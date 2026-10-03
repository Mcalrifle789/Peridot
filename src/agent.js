import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import {
  C, paint, BOLD, DIM, neon, nb, soft, dim, grey, white, warn, cols,
} from './theme.js';
import { COMMANDS, findCommand } from './commands.js';
import {
  saveConfig, loadMemory, saveMemory, activeProvider, audioUnlocked,
  fmtTokens, PERIDOT_DIR, CONFIG_PATH,
} from './config.js';
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

// ─── chat via configured provider ────────────────────────────────────────────
const ENDPOINTS = {
  openrouter: 'https://openrouter.ai/api/v1',
  opencode: 'https://opencode.ai/zen/v1',
  kilo: 'https://api.kilocode.ai/v1',
};

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
    say(`I'm running offline — no model provider is configured yet. Run ` +
      `\`peridot setup\` from PowerShell to add an API key (OpenRouter, OpenCode, Kilo or a custom provider), ` +
      `and I'll come fully online. Local tools (/ls, /read, /run, /remember, /search ...) work without one.`);
    return;
  }
  const base = (provider.baseUrl || ENDPOINTS[provider.name] || ENDPOINTS.openrouter).replace(/\/$/, '');
  const model = provider.model || state.cfg.model.id;

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
        'HTTP-Referer': 'https://peridot.local',
        'X-Title': 'Peridot',
      },
      body: JSON.stringify({ model, messages, stream: true }),
    });
  } catch (e) {
    stop(); state.busy = false;
    say(`Gateway error reaching ${provider.name}: ${e.message}`, C.red);
    return;
  }
  if (!res.ok) {
    stop(); state.busy = false;
    const body = await res.text().catch(() => '');
    say(`${provider.name} returned ${res.status}. ${body.slice(0, 300)}\n` +
      `Check the model id (currently "${model}") — you can change it with /model <id> or in peridot.yaml.`, C.yellow);
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
      if (arg) {
        cfg.model.id = arg;
        cfg.model.display = arg.replace(/\./g, '-');
        saveConfig(cfg);
        say(`Model set to ${arg}.`);
      } else {
        say(`Active model: ${cfg.model.display}  (request id: ${cfg.model.id}, ${cfg.model.planning}).\nUse /model <provider/model-id> to switch.`);
      }
      return;
    case 'models': {
      const active = activeProvider(cfg);
      const rows = ['openrouter', 'opencode', 'kilo', 'custom'].map((p) => {
        const has = Boolean(cfg.providers?.[p]?.apiKey);
        const mark = active?.name === p ? neon(' ◂ active') : '';
        return '  ' + (has ? paint('●', C.neon) : dim('○')) + ' ' + white(p.padEnd(11)) + (has ? grey('key configured') : dim('no key')) + mark;
      });
      sayRaw(rows.join('\n') + '\n');
      return;
    }
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
      sayRaw([
        '  ' + soft('runtime   ') + white('peridot v0.2.0 · local ready | ' + (p ? 'online' : 'offline')),
        '  ' + soft('model     ') + white(cfg.model.display),
        '  ' + soft('provider  ') + white(p ? p.name : 'none'),
        '  ' + soft('gateway   ') + white(`http://127.0.0.1:18789 (${state.gatewayStatus})`),
        '  ' + soft('agent     ') + white(`${state.agent.name} · session ${state.session.name}`),
        '  ' + soft('mode      ') + white(state.mode),
        '  ' + soft('tokens    ') + white(`${fmtTokens(state.session.tokensUsed)}/1M`),
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
      say(`${fmtTokens(state.session.tokensUsed)} of 1M context tokens used across ${state.session.turns} turns in session "${state.session.name}".`);
      return;
    case 'theme':
      sayRaw('  ' + paint('■', C.chart) + paint('■', C.neon) + paint('■', C.lime) + paint('■', C.green) + paint('■', C.mid) + paint('■', C.deep) + paint('■', C.dimg) +
        '  ' + soft('peridot green on pitch black — signature ') + neon('#80FF00') + soft(' · title set in Neuton') + '\n');
      return;
    case 'version':
      say('Peridot local agent runtime v0.2.0 — build "full screen".');
      return;
    case 'doctor': {
      const checks = [
        ['node ' + process.version, true],
        ['config ' + (cfg._exists ? 'loaded' : 'missing — run peridot setup'), cfg._exists],
        ['provider ' + (activeProvider(cfg)?.name || 'none configured'), Boolean(activeProvider(cfg))],
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
      const dir = arg || process.cwd();
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
      const text = fs.readFileSync(arg, 'utf8');
      const lines = text.split('\n').slice(0, 80);
      sayRaw(lines.map((l, i) => '  ' + dim(String(i + 1).padStart(4)) + '  ' + grey(l.slice(0, cols() - 12))).join('\n'));
      if (text.split('\n').length > 80) sayRaw('  ' + dim('… truncated at 80 lines'));
      sayRaw('');
      return;
    }
    case 'write': {
      const sp = arg.indexOf(' ');
      if (sp < 0) { say('Usage: /write <path> <text>', C.yellow); return; }
      fs.writeFileSync(arg.slice(0, sp), arg.slice(sp + 1) + '\n', 'utf8');
      say(`Wrote ${arg.slice(0, sp)}.`);
      return;
    }
    case 'edit':
      if (!arg) { say('Usage: /edit <path>', C.yellow); return; }
      runShell(`start "" "${arg}"`, { inherit: false });
      say(`Opened ${arg} in the system editor.`);
      return;
    case 'mkdir':
      if (!arg) { say('Usage: /mkdir <path>', C.yellow); return; }
      fs.mkdirSync(arg, { recursive: true });
      say(`Created ${arg}.`);
      return;
    case 'rm': {
      if (!arg) { say('Usage: /rm <path>', C.yellow); return; }
      if (!fs.existsSync(arg)) { say(`Not found: ${arg}`, C.yellow); return; }
      const ans = await promptLine(screenRef, { label: `delete ${arg}? type "yes" to confirm`, allowEmpty: true });
      if (ans?.toLowerCase() === 'yes') { fs.rmSync(arg, { recursive: true }); say(`Deleted ${arg}.`); }
      else say('Kept it.');
      return;
    }
    case 'mv': {
      const [a, b] = arg.split(' ');
      if (!a || !b) { say('Usage: /mv <from> <to>', C.yellow); return; }
      fs.renameSync(a, b); say(`Moved ${a} → ${b}.`);
      return;
    }
    case 'cp': {
      const [a, b] = arg.split(' ');
      if (!a || !b) { say('Usage: /cp <from> <to>', C.yellow); return; }
      fs.cpSync(a, b, { recursive: true }); say(`Copied ${a} → ${b}.`);
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
      const root = arg || process.cwd();
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
      const stop = spin(`searching via ${sp}`);
      try {
        if (sp === 'brave' && cfg.search.apiKey) {
          const r = await fetch('https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(q), {
            headers: { 'X-Subscription-Token': cfg.search.apiKey, accept: 'application/json' },
          });
          const j = await r.json();
          stop();
          for (const item of (j.web?.results || []).slice(0, 6)) {
            sayRaw('  ' + nb(item.title) + '\n  ' + dim(item.url) + '\n  ' + grey((item.description || '').replace(/<[^>]+>/g, '').slice(0, 200)) + '\n');
          }
        } else {
          const r = await fetch('https://api.duckduckgo.com/?q=' + encodeURIComponent(q) + '&format=json&no_html=1');
          const j = await r.json();
          stop();
          let shown = false;
          if (j.AbstractText) { say(j.AbstractText + (j.AbstractURL ? `\n${j.AbstractURL}` : '')); shown = true; }
          const topics = (j.RelatedTopics || []).filter((t) => t.Text).slice(0, 5);
          for (const t of topics) { sayRaw('  ' + paint('▪ ', C.deep) + grey(t.Text.slice(0, 160)) + '\n  ' + dim(t.FirstURL || '')); shown = true; }
          if (shown) sayRaw('');
          if (!shown) say(`No instant results for "${q}" via DuckDuckGo. For full web results configure Brave in peridot setup, or ask me directly.`);
        }
      } catch (e) { stop(); say('Search failed: ' + e.message, C.red); }
      return;
    }
    case 'fetch': case 'scrape': {
      if (!arg) { say(`Usage: /${name} <url>`, C.yellow); return; }
      const url = arg.startsWith('http') ? arg : 'https://' + arg;
      const stop = spin('fetching ' + url);
      try {
        const r = await fetch(url, { headers: { 'user-agent': 'peridot/0.2' } });
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
      const r = runShell(cmdline, { inherit: false });
      const output = ((r.stdout || '') + (r.stderr || '')).trim();
      state.lastOutput = output;
      sayRaw(output ? output.split('\n').map((l) => '  ' + grey(l)).join('\n') + '\n' : '  ' + dim('(no output)') + '\n');
      return;
    }
    case 'exec': {
      if (!arg) { say('Usage: /exec <script-file>', C.yellow); return; }
      const ext = path.extname(arg).toLowerCase();
      const runner = { '.py': 'python', '.js': 'node', '.mjs': 'node', '.ps1': 'powershell -File', '.bat': '', '.cmd': '' }[ext];
      if (runner === undefined) { say(`No runner for ${ext || 'that file'}.`, C.yellow); return; }
      runShell(`${runner} "${arg}"`.trim());
      say('Script finished.');
      return;
    }
    case 'sh':
      say('Dropping into PowerShell — type `exit` to return to Peridot.');
      runShell('powershell -NoLogo');
      say('Back in the Peridot runtime.');
      return;
    case 'py': case 'node': {
      if (!arg) { say(`Usage: /${name} <code>`, C.yellow); return; }
      const bin = name === 'py' ? 'python -c' : 'node -e';
      const r = runShell(`${bin} "${arg.replace(/"/g, '\\"')}"`, { inherit: false });
      const output = ((r.stdout || '') + (r.stderr || '')).trim();
      state.lastOutput = output;
      sayRaw(output ? output.split('\n').map((l) => '  ' + grey(l)).join('\n') + '\n' : '  ' + dim('(no output)') + '\n');
      return;
    }
    case 'test': case 'build': case 'lint': {
      if (!fs.existsSync(path.join(process.cwd(), 'package.json'))) {
        say(`No package.json in ${process.cwd()} — nothing to ${name} here.`, C.yellow);
        return;
      }
      const r = runShell(`npm run ${name === 'test' ? 'test' : name}`, { inherit: false });
      const output = ((r.stdout || '') + (r.stderr || '')).trim();
      state.lastOutput = output;
      sayRaw(output.split('\n').slice(-30).map((l) => '  ' + grey(l)).join('\n') + '\n');
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
