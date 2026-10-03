import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import {
  C, paint, BOLD, DIM, neon, nb, soft, dim, grey, white, warn, cols,
  THEMES, applyTheme, findTheme, currentTheme, swatch,
} from './theme.js';
import { COMMANDS, findCommand } from './commands.js';
import {
  saveConfig, loadMemory, saveMemory, activeProvider, audioUnlocked, setModel,
  fmtTokens, PERIDOT_DIR, CONFIG_PATH, VERSION,
} from './config.js';
import {
  PROVIDERS, providerLabel, configuredProviders, getProvider, defaultModelFor,
} from './providers.js';
import {
  discoverModels, allModels, providerModels, undiscovered, loadCatalog, forgetProvider, findPython,
} from './catalog.js';
import { nativeHashAvailable } from './hash.js';
import { loadAgents, saveAgents, loadAgentSession, saveAgentSession, listAgentSessions } from './agents.js';
import { rawStop, rawStart, spinnerStart } from './ui.js';
import { overlaySelect, promptLine } from './input.js';
import { landingScreen } from './boot.js';

// ─── output routing (full-screen app or plain stdout) ───────────────────────
let screenRef = null;
export const bindScreen = (s) => { screenRef = s; };

const out = (text) => screenRef ? screenRef.push(text) : process.stdout.write(text + '\n');
const spin = (text) => screenRef ? screenRef.spinner(text) : spinnerStart(text);

const est = (s) => Math.ceil((s || '').length / 4);

const wrapText = (text, width = Math.min(cols() - 8, 100)) =>
  text.split('\n').flatMap((line) => {
    const res = [];
    while (line.length > width) {
      let cut = line.lastIndexOf(' ', width);
      if (cut < width * 0.6) cut = width;
      res.push(line.slice(0, cut));
      line = line.slice(cut).trimStart();
    }
    res.push(line);
    return res;
  });

export function say(text, color = C.white) {
  const body = wrapText(text).map((l) => '  ' + paint(l, color)).join('\n');
  out(neon('◈') + ' ' + nb('peridot') + '\n' + body + '\n');
}

export function sayRaw(text) {
  out(text);
}

function echoUser(state, text) {
  out('');
  out(paint('>>', C.deep, BOLD) + ' ' + soft('you') + '  ' + white(text));
  out('');
}

// ─── chat via the active model's provider ────────────────────────────────────
const SYSTEM_PROMPT = (state) => {
  const persona = state.agent?.system
    ? state.agent.system
    : 'You are Peridot, a local AI agent runtime running in a terminal GUI on Windows. Tone: professional, efficient, technical, yet conversational.';
  return persona +
    ` Current mode: ${state.mode}. ` +
    (state.mode === 'plan'
      ? 'PLAN MODE: focus on architecture, step-by-step reasoning, file structures and dependency maps. Do not pretend to modify files.'
      : 'BUILD MODE: focus on concrete code, commands and execution steps.') +
    ' Keep answers terminal-friendly: compact, no markdown tables, prefer short code blocks.';
};

async function chat(state, userText, { system } = {}) {
  const provider = activeProvider(state.cfg);
  if (!provider) {
    say(`I'm running offline — no model provider is configured yet. Add an API key with /provider ` +
      `(or run \`peridot setup\`) and I'll come fully online. Local tools (/ls, /read, /run, /remember, /search ...) work without one.`);
    return;
  }
  const base = provider.base;
  const model = state.cfg.model.id;
  const extraHeaders = provider.key === 'openrouter'
    ? { 'HTTP-Referer': 'https://peridot.local', 'X-Title': 'Peridot' }
    : {};

  const messages = [
    { role: 'system', content: system || SYSTEM_PROMPT(state) },
    ...state.session.history.slice(-20),
    { role: 'user', content: userText },
  ];

  state.busy = true;
  const stop = spin('thinking');
  let res;
  try {
    res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${provider.apiKey}`,
        ...extraHeaders,
      },
      body: JSON.stringify({ model, messages, stream: true }),
    });
  } catch (e) {
    stop(); state.busy = false;
    say(`Gateway error reaching ${provider.label}: ${e.message}`, C.red);
    return;
  }
  if (!res.ok) {
    stop(); state.busy = false;
    const body = await res.text().catch(() => '');
    say(`${provider.label} returned ${res.status}. ${body.slice(0, 300)}\n` +
      `Check the model (currently "${model}") — pick another with /model.`, C.yellow);
    return;
  }

  stop();
  out(neon('◈') + ' ' + nb('peridot'));
  let full = '';
  // Streaming into the scrollback: re-render this response's tail as it grows.
  const startIdx = screenRef ? screenRef.lines.length : 0;
  const paintTail = () => {
    if (!screenRef) return;
    screenRef.lines.splice(startIdx);
    for (const l of wrapText(full)) screenRef.lines.push('  ' + paint(l, C.white));
    screenRef.scroll = 0;
    screenRef.render();
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let carry = '';
  let lastPaint = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    carry += decoder.decode(value, { stream: true });
    const lines = carry.split('\n');
    carry = lines.pop();
    for (const line of lines) {
      const m = line.match(/^data: ?(.*)/);
      if (!m || m[1] === '[DONE]') continue;
      try {
        const delta = JSON.parse(m[1]).choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          if (screenRef) {
            const now = Date.now();
            if (now - lastPaint > 40) { paintTail(); lastPaint = now; }
          } else {
            process.stdout.write(delta);
          }
        }
      } catch { /* keep-alive chunk */ }
    }
  }
  if (screenRef) { paintTail(); out(''); }
  else process.stdout.write('\n\n');

  state.busy = false;
  state.session.history.push({ role: 'user', content: userText }, { role: 'assistant', content: full });
  state.session.history = state.session.history.slice(-40);
  state.session.tokensUsed += est(userText) + est(full) + 40;
  state.session.turns++;
  saveAgentSession(state.session);
  return full;
}

// ─── helpers ─────────────────────────────────────────────────────────────────
function runShell(cmd, { inherit = true } = {}) {
  if (inherit && screenRef) screenRef.suspend();
  rawStop();
  const r = spawnSync(cmd, {
    shell: true,
    stdio: inherit ? 'inherit' : 'pipe',
    encoding: 'utf8',
  });
  rawStart();
  if (inherit && screenRef) screenRef.resume();
  return r;
}

function redact(obj) {
  const clone = structuredClone(obj);
  const scrub = (o) => {
    for (const k of Object.keys(o || {})) {
      if (typeof o[k] === 'object') scrub(o[k]);
      else if (/key|token|password|hash/i.test(k) && o[k]) o[k] = String(o[k]).slice(0, 4) + '••••••••';
    }
  };
  scrub(clone);
  delete clone._exists;
  return clone;
}

function walk(dir, cb, depth = 0, maxDepth = 6) {
  if (depth > maxDepth) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (['node_modules', '.git', 'AppData'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    cb(p, e, depth);
    if (e.isDirectory()) walk(p, cb, depth + 1, maxDepth);
  }
}

// Split command arguments on spaces, honoring "double quoted" paths with spaces.
function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2]);
  return out;
}

// A single path argument; surrounding quotes are optional.
const unquote = (s) => s.trim().replace(/^"(.*)"$/, '$1');

// Show captured process output (also kept for /debug).
function showOutput(state, r) {
  const output = ((r.stdout || '') + (r.stderr || '') + (r.error ? r.error.message : '')).trim();
  state.lastOutput = output;
  sayRaw(output ? output.split('\n').map((l) => '  ' + grey(l)).join('\n') + '\n' : '  ' + dim('(no output)') + '\n');
}

// Run a program directly (no shell), so arguments reach it exactly as typed.
function runDirect(state, cmd, args) {
  rawStop();
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  rawStart();
  showOutput(state, r);
}

// DuckDuckGo web results (HTML endpoint; no key required).
async function duckduckgo(q) {
  const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {
    headers: { 'user-agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) peridot/${VERSION}` },
  });
  if (!r.ok) throw new Error(`DuckDuckGo returned ${r.status}`);
  const html = await r.text();
  const text = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  const link = (href) => {
    const u = /[?&]uddg=([^&]+)/.exec(href.replace(/&amp;/g, '&'));
    return u ? decodeURIComponent(u[1]) : href.replace(/^\/\//, 'https://');
  };
  const titles = [...html.matchAll(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
  return titles
    .map((m, i) => ({ title: text(m[2]), url: link(m[1]), desc: snippets[i] ? text(snippets[i][1]) : '' }))
    .filter((x) => x.title && !x.url.includes('duckduckgo.com/y.js')); // drop ads
}

// ─── models + providers ──────────────────────────────────────────────────────
const ctxLabel = (n) => (n ? `${fmtTokens(n)} ctx` : '');

// Discover models for configured providers that have never been listed.
async function ensureCatalog(state) {
  const missing = undiscovered(state.cfg);
  if (!missing.length) return;
  const stop = spin(`finding models: ${missing.map(providerLabel).join(', ')}`);
  const res = await discoverModels(state.cfg, missing);
  stop();
  for (const [key, r] of Object.entries(res)) {
    if (!r.ok) say(`${providerLabel(key)}: ${r.error}`, C.yellow);
  }
}

function chooseModel(state, m) {
  setModel(state.cfg, m.provider, m);
  saveConfig(state.cfg);
  say(`Model set to ${m.id} via ${providerLabel(m.provider)}${m.context ? ` — ${fmtTokens(m.context)} context` : ''}.`);
}

// /model            pick from every model of every configured provider
// /model <id>       switch directly (opens the picker, filtered, if ambiguous)
// /model <provider>:<id>   pin the provider when several offer the same id
async function modelCommand(state, arg) {
  const cfg = state.cfg;
  if (!configuredProviders(cfg).length) { say('No model providers yet — add one with /provider.', C.yellow); return; }
  await ensureCatalog(state);
  const models = allModels(cfg);
  if (!models.length) {
    say('No models could be listed for your providers. Check /models for errors, then /models refresh.', C.yellow);
    return;
  }
  let query = '';
  if (arg) {
    let pool = models, id = arg;
    const pin = /^([a-z]+):(.+)$/.exec(arg);
    if (pin && getProvider(cfg, pin[1])) { pool = models.filter((m) => m.provider === pin[1]); id = pin[2]; }
    const exact = pool.filter((m) => m.id === id);
    if (exact.length === 1) { chooseModel(state, exact[0]); return; }
    query = id;
  }
  if (!screenRef) { say('Usage: /model <model-id> or /model <provider>:<model-id>', C.yellow); return; }
  const isActive = (m) => m.provider === cfg.model.provider && m.id === cfg.model.id;
  const items = models.map((m) => ({
    label: m.id,
    desc: [providerLabel(m.provider), m.name !== m.id ? m.name : '', ctxLabel(m.context)].filter(Boolean).join(' · ') +
      (isActive(m) ? '  ◂ active' : ''),
    model: m,
  }));
  const pick = await overlaySelect(screenRef, {
    title: 'models', items, filter: true, query, initial: query ? 0 : Math.max(models.findIndex(isActive), 0),
  });
  if (!pick) { say('Model unchanged.'); return; }
  chooseModel(state, pick.model);
}

// /models                 providers with model counts
// /models refresh         re-discover every provider's models with its key
// /models <provider>      list one provider's models
async function modelsCommand(state, arg) {
  const cfg = state.cfg;
  if (arg === 'refresh') {
    if (!configuredProviders(cfg).length) { say('No model providers yet — add one with /provider.', C.yellow); return; }
    const stop = spin('refreshing models from every provider');
    const res = await discoverModels(cfg);
    stop();
    for (const [key, r] of Object.entries(res)) {
      sayRaw('  ' + (r.ok ? paint('✓', C.neon) : warn('▲')) + ' ' + white(providerLabel(key).padEnd(16)) +
        (r.ok ? grey(`${r.models.length} models`) : paint(r.error, C.yellow)));
    }
    sayRaw('');
    return;
  }
  if (arg) {
    const p = getProvider(cfg, arg.toLowerCase()) ||
      configuredProviders(cfg).find((x) => x.label.toLowerCase() === arg.toLowerCase());
    if (!p) { say(`"${arg}" is not a configured provider. Configured: ${configuredProviders(cfg).map((x) => x.key).join(', ') || 'none'}.`, C.yellow); return; }
    await ensureCatalog(state);
    const list = providerModels(cfg, p.key);
    if (!list.length) { say(`No models listed for ${p.label}. Try /models refresh.`, C.yellow); return; }
    for (const m of list.slice(0, 80)) {
      const active = m.id === cfg.model.id && p.key === cfg.model.provider;
      sayRaw('  ' + (active ? neon('▸ ') : '  ') + white(m.id) + (m.context ? dim('  ' + ctxLabel(m.context)) : ''));
    }
    if (list.length > 80) sayRaw('  ' + dim(`… ${list.length - 80} more — /model filters all of them`));
    sayRaw('');
    return;
  }
  const catalog = loadCatalog();
  for (const p of PROVIDERS) {
    const conf = getProvider(cfg, p.key);
    if (!conf) { sayRaw('  ' + dim('○ ' + p.label.padEnd(16) + 'not configured')); continue; }
    const entry = catalog.providers[p.key];
    const n = providerModels(cfg, p.key, catalog).length;
    const active = cfg.model.provider === p.key ? neon('  ◂ active') : '';
    sayRaw('  ' + paint('●', C.neon) + ' ' + white(p.label.padEnd(16)) +
      grey(entry?.fetchedAt ? `${n} models` : 'not listed yet') + active +
      (entry?.error ? '  ' + paint('last refresh failed: ' + entry.error, C.yellow) : ''));
  }
  sayRaw('  ' + dim(`active: ${cfg.model.id} via ${providerLabel(cfg.model.provider)} · /model to switch · /provider to add or remove · /models refresh`) + '\n');
}

// Ask for a provider's key (+ base URL for custom), verify it by discovering
// its models, and save it. Returns true if the provider was saved.
async function addProviderFlow(state, info) {
  const cfg = state.cfg;
  for (;;) {
    const apiKey = await promptLine(screenRef, { label: `${info.label} API key`, mask: true });
    if (!apiKey) { say('Provider unchanged.'); return false; }
    // replacing a key keeps a base-URL override the provider already had
    const prevBase = cfg.providers?.[info.key]?.baseUrl;
    const entry = !info.needsBaseUrl && prevBase ? { apiKey, baseUrl: prevBase } : { apiKey };
    if (info.needsBaseUrl) {
      const baseUrl = await promptLine(screenRef, { label: 'base URL (OpenAI-compatible, e.g. https://api.example.com/v1)' });
      if (!baseUrl) { say('Provider unchanged.'); return false; }
      if (!/^https?:\/\/\S+$/i.test(baseUrl)) { say('The base URL must start with http:// or https://.', C.yellow); continue; }
      entry.baseUrl = baseUrl.replace(/\/+$/, '');
    }
    const stop = spin(`finding ${info.label} models with your key`);
    const res = (await discoverModels({ ...cfg, providers: { ...cfg.providers, [info.key]: entry } }, [info.key]))[info.key];
    stop();
    if (!res?.ok) {
      say(`${info.label}: ${res?.error || 'model discovery failed'}`, C.yellow);
      const next = await overlaySelect(screenRef, {
        title: `${info.label} — the key could not list any models`,
        items: [
          { label: 're-enter the key', act: 'retry' },
          { label: 'keep it anyway', act: 'keep', desc: 'retry later with /models refresh' },
          { label: 'cancel', act: 'cancel' },
        ],
      });
      if (!next || next.act === 'cancel') { say('Provider unchanged.'); return false; }
      if (next.act === 'retry') continue;
      if (info.needsBaseUrl) {
        const model = await promptLine(screenRef, { label: 'model id to use (no model list was found)' });
        if (!model) { say('Provider unchanged.'); return false; }
        entry.model = model;
      }
    }
    const hadActive = Boolean(getProvider(cfg, cfg.model.provider));
    cfg.providers = { ...cfg.providers, [info.key]: entry };
    if (!hadActive) {
      const m = defaultModelFor(info.key, providerModels(cfg, info.key));
      if (m) setModel(cfg, info.key, m); else cfg.model.provider = info.key;
    }
    saveConfig(cfg);
    say(`${info.label} saved${res?.ok ? ` — ${res.models.length} models available` : ''}. ` +
      `Active model: ${cfg.model.id} via ${providerLabel(cfg.model.provider)}. Use /model to pick from every provider.`);
    return true;
  }
}

async function removeProvider(state, info) {
  const cfg = state.cfg;
  const ans = await promptLine(screenRef, { label: `remove ${info.label} and its API key? type "yes" to confirm`, allowEmpty: true });
  if (ans?.toLowerCase() !== 'yes') { say(`Kept ${info.label}.`); return; }
  const providers = { ...cfg.providers };
  delete providers[info.key];
  cfg.providers = providers;
  forgetProvider(info.key);
  let note = '';
  if (cfg.model.provider === info.key) {
    const next = configuredProviders(cfg)
      .map((p) => ({ key: p.key, model: defaultModelFor(p.key, providerModels(cfg, p.key)) }))
      .find((x) => x.model);
    if (next) { setModel(cfg, next.key, next.model); note = ` Active model is now ${next.model.id} via ${providerLabel(next.key)}.`; }
    else { cfg.model.provider = configuredProviders(cfg)[0]?.key || ''; note = ' No other provider has models listed — use /model or /provider.'; }
  }
  saveConfig(cfg);
  say(`Removed ${info.label}.${note}`);
}

// /provider                       manage providers (add, replace key, refresh, remove)
// /provider add|remove <name>     same, directly
async function providerCommand(state, arg) {
  const cfg = state.cfg;
  const [action, ...rest] = splitArgs(arg);
  const lookup = (q) => PROVIDERS.find((p) => p.key === q?.toLowerCase() || p.label.toLowerCase() === q?.toLowerCase());
  if (!screenRef) { say('/provider is interactive — run it inside the Peridot runtime.', C.yellow); return; }

  if (action === 'add' || action === 'remove') {
    const info = lookup(rest.join(' '));
    if (!info) { say(`Usage: /provider ${action} <${PROVIDERS.map((p) => p.key).join('|')}>`, C.yellow); return; }
    if (action === 'remove') {
      if (!getProvider(cfg, info.key)) { say(`${info.label} is not configured.`, C.yellow); return; }
      await removeProvider(state, info);
    } else {
      await addProviderFlow(state, info);
    }
    return;
  }
  if (action) { say('Usage: /provider · /provider add <name> · /provider remove <name>', C.yellow); return; }

  const catalog = loadCatalog();
  const pick = await overlaySelect(screenRef, {
    title: 'model providers — add as many as you like',
    items: PROVIDERS.map((p) => {
      const on = getProvider(cfg, p.key);
      return {
        label: (on ? '● ' : '○ ') + p.label,
        desc: on ? `configured · ${providerModels(cfg, p.key, catalog).length} models` + (cfg.model.provider === p.key ? '  ◂ active' : '') : p.desc,
        info: p,
      };
    }),
  });
  if (!pick) { say('Providers unchanged.'); return; }
  const info = pick.info;
  if (!getProvider(cfg, info.key)) { await addProviderFlow(state, info); return; }
  const act = await overlaySelect(screenRef, {
    title: info.label,
    items: [
      { label: 'refresh models', act: 'refresh', desc: 'list every model again with the saved key' },
      { label: 'replace API key', act: 'replace' },
      { label: 'remove provider', act: 'remove' },
    ],
  });
  if (!act) { say('Providers unchanged.'); return; }
  if (act.act === 'replace') { await addProviderFlow(state, info); return; }
  if (act.act === 'remove') { await removeProvider(state, info); return; }
  const stop = spin(`refreshing ${info.label} models`);
  const r = (await discoverModels(cfg, [info.key]))[info.key];
  stop();
  say(r.ok ? `${info.label}: ${r.models.length} models available.` : `${info.label}: ${r.error}`, r.ok ? C.white : C.yellow);
}

// ─── themes ──────────────────────────────────────────────────────────────────
function setTheme(state, theme) {
  applyTheme(theme.id);
  state.cfg.theme = theme.id;
  saveConfig(state.cfg);
  say(`Theme: ${theme.name} — ${theme.desc}. New output uses it; /clear repaints everything.`);
}

function listThemes() {
  for (const t of THEMES) {
    const active = t.id === currentTheme().id;
    sayRaw('  ' + (active ? neon('▸ ') : '  ') + swatch(t) + '  ' + white(t.name.padEnd(24)) + grey(t.desc) +
      (active ? neon('  ◂ active') : ''));
  }
  sayRaw('  ' + dim('/theme <name> to switch, e.g. /theme seattle-blue') + '\n');
}

// /theme            picker with live preview (esc restores the current theme)
// /theme <name>     switch directly · /theme list
async function themeCommand(state, arg) {
  if (arg === 'list' || (!arg && !screenRef)) { listThemes(); return; }
  if (arg) {
    const t = findTheme(arg);
    if (!t) { say(`No theme matches "${arg}". Themes: ${THEMES.map((x) => x.id).join(', ')}.`, C.yellow); return; }
    setTheme(state, t);
    return;
  }
  const before = currentTheme();
  const pick = await overlaySelect(screenRef, {
    title: 'themes — preview with ↑↓',
    items: THEMES.map((t) => ({ label: t.name, desc: t.desc + (t.id === before.id ? '  ◂ active' : ''), swatch: swatch(t), theme: t })),
    initial: THEMES.findIndex((t) => t.id === before.id),
    onMove: (it) => applyTheme(it.theme.id),
  });
  if (!pick) { applyTheme(before.id); screenRef.render(); say(`Theme unchanged (${before.name}).`); return; }
  setTheme(state, pick.theme);
}

// ─── agent + session switching ───────────────────────────────────────────────
function switchSession(state, name) {
  saveAgentSession(state.session);
  state.session = loadAgentSession(state.agent.name, name);
  saveAgentSession(state.session);
  state.agent.lastSession = name;
  saveAgents(state.agents);
  say(`Session "${name}" active for agent ${state.agent.name} — ${state.session.turns} turns, ${fmtTokens(state.session.tokensUsed)} tokens.`);
}

function switchAgent(state, agent) {
  saveAgentSession(state.session);
  state.agent = agent;
  state.cfg.activeAgent = agent.name;
  saveConfig(state.cfg);
  state.session = loadAgentSession(agent.name, agent.lastSession || 'main');
  saveAgentSession(state.session);
  say(`Agent "${agent.name}" active${agent.desc ? ' — ' + agent.desc : ''}. Session: ${state.session.name}.`);
}

async function agentCommand(state) {
  const items = [
    ...state.agents.map((a) => ({
      label: a.name + (a.name === state.agent.name ? '  ◂ active' : ''),
      desc: a.desc || '',
      agent: a,
    })),
    { label: '+ create new agent', desc: 'name it, give it a persona', create: true },
  ];
  const pick = await overlaySelect(screenRef, { title: 'agents — switch or create', items });
  if (!pick) { say('Agent switch cancelled.'); return; }
  if (pick.create) {
    const name = await promptLine(screenRef, { label: 'new agent name (e.g. "reviewer")' });
    if (!name) { say('Agent creation cancelled.'); return; }
    const clean = name.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
    if (state.agents.find((a) => a.name === clean)) { say(`Agent "${clean}" already exists.`, C.yellow); return; }
    const desc = await promptLine(screenRef, { label: 'short description (enter to skip)', allowEmpty: true });
    if (desc === null) { say('Agent creation cancelled.'); return; }
    const persona = await promptLine(screenRef, { label: 'persona / system prompt (enter for default Peridot persona)', allowEmpty: true });
    if (persona === null) { say('Agent creation cancelled.'); return; }
    const agent = { name: clean, desc: desc || '', system: persona || '', lastSession: 'main' };
    state.agents.push(agent);
    saveAgents(state.agents);
    switchAgent(state, agent);
    return;
  }
  if (pick.agent.name === state.agent.name) { say(`Agent "${pick.agent.name}" is already active.`); return; }
  switchAgent(state, pick.agent);
}

async function sessionsCommand(state) {
  const names = listAgentSessions(state.agent.name);
  if (!names.includes(state.session.name)) names.unshift(state.session.name);
  const items = [
    ...names.map((n) => ({
      label: n + (n === state.session.name ? '  ◂ active' : ''),
      desc: '', name: n,
    })),
    { label: '+ new session', desc: 'fresh context for this agent', create: true },
  ];
  const pick = await overlaySelect(screenRef, { title: `sessions — agent ${state.agent.name}`, items });
  if (!pick) { say('Session switch cancelled.'); return; }
  if (pick.create) { await newSessionCommand(state); return; }
  if (pick.name === state.session.name) { say(`Session "${pick.name}" is already active.`); return; }
  switchSession(state, pick.name);
}

async function newSessionCommand(state, argName = '') {
  let name = argName;
  if (!name) {
    const existing = listAgentSessions(state.agent.name);
    let n = existing.length + 1;
    while (existing.includes(`session-${n}`)) n++;
    name = await promptLine(screenRef, { label: `new session name (enter for "session-${n}")`, allowEmpty: true });
    if (name === null) { say('New session cancelled.'); return; }
    if (!name) name = `session-${n}`;
  }
  const clean = name.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  if (listAgentSessions(state.agent.name).includes(clean)) {
    say(`Session "${clean}" already exists — switching to it instead.`, C.yellow);
    switchSession(state, clean);
    return;
  }
  switchSession(state, clean);
}

// ─── command dispatch ────────────────────────────────────────────────────────
export async function handleInput(state, raw) {
  const input = raw.trim();
  if (!input) return {};

  if (!input.startsWith('/')) {
    echoUser(state, input);
    await chat(state, input);
    return {};
  }

  const [name, ...rest] = input.slice(1).split(' ');
  const arg = rest.join(' ').trim();
  const cmd = findCommand(name);
  echoUser(state, input);

  if (!cmd) {
    say(`Unknown command /${name}. Type / to browse all ${COMMANDS.length} commands, or /help for an overview.`, C.yellow);
    return {};
  }
  if (cmd.audio && !audioUnlocked(state.cfg)) {
    say(`/${name} is part of the audio/music suite — locked. Configure ElevenLabs and Deepgram API keys via ` +
      `\`peridot setup\` to unlock all 8 audio commands.`, C.yellow);
    return {};
  }

  try {
    return (await dispatch(state, name, arg)) || {};
  } catch (e) {
    say(`Command failed: ${e.message}`, C.red);
    return {};
  }
}

async function dispatch(state, name, arg) {
  const cfg = state.cfg;
  switch (name) {
    // ── system
    case 'help': {
      const cats = {};
      for (const c of COMMANDS) (cats[c.cat] ??= []).push(c.name);
      sayRaw(nb('Peridot') + soft(` — ${COMMANDS.length} commands. Type `) + neon('/') + soft(' to browse with arrow keys.'));
      for (const [cat, names] of Object.entries(cats)) {
        const locked = cat === 'audio' && !audioUnlocked(cfg) ? dim('  (locked — audio keys required)') : '';
        sayRaw('  ' + paint(cat.padEnd(11), C.green, BOLD) + grey(names.map((n) => '/' + n).join(' ')) + locked);
      }
      sayRaw('  ' + dim('modes: /mode plan · /mode build — anything without a leading / goes to the model.'));
      sayRaw('');
      return;
    }
    case 'clear':
      screenRef ? screenRef.clearContent() : console.clear();
      sayRaw(landingScreen(state));
      return;
    case 'exit':
      return { exit: true };
    case 'mode':
      if (arg === 'plan' || arg === 'build') state.mode = arg;
      else state.mode = state.mode === 'plan' ? 'build' : 'plan';
      say(`Mode: ${state.mode === 'plan'
        ? 'PLAN — architectural layout, step-by-step reasoning, no file modification.'
        : 'BUILD — active execution: writing code, creating files, running scripts.'}`);
      return;
    case 'model':
      await modelCommand(state, arg);
      return;
    case 'models':
      await modelsCommand(state, arg);
      return;
    case 'provider':
      await providerCommand(state, arg);
      return;
    case 'session':
      say(`Agent ${state.agent.name} · session "${state.session.name}" — ${state.session.turns} turns, ${fmtTokens(state.session.tokensUsed)} tokens, ${state.mode} mode.`);
      return;
    case 'sessions':
      await sessionsCommand(state);
      return;
    case 'new':
      await newSessionCommand(state, arg);
      return;
    case 'agent':
      await agentCommand(state);
      return;
    case 'history': {
      if (!state.session.history.length) { say('No conversation history yet this session.'); return; }
      for (const m of state.session.history.slice(-12)) {
        sayRaw('  ' + (m.role === 'user' ? paint('you     ', C.deep, BOLD) : neon('peridot ')) + grey(m.content.slice(0, 90).replace(/\n/g, ' ')));
      }
      sayRaw('');
      return;
    }
    case 'status': {
      const p = activeProvider(cfg);
      const all = configuredProviders(cfg);
      sayRaw([
        '  ' + soft('runtime   ') + white(`peridot v${VERSION} · local ready | ` + (p ? 'online' : 'offline')),
        '  ' + soft('model     ') + white(`${cfg.model.id}`) + grey(cfg.model.display !== cfg.model.id ? `  (${cfg.model.display})` : ''),
        '  ' + soft('provider  ') + white(p ? p.label : 'none') +
          grey(all.length > 1 ? `  · ${all.length} configured: ${all.map((x) => x.label).join(', ')}` : ''),
        '  ' + soft('theme     ') + white(currentTheme().name),
        '  ' + soft('gateway   ') + white(`http://127.0.0.1:18789 (${state.gatewayStatus})`),
        '  ' + soft('agent     ') + white(`${state.agent.name} · session ${state.session.name}`),
        '  ' + soft('mode      ') + white(state.mode),
        '  ' + soft('tokens    ') + white(`${fmtTokens(state.session.tokensUsed)}/${fmtTokens(cfg.model.contextTokens)}`),
        '  ' + soft('audio     ') + white(audioUnlocked(cfg) ? 'unlocked' : 'locked (8 commands)'),
        '',
      ].join('\n'));
      return;
    }
    case 'config':
      sayRaw(paint(yaml.dump(redact(cfg)).split('\n').map((l) => '  ' + l).join('\n'), C.gray));
      sayRaw('  ' + dim(CONFIG_PATH) + '\n');
      return;
    case 'setup':
      say('Exit the runtime (/exit) and run `peridot setup` in PowerShell to re-run the configuration wizard.');
      return;
    case 'tokens':
      say(`${fmtTokens(state.session.tokensUsed)} of ${fmtTokens(cfg.model.contextTokens)} context tokens used across ${state.session.turns} turns in session "${state.session.name}".`);
      return;
    case 'theme':
      await themeCommand(state, arg);
      return;
    case 'version':
      say(`Peridot local agent runtime v${VERSION}.`);
      return;
    case 'doctor': {
      const py = findPython();
      const checks = [
        ['node ' + process.version, true],
        ['config ' + (cfg._exists ? 'loaded' : 'missing — run peridot setup'), cfg._exists],
        ['providers ' + (configuredProviders(cfg).map((p) => p.label).join(', ') || 'none configured'), Boolean(activeProvider(cfg))],
        ['python ' + (py ? py.join(' ') + ' (model discovery)' : 'not found — needed to discover models'), Boolean(py)],
        ['password hasher ' + (nativeHashAvailable() ? 'native C' : 'node crypto (run npm run build:native for the C build)'), true],
        ['gateway ' + state.gatewayStatus, state.gatewayStatus.startsWith('reachable')],
        [`agents ${state.agents.length} · sessions(${state.agent.name}) ${listAgentSessions(state.agent.name).length || 1}`, true],
        ['audio suite ' + (audioUnlocked(cfg) ? 'unlocked' : 'locked'), true],
      ];
      for (const [label, ok] of checks) sayRaw('  ' + (ok ? paint('✓', C.neon) : warn('▲')) + ' ' + white(label));
      sayRaw('');
      return;
    }

    // ── filesystem
    case 'ls': {
      const dir = unquote(arg) || process.cwd();
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries.slice(0, 60)) {
        sayRaw('  ' + (e.isDirectory() ? neon(e.name + '/') : white(e.name)));
      }
      if (entries.length > 60) sayRaw('  ' + dim(`… ${entries.length - 60} more`));
      sayRaw('');
      return;
    }
    case 'read': {
      if (!arg) { say('Usage: /read <path>', C.yellow); return; }
      const text = fs.readFileSync(unquote(arg), 'utf8');
      const lines = text.split('\n').slice(0, 80);
      sayRaw(lines.map((l, i) => '  ' + dim(String(i + 1).padStart(4)) + '  ' + grey(l.slice(0, cols() - 12))).join('\n'));
      if (text.split('\n').length > 80) sayRaw('  ' + dim('… truncated at 80 lines'));
      sayRaw('');
      return;
    }
    case 'write': {
      // /write <path> <text>  — quote the path if it contains spaces
      const m = /^\s*(?:"([^"]+)"|(\S+))\s+([\s\S]+)$/.exec(arg);
      if (!m) { say('Usage: /write <path> <text>  (quote paths with spaces)', C.yellow); return; }
      const file = m[1] ?? m[2];
      fs.writeFileSync(file, m[3] + '\n', 'utf8');
      say(`Wrote ${file}.`);
      return;
    }
    case 'edit': {
      const file = unquote(arg);
      if (!file) { say('Usage: /edit <path>', C.yellow); return; }
      if (!fs.existsSync(file)) { say(`Not found: ${file}`, C.yellow); return; }
      runShell(`start "" "${file}"`, { inherit: false });
      say(`Opened ${file} in the system editor.`);
      return;
    }
    case 'mkdir': {
      const dir = unquote(arg);
      if (!dir) { say('Usage: /mkdir <path>', C.yellow); return; }
      fs.mkdirSync(dir, { recursive: true });
      say(`Created ${dir}.`);
      return;
    }
    case 'rm': {
      const target = unquote(arg);
      if (!target) { say('Usage: /rm <path>', C.yellow); return; }
      if (!fs.existsSync(target)) { say(`Not found: ${target}`, C.yellow); return; }
      if (!screenRef) { say('/rm asks for confirmation — run it inside the Peridot runtime.', C.yellow); return; }
      const ans = await promptLine(screenRef, { label: `delete ${target}? type "yes" to confirm`, allowEmpty: true });
      if (ans?.toLowerCase() === 'yes') { fs.rmSync(target, { recursive: true }); say(`Deleted ${target}.`); }
      else say('Kept it.');
      return;
    }
    case 'mv': case 'cp': {
      const parts = splitArgs(arg);
      if (parts.length !== 2) { say(`Usage: /${name} <from> <to>  (quote paths with spaces)`, C.yellow); return; }
      const [a, b] = parts;
      if (!fs.existsSync(a)) { say(`Not found: ${a}`, C.yellow); return; }
      if (name === 'mv') { fs.renameSync(a, b); say(`Moved ${a} → ${b}.`); }
      else { fs.cpSync(a, b, { recursive: true }); say(`Copied ${a} → ${b}.`); }
      return;
    }
    case 'find': {
      if (!arg) { say('Usage: /find <name-fragment>', C.yellow); return; }
      const hits = [];
      walk(process.cwd(), (p, e) => { if (e.name.toLowerCase().includes(arg.toLowerCase())) hits.push(p); });
      if (!hits.length) say('No matches.');
      else sayRaw(hits.slice(0, 30).map((h) => '  ' + white(path.relative(process.cwd(), h))).join('\n') + '\n');
      return;
    }
    case 'tree': {
      const root = unquote(arg) || process.cwd();
      if (!fs.existsSync(root)) { say(`Not found: ${root}`, C.yellow); return; }
      walk(root, (p, e, depth) => {
        if (depth > 2) return;
        sayRaw('  ' + '  '.repeat(depth) + (e.isDirectory() ? neon(e.name + '/') : grey(e.name)));
      }, 0, 2);
      sayRaw('');
      return;
    }

    // ── web
    case 'search': case 'news': case 'docs': {
      if (!arg) { say(`Usage: /${name} <query>`, C.yellow); return; }
      const q = name === 'news' ? arg + ' news' : name === 'docs' ? arg + ' documentation' : arg;
      const sp = cfg.search?.provider || 'duckduckgo';
      const useBrave = sp === 'brave' && cfg.search.apiKey;
      if (sp !== 'duckduckgo' && !useBrave) {
        sayRaw('  ' + dim(sp === 'brave'
          ? 'Brave has no API key configured — using DuckDuckGo. Add the key with `peridot setup`.'
          : `Search provider "${sp}" isn't wired up in this build — using DuckDuckGo.`));
      }
      const stop = spin(`searching via ${useBrave ? 'Brave' : 'DuckDuckGo'}`);
      try {
        let results;
        if (useBrave) {
          const r = await fetch('https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(q), {
            headers: { 'X-Subscription-Token': cfg.search.apiKey, accept: 'application/json' },
          });
          if (!r.ok) throw new Error(`Brave returned ${r.status}`);
          const j = await r.json();
          results = (j.web?.results || []).map((item) => ({
            title: item.title, url: item.url, desc: (item.description || '').replace(/<[^>]+>/g, ''),
          }));
        } else {
          results = await duckduckgo(q);
        }
        stop();
        if (!results.length) { say(`No results for "${q}".`); return; }
        for (const item of results.slice(0, 6)) {
          sayRaw('  ' + nb(item.title) + '\n  ' + dim(item.url) + (item.desc ? '\n  ' + grey(item.desc.slice(0, 200)) : '') + '\n');
        }
        state.lastOutput = results.slice(0, 6).map((x) => `${x.title}\n${x.url}\n${x.desc}`).join('\n\n');
      } catch (e) { stop(); say('Search failed: ' + e.message, C.red); }
      return;
    }
    case 'fetch': case 'scrape': {
      if (!arg) { say(`Usage: /${name} <url>`, C.yellow); return; }
      const url = arg.startsWith('http') ? arg : 'https://' + arg;
      const stop = spin('fetching ' + url);
      try {
        const r = await fetch(url, { headers: { 'user-agent': `peridot/${VERSION}` } });
        let text = await r.text();
        stop();
        if (name === 'scrape') {
          text = text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ').replace(/&\w+;/g, ' ').replace(/\s+/g, ' ').trim();
        }
        say(`${url} → ${r.status}\n\n` + text.slice(0, 1600) + (text.length > 1600 ? '\n…' : ''));
        state.lastOutput = text.slice(0, 6000);
      } catch (e) { stop(); say('Fetch failed: ' + e.message, C.red); }
      return;
    }

    // ── code
    case 'run': case 'git': {
      const cmdline = name === 'git' ? 'git ' + arg : arg;
      if (!cmdline.trim()) { say(`Usage: /${name} <command>`, C.yellow); return; }
      sayRaw('  ' + dim('$ ' + cmdline));
      showOutput(state, runShell(cmdline, { inherit: false }));
      return;
    }
    case 'exec': {
      const file = unquote(arg);
      if (!file) { say('Usage: /exec <script-file>', C.yellow); return; }
      if (!fs.existsSync(file)) { say(`Not found: ${file}`, C.yellow); return; }
      const ext = path.extname(file).toLowerCase();
      const py = findPython();
      const runner = {
        '.py': py ? py.join(' ') : null, '.js': 'node', '.mjs': 'node', '.cjs': 'node',
        '.ps1': 'powershell -NoProfile -ExecutionPolicy Bypass -File', '.bat': '', '.cmd': '',
      }[ext];
      if (runner === undefined) { say(`No runner for ${ext || 'that file'}.`, C.yellow); return; }
      if (runner === null) { say('Python 3.9+ was not found — install it to run .py scripts.', C.yellow); return; }
      const r = runShell(`${runner} "${file}"`.trim());
      say(r.status === 0 ? 'Script finished.' : `Script exited with code ${r.status}.`, r.status === 0 ? C.white : C.yellow);
      return;
    }
    case 'sh':
      say('Dropping into PowerShell — type `exit` to return to Peridot.');
      runShell('powershell -NoLogo');
      say('Back in the Peridot runtime.');
      return;
    case 'py': case 'node': {
      if (!arg) { say(`Usage: /${name} <code>`, C.yellow); return; }
      if (name === 'node') { runDirect(state, process.execPath, ['-e', arg]); return; }
      const py = findPython();
      if (!py) { say('Python 3.9+ was not found — install it to use /py.', C.yellow); return; }
      runDirect(state, py[0], [...py.slice(1), '-c', arg]);
      return;
    }
    case 'test': case 'build': case 'lint': {
      if (!fs.existsSync(path.join(process.cwd(), 'package.json'))) {
        say(`No package.json in ${process.cwd()} — nothing to ${name} here.`, C.yellow);
        return;
      }
      const r = runShell(`npm run ${name}`, { inherit: false });
      const output = ((r.stdout || '') + (r.stderr || '')).trim();
      state.lastOutput = output;
      sayRaw((output || '(no output)').split('\n').slice(-30).map((l) => '  ' + grey(l)).join('\n') + '\n');
      return;
    }
    case 'debug':
      if (!state.lastOutput) { say('Nothing captured yet — run something with /run first, then /debug.', C.yellow); return; }
      await chat(state, 'Debug this command output and tell me what is wrong and how to fix it:\n\n' + state.lastOutput.slice(0, 4000));
      return;

    // ── memory
    case 'remember': {
      if (!arg) { say('Usage: /remember <fact>', C.yellow); return; }
      const mem = loadMemory();
      mem.push({ text: arg, at: new Date().toISOString() });
      saveMemory(mem);
      say(`Stored. ${mem.length} memories in local long-term memory.`);
      return;
    }
    case 'recall': {
      const mem = loadMemory();
      const hits = arg ? mem.filter((m) => m.text.toLowerCase().includes(arg.toLowerCase())) : mem.slice(-5);
      if (!hits.length) { say('No matching memories.'); return; }
      sayRaw(hits.map((m) => '  ' + paint('▪ ', C.deep) + white(m.text) + dim('  (' + m.at.slice(0, 10) + ')')).join('\n') + '\n');
      return;
    }
    case 'forget': {
      const mem = loadMemory();
      const idx = parseInt(arg, 10) - 1;
      if (isNaN(idx) || !mem[idx]) { say('Usage: /forget <number> — see /memories for numbering.', C.yellow); return; }
      const [gone] = mem.splice(idx, 1);
      saveMemory(mem);
      say(`Forgot: "${gone.text}"`);
      return;
    }
    case 'memories': {
      const mem = loadMemory();
      if (!mem.length) { say('Long-term memory is empty. Use /remember <fact>.'); return; }
      sayRaw(mem.map((m, i) => '  ' + dim(String(i + 1).padStart(3) + '.') + ' ' + white(m.text)).join('\n') + '\n');
      return;
    }
    case 'note': {
      if (!arg) { say('Usage: /note <text>', C.yellow); return; }
      const p = path.join(PERIDOT_DIR, 'notepad.md');
      fs.appendFileSync(p, `- ${arg}\n`);
      say(`Noted → ${p}`);
      return;
    }

    // ── agent ops
    case 'plan': {
      if (!arg) { say('Usage: /plan <task> — I will architect it before any build step.', C.yellow); return; }
      const prev = state.mode;
      state.mode = 'plan';
      await chat(state, `Plan this task: ${arg}. Give architecture, file structure, dependencies and ordered steps.`);
      state.mode = prev;
      return;
    }
    case 'act': {
      const lastPlan = [...state.session.history].reverse().find((m) => m.role === 'assistant');
      if (!lastPlan) { say('No plan in context. Use /plan <task> first.', C.yellow); return; }
      state.mode = 'build';
      await chat(state, 'Execute the current plan: give me the exact files and commands, in order, ready to run.');
      return;
    }
    case 'task': {
      if (!arg) { say('Usage: /task <description>', C.yellow); return; }
      (state.session.tasks ??= []).push({ text: arg, done: false });
      saveAgentSession(state.session);
      say(`Queued task #${state.session.tasks.length}: ${arg}`);
      return;
    }
    case 'tasks': {
      const tasks = state.session.tasks || [];
      if (!tasks.length) { say('Task queue is empty. Use /task <description>.'); return; }
      sayRaw(tasks.map((t, i) => '  ' + (t.done ? paint('✓', C.neon) : dim('○')) + ' ' + white(`${i + 1}. ${t.text}`)).join('\n') + '\n');
      return;
    }
    case 'workflow':
      say('Workflow builder: chain commands with "&&" for now — e.g. `/run npm test && npm run build`. Named multi-step workflows land in the next build.');
      return;

    // ── audio (only reachable when unlocked)
    case 'speak': {
      if (!arg) { say('Usage: /speak <text>', C.yellow); return; }
      const stop = spin('synthesizing via ElevenLabs');
      try {
        const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM', {
          method: 'POST',
          headers: { 'xi-api-key': cfg.audio.elevenlabs, 'content-type': 'application/json' },
          body: JSON.stringify({ text: arg, model_id: 'eleven_multilingual_v2' }),
        });
        if (!r.ok) throw new Error(`ElevenLabs ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        const outFile = path.join(PERIDOT_DIR, 'speech-' + Date.now() + '.mp3');
        fs.writeFileSync(outFile, buf);
        stop();
        runShell(`start "" "${outFile}"`, { inherit: false });
        say(`Spoken. Saved to ${outFile} and playing now.`);
      } catch (e) { stop(); say('Speech synthesis failed: ' + e.message, C.red); }
      return;
    }
    case 'transcribe': {
      if (!arg) { say('Usage: /transcribe <audio-file>', C.yellow); return; }
      const stop = spin('transcribing via Deepgram');
      try {
        const audio = fs.readFileSync(arg);
        const r = await fetch('https://api.deepgram.com/v1/listen?model=nova-2', {
          method: 'POST',
          headers: { authorization: 'Token ' + cfg.audio.deepgram, 'content-type': 'audio/*' },
          body: audio,
        });
        const j = await r.json();
        stop();
        say(j.results?.channels?.[0]?.alternatives?.[0]?.transcript || '(no speech detected)');
      } catch (e) { stop(); say('Transcription failed: ' + e.message, C.red); }
      return;
    }
    case 'voice': case 'listen': case 'music': case 'ambient': case 'stream': case 'sound':
      say(`/${name} is unlocked but this capability ships in the next audio build. /speak and /transcribe are live now.`);
      return;

    default:
      say(`/${name} is recognized but not yet wired in this build.`, C.yellow);
  }
}
