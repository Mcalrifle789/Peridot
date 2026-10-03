import {
  C, paint, BOLD, neon, nb, soft, dim, grey, white, rule, gradient, applyTheme,
} from './theme.js';
import { smallMark } from './logo.js';
import { loadConfig, saveConfig, setModel, CONFIG_PATH } from './config.js';
import { hashPassword } from './hash.js';
import { PROVIDERS, providerInfo, providerLabel, configuredProviders, defaultModelFor } from './providers.js';
import { discoverModels, providerModels } from './catalog.js';
import { rawStart, rawStop, textInput, singleSelect, spinnerStart } from './ui.js';

const header = (step, total, title) =>
  '\n ' + neon('◈') + ' ' + gradient(`peridot setup`, C.chart, C.neon, BOLD) +
  dim(`  ·  step ${step}/${total}  ·  `) + soft(title) + '\n ' + rule(56, C.deep) + '\n';

const say = (mark, text) => process.stdout.write(' ' + mark + ' ' + soft(text) + '\n');
const ok = (text) => say(paint('✓', C.neon, BOLD), text);
const warnLine = (text) => say(paint('▲', C.yellow), text);

export async function runSetup() {
  const cfg = loadConfig();
  applyTheme(cfg.theme);
  rawStart();
  console.clear();

  process.stdout.write('\n ' + gradient('PERIDOT CONFIGURATION WIZARD', C.chart, C.neon, BOLD) + '\n');
  process.stdout.write(' ' + soft('Answers are saved to ') + grey(CONFIG_PATH) + '\n');

  // 1 ── user credentials: username, password, password confirmation (all required)
  process.stdout.write(header(1, 4, 'user credentials'));
  const username = await textInput({ label: 'username', hint: 'required — how Peridot addresses you' });
  if (username === null) return abort();
  let passwordHash;
  for (;;) {
    const pw = await textInput({ label: 'password', mask: true, trim: false, hint: 'required' });
    if (pw === null) return abort();
    const confirm = await textInput({ label: 'confirm password', mask: true, trim: false, hint: 'type it again' });
    if (confirm === null) return abort();
    if (pw === confirm) {
      passwordHash = hashPassword(pw);
      ok('password set.');
      break;
    }
    warnLine('passwords do not match — please enter them again.');
  }

  // 2 ── model providers: add as many as you like; at least one is required.
  // Each key is used right away to discover every model that provider offers.
  process.stdout.write(header(2, 4, 'AI model providers'));
  process.stdout.write(' ' + paint('▲', C.yellow) + ' ' + soft('required — add at least one provider API key. Add several to use models from all of them.') + '\n');
  const providers = structuredClone(cfg.providers || {});
  for (;;) {
    const configured = PROVIDERS.filter((p) => providers[p.key]?.apiKey);
    const items = [
      ...(configured.length
        ? [{ label: 'continue', desc: 'with ' + configured.map((p) => p.label).join(', '), done: true }]
        : []),
      ...PROVIDERS.map((p) => ({
        ...p,
        desc: providers[p.key]?.apiKey ? 'key configured ✓ — select to replace' : p.desc,
      })),
    ];
    const picked = await singleSelect({
      title: configured.length ? 'add another model provider, or continue' : 'choose a model provider',
      items,
    });
    if (picked === null) return abort();
    if (picked.done) break;
    const added = await addProvider(cfg, providers, providerInfo(picked.key));
    if (added === null) return abort();
  }

  // Active model: keep the current one if it is still available, otherwise
  // pick a sensible default from the first provider that has models.
  const draft = { ...cfg, providers };
  const current = providerModels(draft, cfg.model.provider).find((m) => m.id === cfg.model.id);
  if (!current) {
    const withModels = configuredProviders(draft)
      .map((p) => ({ key: p.key, model: defaultModelFor(p.key, providerModels(draft, p.key)) }))
      .find((x) => x.model);
    if (withModels) setModel(cfg, withModels.key, withModels.model);
    else cfg.model.provider = configuredProviders(draft)[0].key;
  }
  ok(`active model: ${cfg.model.display} (${providerLabel(cfg.model.provider)}) — switch any time with /model.`);

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
  const modelCount = configuredProviders(cfg).reduce((n, p) => n + providerModels(cfg, p.key).length, 0);
  process.stdout.write('\n ' + rule(56, C.deep) + '\n');
  process.stdout.write(' ' + paint('✓', C.neon, BOLD) + ' ' + white('Configuration saved to ') + grey('peridot.yaml') + '\n');
  process.stdout.write('   ' + soft('user:      ') + white(username) + '\n');
  process.stdout.write('   ' + soft('providers: ') + white(configuredProviders(cfg).map((p) => p.label).join(', ')) +
    grey(`  (${modelCount} models)`) + '\n');
  process.stdout.write('   ' + soft('model:     ') + white(`${cfg.model.display}`) + grey(` · ${providerLabel(cfg.model.provider)}`) + '\n');
  process.stdout.write('   ' + soft('search:    ') + white(search.label) + '\n');
  process.stdout.write('   ' + soft('audio:     ') + white(audioOn ? 'unlocked — 8 audio commands enabled' : 'locked — 8 audio commands disabled') + '\n');
  process.stdout.write('\n ' + smallMark() + soft('  run ') + nb('peridot') + soft(' to launch the runtime.') + '\n\n');
  rawStop();
}

// Ask for one provider's key (and base URL for custom), then verify it by
// discovering the provider's models. Mutates `providers` on success.
// Resolves 'ok' | 'skip', or null if the user aborted setup.
async function addProvider(cfg, providers, info) {
  for (;;) {
    const apiKey = await textInput({ label: `${info.label} API key`, mask: true, hint: 'required' });
    if (apiKey === null) return null;
    // replacing a key keeps a base-URL override the provider already had
    const prevBase = providers[info.key]?.baseUrl;
    const entry = !info.needsBaseUrl && prevBase ? { apiKey, baseUrl: prevBase } : { apiKey };
    if (info.needsBaseUrl) {
      for (;;) {
        const baseUrl = await textInput({ label: 'base URL', hint: 'OpenAI-compatible, e.g. https://api.example.com/v1' });
        if (baseUrl === null) return null;
        if (/^https?:\/\/\S+$/i.test(baseUrl)) { entry.baseUrl = baseUrl.replace(/\/+$/, ''); break; }
        warnLine('the base URL must start with http:// or https://');
      }
    }

    const stop = spinnerStart(`finding ${info.label} models with your key`);
    const res = (await discoverModels({ ...cfg, providers: { ...providers, [info.key]: entry } }, [info.key]))[info.key];
    if (res?.ok) {
      stop(' ' + paint('✓', C.neon, BOLD) + ' ' + soft(`${info.label}: ${res.models.length} models available.`));
      providers[info.key] = entry;
      return 'ok';
    }
    stop(' ' + paint('▲', C.yellow) + ' ' + soft(`${info.label}: ${res?.error || 'model discovery failed'}`));

    const next = await singleSelect({
      title: 'what now?',
      items: [
        { label: 're-enter the key', act: 'retry' },
        { label: 'keep it anyway', act: 'keep', desc: 'retry discovery later with /models refresh' },
        { label: 'skip this provider', act: 'skip' },
      ],
    });
    if (next === null) return null;
    if (next.act === 'skip') return 'skip';
    if (next.act === 'keep') {
      if (info.needsBaseUrl) {
        const model = await textInput({ label: 'model id to use', hint: 'no model list was found, so name one' });
        if (model === null) return null;
        entry.model = model;
      }
      providers[info.key] = entry;
      return 'ok';
    }
  }
}

function abort() {
  process.stdout.write('\n ' + paint('▲', C.yellow) + ' ' + soft('setup aborted — nothing saved.') + '\n');
  rawStop();
}
