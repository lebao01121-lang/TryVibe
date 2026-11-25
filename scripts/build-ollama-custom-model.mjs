#!/usr/bin/env node
/**
 * Custom Ollama Model Builder & Rollback Verifier (`pnpm ai:build-model`)
 *
 * Builds `atelier-copilot:v1` from `ml/finetune/Modelfile.atelier-copilot` against Host Ollama:
 * - Reads `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`).
 * - Runs `ollama create <model> -f <modelfile>` with automatic HTTP `/api/create` fallback
 *   when the `ollama` binary is unavailable on PATH.
 * - Verifies `<model>` appears in `/api/tags`.
 * - Executes a real Vietnamese domain smoke generation measuring `tokens/s`.
 * - Supports `--rollback` to verify instant 1-second rollback readiness to `qwen2.5:3b`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_MODEL = 'atelier-copilot:v1';
const DEFAULT_BASE_ROLLBACK_MODEL = 'qwen2.5:3b';
const DEFAULT_MODELFILE = path.join(
  REPO_ROOT,
  'ml',
  'finetune',
  'Modelfile.atelier-copilot',
);

function loadRootEnvIfPresent() {
  const envPath = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch {
    // Ignore unreadable .env
  }
}

function parseCliArgs(argv) {
  const opts = {
    modelfile: DEFAULT_MODELFILE,
    model: DEFAULT_MODEL,
    baseModel: DEFAULT_BASE_ROLLBACK_MODEL,
    rollback: false,
    skipSmoke: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--rollback') {
      opts.rollback = true;
    } else if (arg === '--skip-smoke') {
      opts.skipSmoke = true;
    } else if (arg === '--modelfile' && argv[i + 1]) {
      opts.modelfile = path.resolve(REPO_ROOT, argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--modelfile=')) {
      opts.modelfile = path.resolve(REPO_ROOT, arg.slice('--modelfile='.length));
    } else if (arg === '--model' && argv[i + 1]) {
      opts.model = argv[i + 1].trim();
      i += 1;
    } else if (arg.startsWith('--model=')) {
      opts.model = arg.slice('--model='.length).trim();
    } else if (arg === '--base-model' && argv[i + 1]) {
      opts.baseModel = argv[i + 1].trim();
      i += 1;
    } else if (arg.startsWith('--base-model=')) {
      opts.baseModel = arg.slice('--base-model='.length).trim();
    }
  }
  return opts;
}

function parseModelfileDirectives(modelfileText) {
  const fromMatch = /^\s*FROM\s+(\S+)/m.exec(modelfileText);
  const fromModel = fromMatch ? fromMatch[1].trim() : DEFAULT_BASE_ROLLBACK_MODEL;

  const templateMatch = /^\s*TEMPLATE\s+"""([\s\S]*?)"""/m.exec(modelfileText);
  const template = templateMatch ? templateMatch[1] : undefined;

  const systemMatch = /^\s*SYSTEM\s+"""([\s\S]*?)"""/m.exec(modelfileText);
  const system = systemMatch ? systemMatch[1] : undefined;

  const parameters = {};
  const stopList = [];
  const paramRegex = /^\s*PARAMETER\s+(\S+)\s+(.+)$/gm;
  let match = paramRegex.exec(modelfileText);
  while (match !== null) {
    const key = match[1].trim();
    const rawVal = match[2].trim();
    if (key === 'stop') {
      const cleaned = rawVal.replace(/^["']|["']$/g, '');
      stopList.push(cleaned);
    } else {
      const numVal = Number(rawVal);
      parameters[key] = Number.isFinite(numVal)
        ? numVal
        : rawVal.replace(/^["']|["']$/g, '');
    }
    match = paramRegex.exec(modelfileText);
  }
  if (stopList.length > 0) {
    parameters.stop = stopList;
  }

  return { from: fromModel, template, system, parameters };
}

async function fetchOllamaTags(baseUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Ollama /api/tags returned HTTP ${res.status}`);
    }
    const json = await res.json();
    return Array.isArray(json?.models) ? json.models : [];
  } finally {
    clearTimeout(timer);
  }
}

function findModelInTags(models, targetName) {
  const normalizedTarget = targetName.includes(':')
    ? targetName
    : `${targetName}:latest`;
  return (
    models.find(
      (m) =>
        m?.name === targetName ||
        m?.model === targetName ||
        m?.name === normalizedTarget ||
        m?.model === normalizedTarget,
    ) || null
  );
}

function tryCreateViaCli(modelName, modelfilePath, baseUrl) {
  const versionCheck = spawnSync('ollama', ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  if (versionCheck.error || versionCheck.status !== 0) {
    return { available: false, ok: false, reason: 'ollama CLI not on PATH' };
  }

  const createRes = spawnSync(
    'ollama',
    ['create', modelName, '-f', modelfilePath],
    {
      cwd: path.dirname(modelfilePath),
      env: { ...process.env, OLLAMA_HOST: baseUrl },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
    },
  );
  if (createRes.status !== 0) {
    return {
      available: true,
      ok: false,
      reason: (createRes.stderr || createRes.stdout || 'ollama create failed').trim(),
    };
  }
  return {
    available: true,
    ok: true,
    method: 'ollama_cli',
    version: (versionCheck.stdout || versionCheck.stderr || '').trim(),
    output: (createRes.stdout || createRes.stderr || '').trim(),
  };
}

async function createViaHttpApi(modelName, modelfileText, baseUrl) {
  const parsed = parseModelfileDirectives(modelfileText);
  const payload = {
    model: modelName,
    from: parsed.from,
    ...(parsed.template ? { template: parsed.template } : {}),
    ...(parsed.system ? { system: parsed.system } : {}),
    ...(Object.keys(parsed.parameters).length > 0
      ? { parameters: parsed.parameters }
      : {}),
    stream: false,
  };

  const res = await fetch(`${baseUrl}/api/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `HTTP /api/create failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }
  return { ok: true, method: 'ollama_http_api_create', statusText: text.trim() };
}

async function runVietnameseSmokeTest(modelName, baseUrl) {
  const startedAt = performance.now();
  const prompt =
    'Tóm tắt ngắn gọn trong 2 câu bằng tiếng Việt nguyên tắc NHAP_AI và chính sách quyền riêng tư 15 phút của Phòng Thử Đồ AI tại Tầm Xuân Fashion Atelier.';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: modelName,
        stream: false,
        keep_alive: '5m',
        options: {
          temperature: 0.1,
          num_predict: 160,
        },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(
        `Smoke generation failed (${res.status}): ${errBody.slice(0, 300)}`,
      );
    }
    const json = await res.json();
    const elapsedMs = performance.now() - startedAt;
    const content = String(json?.message?.content ?? '').trim();
    if (!content) {
      throw new Error(`Smoke generation for ${modelName} returned empty text`);
    }

    const evalCount = Number(json?.eval_count ?? 0);
    const evalDurationNs = Number(json?.eval_duration ?? 0);
    const promptEvalCount = Number(json?.prompt_eval_count ?? 0);
    const totalDurationMs = Number(json?.total_duration ?? 0) / 1e6;

    const tokensPerSec =
      evalCount > 0 && evalDurationNs > 0
        ? Number((evalCount / (evalDurationNs / 1e9)).toFixed(2))
        : evalCount > 0 && elapsedMs > 0
          ? Number((evalCount / (elapsedMs / 1000)).toFixed(2))
          : 0;

    return {
      ok: true,
      model: modelName,
      promptEvalTokens: promptEvalCount,
      generatedTokens: evalCount,
      tokensPerSec,
      ollamaTotalDurationMs: Number(totalDurationMs.toFixed(1)),
      wallClockMs: Number(elapsedMs.toFixed(1)),
      responseExcerpt: content.slice(0, 280),
    };
  } finally {
    clearTimeout(timer);
  }
}

function printActivationAndRollbackGuide(modelName, baseModel) {
  console.log('\n=== Activation & 1-Second Rollback Commands ===');
  console.log(`Activate custom model (${modelName}):`);
  console.log(`  PowerShell : $env:OLLAMA_MAIN_MODEL = "${modelName}"`);
  console.log(`  Bash/.env  : OLLAMA_MAIN_MODEL=${modelName}`);
  console.log(
    `  Live A/B   : pnpm eval:ai:live -- --compare-models ${baseModel},${modelName}`,
  );
  console.log(`\nInstant 1-second rollback (${baseModel}):`);
  console.log(`  PowerShell : $env:OLLAMA_MAIN_MODEL = "${baseModel}"`);
  console.log(`  Bash/.env  : OLLAMA_MAIN_MODEL=${baseModel}`);
  console.log(`  Verify     : pnpm ai:build-model -- --rollback`);
}

async function main() {
  loadRootEnvIfPresent();
  const opts = parseCliArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(
      [
        'Usage: node scripts/build-ollama-custom-model.mjs [options]',
        '',
        'Options:',
        '  --model <name>        Target Ollama model tag (default: atelier-copilot:v1)',
        '  --modelfile <path>    Path to Modelfile (default: ml/finetune/Modelfile.atelier-copilot)',
        '  --base-model <name>   Rollback baseline model (default: qwen2.5:3b)',
        '  --rollback            Verify instant rollback readiness to base model (qwen2.5:3b)',
        '  --skip-smoke          Skip live Vietnamese smoke generation test',
      ].join('\n'),
    );
    return;
  }

  const ollamaBaseUrl = (
    process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434'
  ).replace(/\/+$/, '');

  // 1. Check Host Ollama daemon health
  const tagsBefore = await fetchOllamaTags(ollamaBaseUrl);

  if (opts.rollback) {
    const baseEntry = findModelInTags(tagsBefore, opts.baseModel);
    if (!baseEntry) {
      throw new Error(
        `Rollback baseline model "${opts.baseModel}" not found on Ollama (${ollamaBaseUrl}). Run: ollama pull ${opts.baseModel}`,
      );
    }
    const smoke = opts.skipSmoke
      ? null
      : await runVietnameseSmokeTest(opts.baseModel, ollamaBaseUrl);

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: 'ROLLBACK_VERIFIED',
          ollamaBaseUrl,
          rollbackTargetModel: baseEntry.name,
          digest: baseEntry.digest,
          smokeTest: smoke,
        },
        null,
        2,
      ),
    );
    printActivationAndRollbackGuide(opts.model, opts.baseModel);
    return;
  }

  // 2. Read Modelfile
  if (!fs.existsSync(opts.modelfile)) {
    throw new Error(`Modelfile not found: ${opts.modelfile}`);
  }
  const modelfileText = fs.readFileSync(opts.modelfile, 'utf8');
  const directives = parseModelfileDirectives(modelfileText);

  // 3. Build custom Ollama model (CLI first, automatic HTTP /api/create fallback)
  let buildResult = tryCreateViaCli(opts.model, opts.modelfile, ollamaBaseUrl);
  if (!buildResult.ok) {
    const fallback = await createViaHttpApi(
      opts.model,
      modelfileText,
      ollamaBaseUrl,
    );
    buildResult = {
      ...fallback,
      cliFallbackReason: buildResult.reason,
    };
  }

  // 4. Verify model appears in /api/tags
  const tagsAfter = await fetchOllamaTags(ollamaBaseUrl);
  const createdEntry = findModelInTags(tagsAfter, opts.model);
  if (!createdEntry) {
    throw new Error(
      `Model "${opts.model}" was created but did not appear in ${ollamaBaseUrl}/api/tags`,
    );
  }

  // 5. Execute real Vietnamese smoke generation measuring tokens/s
  const smoke = opts.skipSmoke
    ? null
    : await runVietnameseSmokeTest(opts.model, ollamaBaseUrl);

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: 'CUSTOM_MODEL_BUILT',
        ollamaBaseUrl,
        model: createdEntry.name,
        baseFrom: directives.from,
        modelfile: path.relative(REPO_ROOT, opts.modelfile).replace(/\\/g, '/'),
        buildMethod: buildResult.method,
        digest: createdEntry.digest,
        parameterSize: createdEntry.details?.parameter_size ?? null,
        quantization: createdEntry.details?.quantization_level ?? null,
        capabilities: createdEntry.capabilities ?? [],
        smokeTest: smoke,
      },
      null,
      2,
    ),
  );

  printActivationAndRollbackGuide(opts.model, opts.baseModel);
}

main().catch((err) => {
  console.error('[ai:build-model] Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
