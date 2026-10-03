// Shared test helpers: an isolated ~/.peridot, a mock model-provider server,
// stdout capture, and simulated keystrokes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Must run before any src/ module is imported (PERIDOT_DIR is read at import).
export function isolatedHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peridot-test-'));
  process.env.PERIDOT_HOME = dir;
  return dir;
}

export const GOOD_KEY = 'good-key';

// Serves the three model-list shapes Peridot understands, plus a chat endpoint.
//   /openai/models      OpenAI-style list (mixed chat + non-chat models)
//   /anthropic/models   Anthropic-style, two pages
//   /gemini/models      Gemini-style, two pages
//   /html/models        not JSON
//   /openai/chat/completions   streams "Hello from <model>"
export async function mockProviders() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      requests.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body });
      const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const bearer = req.headers.authorization === `Bearer ${GOOD_KEY}`;

      if (url.pathname === '/openai/models') {
        if (!bearer) return json(401, { error: { message: 'Incorrect API key provided' } });
        return json(200, {
          data: [
            { id: 'gpt-b', context_window: 128000 },
            { id: 'gpt-a', name: 'GPT A', context_length: 200000 },
            { id: 'text-embedding-3-small' },
            { id: 'whisper-1' },
            { id: 'tts-1' },
            { id: 'gpt-a' }, // duplicate
          ],
        });
      }
      if (url.pathname === '/anthropic/models') {
        if (req.headers['x-api-key'] !== GOOD_KEY || !req.headers['anthropic-version']) {
          return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
        }
        if (url.searchParams.get('after_id') === 'claude-b') {
          return json(200, { data: [{ id: 'claude-c', display_name: 'Claude C' }], has_more: false, last_id: 'claude-c' });
        }
        return json(200, {
          data: [{ id: 'claude-a', display_name: 'Claude A' }, { id: 'claude-b', display_name: 'Claude B' }],
          has_more: true, last_id: 'claude-b',
        });
      }
      if (url.pathname === '/gemini/models') {
        if (req.headers['x-goog-api-key'] !== GOOD_KEY) return json(400, { error: { message: 'API key not valid.' } });
        if (url.searchParams.get('pageToken') === 'p2') {
          return json(200, { models: [{ name: 'models/gemini-z', displayName: 'Gemini Z', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576 }] });
        }
        return json(200, {
          models: [
            { name: 'models/gemini-y', displayName: 'Gemini Y', supportedGenerationMethods: ['generateContent', 'countTokens'] },
            { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
          ],
          nextPageToken: 'p2',
        });
      }
      if (url.pathname === '/html/models') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<html>not an api</html>');
      }
      if (url.pathname === '/openai/chat/completions' && req.method === 'POST') {
        if (!bearer) return json(401, { error: { message: 'Incorrect API key provided' } });
        const { model } = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const piece of ['Hello ', 'from ', model]) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        }
        return res.end('data: [DONE]\n\n');
      }
      json(404, { error: { message: 'not found' } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, requests,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}

// A stand-in for the full-screen Screen: records output and overlay state.
// (Patching process.stdout would swallow the test runner's own reporting.)
export function fakeScreen() {
  return {
    lines: [], scroll: 0, menu: null, input: { buf: '', pos: 0, placeholder: '', prompt: '>>' },
    renders: 0,
    push(text = '') { for (const l of String(text).split('\n')) this.lines.push(l); },
    spinner() { return () => {}; },
    render() { this.renders++; },
    clearContent() { this.lines = []; },
    suspend() {}, resume() {},
    contentHeight() { return 20; },
    text() { return this.lines.join('\n').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''); },
    take() { const t = this.text(); this.lines = []; return t; },
  };
}

export const keys = {
  up: '\x1b[A', down: '\x1b[B', enter: '\r', esc: '\x1b', backspace: '\x7f',
};

// Simulate keystrokes on stdin (the UI listens for 'data' events).
export function press(...seq) {
  for (const s of seq) process.stdin.emit('data', Buffer.from(s, 'utf8'));
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// Wait until `probe()` is truthy (polling), or fail after `ms`.
export async function waitFor(probe, ms = 15000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (probe()) return;
    await tick(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}
