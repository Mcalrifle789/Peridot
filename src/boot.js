import http from 'node:http';
import {
  C, paint, BOLD, neon, soft, dim, grey, white, gradient,
} from './theme.js';
import { logo } from './logo.js';
import { GATEWAY_HOST, GATEWAY_PORT, activeProvider, audioUnlocked } from './config.js';
import { configuredProviders } from './providers.js';
import { sleep } from './ui.js';

// The local gateway — a real HTTP endpoint on 127.0.0.1:18789.
export function startGateway(state) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        app: 'peridot',
        status: 'ok',
        agent: state.agent?.name || 'peridot',
        session: state.session?.name || 'main',
        model: state.cfg.model.id,
        provider: state.cfg.model.provider,
        mode: state.mode,
        tokens: state.session?.tokensUsed || 0,
      }));
    });
    server.on('error', () => resolve({ server: null, status: 'reachable (external)' }));
    server.listen(GATEWAY_PORT, GATEWAY_HOST, () => resolve({ server, status: 'reachable' }));
  });
}

const STAGES = [
  'loading peridot kernel',
  'reading peridot.yaml',
  'binding gateway 127.0.0.1:18789',
  'mounting tools: filesystem · web · code · memory',
  'warming fuzzy local planner',
  'attaching agent + session',
];

// Intentional ~3s startup sequence, rendered inside the full-screen app.
export async function bootSequence(screen) {
  for (const stage of STAGES) {
    const stop = screen.spinner(stage);
    await sleep(500);
    stop();
    screen.push(paint('▪ ', C.deep) + dim(stage));
  }
  await sleep(120);
}

export function landingScreen(state) {
  const { cfg, gatewayStatus } = state;
  const username = cfg.user?.username || 'operator';
  const agentName = state.agent?.name || 'peridot';
  const sessName = state.session?.name || 'main';
  const provider = activeProvider(cfg);
  const audio = audioUnlocked(cfg);
  const out = [];

  out.push(
    neon('peridot') + ' ' + paint(username, C.chart) + dim(' — ') +
    soft('local agent runtime') + dim(' — ') +
    paint('Peridot AI', C.green) + dim(' — ') +
    soft(`session ${sessName}`)
  );
  out.push(' ' + dim(`session agent:${agentName}:${sessName}`));
  out.push('');
  out.push(logo());
  out.push('');
  out.push(gradient("Hi, I'm Peridot.", C.chart, C.neon, BOLD));
  out.push('');
  const li = (label, value) => paint('- ', C.deep) + soft(label + ': ') + white(value);
  out.push(paint('- ', C.deep) + white('Local agent runtime initialized.'));
  out.push(li('Model', cfg.model.display + ' ' + '\x1b[0m' + grey('(' + cfg.model.planning + ')')));
  out.push(li('Config', 'peridot.yaml ' + (cfg._exists ? grey('(loaded)') : paint('(not found — run `peridot setup`)', C.yellow))));
  out.push(li('Gateway', `http://${GATEWAY_HOST}:${GATEWAY_PORT} ` + grey('(' + gatewayStatus + ')')));
  out.push(li('Tools', 'filesystem, web, code, memory' + (audio ? ', audio' : '')));
  out.push(li('Agent', agentName + ' \x1b[0m' + grey(`(session ${sessName} · ${state.mode} mode)`)));
  const others = configuredProviders(cfg).filter((p) => p.key !== provider?.key).map((p) => p.label);
  out.push(li('Provider', provider
    ? provider.label + (others.length ? ' \x1b[0m' + grey(`(+ ${others.join(', ')} · /model to switch)`) : '')
    : 'none — offline (add one with /provider)'));
  out.push('');
  out.push(white('All systems nominal. Awaiting ') + neon('your command') + white('.'));
  return out.join('\n');
}
