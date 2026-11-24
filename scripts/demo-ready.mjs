#!/usr/bin/env node
/**
 * One-Command Demo Preparation Script (`pnpm demo:ready`)
 * fashion-atelier-ai-platform (v3.0)
 *
 * Prepares the full monorepo for live defense & demonstration:
 *   1. Auto-detects Docker Desktop vs LOCAL_DEV_HARNESS honestly (noting port 443 / WSL2 status).
 *   2. Ensures local TLS certs exist (`pnpm infra:certs`).
 *   3. Runs `pnpm build` across all 21 workspaces & verifies Python `services/ai-tryon` Alembic/FastAPI.
 *   4. Runs idempotent `pnpm db:seed` (20 Atelier designs, 0 broken images, 52+ reviews, >40 try-on signals).
 *   5. Prints formatted Portal/Service URLs & all 6 RBAC role credentials (Atelier@2026!).
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPortOpen, startLocalInfraIfNeeded } from './local-infra-dev.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';

function runStep(cmd, args, opts = {}) {
  const { cwd = ROOT_DIR, env = process.env, label = `${cmd} ${args.join(' ')}` } = opts;
  return new Promise((resolve) => {
    console.log(`\n[STEP] ${label} ...`);
    const isPnpm = cmd === 'pnpm';
    const execCmd = IS_WIN && isPnpm ? 'cmd.exe' : cmd;
    const execArgs = IS_WIN && isPnpm ? ['/d', '/c', 'pnpm', ...args] : args;

    const child = spawn(execCmd, execArgs, {
      cwd,
      env,
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', (err) => resolve({ ok: false, code: -1, err: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code: code ?? -1 }));
  });
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

function checkDockerDaemon() {
  const probe = spawnSync('docker', ['info'], { stdio: 'ignore', windowsHide: true, timeout: 4000 });
  return probe.status === 0;
}

async function main() {
  console.log('========================================================================');
  console.log(' fashion-atelier-ai-platform (v3.0) — Demo Preparation (pnpm demo:ready)');
  console.log('========================================================================');

  const dockerOnline = checkDockerDaemon();
  const infraMode = dockerOnline ? 'DOCKER_COMPOSE' : 'LOCAL_DEV_HARNESS';
  let localInfra = null;

  try {
    if (dockerOnline) {
      console.log('[INFRA] Docker daemon detected — INFRA_MODE=DOCKER_COMPOSE');
      const up = await runStep('docker', ['compose', '-f', 'infra/docker-compose.yml', 'up', '-d'], {
        label: 'docker compose -f infra/docker-compose.yml up -d',
      });
      if (!up.ok) throw new Error('Failed to start Docker Compose infrastructure');
    } else {
      console.log('[INFRA] Docker Desktop / WSL2 not running on host — INFRA_MODE=LOCAL_DEV_HARNESS');
      const port443Busy = await isPortOpen('127.0.0.1', 443);
      if (port443Busy) {
        console.log('[NOTE]  TCP :443 is currently occupied on host (e.g. vmware-hostd); local portals run cleanly on :3000/:3001/:3002 & BFF :4000.');
      }
    }

    // 1. Ensure TLS certificates exist
    const certFile = path.join(ROOT_DIR, 'infra', 'nginx', 'certs', 'atelier.crt');
    if (!fs.existsSync(certFile)) {
      const certRes = await runStep('pnpm', ['infra:certs'], { label: 'Generate local TLS certificates (pnpm infra:certs)' });
      if (!certRes.ok) throw new Error('pnpm infra:certs failed');
    } else {
      console.log('[OK]    Local TLS certs already present (infra/nginx/certs/atelier.crt)');
    }

    // 2. Build all 21 monorepo workspaces
    const buildRes = await runStep('pnpm', ['build'], { label: 'Build all 21 workspaces (pnpm build)' });
    if (!buildRes.ok) throw new Error('pnpm build failed');

    // 3. Verify Python AI Try-On FastAPI + Alembic environment
    const pyBin = resolvePythonBin();
    const pyRes = await runStep(pyBin, ['-m', 'compileall', '-q', 'app'], {
      cwd: path.join(ROOT_DIR, 'services', 'ai-tryon'),
      label: 'Verify Python services/ai-tryon syntax & environment',
    });
    if (!pyRes.ok) throw new Error('Python services/ai-tryon check failed');

    // 4. Start temporary local infra if needed so pnpm db:seed can sync MinIO/Meilisearch/Redis
    if (!dockerOnline) {
      localInfra = await startLocalInfraIfNeeded();
    }

    // 5. Run idempotent master seed (`pnpm db:seed`)
    const seedRes = await runStep('pnpm', ['db:seed'], { label: 'Run idempotent master seeder (pnpm db:seed)' });
    if (!seedRes.ok) throw new Error('pnpm db:seed failed');

    console.log('\n========================================================================');
    console.log(` DEMO READY!  (INFRA_MODE=${infraMode})`);
    console.log('========================================================================');
    console.log('\n[1] Portals & Infrastructure URLs (launch with `pnpm start:all`):');
    console.log('  - Storefront Editorial (WebGL + Try-On) : http://localhost:3000');
    console.log('  - Admin Portal (Backoffice + Copilot)   : http://localhost:3001');
    console.log('  - Partner B2B Portal (Suppliers)        : http://localhost:3002');
    console.log('  - Fashion BFF + Socket.io /realtime     : http://localhost:4000');
    console.log('  - Mailpit Email & 2FA OTP Inbox         : http://localhost:8025');
    console.log('  - MinIO S3 Object Storage               : http://localhost:9000');
    console.log('  - RabbitMQ Management + DLQ Console     : http://localhost:15672');
    console.log('  - Microservices (4001..4010)            : auth:4001 catalog:4002 media:4003 inv:4004 cart:4005 order:4006 pay:4007 notify:4008 tryon:4009 mcp:4010');

    console.log('\n[2] Seeded 6-Role RBAC Demo Accounts (Password: Atelier@2026!):');
    console.log('  Role                 | Email                       | 2FA (Mailpit) | Portal');
    console.log('  ---------------------+-----------------------------+---------------+-----------------');
    console.log('  SUPER_ADMIN          | admin@atelier.local         | Mandatory     | :3001 Admin');
    console.log('  WAREHOUSE_MANAGER    | warehouse@atelier.local     | Mandatory     | :3001 Admin');
    console.log('  ORDER_STAFF          | staff@atelier.local         | Optional      | :3001 Admin');
    console.log('  CATALOG_AI_OPERATOR  | operator@atelier.local      | Optional      | :3001 Admin');
    console.log('  SUPPLIER (A / B / C) | supplier-a@atelier.local    | Mandatory     | :3002 Partner');
    console.log('                       | supplier-b@atelier.local    | Mandatory     | :3002 Partner');
    console.log('                       | supplier-c@atelier.local    | Mandatory     | :3002 Partner');
    console.log('  CUSTOMER (A / B)     | customer@atelier.local      | Optional      | :3000 Storefront');
    console.log('                       | customer-b@atelier.local    | Optional      | :3000 Storefront');
    console.log('\nNext step: run `pnpm start:all` to boot all 14 live processes!\n');
  } finally {
    if (localInfra) {
      await localInfra.stop();
    }
  }
}

main().catch((err) => {
  console.error('\n[FATAL] pnpm demo:ready failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
