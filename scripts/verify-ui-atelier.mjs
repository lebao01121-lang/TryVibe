#!/usr/bin/env node
/**
 * Atelier UI Design Token, Isolation & CWV Guardrail Verifier (`pnpm verify:ui`)
 * fashion-atelier-ai-platform (v3.0)
 *
 * Verifies:
 *   1. Exact Quiet Luxury CSS palette tokens (#FBF7EF, #F4EBDA, #EBD9B4, #B08A4A, #EBCF8F, #1C1410, #2B2019)
 *      and 3 typography families (Cormorant Garamond, Be Vietnam Pro, Dancing Script).
 *   2. Zero portal/internal/cost leaks in apps/storefront/src/**
 *      (no /admin, /partner, admin-portal, partner-portal, McpCopilot, costPriceVnd, fake size %).
 *   3. Editorial & CWV invariants: NFC normalization, HeroEditorial fetchPriority="high" + webm/mp4,
 *      100svh/100dvh + ignoreMobileResize, CSS aspect-ratio tokens, GPU/Worker/Camera cleanup hooks
 *      (dispose / terminate / track.stop), W3C traceparent client header, and error.tsx on all 3 portals.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

function walkFiles(dirPath, filterRegex = /\.(ts|tsx|js|jsx|mjs|css|scss)$/) {
  const out = [];
  if (!fs.existsSync(dirPath)) return out;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') continue;
      out.push(...walkFiles(full, filterRegex));
    } else if (!filterRegex || filterRegex.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function readAllText(files) {
  return files.map((f) => ({ file: f, rel: path.relative(ROOT_DIR, f).replace(/\\/g, '/'), text: fs.readFileSync(f, 'utf8') }));
}

const checks = [];
function addCheck(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} — ${detail}`);
}

console.log('========================================================================');
console.log(' fashion-atelier-ai-platform (v3.0) — Atelier UI & Isolation Gate');
console.log('========================================================================');

const tokenFiles = readAllText(walkFiles(path.join(ROOT_DIR, 'packages', 'ui-tokens', 'src')));
const storefrontFiles = readAllText(walkFiles(path.join(ROOT_DIR, 'apps', 'storefront', 'src')));
const combinedTokensAndStorefront = [...tokenFiles, ...storefrontFiles].map((f) => f.text).join('\n');
const combinedStorefront = storefrontFiles.map((f) => f.text).join('\n');

// 1. Quiet Luxury color tokens
const requiredHexTokens = ['#FBF7EF', '#F4EBDA', '#EBD9B4', '#B08A4A', '#EBCF8F', '#1C1410', '#2B2019'];
const missingColors = requiredHexTokens.filter(
  (hex) => !new RegExp(hex.replace('#', '#'), 'i').test(combinedTokensAndStorefront),
);
addCheck(
  'Quiet Luxury Palette Tokens',
  missingColors.length === 0,
  missingColors.length === 0
    ? `All ${requiredHexTokens.length} exact hex tokens present (${requiredHexTokens.join(', ')})`
    : `Missing tokens: ${missingColors.join(', ')}`,
);

// 2. Three brand fonts
const requiredFonts = ['Cormorant Garamond', 'Be Vietnam Pro', 'Dancing Script'];
const missingFonts = requiredFonts.filter(
  (font) =>
    !combinedTokensAndStorefront.includes(font) &&
    !combinedTokensAndStorefront.includes(font.replace(/\s+/g, '_')),
);
addCheck(
  'Editorial Brand Typography (3 Fonts)',
  missingFonts.length === 0,
  missingFonts.length === 0
    ? `Verified all 3 fonts (${requiredFonts.join(', ')})`
    : `Missing font families: ${missingFonts.join(', ')}`,
);

// 3. Strict Storefront physical isolation & zero fake size %
const forbiddenPatterns = [
  { label: '/admin route', regex: /['"`]\/admin(?:\/|['"`?])/ },
  { label: '/partner route', regex: /['"`]\/partner(?:\/|['"`?])/ },
  { label: 'admin-portal ref', regex: /admin-portal/i },
  { label: 'partner-portal ref', regex: /partner-portal/i },
  { label: 'McpCopilot ref', regex: /McpCopilot/ },
  { label: 'costPriceVnd ref', regex: /\bcostPriceVnd\b|\bcost_price_vnd\b|\bcost_price\b/ },
  { label: 'hardcoded fake size match %', regex: /\b(?:8[5-9]|9\d)%\s*(?:phù hợp|hợp với|match|fit)/i },
];

const isolationViolations = [];
for (const entry of storefrontFiles) {
  for (const { label, regex } of forbiddenPatterns) {
    if (regex.test(entry.text)) {
      isolationViolations.push(`${entry.rel}: ${label}`);
    }
  }
}
addCheck(
  'Storefront Physical Isolation & Honest Size Advisor Scan',
  isolationViolations.length === 0,
  isolationViolations.length === 0
    ? `Scanned ${storefrontFiles.length} files in apps/storefront/src — 0 violations`
    : `${isolationViolations.length} violation(s): ${isolationViolations.slice(0, 5).join('; ')}`,
);

// 4. Vietnamese NFC normalization on split-letter editorial headings
const hasNfc = /\.normalize\(\s*['"]NFC['"]\s*\)/.test(combinedStorefront);
addCheck(
  'Vietnamese NFC Heading Normalization',
  hasNfc,
  hasNfc ? '.normalize("NFC") present on split-letter headings' : 'Missing .normalize("NFC") in apps/storefront/src',
);

// 5. HeroEditorial LCP fetchPriority="high" + webm/mp4 video sources
const heroFiles = storefrontFiles.filter((f) => /HeroEditorial|hero/i.test(f.rel));
const heroCombined = heroFiles.map((f) => f.text).join('\n');
const hasFetchPriority = /fetchPriority\s*=\s*(?:["']high["']|\{\s*["']high["']\s*\})/i.test(heroCombined);
const hasWebm = /video\/webm|\.webm/i.test(heroCombined);
const hasMp4 = /video\/mp4|\.mp4/i.test(heroCombined);
addCheck(
  'HeroEditorial LCP Poster & Video Sources',
  hasFetchPriority && hasWebm && hasMp4,
  `fetchPriority="high"=${hasFetchPriority}, video/webm=${hasWebm}, video/mp4=${hasMp4}`,
);

// 6. Mobile viewport (100svh / 100dvh) + ScrollTrigger ignoreMobileResize
const hasMobileVh = /100[sd]vh/i.test(combinedStorefront);
const hasIgnoreMobileResize = /ignoreMobileResize\s*:\s*true/.test(combinedStorefront);
addCheck(
  'Mobile Viewport (svh/dvh) & ScrollTrigger ignoreMobileResize',
  hasMobileVh && hasIgnoreMobileResize,
  `100svh/100dvh=${hasMobileVh}, ignoreMobileResize:true=${hasIgnoreMobileResize}`,
);

// 7. Explicit CSS aspect-ratio tokens (CLS < 0.05 guard)
const hasAspectRatio = /aspect-ratio|aspect-\[\d+\/\d+\]|aspect-\d+\/\d+/i.test(combinedStorefront);
addCheck(
  'Explicit CSS Aspect-Ratio CLS Guards',
  hasAspectRatio,
  hasAspectRatio ? 'Explicit aspect-ratio declarations found across storefront components/styles' : 'Missing aspect-ratio rules',
);

// 8. GPU / Web Worker / Camera cleanup hooks
const hasDispose = /\.dispose\s*\(\s*\)/.test(combinedStorefront);
const hasTerminate = /\.terminate\s*\(\s*\)/.test(combinedStorefront);
const hasTrackStop = /\.stop\s*\(\s*\)/.test(combinedStorefront);
addCheck(
  'GPU / Worker / Camera Cleanup Lifecycle',
  hasDispose && hasTerminate && hasTrackStop,
  `dispose()=${hasDispose}, worker.terminate()=${hasTerminate}, track.stop()=${hasTrackStop}`,
);

// 9. W3C traceparent header propagation on storefront api-client
const hasTraceparent = /traceparent/i.test(combinedStorefront);
addCheck(
  'Storefront W3C traceparent Propagation',
  hasTraceparent,
  hasTraceparent ? 'traceparent header propagation detected in apps/storefront/src' : 'Missing traceparent in storefront API client',
);

// 10. Error Boundary (error.tsx) across ALL 3 Next.js portals
const portalErrorFiles = [
  'apps/storefront/src/app/error.tsx',
  'apps/admin-portal/src/app/error.tsx',
  'apps/partner-portal/src/app/error.tsx',
];
const missingErrorFiles = portalErrorFiles.filter((rel) => !fs.existsSync(path.join(ROOT_DIR, rel)));
addCheck(
  'Error Boundary (error.tsx) Across All 3 Portals',
  missingErrorFiles.length === 0,
  missingErrorFiles.length === 0
    ? `Verified error.tsx in storefront, admin-portal & partner-portal`
    : `Missing error.tsx: ${missingErrorFiles.join(', ')}`,
);

const failed = checks.filter((c) => !c.ok);
console.log('------------------------------------------------------------------------');
console.log(`  UI & Isolation Gate Summary: PASS=${checks.length - failed.length}/${checks.length} | FAIL=${failed.length}`);
console.log('========================================================================');

if (failed.length > 0) {
  process.exit(1);
}
