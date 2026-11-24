#!/usr/bin/env node
/**
 * Frameless Atmospheric Couture — Neural Alpha-Matting Cutout Pipeline.
 *
 * Scans ALL 6 occasions x 4 curated products from
 * `services/catalog-lookbook/src/seed/catalog-seed.ts` (`getCuratedOccasionProducts`)
 * so 24/24 occasion lookbook items have a dedicated 1080x1440 (3:4) pure-alpha
 * editorial cutout (`heroCutoutUrl`), while keeping `lookbookMainUrl` untouched
 * for the 4 framed rectangular thumbnails.
 *
 * Pipeline:
 *   1. Resolves the highest-res raw editorial portrait for each curated slug
 *      under `infra/seeds/real-assets-cache/raw/` (fallback to processed lookbook).
 *   2. Invokes `services/ai-tryon/.venv/Scripts/python.exe` with `rembg`
 *      (`u2net_human_seg` + `alpha_matting=True`, clean fallbacks to
 *      `isnet-general-use` / `u2net`) + SciPy Euclidean Distance Transform
 *      (`distance_transform_edt`) Edge Color Decontamination so semi-transparent
 *      hair & garment border pixels carry strictly clean foreground RGB (ZERO
 *      white/grey halo on BOTH `#EFEAE0`/`#FBF7EF` light and `#1C1410` dark!).
 *   3. Frames every subject cleanly onto a 1080x1440 pure transparent RGBA canvas
 *      (head top at y = 3% [2%..4%], subject filling ~92-96% height, corners
 *      strictly [0, 0, 0, 0]).
 *   4. Encodes via `sharp` (`quality: 92, alphaQuality: 100`) to BOTH:
 *      - `infra/seeds/real-assets-cache/processed/occasion-cutouts/<slug>-cutout-3x4.webp`
 *      - `apps/storefront/public/occasion-cutouts/<slug>-cutout-3x4.webp`
 *   5. Updates `infra/seeds/real-assets-cache/processed/manifest.json` (`occasionCutouts`)
 *      and verifies every cutout's dimensions, alpha channel, and 4 corners `[0,0,0,0]`.
 *
 * Usage:
 *   node scripts/prepare-occasion-frameless-cutouts.mjs
 *   node scripts/prepare-occasion-frameless-cutouts.mjs --only=ao-so-mi-lua-to-tam-tam-xuan
 *   node scripts/prepare-occasion-frameless-cutouts.mjs --contact-sheet=<abs-path.png>
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const CACHE_ROOT = path.join(REPO_ROOT, 'infra', 'seeds', 'real-assets-cache');
const RAW_DIR = path.join(CACHE_ROOT, 'raw');
const PROCESSED_DIR = path.join(CACHE_ROOT, 'processed');
const PROCESSED_CUTOUT_DIR = path.join(PROCESSED_DIR, 'occasion-cutouts');
const PUBLIC_CUTOUT_DIR = path.join(
  REPO_ROOT,
  'apps',
  'storefront',
  'public',
  'occasion-cutouts',
);
const CATALOG_SEED_PATH = path.join(
  REPO_ROOT,
  'services',
  'catalog-lookbook',
  'src',
  'seed',
  'catalog-seed.ts',
);
const PREPARE_ASSETS_PATH = path.join(
  REPO_ROOT,
  'scripts',
  'prepare-real-fashion-assets.mjs',
);

const CANVAS_W = 1080;
const CANVAS_H = 1440;

async function loadSharp() {
  const candidates = [
    pathToFileURL(
      path.join(
        REPO_ROOT,
        'services',
        'catalog-lookbook',
        'node_modules',
        'sharp',
        'lib',
        'index.js',
      ),
    ).href,
    'sharp',
  ];
  for (const modPath of candidates) {
    try {
      const mod = await import(modPath);
      return mod.default ?? mod;
    } catch {
      // try next candidate
    }
  }
  throw new Error('Could not load sharp for frameless cutout encoding/audit.');
}

function findPythonExecutable() {
  const candidates = [
    path.join(REPO_ROOT, 'services', 'ai-tryon', '.venv', 'Scripts', 'python.exe'),
    path.join(REPO_ROOT, 'services', 'ai-tryon', '.venv', 'bin', 'python'),
    process.env.PYTHON_BIN,
    'python',
  ].filter(Boolean);

  for (const cand of candidates) {
    if (cand === 'python' || fs.existsSync(cand)) {
      return cand;
    }
  }
  throw new Error('Could not find Python executable with rembg installed.');
}

/**
 * Parses `OCCASIONS_SEED` and `PRODUCTS_SEED` directly from `catalog-seed.ts`
 * and executes the exact `getCuratedOccasionProducts` selection logic.
 */
function scanCuratedOccasionProducts() {
  const seedSrc = fs.readFileSync(CATALOG_SEED_PATH, 'utf8');

  const occBlockMatch = seedSrc.match(
    /const OCCASIONS_SEED\s*=\s*\[([\s\S]*?)\]\s*as const;/,
  );
  if (!occBlockMatch) {
    throw new Error('Failed to locate OCCASIONS_SEED in catalog-seed.ts');
  }
  const occasionSlugs = Array.from(
    occBlockMatch[1].matchAll(/slug:\s*'([^']+)'/g),
    (m) => m[1],
  );
  if (occasionSlugs.length !== 6) {
    throw new Error(
      `Expected 6 occasions in OCCASIONS_SEED, found ${occasionSlugs.length}`,
    );
  }

  const prodBlockMatch = seedSrc.match(
    /const PRODUCTS_SEED:\s*readonly SeedProductDef\[\]\s*=\s*\[([\s\S]*?)\n\];/,
  );
  if (!prodBlockMatch) {
    throw new Error('Failed to locate PRODUCTS_SEED in catalog-seed.ts');
  }

  const products = [];
  const prodRe = /slug:\s*'([^']+)'[\s\S]*?occasionSlugs:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = prodRe.exec(prodBlockMatch[1])) !== null) {
    const slug = m[1];
    const occList = Array.from(m[2].matchAll(/'([^']+)'/g), (x) => x[1]);
    products.push({ slug, occasionSlugs: occList });
  }

  const byOccasion = [];
  const uniqueSlugs = [];
  const seen = new Set();

  for (const occSlug of occasionSlugs) {
    const primary = products.filter((p) => p.occasionSlugs.includes(occSlug));
    const selected = [...primary];
    if (selected.length < 4) {
      for (const cand of products) {
        if (selected.length >= 4) break;
        if (!selected.some((p) => p.slug === cand.slug)) {
          selected.push(cand);
        }
      }
    }
    const top4 = selected.slice(0, 4).map((p) => p.slug);
    byOccasion.push({ occasionSlug: occSlug, slugs: top4 });
    for (const slug of top4) {
      if (!seen.has(slug)) {
        seen.add(slug);
        uniqueSlugs.push(slug);
      }
    }
  }

  return { byOccasion, uniqueSlugs };
}

/**
 * Reads `prepare-real-fashion-assets.mjs` to map each slug to its highest-res
 * editorial portrait photo in `infra/seeds/real-assets-cache/raw/`, falling back
 * to `processed/products/<slug>/<slug>-lookbook-3x4.webp`.
 */
function buildRawSourceMap() {
  const map = new Map();
  if (fs.existsSync(PREPARE_ASSETS_PATH)) {
    const src = fs.readFileSync(PREPARE_ASSETS_PATH, 'utf8');
    const chunks = src.split(/\n\s*\{\s*\n\s*slug:\s*'/);
    for (let i = 1; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const slugEnd = chunk.indexOf("'");
      if (slugEnd <= 0) continue;
      const slug = chunk.slice(0, slugEnd);
      const lookbookMatch = chunk.match(
        /lookbookEditorial:\s*\{[\s\S]*?rawName:\s*'([^']+)'/,
      );
      const rawMatch = chunk.match(/rawName:\s*'([^']+)'/);
      const preferred = [];
      if (lookbookMatch?.[1]) preferred.push(lookbookMatch[1]);
      if (rawMatch?.[1] && !preferred.includes(rawMatch[1])) {
        preferred.push(rawMatch[1]);
      }
      map.set(slug, preferred);
    }
  }
  return map;
}

function resolveBestSourcePhoto(slug, rawSourceMap) {
  const candidates = [];
  const rawNames = rawSourceMap.get(slug) ?? [];
  for (const rawName of rawNames) {
    candidates.push(path.join(RAW_DIR, rawName));
  }
  candidates.push(
    path.join(PROCESSED_DIR, 'products', slug, `${slug}-lookbook-3x4.webp`),
    path.join(PROCESSED_DIR, 'products', slug, 'lookbook.webp'),
  );

  for (const cand of candidates) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
      return cand;
    }
  }
  throw new Error(
    `No raw or processed lookbook source photo found for curated slug '${slug}'`,
  );
}

/**
 * Per-slug optional fine-tuning knobs (only where raw composition benefits from
 * slightly tighter initial crop or alpha threshold tweaks).
 */
const SLUG_TUNING = {
  // Warm sunlit rattan terrace portrait: model sits in cream silk blouse + white trousers
  'ao-so-mi-lua-to-tam-tam-xuan': {
    erodeCorePx: 2,
    headTopPct: 0.03,
    targetHeightPct: 0.945,
  },
  // Afro curly hair + cream pleated midi skirt next to wooden frames
  'chan-vay-xep-ly-midi-cap-cao': {
    erodeCorePx: 2,
    headTopPct: 0.028,
    targetHeightPct: 0.945,
  },
  // Sitting on dark desk in studio: keep purely the seated model, generous vertical fill
  'quan-tay-ong-suong-xep-ly-doi': {
    erodeCorePx: 2,
    headTopPct: 0.03,
    targetHeightPct: 0.94,
  },
  // Light cream blazer in front of bright white sheer curtains
  'ao-blazer-linen-dang-suong': {
    erodeCorePx: 2,
    headTopPct: 0.03,
    targetHeightPct: 0.945,
  },
  // Crimson satin gown on warm bronze backdrop
  'dam-du-tiec-lua-satin-co-do': {
    erodeCorePx: 1,
    headTopPct: 0.03,
    targetHeightPct: 0.945,
  },
  // Organza wrap blouse seated on wooden stool with cotton branch
  'ao-kieu-lua-organza-phoi-no': {
    erodeCorePx: 2,
    headTopPct: 0.03,
    targetHeightPct: 0.94,
  },
  // Raised arms in oatmeal merino cardigan: clean studio backdrop, intersect with isnet + strip residual cool-gray arm-loop wall patch
  'ao-cardigan-len-merino-khuy-sung': {
    erodeCorePx: 2,
    headTopPct: 0.03,
    targetHeightPct: 0.94,
    intersectIsnet: true,
    cleanCoolGrayHole: true,
  },
};

const PYTHON_PIPELINE = String.raw`#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageOps
from rembg import new_session, remove
from scipy import ndimage

CANVAS_W = 1080
CANVAS_H = 1440


def load_human_session():
    for model_name in ("u2net_human_seg", "isnet-general-use", "u2net"):
        try:
            t0 = time.time()
            sess = new_session(model_name)
            print(f"[cutout:py] loaded rembg session '{model_name}' in {time.time() - t0:.2f}s", flush=True)
            return model_name, sess
        except Exception as err:
            print(f"[cutout:py] warning: could not load '{model_name}': {err}", flush=True)
    raise RuntimeError("No rembg model session could be initialized.")


def remove_small_components(alpha_u8: np.ndarray, min_ratio: float = 0.025) -> np.ndarray:
    mask = alpha_u8 >= 14
    labeled, num_features = ndimage.label(mask)
    if num_features <= 1:
        return alpha_u8
    sizes = ndimage.sum(mask, labeled, range(1, num_features + 1))
    max_size = float(np.max(sizes))
    if max_size <= 0:
        return alpha_u8
    keep_ids = [
        idx + 1
        for idx, sz in enumerate(sizes)
        if float(sz) >= max_size * min_ratio
    ]
    keep_mask = np.isin(labeled, keep_ids)
    # Dilate kept mask by 2px so soft anti-aliased hair wisps right next to kept subject survive
    keep_mask = ndimage.binary_dilation(keep_mask, iterations=2)
    return np.where(keep_mask, alpha_u8, 0).astype(np.uint8)


def decontaminate_edges(
    arr: np.ndarray,
    opaque_thresh: int = 215,
    erode_core_px: int = 2,
    zero_exterior_beyond_px: int | None = None,
) -> np.ndarray:
    """
    Replace background-contaminated RGB on semi-transparent hair/garment pixels
    (0 < alpha < opaque_thresh) with the nearest strictly opaque foreground RGB
    via SciPy Euclidean Distance Transform (distance_transform_edt), preserving
    the smooth antialiased alpha channel.
    """
    out = arr.copy()
    alpha = out[:, :, 3]
    # Suppress ultra-faint residual background dust so dark #1C1410 never shows a ghost box
    alpha = np.where(alpha < 10, 0, alpha).astype(np.uint8)
    out[:, :, 3] = alpha

    core = alpha >= opaque_thresh
    if core.sum() < 400:
        core = alpha >= 180
    if core.sum() < 100:
        return out

    clean_core = core
    if erode_core_px > 0:
        eroded = ndimage.binary_erosion(core, iterations=erode_core_px)
        if eroded.sum() >= max(200, int(core.sum() * 0.45)):
            clean_core = eroded

    _, nearest_idx = ndimage.distance_transform_edt(~clean_core, return_indices=True)
    clean_rgb = out[:, :, :3][nearest_idx[0], nearest_idx[1]]

    # Replace RGB for all semi-transparent and exterior pixels while keeping opaque core intact
    needs_clean = ~clean_core
    out[:, :, :3] = np.where(needs_clean[:, :, None], clean_rgb, out[:, :, :3])

    if zero_exterior_beyond_px is not None:
        fg_any = alpha > 0
        dist_from_fg = ndimage.distance_transform_edt(~fg_any)
        far_zero = (~fg_any) & (dist_from_fg > float(zero_exterior_beyond_px))
        out[far_zero] = 0

    return out


def extract_subject_rgba(
    img_rgb: Image.Image,
    session: Any,
    erode_core_px: int = 2,
    isnet_session: Any | None = None,
    clean_cool_gray_hole: bool = False,
) -> tuple[np.ndarray, bool]:
    used_matting = False
    try:
        rgba_im = remove(
            img_rgb,
            session=session,
            alpha_matting=True,
            alpha_matting_foreground_threshold=240,
            alpha_matting_background_threshold=15,
            alpha_matting_erode_size=8,
        ).convert("RGBA")
        arr = np.array(rgba_im, dtype=np.uint8)
        cov = float((arr[:, :, 3] >= 20).mean())
        if cov < 0.04:
            raise ValueError(f"alpha matting coverage too low ({cov:.4f})")
        used_matting = True
    except Exception as err:
        print(f"[cutout:py] alpha_matting fallback triggered: {err}", flush=True)
        rgba_im = remove(
            img_rgb,
            session=session,
            post_process_mask=True,
        ).convert("RGBA")
        arr = np.array(rgba_im, dtype=np.uint8)

    if isnet_session is not None:
        try:
            isnet_im = remove(
                img_rgb,
                session=isnet_session,
                alpha_matting=True,
                alpha_matting_foreground_threshold=240,
                alpha_matting_background_threshold=15,
                alpha_matting_erode_size=6,
            ).convert("RGBA")
        except Exception:
            isnet_im = remove(
                img_rgb,
                session=isnet_session,
                post_process_mask=True,
            ).convert("RGBA")
        isnet_alpha = np.array(isnet_im, dtype=np.uint8)[:, :, 3]
        if float((isnet_alpha >= 20).mean()) >= 0.08:
            arr[:, :, 3] = np.minimum(arr[:, :, 3], isnet_alpha)

    if clean_cool_gray_hole:
        # Remove any tiny residual neutral/cool light-gray studio wall patch trapped
        # inside the upper arm arch above the head (hair is dark, skin/cardigan are warm).
        rgb_f = arr[:, :, :3].astype(np.float32)
        h_img = rgb_f.shape[0]
        r_ch, g_ch, b_ch = rgb_f[:, :, 0], rgb_f[:, :, 1], rgb_f[:, :, 2]
        lum = 0.299 * r_ch + 0.587 * g_ch + 0.114 * b_ch
        chroma = np.maximum(np.maximum(r_ch, g_ch), b_ch) - np.minimum(np.minimum(r_ch, g_ch), b_ch)
        is_wall = (lum >= 165.0) & (chroma <= 18.0) & (b_ch >= r_ch - 4.0)
        upper_band = np.zeros_like(is_wall)
        upper_band[: int(h_img * 0.38), :] = True
        wall_upper = is_wall & upper_band
        # Keep only wall patches touching/near already-transparent backdrop (or upper arm-hole)
        near_bg = ndimage.binary_dilation(arr[:, :, 3] < 220, iterations=45)
        punch = ndimage.binary_dilation(wall_upper & near_bg, iterations=2)
        soft_punch = ndimage.gaussian_filter(punch.astype(np.float32), sigma=1.2)
        arr[:, :, 3] = np.clip(np.round(arr[:, :, 3].astype(np.float32) * (1.0 - np.clip(soft_punch * 1.4, 0.0, 1.0))), 0, 255).astype(np.uint8)

    # Tighten ultra-faint dust & drop tiny stray background components
    alpha = arr[:, :, 3]
    alpha = np.where(alpha < 10, 0, alpha).astype(np.uint8)
    alpha = remove_small_components(alpha, min_ratio=0.025)
    arr[:, :, 3] = alpha

    # Pre-resize full-canvas decontamination so Lanczos never blends sky/curtain RGB into edges
    arr = decontaminate_edges(
        arr,
        opaque_thresh=215,
        erode_core_px=erode_core_px,
        zero_exterior_beyond_px=None,
    )
    return arr, used_matting


def frame_on_canvas(
    arr: np.ndarray,
    head_top_pct: float = 0.03,
    target_height_pct: float = 0.945,
    erode_core_px: int = 2,
) -> tuple[Image.Image, dict[str, Any]]:
    alpha = arr[:, :, 3]
    ys, xs = np.where(alpha >= 12)
    if len(xs) == 0 or len(ys) == 0:
        raise ValueError("Extracted alpha mask is empty.")

    h, w = alpha.shape
    pad = 4
    x0 = max(0, int(xs.min()) - pad)
    y0 = max(0, int(ys.min()) - pad)
    x1 = min(w, int(xs.max()) + pad + 1)
    y1 = min(h, int(ys.max()) + pad + 1)

    cropped_arr = arr[y0:y1, x0:x1]
    crop_h, crop_w = cropped_arr.shape[:2]

    top_y = int(round(CANVAS_H * head_top_pct))  # ~43px (2%..4%)
    margin_x = 18  # guarantees 4 corners strictly transparent [0,0,0,0]
    bottom_margin = max(24, int(round(CANVAS_H * (1.0 - head_top_pct - target_height_pct))))

    max_w = CANVAS_W - 2 * margin_x
    max_h = CANVAS_H - top_y - bottom_margin

    scale = min(max_w / max(1, crop_w), max_h / max(1, crop_h))
    new_w = max(16, int(round(crop_w * scale)))
    new_h = max(16, int(round(crop_h * scale)))

    # If aspect ratio is wider than 3:4 (e.g., seated legs or raised arms), keep height >= 90%
    # if possible by tightening side margin gently to 12px while keeping corners strictly empty.
    if new_h / float(CANVAS_H) < 0.915 and (crop_w / max(1, crop_h)) < 0.85:
        tight_margin_x = 12
        tight_max_w = CANVAS_W - 2 * tight_margin_x
        scale = min(tight_max_w / max(1, crop_w), max_h / max(1, crop_h))
        new_w = max(16, int(round(crop_w * scale)))
        new_h = max(16, int(round(crop_h * scale)))
        margin_x = tight_margin_x

    # Resize RGB and Alpha separately (RGB already bled cleanly into alpha==0)
    rgb_im = Image.fromarray(cropped_arr[:, :, :3], mode="RGB").resize(
        (new_w, new_h), Image.Resampling.LANCZOS
    )
    alpha_im = Image.fromarray(cropped_arr[:, :, 3], mode="L").resize(
        (new_w, new_h), Image.Resampling.LANCZOS
    )

    resized_arr = np.empty((new_h, new_w, 4), dtype=np.uint8)
    resized_arr[:, :, :3] = np.array(rgb_im, dtype=np.uint8)
    resized_arr[:, :, 3] = np.array(alpha_im, dtype=np.uint8)

    # Blend bbox center with upper-third (head/shoulders) centroid so model's head
    # aligns gracefully with the concentric gold wire halo behind head & shoulders.
    r_alpha = resized_arr[:, :, 3]
    upper_slice = r_alpha[: max(1, int(new_h * 0.34)), :]
    _, u_xs = np.where(upper_slice >= 40)
    if len(u_xs) > 20:
        upper_cx = float(u_xs.mean())
        bbox_cx = new_w * 0.5
        desired_cx = 0.65 * upper_cx + 0.35 * bbox_cx
        paste_x = int(round((CANVAS_W * 0.5) - desired_cx))
    else:
        paste_x = (CANVAS_W - new_w) // 2

    paste_x = max(margin_x, min(CANVAS_W - margin_x - new_w, paste_x))
    paste_y = top_y

    canvas = np.zeros((CANVAS_H, CANVAS_W, 4), dtype=np.uint8)
    canvas[paste_y : paste_y + new_h, paste_x : paste_x + new_w] = resized_arr

    # Final Edge Color Decontamination on 1080x1440 canvas:
    # - Clean nearest foreground RGB on semi-transparent edges + 8px exterior safety ring
    # - Strictly [0, 0, 0, 0] everywhere beyond 8px (guarantees all 4 corners == [0,0,0,0]!)
    canvas = decontaminate_edges(
        canvas,
        opaque_thresh=215,
        erode_core_px=max(1, min(erode_core_px, 2)),
        zero_exterior_beyond_px=8,
    )

    # Strictly enforce full 16x16 WebP macroblocks at all 4 corners as pure [0,0,0,0]
    # so lossy VP8 RGB macroblock encoding never introduces +/-1 chroma drift at corners.
    canvas[:16, :16] = 0
    canvas[:16, -16:] = 0
    canvas[-16:, :16] = 0
    canvas[-16:, -16:] = 0

    final_alpha = canvas[:, :, 3]
    fys, fxs = np.where(final_alpha >= 10)
    actual_top = int(fys.min()) if len(fys) else -1
    actual_bottom = int(fys.max()) if len(fys) else -1
    actual_h_pct = ((actual_bottom - actual_top + 1) / float(CANVAS_H)) if len(fys) else 0.0

    metrics = {
        "width": CANVAS_W,
        "height": CANVAS_H,
        "topY": actual_top,
        "topPct": round(actual_top / float(CANVAS_H), 4),
        "bottomY": actual_bottom,
        "heightFillPct": round(actual_h_pct, 4),
        "coverage": round(float((final_alpha >= 10).mean()), 4),
    }
    return Image.fromarray(canvas, mode="RGBA"), metrics


def main() -> int:
    spec_path = Path(sys.argv[1])
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    model_name, session = load_human_session()
    isnet_session = None

    results = []
    t_all = time.time()
    for job in spec["jobs"]:
        t0 = time.time()
        slug = job["slug"]
        src_path = Path(job["input"])
        png_out = Path(job["tempPng"])
        erode_core_px = int(job.get("erodeCorePx", 2))
        head_top_pct = float(job.get("headTopPct", 0.03))
        target_height_pct = float(job.get("targetHeightPct", 0.945))
        use_isnet = bool(job.get("intersectIsnet", False))
        clean_gray_hole = bool(job.get("cleanCoolGrayHole", False))

        if use_isnet and isnet_session is None:
            try:
                isnet_session = new_session("isnet-general-use")
                print("[cutout:py] loaded secondary session 'isnet-general-use' for interior hole cutout", flush=True)
            except Exception as err:
                print(f"[cutout:py] warning: secondary isnet unavailable: {err}", flush=True)

        img = ImageOps.exif_transpose(Image.open(src_path)).convert("RGB")
        rgba_arr, used_matting = extract_subject_rgba(
            img,
            session=session,
            erode_core_px=erode_core_px,
            isnet_session=isnet_session if use_isnet else None,
            clean_cool_gray_hole=clean_gray_hole,
        )
        framed_im, metrics = frame_on_canvas(
            rgba_arr,
            head_top_pct=head_top_pct,
            target_height_pct=target_height_pct,
            erode_core_px=erode_core_px,
        )

        png_out.parent.mkdir(parents=True, exist_ok=True)
        framed_im.save(png_out, format="PNG", compress_level=1)
        elapsed = round(time.time() - t0, 2)
        print(
            f"[cutout:py] {slug} ({src_path.name} -> {CANVAS_W}x{CANVAS_H}) | "
            f"matting={used_matting} topY={metrics['topY']}px ({metrics['topPct']*100:.1f}%) "
            f"fillH={metrics['heightFillPct']*100:.1f}% cov={metrics['coverage']*100:.1f}% [{elapsed}s]",
            flush=True,
        )
        results.append(
            {
                "slug": slug,
                "source": str(src_path),
                "tempPng": str(png_out),
                "model": model_name,
                "usedMatting": used_matting,
                "metrics": metrics,
            }
        )

    Path(spec["reportPath"]).write_text(
        json.dumps({"model": model_name, "elapsedSec": round(time.time() - t_all, 2), "results": results}, indent=2),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;

async function auditWebpBuffer(sharp, buf, label = '<buffer>') {
  const meta = await sharp(buf).metadata();
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const pxAt = (x, y) => {
    const idx = (y * w + x) * 4;
    return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
  };

  const corners = {
    topLeft: pxAt(0, 0),
    topRight: pxAt(w - 1, 0),
    bottomLeft: pxAt(0, h - 1),
    bottomRight: pxAt(w - 1, h - 1),
  };

  const cornersStrictZero = Object.values(corners).every(
    ([r, g, b, a]) => r === 0 && g === 0 && b === 0 && a === 0,
  );
  const cornersAlphaZero = Object.values(corners).every(([, , , a]) => a === 0);

  return {
    filePath: label,
    bytes: buf.length,
    width: meta.width,
    height: meta.height,
    hasAlpha: meta.hasAlpha === true,
    format: meta.format,
    corners,
    cornersStrictZero,
    cornersAlphaZero,
  };
}

async function auditWebpFile(sharp, filePath) {
  const buf = fs.readFileSync(filePath);
  return auditWebpBuffer(sharp, buf, filePath);
}

async function generateContactSheet(sharp, slugs, outPath) {
  const tileW = 420;
  const tileH = 560;
  const labelH = 38;
  const cols = 2; // Left: #EFEAE0 light cream | Right: #1C1410 dark espresso
  const sheetW = tileW * cols;
  const sheetH = (tileH + labelH) * slugs.length;

  const composites = [];
  for (let row = 0; row < slugs.length; row += 1) {
    const slug = slugs[row];
    const webpPath = path.join(PUBLIC_CUTOUT_DIR, `${slug}-cutout-3x4.webp`);
    const resizedCutout = await sharp(webpPath)
      .resize(tileW, tileH, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    const lightBg = await sharp({
      create: {
        width: tileW,
        height: tileH,
        channels: 4,
        background: { r: 239, g: 234, b: 224, alpha: 1 }, // #EFEAE0
      },
    })
      .composite([{ input: resizedCutout, blend: 'over' }])
      .png()
      .toBuffer();

    const darkBg = await sharp({
      create: {
        width: tileW,
        height: tileH,
        channels: 4,
        background: { r: 28, g: 20, b: 16, alpha: 1 }, // #1C1410
      },
    })
      .composite([{ input: resizedCutout, blend: 'over' }])
      .png()
      .toBuffer();

    const labelSvg = Buffer.from(
      `<svg width="${sheetW}" height="${labelH}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="#2B221B"/>` +
        `<text x="16" y="25" font-family="Arial, sans-serif" font-size="16" fill="#FBF7EF">${slug} — #EFEAE0 CREAM (LIGHT)</text>` +
        `<text x="${tileW + 16}" y="25" font-family="Arial, sans-serif" font-size="16" fill="#EBCF8F">${slug} — #1C1410 ESPRESSO (DARK)</text>` +
        `</svg>`,
    );

    const yTop = row * (tileH + labelH);
    composites.push(
      { input: labelSvg, top: yTop, left: 0 },
      { input: lightBg, top: yTop + labelH, left: 0 },
      { input: darkBg, top: yTop + labelH, left: tileW },
    );
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await sharp({
    create: {
      width: sheetW,
      height: sheetH,
      channels: 4,
      background: { r: 43, g: 34, b: 27, alpha: 1 },
    },
  })
    .composite(composites)
    .png()
    .toFile(outPath);

  console.log(`[contact-sheet] Saved ${slugs.length}x2 light/dark audit -> ${outPath}`);
}

async function main() {
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const contactSheetArg = process.argv.find((a) =>
    a.startsWith('--contact-sheet='),
  );
  const fullSheetArg = process.argv.find((a) => a.startsWith('--full-sheet='));
  const onlySet = onlyArg
    ? new Set(
        onlyArg
          .slice('--only='.length)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;

  fs.mkdirSync(PROCESSED_CUTOUT_DIR, { recursive: true });
  fs.mkdirSync(PUBLIC_CUTOUT_DIR, { recursive: true });

  const sharp = await loadSharp();
  const pythonExe = findPythonExecutable();

  const { byOccasion, uniqueSlugs } = scanCuratedOccasionProducts();
  const totalOccasionItems = byOccasion.reduce(
    (sum, o) => sum + o.slugs.length,
    0,
  );
  console.log(
    `[frameless] Scanned ${byOccasion.length} occasions x 4 = ${totalOccasionItems} curated items (${uniqueSlugs.length} unique slugs).`,
  );
  for (const occ of byOccasion) {
    console.log(`  - ${occ.occasionSlug}: ${occ.slugs.join(', ')}`);
  }

  const rawSourceMap = buildRawSourceMap();
  const targetSlugs = onlySet
    ? uniqueSlugs.filter((s) => onlySet.has(s))
    : uniqueSlugs;

  if (targetSlugs.length === 0) {
    throw new Error('No matching slugs to process.');
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-cutouts-'));
  try {
    const pyPath = path.join(tmpDir, 'frameless_matting.py');
    const jobsPath = path.join(tmpDir, 'jobs.json');
    const reportPath = path.join(tmpDir, 'report.json');

    fs.writeFileSync(pyPath, PYTHON_PIPELINE, 'utf8');

    const jobs = targetSlugs.map((slug) => {
      const tuning = SLUG_TUNING[slug] ?? {};
      return {
        slug,
        input: resolveBestSourcePhoto(slug, rawSourceMap),
        tempPng: path.join(tmpDir, `${slug}.png`),
        erodeCorePx: tuning.erodeCorePx ?? 2,
        headTopPct: tuning.headTopPct ?? 0.03,
        targetHeightPct: tuning.targetHeightPct ?? 0.945,
        intersectIsnet: Boolean(tuning.intersectIsnet),
        cleanCoolGrayHole: Boolean(tuning.cleanCoolGrayHole),
      };
    });

    fs.writeFileSync(
      jobsPath,
      JSON.stringify({ jobs, reportPath }, null, 2) + '\n',
      'utf8',
    );

    console.log(
      `[frameless] Running neural alpha matting via ${pythonExe} for ${jobs.length} curated portrait(s)...`,
    );
    const run = spawnSync(pythonExe, [pyPath, jobsPath], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    if (run.status !== 0) {
      throw new Error(`Python alpha matting failed with exit code ${run.status}`);
    }

    const pyReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

    // Encode with Sharp (quality: 92, alphaQuality: 100) to BOTH processed cache & public mirror
    let auditFailures = 0;
    const encodeProfiles = [
      { quality: 92, alphaQuality: 100, effort: 5 },
      { quality: 92, alphaQuality: 100, effort: 4 },
      { quality: 90, alphaQuality: 100, effort: 5 },
      { nearLossless: true, quality: 92, alphaQuality: 100, effort: 5 },
    ];
    for (const item of pyReport.results) {
      const slug = item.slug;
      let webpBuf = null;
      for (const profile of encodeProfiles) {
        const candidate = await sharp(item.tempPng)
          .ensureAlpha()
          .webp(profile)
          .toBuffer();
        const check = await auditWebpBuffer(sharp, candidate, slug);
        if (check.cornersStrictZero && check.hasAlpha) {
          webpBuf = candidate;
          break;
        }
      }
      if (!webpBuf) {
        webpBuf = await sharp(item.tempPng)
          .ensureAlpha()
          .webp({ quality: 92, alphaQuality: 100, effort: 5 })
          .toBuffer();
      }

      const processedOut = path.join(
        PROCESSED_CUTOUT_DIR,
        `${slug}-cutout-3x4.webp`,
      );
      const publicOut = path.join(PUBLIC_CUTOUT_DIR, `${slug}-cutout-3x4.webp`);
      fs.writeFileSync(processedOut, webpBuf);
      fs.writeFileSync(publicOut, webpBuf);

      const audit = await auditWebpFile(sharp, publicOut);
      const ok =
        audit.width >= CANVAS_W &&
        audit.height >= CANVAS_H &&
        audit.hasAlpha &&
        audit.cornersStrictZero;
      if (!ok) {
        auditFailures += 1;
        console.error(`[AUDIT FAIL] ${slug}:`, audit);
      } else {
        console.log(
          `[webp] ${slug}-cutout-3x4.webp | ${audit.width}x${audit.height} | ` +
            `alpha=${audit.hasAlpha} | corners=[0,0,0,0] | ${(audit.bytes / 1024).toFixed(1)} KB`,
        );
      }
    }

    if (auditFailures > 0) {
      throw new Error(`${auditFailures} cutout(s) failed strict RGBA/corner audit!`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Update processed/manifest.json with `occasionCutouts` while preserving all existing keys
  const manifestPath = path.join(PROCESSED_DIR, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const occasionCutouts = { ...(manifest.occasionCutouts ?? {}) };
    for (const slug of uniqueSlugs) {
      const rel = `occasion-cutouts/${slug}-cutout-3x4.webp`;
      if (fs.existsSync(path.join(PROCESSED_DIR, rel))) {
        occasionCutouts[slug] = rel;
      }
    }
    manifest.occasionCutouts = occasionCutouts;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(
      `[manifest] Updated occasionCutouts (${Object.keys(occasionCutouts).length} entries) in ${path.relative(REPO_ROOT, manifestPath)}`,
    );
  }

  // Optional visual quality audit contact sheets
  if (contactSheetArg) {
    const sheetPath = contactSheetArg.slice('--contact-sheet='.length);
    const keySlugs = [
      'ao-so-mi-lua-to-tam-tam-xuan',
      'chan-vay-xep-ly-midi-cap-cao',
      'dam-du-tiec-lua-satin-co-do',
      'ao-blazer-linen-dang-suong',
    ];
    await generateContactSheet(sharp, keySlugs, sheetPath);
  }
  if (fullSheetArg) {
    const sheetPath = fullSheetArg.slice('--full-sheet='.length);
    await generateContactSheet(sharp, uniqueSlugs, sheetPath);
  }

  console.log(
    `[frameless] COMPLETE: ${targetSlugs.length}/${uniqueSlugs.length} curated cutouts ready (${totalOccasionItems}/24 occasion items covered).`,
  );
}

main().catch((err) => {
  console.error('[frameless] ERROR:', err);
  process.exit(1);
});
