import * as crypto from 'node:crypto';

interface NodeArgon2Options {
  message: string | Buffer;
  nonce: Buffer;
  parallelism: number;
  tagLength: number;
  memory: number;
  passes: number;
}

type NodeArgon2SyncFn = (
  algorithm: 'argon2id' | 'argon2i' | 'argon2d',
  options: NodeArgon2Options,
) => Buffer;

const ARGON2_DEFAULT_MEMORY_KIB = 16384; // 16 MiB
const ARGON2_DEFAULT_PASSES = 2;
const ARGON2_DEFAULT_PARALLELISM = 1;
const ARGON2_TAG_LENGTH = 32;
const SALT_LENGTH = 16;

function getNativeArgon2Sync(): NodeArgon2SyncFn | undefined {
  const candidate = (crypto as unknown as { argon2Sync?: NodeArgon2SyncFn }).argon2Sync;
  return typeof candidate === 'function' ? candidate : undefined;
}

function toBase64NoPad(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/g, '');
}

function fromBase64NoPad(encoded: string): Buffer {
  const padLen = (4 - (encoded.length % 4)) % 4;
  return Buffer.from(encoded + '='.repeat(padLen), 'base64');
}

/**
 * Hashes a plaintext password using Argon2id (Node v24 built-in `crypto.argon2Sync`)
 * in standard PHC format: `$argon2id$v=19$m=...,t=...,p=...$<salt>$<hash>`.
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const argon2Sync = getNativeArgon2Sync();

  if (argon2Sync) {
    const derived = argon2Sync('argon2id', {
      message: Buffer.from(password, 'utf8'),
      nonce: salt,
      memory: ARGON2_DEFAULT_MEMORY_KIB,
      passes: ARGON2_DEFAULT_PASSES,
      parallelism: ARGON2_DEFAULT_PARALLELISM,
      tagLength: ARGON2_TAG_LENGTH,
    });
    return `$argon2id$v=19$m=${ARGON2_DEFAULT_MEMORY_KIB},t=${ARGON2_DEFAULT_PASSES},p=${ARGON2_DEFAULT_PARALLELISM}$${toBase64NoPad(salt)}$${toBase64NoPad(derived)}`;
  }

  // Fallback for older Node runtimes without built-in argon2Sync
  const derived = crypto.scryptSync(password, salt, ARGON2_TAG_LENGTH, {
    N: 16384,
    r: 8,
    p: 1,
  });
  return `$scrypt$N=16384,r=8,p=1$${toBase64NoPad(salt)}$${toBase64NoPad(derived)}`;
}

/**
 * Verifies a plaintext password against a stored PHC Argon2id (or fallback scrypt) hash
 * using constant-time comparison.
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  if (!password || !storedHash) {
    return false;
  }

  const parts = storedHash.split('$');
  // PHC format splits to ['', 'argon2id', 'v=19', 'm=...,t=...,p=...', '<salt>', '<hash>']
  if (parts.length === 6 && parts[1] === 'argon2id') {
    const argon2Sync = getNativeArgon2Sync();
    if (!argon2Sync) {
      return false;
    }

    const paramsStr = parts[3];
    const saltB64 = parts[4];
    const expectedB64 = parts[5];

    const paramMap = new Map<string, number>();
    for (const entry of paramsStr.split(',')) {
      const [k, v] = entry.split('=');
      if (k && v) {
        const parsed = Number.parseInt(v, 10);
        if (Number.isInteger(parsed) && parsed > 0) {
          paramMap.set(k, parsed);
        }
      }
    }

    const memory = paramMap.get('m') ?? ARGON2_DEFAULT_MEMORY_KIB;
    const passes = paramMap.get('t') ?? ARGON2_DEFAULT_PASSES;
    const parallelism = paramMap.get('p') ?? ARGON2_DEFAULT_PARALLELISM;

    try {
      const salt = fromBase64NoPad(saltB64);
      const expected = fromBase64NoPad(expectedB64);
      const actual = argon2Sync('argon2id', {
        message: Buffer.from(password, 'utf8'),
        nonce: salt,
        memory,
        passes,
        parallelism,
        tagLength: expected.length,
      });
      if (actual.length !== expected.length) {
        return false;
      }
      return crypto.timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  if (parts.length === 5 && parts[1] === 'scrypt') {
    try {
      const salt = fromBase64NoPad(parts[3]);
      const expected = fromBase64NoPad(parts[4]);
      const actual = crypto.scryptSync(password, salt, expected.length, {
        N: 16384,
        r: 8,
        p: 1,
      });
      if (actual.length !== expected.length) {
        return false;
      }
      return crypto.timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  return false;
}
