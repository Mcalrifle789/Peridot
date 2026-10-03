import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import { configuredProviders } from './providers.js';

export { activeProvider } from './providers.js';

export const VERSION = '0.3.0';

export const PERIDOT_DIR = process.env.PERIDOT_HOME || path.join(os.homedir(), '.peridot');
export const CONFIG_PATH = path.join(PERIDOT_DIR, 'peridot.yaml');
export const MEMORY_PATH = path.join(PERIDOT_DIR, 'memory.json');
export const SESSION_DIR = path.join(PERIDOT_DIR, 'sessions');

export const GATEWAY_HOST = '127.0.0.1';
export const GATEWAY_PORT = 18789;

export const DEFAULTS = {
  user: { username: '', passwordHash: '' },
  model: {
    provider: '',         // key into PROVIDERS (src/providers.js)
    display: 'anthropic/claude-sonnet-4-6',
    id: 'anthropic/claude-sonnet-4.5',
    planning: 'fuzzy local planning',
    contextTokens: 1000000,
  },
  providers: {},          // { <provider key>: { apiKey, baseUrl? } } — as many as the user adds
  theme: 'peridot',
  search: { provider: 'duckduckgo', apiKey: '' },
  audio: { elevenlabs: '', deepgram: '' },
  session: 'main',
};

export function ensureDirs() {
  fs.mkdirSync(PERIDOT_DIR, { recursive: true });
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

export function loadConfig() {
  ensureDirs();
  if (!fs.existsSync(CONFIG_PATH)) return { ...structuredClone(DEFAULTS), _exists: false };
  try {
    const raw = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
    const cfg = deepMerge(structuredClone(DEFAULTS), raw);
    migrate(cfg, raw);
    cfg._exists = true;
    return cfg;
  } catch {
    return { ...structuredClone(DEFAULTS), _exists: false, _corrupt: true };
  }
}

export function saveConfig(cfg) {
  ensureDirs();
  const clean = structuredClone(cfg);
  delete clean._exists;
  delete clean._corrupt;
  fs.writeFileSync(CONFIG_PATH, yaml.dump(clean, { lineWidth: 120 }), 'utf8');
}

// v0.2 configs had no model.provider: the first keyed provider in this order
// served every request, and a custom provider used its own `model` id.
function migrate(cfg, raw) {
  if (raw.model?.provider) return;
  const legacy = ['openrouter', 'custom', 'opencode', 'kilo'].find((k) => cfg.providers?.[k]?.apiKey);
  const first = legacy || configuredProviders(cfg)[0]?.key;
  if (!first) return;
  cfg.model.provider = first;
  if (first === 'custom' && cfg.providers.custom.model) {
    cfg.model.id = cfg.providers.custom.model;
    cfg.model.display = cfg.providers.custom.model;
  }
}

// Make `model` (from the catalog) the active model.
export function setModel(cfg, provider, model) {
  cfg.model.provider = provider;
  cfg.model.id = model.id;
  cfg.model.display = model.name || model.id;
  cfg.model.contextTokens = model.context || DEFAULTS.model.contextTokens;
}

function deepMerge(base, over) {
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object') {
      deepMerge(base[k], over[k]);
    } else {
      base[k] = over[k];
    }
  }
  return base;
}

// --- memory ---
export function loadMemory() {
  ensureDirs();
  try { return JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf8')); } catch { return []; }
}
export function saveMemory(mem) {
  ensureDirs();
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(mem, null, 2), 'utf8');
}

// --- session state (token usage etc.) ---
export function loadSession(name = 'main') {
  ensureDirs();
  const p = path.join(SESSION_DIR, `${name}.json`);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { name, tokensUsed: 0, turns: 0, history: [] }; }
}
export function saveSession(s) {
  ensureDirs();
  fs.writeFileSync(path.join(SESSION_DIR, `${s.name}.json`), JSON.stringify(s, null, 2), 'utf8');
}

export function audioUnlocked(cfg) {
  return Boolean(cfg.audio?.elevenlabs && cfg.audio?.deepgram);
}

export function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}
