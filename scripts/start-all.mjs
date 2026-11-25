#!/usr/bin/env node
/**
 * Full 14-Process Stack Launcher (`pnpm start:all`)
 * fashion-atelier-ai-platform (v3.0)
 *
 * 1. Cleans stale Node/Python processes occupying ports 3000..3002 & 4000..4010.
 * 2. Ensures infrastructure is online (starts `scripts/local-infra-dev.mjs` if Docker offline).
 * 3. Launches ALL 14 built apps/services with color-coded log prefixes:
 *      - 8 DDD Microservices (:4001..:4008)
 *      - Python FastAPI AI Virtual Try-On (:4009)
 *      - Admin/Customer 8-Layer MCP Copilot (:4010)
 *      - Fashion BFF + Socket.io (:4000)
 *      - 3 Next.js 15 Portals (storefront:3000, admin-portal:3001, partner-portal:3002)
 * 4. Polls `/ready` across all 11 backend services + HTTP 200 on all 3 portals, prints Ready Banner,
 *    and traps SIGINT/SIGTERM for zero-stray-port teardown.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalInfraIfNeeded } from './local-infra-dev.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const PROJECT_DATA_DIR = path.join(ROOT_DIR, '.project-data');
const PROJECT_STORAGE_DIRS = {
  tmp: path.join(PROJECT_DATA_DIR, 'tmp'),
  uvCache: path.join(PROJECT_DATA_DIR, 'uv-cache'),
  u2netHome: path.join(PROJECT_DATA_DIR, 'ai-models', 'u2net'),
  u2netModels: path.join(PROJECT_DATA_DIR, 'ai-models', 'u2net', 'models'),
  turboCache: path.join(PROJECT_DATA_DIR, 'turbo-cache'),
  pnpmStore: path.join(PROJECT_DATA_DIR, 'pnpm', 'store'),
  pnpmCache: path.join(PROJECT_DATA_DIR, 'pnpm', 'cache'),
};

function configureProjectLocalStorageEnv() {
  for (const dir of Object.values(PROJECT_STORAGE_DIRS)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const overrides = {
    TEMP: PROJECT_STORAGE_DIRS.tmp,
    TMP: PROJECT_STORAGE_DIRS.tmp,
    TMPDIR: PROJECT_STORAGE_DIRS.tmp,
    UV_CACHE_DIR: PROJECT_STORAGE_DIRS.uvCache,
    U2NET_HOME: PROJECT_STORAGE_DIRS.u2netHome,
    REMBG_HOME: PROJECT_STORAGE_DIRS.u2netHome,
    TURBO_CACHE_DIR: PROJECT_STORAGE_DIRS.turboCache,
  };
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
  return overrides;
}

const COLORS = [
  '\x1b[36m', '\x1b[33m', '\x1b[32m', '\x1b[35m', '\x1b[34m', '\x1b[93m',
  '\x1b[96m', '\x1b[92m', '\x1b[95m', '\x1b[94m', '\x1b[31m', '\x1b[91m', '\x1b[90m', '\x1b[37m',
];
const RESET = '\x1b[0m';

function loadDotEnv(filePath) {
  const vars = {};
  if (!fs.existsSync(filePath)) return vars;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    vars[k] = v;
  }
  return vars;
}

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (IS_WIN) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // ignore
  }
}

function cleanStalePorts(ports) {
  if (IS_WIN) {
    const ps = `$ports=@(${ports.join(',')}); Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort } | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { if ($_ -and $_ -ne ${process.pid}) { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }`;
    spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore', windowsHide: true });
  } else {
    for (const p of ports) {
      spawnSync('sh', ['-c', `lsof -ti tcp:${p} | xargs -r kill -9`], { stdio: 'ignore' });
    }
  }
}

function resolvePythonBin() {
  const candidates = IS_WIN
    ? [path.join(ROOT_DIR, 'services', 'ai-tryon', '.venv', 'Scripts', 'python.exe'), 'python']
    : [path.join(ROOT_DIR, 'services', 'ai-tryon', '.venv', 'bin', 'python'), 'python3'];
  for (const c of candidates) {
    if (!c.includes(path.sep) || fs.existsSync(c)) return c;
  }
  return candidates[0];
}

function probeHttp(urlStr, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const req = http.get(
      { hostname: u.hostname, port: u.port || 80, path: `${u.pathname}${u.search}`, timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(0);
    });
    req.on('error', () => resolve(0));
  });
}

async function waitForReady(name, urlStr, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await probeHttp(urlStr, 2500);
    if (status >= 200 && status < 400) return status;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${name} (${urlStr})`);
}

async function main() {
  const projectStorageEnv = configureProjectLocalStorageEnv();
  const envVars = {
    ...loadDotEnv(path.join(ROOT_DIR, '.env')),
    ...process.env,
    ...projectStorageEnv,
    NODE_ENV: 'development',
  };
  const managedPorts = [3000, 3001, 3002, 4000, 4001, 4002, 4003, 4004, 4005, 4006, 4007, 4008, 4009, 4010];

  console.log('[START-ALL] Cleaning any stale processes on ports 3000..3002 and 4000..4010 ...');
  cleanStalePorts(managedPorts);

  const infraHandle = await startLocalInfraIfNeeded(envVars);
  console.log(`[START-ALL] Infrastructure online (INFRA_MODE=${infraHandle.infraMode})`);

  const pyBin = resolvePythonBin();
  const nextBin = IS_WIN ? 'cmd.exe' : 'pnpm';

  const specs = [
    { name: 'auth:4001', cmd: process.execPath, args: ['services/auth-customer/dist/main.js'], readyUrl: 'http://127.0.0.1:4001/ready', env: { AUTH_SERVICE_PORT: '4001' } },
    { name: 'catalog:4002', cmd: process.execPath, args: ['services/catalog-lookbook/dist/main.js'], readyUrl: 'http://127.0.0.1:4002/ready', env: { CATALOG_SERVICE_PORT: '4002' } },
    { name: 'media:4003', cmd: process.execPath, args: ['services/media-pipeline/dist/main.js'], readyUrl: 'http://127.0.0.1:4003/ready', env: { MEDIA_SERVICE_PORT: '4003' } },
    { name: 'inventory:4004', cmd: process.execPath, args: ['services/inventory/dist/main.js'], readyUrl: 'http://127.0.0.1:4004/ready', env: { INVENTORY_SERVICE_PORT: '4004' } },
    { name: 'cart:4005', cmd: process.execPath, args: ['services/cart-outfit/dist/main.js'], readyUrl: 'http://127.0.0.1:4005/ready', env: { CART_SERVICE_PORT: '4005' } },
    { name: 'order-rma:4006', cmd: process.execPath, args: ['services/order-rma/dist/main.js'], readyUrl: 'http://127.0.0.1:4006/ready', env: { ORDER_SERVICE_PORT: '4006' } },
    { name: 'payment:4007', cmd: process.execPath, args: ['services/payment-promo/dist/main.js'], readyUrl: 'http://127.0.0.1:4007/ready', env: { PAYMENT_SERVICE_PORT: '4007' } },
    { name: 'notify:4008', cmd: process.execPath, args: ['services/notify-review/dist/main.js'], readyUrl: 'http://127.0.0.1:4008/ready', env: { NOTIFY_SERVICE_PORT: '4008' } },
    {
      name: 'ai-tryon:4009',
      cmd: pyBin,
      args: ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '4009'],
      cwd: path.join(ROOT_DIR, 'services', 'ai-tryon'),
      readyUrl: 'http://127.0.0.1:4009/ready',
      env: { AI_TRYON_PORT: '4009' },
    },
    { name: 'mcp:4010', cmd: process.execPath, args: ['apps/mcp-copilot/dist/main.js'], readyUrl: 'http://127.0.0.1:4010/ready', env: { MCP_COPILOT_PORT: '4010' } },
    { name: 'bff:4000', cmd: process.execPath, args: ['apps/bff/dist/main.js'], readyUrl: 'http://127.0.0.1:4000/ready', env: { BFF_PORT: '4000' } },
    {
      name: 'storefront:3000',
      cmd: nextBin,
      args: IS_WIN ? ['/d', '/c', 'pnpm', '--filter', '@atelier/storefront', 'start'] : ['--filter', '@atelier/storefront', 'start'],
      readyUrl: 'http://127.0.0.1:3000/',
      env: { PORT: '3000', NEXT_PUBLIC_BFF_URL: 'http://localhost:4000' },
    },
    {
      name: 'admin:3001',
      cmd: nextBin,
      args: IS_WIN ? ['/d', '/c', 'pnpm', '--filter', '@atelier/admin-portal', 'start'] : ['--filter', '@atelier/admin-portal', 'start'],
      readyUrl: 'http://127.0.0.1:3001/',
      env: { PORT: '3001', NEXT_PUBLIC_BFF_URL: 'http://localhost:4000' },
    },
    {
      name: 'partner:3002',
      cmd: nextBin,
      args: IS_WIN ? ['/d', '/c', 'pnpm', '--filter', '@atelier/partner-portal', 'start'] : ['--filter', '@atelier/partner-portal', 'start'],
      readyUrl: 'http://127.0.0.1:3002/',
      env: { PORT: '3002', NEXT_PUBLIC_BFF_URL: 'http://localhost:4000' },
    },
  ];

  const children = [];
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[START-ALL] Received ${signal} — stopping all 14 processes and local infra...`);
    for (const c of children) killTree(c);
    await infraHandle.stop();
    console.log('[START-ALL] Clean shutdown complete.');
    process.exit(0);
  }

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  specs.forEach((spec, idx) => {
    const color = COLORS[idx % COLORS.length];
    const tag = `${color}[${spec.name.padEnd(15)}]${RESET}`;
    const child = spawn(spec.cmd, spec.args, {
      cwd: spec.cwd || ROOT_DIR,
      env: { ...envVars, ...(spec.env || {}) },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    children.push(child);

    const pipeLines = (stream, isErr) => {
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const out = isErr ? process.stderr : process.stdout;
          out.write(`${tag} ${line}\n`);
        }
      });
    };
    pipeLines(child.stdout, false);
    pipeLines(child.stderr, true);
  });

  try {
    await Promise.all(specs.map((s) => waitForReady(s.name, s.readyUrl, 60_000)));
  } catch (err) {
    console.error('[START-ALL] Boot failed:', err instanceof Error ? err.message : String(err));
    await shutdown('BOOT_FAILURE');
    return;
  }

  console.log('\n========================================================================');
  console.log(` ALL 14 SERVICES & PORTALS ONLINE! (INFRA_MODE=${infraHandle.infraMode})`);
  console.log('------------------------------------------------------------------------');
  console.log('  Storefront Editorial : http://localhost:3000');
  console.log('  Admin Backoffice     : http://localhost:3001  (lebao01121@gmail.com / Atelier@2026!)');
  console.log('  Partner B2B Portal   : http://localhost:3002  (supplier-a@atelier.local / Atelier@2026!)');
  console.log('  Fashion BFF + WS     : http://localhost:4000');
  console.log('  Mailpit 2FA Inbox    : http://localhost:8025');
  console.log('  RabbitMQ DLQ Mgmt    : http://localhost:15672 (atelier_mq / Atelier_Mq2026!)');
  console.log('========================================================================');
  console.log('Press Ctrl+C to shut down the entire platform cleanly.\n');
}

main().catch((err) => {
  console.error('[FATAL] start-all:', err);
  process.exit(1);
});
