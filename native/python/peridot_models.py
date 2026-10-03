"""Peridot model discovery.

Uses each configured provider's API key to list every model that provider
offers. Reads one JSON request on stdin and writes one JSON response on stdout:

  request:  {"providers": [{"key": "openrouter", "kind": "openai",
                            "base": "https://openrouter.ai/api/v1",
                            "apiKey": "...", "chatOnly": false}]}
  response: {"results": {"openrouter": {"ok": true, "models": [
                {"id": "...", "name": "...", "context": 200000}]}}}
            {"results": {"openai": {"ok": false, "status": 401, "error": "..."}}}

API keys travel over stdin only, so they never appear in the process list.
Providers are queried concurrently. Standard library only (Python 3.9+).
"""
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

TIMEOUT = 20
MAX_PAGES = 50
USER_AGENT = "peridot/0.3"

# Model families that can't hold a chat conversation (embeddings, speech,
# image/video generation, moderation, realtime-only, legacy completions).
NON_CHAT = re.compile(
    r"embed|tts|whisper|dall-e|moderation|transcri|babbage|davinci|realtime"
    r"|(^|[-/_.])image|image-|imagen|sora|veo-|computer-use|aqa",
    re.IGNORECASE,
)


class ProviderError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def error_detail(raw):
    """The provider's own error message, if the body is the usual JSON error shape."""
    text = raw.decode("utf-8", "replace")
    try:
        body = json.loads(text)
        err = body.get("error", body) if isinstance(body, dict) else body
        text = err.get("message", text) if isinstance(err, dict) else (err if isinstance(err, str) else text)
    except ValueError:
        pass
    text = " ".join(str(text).split())
    return text[:200] + ("…" if len(text) > 200 else "")


def get_json(url, headers):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            body = res.read()
    except urllib.error.HTTPError as e:
        detail = error_detail(e.read(2000))
        hint = {401: "API key rejected", 403: "API key not permitted", 404: "no model list at this URL"}.get(e.code, "")
        raise ProviderError(f"HTTP {e.code}{' — ' + hint if hint else ''}{': ' + detail if detail else ''}", e.code)
    except urllib.error.URLError as e:
        raise ProviderError(f"cannot reach provider: {e.reason}")
    except TimeoutError:
        raise ProviderError(f"provider did not answer within {TIMEOUT}s")
    try:
        return json.loads(body)
    except ValueError:
        raise ProviderError("provider returned something that is not JSON — check the base URL")


def model(mid, name=None, context=None):
    ctx = context if isinstance(context, int) and context > 0 else None
    return {"id": mid, "name": (name or mid).strip(), "context": ctx}


def list_openai(p):
    data = get_json(p["base"].rstrip("/") + "/models", {"Authorization": "Bearer " + p["apiKey"]})
    items = data.get("data") if isinstance(data, dict) else data
    if not isinstance(items, list):
        raise ProviderError("unexpected response — no model list in it")
    out = []
    for m in items:
        if isinstance(m, dict) and isinstance(m.get("id"), str) and m["id"]:
            ctx = m.get("context_length") or m.get("context_window") or (m.get("top_provider") or {}).get("context_length")
            out.append(model(m["id"], m.get("name"), ctx))
    return out


def list_anthropic(p):
    base = p["base"].rstrip("/")
    headers = {"x-api-key": p["apiKey"], "anthropic-version": "2023-06-01"}
    out, after = [], None
    for _ in range(MAX_PAGES):
        query = {"limit": 1000}
        if after:
            query["after_id"] = after
        data = get_json(f"{base}/models?{urllib.parse.urlencode(query)}", headers)
        for m in data.get("data", []):
            if m.get("id"):
                out.append(model(m["id"], m.get("display_name")))
        after = data.get("last_id")
        if not data.get("has_more") or not after:
            break
    return out


def list_gemini(p):
    base = p["base"].rstrip("/")
    headers = {"x-goog-api-key": p["apiKey"]}
    out, token = [], None
    for _ in range(MAX_PAGES):
        query = {"pageSize": 1000}
        if token:
            query["pageToken"] = token
        data = get_json(f"{base}/models?{urllib.parse.urlencode(query)}", headers)
        for m in data.get("models", []):
            if "generateContent" not in m.get("supportedGenerationMethods", []):
                continue
            mid = m.get("name", "")
            mid = mid[len("models/"):] if mid.startswith("models/") else mid
            if mid:
                out.append(model(mid, m.get("displayName"), m.get("inputTokenLimit")))
        token = data.get("nextPageToken")
        if not token:
            break
    return out


LISTERS = {"openai": list_openai, "anthropic": list_anthropic, "gemini": list_gemini}


def discover(p):
    try:
        lister = LISTERS.get(p.get("kind"))
        if not lister:
            raise ProviderError(f"unknown provider kind {p.get('kind')!r}")
        if not p.get("apiKey"):
            raise ProviderError("no API key configured")
        if not p.get("base"):
            raise ProviderError("no base URL configured")
        models = lister(p)
        if p.get("chatOnly"):
            models = [m for m in models if not NON_CHAT.search(m["id"])]
        unique = {}
        for m in models:  # first listing wins; fill in a context size a duplicate knows
            seen = unique.setdefault(m["id"], m)
            if seen["context"] is None and m["context"]:
                seen["context"] = m["context"]
        if not unique:
            raise ProviderError("the provider returned an empty model list")
        return {"ok": True, "models": sorted(unique.values(), key=lambda m: m["id"].lower())}
    except ProviderError as e:
        return {"ok": False, "status": e.status, "error": str(e)}
    except Exception as e:  # malformed payloads must not take down the other providers
        return {"ok": False, "status": None, "error": f"unexpected response ({type(e).__name__}: {e})"}


def main():
    try:
        request = json.load(sys.stdin)
        providers = request["providers"]
        assert isinstance(providers, list)
    except Exception:
        print("peridot_models: expected {\"providers\": [...]} on stdin", file=sys.stderr)
        return 2
    results = {}
    if providers:
        with ThreadPoolExecutor(max_workers=min(8, len(providers))) as pool:
            for p, result in zip(providers, pool.map(discover, providers)):
                results[p.get("key", "?")] = result
    json.dump({"results": results}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
