// Drives `peridot setup` end to end in a child process, typing into it like a user.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { mockProviders, keys, GOOD_KEY } from './helpers.js';
import { pbkdf2Node } from '../src/hash.js';

const BIN = fileURLToPath(new URL('../bin/peridot.js', import.meta.url));
let mock;
before(async () => { mock = await mockProviders(); });
after(async () => { await mock.close(); });

// Start setup; returns helpers to wait for output and type answers.
function startSetup(home) {
  const child = spawn(process.execPath, [BIN, 'setup'], {
    env: { ...process.env, PERIDOT_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '', cursor = 0;
  child.stdout.on('data', (d) => { out += d.toString('utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''); });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => child.on('close', r));
  return {
    // wait for `re` to appear after everything matched so far
    async expect(re, ms = 20000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const m = re.exec(out.slice(cursor));
        if (m) { cursor += m.index + m[0].length; return; }
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`setup never showed ${re}\n--- output ---\n${out}`);
    },
    type: (s) => child.stdin.write(s),
    exited,
    output: () => out,
    kill: () => child.kill(),
  };
}

test('setup requires a confirmed password and verifies provider keys by listing models', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'peridot-setup-'));
  const s = startSetup(home);
  try {
    await s.expect(/username/);
    s.type('alex' + keys.enter);

    await s.expect(/password\s+required/);
    s.type('first try' + keys.enter);
    await s.expect(/confirm password/);
    s.type('typo' + keys.enter);
    await s.expect(/passwords do not match/);

    await s.expect(/password\s+required/);
    s.type('  s3cret pass ' + keys.enter); // spaces are part of the password
    await s.expect(/confirm password/);
    s.type('  s3cret pass ' + keys.enter);
    await s.expect(/password set/);

    await s.expect(/choose a model provider/);
    s.type(keys.up + keys.enter); // wraps to the last entry: Custom Provider
    await s.expect(/Custom Provider API key/);
    s.type('wrong-key' + keys.enter);
    await s.expect(/base URL/);
    s.type('not-a-url' + keys.enter);
    await s.expect(/must start with http/);
    s.type(`${mock.base}/openai` + keys.enter);
    await s.expect(/401 — API key rejected/);
    await s.expect(/what now\?/);
    s.type(keys.enter); // re-enter the key
    await s.expect(/Custom Provider API key/);
    s.type(GOOD_KEY + keys.enter);
    await s.expect(/base URL/);
    s.type(`${mock.base}/openai` + keys.enter);
    await s.expect(/Custom Provider: 2 models available/);

    await s.expect(/add another model provider, or continue/);
    s.type(keys.enter); // continue
    await s.expect(/active model: GPT A \(Custom Provider\)/); // display name of gpt-a

    await s.expect(/choose a search provider/);
    s.type(keys.enter);
    await s.expect(/ElevenLabs API key/);
    s.type(keys.enter);
    await s.expect(/Deepgram API key/);
    s.type(keys.enter);
    await s.expect(/Configuration saved/);
    await s.exited;
  } finally {
    s.kill();
  }

  const raw = fs.readFileSync(path.join(home, 'peridot.yaml'), 'utf8');
  assert.ok(!raw.includes('s3cret'), 'password is never stored in plain text');
  const cfg = yaml.load(raw);
  assert.equal(cfg.user.username, 'alex');
  const [scheme, iter, salt, key] = cfg.user.passwordHash.split('$');
  assert.equal(scheme, 'pbkdf2-sha256');
  assert.equal(key, pbkdf2Node('  s3cret pass ', salt, Number(iter)), 'hash is of the confirmed password, exactly as typed');
  assert.deepEqual(cfg.providers, { custom: { apiKey: GOOD_KEY, baseUrl: `${mock.base}/openai` } });
  assert.equal(cfg.model.provider, 'custom');
  assert.equal(cfg.model.id, 'gpt-a');
  assert.equal(cfg.model.contextTokens, 200000);
  const catalog = JSON.parse(fs.readFileSync(path.join(home, 'models.json'), 'utf8'));
  assert.deepEqual(catalog.providers.custom.models.map((m) => m.id), ['gpt-a', 'gpt-b']);
});

test('aborting setup saves nothing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'peridot-setup-'));
  const s = startSetup(home);
  try {
    await s.expect(/username/);
    s.type('alex' + keys.enter);
    await s.expect(/password\s+required/);
    s.type('\x03'); // ctrl-c
    await s.expect(/setup aborted — nothing saved/);
    await s.exited;
  } finally {
    s.kill();
  }
  assert.ok(!fs.existsSync(path.join(home, 'peridot.yaml')));
});
