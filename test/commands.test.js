// Runs every Peridot command through the real dispatcher against a fake
// screen, an isolated ~/.peridot and a mock model provider.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatedHome, mockProviders, fakeScreen, press, keys, waitFor, GOOD_KEY } from './helpers.js';

const home = isolatedHome();
const { loadConfig, saveConfig } = await import('../src/config.js');
const { handleInput, bindScreen } = await import('../src/agent.js');
const { COMMANDS } = await import('../src/commands.js');
const { currentTheme, applyTheme } = await import('../src/theme.js');
const { loadAgents, loadAgentSession } = await import('../src/agents.js');

let mock, screen, state;
const work = path.join(home, 'work dir with spaces');

before(async () => {
  mock = await mockProviders();
  const cfg = loadConfig();
  cfg.providers = { custom: { apiKey: GOOD_KEY, baseUrl: `${mock.base}/openai` } };
  cfg.model = { ...cfg.model, provider: 'custom', id: 'gpt-a', display: 'gpt-a' };
  saveConfig(cfg);
  fs.mkdirSync(work, { recursive: true });
  process.chdir(work);
  screen = fakeScreen();
  bindScreen(screen);
  const agents = loadAgents();
  state = {
    cfg: loadConfig(), agents, agent: agents[0], mode: 'build', gatewayStatus: 'reachable',
    session: loadAgentSession('peridot', 'main'), lastOutput: '', busy: false,
  };
});
after(async () => {
  process.chdir(home);
  process.stdin.pause(); // shell commands resume stdin (raw-mode keyboard)
  await mock.close();
});

// Run a command; returns its output. Fails on crashes or unwired commands.
async function run(input, { interact } = {}) {
  screen.take();
  const p = handleInput(state, input);
  if (interact) await interact();
  const res = await p;
  const out = screen.take();
  assert.doesNotMatch(out, /Command failed|not yet wired/, `${input} →\n${out}`);
  return { out, res };
}

const waitMenu = (what) => waitFor(() => screen.menu, 15000, what);
const waitPrompt = (re) => waitFor(() => re.test(screen.input.placeholder || ''), 15000, String(re));
const type = (s) => press(...[...s]);

test('there are 62 commands, each handled by the dispatcher', () => {
  assert.equal(COMMANDS.length, 62);
  assert.ok(COMMANDS.find((c) => c.name === 'provider'));
  assert.ok(COMMANDS.find((c) => c.name === 'theme'));
});

test('system commands', async () => {
  assert.match((await run('/help')).out, /62 commands/);
  assert.match((await run('/version')).out, /v0\.3\.0/);
  assert.match((await run('/mode plan')).out, /PLAN/);
  assert.equal(state.mode, 'plan');
  await run('/mode');
  assert.equal(state.mode, 'build', '/mode with no argument toggles');
  assert.match((await run('/status')).out, /gpt-a[\s\S]*Custom Provider[\s\S]*theme\s+Peridot/);
  assert.match((await run('/session')).out, /session "main"/);
  assert.match((await run('/tokens')).out, /context tokens/);
  assert.match((await run('/setup')).out, /peridot setup/);
  assert.match((await run('/doctor')).out, /python[\s\S]*password hasher/);
  assert.match((await run('/clear')).out, /Hi, I'm Peridot/);
  assert.equal((await run('/exit')).res.exit, true);
  assert.match((await run('/bogus')).out, /Unknown command \/bogus/);
});

test('/config never prints secrets', async () => {
  const { out } = await run('/config');
  assert.ok(!out.includes(GOOD_KEY), 'API key redacted');
  assert.match(out, /apiKey: good••••••••/);
});

test('/model switches directly, by provider pin, and through the filterable picker', async () => {
  assert.match((await run('/model gpt-b')).out, /Model set to gpt-b via Custom Provider — 128\.0k context/);
  assert.equal(loadConfig().model.id, 'gpt-b', 'saved');
  assert.equal(loadConfig().model.contextTokens, 128000);
  await run('/model custom:gpt-a');
  assert.equal(state.cfg.model.id, 'gpt-a');

  // picker: type to filter, enter to choose
  const { out } = await run('/model', {
    interact: async () => {
      await waitMenu('model picker');
      assert.match(screen.menu.title, /models\s+2\/2/);
      type('gpt-b');
      assert.equal(screen.menu.items.length, 1);
      assert.equal(screen.menu.items[0].left, 'gpt-b');
      press(keys.enter);
    },
  });
  assert.match(out, /Model set to gpt-b/);

  // esc leaves it alone
  assert.match((await run('/model', { interact: async () => { await waitMenu('picker'); press(keys.esc); } })).out, /Model unchanged/);
  // partial id opens the picker pre-filtered
  await run('/model gpt', {
    interact: async () => {
      await waitMenu('prefiltered picker');
      assert.equal(screen.input.buf, 'gpt');
      press(keys.esc);
    },
  });
});

test('/models lists providers, one provider, and refreshes with the key', async () => {
  const list = (await run('/models')).out;
  assert.match(list, /● Custom Provider\s+2 models\s+◂ active/);
  assert.match(list, /○ OpenAI\s+not configured/);
  assert.match((await run('/models custom')).out, /gpt-a[\s\S]*gpt-b/);
  assert.match((await run('/models refresh')).out, /✓ Custom Provider\s+2 models/);
  assert.match((await run('/models nope')).out, /not a configured provider/);
});

test('/provider adds a second provider (key verified by listing models), then removes it', async () => {
  // A rejected key is reported and nothing is saved.
  const { out } = await run('/provider add anthropic', {
    interact: async () => {
      await waitPrompt(/Anthropic API key/);
      assert.equal(screen.input.mask, true, 'key entry is masked');
      type('wrong-key'); press(keys.enter);
      await waitMenu('retry menu'); // discovery fails against the real Anthropic URL with a bad key
      press(keys.esc);
    },
  });
  assert.match(out, /Anthropic: [\s\S]*Provider unchanged/);
  assert.equal(loadConfig().providers.anthropic, undefined, 'nothing saved on cancel');

  // Point a provider at the mock by giving it a baseUrl, then add it via the picker flow.
  const cfg = loadConfig();
  cfg.providers.gemini = { apiKey: 'placeholder', baseUrl: `${mock.base}/gemini` };
  saveConfig(cfg);
  state.cfg = loadConfig();
  const pick = await run('/provider', {
    interact: async () => {
      await waitMenu('provider list');
      const idx = screen.menu.items.findIndex((it) => /Google Gemini/.test(it.left));
      assert.match(screen.menu.items[idx].left, /^● /, 'configured providers are marked');
      for (let i = 0; i < idx; i++) press(keys.down);
      press(keys.enter);
      await waitFor(() => screen.menu?.title === 'Google Gemini', 5000, 'provider actions');
      press(keys.down, keys.enter); // replace API key
      await waitPrompt(/Google Gemini API key/);
      type(GOOD_KEY); press(keys.enter);
    },
  });
  assert.match(pick.out, /Google Gemini saved — 2 models available/);
  assert.equal(loadConfig().providers.gemini.apiKey, GOOD_KEY);

  // both providers' models are now selectable together
  await run('/model', {
    interact: async () => {
      await waitMenu('combined picker');
      assert.match(screen.menu.title, /models\s+4\/4/);
      const labels = screen.menu.items.map((i) => i.left);
      assert.deepEqual(labels.sort(), ['gemini-y', 'gemini-z', 'gpt-a', 'gpt-b']);
      type('gemini-z'); press(keys.enter);
    },
  });
  assert.equal(state.cfg.model.provider, 'gemini');
  assert.equal(state.cfg.model.id, 'gemini-z');

  // removing the active provider moves the model to a remaining one
  const rm = await run('/provider remove gemini', {
    interact: async () => { await waitPrompt(/type "yes"/); type('yes'); press(keys.enter); },
  });
  assert.match(rm.out, /Removed Google Gemini\. Active model is now gpt-\w via Custom Provider/);
  assert.equal(loadConfig().providers.gemini, undefined);
  assert.equal(loadConfig().model.provider, 'custom');
});

test('/theme: direct, list, live-preview picker, esc restores', async () => {
  assert.match((await run('/theme nyc')).out, /Theme: NYC Yellow/);
  assert.equal(currentTheme().id, 'nyc-yellow');
  assert.equal(loadConfig().theme, 'nyc-yellow', 'saved');
  assert.match((await run('/theme list')).out, /Indigo Bridle Path[\s\S]*Galactic Neon Magenta[\s\S]*Seattle Blue[\s\S]*Cyan Atlantis/);
  assert.match((await run('/theme sunset')).out, /No theme matches "sunset"/);

  await run('/theme', {
    interact: async () => {
      await waitMenu('theme picker');
      assert.equal(screen.menu.items.length, 6);
      press(keys.down); // NYC Yellow → Seattle Blue, previewed live
      assert.equal(currentTheme().id, 'seattle-blue');
      press(keys.esc);
    },
  });
  assert.equal(currentTheme().id, 'nyc-yellow', 'esc restores the previous theme');

  await run('/theme', {
    interact: async () => { await waitMenu('theme picker'); press(keys.down, keys.down, keys.enter); },
  });
  assert.equal(currentTheme().id, 'cyan-atlantis');
  assert.equal(loadConfig().theme, 'cyan-atlantis');
  applyTheme('peridot');
});

test('filesystem commands handle paths with spaces', async () => {
  await run('/mkdir "sub dir"');
  assert.ok(fs.existsSync(path.join(work, 'sub dir')));
  await run('/write "sub dir/a file.txt" hello world');
  assert.equal(fs.readFileSync(path.join(work, 'sub dir', 'a file.txt'), 'utf8'), 'hello world\n');
  assert.match((await run('/read "sub dir/a file.txt"')).out, /1\s+hello world/);
  await run('/cp "sub dir/a file.txt" "sub dir/b file.txt"');
  await run('/mv "sub dir/b file.txt" c.txt');
  assert.ok(fs.existsSync(path.join(work, 'c.txt')));
  assert.match((await run('/ls "sub dir"')).out, /a file\.txt/);
  assert.match((await run('/find c.txt')).out, /c\.txt/);
  assert.match((await run('/tree')).out, /sub dir\//);
  assert.match((await run('/edit nothing-here.txt')).out, /Not found/);
  assert.match((await run('/mv onlyone')).out, /Usage: \/mv/);
  const rm = await run('/rm c.txt', { interact: async () => { await waitPrompt(/type "yes"/); type('yes'); press(keys.enter); } });
  assert.match(rm.out, /Deleted c\.txt/);
  assert.ok(!fs.existsSync(path.join(work, 'c.txt')));
});

test('code commands', async () => {
  assert.match((await run('/run echo peridot-ok')).out, /peridot-ok/);
  assert.match((await run('/git --version')).out, /git version/);
  assert.match((await run('/py print("py says " + "hi")')).out, /py says hi/, 'quotes reach python intact');
  assert.match((await run('/node console.log("node " + "ok", 6*7)')).out, /node ok 42/);
  fs.writeFileSync(path.join(work, 'script.js'), 'process.exit(0)');
  assert.match((await run('/exec script.js')).out, /Script finished/);
  assert.match((await run('/test')).out, /No package\.json/);
  await run('/run echo something-to-debug');
  assert.match((await run('/debug')).out, /Hello from/, '/debug sends the last output to the model');
});

test('web fetch commands', async () => {
  assert.match((await run(`/fetch ${mock.base}/html/models`)).out, /→ 200[\s\S]*not an api/);
  const { out } = await run(`/scrape ${mock.base}/html/models`);
  assert.match(out, /not an api/);
  assert.doesNotMatch(out, /<html>/);
});

test('memory commands', async () => {
  await run('/remember the sky is green in peridot');
  assert.match((await run('/recall sky')).out, /the sky is green/);
  assert.match((await run('/memories')).out, /1\. the sky is green/);
  assert.match((await run('/forget 1')).out, /Forgot/);
  assert.match((await run('/note a note')).out, /Noted/);
});

test('agent commands', async () => {
  assert.match((await run('/task write tests')).out, /Queued task #1/);
  assert.match((await run('/tasks')).out, /1\. write tests/);
  assert.match((await run('/plan build a thing')).out, /Hello from/);
  assert.match((await run('/act')).out, /Hello from/);
  assert.match((await run('/workflow')).out, /Workflow/);
  await run('/agent', { interact: async () => { await waitMenu('agents'); press(keys.esc); } });
  await run('/sessions', { interact: async () => { await waitMenu('sessions'); press(keys.esc); } });
  assert.match((await run('/new scratch')).out, /Session "scratch" active/);
  assert.match((await run('/history')).out, /No conversation history|you|peridot/);
});

test('audio commands stay locked without ElevenLabs + Deepgram keys', async () => {
  for (const c of COMMANDS.filter((x) => x.audio)) {
    assert.match((await run('/' + c.name)).out, /locked/);
  }
});
