// Model provider registry. Every provider is reached for chat through an
// OpenAI-compatible /chat/completions endpoint at `base`; model discovery
// (native/python/peridot_models.py) uses `kind` + `modelsBase`.
//
// cfg.providers: { <key>: { apiKey, baseUrl? } } — any number at once.
// cfg.model:     { provider, id, display, contextTokens } — the active model.

export const PROVIDERS = [
  {
    key: 'openrouter', label: 'OpenRouter', desc: 'hundreds of models behind one key',
    kind: 'openai', base: 'https://openrouter.ai/api/v1',
    prefer: ['anthropic/claude-sonnet', 'openai/gpt-5', 'google/gemini'],
  },
  {
    key: 'openai', label: 'OpenAI', desc: 'GPT models',
    kind: 'openai', base: 'https://api.openai.com/v1', chatOnly: true,
    prefer: ['gpt-5', 'gpt-4.1', 'gpt-4o'],
  },
  {
    key: 'anthropic', label: 'Anthropic', desc: 'Claude models',
    kind: 'anthropic', base: 'https://api.anthropic.com/v1',
    prefer: ['claude-sonnet', 'claude-opus'],
  },
  {
    key: 'gemini', label: 'Google Gemini', desc: 'Gemini models',
    kind: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    modelsBase: 'https://generativelanguage.googleapis.com/v1beta', chatOnly: true,
    prefer: ['gemini'],
  },
  {
    key: 'groq', label: 'Groq', desc: 'fast open-weight inference',
    kind: 'openai', base: 'https://api.groq.com/openai/v1', chatOnly: true,
    prefer: ['llama', 'qwen', 'gpt-oss'],
  },
  {
    key: 'mistral', label: 'Mistral', desc: 'Mistral models',
    kind: 'openai', base: 'https://api.mistral.ai/v1', chatOnly: true,
    prefer: ['mistral-large', 'mistral-medium'],
  },
  {
    key: 'deepseek', label: 'DeepSeek', desc: 'DeepSeek models',
    kind: 'openai', base: 'https://api.deepseek.com/v1', chatOnly: true,
    prefer: ['deepseek-chat'],
  },
  {
    key: 'xai', label: 'xAI', desc: 'Grok models',
    kind: 'openai', base: 'https://api.x.ai/v1', chatOnly: true,
    prefer: ['grok'],
  },
  {
    key: 'opencode', label: 'OpenCode', desc: 'OpenCode Zen gateway',
    kind: 'openai', base: 'https://opencode.ai/zen/v1',
    prefer: ['claude-sonnet', 'gpt-5'],
  },
  {
    key: 'kilo', label: 'Kilo', desc: 'Kilo Code gateway',
    kind: 'openai', base: 'https://api.kilo.ai/api/gateway',
    prefer: ['anthropic/claude-sonnet', 'kilo-auto'],
  },
  {
    key: 'custom', label: 'Custom Provider', desc: 'any OpenAI-compatible endpoint',
    kind: 'openai', base: '', chatOnly: true, needsBaseUrl: true,
    prefer: [],
  },
];

export const providerInfo = (key) => PROVIDERS.find((p) => p.key === key) || null;
export const providerLabel = (key) => providerInfo(key)?.label || key;

// A configured provider, merged with its registry entry.
function resolve(info, conf) {
  const base = (conf.baseUrl || info.base || '').replace(/\/+$/, '');
  return {
    ...info,
    name: info.key,
    apiKey: conf.apiKey,
    base,
    modelsBase: (conf.baseUrl ? base : info.modelsBase || base).replace(/\/+$/, ''),
    manualModel: conf.model || '',
  };
}

// Providers that have an API key, in registry order.
export function configuredProviders(cfg) {
  return PROVIDERS
    .filter((p) => cfg.providers?.[p.key]?.apiKey)
    .map((p) => resolve(p, cfg.providers[p.key]));
}

export function getProvider(cfg, key) {
  const info = providerInfo(key);
  const conf = cfg.providers?.[key];
  return info && conf?.apiKey ? resolve(info, conf) : null;
}

// The provider the active model belongs to (falls back to the first configured one).
export function activeProvider(cfg) {
  return getProvider(cfg, cfg.model?.provider) || configuredProviders(cfg)[0] || null;
}

// Pick a sensible starting model from a provider's discovered list.
export function defaultModelFor(key, models) {
  if (!models?.length) return null;
  const info = providerInfo(key);
  const sorted = [...models].sort((a, b) => b.id.localeCompare(a.id));
  const variant = /:|(^|[-.])(pro|nano|preview|audio|search|vision|instruct)([-.]|$)|\d{4}-?\d{2}-?\d{2}/i;
  for (const want of info?.prefer || []) {
    const hits = sorted.filter((m) => m.id.includes(want));
    const plain = hits.find((m) => !variant.test(m.id));
    if (plain || hits[0]) return plain || hits[0];
  }
  return models[0];
}
