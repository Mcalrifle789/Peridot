// Agent registry + per-agent session storage.
// Agents live in ~/.peridot/agents.json; sessions in ~/.peridot/sessions/<agent>__<name>.json
import fs from 'node:fs';
import path from 'node:path';
import { PERIDOT_DIR, SESSION_DIR, ensureDirs } from './config.js';

export const AGENTS_PATH = path.join(PERIDOT_DIR, 'agents.json');

const DEFAULT_AGENT = {
  name: 'peridot',
  desc: 'default local runtime agent',
  system: '',
  lastSession: 'main',
};

export function loadAgents() {
  ensureDirs();
  let list = [];
  try { list = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf8')); } catch { /* fresh */ }
  if (!Array.isArray(list)) list = [];
  if (!list.find((a) => a.name === 'peridot')) list.unshift({ ...DEFAULT_AGENT });
  return list;
}

export function saveAgents(list) {
  ensureDirs();
  fs.writeFileSync(AGENTS_PATH, JSON.stringify(list, null, 2), 'utf8');
}

const sessionPath = (agent, name) => path.join(SESSION_DIR, `${agent}__${name}.json`);

export function loadAgentSession(agent, name = 'main') {
  ensureDirs();
  const p = sessionPath(agent, name);
  try { return { history: [], tasks: [], ...JSON.parse(fs.readFileSync(p, 'utf8')), agent, name }; } catch { /* fall through */ }
  // migrate the pre-agents "main.json" once, for the default agent
  if (agent === 'peridot' && name === 'main') {
    const legacy = path.join(SESSION_DIR, 'main.json');
    try {
      const s = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      return { history: [], tasks: [], ...s, agent, name };
    } catch { /* fresh */ }
  }
  return { agent, name, tokensUsed: 0, turns: 0, history: [], tasks: [] };
}

export function saveAgentSession(s) {
  ensureDirs();
  fs.writeFileSync(sessionPath(s.agent, s.name), JSON.stringify(s, null, 2), 'utf8');
}

export function listAgentSessions(agent) {
  ensureDirs();
  const prefix = `${agent}__`;
  return fs.readdirSync(SESSION_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .map((f) => f.slice(prefix.length, -5))
    .sort();
}
