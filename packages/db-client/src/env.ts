import fs from 'node:fs';
import path from 'node:path';

export interface LoadRootEnvResult {
  repoRoot: string;
  envPath: string | null;
  loadedKeys: string[];
}

export function findRepoRoot(startDir: string = process.cwd()): string {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 12; depth += 1) {
    if (fs.existsSync(path.join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  // Fallback: walk up to first directory with .env
  current = path.resolve(startDir);
  for (let depth = 0; depth < 12; depth += 1) {
    if (fs.existsSync(path.join(current, '.env'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return path.resolve(startDir);
}

function unquoteEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Finds the monorepo root `.env` file and populates missing keys into `process.env`.
 * Never overrides environment variables that are already defined.
 */
export function loadRootEnv(startDir?: string): LoadRootEnvResult {
  const repoRoot = findRepoRoot(startDir);
  const envPath = path.join(repoRoot, '.env');
  const loadedKeys: string[] = [];

  if (!fs.existsSync(envPath)) {
    return { repoRoot, envPath: null, loadedKeys };
  }

  const content = fs.readFileSync(envPath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    if (process.env[key] !== undefined) {
      continue;
    }
    const rawValue = trimmed.slice(eqIndex + 1);
    process.env[key] = unquoteEnvValue(rawValue);
    loadedKeys.push(key);
  }

  return { repoRoot, envPath, loadedKeys };
}
