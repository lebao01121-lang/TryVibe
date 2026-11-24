#!/usr/bin/env node
/**
 * Local Development Infrastructure Harness — fashion-atelier-ai-platform (v3.0)
 *
 * Protocol-compatible local fallbacks for hosts without Docker Desktop / WSL2.
 * Auto-detects open ports first and yields cleanly to real Docker containers whenever present.
 *
 * Services (all bound on 127.0.0.1 only when port is offline):
 *   1. Redis RESP2 TCP Server        (127.0.0.1:6379) — native ioredis compatible
 *   2. Meilisearch HTTP Server       (127.0.0.1:7700) — native meilisearch JS SDK v0.45+ compatible
 *   3. MinIO S3-Compatible HTTP      (127.0.0.1:9000) — native @aws-sdk/client-s3 + presigner compatible
 *   4. Mailpit SMTP + HTTP API       (127.0.0.1:1025 & 127.0.0.1:8025) — native nodemailer compatible
 *   5. RabbitMQ Mgmt + DLQ HTTP API  (127.0.0.1:15672) — RabbitMQ Management v3.13 compatible
 *
 * Zero external npm dependencies (100% Node.js built-ins).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// =============================================================================
// Shared Utilities
// =============================================================================
function loadDotEnv(filePath) {
  const vars = {};
  if (!fs.existsSync(filePath)) return vars;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }
  return vars;
}

export function isPortOpen(host, port, timeoutMs = 350) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

function readRequestBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function foldVietnamese(input) {
  return String(input ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, (ch) => (ch === 'Đ' ? 'D' : 'd'))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function globToRegExp(glob) {
  let out = '^';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*') {
      out += '.*';
    } else if (ch === '?') {
      out += '.';
    } else if (ch === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end !== -1) {
        out += glob.slice(i, end + 1);
        i = end;
      } else {
        out += '\\[';
      }
    } else if (ch === '\\' && i + 1 < glob.length) {
      out += '\\' + glob[i + 1];
      i += 1;
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    i += 1;
  }
  out += '$';
  return new RegExp(out);
}

// =============================================================================
// 1. Redis RESP2 TCP Server (127.0.0.1:6379)
// =============================================================================
function encodeSimple(str) {
  return Buffer.from(`+${str}\r\n`, 'utf8');
}

function encodeError(msg) {
  return Buffer.from(`-${msg}\r\n`, 'utf8');
}

function encodeInteger(n) {
  return Buffer.from(`:${Math.trunc(n)}\r\n`, 'utf8');
}

function encodeBulk(val) {
  if (val === null || val === undefined) {
    return Buffer.from('$-1\r\n', 'utf8');
  }
  const buf = Buffer.isBuffer(val) ? val : Buffer.from(String(val), 'utf8');
  return Buffer.concat([Buffer.from(`$${buf.length}\r\n`, 'utf8'), buf, Buffer.from('\r\n', 'utf8')]);
}

function encodeArray(items) {
  if (items === null || items === undefined) {
    return Buffer.from('*-1\r\n', 'utf8');
  }
  const parts = [Buffer.from(`*${items.length}\r\n`, 'utf8')];
  for (const item of items) {
    if (Buffer.isBuffer(item)) {
      parts.push(item);
    } else {
      parts.push(encodeBulk(item));
    }
  }
  return Buffer.concat(parts);
}

/**
 * Incremental binary-safe RESP2 + inline command parser.
 */
function parseRespCommands(buffer) {
  const commands = [];
  let offset = 0;

  while (offset < buffer.length) {
    const firstByte = buffer[offset];

    if (firstByte === 0x2a) {
      // RESP Array: *<count>\r\n
      const lineEnd = buffer.indexOf('\r\n', offset);
      if (lineEnd === -1) break;
      const count = Number.parseInt(buffer.subarray(offset + 1, lineEnd).toString('utf8'), 10);
      if (Number.isNaN(count) || count < 0) {
        offset = lineEnd + 2;
        continue;
      }
      let cursor = lineEnd + 2;
      const args = [];
      let incomplete = false;

      for (let i = 0; i < count; i += 1) {
        if (cursor >= buffer.length || buffer[cursor] !== 0x24) {
          incomplete = true;
          break;
        }
        const lenEnd = buffer.indexOf('\r\n', cursor);
        if (lenEnd === -1) {
          incomplete = true;
          break;
        }
        const byteLen = Number.parseInt(buffer.subarray(cursor + 1, lenEnd).toString('utf8'), 10);
        const dataStart = lenEnd + 2;
        const dataEnd = dataStart + byteLen;
        if (byteLen < 0) {
          args.push(Buffer.alloc(0));
          cursor = dataStart;
        } else {
          if (dataEnd + 2 > buffer.length) {
            incomplete = true;
            break;
          }
          args.push(buffer.subarray(dataStart, dataEnd));
          cursor = dataEnd + 2;
        }
      }

      if (incomplete) break;
      commands.push(args);
      offset = cursor;
    } else {
      // Inline command (e.g., "PING\r\n" or "SET foo bar\n")
      let lineEnd = buffer.indexOf('\n', offset);
      if (lineEnd === -1) break;
      let line = buffer.subarray(offset, lineEnd).toString('utf8');
      if (line.endsWith('\r')) line = line.slice(0, -1);
      offset = lineEnd + 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      const tokens = [];
      const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
      let m;
      while ((m = re.exec(trimmed)) !== null) {
        tokens.push(Buffer.from(m[1] ?? m[2] ?? m[3], 'utf8'));
      }
      if (tokens.length > 0) commands.push(tokens);
    }
  }

  return { commands, remaining: buffer.subarray(offset) };
}

function createRedisServer(port, expectedPassword) {
  /** @type {Map<number, Map<string, { type: 'string' | 'hash', value?: Buffer, hash?: Map<string, Buffer>, expiresAt: number | null }>>} */
  const databases = new Map();
  /** @type {Map<string, string>} */
  const scriptCache = new Map();
  const sockets = new Set();

  function getDb(dbIndex) {
    let db = databases.get(dbIndex);
    if (!db) {
      db = new Map();
      databases.set(dbIndex, db);
    }
    return db;
  }

  function getLiveEntry(db, key) {
    const entry = db.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      db.delete(key);
      return null;
    }
    return entry;
  }

  function purgeExpired(db) {
    const now = Date.now();
    for (const [k, entry] of db.entries()) {
      if (entry.expiresAt !== null && now >= entry.expiresAt) {
        db.delete(k);
      }
    }
  }

  function resolveLuaArgToken(rawTok, keys, argv, argBufs) {
    let tok = rawTok.trim();
    const tonum = /^tonumber\((.+)\)$/i.exec(tok);
    if (tonum) tok = tonum[1].trim();
    const tostr = /^tostring\((.+)\)$/i.exec(tok);
    if (tostr) tok = tostr[1].trim();

    if ((tok.startsWith("'") && tok.endsWith("'")) || (tok.startsWith('"') && tok.endsWith('"'))) {
      const s = tok.slice(1, -1);
      return { str: s, buf: Buffer.from(s, 'utf8') };
    }
    const keyRef = /^KEYS\[(\d+)\]$/i.exec(tok);
    if (keyRef) {
      const idx = Number.parseInt(keyRef[1], 10) - 1;
      const val = keys[idx] ?? '';
      return { str: val, buf: Buffer.from(val, 'utf8') };
    }
    const argRef = /^ARGV\[(\d+)\]$/i.exec(tok);
    if (argRef) {
      const idx = Number.parseInt(argRef[1], 10) - 1;
      const val = argv[idx] ?? '';
      return { str: val, buf: argBufs[idx] ?? Buffer.from(val, 'utf8') };
    }
    return { str: tok, buf: Buffer.from(tok, 'utf8') };
  }

  function splitLuaCallArgs(argListStr) {
    const out = [];
    let cur = '';
    let quote = null;
    let depth = 0;
    for (let i = 0; i < argListStr.length; i += 1) {
      const ch = argListStr[i];
      if (quote) {
        cur += ch;
        if (ch === '\\' && i + 1 < argListStr.length) {
          cur += argListStr[++i];
        } else if (ch === quote) {
          quote = null;
        }
      } else if (ch === "'" || ch === '"') {
        quote = ch;
        cur += ch;
      } else if (ch === '(') {
        depth += 1;
        cur += ch;
      } else if (ch === ')') {
        depth = Math.max(0, depth - 1);
        cur += ch;
      } else if (ch === ',' && depth === 0) {
        if (cur.trim()) out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function evaluateLuaScript(db, script, keys, argv, argBufs, connState) {
    // 1) Multi-SKU atomic stock reserve (ATELIER_LUA_RESERVE)
    if (script.includes('ATELIER_LUA_RESERVE')) {
      if (keys.length === 0) {
        return encodeArray([encodeBulk('OK')]);
      }
      const requestedByKey = new Map();
      const insufficient = [];
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        const entry = getLiveEntry(db, key);
        if (!entry) {
          return encodeArray([encodeBulk('MISS'), encodeBulk(key)]);
        }
        if (entry.type === 'hash') {
          return encodeError('WRONGTYPE Operation against a key holding the wrong kind of value');
        }
        const avail = Number.parseInt(entry.value.toString('utf8'), 10);
        const req = Number.parseInt(argv[i] ?? '0', 10);
        if (Number.isNaN(avail) || Number.isNaN(req) || req < 0) {
          return encodeError('ERR value is not an integer or out of range');
        }
        const totalReq = (requestedByKey.get(key) ?? 0) + req;
        requestedByKey.set(key, totalReq);
        if (avail < totalReq) {
          insufficient.push({ key, avail, req: totalReq });
        }
      }
      if (insufficient.length > 0) {
        const respItems = [encodeBulk('INSUFFICIENT')];
        for (const item of insufficient) {
          respItems.push(encodeBulk(item.key), encodeInteger(item.avail), encodeInteger(item.req));
        }
        return encodeArray(respItems);
      }
      for (const [key, totalReq] of requestedByKey.entries()) {
        const entry = getLiveEntry(db, key);
        const avail = Number.parseInt(entry.value.toString('utf8'), 10);
        db.set(key, {
          type: 'string',
          value: Buffer.from(String(avail - totalReq), 'utf8'),
          expiresAt: entry.expiresAt,
        });
      }
      return encodeArray([encodeBulk('OK')]);
    }

    // 2) Multi-SKU atomic stock release (ATELIER_LUA_RELEASE)
    if (script.includes('ATELIER_LUA_RELEASE')) {
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        const delta = Number.parseInt(argv[i] ?? '0', 10);
        if (Number.isNaN(delta) || delta === 0) continue;
        const entry = getLiveEntry(db, key);
        if (!entry || entry.type === 'hash') continue;
        const cur = Number.parseInt(entry.value.toString('utf8'), 10);
        if (!Number.isNaN(cur)) {
          db.set(key, {
            type: 'string',
            value: Buffer.from(String(cur + delta), 'utf8'),
            expiresAt: entry.expiresAt,
          });
        }
      }
      return encodeSimple('OK');
    }

    // 3a) Dual-quota refund (ATELIER_LUA_QUOTA_REFUND)
    if (script.includes('ATELIER_LUA_QUOTA_REFUND')) {
      const dec = Math.max(1, Number.parseInt(argv[0] ?? '1', 10) || 1);
      for (const key of keys) {
        if (!key) continue;
        const entry = getLiveEntry(db, key);
        if (!entry || entry.type === 'hash') continue;
        const cur = Number.parseInt(entry.value.toString('utf8'), 10) || 0;
        const nextVal = Math.max(0, cur - dec);
        db.set(key, {
          type: 'string',
          value: Buffer.from(String(nextVal), 'utf8'),
          expiresAt: entry.expiresAt,
        });
      }
      return encodeArray([encodeInteger(1)]);
    }

    // 3b) Dual-quota atomic check & reserve (ATELIER_LUA_QUOTA)
    if (script.includes('ATELIER_LUA_QUOTA')) {
      const userKey = keys[0] || '';
      const ipKey = keys[1] || '';
      const userLimit = Number.parseInt(argv[0] ?? '0', 10);
      const ipLimit = Number.parseInt(argv[1] ?? '0', 10);
      const ttlSec = Math.max(1, Number.parseInt(argv[2] ?? '86400', 10) || 86400);

      const userEntry = userKey ? getLiveEntry(db, userKey) : null;
      const ipEntry = ipKey ? getLiveEntry(db, ipKey) : null;
      const userUsed =
        userEntry && userEntry.type !== 'hash'
          ? Number.parseInt(userEntry.value.toString('utf8'), 10) || 0
          : 0;
      const ipUsed =
        ipEntry && ipEntry.type !== 'hash'
          ? Number.parseInt(ipEntry.value.toString('utf8'), 10) || 0
          : 0;

      if (userKey && userLimit > 0 && userUsed >= userLimit) {
        return encodeArray([
          encodeInteger(0),
          encodeBulk('USER_QUOTA_EXCEEDED'),
          encodeInteger(0),
          encodeInteger(ipKey ? Math.max(0, ipLimit - ipUsed) : 0),
        ]);
      }
      if (ipKey && ipLimit > 0 && ipUsed >= ipLimit) {
        return encodeArray([
          encodeInteger(0),
          encodeBulk('IP_QUOTA_EXCEEDED'),
          encodeInteger(userKey ? Math.max(0, userLimit - userUsed) : 0),
          encodeInteger(0),
        ]);
      }

      const now = Date.now();
      let newUserUsed = userUsed;
      if (userKey) {
        newUserUsed = userUsed + 1;
        db.set(userKey, {
          type: 'string',
          value: Buffer.from(String(newUserUsed), 'utf8'),
          expiresAt: userEntry?.expiresAt ?? now + ttlSec * 1000,
        });
      }
      let newIpUsed = ipUsed;
      if (ipKey) {
        newIpUsed = ipUsed + 1;
        db.set(ipKey, {
          type: 'string',
          value: Buffer.from(String(newIpUsed), 'utf8'),
          expiresAt: ipEntry?.expiresAt ?? now + ttlSec * 1000,
        });
      }

      return encodeArray([
        encodeInteger(1),
        encodeInteger(userKey ? Math.max(0, userLimit - newUserUsed) : 0),
        encodeInteger(ipKey ? Math.max(0, ipLimit - newIpUsed) : 0),
      ]);
    }

    // 3c) Flash Sale atomic slot claim (ATELIER_LUA_FLASH_CLAIM)
    if (script.includes('ATELIER_LUA_FLASH_CLAIM')) {
      const key = keys[0] ?? '';
      const maxSlots = Number.parseInt(argv[0] ?? '0', 10);
      const ttlSec = Math.max(0, Number.parseInt(argv[1] ?? '0', 10) || 0);
      const entry = getLiveEntry(db, key);
      const current =
        entry && entry.type !== 'hash' ? Number.parseInt(entry.value.toString('utf8'), 10) || 0 : 0;
      if (maxSlots > 0 && current >= maxSlots) {
        return encodeArray([encodeInteger(0), encodeInteger(current)]);
      }
      const nextVal = current + 1;
      db.set(key, {
        type: 'string',
        value: Buffer.from(String(nextVal), 'utf8'),
        expiresAt: entry?.expiresAt ?? (ttlSec > 0 ? Date.now() + ttlSec * 1000 : null),
      });
      return encodeArray([encodeInteger(1), encodeInteger(nextVal)]);
    }

    // 4a) Generic compare-and-delete lock release pattern
    if (
      /redis\.call\(\s*['"]get['"]\s*,\s*KEYS\[1\]\s*\)\s*==\s*ARGV\[1\]/i.test(script) &&
      /redis\.call\(\s*['"]del['"]\s*,\s*KEYS\[1\]\s*\)/i.test(script)
    ) {
      const key = keys[0] ?? '';
      const entry = getLiveEntry(db, key);
      if (entry && entry.type !== 'hash' && entry.value.toString('utf8') === (argv[0] ?? '')) {
        db.delete(key);
        return encodeInteger(1);
      }
      return encodeInteger(0);
    }

    // 4b) Generic INCR + EXPIRE/PEXPIRE rate limiter pattern
    const rateLimitMatch = /redis\.call\(\s*['"]incr['"]\s*,\s*KEYS\[1\]\s*\)[\s\S]*redis\.call\(\s*['"](p?expire)['"]\s*,\s*KEYS\[1\]\s*,\s*ARGV\[1\]\s*\)/i.exec(
      script,
    );
    if (rateLimitMatch) {
      const key = keys[0] ?? '';
      const entry = getLiveEntry(db, key);
      const current = entry && entry.type !== 'hash' ? Number.parseInt(entry.value.toString('utf8'), 10) || 0 : 0;
      const nextVal = current + 1;
      const ttlVal = Number.parseInt(argv[0] ?? '60', 10) || 60;
      const ttlMs = rateLimitMatch[1].toLowerCase() === 'pexpire' ? ttlVal : ttlVal * 1000;
      db.set(key, {
        type: 'string',
        value: Buffer.from(String(nextVal), 'utf8'),
        expiresAt: entry?.expiresAt ?? Date.now() + ttlMs,
      });
      return encodeInteger(nextVal);
    }

    // 4c) Generic single `return redis.call(...)` fallback
    const singleCall = /return\s+redis\.call\(\s*([^)]+)\)/i.exec(script);
    if (singleCall) {
      const tokens = splitLuaCallArgs(singleCall[1]);
      if (tokens.length > 0) {
        const resolved = tokens.map((t) => resolveLuaArgToken(t, keys, argv, argBufs));
        const subCmd = resolved[0].str.toUpperCase();
        const subArgs = resolved.slice(1).map((r) => r.buf);
        const subStrArgs = resolved.slice(1).map((r) => r.str);
        return executeCommand(subCmd, subArgs, subStrArgs, connState);
      }
    }

    return encodeError('ERR unsupported Lua script in local-infra-dev');
  }

  function executeCommand(cmd, args, strArgs, connState) {
    const db = getDb(connState.currentDb);

    switch (cmd) {
      case 'HELLO': {
        return encodeError("ERR unknown command 'HELLO'");
      }
      case 'AUTH': {
        const supplied = strArgs.length >= 2 ? strArgs[1] : strArgs[0] || '';
        if (expectedPassword && supplied !== expectedPassword) {
          return encodeError('WRONGPASS invalid username-password pair or user is disabled.');
        }
        return encodeSimple('OK');
      }
      case 'PING': {
        if (args.length > 0) {
          return encodeBulk(args[0]);
        }
        return encodeSimple('PONG');
      }
      case 'SELECT': {
        const idx = Number.parseInt(strArgs[0] ?? '0', 10);
        if (Number.isNaN(idx) || idx < 0) {
          return encodeError('ERR value is not an integer or out of range');
        }
        connState.currentDb = idx;
        return encodeSimple('OK');
      }
      case 'CLIENT': {
        const sub = (strArgs[0] || '').toUpperCase();
        if (sub === 'SETNAME') {
          connState.clientName = strArgs[1] || null;
          return encodeSimple('OK');
        }
        if (sub === 'GETNAME') {
          return encodeBulk(connState.clientName);
        }
        if (sub === 'ID') {
          return encodeInteger(1);
        }
        return encodeSimple('OK');
      }
      case 'INFO': {
        const infoBody = [
          '# Server',
          'redis_version:7.2.4',
          'redis_mode:standalone',
          `tcp_port:${port}`,
          '# Clients',
          `connected_clients:${sockets.size}`,
          '# Persistence',
          'loading:0',
          '# Keyspace',
          `db${connState.currentDb}:keys=${db.size},expires=0,avg_ttl=0`,
          '',
        ].join('\r\n');
        return encodeBulk(infoBody);
      }
      case 'COMMAND': {
        return encodeArray([]);
      }
      case 'TYPE': {
        const entry = getLiveEntry(db, strArgs[0] ?? '');
        if (!entry) return encodeSimple('none');
        return encodeSimple(entry.type === 'hash' ? 'hash' : 'string');
      }
      case 'GET': {
        const entry = getLiveEntry(db, strArgs[0] ?? '');
        if (!entry) return encodeBulk(null);
        if (entry.type === 'hash') {
          return encodeError('WRONGTYPE Operation against a key holding the wrong kind of value');
        }
        return encodeBulk(entry.value);
      }
      case 'MGET': {
        const vals = strArgs.map((k) => {
          const e = getLiveEntry(db, k);
          return encodeBulk(e && e.type !== 'hash' ? e.value : null);
        });
        return encodeArray(vals);
      }
      case 'MSET': {
        if (args.length < 2 || args.length % 2 !== 0) {
          return encodeError("ERR wrong number of arguments for 'mset' command");
        }
        for (let i = 0; i < args.length; i += 2) {
          db.set(strArgs[i], { type: 'string', value: Buffer.from(args[i + 1]), expiresAt: null });
        }
        return encodeSimple('OK');
      }
      case 'SET': {
        const key = strArgs[0];
        const val = args[1] ?? Buffer.alloc(0);
        if (key === undefined) {
          return encodeError("ERR wrong number of arguments for 'set' command");
        }
        let nx = false;
        let xx = false;
        let getOld = false;
        let keepTtl = false;
        let expiresAt = null;

        for (let i = 2; i < strArgs.length; i += 1) {
          const flag = strArgs[i].toUpperCase();
          if (flag === 'NX') nx = true;
          else if (flag === 'XX') xx = true;
          else if (flag === 'GET') getOld = true;
          else if (flag === 'KEEPTTL') keepTtl = true;
          else if (flag === 'EX' && i + 1 < strArgs.length) {
            const sec = Number.parseInt(strArgs[++i], 10);
            expiresAt = Date.now() + sec * 1000;
          } else if (flag === 'PX' && i + 1 < strArgs.length) {
            const ms = Number.parseInt(strArgs[++i], 10);
            expiresAt = Date.now() + ms;
          } else if (flag === 'EXAT' && i + 1 < strArgs.length) {
            const ts = Number.parseInt(strArgs[++i], 10);
            expiresAt = ts * 1000;
          } else if (flag === 'PXAT' && i + 1 < strArgs.length) {
            const ts = Number.parseInt(strArgs[++i], 10);
            expiresAt = ts;
          }
        }

        const existing = getLiveEntry(db, key);
        if (nx && existing) {
          return getOld ? encodeBulk(existing.type !== 'hash' ? existing.value : null) : encodeBulk(null);
        }
        if (xx && !existing) {
          return encodeBulk(null);
        }
        if (keepTtl && existing) {
          expiresAt = existing.expiresAt;
        }
        if (expiresAt !== null && expiresAt <= Date.now()) {
          db.delete(key);
        } else {
          db.set(key, { type: 'string', value: Buffer.from(val), expiresAt });
        }
        return getOld
          ? encodeBulk(existing && existing.type !== 'hash' ? existing.value : null)
          : encodeSimple('OK');
      }
      case 'SETEX': {
        const key = strArgs[0];
        const sec = Number.parseInt(strArgs[1] ?? '0', 10);
        const val = args[2] ?? Buffer.alloc(0);
        if (sec <= 0) {
          db.delete(key);
        } else {
          db.set(key, { type: 'string', value: Buffer.from(val), expiresAt: Date.now() + sec * 1000 });
        }
        return encodeSimple('OK');
      }
      case 'PSETEX': {
        const key = strArgs[0];
        const ms = Number.parseInt(strArgs[1] ?? '0', 10);
        const val = args[2] ?? Buffer.alloc(0);
        if (ms <= 0) {
          db.delete(key);
        } else {
          db.set(key, { type: 'string', value: Buffer.from(val), expiresAt: Date.now() + ms });
        }
        return encodeSimple('OK');
      }
      case 'HSET':
      case 'HMSET': {
        if (args.length < 3 || (args.length - 1) % 2 !== 0) {
          return encodeError(`ERR wrong number of arguments for '${cmd.toLowerCase()}' command`);
        }
        const key = strArgs[0];
        let entry = getLiveEntry(db, key);
        if (entry && entry.type !== 'hash') {
          return encodeError('WRONGTYPE Operation against a key holding the wrong kind of value');
        }
        if (!entry) {
          entry = { type: 'hash', hash: new Map(), expiresAt: null };
          db.set(key, entry);
        }
        let added = 0;
        for (let i = 1; i < args.length; i += 2) {
          const field = strArgs[i];
          if (!entry.hash.has(field)) added += 1;
          entry.hash.set(field, Buffer.from(args[i + 1]));
        }
        return cmd === 'HMSET' ? encodeSimple('OK') : encodeInteger(added);
      }
      case 'HGET': {
        const key = strArgs[0] ?? '';
        const field = strArgs[1] ?? '';
        const entry = getLiveEntry(db, key);
        if (!entry) return encodeBulk(null);
        if (entry.type !== 'hash') {
          return encodeError('WRONGTYPE Operation against a key holding the wrong kind of value');
        }
        return encodeBulk(entry.hash.get(field) ?? null);
      }
      case 'HMGET': {
        const key = strArgs[0] ?? '';
        const fields = strArgs.slice(1);
        const entry = getLiveEntry(db, key);
        if (entry && entry.type !== 'hash') {
          return encodeError('WRONGTYPE Operation against a key holding the wrong kind of value');
        }
        return encodeArray(fields.map((f) => encodeBulk(entry ? (entry.hash.get(f) ?? null) : null)));
      }
      case 'HDEL': {
        const key = strArgs[0] ?? '';
        const fields = strArgs.slice(1);
        const entry = getLiveEntry(db, key);
        if (!entry) return encodeInteger(0);
        if (entry.type !== 'hash') {
          return encodeError('WRONGTYPE Operation against a key holding the wrong kind of value');
        }
        let removed = 0;
        for (const f of fields) {
          if (entry.hash.delete(f)) removed += 1;
        }
        if (entry.hash.size === 0) db.delete(key);
        return encodeInteger(removed);
      }
      case 'HGETALL': {
        const key = strArgs[0] ?? '';
        const entry = getLiveEntry(db, key);
        if (!entry) return encodeArray([]);
        if (entry.type !== 'hash') {
          return encodeError('WRONGTYPE Operation against a key holding the wrong kind of value');
        }
        const items = [];
        for (const [f, v] of entry.hash.entries()) {
          items.push(encodeBulk(f), encodeBulk(v));
        }
        return encodeArray(items);
      }
      case 'HEXISTS': {
        const entry = getLiveEntry(db, strArgs[0] ?? '');
        if (!entry) return encodeInteger(0);
        if (entry.type !== 'hash') {
          return encodeError('WRONGTYPE Operation against a key holding the wrong kind of value');
        }
        return encodeInteger(entry.hash.has(strArgs[1] ?? '') ? 1 : 0);
      }
      case 'HLEN': {
        const entry = getLiveEntry(db, strArgs[0] ?? '');
        if (!entry) return encodeInteger(0);
        if (entry.type !== 'hash') {
          return encodeError('WRONGTYPE Operation against a key holding the wrong kind of value');
        }
        return encodeInteger(entry.hash.size);
      }
      case 'HINCRBY': {
        const key = strArgs[0] ?? '';
        const field = strArgs[1] ?? '';
        const delta = Number.parseInt(strArgs[2] ?? '', 10);
        if (Number.isNaN(delta)) {
          return encodeError('ERR value is not an integer or out of range');
        }
        let entry = getLiveEntry(db, key);
        if (entry && entry.type !== 'hash') {
          return encodeError('WRONGTYPE Operation against a key holding the wrong kind of value');
        }
        if (!entry) {
          entry = { type: 'hash', hash: new Map(), expiresAt: null };
          db.set(key, entry);
        }
        const existing = entry.hash.get(field);
        const cur = existing ? Number.parseInt(existing.toString('utf8'), 10) : 0;
        if (Number.isNaN(cur)) {
          return encodeError('ERR hash value is not an integer');
        }
        const nextVal = cur + delta;
        entry.hash.set(field, Buffer.from(String(nextVal), 'utf8'));
        return encodeInteger(nextVal);
      }
      case 'DEL':
      case 'UNLINK': {
        let deleted = 0;
        for (const k of strArgs) {
          if (getLiveEntry(db, k) !== null) {
            db.delete(k);
            deleted += 1;
          }
        }
        return encodeInteger(deleted);
      }
      case 'EXISTS': {
        let count = 0;
        for (const k of strArgs) {
          if (getLiveEntry(db, k) !== null) count += 1;
        }
        return encodeInteger(count);
      }
      case 'EXPIRE': {
        const key = strArgs[0];
        const sec = Number.parseInt(strArgs[1] ?? '0', 10);
        const entry = getLiveEntry(db, key);
        if (!entry) return encodeInteger(0);
        if (sec <= 0) {
          db.delete(key);
          return encodeInteger(1);
        }
        entry.expiresAt = Date.now() + sec * 1000;
        return encodeInteger(1);
      }
      case 'PEXPIRE': {
        const key = strArgs[0];
        const ms = Number.parseInt(strArgs[1] ?? '0', 10);
        const entry = getLiveEntry(db, key);
        if (!entry) return encodeInteger(0);
        if (ms <= 0) {
          db.delete(key);
          return encodeInteger(1);
        }
        entry.expiresAt = Date.now() + ms;
        return encodeInteger(1);
      }
      case 'PERSIST': {
        const entry = getLiveEntry(db, strArgs[0] ?? '');
        if (!entry || entry.expiresAt === null) return encodeInteger(0);
        entry.expiresAt = null;
        return encodeInteger(1);
      }
      case 'TTL': {
        const entry = getLiveEntry(db, strArgs[0] ?? '');
        if (!entry) return encodeInteger(-2);
        if (entry.expiresAt === null) return encodeInteger(-1);
        return encodeInteger(Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000)));
      }
      case 'PTTL': {
        const entry = getLiveEntry(db, strArgs[0] ?? '');
        if (!entry) return encodeInteger(-2);
        if (entry.expiresAt === null) return encodeInteger(-1);
        return encodeInteger(Math.max(0, entry.expiresAt - Date.now()));
      }
      case 'INCR':
      case 'DECR':
      case 'INCRBY':
      case 'DECRBY': {
        const key = strArgs[0];
        const delta =
          cmd === 'INCR'
            ? 1
            : cmd === 'DECR'
              ? -1
              : cmd === 'INCRBY'
                ? Number.parseInt(strArgs[1] ?? '0', 10)
                : -Number.parseInt(strArgs[1] ?? '0', 10);
        const entry = getLiveEntry(db, key);
        if (entry && entry.type === 'hash') {
          return encodeError('WRONGTYPE Operation against a key holding the wrong kind of value');
        }
        const current = entry ? Number.parseInt(entry.value.toString('utf8'), 10) : 0;
        if (Number.isNaN(current) || Number.isNaN(delta)) {
          return encodeError('ERR value is not an integer or out of range');
        }
        const nextVal = current + delta;
        db.set(key, {
          type: 'string',
          value: Buffer.from(String(nextVal), 'utf8'),
          expiresAt: entry ? entry.expiresAt : null,
        });
        return encodeInteger(nextVal);
      }
      case 'SCRIPT': {
        const sub = (strArgs[0] || '').toUpperCase();
        if (sub === 'LOAD') {
          const script = strArgs[1] ?? '';
          const sha1 = crypto.createHash('sha1').update(script, 'utf8').digest('hex');
          scriptCache.set(sha1, script);
          return encodeBulk(sha1);
        }
        if (sub === 'EXISTS') {
          return encodeArray(strArgs.slice(1).map((h) => encodeInteger(scriptCache.has(h.toLowerCase()) ? 1 : 0)));
        }
        if (sub === 'FLUSH') {
          scriptCache.clear();
          return encodeSimple('OK');
        }
        return encodeSimple('OK');
      }
      case 'EVAL': {
        if (args.length < 2) {
          return encodeError("ERR wrong number of arguments for 'eval' command");
        }
        const script = strArgs[0];
        const numKeys = Number.parseInt(strArgs[1], 10);
        if (Number.isNaN(numKeys) || numKeys < 0 || args.length < 2 + numKeys) {
          return encodeError('ERR Number of keys cannot be greater than number of args');
        }
        const sha1 = crypto.createHash('sha1').update(script, 'utf8').digest('hex');
        scriptCache.set(sha1, script);
        const keys = strArgs.slice(2, 2 + numKeys);
        const argv = strArgs.slice(2 + numKeys);
        const argBufs = args.slice(2 + numKeys);
        return evaluateLuaScript(db, script, keys, argv, argBufs, connState);
      }
      case 'EVALSHA': {
        if (args.length < 2) {
          return encodeError("ERR wrong number of arguments for 'evalsha' command");
        }
        const sha1 = (strArgs[0] || '').toLowerCase();
        const numKeys = Number.parseInt(strArgs[1], 10);
        if (Number.isNaN(numKeys) || numKeys < 0 || args.length < 2 + numKeys) {
          return encodeError('ERR Number of keys cannot be greater than number of args');
        }
        const script = scriptCache.get(sha1);
        if (!script) {
          return encodeError('NOSCRIPT No matching script. Please use EVAL.');
        }
        const keys = strArgs.slice(2, 2 + numKeys);
        const argv = strArgs.slice(2 + numKeys);
        const argBufs = args.slice(2 + numKeys);
        return evaluateLuaScript(db, script, keys, argv, argBufs, connState);
      }
      case 'KEYS': {
        purgeExpired(db);
        const pattern = strArgs[0] ?? '*';
        const regex = globToRegExp(pattern);
        const matched = [];
        for (const k of db.keys()) {
          if (regex.test(k)) matched.push(encodeBulk(k));
        }
        return encodeArray(matched);
      }
      case 'SCAN': {
        purgeExpired(db);
        const cursor = Math.max(0, Number.parseInt(strArgs[0] ?? '0', 10) || 0);
        let matchPat = '*';
        let count = 10;
        for (let i = 1; i < strArgs.length; i += 1) {
          const tok = strArgs[i].toUpperCase();
          if (tok === 'MATCH' && i + 1 < strArgs.length) matchPat = strArgs[++i];
          else if (tok === 'COUNT' && i + 1 < strArgs.length) {
            count = Math.max(1, Number.parseInt(strArgs[++i], 10) || 10);
          }
        }
        const regex = globToRegExp(matchPat);
        const allMatching = [...db.keys()].filter((k) => regex.test(k));
        const page = allMatching.slice(cursor, cursor + count);
        const nextCursor = cursor + count >= allMatching.length ? '0' : String(cursor + count);
        return encodeArray([encodeBulk(nextCursor), encodeArray(page.map((k) => encodeBulk(k)))]);
      }
      case 'FLUSHDB': {
        db.clear();
        return encodeSimple('OK');
      }
      case 'FLUSHALL': {
        databases.clear();
        return encodeSimple('OK');
      }
      default: {
        return encodeError(`ERR unknown command '${cmd}'`);
      }
    }
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    let recvBuf = Buffer.alloc(0);
    const connState = {
      currentDb: 0,
      clientName: null,
      multiQueue: null,
    };

    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));

    socket.on('data', (chunk) => {
      recvBuf = Buffer.concat([recvBuf, chunk]);
      const { commands, remaining } = parseRespCommands(recvBuf);
      recvBuf = remaining;

      for (const rawArgs of commands) {
        const cmd = rawArgs[0].toString('utf8').toUpperCase();
        const args = rawArgs.slice(1);
        const strArgs = args.map((b) => b.toString('utf8'));

        if (cmd === 'QUIT') {
          socket.write(encodeSimple('OK'));
          socket.end();
          break;
        }
        if (cmd === 'MULTI') {
          if (connState.multiQueue !== null) {
            socket.write(encodeError('ERR MULTI calls can not be nested'));
          } else {
            connState.multiQueue = [];
            socket.write(encodeSimple('OK'));
          }
          continue;
        }
        if (cmd === 'DISCARD') {
          if (connState.multiQueue === null) {
            socket.write(encodeError('ERR DISCARD without MULTI'));
          } else {
            connState.multiQueue = null;
            socket.write(encodeSimple('OK'));
          }
          continue;
        }
        if (cmd === 'EXEC') {
          if (connState.multiQueue === null) {
            socket.write(encodeError('ERR EXEC without MULTI'));
          } else {
            const queue = connState.multiQueue;
            connState.multiQueue = null;
            const results = queue.map((q) => executeCommand(q.cmd, q.args, q.strArgs, connState));
            socket.write(encodeArray(results));
          }
          continue;
        }
        if (connState.multiQueue !== null) {
          connState.multiQueue.push({ cmd, args, strArgs });
          socket.write(encodeSimple('QUEUED'));
          continue;
        }

        socket.write(executeCommand(cmd, args, strArgs, connState));
      }
    });
  });

  return {
    server,
    start: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}

// =============================================================================
// 2. Meilisearch HTTP Server (127.0.0.1:7700)
// =============================================================================
function tokenizeFilter(expr) {
  const tokens = [];
  let i = 0;
  const s = expr.trim();

  while (i < s.length) {
    if (/\s/.test(s[i])) {
      i += 1;
      continue;
    }
    const twoChar = s.slice(i, i + 2);
    if (twoChar === '!=' || twoChar === '>=' || twoChar === '<=') {
      tokens.push({ type: 'OP', value: twoChar });
      i += 2;
      continue;
    }
    const ch = s[i];
    if (ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === ',') {
      tokens.push({ type: ch, value: ch });
      i += 1;
      continue;
    }
    if (ch === '=' || ch === '>' || ch === '<') {
      tokens.push({ type: 'OP', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let val = '';
      i += 1;
      while (i < s.length && s[i] !== quote) {
        if (s[i] === '\\' && i + 1 < s.length) {
          val += s[i + 1];
          i += 2;
        } else {
          val += s[i];
          i += 1;
        }
      }
      if (s[i] === quote) i += 1;
      tokens.push({ type: 'STRING', value: val });
      continue;
    }
    let start = i;
    while (i < s.length && !/[\s()[\],=<>!]/.test(s[i])) {
      i += 1;
    }
    const word = s.slice(start, i);
    const upper = word.toUpperCase();
    if (upper === 'AND' || upper === 'OR' || upper === 'NOT' || upper === 'IN' || upper === 'TO' || upper === 'EXISTS' || upper === 'IS' || upper === 'NULL') {
      tokens.push({ type: upper, value: upper });
    } else if (/^-?\d+(?:\.\d+)?$/.test(word)) {
      tokens.push({ type: 'NUMBER', value: Number(word) });
    } else if (upper === 'TRUE' || upper === 'FALSE') {
      tokens.push({ type: 'BOOL', value: upper === 'TRUE' });
    } else {
      tokens.push({ type: 'IDENT', value: word });
    }
  }
  return tokens;
}

function getNestedField(doc, fieldPath) {
  const parts = fieldPath.split('.');
  let cur = doc;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function scalarMatchesEq(actual, target) {
  if (actual === undefined || actual === null) return false;
  if (typeof actual === 'boolean' || typeof target === 'boolean') {
    return String(actual).toLowerCase() === String(target).toLowerCase();
  }
  if (typeof actual === 'number' && typeof target === 'number') {
    return actual === target;
  }
  return foldVietnamese(actual) === foldVietnamese(target);
}

function evaluateFilterString(expr, doc) {
  if (!expr || !String(expr).trim()) return true;
  const tokens = tokenizeFilter(String(expr));
  let pos = 0;

  function peek(offset = 0) {
    return tokens[pos + offset];
  }
  function consume() {
    return tokens[pos++];
  }

  function parseOr() {
    let left = parseAnd();
    while (peek()?.type === 'OR') {
      consume();
      const right = parseAnd();
      left = left || right;
    }
    return left;
  }

  function parseAnd() {
    let left = parseUnary();
    while (peek()?.type === 'AND') {
      consume();
      const right = parseUnary();
      left = left && right;
    }
    return left;
  }

  function parseUnary() {
    if (peek()?.type === 'NOT') {
      consume();
      return !parseUnary();
    }
    if (peek()?.type === '(') {
      consume();
      const val = parseOr();
      if (peek()?.type === ')') consume();
      return val;
    }
    return parseComparison();
  }

  function parseValue() {
    const tok = consume();
    if (!tok) return undefined;
    return tok.value;
  }

  function parseComparison() {
    const fieldTok = consume();
    if (!fieldTok) return true;
    const fieldVal = getNestedField(doc, String(fieldTok.value));

    const next = peek();
    if (!next) return Boolean(fieldVal);

    if (next.type === 'EXISTS') {
      consume();
      return fieldVal !== undefined;
    }
    if (next.type === 'IS') {
      consume();
      let negate = false;
      if (peek()?.type === 'NOT') {
        negate = true;
        consume();
      }
      if (peek()?.type === 'NULL') consume();
      const isNull = fieldVal === null || fieldVal === undefined;
      return negate ? !isNull : isNull;
    }
    if (next.type === 'NOT' && peek(1)?.type === 'IN') {
      consume();
      consume();
      const list = parseList();
      return !matchesIn(fieldVal, list);
    }
    if (next.type === 'IN') {
      consume();
      const list = parseList();
      return matchesIn(fieldVal, list);
    }
    if (next.type === 'OP') {
      const op = consume().value;
      const target = parseValue();
      return compareValues(fieldVal, op, target);
    }
    if (next.type === 'NUMBER' && peek(1)?.type === 'TO') {
      const min = Number(consume().value);
      consume(); // TO
      const max = Number(parseValue());
      const num = Number(fieldVal);
      return !Number.isNaN(num) && num >= min && num <= max;
    }
    return true;
  }

  function parseList() {
    const items = [];
    if (peek()?.type === '[') consume();
    while (peek() && peek().type !== ']') {
      if (peek().type === ',') {
        consume();
        continue;
      }
      items.push(parseValue());
    }
    if (peek()?.type === ']') consume();
    return items;
  }

  function matchesIn(actual, list) {
    if (actual === undefined || actual === null) return false;
    if (Array.isArray(actual)) {
      return actual.some((el) => list.some((t) => scalarMatchesEq(el, t)));
    }
    return list.some((t) => scalarMatchesEq(actual, t));
  }

  function compareValues(actual, op, target) {
    if (Array.isArray(actual)) {
      if (op === '=') return actual.some((el) => scalarMatchesEq(el, target));
      if (op === '!=') return !actual.some((el) => scalarMatchesEq(el, target));
      return actual.some((el) => compareValues(el, op, target));
    }
    if (op === '=') return scalarMatchesEq(actual, target);
    if (op === '!=') return !scalarMatchesEq(actual, target);
    const aNum = Number(actual);
    const tNum = Number(target);
    if (!Number.isNaN(aNum) && !Number.isNaN(tNum)) {
      if (op === '>') return aNum > tNum;
      if (op === '>=') return aNum >= tNum;
      if (op === '<') return aNum < tNum;
      if (op === '<=') return aNum <= tNum;
    }
    const aStr = foldVietnamese(actual);
    const tStr = foldVietnamese(target);
    if (op === '>') return aStr > tStr;
    if (op === '>=') return aStr >= tStr;
    if (op === '<') return aStr < tStr;
    if (op === '<=') return aStr <= tStr;
    return false;
  }

  return parseOr();
}

function evaluateFilter(filter, doc) {
  if (!filter) return true;
  if (typeof filter === 'string') {
    return evaluateFilterString(filter, doc);
  }
  if (Array.isArray(filter)) {
    // Meilisearch array filter syntax: outer = AND, inner = OR
    return filter.every((clause) => {
      if (Array.isArray(clause)) {
        return clause.some((sub) => evaluateFilter(sub, doc));
      }
      return evaluateFilter(clause, doc);
    });
  }
  return true;
}

function collectSearchableText(doc, searchableAttributes) {
  const parts = [];
  const visit = (val) => {
    if (val === null || val === undefined) return;
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      parts.push(String(val));
    } else if (Array.isArray(val)) {
      for (const item of val) visit(item);
    } else if (typeof val === 'object') {
      for (const v of Object.values(val)) visit(v);
    }
  };

  if (
    Array.isArray(searchableAttributes) &&
    searchableAttributes.length > 0 &&
    !searchableAttributes.includes('*')
  ) {
    for (const attr of searchableAttributes) {
      visit(getNestedField(doc, attr));
    }
  } else {
    visit(doc);
  }
  return foldVietnamese(parts.join(' '));
}

function expandQueryWithSynonyms(foldedQuery, synonymsMap) {
  const variants = new Set([foldedQuery]);
  if (!synonymsMap || typeof synonymsMap !== 'object' || !foldedQuery) {
    return [...variants];
  }

  // Build normalized bidirectional synonym lookup
  /** @type {Map<string, Set<string>>} */
  const normSyns = new Map();
  const addLink = (a, b) => {
    const fa = foldVietnamese(a);
    const fb = foldVietnamese(b);
    if (!fa || !fb || fa === fb) return;
    if (!normSyns.has(fa)) normSyns.set(fa, new Set());
    normSyns.get(fa).add(fb);
  };

  for (const [k, vals] of Object.entries(synonymsMap)) {
    if (!Array.isArray(vals)) continue;
    for (const v of vals) {
      addLink(k, v);
      addLink(v, k);
    }
  }

  // Phrase replacement expansion
  for (const [src, targets] of normSyns.entries()) {
    if (foldedQuery === src || foldedQuery.includes(src)) {
      for (const target of targets) {
        const replaced = foldedQuery.replace(src, target).replace(/\s+/g, ' ').trim();
        variants.add(replaced);
      }
    }
  }

  return [...variants];
}

function scoreDocumentAgainstQueries(foldedDoc, queryVariants) {
  let bestScore = 0;
  const docWords = foldedDoc.split(' ').filter(Boolean);

  for (const q of queryVariants) {
    if (!q) return 1;
    if (foldedDoc.includes(q)) {
      bestScore = Math.max(bestScore, 100 + q.length);
      continue;
    }
    const qTokens = q.split(' ').filter(Boolean);
    if (qTokens.length === 0) continue;

    let allMatched = true;
    let tokenScore = 0;
    for (const qt of qTokens) {
      if (docWords.includes(qt)) {
        tokenScore += 20;
      } else if (docWords.some((dw) => dw.startsWith(qt))) {
        tokenScore += 12;
      } else if (foldedDoc.includes(qt)) {
        tokenScore += 8;
      } else {
        allMatched = false;
        break;
      }
    }
    if (allMatched) {
      bestScore = Math.max(bestScore, tokenScore);
    }
  }
  return bestScore;
}

function createMeilisearchServer(port) {
  /** @type {Map<string, { uid: string, primaryKey: string, createdAt: string, updatedAt: string, docs: Map<string, Record<string, unknown>>, settings: Record<string, unknown> }>} */
  const indexes = new Map();
  /** @type {Map<number, Record<string, unknown>>} */
  const tasks = new Map();
  let nextTaskUid = 1;
  const sockets = new Set();

  function defaultSettings() {
    return {
      displayedAttributes: ['*'],
      searchableAttributes: ['*'],
      filterableAttributes: [],
      sortableAttributes: [],
      rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
      stopWords: [],
      synonyms: {},
      distinctAttribute: null,
      typoTolerance: { enabled: true },
    };
  }

  function ensureIndex(uid, primaryKey = 'id') {
    let idx = indexes.get(uid);
    if (!idx) {
      const now = new Date().toISOString();
      idx = {
        uid,
        primaryKey: primaryKey || 'id',
        createdAt: now,
        updatedAt: now,
        docs: new Map(),
        settings: defaultSettings(),
      };
      indexes.set(uid, idx);
    } else if (primaryKey && !idx.primaryKey) {
      idx.primaryKey = primaryKey;
    }
    return idx;
  }

  function enqueueAndCompleteTask(indexUid, type, details = {}) {
    const uid = nextTaskUid++;
    const now = new Date().toISOString();
    const taskRecord = {
      uid,
      indexUid: indexUid ?? null,
      status: 'succeeded',
      type,
      canceledBy: null,
      details,
      error: null,
      duration: 'PT0.001S',
      enqueuedAt: now,
      startedAt: now,
      finishedAt: now,
    };
    tasks.set(uid, taskRecord);
    return {
      taskUid: uid,
      indexUid: indexUid ?? null,
      status: 'enqueued',
      type,
      enqueuedAt: now,
    };
  }

  function executeSearch(idx, params) {
    const t0 = Date.now();
    const q = String(params.q ?? '').trim();
    const foldedQ = foldVietnamese(q);
    const queryVariants = foldedQ ? expandQueryWithSynonyms(foldedQ, idx.settings.synonyms) : [''];
    const limit =
      params.hitsPerPage !== undefined
        ? Number(params.hitsPerPage)
        : params.limit !== undefined
          ? Number(params.limit)
          : 20;
    const offset =
      params.page !== undefined
        ? Math.max(0, (Number(params.page) - 1) * limit)
        : params.offset !== undefined
          ? Number(params.offset)
          : 0;

    let candidates = [];
    for (const doc of idx.docs.values()) {
      if (!evaluateFilter(params.filter, doc)) continue;
      if (!foldedQ) {
        candidates.push({ doc, score: 1 });
      } else {
        const searchableText = collectSearchableText(doc, idx.settings.searchableAttributes);
        const score = scoreDocumentAgainstQueries(searchableText, queryVariants);
        if (score > 0) {
          candidates.push({ doc, score });
        }
      }
    }

    // Sorting
    const sortSpecs = Array.isArray(params.sort)
      ? params.sort
      : typeof params.sort === 'string' && params.sort.trim()
        ? params.sort.split(',').map((s) => s.trim())
        : [];

    candidates.sort((a, b) => {
      for (const spec of sortSpecs) {
        const [field, dirRaw] = spec.split(':');
        const dir = (dirRaw || 'asc').toLowerCase() === 'desc' ? -1 : 1;
        const av = getNestedField(a.doc, field);
        const bv = getNestedField(b.doc, field);
        if (av === bv) continue;
        if (av === undefined || av === null) return 1;
        if (bv === undefined || bv === null) return -1;
        if (typeof av === 'number' && typeof bv === 'number') {
          return (av - bv) * dir;
        }
        return String(av).localeCompare(String(bv)) * dir;
      }
      return b.score - a.score;
    });

    // Optional facets
    let facetDistribution;
    if (Array.isArray(params.facets) && params.facets.length > 0) {
      facetDistribution = {};
      for (const facetField of params.facets) {
        const counts = {};
        for (const { doc } of candidates) {
          const val = getNestedField(doc, facetField);
          const list = Array.isArray(val) ? val : val !== undefined && val !== null ? [val] : [];
          for (const item of list) {
            const key = String(item);
            counts[key] = (counts[key] || 0) + 1;
          }
        }
        facetDistribution[facetField] = counts;
      }
    }

    const totalHits = candidates.length;
    const hits = candidates.slice(offset, offset + limit).map((c) => c.doc);
    const response = {
      hits,
      query: q,
      processingTimeMs: Math.max(1, Date.now() - t0),
      limit,
      offset,
      estimatedTotalHits: totalHits,
    };
    if (params.page !== undefined || params.hitsPerPage !== undefined) {
      response.totalHits = totalHits;
      response.hitsPerPage = limit;
      response.page = params.page !== undefined ? Number(params.page) : 1;
      response.totalPages = Math.max(1, Math.ceil(totalHits / Math.max(1, limit)));
    }
    if (facetDistribution) {
      response.facetDistribution = facetDistribution;
    }
    return response;
  }

  const server = http.createServer(async (req, res) => {
    const corsHeaders = {
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      const pathname = url.pathname.replace(/\/+$/, '') || '/';
      const method = req.method || 'GET';

      if (method === 'GET' && pathname === '/health') {
        return sendJson(res, 200, { status: 'available' }, corsHeaders);
      }
      if (method === 'GET' && pathname === '/version') {
        return sendJson(
          res,
          200,
          { commitSha: 'local-dev-harness', commitDate: '2026-01-01T00:00:00Z', pkgVersion: '1.11.0' },
          corsHeaders,
        );
      }

      // Tasks endpoints
      const taskMatch = /^\/tasks\/(\d+)$/.exec(pathname);
      if (method === 'GET' && taskMatch) {
        const task = tasks.get(Number(taskMatch[1]));
        if (!task) {
          return sendJson(
            res,
            404,
            { message: `Task ${taskMatch[1]} not found.`, code: 'task_not_found', type: 'invalid_request', link: '' },
            corsHeaders,
          );
        }
        return sendJson(res, 200, task, corsHeaders);
      }
      if (method === 'GET' && pathname === '/tasks') {
        const list = [...tasks.values()].reverse();
        return sendJson(
          res,
          200,
          { results: list.slice(0, 50), total: list.length, limit: 50, from: list[0]?.uid ?? null, next: null },
          corsHeaders,
        );
      }

      // Indexes root
      if (pathname === '/indexes') {
        if (method === 'GET') {
          const results = [...indexes.values()].map((i) => ({
            uid: i.uid,
            primaryKey: i.primaryKey,
            createdAt: i.createdAt,
            updatedAt: i.updatedAt,
          }));
          return sendJson(res, 200, { results, offset: 0, limit: 20, total: results.length }, corsHeaders);
        }
        if (method === 'POST') {
          const raw = (await readRequestBodyBuffer(req)).toString('utf8');
          const body = raw ? JSON.parse(raw) : {};
          const uid = body.uid;
          if (!uid) {
            return sendJson(
              res,
              400,
              { message: 'Missing index uid', code: 'missing_index_uid', type: 'invalid_request', link: '' },
              corsHeaders,
            );
          }
          ensureIndex(uid, body.primaryKey || 'id');
          return sendJson(res, 202, enqueueAndCompleteTask(uid, 'indexCreation', { primaryKey: body.primaryKey || 'id' }), corsHeaders);
        }
      }

      // /indexes/:uid/*
      const idxMatch = /^\/indexes\/([^/]+)(\/.*)?$/.exec(pathname);
      if (idxMatch) {
        const uid = decodeURIComponent(idxMatch[1]);
        const subPath = idxMatch[2] || '';

        if (subPath === '') {
          if (method === 'GET') {
            const idx = indexes.get(uid);
            if (!idx) {
              return sendJson(
                res,
                404,
                { message: `Index \`${uid}\` not found.`, code: 'index_not_found', type: 'invalid_request', link: '' },
                corsHeaders,
              );
            }
            return sendJson(
              res,
              200,
              { uid: idx.uid, primaryKey: idx.primaryKey, createdAt: idx.createdAt, updatedAt: idx.updatedAt },
              corsHeaders,
            );
          }
          if (method === 'DELETE') {
            indexes.delete(uid);
            return sendJson(res, 202, enqueueAndCompleteTask(uid, 'indexDeletion'), corsHeaders);
          }
        }

        // Settings routes
        const settingsSubMap = {
          '/settings/filterable-attributes': 'filterableAttributes',
          '/settings/sortable-attributes': 'sortableAttributes',
          '/settings/searchable-attributes': 'searchableAttributes',
          '/settings/displayed-attributes': 'displayedAttributes',
          '/settings/synonyms': 'synonyms',
          '/settings/ranking-rules': 'rankingRules',
          '/settings/stop-words': 'stopWords',
        };

        if (subPath === '/settings') {
          const idx = ensureIndex(uid);
          if (method === 'GET') {
            return sendJson(res, 200, idx.settings, corsHeaders);
          }
          if (method === 'PATCH' || method === 'PUT') {
            const raw = (await readRequestBodyBuffer(req)).toString('utf8');
            const body = raw ? JSON.parse(raw) : {};
            idx.settings = { ...idx.settings, ...body };
            idx.updatedAt = new Date().toISOString();
            return sendJson(res, 202, enqueueAndCompleteTask(uid, 'settingsUpdate', body), corsHeaders);
          }
          if (method === 'DELETE') {
            idx.settings = defaultSettings();
            idx.updatedAt = new Date().toISOString();
            return sendJson(res, 202, enqueueAndCompleteTask(uid, 'settingsUpdate'), corsHeaders);
          }
        }

        if (settingsSubMap[subPath]) {
          const key = settingsSubMap[subPath];
          const idx = ensureIndex(uid);
          if (method === 'GET') {
            return sendJson(res, 200, idx.settings[key], corsHeaders);
          }
          if (method === 'PUT' || method === 'POST' || method === 'PATCH') {
            const raw = (await readRequestBodyBuffer(req)).toString('utf8');
            const body = raw ? JSON.parse(raw) : null;
            idx.settings[key] = body;
            idx.updatedAt = new Date().toISOString();
            return sendJson(res, 202, enqueueAndCompleteTask(uid, 'settingsUpdate', { [key]: body }), corsHeaders);
          }
          if (method === 'DELETE') {
            idx.settings[key] = defaultSettings()[key];
            idx.updatedAt = new Date().toISOString();
            return sendJson(res, 202, enqueueAndCompleteTask(uid, 'settingsUpdate'), corsHeaders);
          }
        }

        // Documents routes
        if (subPath === '/documents/delete-batch' && method === 'POST') {
          const idx = ensureIndex(uid);
          const raw = (await readRequestBodyBuffer(req)).toString('utf8');
          const ids = raw ? JSON.parse(raw) : [];
          let deleted = 0;
          if (Array.isArray(ids)) {
            for (const id of ids) {
              if (idx.docs.delete(String(id))) deleted += 1;
            }
          }
          return sendJson(res, 202, enqueueAndCompleteTask(uid, 'documentDeletion', { deletedDocuments: deleted }), corsHeaders);
        }

        const docIdMatch = /^\/documents\/([^/]+)$/.exec(subPath);
        if (docIdMatch) {
          const docId = decodeURIComponent(docIdMatch[1]);
          const idx = indexes.get(uid);
          if (method === 'GET') {
            const doc = idx?.docs.get(docId);
            if (!doc) {
              return sendJson(
                res,
                404,
                { message: `Document \`${docId}\` not found.`, code: 'document_not_found', type: 'invalid_request', link: '' },
                corsHeaders,
              );
            }
            return sendJson(res, 200, doc, corsHeaders);
          }
          if (method === 'DELETE') {
            idx?.docs.delete(docId);
            return sendJson(res, 202, enqueueAndCompleteTask(uid, 'documentDeletion', { deletedDocuments: 1 }), corsHeaders);
          }
        }

        if (subPath === '/documents') {
          const primaryKeyQuery = url.searchParams.get('primaryKey') || undefined;
          const idx = ensureIndex(uid, primaryKeyQuery || 'id');
          if (method === 'GET') {
            const limit = Number(url.searchParams.get('limit') || 20);
            const offset = Number(url.searchParams.get('offset') || 0);
            const all = [...idx.docs.values()];
            return sendJson(
              res,
              200,
              { results: all.slice(offset, offset + limit), offset, limit, total: all.length },
              corsHeaders,
            );
          }
          if (method === 'POST' || method === 'PUT') {
            const raw = (await readRequestBodyBuffer(req)).toString('utf8');
            const parsed = raw ? JSON.parse(raw) : [];
            const docs = Array.isArray(parsed) ? parsed : [parsed];
            const pk = primaryKeyQuery || idx.primaryKey || 'id';
            for (const doc of docs) {
              if (!doc || typeof doc !== 'object') continue;
              const docKey = doc[pk] ?? doc.id ?? crypto.randomUUID();
              const idStr = String(docKey);
              if (method === 'PUT' && idx.docs.has(idStr)) {
                idx.docs.set(idStr, { ...idx.docs.get(idStr), ...doc });
              } else {
                idx.docs.set(idStr, { ...doc });
              }
            }
            idx.updatedAt = new Date().toISOString();
            return sendJson(
              res,
              202,
              enqueueAndCompleteTask(uid, 'documentAdditionOrUpdate', { receivedDocuments: docs.length, indexedDocuments: docs.length }),
              corsHeaders,
            );
          }
          if (method === 'DELETE') {
            const count = idx.docs.size;
            idx.docs.clear();
            return sendJson(res, 202, enqueueAndCompleteTask(uid, 'documentDeletion', { deletedDocuments: count }), corsHeaders);
          }
        }

        // Search routes
        if (subPath === '/search') {
          const idx = indexes.get(uid);
          if (!idx) {
            return sendJson(
              res,
              404,
              { message: `Index \`${uid}\` not found.`, code: 'index_not_found', type: 'invalid_request', link: '' },
              corsHeaders,
            );
          }
          let params = {};
          if (method === 'POST') {
            const raw = (await readRequestBodyBuffer(req)).toString('utf8');
            params = raw ? JSON.parse(raw) : {};
          } else if (method === 'GET') {
            params = {
              q: url.searchParams.get('q') || '',
              filter: url.searchParams.get('filter') || undefined,
              sort: url.searchParams.get('sort') || undefined,
              limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
              offset: url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : undefined,
              facets: url.searchParams.get('facets') ? url.searchParams.get('facets').split(',') : undefined,
            };
          }
          return sendJson(res, 200, executeSearch(idx, params), corsHeaders);
        }
      }

      return sendJson(
        res,
        404,
        { message: `Route ${method} ${pathname} not found`, code: 'not_found', type: 'invalid_request', link: '' },
        corsHeaders,
      );
    } catch (err) {
      return sendJson(
        res,
        400,
        { message: err instanceof Error ? err.message : String(err), code: 'bad_request', type: 'invalid_request', link: '' },
        corsHeaders,
      );
    }
  });

  server.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });

  return {
    server,
    start: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}

// =============================================================================
// 3. MinIO S3-Compatible HTTP Server (127.0.0.1:9000)
// =============================================================================
function decodeAwsChunkedPayload(rawBuf) {
  const chunks = [];
  let offset = 0;

  while (offset < rawBuf.length) {
    const lineEnd = rawBuf.indexOf('\r\n', offset);
    if (lineEnd === -1) break;
    const headerLine = rawBuf.subarray(offset, lineEnd).toString('utf8');
    const semiIdx = headerLine.indexOf(';');
    const hexSize = (semiIdx >= 0 ? headerLine.slice(0, semiIdx) : headerLine).trim();
    if (!/^[0-9a-fA-F]+$/.test(hexSize)) {
      return rawBuf;
    }
    const chunkSize = Number.parseInt(hexSize, 16);
    if (Number.isNaN(chunkSize)) {
      return rawBuf;
    }
    const dataStart = lineEnd + 2;
    if (chunkSize === 0) {
      break;
    }
    const dataEnd = dataStart + chunkSize;
    if (dataEnd > rawBuf.length) {
      return rawBuf;
    }
    chunks.push(rawBuf.subarray(dataStart, dataEnd));
    offset = dataEnd + 2; // skip trailing \r\n
  }

  return Buffer.concat(chunks);
}

function guessContentType(key) {
  const ext = path.extname(key).toLowerCase();
  if (ext === '.webp') return 'image/webp';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.json') return 'application/json';
  if (ext === '.txt') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function listObjectsRecursive(bucketDir, currentDir = bucketDir, prefix = '') {
  const results = [];
  if (!fs.existsSync(currentDir)) return results;
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listObjectsRecursive(bucketDir, full, prefix));
    } else {
      const relKey = path.relative(bucketDir, full).replace(/\\/g, '/');
      if (!prefix || relKey.startsWith(prefix)) {
        const stat = fs.statSync(full);
        results.push({ key: relKey, size: stat.size, lastModified: stat.mtime.toISOString() });
      }
    }
  }
  return results;
}

function createMinioServer(port, storageRoot, defaultBuckets, privateBucketName) {
  const metaRoot = path.join(storageRoot, '.meta');
  fs.mkdirSync(storageRoot, { recursive: true });
  fs.mkdirSync(metaRoot, { recursive: true });
  for (const bucket of defaultBuckets) {
    fs.mkdirSync(path.join(storageRoot, bucket), { recursive: true });
  }

  const sockets = new Set();

  function safeResolveInside(baseDir, relPath) {
    const resolvedBase = path.resolve(baseDir);
    const resolvedTarget = path.resolve(baseDir, relPath);
    if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
      return null;
    }
    return resolvedTarget;
  }

  function parseAmzDateMs(raw) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(raw || '').trim());
    if (!m) return null;
    return Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6]),
    );
  }

  function hasS3Auth(req, url) {
    if (typeof req.headers.authorization === 'string' && req.headers.authorization.trim().length > 0) {
      return true;
    }
    let signature = '';
    let amzDate = '';
    let amzExpires = '';
    for (const [k, v] of url.searchParams.entries()) {
      const lower = k.toLowerCase();
      if (lower === 'x-amz-signature') signature = v.trim();
      else if (lower === 'x-amz-date') amzDate = v.trim();
      else if (lower === 'x-amz-expires') amzExpires = v.trim();
    }
    if (!signature) return false;
    if (amzDate && amzExpires) {
      const signedAt = parseAmzDateMs(amzDate);
      const ttlSec = Number.parseInt(amzExpires, 10);
      if (signedAt !== null && Number.isFinite(ttlSec) && Date.now() > signedAt + ttlSec * 1000) {
        return false;
      }
    }
    return true;
  }

  function sendS3Xml(res, status, xml, extraHeaders = {}) {
    res.writeHead(status, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Length': Buffer.byteLength(xml),
      'x-amz-request-id': crypto.randomUUID(),
      ...extraHeaders,
    });
    res.end(xml);
  }

  function sendS3Error(res, status, code, message, extraHeaders = {}) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${escapeXml(code)}</Code><Message>${escapeXml(message)}</Message></Error>`;
    sendS3Xml(res, status, xml, extraHeaders);
  }

  const server = http.createServer(async (req, res) => {
    const reqOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const requestedHeaders =
      typeof req.headers['access-control-request-headers'] === 'string' &&
      req.headers['access-control-request-headers'].trim().length > 0
        ? req.headers['access-control-request-headers']
        : 'Content-Type, Authorization, X-Amz-Date, X-Amz-Content-Sha256, X-Amz-Security-Token, X-Amz-User-Agent, X-Requested-With';
    const corsHeaders = {
      'Access-Control-Allow-Origin': reqOrigin || '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': requestedHeaders,
      'Access-Control-Expose-Headers': 'ETag, Content-Length, Content-Type, x-amz-request-id',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin, Access-Control-Request-Headers',
      ...(reqOrigin ? { 'Access-Control-Allow-Credentials': 'true' } : {}),
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      const method = req.method || 'GET';
      const rawPathname = url.pathname;

      if (rawPathname === '/minio/health/live' || rawPathname === '/minio/health/ready') {
        res.writeHead(200, { 'Content-Type': 'text/plain', ...corsHeaders });
        res.end('OK');
        return;
      }

      if (rawPathname === '/' && method === 'GET') {
        const buckets = fs
          .readdirSync(storageRoot, { withFileTypes: true })
          .filter((d) => d.isDirectory() && d.name !== '.meta')
          .map((d) => `<Bucket><Name>${escapeXml(d.name)}</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket>`)
          .join('');
        const xml = `<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Buckets>${buckets}</Buckets></ListAllMyBucketsResult>`;
        return sendS3Xml(res, 200, xml, corsHeaders);
      }

      const trimmed = rawPathname.replace(/^\/+/, '');
      const slashIdx = trimmed.indexOf('/');
      const bucket = decodeURIComponent(slashIdx === -1 ? trimmed : trimmed.slice(0, slashIdx));
      const objectKey = slashIdx === -1 ? '' : trimmed.slice(slashIdx + 1).split('/').map(decodeURIComponent).join('/');

      if (!bucket || bucket === '.meta' || bucket.includes('..')) {
        return sendS3Error(res, 400, 'InvalidBucketName', 'Invalid bucket name', corsHeaders);
      }

      const bucketDir = safeResolveInside(storageRoot, bucket);
      if (!bucketDir) {
        return sendS3Error(res, 400, 'InvalidBucketName', 'Invalid bucket path', corsHeaders);
      }

      // Bucket-level operations
      if (!objectKey) {
        if (method === 'HEAD') {
          if (fs.existsSync(bucketDir)) {
            res.writeHead(200, { 'x-amz-request-id': crypto.randomUUID(), ...corsHeaders });
            res.end();
          } else {
            res.writeHead(404, { 'x-amz-request-id': crypto.randomUUID(), ...corsHeaders });
            res.end();
          }
          return;
        }
        if (method === 'PUT') {
          fs.mkdirSync(bucketDir, { recursive: true });
          res.writeHead(200, { 'x-amz-request-id': crypto.randomUUID(), ...corsHeaders });
          res.end();
          return;
        }
        if (method === 'DELETE') {
          if (fs.existsSync(bucketDir)) {
            fs.rmSync(bucketDir, { recursive: true, force: true });
          }
          res.writeHead(204, { 'x-amz-request-id': crypto.randomUUID(), ...corsHeaders });
          res.end();
          return;
        }
        if (method === 'POST' && url.searchParams.has('delete')) {
          if (bucket === privateBucketName && !hasS3Auth(req, url)) {
            return sendS3Error(res, 403, 'AccessDenied', 'Unsigned batch DELETE on atelier-private-tryon is forbidden.', corsHeaders);
          }
          const bodyText = (await readRequestBodyBuffer(req)).toString('utf8');
          const keys = [...bodyText.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => m[1]);
          const deletedXml = [];
          for (const k of keys) {
            const fPath = safeResolveInside(bucketDir, k);
            const mPath = safeResolveInside(path.join(metaRoot, bucket), `${k}.json`);
            if (fPath && fs.existsSync(fPath)) fs.rmSync(fPath, { force: true });
            if (mPath && fs.existsSync(mPath)) fs.rmSync(mPath, { force: true });
            deletedXml.push(`<Deleted><Key>${escapeXml(k)}</Key></Deleted>`);
          }
          return sendS3Xml(
            res,
            200,
            `<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${deletedXml.join('')}</DeleteResult>`,
            corsHeaders,
          );
        }
        if (method === 'GET') {
          if (bucket === privateBucketName && !hasS3Auth(req, url)) {
            return sendS3Error(res, 403, 'AccessDenied', 'Access Denied on private try-on bucket.', corsHeaders);
          }
          if (!fs.existsSync(bucketDir)) {
            return sendS3Error(res, 404, 'NoSuchBucket', 'The specified bucket does not exist.', corsHeaders);
          }
          const prefix = url.searchParams.get('prefix') || '';
          const maxKeys = Number.parseInt(url.searchParams.get('max-keys') || '1000', 10) || 1000;
          const items = listObjectsRecursive(bucketDir, bucketDir, prefix).slice(0, maxKeys);
          const contentsXml = items
            .map(
              (item) =>
                `<Contents><Key>${escapeXml(item.key)}</Key><LastModified>${escapeXml(item.lastModified)}</LastModified><ETag>&quot;local&quot;</ETag><Size>${item.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
            )
            .join('');
          const xml =
            `<?xml version="1.0" encoding="UTF-8"?>` +
            `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
            `<Name>${escapeXml(bucket)}</Name><Prefix>${escapeXml(prefix)}</Prefix>` +
            `<KeyCount>${items.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys><IsTruncated>false</IsTruncated>` +
            `${contentsXml}</ListBucketResult>`;
          return sendS3Xml(res, 200, xml, corsHeaders);
        }
      }

      // Object-level operations
      const filePath = safeResolveInside(bucketDir, objectKey);
      const metaPath = safeResolveInside(path.join(metaRoot, bucket), `${objectKey}.json`);
      if (!filePath || !metaPath) {
        return sendS3Error(res, 400, 'InvalidArgument', 'Invalid object key', corsHeaders);
      }

      if (method === 'PUT') {
        if (bucket === privateBucketName && !hasS3Auth(req, url)) {
          return sendS3Error(
            res,
            403,
            'AccessDenied',
            'Unsigned PUT to atelier-private-tryon is forbidden.',
            corsHeaders,
          );
        }
        if (!fs.existsSync(bucketDir)) {
          fs.mkdirSync(bucketDir, { recursive: true });
        }
        let payload = await readRequestBodyBuffer(req);
        const shaHeader = String(req.headers['x-amz-content-sha256'] || '');
        const contentEncoding = String(req.headers['content-encoding'] || '').toLowerCase();
        if (shaHeader.startsWith('STREAMING-') || contentEncoding.includes('aws-chunked')) {
          payload = decodeAwsChunkedPayload(payload);
        }
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.mkdirSync(path.dirname(metaPath), { recursive: true });
        fs.writeFileSync(filePath, payload);

        const etag = `"${crypto.createHash('md5').update(payload).digest('hex')}"`;
        const contentType = String(req.headers['content-type'] || guessContentType(objectKey));
        const meta = {
          contentType,
          etag,
          size: payload.length,
          lastModified: new Date().toUTCString(),
        };
        fs.writeFileSync(metaPath, JSON.stringify(meta), 'utf8');

        res.writeHead(200, {
          ETag: etag,
          'x-amz-request-id': crypto.randomUUID(),
          ...corsHeaders,
        });
        res.end();
        return;
      }

      if (method === 'GET' || method === 'HEAD') {
        if (bucket === privateBucketName && !hasS3Auth(req, url)) {
          return sendS3Error(res, 403, 'AccessDenied', 'Unsigned access to atelier-private-tryon is forbidden.', corsHeaders);
        }
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          if (method === 'HEAD') {
            res.writeHead(404, { 'x-amz-request-id': crypto.randomUUID(), ...corsHeaders });
            res.end();
            return;
          }
          return sendS3Error(res, 404, 'NoSuchKey', 'The specified key does not exist.', corsHeaders);
        }

        const data = method === 'GET' ? fs.readFileSync(filePath) : null;
        const stat = fs.statSync(filePath);
        let meta = {
          contentType: guessContentType(objectKey),
          etag: `"${stat.size}-${Math.trunc(stat.mtimeMs)}"`,
          lastModified: stat.mtime.toUTCString(),
        };
        if (fs.existsSync(metaPath)) {
          try {
            meta = { ...meta, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')) };
          } catch {
            // use fallback meta
          }
        }

        res.writeHead(200, {
          'Content-Type': meta.contentType,
          'Content-Length': stat.size,
          ETag: meta.etag,
          'Last-Modified': meta.lastModified,
          'Accept-Ranges': 'bytes',
          'x-amz-request-id': crypto.randomUUID(),
          ...corsHeaders,
        });
        if (method === 'GET' && data) {
          res.end(data);
        } else {
          res.end();
        }
        return;
      }

      if (method === 'DELETE') {
        if (bucket === privateBucketName && !hasS3Auth(req, url)) {
          return sendS3Error(
            res,
            403,
            'AccessDenied',
            'Unsigned DELETE on atelier-private-tryon is forbidden.',
            corsHeaders,
          );
        }
        if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
        if (fs.existsSync(metaPath)) fs.rmSync(metaPath, { force: true });
        res.writeHead(204, { 'x-amz-request-id': crypto.randomUUID(), ...corsHeaders });
        res.end();
        return;
      }

      return sendS3Error(res, 405, 'MethodNotAllowed', `Method ${method} not supported`, corsHeaders);
    } catch (err) {
      return sendS3Error(res, 500, 'InternalError', err instanceof Error ? err.message : String(err), corsHeaders);
    }
  });

  server.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });

  return {
    server,
    start: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}

// =============================================================================
// 4. Mailpit SMTP (127.0.0.1:1025) + HTTP API (127.0.0.1:8025)
// =============================================================================
function decodeQuotedPrintable(input) {
  const unfolded = input.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < unfolded.length; i += 1) {
    if (unfolded[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(unfolded.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(unfolded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(unfolded.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodeMimeWord(headerVal) {
  return String(headerVal || '').replace(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (_m, _charset, enc, payload) => {
    try {
      if (enc.toUpperCase() === 'B') {
        return Buffer.from(payload, 'base64').toString('utf8');
      }
      return decodeQuotedPrintable(payload.replace(/_/g, ' '));
    } catch {
      return payload;
    }
  });
}

function decodeTransferBody(body, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  if (enc === 'base64') {
    try {
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch {
      return body;
    }
  }
  if (enc === 'quoted-printable') {
    return decodeQuotedPrintable(body);
  }
  return body;
}

function parseHeadersAndBody(raw) {
  const sepIdx = raw.indexOf('\r\n\r\n');
  const altSepIdx = sepIdx === -1 ? raw.indexOf('\n\n') : sepIdx;
  const headerPart = altSepIdx === -1 ? raw : raw.slice(0, altSepIdx);
  const bodyPart = altSepIdx === -1 ? '' : raw.slice(altSepIdx + (sepIdx !== -1 ? 4 : 2));

  // Unfold RFC 5322 folded headers
  const unfolded = headerPart.replace(/\r?\n[ \t]+/g, ' ');
  const headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();
    headers[k] = v;
  }
  return { headers, body: bodyPart };
}

function parseAddress(raw, fallbackEmail = '') {
  const str = decodeMimeWord(raw || fallbackEmail).trim();
  const angle = /^(.*)<([^>]+)>/.exec(str);
  if (angle) {
    return { Name: angle[1].trim().replace(/^["']|["']$/g, ''), Address: angle[2].trim() };
  }
  return { Name: '', Address: str.replace(/^<|>$/g, '').trim() };
}

function extractMimeBodies(contentType, transferEncoding, body, acc, depth = 0) {
  if (depth > 8) return;
  const ctLower = String(contentType || 'text/plain').toLowerCase();
  const boundaryMatch = /boundary\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(contentType || '');
  if (ctLower.includes('multipart/') && boundaryMatch) {
    const boundary = boundaryMatch[1] || boundaryMatch[2] || boundaryMatch[3];
    const parts = body.split(`--${boundary}`);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || trimmed === '--' || trimmed.startsWith('--\r') || trimmed.startsWith('--\n')) continue;
      const parsed = parseHeadersAndBody(part.replace(/^\r?\n/, ''));
      const partCt = parsed.headers['content-type'] || 'text/plain';
      const partEnc = parsed.headers['content-transfer-encoding'] || '';
      const cleanedBody = parsed.body.replace(/\r?\n$/, '');
      extractMimeBodies(partCt, partEnc, cleanedBody, acc, depth + 1);
    }
    return;
  }
  const decoded = decodeTransferBody(body, transferEncoding);
  if (ctLower.includes('text/html')) {
    acc.htmlBody = acc.htmlBody ? `${acc.htmlBody}\n${decoded}` : decoded;
  } else if (ctLower.includes('text/plain') || !ctLower.includes('/')) {
    acc.textBody = acc.textBody ? `${acc.textBody}\n${decoded}` : decoded;
  }
}

function parseEmailMessage(rawData, envelopeFrom, envelopeTo) {
  const { headers, body } = parseHeadersAndBody(rawData);
  const contentType = headers['content-type'] || 'text/plain';
  const acc = { textBody: '', htmlBody: '' };
  extractMimeBodies(contentType, headers['content-transfer-encoding'] || '', body, acc, 0);
  const { textBody, htmlBody } = acc;

  const from = parseAddress(headers.from || envelopeFrom, envelopeFrom);
  const toList = headers.to
    ? headers.to.split(',').map((a) => parseAddress(a))
    : envelopeTo.map((a) => parseAddress(a));
  const subject = decodeMimeWord(headers.subject || '(no subject)');
  const plainSnippetSource = textBody || htmlBody.replace(/<[^>]+>/g, ' ');
  const snippet = plainSnippetSource.replace(/\s+/g, ' ').trim().slice(0, 180);

  return {
    ID: crypto.randomUUID(),
    MessageID: headers['message-id'] || `<${crypto.randomUUID()}@atelier.local>`,
    From: from,
    To: toList,
    Cc: [],
    Bcc: [],
    Subject: subject,
    Snippet: snippet,
    Text: textBody,
    HTML: htmlBody,
    Read: false,
    Size: Buffer.byteLength(rawData, 'utf8'),
    Created: new Date().toISOString(),
  };
}

function createMailpitServers(smtpPort, httpPort) {
  /** @type {Array<Record<string, unknown>>} */
  const messages = [];
  const smtpSockets = new Set();
  const httpSockets = new Set();

  const smtpServer = net.createServer((socket) => {
    smtpSockets.add(socket);
    socket.on('close', () => smtpSockets.delete(socket));
    socket.on('error', () => smtpSockets.delete(socket));

    let inDataMode = false;
    let lineBuf = '';
    let dataBuf = '';
    let mailFrom = '';
    let rcptTo = [];

    socket.write('220 atelier-local-mailpit ESMTP\r\n');

    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8');

      if (inDataMode) {
        dataBuf += text;
        const endMarker = '\r\n.\r\n';
        const altEndMarker = '\n.\n';
        let endIdx = dataBuf.indexOf(endMarker);
        let markerLen = endMarker.length;
        if (endIdx === -1 && dataBuf.startsWith('.\r\n')) {
          endIdx = 0;
          markerLen = 3;
        }
        if (endIdx === -1) {
          endIdx = dataBuf.indexOf(altEndMarker);
          markerLen = altEndMarker.length;
        }
        if (endIdx !== -1) {
          const rawMessage = dataBuf
            .slice(0, endIdx)
            .replace(/\r\n\.\./g, '\r\n.')
            .replace(/\n\.\./g, '\n.');
          const leftover = dataBuf.slice(endIdx + markerLen);
          inDataMode = false;
          dataBuf = '';

          const msg = parseEmailMessage(rawMessage, mailFrom, rcptTo);
          messages.unshift(msg);
          mailFrom = '';
          rcptTo = [];
          socket.write('250 2.0.0 OK queued\r\n');

          if (leftover.length > 0) {
            lineBuf += leftover;
            processLines();
          }
        }
        return;
      }

      lineBuf += text;
      processLines();
    });

    function processLines() {
      while (!inDataMode) {
        const nlIdx = lineBuf.indexOf('\n');
        if (nlIdx === -1) break;
        const line = lineBuf.slice(0, nlIdx).replace(/\r$/, '');
        lineBuf = lineBuf.slice(nlIdx + 1);
        const upper = line.toUpperCase();

        if (upper.startsWith('EHLO')) {
          socket.write(
            '250-atelier-local-mailpit\r\n250-PIPELINING\r\n250-SIZE 26214400\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n',
          );
        } else if (upper.startsWith('HELO')) {
          socket.write('250 atelier-local-mailpit\r\n');
        } else if (upper.startsWith('MAIL FROM:')) {
          mailFrom = line.slice(10).trim().replace(/^<|>$/g, '');
          socket.write('250 2.1.0 OK\r\n');
        } else if (upper.startsWith('RCPT TO:')) {
          rcptTo.push(line.slice(8).trim().replace(/^<|>$/g, ''));
          socket.write('250 2.1.5 OK\r\n');
        } else if (upper === 'DATA') {
          inDataMode = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          if (lineBuf.length > 0) {
            dataBuf = lineBuf;
            lineBuf = '';
          }
          break;
        } else if (upper === 'RSET') {
          mailFrom = '';
          rcptTo = [];
          socket.write('250 OK\r\n');
        } else if (upper === 'NOOP') {
          socket.write('250 OK\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
          break;
        } else {
          socket.write('250 OK\r\n');
        }
      }
    }
  });

  const httpServer = http.createServer((req, res) => {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${httpPort}`);
    const pathname = url.pathname;
    const method = req.method || 'GET';

    if (method === 'GET' && (pathname === '/livez' || pathname === '/readyz')) {
      res.writeHead(200, { 'Content-Type': 'text/plain', ...corsHeaders });
      res.end('ok');
      return;
    }

    if (method === 'GET' && pathname === '/') {
      const itemsHtml = messages
        .map((m) => `<li><strong>${escapeXml(m.Subject)}</strong> — ${escapeXml(m.Snippet)}</li>`)
        .join('');
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>Atelier Local Mailpit</title></head><body><h1>Atelier Local Mailpit (${messages.length} messages)</h1><ul>${itemsHtml}</ul></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders });
      res.end(html);
      return;
    }

    if (pathname === '/api/v1/search' && method === 'GET') {
      const q = (url.searchParams.get('query') || '').trim().toLowerCase();
      const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10) || 50;
      const start = Number.parseInt(url.searchParams.get('start') || '0', 10) || 0;
      const filtered = q
        ? messages.filter((m) => {
            const haystack = [
              m.Subject,
              m.Text,
              m.HTML,
              m.From?.Address,
              ...(Array.isArray(m.To) ? m.To.map((t) => t?.Address || '') : []),
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase();
            return haystack.includes(q);
          })
        : messages;
      const page = filtered.slice(start, start + limit);
      return sendJson(
        res,
        200,
        {
          total: filtered.length,
          unread: filtered.length,
          count: page.length,
          messages_count: page.length,
          start,
          messages: page,
        },
        corsHeaders,
      );
    }

    if (pathname === '/api/v1/messages') {
      if (method === 'GET') {
        const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10) || 50;
        const start = Number.parseInt(url.searchParams.get('start') || '0', 10) || 0;
        const page = messages.slice(start, start + limit);
        return sendJson(
          res,
          200,
          {
            total: messages.length,
            unread: messages.length,
            count: page.length,
            messages_count: page.length,
            start,
            messages: page,
          },
          corsHeaders,
        );
      }
      if (method === 'DELETE') {
        messages.length = 0;
        return sendJson(res, 200, { status: 'ok' }, corsHeaders);
      }
    }

    const msgMatch = /^\/api\/v1\/message\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && msgMatch) {
      const id = decodeURIComponent(msgMatch[1]);
      const found = messages.find((m) => m.ID === id);
      if (!found) {
        return sendJson(res, 404, { error: 'Message not found' }, corsHeaders);
      }
      return sendJson(res, 200, found, corsHeaders);
    }

    return sendJson(res, 404, { error: 'Not found' }, corsHeaders);
  });

  httpServer.on('connection', (sock) => {
    httpSockets.add(sock);
    sock.on('close', () => httpSockets.delete(sock));
  });

  return {
    smtpServer,
    httpServer,
    startSmtp: () =>
      new Promise((resolve, reject) => {
        smtpServer.once('error', reject);
        smtpServer.listen(smtpPort, '127.0.0.1', () => {
          smtpServer.removeListener('error', reject);
          resolve();
        });
      }),
    startHttp: () =>
      new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(httpPort, '127.0.0.1', () => {
          httpServer.removeListener('error', reject);
          resolve();
        });
      }),
    stopSmtp: () =>
      new Promise((resolve) => {
        for (const s of smtpSockets) s.destroy();
        smtpSockets.clear();
        smtpServer.close(() => resolve());
      }),
    stopHttp: () =>
      new Promise((resolve) => {
        for (const s of httpSockets) s.destroy();
        httpSockets.clear();
        httpServer.close(() => resolve());
      }),
  };
}

// =============================================================================
// 5. RabbitMQ Management v3.13 + DLQ HTTP Server (127.0.0.1:15672)
// =============================================================================
function createRabbitMqMgmtServer(port, expectedUser, expectedPassword) {
  const sockets = new Set();

  /** @type {Map<string, { name: string, vhost: string, type: string, durable: boolean }>} */
  const exchanges = new Map([
    ['', { name: '', vhost: '/', type: 'direct', durable: true }],
    ['amq.default', { name: 'amq.default', vhost: '/', type: 'direct', durable: true }],
    ['atelier.domain.topic', { name: 'atelier.domain.topic', vhost: '/', type: 'topic', durable: true }],
    ['atelier.dlx.direct', { name: 'atelier.dlx.direct', vhost: '/', type: 'direct', durable: true }],
    ['atelier.retry.direct', { name: 'atelier.retry.direct', vhost: '/', type: 'direct', durable: true }],
  ]);

  /**
   * @type {Map<string, {
   *   name: string,
   *   vhost: string,
   *   durable: boolean,
   *   auto_delete: boolean,
   *   arguments: Record<string, unknown>,
   *   messages: Array<Record<string, unknown>>,
   *   stats: { publish: number, deliverGet: number, ack: number }
   * }>}
   */
  const queues = new Map();

  function defaultQueueArgs(queueName) {
    if (queueName.endsWith('.dlq')) {
      const targetQueue = queueName.slice(0, -4);
      return {
        'x-dead-letter-exchange': 'atelier.dlx.direct',
        'x-retry-policy': '2s -> 10s -> 30s',
        'x-retry-delays-ms': [2000, 10000, 30000],
        'x-max-retries': 3,
        'x-target-queue': targetQueue,
      };
    }
    return {
      'x-dead-letter-exchange': 'atelier.dlx.direct',
      'x-dead-letter-routing-key': `${queueName}.dlq`,
      'x-retry-policy': '2s -> 10s -> 30s',
      'x-retry-delays-ms': [2000, 10000, 30000],
      'x-max-retries': 3,
    };
  }

  function ensureQueue(name, extraArgs = {}) {
    let q = queues.get(name);
    if (!q) {
      q = {
        name,
        vhost: '/',
        durable: true,
        auto_delete: false,
        arguments: { ...defaultQueueArgs(name), ...extraArgs },
        messages: [],
        stats: { publish: 0, deliverGet: 0, ack: 0 },
      };
      queues.set(name, q);
    }
    return q;
  }

  const predeclaredQueues = [
    'order.saga.dlq',
    'payment.webhook.dlq',
    'notify.zns.dlq',
    'tryon.jobs.dlq',
    'order.saga',
    'payment.webhook',
    'notify.zns',
    'tryon.jobs',
  ];
  for (const qName of predeclaredQueues) {
    ensureQueue(qName);
  }

  function serializeQueue(q) {
    return {
      name: q.name,
      vhost: q.vhost,
      durable: q.durable,
      auto_delete: q.auto_delete,
      type: 'classic',
      state: 'running',
      messages: q.messages.length,
      messages_ready: q.messages.length,
      messages_unacknowledged: 0,
      consumers: q.name.endsWith('.dlq') ? 0 : 1,
      arguments: q.arguments,
      message_stats: {
        publish: q.stats.publish,
        deliver_get: q.stats.deliverGet,
        ack: q.stats.ack,
      },
    };
  }

  function checkBasicAuth(req) {
    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : '';
    if (!authHeader) {
      // Allow unauthenticated loopback local internal access cleanly
      return true;
    }
    if (!authHeader.toLowerCase().startsWith('basic ')) {
      return false;
    }
    try {
      const decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      if (sep < 0) return false;
      const user = decoded.slice(0, sep);
      const pass = decoded.slice(sep + 1);
      return user === expectedUser && pass === expectedPassword;
    } catch {
      return false;
    }
  }

  function isDefaultVhostSegment(rawSeg) {
    const decoded = decodeURIComponent(rawSeg || '');
    return decoded === '/' || decoded === 'default';
  }

  const server = http.createServer(async (req, res) => {
    const corsHeaders = {
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Correlation-Id',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const rawPathname = url.pathname;
    const trimmedPathname = rawPathname.length > 1 ? rawPathname.replace(/\/+$/, '') : rawPathname;
    const method = req.method || 'GET';

    // Always allow health/ready probes
    if (
      method === 'GET' &&
      (trimmedPathname === '/health' ||
        trimmedPathname === '/ready' ||
        trimmedPathname === '/api/health/checks/alarms')
    ) {
      return sendJson(res, 200, { status: 'ok', service: 'rabbitmq-mgmt-local-harness' }, corsHeaders);
    }

    if (!checkBasicAuth(req)) {
      return sendJson(
        res,
        401,
        { error: 'not_authorised', reason: 'Login failed' },
        { 'WWW-Authenticate': 'Basic realm="RabbitMQ Management"', ...corsHeaders },
      );
    }

    try {
      // GET /api/overview
      if (method === 'GET' && trimmedPathname === '/api/overview') {
        let totalMessages = 0;
        let totalDlqMessages = 0;
        for (const q of queues.values()) {
          totalMessages += q.messages.length;
          if (q.name.endsWith('.dlq')) {
            totalDlqMessages += q.messages.length;
          }
        }
        return sendJson(
          res,
          200,
          {
            management_version: '3.13.7-local-harness',
            rabbitmq_version: '3.13-local-harness',
            cluster_name: 'atelier-local-rabbitmq',
            node: 'rabbit@127.0.0.1',
            object_totals: {
              channels: 1,
              connections: 1,
              consumers: 4,
              exchanges: exchanges.size,
              queues: queues.size,
            },
            queue_totals: {
              messages: totalMessages,
              messages_ready: totalMessages,
              messages_unacknowledged: 0,
              dlq_messages: totalDlqMessages,
            },
            retry_policy: {
              levels: ['2s', '10s', '30s'],
              dead_letter_exchange: 'atelier.dlx.direct',
            },
          },
          corsHeaders,
        );
      }

      // GET /api/aliveness-test/%2F
      const aliveMatch = /^\/api\/aliveness-test\/([^/]+)$/.exec(trimmedPathname);
      if (method === 'GET' && aliveMatch && isDefaultVhostSegment(aliveMatch[1])) {
        return sendJson(res, 200, { status: 'ok' }, corsHeaders);
      }

      // GET /api/exchanges & /api/exchanges/%2F
      if (method === 'GET' && (trimmedPathname === '/api/exchanges' || /^\/api\/exchanges\/([^/]+)$/.test(trimmedPathname))) {
        return sendJson(res, 200, [...exchanges.values()], corsHeaders);
      }

      // POST /api/exchanges/%2F/:exchange/publish (also supports empty default exchange "//publish")
      const pubMatch = /^\/api\/exchanges\/([^/]+)\/([^/]*)\/publish$/.exec(trimmedPathname);
      if (method === 'POST' && pubMatch && isDefaultVhostSegment(pubMatch[1])) {
        const exchangeName = decodeURIComponent(pubMatch[2] || 'amq.default');
        const rawBody = (await readRequestBodyBuffer(req)).toString('utf8');
        const body = rawBody ? JSON.parse(rawBody) : {};

        const routingKey = String(body.routing_key ?? body.routingKey ?? '').trim();
        if (!routingKey) {
          return sendJson(
            res,
            400,
            { error: 'bad_request', reason: 'routing_key is required' },
            corsHeaders,
          );
        }

        const payload =
          typeof body.payload === 'string' ? body.payload : JSON.stringify(body.payload ?? {});
        const payloadEncoding = String(body.payload_encoding || 'string');
        const rawProps = body.properties && typeof body.properties === 'object' ? body.properties : {};
        const rawHeaders =
          rawProps.headers && typeof rawProps.headers === 'object' ? { ...rawProps.headers } : {};

        const targetQueue = ensureQueue(routingKey);
        const nowSec = Math.floor(Date.now() / 1000);
        const correlationId =
          rawHeaders['x-correlation-id'] ||
          rawProps.correlation_id ||
          (typeof req.headers['x-correlation-id'] === 'string' ? req.headers['x-correlation-id'] : '') ||
          crypto.randomUUID();

        const normalizedHeaders = {
          'x-correlation-id': String(correlationId),
          ...rawHeaders,
        };

        if (targetQueue.name.endsWith('.dlq')) {
          const originQueue = targetQueue.name.slice(0, -4);
          if (normalizedHeaders['x-retry-count'] === undefined) {
            normalizedHeaders['x-retry-count'] = 3;
          }
          if (normalizedHeaders['x-failure-reason'] === undefined) {
            normalizedHeaders['x-failure-reason'] = 'MAX_RETRIES_EXCEEDED_AFTER_2S_10S_30S';
          }
          if (!Array.isArray(normalizedHeaders['x-death'])) {
            normalizedHeaders['x-death'] = [
              {
                count: Number(normalizedHeaders['x-retry-count']) || 3,
                exchange: exchangeName || 'atelier.dlx.direct',
                queue: originQueue,
                reason: 'rejected',
                'routing-keys': [originQueue],
                time: nowSec,
              },
            ];
          }
        }

        const storedMessage = {
          payload,
          payload_encoding: payloadEncoding,
          exchange: exchangeName || 'amq.default',
          routing_key: routingKey,
          redelivered: Boolean(body.redelivered),
          properties: {
            delivery_mode: 2,
            content_type: rawProps.content_type || 'application/json',
            message_id: rawProps.message_id || crypto.randomUUID(),
            timestamp: rawProps.timestamp || nowSec,
            ...rawProps,
            headers: normalizedHeaders,
          },
        };

        targetQueue.messages.push(storedMessage);
        targetQueue.stats.publish += 1;

        return sendJson(res, 200, { routed: true }, corsHeaders);
      }

      // GET /api/queues & GET /api/queues/%2F
      if (method === 'GET' && trimmedPathname === '/api/queues') {
        return sendJson(
          res,
          200,
          [...queues.values()].map((q) => serializeQueue(q)),
          corsHeaders,
        );
      }

      const vhostQueuesMatch = /^\/api\/queues\/([^/]+)$/.exec(trimmedPathname);
      if (method === 'GET' && vhostQueuesMatch && isDefaultVhostSegment(vhostQueuesMatch[1])) {
        return sendJson(
          res,
          200,
          [...queues.values()].map((q) => serializeQueue(q)),
          corsHeaders,
        );
      }

      // POST /api/queues/%2F/:queue/get
      const queueGetMatch = /^\/api\/queues\/([^/]+)\/([^/]+)\/get$/.exec(trimmedPathname);
      if (method === 'POST' && queueGetMatch && isDefaultVhostSegment(queueGetMatch[1])) {
        const queueName = decodeURIComponent(queueGetMatch[2]);
        const q = queues.get(queueName);
        if (!q) {
          return sendJson(
            res,
            404,
            { error: 'Object Not Found', reason: `Queue '${queueName}' not found` },
            corsHeaders,
          );
        }

        const rawBody = (await readRequestBodyBuffer(req)).toString('utf8');
        const body = rawBody ? JSON.parse(rawBody) : {};
        const count = Math.max(1, Math.min(500, Number.parseInt(String(body.count ?? 10), 10) || 10));
        const ackmode = String(
          body.ackmode || (body.requeue === false ? 'ack_requeue_false' : 'ack_requeue_true'),
        ).toLowerCase();
        const removeFromQueue = ackmode === 'ack_requeue_false' || ackmode === 'reject_requeue_false';
        const truncateLen =
          body.truncate !== undefined && Number.isFinite(Number(body.truncate))
            ? Math.max(0, Number(body.truncate))
            : null;

        const slice = removeFromQueue ? q.messages.splice(0, count) : q.messages.slice(0, count);
        q.stats.deliverGet += slice.length;
        if (removeFromQueue) {
          q.stats.ack += slice.length;
        }

        const totalBefore = removeFromQueue ? q.messages.length + slice.length : q.messages.length;
        const result = slice.map((msg, idx) => {
          const payloadStr =
            truncateLen !== null && msg.payload.length > truncateLen
              ? msg.payload.slice(0, truncateLen)
              : msg.payload;
          return {
            payload_bytes: Buffer.byteLength(msg.payload, 'utf8'),
            redelivered: removeFromQueue ? Boolean(msg.redelivered) : true,
            exchange: msg.exchange,
            routing_key: msg.routing_key,
            message_count: Math.max(0, totalBefore - idx - 1),
            properties: msg.properties,
            payload: payloadStr,
            payload_encoding: msg.payload_encoding || 'string',
          };
        });

        return sendJson(res, 200, result, corsHeaders);
      }

      // DELETE /api/queues/%2F/:queue/contents
      const queueContentsMatch = /^\/api\/queues\/([^/]+)\/([^/]+)\/contents$/.exec(trimmedPathname);
      if (method === 'DELETE' && queueContentsMatch && isDefaultVhostSegment(queueContentsMatch[1])) {
        const queueName = decodeURIComponent(queueContentsMatch[2]);
        const q = queues.get(queueName);
        if (!q) {
          return sendJson(
            res,
            404,
            { error: 'Object Not Found', reason: `Queue '${queueName}' not found` },
            corsHeaders,
          );
        }
        q.messages.length = 0;
        res.writeHead(204, corsHeaders);
        res.end();
        return;
      }

      // GET / PUT / DELETE /api/queues/%2F/:queue
      const queueSingleMatch = /^\/api\/queues\/([^/]+)\/([^/]+)$/.exec(trimmedPathname);
      if (queueSingleMatch && isDefaultVhostSegment(queueSingleMatch[1])) {
        const queueName = decodeURIComponent(queueSingleMatch[2]);
        if (method === 'GET') {
          const q = queues.get(queueName);
          if (!q) {
            return sendJson(
              res,
              404,
              { error: 'Object Not Found', reason: `Queue '${queueName}' not found` },
              corsHeaders,
            );
          }
          return sendJson(res, 200, serializeQueue(q), corsHeaders);
        }
        if (method === 'PUT') {
          const existed = queues.has(queueName);
          const rawBody = (await readRequestBodyBuffer(req)).toString('utf8');
          const body = rawBody ? JSON.parse(rawBody) : {};
          const extraArgs = body.arguments && typeof body.arguments === 'object' ? body.arguments : {};
          ensureQueue(queueName, extraArgs);
          res.writeHead(existed ? 204 : 201, corsHeaders);
          res.end();
          return;
        }
        if (method === 'DELETE') {
          queues.delete(queueName);
          res.writeHead(204, corsHeaders);
          res.end();
          return;
        }
      }

      return sendJson(
        res,
        404,
        { error: 'Object Not Found', reason: `Route ${method} ${trimmedPathname} not found` },
        corsHeaders,
      );
    } catch (err) {
      return sendJson(
        res,
        400,
        { error: 'bad_request', reason: err instanceof Error ? err.message : String(err) },
        corsHeaders,
      );
    }
  });

  server.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });

  return {
    server,
    start: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}

// =============================================================================
// Public API: startLocalInfraIfNeeded(envOverrides)
// =============================================================================
export async function startLocalInfraIfNeeded(envOverrides = {}) {
  const fileEnv = loadDotEnv(path.join(ROOT_DIR, '.env'));
  const env = { ...fileEnv, ...process.env, ...envOverrides };

  const redisPort = Number.parseInt(env.REDIS_PORT || '6379', 10);
  const redisPassword = env.REDIS_PASSWORD || '';
  const meiliPort = Number.parseInt(env.MEILISEARCH_PORT || '7700', 10);
  const minioPort = Number.parseInt(env.MINIO_PORT || '9000', 10);
  const smtpPort = Number.parseInt(env.SMTP_PORT || '1025', 10);
  const mailpitHttpPort = Number.parseInt(env.MAILPIT_UI_PORT || '8025', 10);
  const rabbitMgmtPort = Number.parseInt(env.RABBITMQ_MGMT_PORT || '15672', 10);
  const rabbitUser = env.RABBITMQ_DEFAULT_USER || env.RABBITMQ_USER || 'atelier_mq';
  const rabbitPass = env.RABBITMQ_DEFAULT_PASS || env.RABBITMQ_PASSWORD || 'Atelier_Mq2026!';

  const storageRoot = env.LOCAL_MINIO_DIR || path.join(ROOT_DIR, '.local-minio');
  const defaultBuckets = [
    env.MINIO_BUCKET_PUBLIC || 'atelier-public',
    env.MINIO_BUCKET_GARMENTS || 'atelier-garments',
    env.MINIO_BUCKET_PRIVATE_TRYON || 'atelier-private-tryon',
  ];
  const privateBucket = env.MINIO_BUCKET_PRIVATE_TRYON || 'atelier-private-tryon';

  const [redisOpen, meiliOpen, minioOpen, smtpOpen, mailpitHttpOpen, rabbitMgmtOpen] = await Promise.all([
    isPortOpen('127.0.0.1', redisPort),
    isPortOpen('127.0.0.1', meiliPort),
    isPortOpen('127.0.0.1', minioPort),
    isPortOpen('127.0.0.1', smtpPort),
    isPortOpen('127.0.0.1', mailpitHttpPort),
    isPortOpen('127.0.0.1', rabbitMgmtPort),
  ]);

  const stoppers = [];
  const services = {
    redis: { port: redisPort, mode: 'external', started: false },
    meilisearch: { port: meiliPort, mode: 'external', started: false },
    minio: { port: minioPort, mode: 'external', started: false },
    mailpitSmtp: { port: smtpPort, mode: 'external', started: false },
    mailpitHttp: { port: mailpitHttpPort, mode: 'external', started: false },
    rabbitmqMgmt: { port: rabbitMgmtPort, mode: 'external', started: false },
  };

  if (!redisOpen) {
    const redis = createRedisServer(redisPort, redisPassword);
    await redis.start();
    stoppers.push(() => redis.stop());
    services.redis = { port: redisPort, mode: 'local-dev-harness', started: true };
  }

  if (!meiliOpen) {
    const meili = createMeilisearchServer(meiliPort);
    await meili.start();
    stoppers.push(() => meili.stop());
    services.meilisearch = { port: meiliPort, mode: 'local-dev-harness', started: true };
  }

  if (!minioOpen) {
    const minio = createMinioServer(minioPort, storageRoot, defaultBuckets, privateBucket);
    await minio.start();
    stoppers.push(() => minio.stop());
    services.minio = { port: minioPort, mode: 'local-dev-harness', started: true };
  }

  if (!smtpOpen || !mailpitHttpOpen) {
    const mailpit = createMailpitServers(smtpPort, mailpitHttpPort);
    if (!smtpOpen) {
      await mailpit.startSmtp();
      stoppers.push(() => mailpit.stopSmtp());
      services.mailpitSmtp = { port: smtpPort, mode: 'local-dev-harness', started: true };
    }
    if (!mailpitHttpOpen) {
      await mailpit.startHttp();
      stoppers.push(() => mailpit.stopHttp());
      services.mailpitHttp = { port: mailpitHttpPort, mode: 'local-dev-harness', started: true };
    }
  }

  if (!rabbitMgmtOpen) {
    const rabbitMgmt = createRabbitMqMgmtServer(rabbitMgmtPort, rabbitUser, rabbitPass);
    await rabbitMgmt.start();
    stoppers.push(() => rabbitMgmt.stop());
    services.rabbitmqMgmt = { port: rabbitMgmtPort, mode: 'local-dev-harness', started: true };
  }

  const anyStarted = Object.values(services).some((s) => s.started);
  const infraMode = anyStarted ? 'LOCAL_DEV_HARNESS' : 'DOCKER_OR_EXTERNAL';

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    await Promise.allSettled(stoppers.map((fn) => fn()));
  }

  return {
    infraMode,
    services,
    stop,
  };
}

// =============================================================================
// Direct CLI Mode (`node scripts/local-infra-dev.mjs`)
// =============================================================================
const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectExecution) {
  startLocalInfraIfNeeded()
    .then((handle) => {
      console.log('========================================================================');
      console.log(` fashion-atelier-ai-platform — INFRA_MODE=${handle.infraMode}`);
      console.log('------------------------------------------------------------------------');
      for (const [name, info] of Object.entries(handle.services)) {
        console.log(`  ${name.padEnd(14)} 127.0.0.1:${String(info.port).padEnd(6)} [${info.mode}]`);
      }
      console.log('========================================================================');
      console.log('Press Ctrl+C to stop local dev infrastructure servers.');

      const shutdown = async () => {
        console.log('\nStopping local dev infrastructure harness...');
        await handle.stop();
        process.exit(0);
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.error('[FATAL] Failed to start local-infra-dev:', err);
      process.exit(1);
    });
}
