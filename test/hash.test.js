import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  hashPassword, pbkdf2Native, pbkdf2Node, nativeHashAvailable, PBKDF2_ITERATIONS,
} from '../src/hash.js';

const native = nativeHashAvailable();

test('Node fallback matches the RFC 7914 PBKDF2-HMAC-SHA256 vector', () => {
  assert.equal(pbkdf2Node('password', Buffer.from('salt').toString('hex'), 1),
    '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b');
});

test('native C hasher matches Node byte for byte', { skip: !native && 'native hasher not built (npm run build:native)' }, () => {
  const cases = [
    ['password', 'salt', 1],
    ['password', 'salt', 4096],
    ['', 'salt', 2],
    ['pässwörd with spaces & ünïcode 🔑', 'salt', 1000],
    ['x'.repeat(100), 'a-longer-salt-value', 1000], // key longer than the 64-byte HMAC block
    ['  leading and trailing  ', 'salt', 10],
  ];
  for (const [pw, salt, iter] of cases) {
    const saltHex = Buffer.from(salt).toString('hex');
    assert.equal(pbkdf2Native(pw, saltHex, iter), pbkdf2Node(pw, saltHex, iter), `"${pw}" × ${iter}`);
  }
  for (let i = 0; i < 5; i++) {
    const pw = crypto.randomBytes(12).toString('base64');
    const saltHex = crypto.randomBytes(16).toString('hex');
    assert.equal(pbkdf2Native(pw, saltHex, 777), pbkdf2Node(pw, saltHex, 777));
  }
});

test('native C hasher rejects bad arguments', { skip: !native && 'native hasher not built' }, () => {
  assert.equal(pbkdf2Native('pw', 'zz', 1), null, 'non-hex salt');
  assert.equal(pbkdf2Native('pw', 'abc', 1), null, 'odd-length salt');
  assert.equal(pbkdf2Native('pw', '00', 0), null, 'zero iterations');
});

test('hashPassword stores a salted PBKDF2 record that verifies', () => {
  const rec = hashPassword('correct horse');
  const [scheme, iter, salt, key] = rec.split('$');
  assert.equal(scheme, 'pbkdf2-sha256');
  assert.equal(Number(iter), PBKDF2_ITERATIONS);
  assert.match(salt, /^[0-9a-f]{32}$/);
  assert.equal(key, pbkdf2Node('correct horse', salt, Number(iter)));
  assert.notEqual(hashPassword('correct horse'), rec, 'fresh salt every time');
});
