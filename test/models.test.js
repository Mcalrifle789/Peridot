import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isolatedHome, mockProviders, fakeScreen, GOOD_KEY } from './helpers.js';

isolatedHome();
const { loadConfig, saveConfig } = await import('../src/config.js');
const { discoverModels, allModels, providerModels, loadCatalog, undiscovered, findPython } = await import('../src/catalog.js');
const { defaultModelFor, activeProvider, configuredProviders } = await import('../src/providers.js');
const { handleInput, bindScreen } = await import('../src/agent.js');

let mock;
before(async () => { mock = await mockProviders(); });
after(async () => { await mock.close(); });

const cfgWith = (providers) => {
  const cfg = loadConfig();
  cfg.providers = providers;
  return cfg;
};

test('python is available for model discovery', () => {
  assert.ok(findPython(), 'Python 3.9+ must be installed to run these tests');
});

test('discovers every model from OpenAI-, Anthropic- and Gemini-style APIs, concurrently', async () => {
  const cfg = cfgWith({
    custom: { apiKey: GOOD_KEY, baseUrl: `${mock.base}/openai` },
    anthropic: { apiKey: GOOD_KEY, baseUrl: `${mock.base}/anthropic` },
    gemini: { apiKey: GOOD_KEY, baseUrl: `${mock.base}/gemini` },
  });
  const res = await discoverModels(cfg);

  assert.ok(res.custom.ok);
  assert.deepEqual(res.custom.models.map((m) => m.id), ['gpt-a', 'gpt-b'], 'non-chat models filtered, duplicates removed, sorted');
  assert.equal(res.custom.models.find((m) => m.id === 'gpt-a').context, 200000);
  assert.equal(res.custom.models.find((m) => m.id === 'gpt-b').context, 128000);

  assert.ok(res.anthropic.ok);
  assert.deepEqual(res.anthropic.models.map((m) => m.id), ['claude-a', 'claude-b', 'claude-c'], 'follows pagination');
  assert.equal(res.anthropic.models[0].name, 'Claude A');

  assert.ok(res.gemini.ok);
  assert.deepEqual(res.gemini.models.map((m) => m.id), ['gemini-y', 'gemini-z'], 'paginates, strips models/, keeps generateContent only');
  assert.equal(res.gemini.models[1].context, 1048576);

  // the key travels in each provider's own auth header
  const anth = mock.requests.find((r) => r.path === '/anthropic/models');
  assert.equal(anth.headers['x-api-key'], GOOD_KEY);
  const gem = mock.requests.find((r) => r.path === '/gemini/models');
  assert.equal(gem.headers['x-goog-api-key'], GOOD_KEY);
  assert.ok(!gem.query.has('key'), 'Gemini key is not put in the URL');

  // cached and merged across providers
  assert.equal(allModels(cfg).length, 7);
  assert.deepEqual(undiscovered(cfg), []);
});

test('reports a rejected key or a non-API URL clearly, without breaking other providers', async () => {
  const cfg = cfgWith({
    custom: { apiKey: 'wrong-key', baseUrl: `${mock.base}/openai` },
    anthropic: { apiKey: GOOD_KEY, baseUrl: `${mock.base}/html` },
    openrouter: { apiKey: GOOD_KEY, baseUrl: `${mock.base}/openai` },
  });
  const res = await discoverModels(cfg);
  assert.equal(res.custom.ok, false);
  assert.match(res.custom.error, /401.*API key rejected.*Incorrect API key provided/);
  assert.equal(res.anthropic.ok, false);
  assert.match(res.anthropic.error, /not JSON/);
  assert.equal(res.openrouter.ok, true, 'other providers still succeed');
  // a failed refresh keeps the last good list but records the error
  assert.deepEqual(providerModels(cfg, 'custom').map((m) => m.id), ['gpt-a', 'gpt-b']);
  assert.match(loadCatalog().providers.custom.error, /401/);
  assert.deepEqual(undiscovered(cfg), [], 'failed providers are not retried on every /model');
});

test('a manually entered custom model id is always selectable', () => {
  const cfg = cfgWith({ custom: { apiKey: GOOD_KEY, baseUrl: `${mock.base}/openai`, model: 'my-own-model' } });
  assert.equal(providerModels(cfg, 'custom')[0].id, 'my-own-model');
});

test('defaultModelFor prefers the provider\'s flagship family', () => {
  const pick = (key, ids) => defaultModelFor(key, ids.map((id) => ({ id })))?.id;
  assert.equal(pick('anthropic', ['claude-3-haiku-20240307', 'claude-sonnet-4-5-20250929', 'claude-opus-4-1-20250805']), 'claude-sonnet-4-5-20250929');
  assert.equal(pick('openrouter', ['x/y', 'anthropic/claude-sonnet-4.5:thinking', 'anthropic/claude-sonnet-4.5']), 'anthropic/claude-sonnet-4.5');
  assert.equal(pick('openai', ['gpt-5-nano', 'gpt-5', 'gpt-4o']), 'gpt-5');
  assert.equal(pick('custom', ['only-one']), 'only-one');
  assert.equal(pick('custom', []), undefined);
});

test('v0.2 configs migrate to a provider-aware model', async () => {
  const fs = await import('node:fs');
  const { CONFIG_PATH } = await import('../src/config.js');
  fs.writeFileSync(CONFIG_PATH, [
    'model:', '  id: anthropic/claude-sonnet-4.5',
    'providers:', '  custom:', '    apiKey: k', '    baseUrl: https://example.com/v1', '    model: custom-model',
    '  opencode:', '    apiKey: k2',
  ].join('\n'));
  const cfg = loadConfig();
  assert.equal(cfg.model.provider, 'custom', 'legacy priority: custom before opencode');
  assert.equal(cfg.model.id, 'custom-model');
  assert.equal(cfg.theme, 'peridot');
  assert.deepEqual(configuredProviders(cfg).map((p) => p.key), ['opencode', 'custom']);
  assert.equal(activeProvider(cfg).key, 'custom');
});

test('chat goes to the active model\'s provider with that provider\'s key', async () => {
  const cfg = cfgWith({
    openrouter: { apiKey: 'other-providers-key', baseUrl: `${mock.base}/nowhere` },
    custom: { apiKey: GOOD_KEY, baseUrl: `${mock.base}/openai` },
  });
  cfg.model = { ...cfg.model, provider: 'custom', id: 'gpt-b', display: 'gpt-b' };
  saveConfig(cfg);
  const state = {
    cfg, mode: 'build', agent: { name: 'peridot' },
    session: { agent: 'peridot', name: 'test', history: [], tokensUsed: 0, turns: 0, tasks: [] },
  };
  const screen = fakeScreen();
  bindScreen(screen);
  await handleInput(state, 'hi there');
  assert.match(screen.text(), /Hello from gpt-b/);
  const req = mock.requests.filter((r) => r.path === '/openai/chat/completions').pop();
  assert.equal(req.headers.authorization, `Bearer ${GOOD_KEY}`);
  assert.equal(JSON.parse(req.body).model, 'gpt-b');
  assert.equal(req.headers['x-title'], undefined, 'OpenRouter-only headers are not sent elsewhere');
  assert.equal(state.session.turns, 1);
});
