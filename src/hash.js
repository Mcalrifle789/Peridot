// Password hashing: salted PBKDF2-HMAC-SHA256, stored as
//   pbkdf2-sha256$<iterations>$<salt hex>$<key hex>
// Uses the native C hasher (native/bin/peridot-hash) when it has been built,
// otherwise Node's crypto — both produce identical keys.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PBKDF2_ITERATIONS = 600_000;
export const HASH_BIN = fileURLToPath(new URL(
  `../native/bin/peridot-hash${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));

export const nativeHashAvailable = () => fs.existsSync(HASH_BIN);

// Hex key from the C hasher, or null if it isn't built or fails.
export function pbkdf2Native(password, saltHex, iterations) {
  if (!nativeHashAvailable()) return null;
  const r = spawnSync(HASH_BIN, [saltHex, String(iterations)], {
    input: Buffer.from(password, 'utf8'), encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  const key = r.status === 0 ? r.stdout.trim() : '';
  return /^[0-9a-f]{64}$/.test(key) ? key : null;
}

export function pbkdf2Node(password, saltHex, iterations) {
  return crypto.pbkdf2Sync(password, Buffer.from(saltHex, 'hex'), iterations, 32, 'sha256').toString('hex');
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = pbkdf2Native(password, salt, PBKDF2_ITERATIONS) ?? pbkdf2Node(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${salt}$${key}`;
}
