// Model catalog: discovers every model each configured provider offers (via the
// Python helper, which uses the provider's API key) and caches the result in
// ~/.peridot/models.json so pickers open instantly.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PERIDOT_DIR, ensureDirs } from './config.js';
import { configuredProviders, getProvider } from './providers.js';

export const CATALOG_PATH = path.join(PERIDOT_DIR, 'models.json');
const SCRIPT = fileURLToPath(new URL('../native/python/peridot_models.py', import.meta.url));
const DISCOVERY_TIMEOUT_MS = 90_000;

// ─── python interpreter ──────────────────────────────────────────────────────
let python; // cached: [cmd, ...args] | null
export function findPython() {
  if (python !== undefined) return python;
  const candidates = process.env.PERIDOT_PYTHON
    ? [[process.env.PERIDOT_PYTHON]]
    : [['python'], ['py', '-3'], ['python3']];
  for (const c of candidates) {
    const r = spawnSync(c[0], [...c.slice(1), '-c', 'import sys; print(sys.version_info >= (3, 9))'], {
      encoding: 'utf8', timeout: 8000, windowsHide: true,
    });
    if (r.status === 0 && r.stdout.trim() === 'True') return (python = c);
  }
  return (python = null);
}

// ─── cache ───────────────────────────────────────────────────────────────────
export function loadCatalog() {
  try {
    const c = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    if (c && typeof c.providers === 'object') return c;
  } catch { /* fresh */ }
  return { providers: {} };
}

function saveCatalog(c) {
  ensureDirs();
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(c, null, 2), 'utf8');
}

export function forgetProvider(key) {
  const c = loadCatalog();
  delete c.providers[key];
  saveCatalog(c);
}

// ─── discovery ───────────────────────────────────────────────────────────────
function runHelper(request) {
  return new Promise((resolve) => {
    const py = findPython();
    if (!py) {
      resolve({ error: 'Python 3.9+ was not found — install it from python.org (or set PERIDOT_PYTHON) to discover models.' });
      return;
    }
    const child = spawn(py[0], [...py.slice(1), SCRIPT], { windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), DISCOVERY_TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ error: `model discovery failed to start: ${e.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ error: `model discovery failed (exit ${code}): ${stderr.trim().split('\n').pop() || 'no output'}` });
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

// Discover models for the given configured providers (default: all of them).
// Returns { <key>: { ok, models, error } } and updates the cache. A failed
// refresh keeps the previously cached list but records the error.
export async function discoverModels(cfg, keys) {
  const providers = (keys ? keys.map((k) => getProvider(cfg, k)) : configuredProviders(cfg)).filter(Boolean);
  if (!providers.length) return {};
  const res = await runHelper({
    providers: providers.map((p) => ({
      key: p.key, kind: p.kind, base: p.modelsBase, apiKey: p.apiKey, chatOnly: Boolean(p.chatOnly),
    })),
  });
  const catalog = loadCatalog();
  const out = {};
  for (const p of providers) {
    const r = res.results?.[p.key] || { ok: false, error: res.error || 'no result from model discovery' };
    const prev = catalog.providers[p.key];
    catalog.providers[p.key] = r.ok
      ? { fetchedAt: new Date().toISOString(), models: r.models }
      : { fetchedAt: prev?.fetchedAt || null, models: prev?.models || [], error: r.error };
    out[p.key] = { ok: Boolean(r.ok), models: r.ok ? r.models : [], error: r.error || '' };
  }
  saveCatalog(catalog);
  return out;
}

// Cached models for one provider (plus a manually entered model id, if any).
export function providerModels(cfg, key, catalog = loadCatalog()) {
  const p = getProvider(cfg, key);
  if (!p) return [];
  const models = [...(catalog.providers[key]?.models || [])];
  if (p.manualModel && !models.some((m) => m.id === p.manualModel)) {
    models.unshift({ id: p.manualModel, name: p.manualModel, context: null });
  }
  return models;
}

// Every model across every configured provider: [{ provider, id, name, context }].
export function allModels(cfg) {
  const catalog = loadCatalog();
  return configuredProviders(cfg).flatMap((p) =>
    providerModels(cfg, p.key, catalog).map((m) => ({ provider: p.key, ...m })));
}

// Configured providers whose models were never requested. (Failed attempts are
// recorded too, so a broken provider isn't retried on every /model —
// /models refresh retries everything.)
export function undiscovered(cfg) {
  const catalog = loadCatalog();
  return configuredProviders(cfg).filter((p) => !catalog.providers[p.key]).map((p) => p.key);
}
