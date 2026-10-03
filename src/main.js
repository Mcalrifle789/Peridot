import { loadConfig, activeProvider, audioUnlocked, fmtTokens } from './config.js';
import { loadAgents, loadAgentSession, saveAgentSession } from './agents.js';
import { bootSequence, startGateway, landingScreen } from './boot.js';
import { Screen } from './screen.js';
import { readInput } from './input.js';
import { rawStart, rawStop } from './ui.js';
import { handleInput, bindScreen } from './agent.js';
import { COMMANDS } from './commands.js';
import { C, paint, BOLD, soft, dim, neon, grey } from './theme.js';

function buildState() {
  const cfg = loadConfig();
  const agents = loadAgents();
  const agent = agents.find((a) => a.name === (cfg.activeAgent || 'peridot')) || agents[0];
  const session = loadAgentSession(agent.name, agent.lastSession || 'main');
  return { cfg, agents, agent, session, mode: 'build', gatewayStatus: 'unreachable', lastOutput: '', busy: false };
}

const modelName = (cfg) => cfg.model.display
  .replace(/^anthropic\//, '')
  .replace(/claude-sonnet-4-6/, 'Claude Sonnet 4.6')
  .replace(/-/g, ' ');

export async function runMain() {
  const state = buildState();

  const modeChip = () => state.mode === 'plan'
    ? paint(' PLAN ', C.chart, BOLD)
    : paint(' BUILD ', C.neon, BOLD);

  const screen = new Screen(() => ({
    headerLeft: paint('◈ PERIDOT', C.neon, BOLD) + dim('  local agent runtime'),
    headerRight: soft('agent ') + neon(state.agent.name) + dim(' · ') +
      soft('session ') + neon(state.session.name) + dim(' · ') + modeChip(),
    statusRight: `/ commands · pgup/pgdn scroll · ${state.mode} mode`,
    idle: state.busy ? 'working' : 'idle',
    footerLeft: soft('Model: ') + neon(modelName(state.cfg)),
    footerRight: grey(`${fmtTokens(state.session.tokensUsed)}/1M tokens`),
  }));

  state.screen = screen;
  bindScreen(screen);

  const gw = await startGateway(state);
  state.gatewayStatus = gw.status;

  rawStart();
  screen.enter();
  await bootSequence(screen);
  screen.clearContent();
  screen.push(landingScreen(state));

  for (;;) {
    const input = await readInput(screen, {
      commands: COMMANDS,
      audioOn: audioUnlocked(state.cfg),
    });
    const result = await handleInput(state, input);
    if (result.exit) break;
  }

  saveAgentSession(state.session);
  gw.server?.close();
  screen.exit();
  rawStop();
  process.stdout.write('\n ' + neon('◈') + ' ' + soft('Peridot runtime shut down. ') + dim('session saved · gateway released') + '\n\n');
  process.exit(0);
}

// Non-interactive smoke path (piped stdin / CI): render the landing screen once.
export async function renderOnce() {
  const state = buildState();
  state.gatewayStatus = 'skipped (non-interactive)';
  process.stdout.write(landingScreen(state) + '\n');
}
