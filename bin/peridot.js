#!/usr/bin/env node
// Peridot — local AI agent runtime. Entry point / command dispatch.
import { runMain, renderOnce } from '../src/main.js';
import { runSetup } from '../src/setup.js';
import { loadConfig, activeProvider, audioUnlocked, CONFIG_PATH, GATEWAY_PORT } from '../src/config.js';
import { C, paint, BOLD, neon, nb, soft, dim, grey, white } from '../src/theme.js';
import yaml from 'js-yaml';

const [, , cmd] = process.argv;

const HELP = `
 ${nb('peridot')} ${soft('— local AI agent runtime')}

   ${neon('peridot')}            ${grey('launch the main runtime')}
   ${neon('peridot setup')}      ${grey('configuration wizard (credentials, providers, search, audio)')}
   ${neon('peridot status')}     ${grey('quick status report')}
   ${neon('peridot config')}     ${grey('print loaded configuration (keys redacted)')}
   ${neon('peridot doctor')}     ${grey('environment diagnostics')}
   ${neon('peridot help')}       ${grey('this screen')}
`;

function redact(obj) {
  const clone = structuredClone(obj);
  const scrub = (o) => {
    for (const k of Object.keys(o || {})) {
      if (typeof o[k] === 'object' && o[k]) scrub(o[k]);
      else if (/key|token|password|hash/i.test(k) && o[k]) o[k] = String(o[k]).slice(0, 4) + '••••••••';
    }
  };
  scrub(clone);
  delete clone._exists;
  return clone;
}

async function main() {
  switch (cmd) {
    case undefined:
      if (!process.stdin.isTTY && !process.env.PERIDOT_FORCE_TTY) { await renderOnce(); return; }
      await runMain();
      return;
    case 'setup':
      await runSetup();
      return;
    case 'status': {
      const cfg = loadConfig();
      const p = activeProvider(cfg);
      console.log('\n ' + nb('peridot') + soft(' status'));
      console.log('   ' + soft('config    ') + white(cfg._exists ? 'peridot.yaml (loaded)' : 'missing — run peridot setup'));
      console.log('   ' + soft('model     ') + white(cfg.model.display));
      console.log('   ' + soft('provider  ') + white(p ? p.name : 'none (offline)'));
      console.log('   ' + soft('gateway   ') + white(`http://127.0.0.1:${GATEWAY_PORT} (starts with runtime)`));
      console.log('   ' + soft('audio     ') + white(audioUnlocked(cfg) ? 'unlocked' : 'locked') + '\n');
      return;
    }
    case 'config': {
      const cfg = loadConfig();
      console.log('\n' + paint(yaml.dump(redact(cfg)), C.gray) + dim(CONFIG_PATH) + '\n');
      return;
    }
    case 'doctor': {
      const cfg = loadConfig();
      const p = activeProvider(cfg);
      const rows = [
        ['node ' + process.version, parseInt(process.versions.node) >= 18],
        ['config ' + (cfg._exists ? 'loaded' : 'missing'), cfg._exists],
        ['model provider ' + (p ? p.name : 'none'), Boolean(p)],
        ['search provider ' + (cfg.search?.provider || 'none'), Boolean(cfg.search?.provider)],
        ['audio suite ' + (audioUnlocked(cfg) ? 'unlocked' : 'locked (optional)'), true],
      ];
      console.log('');
      for (const [label, ok] of rows) {
        console.log('   ' + (ok ? paint('✓', C.neon) : paint('▲', C.yellow)) + ' ' + white(label));
      }
      console.log('');
      return;
    }
    case '--version': case '-v': case 'version':
      console.log('peridot v0.2.0');
      return;
    case 'help': case '--help': case '-h':
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(paint(' peridot fatal: ', C.red, BOLD) + e.stack);
  process.exit(1);
});
