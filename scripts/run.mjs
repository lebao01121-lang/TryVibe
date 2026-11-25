#!/usr/bin/env node
/**
 * ============================================================================
 * fashion-atelier-ai-platform (v3.1) — Unified One-Command Launcher (`./run`)
 * ============================================================================
 * Zero external npm dependencies (Node.js built-ins `node:*` ONLY) so `./run`
 * works cleanly even BEFORE `pnpm install` on Git Bash, WSL, Linux, macOS,
 * Windows PowerShell (`./run`), and Windows CMD (`run` / `.\run`).
 *
 * Flags:
 *   ./run                 Full 6-step boot + Local Ollama AI + live color logs
 *   ./run --seed          Force re-run `pnpm db:seed` before launch
 *   ./run --reset         Reset volumes / local DBs, rebuild, migrate, seed, run
 *   ./run --status        Print live status table for infra + Ollama + ports 3000..4010
 *   ./run --down          Free ports 3000..4010 and run `docker compose down`
 *   ./run --verify        Ensure infra ready, run `pnpm eval:ai` + `pnpm verify:all`
 *   ./run --smoke-test    Full Step 1..6 boot, verify 14/14 200 OK, clean exit 0
 *   ./run --docker        Require Docker Desktop strictly (exit 1 if unavailable)
 *   ./run --ollama-docker Start optional `atelier-ollama` Docker profile (`--profile ollama-docker`)
 *   ./run --local         Explicitly use Local Dev Harness (no Docker required)
 *   ./run --dev           Run Next.js & services in hot-reload `dev` mode
 *   ./run --help          Print detailed usage instructions
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const COMPOSE_FILE = path.join(ROOT_DIR, 'infra', 'docker-compose.yml');
const SEED_MARKER = path.join(ROOT_DIR, '.secrets', '.seeded-v3');
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

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
};

const DOCKER_PERSISTENT_CONTAINERS = [
  'atelier-postgres',
  'atelier-redis',
  'atelier-meilisearch',
  'atelier-rabbitmq',
  'atelier-minio',
  'atelier-mailpit',
  'atelier-nginx',
];
const DOCKER_INIT_CONTAINER = 'atelier-minio-mc';

const MANAGED_APP_PORTS = [
  3000, 3001, 3002,
  4000, 4001, 4002, 4003, 4004, 4005, 4006, 4007, 4008, 4009, 4010,
];

const INFRA_PORTS = [
  { name: 'PostgreSQL 16 (pgvector)', port: 5432, dockerOnly: true },
  { name: 'Redis 7', port: 6379, dockerOnly: false },
  { name: 'Meilisearch', port: 7700, dockerOnly: false },
  { name: 'RabbitMQ AMQP', port: 5672, dockerOnly: true },
  { name: 'RabbitMQ Management/DLQ', port: 15672, dockerOnly: false },
  { name: 'MinIO S3 API', port: 9000, dockerOnly: false },
  { name: 'MinIO Console', port: 9001, dockerOnly: true },
  { name: 'Mailpit SMTP', port: 1025, dockerOnly: false },
  { name: 'Mailpit Webmail (2FA)', port: 8025, dockerOnly: false },
  { name: 'Nginx HTTP / HTTPS', port: 80, dockerOnly: true },
];

// ============================================================================
// Argument Parsing & Help
// ============================================================================
function parseArgs(argv) {
  const flags = new Set(argv.map((a) => a.trim()).filter(Boolean));
  return {
    help: flags.has('--help') || flags.has('-h'),
    seed: flags.has('--seed'),
    reset: flags.has('--reset'),
    status: flags.has('--status'),
    down: flags.has('--down'),
    verify: flags.has('--verify'),
    smokeTest: flags.has('--smoke-test'),
    strictDocker: flags.has('--docker') || flags.has('--strict-docker'),
    ollamaDocker: flags.has('--ollama-docker'),
    forceLocal: flags.has('--local'),
    devMode: flags.has('--dev'),
  };
}

function printHelp() {
  console.log(`
${ANSI.bold}${ANSI.brightYellow}========================================================================${ANSI.reset}
${ANSI.bold}  Tầm Xuân · fashion-atelier-ai-platform (v3.1) — Trình khởi chạy ./run${ANSI.reset}
${ANSI.bold}${ANSI.brightYellow}========================================================================${ANSI.reset}

${ANSI.bold}Cách dùng:${ANSI.reset}
  Git Bash / WSL / Linux / macOS :  ${ANSI.cyan}./run [cờ]${ANSI.reset}
  Windows PowerShell             :  ${ANSI.cyan}./run [cờ]${ANSI.reset}  hoặc  ${ANSI.cyan}.\\run.ps1 [cờ]${ANSI.reset}
  Windows CMD                    :  ${ANSI.cyan}run [cờ]${ANSI.reset}    hoặc  ${ANSI.cyan}.\\run.cmd [cờ]${ANSI.reset}

${ANSI.bold}Các cờ hỗ trợ:${ANSI.reset}
  ${ANSI.green}(không truyền cờ)${ANSI.reset}   Bật trọn gói Hạ tầng + Local Ollama AI + Build packages + Migrate
                      + Smart Auto-Seed + Toàn bộ 14 ứng dụng/dịch vụ (log màu trực tiếp).
  ${ANSI.green}--seed${ANSI.reset}              Ép nạp lại dữ liệu mẫu (pnpm db:seed) trước khi mở hệ thống.
  ${ANSI.green}--reset${ANSI.reset}             Xóa sạch volume/DB cục bộ cũ, dựng lại 10 DB cô lập từ đầu,
                      migrate, seed lại và khởi chạy.
  ${ANSI.green}--status${ANSI.reset}            In bảng kiểm tra nhanh trạng thái Docker/Hạ tầng, Ollama & cổng 3000..4010.
  ${ANSI.green}--down${ANSI.reset}              Giải phóng sạch cổng 3000..4010 và tắt cụm Docker (compose down).
  ${ANSI.green}--verify${ANSI.reset}            Đảm bảo hạ tầng sẵn sàng, chạy ${ANSI.cyan}pnpm eval:ai${ANSI.reset} + ${ANSI.cyan}pnpm verify:all${ANSI.reset}.
  ${ANSI.green}--smoke-test${ANSI.reset}        Chạy trọn Bước 1 -> Bước 6, xác minh 14/14 cổng trả ${ANSI.green}200 OK${ANSI.reset},
                      in bảng xanh rồi tự động tắt gọn tiến trình (exit 0).
  ${ANSI.green}--docker${ANSI.reset}            Ép bắt buộc Docker Desktop phải đang bật (thoát mã 1 nếu không có).
  ${ANSI.green}--ollama-docker${ANSI.reset}     Chạy thêm container ${ANSI.cyan}atelier-ollama${ANSI.reset} qua ${ANSI.cyan}--profile ollama-docker${ANSI.reset}.
  ${ANSI.green}--local${ANSI.reset}             Chạy chủ động bằng Local Dev Harness (không cần Docker Desktop).
  ${ANSI.green}--dev${ANSI.reset}               Khởi chạy ở chế độ hot-reload dev (tsx watch / next dev).
  ${ANSI.green}--help, -h${ANSI.reset}          Hiển thị hướng dẫn chi tiết này.

${ANSI.bold}Bản đồ 14 Cổng Ứng Dụng:${ANSI.reset}
  3000  Storefront (Khách hàng · 3D Rack · Outfit Studio · AI Try-On)
  3001  Admin Portal (Quản trị nội bộ · MCP Copilot · AI Ops & *.dlq)
  3002  Partner Portal (Nhà cung cấp B2B khóa cứng supplier_id)
  4000  Fashion BFF, API Gateway & Socket.io /realtime Hub
  4001  auth-customer       (auth_db)     | 4006  order-rma       (order_db)
  4002  catalog-lookbook    (catalog_db)  | 4007  payment-promo   (payment_db)
  4003  media-pipeline      (media_db)    | 4008  notify-review   (notify_db)
  4004  inventory           (inventory_db)| 4009  ai-tryon Python (tryon_db)
  4005  cart-outfit         (cart_db)     | 4010  mcp-copilot     (rag_vector_db)
`);
}

// ============================================================================
// Low-level Shell, Env, Port & HTTP Helpers (Zero external deps)
// ============================================================================
function logStep(stepNo, title) {
  console.log(`\n${ANSI.bold}${ANSI.cyan}[BƯỚC ${stepNo}/6]${ANSI.reset} ${ANSI.bold}${title}${ANSI.reset}`);
}

function logOk(msg) {
  console.log(`  ${ANSI.green}[OK]${ANSI.reset}   ${msg}`);
}

function logInfo(msg) {
  console.log(`  ${ANSI.cyan}[INFO]${ANSI.reset} ${msg}`);
}

function logWarn(msg) {
  console.log(`  ${ANSI.yellow}[WARN]${ANSI.reset} ${msg}`);
}

function logErr(msg) {
  console.error(`  ${ANSI.red}[ERR]${ANSI.reset}  ${msg}`);
}

function loadDotEnv(filePath) {
  const vars = {};
  if (!fs.existsSync(filePath)) return vars;
  for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }
  return vars;
}

function probeCommand(cmd, args = ['--version'], timeout = 5000) {
  try {
    const isWinCmd = IS_WIN && (cmd === 'pnpm' || cmd === 'npm');
    const execCmd = isWinCmd ? 'cmd.exe' : cmd;
    const execArgs = isWinCmd ? ['/d', '/c', cmd, ...args] : args;
    const res = spawnSync(execCmd, execArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      windowsHide: true,
    });
    if (res.error) return { found: false, ok: false, output: res.error.message };
    return {
      found: true,
      ok: res.status === 0,
      status: res.status,
      output: (res.stdout || res.stderr || '').trim(),
    };
  } catch (err) {
    return { found: false, ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

function resolveUvBinary() {
  const direct = probeCommand('uv', ['--version']);
  if (direct.ok) return { bin: 'uv', version: direct.output };

  if (IS_WIN && process.env.APPDATA) {
    const pyRoot = path.join(process.env.APPDATA, 'Python');
    if (fs.existsSync(pyRoot)) {
      for (const entry of fs.readdirSync(pyRoot)) {
        const candidate = path.join(pyRoot, entry, 'Scripts', 'uv.exe');
        if (fs.existsSync(candidate)) {
          const check = probeCommand(candidate, ['--version']);
          if (check.ok) return { bin: candidate, version: check.output };
        }
      }
    }
  }
  return null;
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

function runForeground(cmd, args, opts = {}) {
  const { cwd = ROOT_DIR, env = process.env, silent = false } = opts;
  return new Promise((resolve) => {
    const isWinCmd = IS_WIN && (cmd === 'pnpm' || cmd === 'npm');
    const execCmd = isWinCmd ? 'cmd.exe' : cmd;
    const execArgs = isWinCmd ? ['/d', '/c', cmd, ...args] : args;

    const child = spawn(execCmd, execArgs, {
      cwd,
      env,
      shell: false,
      stdio: silent ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
    });
    let out = '';
    if (silent && child.stdout) child.stdout.on('data', (d) => (out += d.toString('utf8')));
    if (silent && child.stderr) child.stderr.on('data', (d) => (out += d.toString('utf8')));
    child.on('error', (err) => resolve({ ok: false, code: -1, output: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code: code ?? -1, output: out.trim() }));
  });
}

function killPidTree(pid) {
  if (!pid || pid === process.pid) return;
  try {
    if (IS_WIN) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        process.kill(pid, 'SIGTERM');
      }
    }
  } catch {
    // ignore already-exited pid
  }
}

function findPidsListeningOnPorts(ports) {
  const pidSet = new Set();
  const portSet = new Set(ports.map(Number));

  if (IS_WIN) {
    // IMPORTANT: omit `-p TCP` so Windows `netstat -ano` returns BOTH IPv4 (0.0.0.0) AND IPv6 ([::]) listeners!
    const res = spawnSync('netstat', ['-ano'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    for (const line of (res.stdout || '').split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || !parts[0].toUpperCase().startsWith('TCP')) continue;
      const localAddr = parts[1];
      const pid = Number(parts[4]);
      const colonIdx = localAddr.lastIndexOf(':');
      if (colonIdx === -1) continue;
      const port = Number(localAddr.slice(colonIdx + 1));
      if (portSet.has(port) && Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
        pidSet.add(pid);
      }
    }
  } else {
    for (const p of ports) {
      const res = spawnSync('lsof', ['-ti', `tcp:${p}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const tok of (res.stdout || '').split(/\s+/)) {
        const pid = Number(tok);
        if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) pidSet.add(pid);
      }
    }
  }
  return [...pidSet];
}

function freePorts(ports) {
  const pids = findPidsListeningOnPorts(ports);
  for (const pid of pids) {
    killPidTree(pid);
  }
  return pids.length;
}

function cleanStalePgliteLocks() {
  const localPgDir = path.join(ROOT_DIR, '.local-pgdata');
  if (!fs.existsSync(localPgDir)) return 0;
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(localPgDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pidFile = path.join(localPgDir, entry.name, 'postmaster.pid');
      if (fs.existsSync(pidFile)) {
        try {
          fs.rmSync(pidFile, { force: true });
          removed += 1;
        } catch {
          // ignore locked file
        }
      }
    }
  } catch {
    // ignore
  }
  return removed;
}

function isTcpOpen(port, host = '127.0.0.1', timeoutMs = 600) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      sock.removeAllListeners();
      sock.destroy();
      resolve(open);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

function probeHttp(urlStr, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const u = new URL(urlStr);
    const req = http.get(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: `${u.pathname}${u.search}`,
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve({
          status: res.statusCode ?? 0,
          latencyMs: Number((performance.now() - t0).toFixed(1)),
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, latencyMs: timeoutMs });
    });
    req.on('error', () => resolve({ status: 0, latencyMs: 0 }));
  });
}

async function waitForHttp200(label, urlStr, timeoutMs = 65_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await probeHttp(urlStr, 2500);
    if (res.status === 200) {
      return res;
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  const last = await probeHttp(urlStr, 2000);
  throw new Error(`Hết thời gian chờ ${label} (${urlStr}) — HTTP gần nhất: ${last.status}`);
}

// ============================================================================
// Docker Inspect & Healthy Poller
// ============================================================================
function inspectDockerStatus() {
  const cli = probeCommand('docker', ['--version'], 4000);
  if (!cli.found || !cli.ok) {
    return { installed: false, running: false, version: null };
  }
  const daemon = probeCommand('docker', ['info', '--format', '{{.ServerVersion}}'], 6000);
  return {
    installed: true,
    running: daemon.ok,
    version: daemon.ok ? daemon.output : null,
    cliVersion: cli.output,
  };
}

function inspectContainer(name) {
  const res = spawnSync(
    'docker',
    ['inspect', '--format', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.ExitCode}}', name],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 4000 },
  );
  if (res.status !== 0) return { exists: false, status: 'missing', health: 'none', exitCode: -1 };
  const [status = 'unknown', health = 'none', exitCodeStr = '0'] = (res.stdout || '').trim().split('|');
  return { exists: true, status, health, exitCode: Number(exitCodeStr) };
}

async function waitForDockerHealthy(timeoutMs = 90_000, includeOllamaDocker = false) {
  const deadline = Date.now() + timeoutMs;
  let lastSummary = '';
  const targetContainers = includeOllamaDocker
    ? [...DOCKER_PERSISTENT_CONTAINERS, 'atelier-ollama']
    : DOCKER_PERSISTENT_CONTAINERS;

  while (Date.now() < deadline) {
    let allReady = true;
    const parts = [];

    for (const name of targetContainers) {
      const st = inspectContainer(name);
      const ok = st.status === 'running' && (st.health === 'healthy' || st.health === 'none');
      if (!ok) allReady = false;
      parts.push(`${name.replace('atelier-', '')}:${st.health !== 'none' ? st.health : st.status}`);
    }

    const mc = inspectContainer(DOCKER_INIT_CONTAINER);
    const mcOk = mc.exists && mc.status === 'exited' && mc.exitCode === 0;
    if (!mcOk) allReady = false;
    parts.push(`minio-mc:${mc.status}(${mc.exitCode})`);

    const summary = parts.join(' | ');
    if (summary !== lastSummary) {
      logInfo(`Docker health: ${summary}`);
      lastSummary = summary;
    }
    if (allReady) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Hạ tầng Docker chưa đạt healthy sau ${timeoutMs / 1000}s: ${lastSummary}`);
}

// ============================================================================
// Local Ollama AI Engine Detection, Smart RAM Auto-Selection & Auto-Pull
// ============================================================================
function resolveOllamaBinary() {
  const direct = probeCommand('ollama', ['--version'], 3500);
  if (direct.ok) return { bin: 'ollama', version: direct.output };

  if (IS_WIN && process.env.LOCALAPPDATA) {
    const winCandidate = path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe');
    if (fs.existsSync(winCandidate)) {
      const check = probeCommand(winCandidate, ['--version'], 3500);
      if (check.ok) return { bin: winCandidate, version: check.output };
    }
  }
  return null;
}

function normalizeOllamaModel(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/:latest$/, '');
}

function isOllamaModelInstalled(installedNames, requiredModel) {
  const reqRaw = String(requiredModel || '').trim().toLowerCase();
  const reqNorm = normalizeOllamaModel(requiredModel);
  if (!reqRaw) return false;
  return installedNames.some((m) => {
    const mRaw = String(m || '').trim().toLowerCase();
    return mRaw === reqRaw || normalizeOllamaModel(mRaw) === reqNorm;
  });
}

async function probeOllamaTags(baseUrl, timeoutMs = 2000) {
  const cleanUrl = String(baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const t0 = performance.now();
  try {
    const res = await fetch(`${cleanUrl}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Number((performance.now() - t0).toFixed(1));
    if (!res.ok) {
      return { reachable: false, status: res.status, latencyMs, models: [] };
    }
    const json = await res.json();
    const models = Array.isArray(json?.models)
      ? json.models.map((m) => String(m?.name || m?.model || '').trim()).filter(Boolean)
      : [];
    return { reachable: true, status: res.status, latencyMs, models };
  } catch {
    return { reachable: false, status: 0, latencyMs: Number((performance.now() - t0).toFixed(1)), models: [] };
  }
}

async function ensureOllamaReady(envVars, flags, infraMode) {
  const baseUrl = String(envVars.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const configuredMain = String(envVars.OLLAMA_MAIN_MODEL || 'qwen2.5:7b').trim();
  const fastModel = String(envVars.OLLAMA_FAST_MODEL || 'qwen2.5:3b').trim();
  const embedModel = String(envVars.OLLAMA_EMBED_MODEL || 'nomic-embed-text').trim();
  const embedDim = Number.parseInt(String(envVars.OLLAMA_EMBED_DIM || '768'), 10) || 768;
  const totalRamGb = Number((os.totalmem() / 1024 ** 3).toFixed(2));
  const freeRamGb = Number((os.freemem() / 1024 ** 3).toFixed(2));

  let spawnedOllamaChild = null;
  const ollamaCli = resolveOllamaBinary();
  let probe = await probeOllamaTags(baseUrl, 2000);

  if (!probe.reachable) {
    if (flags.ollamaDocker && infraMode === 'DOCKER_COMPOSE') {
      logInfo(`Đang chờ container atelier-ollama sẵn sàng tại ${baseUrl}/api/tags...`);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !probe.reachable) {
        await new Promise((r) => setTimeout(r, 500));
        probe = await probeOllamaTags(baseUrl, 2000);
      }
    } else if (ollamaCli) {
      logInfo(`Ollama chưa chạy tại ${baseUrl} -> tự động khởi chạy nền \`ollama serve\`...`);
      const child = spawn(ollamaCli.bin, ['serve'], {
        cwd: ROOT_DIR,
        env: envVars,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      spawnedOllamaChild = child;

      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        probe = await probeOllamaTags(baseUrl, 2000);
        if (probe.reachable) break;
      }
    }
  }

  if (!probe.reachable) {
    logWarn('Ollama chưa cài trên máy (hoặc daemon không phản hồi) -> MCP Copilot sẽ tự dùng RuleBasedMcpOrchestrator dự phòng.');
    return {
      reachable: false,
      baseUrl,
      activeMainModel: configuredMain,
      activeEmbedModel: embedModel,
      embedDim,
      installedModels: [],
      latencyMs: probe.latencyMs,
      totalRamGb,
      freeRamGb,
      spawnedChild: spawnedOllamaChild,
    };
  }

  let installedModels = probe.models;
  let activeMainModel = configuredMain;

  if (
    normalizeOllamaModel(configuredMain) === 'qwen2.5:7b' &&
    !isOllamaModelInstalled(installedModels, 'qwen2.5:7b') &&
    (totalRamGb <= 16 || freeRamGb < 6)
  ) {
    logWarn(
      `Máy có tổng RAM ${totalRamGb} GB (khả dụng ${freeRamGb} GB) -> tự động chọn ${fastModel} thay cho ${configuredMain} để tối ưu tốc độ và tránh tràn RAM!`,
    );
    activeMainModel = fastModel;
    envVars.OLLAMA_MAIN_MODEL = activeMainModel;
  }

  // Auto-pull any missing required model (main or embedding) when ollama CLI is available
  const requiredModels = [...new Set([activeMainModel, embedModel])];
  for (const model of requiredModels) {
    if (!isOllamaModelInstalled(installedModels, model)) {
      if (ollamaCli) {
        logInfo(`Chưa thấy model "${model}" trong Ollama -> đang tự động tải (\`ollama pull ${model}\`)...`);
        const pullRes = await runForeground(ollamaCli.bin, ['pull', model], { env: envVars });
        if (!pullRes.ok) {
          logWarn(`Không thể tải model "${model}" (exit ${pullRes.code}) — hệ thống sẽ fallback an toàn nếu cần.`);
        } else {
          logOk(`Đã tải xong model "${model}".`);
        }
      } else {
        logWarn(`Model "${model}" chưa có trên Ollama (${baseUrl}) và máy không có CLI \`ollama\` để auto-pull.`);
      }
    }
  }

  // Refresh installed models list after any pull
  const refreshed = await probeOllamaTags(baseUrl, 2000);
  if (refreshed.reachable) {
    installedModels = refreshed.models;
  }

  logOk(
    `Ollama Engine ONLINE tại ${baseUrl} (${probe.latencyMs}ms · RAM ${totalRamGb} GB) — Main: ${activeMainModel} | Embed: ${embedModel} (${embedDim}-dim) | ${installedModels.length} model(s) sẵn sàng.`,
  );

  return {
    reachable: true,
    baseUrl,
    activeMainModel,
    activeEmbedModel: embedModel,
    embedDim,
    installedModels,
    latencyMs: probe.latencyMs,
    totalRamGb,
    freeRamGb,
    spawnedChild: spawnedOllamaChild,
  };
}

function printDockerRequiredGuide(installed) {
  console.error(`
${ANSI.bold}${ANSI.red}========================================================================${ANSI.reset}
${ANSI.bold}${ANSI.red}  KHÔNG THỂ KẾT NỐI DOCKER DESKTOP / DOCKER DAEMON${ANSI.reset}
${ANSI.bold}${ANSI.red}========================================================================${ANSI.reset}`);
  if (installed) {
    console.error(`  • Đã tìm thấy lệnh ${ANSI.cyan}docker${ANSI.reset}, nhưng ${ANSI.yellow}Docker Desktop hiện chưa được bật${ANSI.reset}.`);
    console.error(`  • Cách 1 (Khuyến nghị Full Docker): Mở ứng dụng ${ANSI.bold}Docker Desktop${ANSI.reset}, chờ biểu tượng xanh rồi chạy lại ${ANSI.cyan}./run${ANSI.reset}.`);
  } else {
    console.error(`  • Máy hiện chưa cài đặt ${ANSI.yellow}Docker Desktop / WSL2${ANSI.reset}.`);
    console.error(`  • Cách 1 (Full Docker 10 DB PostgreSQL 16): Cài Docker Desktop tại https://www.docker.com/products/docker-desktop/ rồi chạy ${ANSI.cyan}./run${ANSI.reset}.`);
  }
  console.error(`  • Cách 2 (Chạy ngay không cần Docker): Dùng ${ANSI.green}./run --local${ANSI.reset} để khởi động toàn bộ 14 dịch vụ với Local Dev Harness.\n`);
}

// ============================================================================
// Service Process Definitions (14 processes: 4001..4010, 4000, 3000..3002)
// ============================================================================
function buildProcessSpecs(devMode) {
  const pyBin = resolvePythonBin();
  const pnpmCmd = IS_WIN ? 'cmd.exe' : 'pnpm';
  const pnpmArgs = (...args) => (IS_WIN ? ['/d', '/c', 'pnpm', ...args] : args);

  const nodeSvc = (tag, color, port, filterPkg, distEntry, extraEnv = {}) => ({
    tag,
    color,
    port,
    healthUrl: `http://127.0.0.1:${port}/health`,
    readyUrl: `http://127.0.0.1:${port}/ready`,
    cmd: devMode ? pnpmCmd : process.execPath,
    args: devMode ? pnpmArgs('--filter', filterPkg, 'dev') : [distEntry],
    distEntry,
    cwd: ROOT_DIR,
    env: extraEnv,
    kind: 'backend',
  });

  const portalApp = (tag, color, port, filterPkg, nextDir) => ({
    tag,
    color,
    port,
    healthUrl: `http://127.0.0.1:${port}/`,
    readyUrl: `http://127.0.0.1:${port}/`,
    cmd: pnpmCmd,
    args: pnpmArgs('--filter', filterPkg, devMode ? 'dev' : 'start'),
    nextBuildMarker: path.join(ROOT_DIR, nextDir, '.next', 'BUILD_ID'),
    cwd: ROOT_DIR,
    env: {
      PORT: String(port),
      NEXT_PUBLIC_BFF_URL: 'http://localhost:4000',
      NODE_ENV: devMode ? 'development' : 'production',
    },
    kind: 'portal',
  });

  return [
    nodeSvc('AUTH     :4001', ANSI.cyan, 4001, '@atelier/auth-customer', 'services/auth-customer/dist/main.js', { AUTH_SERVICE_PORT: '4001' }),
    nodeSvc('CATALOG  :4002', ANSI.brightCyan, 4002, '@atelier/catalog-lookbook', 'services/catalog-lookbook/dist/main.js', { CATALOG_SERVICE_PORT: '4002' }),
    nodeSvc('MEDIA    :4003', ANSI.blue, 4003, '@atelier/media-pipeline', 'services/media-pipeline/dist/main.js', { MEDIA_SERVICE_PORT: '4003' }),
    nodeSvc('INVENT   :4004', ANSI.yellow, 4004, '@atelier/inventory', 'services/inventory/dist/main.js', { INVENTORY_SERVICE_PORT: '4004' }),
    nodeSvc('CART     :4005', ANSI.brightYellow, 4005, '@atelier/cart-outfit', 'services/cart-outfit/dist/main.js', { CART_SERVICE_PORT: '4005' }),
    nodeSvc('ORDER    :4006', ANSI.magenta, 4006, '@atelier/order-rma', 'services/order-rma/dist/main.js', { ORDER_SERVICE_PORT: '4006' }),
    nodeSvc('PAYMENT  :4007', ANSI.brightMagenta, 4007, '@atelier/payment-promo', 'services/payment-promo/dist/main.js', { PAYMENT_SERVICE_PORT: '4007' }),
    nodeSvc('NOTIFY   :4008', ANSI.brightBlue, 4008, '@atelier/notify-review', 'services/notify-review/dist/main.js', { NOTIFY_SERVICE_PORT: '4008' }),
    {
      tag: 'AI-TRYON :4009',
      color: ANSI.green,
      port: 4009,
      healthUrl: 'http://127.0.0.1:4009/health',
      readyUrl: 'http://127.0.0.1:4009/ready',
      cmd: pyBin,
      args: ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '4009'],
      cwd: path.join(ROOT_DIR, 'services', 'ai-tryon'),
      env: { AI_TRYON_PORT: '4009' },
      kind: 'backend',
    },
    nodeSvc('MCP-AI   :4010', ANSI.brightGreen, 4010, '@atelier/mcp-copilot', 'apps/mcp-copilot/dist/main.js', { MCP_COPILOT_PORT: '4010' }),
    nodeSvc('BFF-GW   :4000', ANSI.bold + ANSI.brightYellow, 4000, '@atelier/bff', 'apps/bff/dist/main.js', { BFF_PORT: '4000' }),
    portalApp('STORE    :3000', ANSI.bold + ANSI.cyan, 3000, '@atelier/storefront', 'apps/storefront'),
    portalApp('ADMIN    :3001', ANSI.bold + ANSI.magenta, 3001, '@atelier/admin-portal', 'apps/admin-portal'),
    portalApp('PARTNER  :3002', ANSI.bold + ANSI.green, 3002, '@atelier/partner-portal', 'apps/partner-portal'),
  ];
}

// ============================================================================
// Subcommands: --status, --down, --verify
// ============================================================================
async function handleStatus() {
  const docker = inspectDockerStatus();
  const envVars = { ...loadDotEnv(path.join(ROOT_DIR, '.env')), ...process.env };
  const ollamaUrl = String(envVars.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const ollamaMain = String(envVars.OLLAMA_MAIN_MODEL || 'qwen2.5:3b').trim();
  const ollamaEmbed = String(envVars.OLLAMA_EMBED_MODEL || 'nomic-embed-text').trim();
  const ollamaEmbedDim = Number.parseInt(String(envVars.OLLAMA_EMBED_DIM || '768'), 10) || 768;
  const ollamaProbe = await probeOllamaTags(ollamaUrl, 2000);

  console.log(`\n${ANSI.bold}${ANSI.cyan}=== TRẠNG THÁI HỆ THỐNG fashion-atelier-ai-platform (v3.1 · Local Ollama AI) ===${ANSI.reset}`);

  if (docker.running) {
    console.log(`\n${ANSI.bold}[1] Cụm Container Docker (INFRA_MODE=DOCKER_COMPOSE, Docker ${docker.version})${ANSI.reset}`);
    for (const name of [...DOCKER_PERSISTENT_CONTAINERS, DOCKER_INIT_CONTAINER]) {
      const st = inspectContainer(name);
      const ok = name === DOCKER_INIT_CONTAINER
        ? st.status === 'exited' && st.exitCode === 0
        : st.status === 'running' && (st.health === 'healthy' || st.health === 'none');
      const badge = ok ? `${ANSI.green}HEALTHY${ANSI.reset}` : `${ANSI.red}${st.status}/${st.health}${ANSI.reset}`;
      console.log(`  ${name.padEnd(22)} : ${badge}`);
    }
  } else {
    console.log(`\n${ANSI.bold}[1] Hạ tầng Cục bộ (INFRA_MODE=LOCAL_DEV_HARNESS — Docker ${docker.installed ? 'chưa bật' : 'chưa cài đặt'})${ANSI.reset}`);
    for (const item of INFRA_PORTS) {
      const open = await isTcpOpen(item.port);
      const badge = open
        ? `${ANSI.green}UP${ANSI.reset}`
        : item.dockerOnly
          ? `${ANSI.dim}N/A (Docker-only)${ANSI.reset}`
          : `${ANSI.red}DOWN${ANSI.reset}`;
      console.log(`  :${String(item.port).padEnd(5)} ${item.name.padEnd(28)} : ${badge}`);
    }
  }

  console.log(`\n${ANSI.bold}[2] Local AI Engine (100% Ollama — 0₫ / Offline Privacy)${ANSI.reset}`);
  const ollamaBadge = ollamaProbe.reachable
    ? `${ANSI.green}ONLINE${ANSI.reset} (${ollamaProbe.latencyMs}ms · ${ollamaProbe.models.length} model(s): ${ollamaProbe.models.join(', ')})`
    : `${ANSI.red}OFFLINE${ANSI.reset} (RuleBasedMcpOrchestrator fallback)`;
  console.log(
    `  Ollama Engine (${ollamaUrl} — Main: ${ollamaMain} | Embed: ${ollamaEmbed} ${ollamaEmbedDim}-dim) : ${ollamaBadge}`,
  );

  console.log(`\n${ANSI.bold}[3] 14 Ứng dụng & Microservices (Cổng 3000..3002 & 4000..4010)${ANSI.reset}`);
  const specs = buildProcessSpecs(false);
  for (const s of specs) {
    const res = await probeHttp(s.healthUrl, 1200);
    const badge = res.status === 200
      ? `${ANSI.green}200 OK${ANSI.reset} (${res.latencyMs}ms)`
      : res.status > 0
        ? `${ANSI.yellow}HTTP ${res.status}${ANSI.reset}`
        : `${ANSI.red}OFFLINE${ANSI.reset}`;
    console.log(`  [${s.tag}]  ${s.healthUrl.padEnd(32)} -> ${badge}`);
  }
  console.log('');
}

async function handleDown() {
  console.log(`\n${ANSI.bold}${ANSI.yellow}[DOWN] Đang dừng toàn bộ ứng dụng & giải phóng cổng 3000..4010...${ANSI.reset}`);
  const appKilled = freePorts(MANAGED_APP_PORTS);
  const localInfraKilled = freePorts([6379, 7700, 9000, 1025, 8025, 15672]);
  cleanStalePgliteLocks();
  logOk(`Đã giải phóng tiến trình ứng dụng (${appKilled} PID) và hạ tầng cục bộ (${localInfraKilled} PID; giữ nguyên host Ollama daemon :11434 nếu có).`);

  const docker = inspectDockerStatus();
  if (docker.running && fs.existsSync(COMPOSE_FILE)) {
    logInfo('Đang tắt cụm Docker Compose (docker compose --profile ollama-docker down)...');
    const res = await runForeground('docker', ['compose', '-f', COMPOSE_FILE, '--profile', 'ollama-docker', 'down']);
    if (!res.ok) {
      logErr('docker compose down trả mã lỗi.');
      process.exit(1);
    }
    logOk('Đã tắt cụm Docker Compose thành công.');
  } else {
    logInfo('Không phát hiện Docker daemon đang chạy — bỏ qua docker compose down.');
  }
  console.log('');
}

async function handleVerify(flags) {
  console.log(`\n${ANSI.bold}${ANSI.cyan}[VERIFY] Khởi chạy cổng kiểm định AI Harness (pnpm eval:ai) & Tổng kiểm toán (pnpm verify:all)...${ANSI.reset}`);
  const docker = inspectDockerStatus();
  if (flags.strictDocker && !docker.running) {
    printDockerRequiredGuide(docker.installed);
    process.exit(1);
  }
  if (docker.running && !flags.forceLocal) {
    logInfo('Docker đang chạy — đảm bảo cụm hạ tầng online trước khi kiểm định...');
    await runForeground('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d']);
    await waitForDockerHealthy(90_000);
  } else {
    logWarn('Chạy kiểm định ở chế độ INFRA_MODE=LOCAL_DEV_HARNESS (verify:all sẽ tự bật/dọn sạch hạ tầng).');
  }

  const evalRes = await runForeground('pnpm', ['eval:ai']);
  if (!evalRes.ok) process.exit(evalRes.code || 1);

  const allRes = await runForeground('pnpm', ['verify:all']);
  process.exit(allRes.ok ? 0 : allRes.code || 1);
}

// ============================================================================
// Dashboard Banner (Step 6)
// ============================================================================
function printDashboard(infraMode, probeResults, seededThisRun, ollamaInfo) {
  const httpsNote = infraMode === 'DOCKER_COMPOSE'
    ? 'HTTPS Nginx sẵn sàng'
    : 'HTTP cục bộ (HTTPS qua Nginx khi chạy Docker)';
  const ollamaStatusText = ollamaInfo?.reachable
    ? `${ANSI.green}ONLINE${ANSI.reset} (${ollamaInfo.installedModels.length} model(s) · 0₫ Offline Privacy)`
    : `${ANSI.yellow}OFFLINE${ANSI.reset} (RuleBasedMcpOrchestrator dự phòng)`;
  const ollamaLine = ollamaInfo
    ? `Ollama Engine (${ollamaInfo.baseUrl} — Main: ${ollamaInfo.activeMainModel} | Embed: ${ollamaInfo.activeEmbedModel} ${ollamaInfo.embedDim}-dim) : ${ollamaStatusText}`
    : `Ollama Engine (http://127.0.0.1:11434) : ${ollamaStatusText}`;

  console.log(`
${ANSI.bold}${ANSI.brightGreen}================================================================================${ANSI.reset}
${ANSI.bold}${ANSI.brightGreen}  TẦM XUÂN · FASHION ATELIER AI PLATFORM (v3.1) — SẴN SÀNG 14/14 (200 OK)${ANSI.reset}
${ANSI.bold}${ANSI.brightGreen}================================================================================${ANSI.reset}
  Chế độ hạ tầng : ${ANSI.bold}${ANSI.yellow}${infraMode}${ANSI.reset}  (${httpsNote})
  Local AI       : ${ollamaLine}
  Auto-Seed      : ${seededThisRun ? `${ANSI.green}Đã nạp mới dữ liệu mẫu (20 thiết kế, 6 RBAC, 3 NCC)${ANSI.reset}` : `${ANSI.cyan}Dữ liệu mẫu đã sẵn sàng (.secrets/.seeded-v3)${ANSI.reset}`}

${ANSI.bold}  [1] 3 CỔNG GIAO DIỆN TÁCH RỜI VẬT LÝ${ANSI.reset}
      • Trang chủ Mua sắm & 3D Rack : ${ANSI.cyan}http://localhost:3000${ANSI.reset}  |  ${ANSI.dim}https://localhost${ANSI.reset}
      • Cổng Quản trị & MCP Copilot : ${ANSI.magenta}http://localhost:3001${ANSI.reset}  |  ${ANSI.dim}https://admin.localhost${ANSI.reset}
      • Cổng Đối tác B2B (Supplier) : ${ANSI.green}http://localhost:3002${ANSI.reset}  |  ${ANSI.dim}https://partner.localhost${ANSI.reset}

${ANSI.bold}  [2] CÔNG CỤ VẬN HÀNH & GIÁM SÁT${ANSI.reset}
      • BFF Gateway & Socket.io     : ${ANSI.yellow}http://localhost:4000/health${ANSI.reset}
      • ${ollamaLine}
      • Mailpit Webmail (OTP 2FA)   : ${ANSI.yellow}http://localhost:8025${ANSI.reset}
      • MinIO Object Storage        : ${ANSI.yellow}http://localhost:9001${ANSI.reset}  (API :9000 · atelier_minio / Atelier_Minio2026!)
      • RabbitMQ Management & *.dlq : ${ANSI.yellow}http://localhost:15672${ANSI.reset} (atelier_mq / Atelier_Mq2026!)

${ANSI.bold}  [3] TÀI KHOẢN ĐĂNG NHẬP NHANH — 6 VAI TRÒ RBAC (Mật khẩu: ${ANSI.brightYellow}Atelier@2026!${ANSI.reset}${ANSI.bold})${ANSI.reset}
      Vai trò              | Email đăng nhập           | 2FA Mailpit | Cổng
      ---------------------+---------------------------+-------------+-----------------
      SUPER_ADMIN          | lebao01121@gmail.com      | Bắt buộc    | :3001 Admin
      CATALOG_AI_OPERATOR  | operator@atelier.local    | Tùy chọn    | :3001 Admin
      WAREHOUSE_MANAGER    | warehouse@atelier.local   | Bắt buộc    | :3001 Admin
      ORDER_STAFF          | staff@atelier.local       | Tùy chọn    | :3001 Admin
      SUPPLIER (A / B / C) | supplier-a@atelier.local  | Bắt buộc    | :3002 Partner
                           | supplier-b@atelier.local  | Bắt buộc    | :3002 Partner
      CUSTOMER (A / B)     | customer@atelier.local    | Tùy chọn    | :3000 Storefront

${ANSI.bold}  [4] KẾT QUẢ KIỂM TRA SỨC KHỎE 14/14 ENDPOINTS${ANSI.reset}`);

  for (const r of probeResults) {
    console.log(
      `      ${r.color}[${r.tag}]${ANSI.reset}  ${r.url.padEnd(32)} -> ${ANSI.green}${r.status} OK${ANSI.reset} (${r.latencyMs}ms)`,
    );
  }
  console.log(`${ANSI.bold}${ANSI.brightGreen}================================================================================${ANSI.reset}\n`);
}

// ============================================================================
// Main 6-Step Orchestrator
// ============================================================================
async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    printHelp();
    process.exit(0);
  }
  const projectStorageEnv = configureProjectLocalStorageEnv();
  if (flags.status) {
    await handleStatus();
    process.exit(0);
  }
  if (flags.down) {
    await handleDown();
    process.exit(0);
  }
  if (flags.verify) {
    await handleVerify(flags);
    process.exit(0);
  }

  console.log(`\n${ANSI.bold}${ANSI.brightYellow}>>> TẦM XUÂN · FASHION ATELIER AI PLATFORM (v3.1) — ONE-COMMAND LAUNCHER <<<${ANSI.reset}`);

  // --------------------------------------------------------------------------
  // BƯỚC 1: Kiểm tra Môi trường, .env, Chứng chỉ HTTPS & Giải phóng Cổng
  // --------------------------------------------------------------------------
  logStep(1, 'Kiểm tra môi trường, tệp .env, chứng chỉ HTTPS & giải phóng cổng');

  const nodeVer = process.version;
  const pnpmCheck = probeCommand('pnpm', ['--version']);
  if (!pnpmCheck.ok) {
    logErr('Không tìm thấy `pnpm`. Cài đặt bằng: corepack enable && corepack prepare pnpm@9.15.4 --activate');
    process.exit(1);
  }
  const uvInfo = resolveUvBinary();
  const uvLabel = uvInfo ? uvInfo.version.replace(/^uv\s+/i, '') : '(chưa cài, dùng .venv trực tiếp)';
  logOk(`Node ${nodeVer} | pnpm ${pnpmCheck.output} | uv ${uvLabel}`);

  const docker = inspectDockerStatus();
  let infraMode = 'DOCKER_COMPOSE';

  if (flags.forceLocal) {
    infraMode = 'LOCAL_DEV_HARNESS';
    logWarn('Đã bật cờ --local -> vận hành ở chế độ INFRA_MODE=LOCAL_DEV_HARNESS.');
  } else if (docker.running) {
    infraMode = 'DOCKER_COMPOSE';
    logOk(`Docker daemon sẵn sàng (Server ${docker.version}) -> INFRA_MODE=DOCKER_COMPOSE`);
  } else if (flags.strictDocker) {
    printDockerRequiredGuide(docker.installed);
    process.exit(1);
  } else if (docker.installed && !docker.running) {
    // Docker Desktop IS installed on the machine, but daemon is turned off -> obey Step 1 strictly
    printDockerRequiredGuide(true);
    process.exit(1);
  } else {
    // Docker is NOT installed on this host -> honestly report & auto-switch to LOCAL_DEV_HARNESS so `./run` works out of the box!
    infraMode = 'LOCAL_DEV_HARNESS';
    logWarn('Docker Desktop / WSL2 chưa được cài đặt trên máy này.');
    logWarn('Tự động chuyển sang chế độ dự phòng INFRA_MODE=LOCAL_DEV_HARNESS (Redis/Meilisearch/MinIO/Mailpit/RabbitMQ DLQ + 10 DB cô lập).');
    logInfo('Gợi ý: Truyền `./run --docker` nếu muốn ép bắt buộc Docker Desktop (thoát mã lỗi 1 khi thiếu Docker).');
  }

  // Ensure .env exists
  const envPath = path.join(ROOT_DIR, '.env');
  const envExamplePath = path.join(ROOT_DIR, '.env.example');
  if (!fs.existsSync(envPath)) {
    if (!fs.existsSync(envExamplePath)) {
      logErr('Không tìm thấy .env hoặc .env.example tại thư mục gốc.');
      process.exit(1);
    }
    fs.copyFileSync(envExamplePath, envPath);
    logOk('Đã tự động sao chép .env.example -> .env');
  } else {
    logOk('Đã tìm thấy tệp .env');
  }

  const envVars = {
    ...loadDotEnv(envPath),
    ...process.env,
    ...projectStorageEnv,
    NODE_ENV: 'development',
  };

  // Ensure TLS certs exist for Nginx / Camera API
  const certCrt = path.join(ROOT_DIR, 'infra', 'nginx', 'certs', 'atelier.crt');
  const certKey = path.join(ROOT_DIR, 'infra', 'nginx', 'certs', 'atelier.key');
  if (!fs.existsSync(certCrt) || !fs.existsSync(certKey)) {
    logInfo('Chưa có chứng chỉ HTTPS local -> đang chạy `pnpm infra:certs`...');
    const certRes = await runForeground('pnpm', ['infra:certs'], { env: envVars });
    if (!certRes.ok) {
      logErr('Không thể tạo chứng chỉ HTTPS tại infra/nginx/certs/.');
      process.exit(1);
    }
    logOk('Đã khởi tạo chứng chỉ HTTPS local thành công.');
  } else {
    logOk('Chứng chỉ HTTPS local đã tồn tại (infra/nginx/certs/atelier.crt).');
  }

  // Clean stale processes occupying 3000..3002 & 4000..4010
  const killedCount = freePorts(MANAGED_APP_PORTS);
  if (killedCount > 0) {
    logOk(`Đã giải phóng ${killedCount} tiến trình mồ côi trên các cổng 3000..3002 & 4000..4010.`);
    await new Promise((r) => setTimeout(r, 400));
  } else {
    logOk('Toàn bộ cổng ứng dụng 3000..3002 & 4000..4010 đã sạch (không có EADDRINUSE).');
  }
  cleanStalePgliteLocks();

  // --------------------------------------------------------------------------
  // BƯỚC 2: Khởi động Hạ tầng (Docker Compose hoặc Local Dev Harness) + Ollama AI
  // --------------------------------------------------------------------------
  logStep(2, `Khởi động cụm hạ tầng (${infraMode}) & Local Ollama AI Engine`);

  let localInfraHandle = null;

  if (infraMode === 'DOCKER_COMPOSE') {
    const composeBaseArgs = ['compose', '-f', COMPOSE_FILE];
    if (flags.ollamaDocker) {
      composeBaseArgs.push('--profile', 'ollama-docker');
    }
    if (flags.reset) {
      logWarn('Cờ --reset: đang xóa sạch volume Docker cũ (docker compose down -v)...');
      await runForeground('docker', [...composeBaseArgs, 'down', '-v'], { env: envVars });
      if (fs.existsSync(SEED_MARKER)) fs.rmSync(SEED_MARKER, { force: true });
    }
    const upRes = await runForeground('docker', [...composeBaseArgs, 'up', '-d'], { env: envVars });
    if (!upRes.ok) {
      logErr('docker compose up -d thất bại.');
      process.exit(1);
    }
    await waitForDockerHealthy(90_000, flags.ollamaDocker);
    logOk(
      flags.ollamaDocker
        ? 'Toàn bộ 7 container nền + atelier-ollama đã healthy và atelier-minio-mc hoàn tất (exit 0).'
        : 'Toàn bộ 7 container nền đã healthy và atelier-minio-mc hoàn tất (exit 0).',
    );
  } else {
    if (flags.reset) {
      logWarn('Cờ --reset: đang xóa sạch dữ liệu cục bộ .local-pgdata & dấu seed...');
      const localPgDir = path.join(ROOT_DIR, '.local-pgdata');
      if (fs.existsSync(localPgDir)) fs.rmSync(localPgDir, { recursive: true, force: true });
      if (fs.existsSync(SEED_MARKER)) fs.rmSync(SEED_MARKER, { force: true });
    }
    const { startLocalInfraIfNeeded } = await import('./local-infra-dev.mjs');
    localInfraHandle = await startLocalInfraIfNeeded(envVars);
    logOk('Local Dev Harness đã sẵn sàng: Redis :6379 | Meilisearch :7700 | MinIO :9000 | Mailpit :1025/:8025 | RabbitMQ DLQ :15672.');
  }

  // Ensure Local Ollama Engine & RAM-aware model auto-selection / auto-pull
  const ollamaInfo = await ensureOllamaReady(envVars, flags, infraMode);

  const spawnedChildren = [];
  const earlyFailures = [];
  let shuttingDown = false;

  async function cleanupAll(reason, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${ANSI.yellow}[CLEANUP] (${reason}) Đang tắt gọn toàn bộ tiến trình con...${ANSI.reset}`);
    for (const child of spawnedChildren) {
      killPidTree(child.pid);
    }
    // ONLY stop `ollama serve` if scripts/run.mjs itself spawned it (preserve user's pre-existing system Ollama daemon!)
    if (ollamaInfo?.spawnedChild?.pid) {
      killPidTree(ollamaInfo.spawnedChild.pid);
    }
    if (localInfraHandle) {
      await localInfraHandle.stop();
    }
    // Verify no lingering IPv4 or IPv6 app ports remain
    let totalCleaned = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await new Promise((r) => setTimeout(r, 350));
      const lingering = freePorts(MANAGED_APP_PORTS);
      totalCleaned += lingering;
      if (lingering === 0) break;
    }
    if (totalCleaned > 0) {
      logInfo(`Đã dọn thêm ${totalCleaned} tiến trình phụ còn sót (IPv4/IPv6).`);
    }
    cleanStalePgliteLocks();
    logOk('Đã đóng gọn toàn bộ tiến trình — không kẹt cổng (STRAY_PORTS=NONE).');
    process.exit(exitCode);
  }

  process.once('SIGINT', () => void cleanupAll('SIGINT / Ctrl+C', 0));
  process.once('SIGTERM', () => void cleanupAll('SIGTERM', 0));

  try {
    // ------------------------------------------------------------------------
    // BƯỚC 3: Cài đặt Gói Thiếu & Build Cụm packages/* (+ workspace nếu thiếu)
    // ------------------------------------------------------------------------
    logStep(3, 'Kiểm tra phụ thuộc (pnpm / Python uv) & build cụm packages/*');

    if (!fs.existsSync(path.join(ROOT_DIR, 'node_modules'))) {
      logInfo('Chưa có node_modules -> đang chạy `pnpm install`...');
      const inst = await runForeground('pnpm', ['install'], { env: envVars });
      if (!inst.ok) throw new Error('pnpm install thất bại');
    } else {
      logOk('Thư mục node_modules đã sẵn sàng.');
    }

    const pyDir = path.join(ROOT_DIR, 'services', 'ai-tryon');
    const pyVenv = path.join(pyDir, '.venv');
    if (fs.existsSync(path.join(pyDir, 'pyproject.toml')) && !fs.existsSync(pyVenv)) {
      if (!uvInfo) {
        throw new Error('Không tìm thấy `uv` để khởi tạo services/ai-tryon/.venv. Cài `pip install uv`.');
      }
      logInfo('Chưa có services/ai-tryon/.venv -> đang chạy `uv sync`...');
      const syncRes = await runForeground(uvInfo.bin, ['sync'], { cwd: pyDir, env: envVars });
      if (!syncRes.ok) throw new Error('uv sync tại services/ai-tryon thất bại');
      logOk('Đã khởi tạo môi trường Python 3.12 (uv sync).');
    } else {
      logOk('Môi trường Python services/ai-tryon/.venv đã sẵn sàng.');
    }

    logInfo('Đang build cụm shared packages (`pnpm --filter "./packages/*" build`)...');
    const pkgBuild = await runForeground('pnpm', ['--filter', './packages/*', 'build'], { env: envVars });
    if (!pkgBuild.ok) throw new Error('Build cụm packages/* thất bại');
    logOk('Đã build xanh @atelier/{contracts,observability,ai-harness,ui-tokens,motion-kit,db-client}.');

    const specs = buildProcessSpecs(flags.devMode);
    if (!flags.devMode) {
      const missingDist = specs.some(
        (s) =>
          (s.distEntry && !fs.existsSync(path.join(ROOT_DIR, s.distEntry))) ||
          (s.nextBuildMarker && !fs.existsSync(s.nextBuildMarker)),
      );
      if (missingDist) {
        logInfo('Phát hiện ứng dụng/dịch vụ chưa có bản build -> đang chạy `pnpm build`...');
        const fullBuild = await runForeground('pnpm', ['build'], { env: envVars });
        if (!fullBuild.ok) throw new Error('pnpm build thất bại');
        logOk('Đã build xanh toàn bộ 21 workspaces.');
      } else {
        logOk('Bản build cho toàn bộ 11 dịch vụ & 3 cổng Next.js đã sẵn sàng.');
      }
    }

    // ------------------------------------------------------------------------
    // BƯỚC 4: Chạy Database Migrations (Python Alembic + 10 DB) & Chuẩn bị Seed
    // ------------------------------------------------------------------------
    logStep(4, 'Chạy Database Migrations (Alembic + 10 DB cô lập) & kiểm tra Smart Auto-Seed');

    const pyBin = resolvePythonBin();
    const alembicCmd = uvInfo ? uvInfo.bin : pyBin;
    const alembicPrefix = uvInfo ? ['run', 'alembic'] : ['-m', 'alembic'];
    let alembicRes = await runForeground(alembicCmd, [...alembicPrefix, 'upgrade', 'head'], {
      cwd: pyDir,
      env: envVars,
      silent: true,
    });
    if (!alembicRes.ok && /already exists/i.test(alembicRes.output)) {
      logWarn('Phát hiện tryon_db đã có bảng (chưa gắn dấu alembic_version) -> tự động `alembic stamp head`...');
      const stampRes = await runForeground(alembicCmd, [...alembicPrefix, 'stamp', 'head'], {
        cwd: pyDir,
        env: envVars,
        silent: true,
      });
      if (stampRes.ok) {
        alembicRes = await runForeground(alembicCmd, [...alembicPrefix, 'upgrade', 'head'], {
          cwd: pyDir,
          env: envVars,
          silent: true,
        });
      }
    }
    if (!alembicRes.ok) {
      throw new Error(`Alembic upgrade head thất bại: ${alembicRes.output}`);
    }
    logOk('Python services/ai-tryon: `alembic upgrade head` thành công (tryon_db).');
    logOk('8 Dịch vụ DDD TypeScript & rag_vector_db sẽ tự chạy idempotent DDL migration khi boot.');

    const needsSeed = flags.seed || flags.reset || !fs.existsSync(SEED_MARKER);
    if (needsSeed) {
      logInfo('Smart Auto-Seed: sẽ tự động nạp `pnpm db:seed` ngay sau khi các dịch vụ nền đạt sẵn sàng.');
    } else {
      logOk('Smart Auto-Seed: phát hiện `.secrets/.seeded-v3` (dùng `--seed` để ép nạp lại).');
    }

    // ------------------------------------------------------------------------
    // BƯỚC 5: Khởi chạy Đồng thời Toàn bộ 14 Tiến trình với Log Màu Sắc
    // ------------------------------------------------------------------------
    logStep(5, `Khởi chạy đồng thời 14 tiến trình (11 Backend + 3 Portals · chế độ ${flags.devMode ? 'DEV' : 'START'})`);

    for (const spec of specs) {
      const prefix = `${spec.color}[${spec.tag}]${ANSI.reset}`;
      const child = spawn(spec.cmd, spec.args, {
        cwd: spec.cwd,
        env: { ...envVars, ...(spec.env || {}) },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      spawnedChildren.push(child);
      child.once('exit', (code, signal) => {
        if (!shuttingDown) {
          earlyFailures.push(`${spec.tag} exited prematurely (code=${code}, signal=${signal})`);
        }
      });

      const attachPipe = (stream, isErr) => {
        if (!stream) return;
        let buffer = '';
        stream.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            // Keep smoke-test output crisp; stream everything in live mode
            if (!flags.smokeTest || isErr) {
              const out = isErr ? process.stderr : process.stdout;
              out.write(`${prefix} ${line}\n`);
            }
          }
        });
      };

      attachPipe(child.stdout, false);
      attachPipe(child.stderr, true);
    }

    // ------------------------------------------------------------------------
    // BƯỚC 6: Poll 200 OK cho 14/14 Endpoints, Smart Auto-Seed & In Dashboard
    // ------------------------------------------------------------------------
    logStep(6, 'Chờ 14/14 cổng (4000..4010 /health & 3000..3002) phản hồi 200 OK');

    const backendSpecs = specs.filter((s) => s.kind === 'backend');
    const portalSpecs = specs.filter((s) => s.kind === 'portal');

    const backendResults = await Promise.all(
      backendSpecs.map(async (s) => {
        const res = await waitForHttp200(s.tag, s.healthUrl, 65_000);
        return { tag: s.tag, color: s.color, url: s.healthUrl, status: res.status, latencyMs: res.latencyMs };
      }),
    );

    let seededThisRun = false;
    if (needsSeed) {
      logInfo('Đang thực thi Smart Auto-Seed (`pnpm db:seed`) trên cụm dịch vụ đang sống...');
      const seedRes = await runForeground('pnpm', ['db:seed'], { env: envVars });
      if (!seedRes.ok) {
        throw new Error('Smart Auto-Seed (`pnpm db:seed`) thất bại.');
      }
      fs.mkdirSync(path.dirname(SEED_MARKER), { recursive: true });
      fs.writeFileSync(
        SEED_MARKER,
        `${JSON.stringify({ seededAt: new Date().toISOString(), infraMode }, null, 2)}\n`,
        'utf8',
      );
      seededThisRun = true;
      logOk('Đã hoàn tất Smart Auto-Seed và ghi dấu `.secrets/.seeded-v3`.');
    }

    const portalResults = await Promise.all(
      portalSpecs.map(async (s) => {
        const res = await waitForHttp200(s.tag, s.healthUrl, 65_000);
        return { tag: s.tag, color: s.color, url: s.healthUrl, status: res.status, latencyMs: res.latencyMs };
      }),
    );

    const allResults = [...portalResults, ...backendResults];
    if (earlyFailures.length > 0) {
      throw new Error(`Phát hiện tiến trình thoát sớm khi khởi chạy: ${earlyFailures.join('; ')}`);
    }
    printDashboard(infraMode, allResults, seededThisRun, ollamaInfo);

    if (flags.smokeTest) {
      console.log(
        `${ANSI.bold}${ANSI.brightGreen}[SMOKE-TEST PASS]${ANSI.reset} Tất cả ${allResults.length}/14 cổng (3000..3002 & 4000..4010 /health) đều trả về 200 OK!`,
      );
      await cleanupAll('SMOKE_TEST_DONE', 0);
      return;
    }

    console.log(`${ANSI.dim}Đang giữ phiên log trực tiếp. Nhấn Ctrl + C để dừng toàn bộ hệ thống sạch sẽ.${ANSI.reset}\n`);
    // Keep event loop alive until SIGINT / SIGTERM
    await new Promise(() => {});
  } catch (err) {
    logErr(err instanceof Error ? err.message : String(err));
    await cleanupAll('ERROR', 1);
  }
}

main().catch((err) => {
  console.error('[FATAL] scripts/run.mjs:', err);
  process.exit(1);
});
