# ◈ Peridot

**Local AI agent runtime in a full-screen terminal GUI.** Matrix/peridot green (`#80FF00`) on pitch black by default, with a glowing infinity-loop identity — built to match the reference design in `Peridot.png`. The title is set in the **Neuton** serif font (`assets/Neuton-Regular.ttf`), rendered to terminal half-block art by `scripts/gen-wordmark.py` and colored with the active theme.

The app owns the whole terminal (alternate screen buffer): fixed header bar (agent · session · mode), scrollback viewport (PgUp/PgDn), pinned input line, status row, and a model/token footer bar.

## What's new in 0.3.0

- **Multiple model providers at once.** Add API keys for as many providers as you like — OpenRouter, OpenAI, Anthropic, Google Gemini, Groq, Mistral, DeepSeek, xAI, OpenCode, Kilo, or any OpenAI-compatible endpoint — and use models from all of them.
- **Automatic model discovery.** Peridot uses each provider's API key to list every model that provider offers, so `/model` can pick from all of them (type to filter).
- **`/theme`** with five new themes: Indigo Bridle Path, Galactic Neon Magenta, NYC Yellow, Seattle Blue and Cyan Atlantis (plus the original Peridot), previewed live.
- **Setup** now requires a username and a password, entered twice to confirm. Passwords are stored as salted PBKDF2-SHA256 hashes.
- **Rust, C and Python** components (see [Architecture](#architecture)).
- Command fixes: the Kilo gateway URL, `/search` returns real web results, file commands accept quoted paths with spaces, `/py` and `/node` pass code through intact.

## Install

```powershell
cd "D:\Apps\AI AGENTS\Peridot"
npm install
npm link                 # puts `peridot` on your PATH
npm run build:native     # optional: builds the C password hasher (needs MSVC, gcc or clang)
```

Requirements: Node 18+, and **Python 3.9+** (used to discover each provider's models). Set `PERIDOT_PYTHON` if Python isn't on your PATH as `python`, `py` or `python3`.

## Commands

| Command | What it does |
|---|---|
| `peridot setup` | Configuration wizard — username + password (confirmed), AI model providers (**at least one API key is required**; add as many as you want — each key is verified by listing its models), search provider (DuckDuckGo, Gemini, Perplexity, Parallel, Parallel Free, Firecrawl, Brave, Custom), optional ElevenLabs + Deepgram keys |
| `peridot` | Launches the main runtime (intentional 3-second boot sequence) |
| `peridot status` | Quick status report *(maintenance)* |
| `peridot config` | Print loaded config, keys redacted *(maintenance)* |
| `peridot doctor` | Environment diagnostics *(maintenance)* |

## Inside the runtime

- Type anything at `>> Ask Peridot anything...` to chat with the active model (streamed).
- Type `/` to open the scrollable dropdown of all **62 skills/commands** — filter by typing, navigate with `↑`/`↓`, select with `Enter` or `Tab`, close with `Esc`. `PgUp`/`PgDn` scrolls the conversation.
- **`/model`** — pick from every model of every configured provider; type to filter (`claude`, `gpt 5`, `gemini flash` …). `/model <id>` switches directly; `/model <provider>:<id>` pins the provider when several offer the same id.
- **`/models`** — providers with their model counts · `/models <provider>` lists one provider's models · `/models refresh` re-lists everything with your keys.
- **`/provider`** — add a provider, replace its key, refresh its models, or remove it, without re-running setup. Also `/provider add <name>` / `/provider remove <name>`.
- **`/theme`** — theme picker with live preview (`Esc` restores the current theme). `/theme <name>` switches directly (`/theme nyc`, `/theme seattle-blue`); `/theme list` shows swatches.
- **Plan mode** (`/mode plan`) — architecture and step-by-step reasoning, no file changes. Shown as a `PLAN` chip in the header.
- **Build mode** (`/mode build`) — writes code, runs commands, executes scripts. Shown as a `BUILD` chip in the header.
- **`/agent`** — arrow-key picker to switch between agents or create a new one (name, description, persona/system prompt). Each agent keeps its own sessions.
- **`/sessions`** — switch between the current agent's sessions.
- **`/new [name]`** — create a fresh session for the current agent (auto-names `session-N` if you skip the name).
- The **8 audio/music commands** (`/speak`, `/voice`, `/listen`, `/transcribe`, `/music`, `/ambient`, `/stream`, `/sound`) stay locked until both ElevenLabs and Deepgram keys are configured in `peridot setup`.

### Command categories (62 total)

- **system** (18): help, clear, exit, mode, model, models, provider, session, sessions, new, history, status, config, setup, tokens, theme, version, doctor
- **filesystem** (10): ls, read, write, edit, mkdir, rm, mv, cp, find, tree
- **web** (5): search, fetch, scrape, news, docs
- **code** (10): run, exec, sh, py, node, test, build, lint, debug, git
- **memory** (5): remember, recall, forget, memories, note
- **agent** (6): plan, act, task, tasks, agent, workflow
- **audio** (8): speak, voice, listen, transcribe, music, ambient, stream, sound

## Model providers

| Provider | Chat endpoint | Model list |
|---|---|---|
| OpenRouter | `https://openrouter.ai/api/v1` | `/models` |
| OpenAI | `https://api.openai.com/v1` | `/models` (chat models only) |
| Anthropic | `https://api.anthropic.com/v1` (OpenAI-compatible) | `/v1/models`, paginated |
| Google Gemini | `…/v1beta/openai` (OpenAI-compatible) | `/v1beta/models`, `generateContent` models |
| Groq · Mistral · DeepSeek · xAI | their OpenAI-compatible APIs | `/models` (chat models only) |
| OpenCode | `https://opencode.ai/zen/v1` | `/models` |
| Kilo | `https://api.kilo.ai/api/gateway` | `/models` |
| Custom | your base URL | `<base>/models`, or a model id you enter |

Model lists are cached in `~/.peridot/models.json`. A provider whose list can't be fetched keeps its last good list and shows the error in `/models`.

## Themes

| Theme | Feel |
|---|---|
| Peridot | signature peridot green on pitch black |
| Indigo Bridle Path | deep indigo trail with saddle-leather tan |
| Galactic Neon Magenta | hot neon magenta in a violet nebula |
| NYC Yellow | taxi-cab yellow on midnight asphalt |
| Seattle Blue | rain-cool Puget Sound blue |
| Cyan Atlantis | luminous deep-sea cyan |

Every palette is generated and contrast-checked (WCAG ratios on the black background and the bar background) by the Rust tool in `native/rust/peridot-themes`. To change or add a theme, edit its anchors in `src/main.rs` and run `npm run build:themes`.

## Architecture

```
bin/peridot.js                  entry point + maintenance commands
src/theme.js                    live palette (C), applyTheme, gradients
src/themes.js                   generated palettes (Rust) — do not edit by hand
src/providers.js                provider registry, active provider, default model choice
src/catalog.js                  model discovery (runs the Python helper) + cache
src/hash.js                     password hashing (C hasher, Node crypto fallback)
src/logo.js                     infinity loop + themed Neuton wordmark
src/wordmark.js                 generated wordmark coverage (scripts/gen-wordmark.py)
src/config.js                   ~/.peridot/peridot.yaml, migration, memory
src/agents.js                   agent registry + per-agent session storage
src/commands.js                 the 62 skills/commands registry
src/screen.js                   full-screen engine: alt buffer, chrome, viewport, overlays
src/ui.js                       raw-mode key parsing, wizard controls (setup)
src/input.js                    line editor, slash menu, filterable overlay select, prompts
src/boot.js                     3s boot sequence, landing screen, local gateway
src/agent.js                    command dispatch + streaming chat
src/setup.js                    4-step configuration wizard
src/main.js                     runtime loop

native/python/peridot_models.py Python — lists every model a provider offers, using its key
native/c/peridot_hash.c         C — PBKDF2-HMAC-SHA256 password hasher
native/rust/peridot-themes/     Rust — theme palette generator + contrast validator
scripts/build_native.py         builds the C and Rust components
test/                           node:test suite (npm test)
```

- **Local gateway**: a real HTTP endpoint on `http://127.0.0.1:18789` reporting runtime state as JSON.
- **Config**: `~/.peridot/peridot.yaml` (override with `PERIDOT_HOME`). Passwords are stored as `pbkdf2-sha256$600000$<salt>$<hash>`, never plaintext. API keys reach the Python helper over stdin, never on a command line.
- **Chat**: every provider is called through an OpenAI-compatible `/chat/completions` endpoint with streaming; the active model is `model.provider` + `model.id` in the config.
- **Token tracker**: approximate usage persisted per session, shown as `used/context` in the footer (context size comes from the provider's model list when it reports one).

## Development

```powershell
npm test                 # 30 tests: commands, providers, discovery, setup, themes, hashing
npm run build:native     # C hasher + Rust theme generator
npm run build:themes     # regenerate src/themes.js only
```
