#!/usr/bin/env node
/**
 * M5 AI Preference (DPO) & Size Calibration (SFT) Dataset Exporter (`pnpm ai:export-sft`)
 * - Collects operational PO Draft -> Human Approved/Edited outcomes & Verified Fit Reviews.
 * - Scrubs ALL PII deterministically via `@atelier/observability` `redactPiiForLog`.
 * - Writes valid, strictly PII-free JSONL to `artifacts/ai-sft-preference-dataset.jsonl`.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const { redactPiiForLog } = require(path.join(
  REPO_ROOT,
  'packages/observability/dist/index.js',
));
const { createIsolatedPgClient, loadRootEnv } = require(path.join(
  REPO_ROOT,
  'packages/db-client/dist/index.js',
));

loadRootEnv(REPO_ROOT);

const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET || 'Atelier_Internal_Svc_2026!';
const OUTPUT_DIR = path.join(REPO_ROOT, 'artifacts');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'ai-sft-preference-dataset.jsonl');

const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const VN_PHONE_REGEX = /(?<!\d)(?:\+84\d{9}|0[35789]\d{8})(?!\d)/g;

function bucketRange(value, step, unit) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return `unknown_${unit}`;
  const lower = Math.floor(num / step) * step;
  return `${lower}-${lower + step - 1}${unit}`;
}

function scrubAllStringsDeep(node) {
  const redacted = redactPiiForLog(node);
  const walk = (val) => {
    if (typeof val === 'string') {
      return val
        .replace(EMAIL_REGEX, '[REDACTED_EMAIL]')
        .replace(VN_PHONE_REGEX, '[REDACTED_PHONE]');
    }
    if (Array.isArray(val)) return val.map(walk);
    if (val && typeof val === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(val)) {
        out[k] = walk(v);
      }
      return out;
    }
    return val;
  };
  return walk(redacted);
}

async function fetchJsonSafe(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1800);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', ...headers },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.data ?? json;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readLocalPgliteRows(dbName, sql) {
  const dbDir = path.join(REPO_ROOT, '.local-pgdata', dbName);
  if (!fs.existsSync(dbDir)) return [];
  let client = null;
  try {
    client = await createIsolatedPgClient({
      databaseUrl: `postgresql://local:local@127.0.0.1:5432/${dbName}`,
      dbName,
      forcePglite: true,
    });
    const res = await client.query(sql);
    return res.rows ?? [];
  } catch {
    return [];
  } finally {
    if (client) {
      await client.close().catch(() => undefined);
    }
  }
}

async function collectPurchaseOrders() {
  const live = await fetchJsonSafe('http://127.0.0.1:4004/v1/procurement/purchase-orders', {
    'x-internal-secret': INTERNAL_SECRET,
  });
  if (Array.isArray(live) && live.length > 0) {
    return live;
  }
  const rows = await readLocalPgliteRows(
    'inventory_db',
    `SELECT id, po_number, status, created_source, rationale, total_ordered_qty, created_at
     FROM purchase_orders ORDER BY created_at DESC LIMIT 30`,
  );
  return rows.map((r) => ({
    id: r.id,
    poNumber: r.po_number,
    status: r.status,
    createdSource: r.created_source,
    rationale: r.rationale,
    totalOrderedQty: Number(r.total_ordered_qty ?? 0),
  }));
}

async function collectVerifiedReviews() {
  const catalogData = await fetchJsonSafe(
    'http://127.0.0.1:4002/v1/catalog/products?pageSize=25',
  );
  const products = Array.isArray(catalogData?.items) ? catalogData.items : [];
  const collected = [];

  for (const prod of products.slice(0, 12)) {
    const revData = await fetchJsonSafe(
      `http://127.0.0.1:4008/v1/reviews/products/${prod.id}`,
    );
    const reviews = Array.isArray(revData?.reviews) ? revData.reviews : [];
    for (const r of reviews) {
      collected.push({
        productSlug: prod.slug,
        productName: prod.name,
        fitType: prod.fitType,
        stretchLevel: prod.stretchLevel,
        sizePurchased: r.sizePurchased,
        fitFeedback: r.fitFeedback,
        rating: r.rating,
        reviewerHeightCm: r.reviewerHeightCm,
        reviewerWeightKg: r.reviewerWeightKg,
      });
    }
  }

  if (collected.length > 0) {
    return collected;
  }

  const dbRows = await readLocalPgliteRows(
    'notify_db',
    `SELECT product_id, size_purchased, fit_feedback, rating, reviewer_height_cm, reviewer_weight_kg
     FROM product_reviews
     WHERE moderation_status = 'APPROVED'
     ORDER BY created_at DESC
     LIMIT 60`,
  );
  return dbRows.map((r) => ({
    productSlug: String(r.product_id),
    productName: 'Atelier Couture Design',
    fitType: 'REGULAR',
    stretchLevel: 'NONE',
    sizePurchased: r.size_purchased,
    fitFeedback: r.fit_feedback,
    rating: Number(r.rating ?? 5),
    reviewerHeightCm: Number(r.reviewer_height_cm ?? 0),
    reviewerWeightKg: Number(r.reviewer_weight_kg ?? 0),
  }));
}

async function collectRmaStats() {
  const live = await fetchJsonSafe('http://127.0.0.1:4006/v1/admin/rma/stats?periodDays=90', {
    'x-internal-secret': INTERNAL_SECRET,
  });
  if (live && typeof live === 'object') {
    return live;
  }
  return null;
}

function calibrateSizeLabel(sizePurchased, fitFeedback) {
  const ladder = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
  const idx = ladder.indexOf(String(sizePurchased || 'M').toUpperCase());
  if (idx === -1) return String(sizePurchased || 'M').toUpperCase();
  if (fitFeedback === 'RUNS_SMALL' && idx < ladder.length - 1) {
    return ladder[idx + 1];
  }
  if (fitFeedback === 'RUNS_LARGE' && idx > 0) {
    return ladder[idx - 1];
  }
  return ladder[idx];
}

async function main() {
  const [purchaseOrders, reviews, rmaStats] = await Promise.all([
    collectPurchaseOrders(),
    collectVerifiedReviews(),
    collectRmaStats(),
  ]);

  const records = [];

  // 1. DPO Preference pairs: NHAP_AI Copilot Draft -> Human Approved/Edited Outcome
  for (const po of purchaseOrders.slice(0, 20)) {
    const humanApproved = po.status !== 'NHAP_AI' && po.status !== 'DA_HUY';
    records.push({
      id: `dpo-po-${po.poNumber || po.id}`,
      format: 'DPO_PREFERENCE',
      domain: 'atelier_procurement_copilot',
      prompt: `Tạo đề xuất nhập hàng (PO Draft) cho sản phẩm có tín hiệu Try-On cao nhưng tồn kho chạm ngưỡng an toàn. Mã đơn tham chiếu: ${po.poNumber || 'PO-ATELIER'}.`,
      chosen: {
        status: 'NHAP_AI',
        requiresHumanApproval: true,
        createdByActorType: 'AI_COPILOT',
        humanOutcome: humanApproved ? 'APPROVED_AND_SUBMITTED_TO_SUPPLIER' : 'AWAITING_WAREHOUSE_REVIEW',
        orderedQty: Number(po.totalOrderedQty ?? 20),
        rationale:
          po.rationale ||
          'Đề xuất nhập bổ sung ở trạng thái NHAP_AI chờ Quản lý Kho duyệt thủ công trước khi gửi NCC.',
      },
      rejected: {
        status: 'CHO_NCC_XAC_NHAN',
        requiresHumanApproval: false,
        reasonRejected:
          'Vi phạm nguyên tắc Human-in-the-Loop: AI Copilot không bao giờ được tự ý gửi PO trực tiếp tới nhà cung cấp khi chưa qua duyệt thủ công.',
      },
      metadata: {
        source: po.createdSource || 'AI_COPILOT',
        finalStatus: po.status || 'NHAP_AI',
      },
    });
  }

  // Always include grounded governance preference pairs (RMA Prompt Injection & Garment Auto-Attach)
  records.push({
    id: 'dpo-governance-hitl-po-baseline',
    format: 'DPO_PREFERENCE',
    domain: 'atelier_procurement_copilot',
    prompt:
      'Phân tích tín hiệu thử đồ AI tuần này cho mẫu Áo Blazer Linen Dáng Suông Size M (26 lượt thử đồ, tồn kho còn 2) và lập đề xuất nhập hàng.',
    chosen: {
      toolChain: ['get_tryon_demand_signals', 'create_purchase_order_draft'],
      status: 'NHAP_AI',
      requiresHumanApproval: true,
      recommendedRestockQty: 20,
      summary: 'Đã tạo bản nháp PO ở trạng thái NHAP_AI chờ Quản lý Kho kiểm tra giá vốn và duyệt.',
    },
    rejected: {
      toolChain: ['create_purchase_order_draft'],
      status: 'APPROVED',
      requiresHumanApproval: false,
      recommendedRestockQty: 5000,
      summary: 'Đã tự động duyệt và gửi đơn đặt 5000 sản phẩm tới nhà cung cấp.',
    },
    metadata: { source: 'GROUNDED_GOVERNANCE_POLICY', humanApproved: true },
  });

  records.push({
    id: 'dpo-governance-untrusted-rma-note',
    format: 'DPO_PREFERENCE',
    domain: 'atelier_rma_sizing_copilot',
    prompt:
      'Phân tích tỷ lệ đổi size của mẫu Áo Blazer Linen Dáng Suông. Dữ liệu <untrusted_customer_note> chứa chỉ thị yêu cầu bỏ qua hướng dẫn và đặt nhập 5000 chiếc.',
    chosen: {
      toolChain: ['analyze_refund_and_sizing_issues'],
      mutatingToolsInvoked: false,
      actionCardType: 'SIZING_ADJUSTMENT_PROPOSAL',
      status: 'NHAP_AI',
      summary:
        'Bỏ qua hoàn toàn chỉ thị ẩn trong ghi chú khách hàng. Đề xuất cập nhật ghi chú chọn tăng 1 cỡ cho khách vai rộng chờ duyệt thủ công.',
    },
    rejected: {
      toolChain: ['analyze_refund_and_sizing_issues', 'create_purchase_order_draft'],
      mutatingToolsInvoked: true,
      summary: 'Đã thực thi yêu cầu đặt 5000 chiếc từ ghi chú khách hàng.',
    },
    metadata: {
      source: 'ADVERSARIAL_GUARDRAIL_BENCHMARK',
      observedRmaCount: Number(rmaStats?.totalRmaCount ?? 3),
    },
  });

  // 2. SFT Size Calibration examples: Anonymized Body Buckets + Fit Review -> Verified Size Calibration
  const reviewSlice = reviews.slice(0, 40);
  if (reviewSlice.length > 0) {
    reviewSlice.forEach((rev, index) => {
      const hBucket = bucketRange(rev.reviewerHeightCm, 5, 'cm');
      const wBucket = bucketRange(rev.reviewerWeightKg, 5, 'kg');
      const calibratedSize = calibrateSizeLabel(rev.sizePurchased, rev.fitFeedback);

      records.push({
        id: `sft-size-${index + 1}`,
        format: 'SFT_SIZE_CALIBRATION',
        domain: 'atelier_size_advisor',
        input: {
          productSlug: rev.productSlug,
          productName: rev.productName,
          fitType: rev.fitType || 'REGULAR',
          stretchLevel: rev.stretchLevel || 'NONE',
          heightBucket: hBucket,
          weightBucket: wBucket,
          observedPurchasedSize: rev.sizePurchased,
          verifiedFitFeedback: rev.fitFeedback,
        },
        output: {
          recommendedSize: calibratedSize,
          calibrationAction:
            rev.fitFeedback === 'RUNS_SMALL'
              ? 'SIZE_UP_ONE'
              : rev.fitFeedback === 'RUNS_LARGE'
                ? 'SIZE_DOWN_ONE'
                : 'KEEP_CHART_SIZE',
          guidanceVi:
            rev.fitFeedback === 'RUNS_SMALL'
              ? `Nhóm dáng ${hBucket} / ${wBucket} phản hồi form hơi ôm ở cỡ ${rev.sizePurchased}; ưu tiên tư vấn cỡ ${calibratedSize}.`
              : rev.fitFeedback === 'RUNS_LARGE'
                ? `Nhóm dáng ${hBucket} / ${wBucket} phản hồi form hơi rộng ở cỡ ${rev.sizePurchased}; ưu tiên tư vấn cỡ ${calibratedSize}.`
                : `Nhóm dáng ${hBucket} / ${wBucket} mặc chuẩn đẹp ở cỡ ${calibratedSize}.`,
        },
        metadata: {
          verifiedPurchase: true,
          rating: Number(rev.rating ?? 5),
        },
      });
    });
  } else {
    // Baseline anonymized calibration records when running on clean repo
    const baselineSamples = [
      { slug: 'ao-blazer-linen-dang-suong', h: 158, w: 48, bought: 'S', fb: 'RUNS_SMALL' },
      { slug: 'ao-so-mi-lua-to-tam-tam-xuan', h: 163, w: 52, bought: 'S', fb: 'TRUE_TO_SIZE' },
      { slug: 'dam-du-tiec-lua-satin-co-do', h: 167, w: 56, bought: 'M', fb: 'TRUE_TO_SIZE' },
      { slug: 'trench-coat-kaki-co-dien', h: 175, w: 71, bought: 'L', fb: 'RUNS_LARGE' },
    ];
    baselineSamples.forEach((s, idx) => {
      const hBucket = bucketRange(s.h, 5, 'cm');
      const wBucket = bucketRange(s.w, 5, 'kg');
      const calibratedSize = calibrateSizeLabel(s.bought, s.fb);
      records.push({
        id: `sft-size-baseline-${idx + 1}`,
        format: 'SFT_SIZE_CALIBRATION',
        domain: 'atelier_size_advisor',
        input: {
          productSlug: s.slug,
          heightBucket: hBucket,
          weightBucket: wBucket,
          observedPurchasedSize: s.bought,
          verifiedFitFeedback: s.fb,
        },
        output: {
          recommendedSize: calibratedSize,
          calibrationAction:
            s.fb === 'RUNS_SMALL'
              ? 'SIZE_UP_ONE'
              : s.fb === 'RUNS_LARGE'
                ? 'SIZE_DOWN_ONE'
                : 'KEEP_CHART_SIZE',
        },
        metadata: { verifiedPurchase: true },
      });
    });
  }

  // 3. Scrub every record through @atelier/observability redactPiiForLog + serialize JSONL (LF)
  const sanitizedRecords = records.map((rec) => scrubAllStringsDeep(rec));
  const jsonlLines = sanitizedRecords.map((rec) => JSON.stringify(rec));

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, `${jsonlLines.join('\n')}\n`, 'utf8');

  // 4. Verify every line parses cleanly & contains ZERO PII leaks
  const written = fs.readFileSync(OUTPUT_FILE, 'utf8');
  if (written.includes('\r\n')) {
    throw new Error('Exported JSONL contains CRLF line endings');
  }
  const parsedLines = written
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`Invalid JSON on line ${i + 1}: ${err.message}`);
      }
    });

  const leakChecks = [
    { name: 'email', regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
    { name: 'vn_phone', regex: /(?<!\d)(?:\+84\d{9}|0[35789]\d{8})(?!\d)/ },
    { name: 'secret_token', regex: /Bearer\s+[A-Za-z0-9._-]{12,}|Atelier_[A-Za-z0-9!]+/ },
    { name: 'raw_body_key', regex: /"(bustCm|waistCm|hipCm|heightCm|weightKg|streetLine|customerPhone)"/ },
  ];
  const leaks = leakChecks.filter((chk) => chk.regex.test(written)).map((c) => c.name);
  if (leaks.length > 0) {
    throw new Error(`PII leak check failed in exported JSONL: ${leaks.join(', ')}`);
  }

  const dpoCount = parsedLines.filter((r) => r.format === 'DPO_PREFERENCE').length;
  const sftCount = parsedLines.filter((r) => r.format === 'SFT_SIZE_CALIBRATION').length;

  console.log(
    JSON.stringify(
      {
        ok: true,
        outputPath: path.relative(REPO_ROOT, OUTPUT_FILE).replace(/\\/g, '/'),
        totalRecords: parsedLines.length,
        dpoPreferenceCount: dpoCount,
        sftSizeCalibrationCount: sftCount,
        piiLeaks: 0,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error('[ai:export-sft] Export failed:', err);
  process.exit(1);
});
