import {
  C, paint, BOLD, DIM, neon, nb, soft, dim, grey, white, rule, gradient,
} from './theme.js';
import { smallMark } from './logo.js';
import { loadConfig, saveConfig, hashPassword, CONFIG_PATH } from './config.js';
import { rawStart, rawStop, textInput, singleSelect, multiSelect, sleep } from './ui.js';

const header = (step, total, title) =>
  '\n ' + neon('◈') + ' ' + gradient(`peridot setup`, C.chart, C.neon, BOLD) +
  dim(`  ·  step ${step}/${total}  ·  `) + soft(title) + '\n ' + rule(56, C.deep) + '\n';

export async function runSetup() {
  const cfg = loadConfig();
  rawStart();
  console.clear();

  process.stdout.write('\n ' + gradient('PERIDOT CONFIGURATION WIZARD', C.chart, C.neon, BOLD) + '\n');
  process.stdout.write(' ' + soft('Answers are saved to ') + grey(CONFIG_PATH) + '\n');

  // 1 ── user credentials
  process.stdout.write(header(1, 4, 'user credentials'));
  const username = await textInput({ label: 'username', hint: 'how Peridot addresses you' });
  if (username === null) return abort();
  let passwordHash = cfg.user.passwordHash;
  const pw = await textInput({ label: 'password', mask: true, allowEmpty: true, hint: 'enter to keep/skip' });
  if (pw === null) return abort();
  if (pw) passwordHash = hashPassword(pw);

  // 2 ── model providers (an API key is REQUIRED to complete setup)
  // Flow: pick a provider with enter → immediately enter its API key → optionally add another.
  process.stdout.write(header(2, 4, 'AI model providers'));
  process.stdout.write(' ' + paint('▲', C.yellow) + ' ' + soft('required — Peridot needs at least one model provider API key to run.') + '\n');
  const providers = cfg.providers || {};
  const PROVIDER_ITEMS = [
    { label: 'OpenRouter', key: 'openrouter', desc: 'recommended — anthropic/claude models' },
    { label: 'OpenCode', key: 'opencode', desc: 'OpenCode Zen gateway' },
    { label: 'Kilo', key: 'kilo', desc: 'Kilo Code gateway' },
    { label: 'Custom Provider', key: 'custom', desc: 'any OpenAI-compatible endpoint' },
  ];
  for (;;) {
    const items = PROVIDER_ITEMS.map((p) => ({
      ...p,
      desc: providers[p.key]?.apiKey ? 'key configured ✓ — select to replace' : p.desc,
    }));
    const picked = await singleSelect({ title: 'choose a model provider', items });
    if (picked === null) return abort();

    const apiKey = await textInput({ label: `${picked.label} API key`, mask: true, allowEmpty: false, hint: 'required' });
    if (apiKey === null) return abort();
    providers[picked.key] = { ...(providers[picked.key] || {}), apiKey };
    if (picked.key === 'custom') {
      const baseUrl = await textInput({ label: 'custom base URL', hint: 'e.g. https://api.example.com/v1' });
      if (baseUrl === null) return abort();
      const model = await textInput({ label: 'custom model id', allowEmpty: true, hint: 'enter for default' });
      providers.custom.baseUrl = baseUrl;
      if (model) providers.custom.model = model;
    }
    process.stdout.write(' ' + paint('✓', C.neon, BOLD) + ' ' + soft(`${picked.label} configured.`) + '\n');

    const again = await singleSelect({
      title: 'add another model provider?',
      items: [
        { label: 'no — continue setup', done: true },
        { label: 'yes — add another provider', done: false },
      ],
    });
    if (again === null) return abort();
    if (again.done) break;
  }

  // 3 ── search provider
  process.stdout.write(header(3, 4, 'web search provider'));
  const search = await singleSelect({
    title: 'choose a search provider',
    items: [
      { label: 'DuckDuckGo', key: 'duckduckgo', desc: 'no key required' },
      { label: 'Google Gemini', key: 'gemini', desc: 'grounded search' },
      { label: 'Perplexity', key: 'perplexity', desc: 'answer engine' },
      { label: 'Parallel', key: 'parallel', desc: 'parallel.ai search API' },
      { label: 'Parallel Free', key: 'parallel-free', desc: 'no key required' },
      { label: 'Firecrawl', key: 'firecrawl', desc: 'search + scrape' },
      { label: 'Brave', key: 'brave', desc: 'independent index' },
      { label: 'Custom Search Provider', key: 'custom-search', desc: 'your own endpoint' },
    ],
  });
  if (search === null) return abort();
  let searchKey = '';
  if (!['duckduckgo', 'parallel-free'].includes(search.key)) {
    searchKey = await textInput({ label: `${search.label} API key`, mask: true, allowEmpty: true, hint: 'enter to skip' });
    if (searchKey === null) return abort();
  }

  // 4 ── optional audio integration
  process.stdout.write(header(4, 4, 'audio integration (optional)'));
  process.stdout.write(' ' + dim('Optional — but both keys are required to unlock the 8 audio/music commands.') + '\n');
  const eleven = await textInput({ label: 'ElevenLabs API key', mask: true, allowEmpty: true, hint: 'enter to skip' });
  if (eleven === null) return abort();
  const deepgram = await textInput({ label: 'Deepgram API key', mask: true, allowEmpty: true, hint: 'enter to skip' });
  if (deepgram === null) return abort();

  // save
  cfg.user = { username, passwordHash };
  cfg.providers = providers;
  cfg.search = { provider: search.key, apiKey: searchKey || '' };
  cfg.audio = { elevenlabs: eleven || cfg.audio.elevenlabs || '', deepgram: deepgram || cfg.audio.deepgram || '' };
  saveConfig(cfg);

  const audioOn = cfg.audio.elevenlabs && cfg.audio.deepgram;
  process.stdout.write('\n ' + rule(56, C.deep) + '\n');
  process.stdout.write(' ' + paint('✓', C.neon, BOLD) + ' ' + white('Configuration saved to ') + grey('peridot.yaml') + '\n');
  process.stdout.write('   ' + soft('providers: ') + white(Object.keys(providers).join(', ') || 'none (offline mode)') + '\n');
  process.stdout.write('   ' + soft('search:    ') + white(search.label) + '\n');
  process.stdout.write('   ' + soft('audio:     ') + white(audioOn ? 'unlocked — 8 audio commands enabled' : 'locked — 8 audio commands disabled') + '\n');
  process.stdout.write('\n ' + smallMark() + soft('  run ') + nb('peridot') + soft(' to launch the runtime.') + '\n\n');
  rawStop();
}

function abort() {
  process.stdout.write('\n ' + paint('▲', C.yellow) + ' ' + soft('setup aborted — nothing saved.') + '\n');
  rawStop();
}
