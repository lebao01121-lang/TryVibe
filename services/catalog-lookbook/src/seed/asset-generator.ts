import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import fs from 'node:fs';
import path from 'node:path';
import { isTcpReachable } from '@atelier/db-client';
import { createLogger } from '@atelier/observability';
import sharp from 'sharp';
import {
  OCCASION_CUTOUT_SLUGS,
  type OccasionCutoutSlug,
} from '../occasions/occasion-cutout';
import {
  OCCASION_MACRO_KEYS,
  type OccasionMacroKey,
} from '../occasions/occasion-macro';
import { type CatalogLookbookConfig, SERVICE_NAME } from '../config/env';

export type GarmentSilhouetteKind =
  | 'blazer'
  | 'shirt'
  | 'gown'
  | 'trousers'
  | 'skirt'
  | 'trench'
  | 'blouse'
  | 'dress'
  | 'cardigan'
  | 'sweater'
  | 'culottes'
  | 'tweed'
  | 'polo'
  | 'clutch'
  | 'scarf'
  | 'belt';

export interface GarmentAssetSpec {
  slug: string;
  title: string;
  kind: GarmentSilhouetteKind;
  primaryHex: string;
  accentHex: string;
  shadeHex: string;
  variantCount?: number;
}

export interface GeneratedVariantAssetUrls {
  variantIndex: number;
  rackCutout2x3Url: string;
  rackBackCutout2x3Url: string;
  tryonFlat3x4GarmentKey: string;
  tryonFlatPreviewUrl: string;
  lookbookMainUrl: string;
  uploadedToMinio: boolean;
}

export interface GeneratedProductAssetUrls {
  rackCutout2x3Url: string;
  rackBackCutout2x3Url: string;
  tryonFlat3x4GarmentKey: string;
  tryonFlatPreviewUrl: string;
  lookbookMainUrl: string;
  uploadedToMinio: boolean;
  variants: GeneratedVariantAssetUrls[];
}

export interface PackagingEditorialAssetUrls {
  frontUrl: string;
  backUrl: string;
}

export interface CampaignEditorialAssetUrls {
  heroPosterUrl: string;
  step1Url: string;
  step2Url: string;
  step3Url: string;
  step4Url: string;
  seasonUrls: Record<string, string>;
  packagingUrls: Record<string, PackagingEditorialAssetUrls>;
  occasionMacroUrls: Record<OccasionMacroKey, string>;
  occasionCutoutUrls: Record<OccasionCutoutSlug, string>;
  uploadedCount: number;
}

interface ManifestVariantEntry {
  index?: number;
  variantIndex?: number;
  rackFront?: string;
  rackCutout?: string;
  rackCutout2x3?: string;
  frontCutout?: string;
  rack_2x3?: string;
  rackBack?: string;
  rackBackCutout?: string;
  rackBackCutout2x3?: string;
  backCutout?: string;
  rack_back_2x3?: string;
  tryonFlat?: string;
  tryonFlat3x4?: string;
  flat3x4?: string;
  flat?: string;
  flat_3x4?: string;
  lookbook?: string;
  lookbookMain?: string;
  lookbook3x4?: string;
  lookbook_main?: string;
}

interface ManifestProductEntry extends ManifestVariantEntry {
  slug?: string;
  variants?: ManifestVariantEntry[];
}

interface RealAssetsManifest {
  version?: string;
  generatedAt?: string;
  campaign?: {
    heroPoster?: string;
    hero?: string;
    atelierSteps?: string[] | Record<string, string>;
    steps?: string[] | Record<string, string>;
    step1?: string;
    step2?: string;
    step3?: string;
    step4?: string;
  };
  heroPoster?: string;
  atelierSteps?: string[] | Record<string, string>;
  seasons?: Record<string, string | { image?: string; cover?: string; path?: string }>;
  packaging?: Record<
    string,
    string | { front?: string; back?: string; image?: string; path?: string }
  >;
  occasionMacros?: Record<string, string>;
  occasionCutouts?: Record<string, string>;
  products?: Record<string, ManifestProductEntry> | ManifestProductEntry[];
}

const SEASON_SLUGS = [
  'xuan-tam-xuan',
  'ha-pho-co',
  'thu-hoang-hon',
  'dong-cashmere',
  'resort-ban-mai',
  'atelier-di-san',
] as const;

const PACKAGING_CODES = [
  'tui-vai-linen-moc',
  'hop-lua-co-dien',
  'hop-qua-khac-ten-gold',
] as const;

const logger = createLogger(`${SERVICE_NAME}:assets`);

function resolveRealAssetsProcessedDir(): string | null {
  const candidates: string[] = [];
  if (process.env.REAL_ASSETS_CACHE_DIR) {
    candidates.push(path.resolve(process.env.REAL_ASSETS_CACHE_DIR));
  }
  candidates.push(
    path.resolve(__dirname, '../../../../infra/seeds/real-assets-cache/processed'),
    path.resolve(__dirname, '../../../infra/seeds/real-assets-cache/processed'),
    path.resolve(process.cwd(), 'infra/seeds/real-assets-cache/processed'),
    path.resolve(process.cwd(), '../../infra/seeds/real-assets-cache/processed'),
  );

  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      return dir;
    }
  }
  return null;
}

function loadManifest(processedDir: string | null): RealAssetsManifest | null {
  if (!processedDir) {
    return null;
  }
  const manifestPath = path.join(processedDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    return JSON.parse(raw) as RealAssetsManifest;
  } catch (error) {
    logger.warn(
      {
        manifestPath,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to parse real-assets-cache manifest.json',
    );
    return null;
  }
}

function resolveCandidateFile(
  processedDir: string | null,
  ...candidates: Array<string | null | undefined>
): string | null {
  if (!processedDir) {
    return null;
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') {
      continue;
    }
    const normalized = candidate.replace(/\\/g, '/').replace(/^\/+/, '');
    const tries = path.isAbsolute(candidate)
      ? [candidate]
      : [
          path.resolve(processedDir, normalized),
          path.resolve(processedDir, '..', normalized),
          path.resolve(process.cwd(), normalized),
        ];
    for (const fullPath of tries) {
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        return fullPath;
      }
    }
  }
  return null;
}

function pickManifestProduct(
  manifest: RealAssetsManifest | null,
  slug: string,
): ManifestProductEntry | null {
  if (!manifest?.products) {
    return null;
  }
  if (Array.isArray(manifest.products)) {
    return manifest.products.find((p) => p.slug === slug) ?? null;
  }
  return manifest.products[slug] ?? null;
}

function pickManifestVariant(
  prodEntry: ManifestProductEntry | null,
  variantIndex: number,
): ManifestVariantEntry | null {
  if (!prodEntry) {
    return null;
  }
  if (Array.isArray(prodEntry.variants) && prodEntry.variants.length > 0) {
    const exact =
      prodEntry.variants.find(
        (v) => v.index === variantIndex || v.variantIndex === variantIndex,
      ) ?? prodEntry.variants[variantIndex];
    if (exact) {
      return exact;
    }
  }
  return variantIndex === 0 ? prodEntry : null;
}

function pickStepFromManifest(
  manifest: RealAssetsManifest | null,
  stepNum: number,
): string | undefined {
  const campaign = manifest?.campaign;
  const directKey = `step${stepNum}` as 'step1' | 'step2' | 'step3' | 'step4';
  if (campaign?.[directKey]) {
    return campaign[directKey];
  }
  const sources = [
    campaign?.atelierSteps,
    campaign?.steps,
    manifest?.atelierSteps,
  ];
  for (const src of sources) {
    if (!src) continue;
    if (Array.isArray(src)) {
      const val = src[stepNum - 1];
      if (typeof val === 'string') return val;
    } else if (typeof src === 'object') {
      const val =
        src[String(stepNum)] ??
        src[`step${stepNum}`] ??
        src[`step-${stepNum}`] ??
        src[`atelier-step-${stepNum}`];
      if (typeof val === 'string') return val;
    }
  }
  return undefined;
}

async function readValidatedRealWebp(
  filePath: string,
  options: { requireAlpha: boolean; label: string },
): Promise<Buffer> {
  const buffer = fs.readFileSync(filePath);
  const metadata = await sharp(buffer).metadata();
  if (!metadata.width || !metadata.height || metadata.format === 'svg') {
    throw new Error(
      `Invalid real photography asset (${options.label}) at ${filePath}: format=${String(metadata.format)}`,
    );
  }
  if (options.requireAlpha && metadata.hasAlpha !== true) {
    throw new Error(
      `Cutout asset (${options.label}) at ${filePath} missing required transparent alpha channel (hasAlpha=${String(metadata.hasAlpha)})`,
    );
  }
  if (metadata.format === 'webp') {
    return buffer;
  }
  return sharp(buffer)
    .webp({ quality: 86, alphaQuality: 95 })
    .toBuffer();
}

export class SeedAssetGenerator {
  private readonly s3: S3Client;
  private bucketsEnsured = false;

  constructor(private readonly config: CatalogLookbookConfig) {
    this.s3 = new S3Client({
      endpoint: `http://${config.infra.minioEndpoint}:${config.infra.minioPort}`,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.infra.minioRootUser,
        secretAccessKey: config.infra.minioRootPassword,
      },
    });
  }

  public getSeasonAssetUrl(seasonSlug: string): string {
    const base = this.config.infra.minioPublicBaseUrl;
    const pub = this.config.infra.minioBucketPublic;
    return `${base}/${pub}/seed/season-${seasonSlug}.webp`;
  }

  public getPackagingAssetUrls(pkgCode: string): PackagingEditorialAssetUrls {
    const base = this.config.infra.minioPublicBaseUrl;
    const pub = this.config.infra.minioBucketPublic;
    return {
      frontUrl: `${base}/${pub}/seed/packaging-${pkgCode}.webp`,
      backUrl: `${base}/${pub}/seed/packaging-${pkgCode}-back.webp`,
    };
  }

  public getCampaignEditorialUrls(): CampaignEditorialAssetUrls {
    const base = this.config.infra.minioPublicBaseUrl;
    const pub = this.config.infra.minioBucketPublic;
    const seasonUrls: Record<string, string> = {};
    for (const slug of SEASON_SLUGS) {
      seasonUrls[slug] = this.getSeasonAssetUrl(slug);
    }
    const packagingUrls: Record<string, PackagingEditorialAssetUrls> = {};
    for (const code of PACKAGING_CODES) {
      packagingUrls[code] = this.getPackagingAssetUrls(code);
    }
    const occasionMacroUrls = {} as Record<OccasionMacroKey, string>;
    for (const macroKey of OCCASION_MACRO_KEYS) {
      occasionMacroUrls[macroKey] = `${base}/${pub}/seed/occasion-macro-${macroKey}.webp`;
    }
    const occasionCutoutUrls = {} as Record<OccasionCutoutSlug, string>;
    for (const cutoutSlug of OCCASION_CUTOUT_SLUGS) {
      occasionCutoutUrls[cutoutSlug] = `${base}/${pub}/seed/occasion-cutout-${cutoutSlug}.webp`;
    }
    return {
      heroPosterUrl: `${base}/${pub}/seed/atelier-hero-poster.webp`,
      step1Url: `${base}/${pub}/seed/atelier-step-1.webp`,
      step2Url: `${base}/${pub}/seed/atelier-step-2.webp`,
      step3Url: `${base}/${pub}/seed/atelier-step-3.webp`,
      step4Url: `${base}/${pub}/seed/atelier-step-4.webp`,
      seasonUrls,
      packagingUrls,
      occasionMacroUrls,
      occasionCutoutUrls,
      uploadedCount: 0,
    };
  }

  public getVariantAssetUrls(
    slug: string,
    variantIndex = 0,
    hasDistinctVariantAssets = false,
  ): GeneratedVariantAssetUrls {
    const base = this.config.infra.minioPublicBaseUrl;
    const pub = this.config.infra.minioBucketPublic;
    const gar = this.config.infra.minioBucketGarments;
    const suffix =
      variantIndex > 0 && hasDistinctVariantAssets ? `-v${variantIndex}` : '';
    return {
      variantIndex,
      rackCutout2x3Url: `${base}/${pub}/seed/${slug}${suffix}-rack-2x3.webp`,
      rackBackCutout2x3Url: `${base}/${pub}/seed/${slug}${suffix}-rack-back-2x3.webp`,
      tryonFlat3x4GarmentKey: `${gar}/seed/${slug}${suffix}-flat-3x4.webp`,
      tryonFlatPreviewUrl: `${base}/${pub}/seed/${slug}${suffix}-flat-preview.webp`,
      lookbookMainUrl: `${base}/${pub}/seed/${slug}${suffix}-lookbook.webp`,
      uploadedToMinio: false,
    };
  }

  public getPublicAssetUrls(
    slug: string,
    variantCount = 1,
  ): GeneratedProductAssetUrls {
    const processedDir = resolveRealAssetsProcessedDir();
    const manifest = loadManifest(processedDir);
    const prodEntry = pickManifestProduct(manifest, slug);
    const primary = this.getVariantAssetUrls(slug, 0, false);
    const variants: GeneratedVariantAssetUrls[] = [primary];

    for (let vIdx = 1; vIdx < variantCount; vIdx += 1) {
      const files = this.resolveProductVariantFiles(
        processedDir,
        prodEntry,
        slug,
        vIdx,
      );
      const distinct = Boolean(
        files.rackFront && files.lookbook && vIdx > 0 && files.isDistinctVariant,
      );
      variants.push(this.getVariantAssetUrls(slug, vIdx, distinct));
    }

    return {
      rackCutout2x3Url: primary.rackCutout2x3Url,
      rackBackCutout2x3Url: primary.rackBackCutout2x3Url,
      tryonFlat3x4GarmentKey: primary.tryonFlat3x4GarmentKey,
      tryonFlatPreviewUrl: primary.tryonFlatPreviewUrl,
      lookbookMainUrl: primary.lookbookMainUrl,
      uploadedToMinio: false,
      variants,
    };
  }

  private async isMinioReachable(): Promise<boolean> {
    const host = this.config.infra.minioEndpoint;
    const port = this.config.infra.minioPort;
    if (await isTcpReachable(host, port, 3000)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    return isTcpReachable(host, port, 3000);
  }

  private async ensureBuckets(): Promise<void> {
    if (this.bucketsEnsured) {
      return;
    }
    for (const bucket of [
      this.config.infra.minioBucketPublic,
      this.config.infra.minioBucketGarments,
    ]) {
      try {
        await this.s3.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        await this.s3.send(new CreateBucketCommand({ Bucket: bucket }));
      }
    }
    this.bucketsEnsured = true;
  }

  private async putWebp(bucket: string, key: string, body: Buffer): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=86400',
      }),
    );
  }

  private resolveProductVariantFiles(
    processedDir: string | null,
    prodEntry: ManifestProductEntry | null,
    slug: string,
    variantIndex: number,
  ): {
    rackFront: string | null;
    rackBack: string | null;
    tryonFlat: string | null;
    lookbook: string | null;
    isDistinctVariant: boolean;
  } {
    const variantEntry = pickManifestVariant(prodEntry, variantIndex);
    const vTag = `v${variantIndex}`;
    const vPrefix = variantIndex > 0 ? `${vTag}-` : '';

    const rackFront = resolveCandidateFile(
      processedDir,
      variantEntry?.rackFront,
      variantEntry?.rackCutout2x3,
      variantEntry?.rackCutout,
      variantEntry?.frontCutout,
      variantEntry?.rack_2x3,
      variantIndex > 0 ? `products/${slug}/${vTag}/rack-2x3.webp` : null,
      variantIndex > 0 ? `products/${slug}/${vTag}-rack-2x3.webp` : null,
      variantIndex > 0 ? `products/${slug}/${vTag}-rack-front.webp` : null,
      variantIndex > 0 ? `products/${slug}-${vTag}-rack-2x3.webp` : null,
      `products/${slug}/${vPrefix}rack-2x3.webp`,
      `products/${slug}/rack-2x3.webp`,
      `products/${slug}/rack-front.webp`,
      `products/${slug}/front-2x3.webp`,
      `products/${slug}-rack-2x3.webp`,
    );

    const rackBack = resolveCandidateFile(
      processedDir,
      variantEntry?.rackBack,
      variantEntry?.rackBackCutout2x3,
      variantEntry?.rackBackCutout,
      variantEntry?.backCutout,
      variantEntry?.rack_back_2x3,
      variantIndex > 0 ? `products/${slug}/${vTag}/rack-back-2x3.webp` : null,
      variantIndex > 0 ? `products/${slug}/${vTag}-rack-back-2x3.webp` : null,
      variantIndex > 0 ? `products/${slug}/${vTag}-rack-back.webp` : null,
      variantIndex > 0 ? `products/${slug}-${vTag}-rack-back-2x3.webp` : null,
      `products/${slug}/${vPrefix}rack-back-2x3.webp`,
      `products/${slug}/rack-back-2x3.webp`,
      `products/${slug}/rack-back.webp`,
      `products/${slug}/back-2x3.webp`,
      `products/${slug}-rack-back-2x3.webp`,
      rackFront,
    );

    const tryonFlat = resolveCandidateFile(
      processedDir,
      variantEntry?.tryonFlat,
      variantEntry?.tryonFlat3x4,
      variantEntry?.flat3x4,
      variantEntry?.flat,
      variantEntry?.flat_3x4,
      variantIndex > 0 ? `products/${slug}/${vTag}/flat-3x4.webp` : null,
      variantIndex > 0 ? `products/${slug}/${vTag}-flat-3x4.webp` : null,
      variantIndex > 0 ? `products/${slug}-${vTag}-flat-3x4.webp` : null,
      `products/${slug}/${vPrefix}flat-3x4.webp`,
      `products/${slug}/flat-3x4.webp`,
      `products/${slug}/tryon-flat-3x4.webp`,
      `products/${slug}/tryon-3x4.webp`,
      `products/${slug}-flat-3x4.webp`,
      rackFront,
    );

    const lookbook = resolveCandidateFile(
      processedDir,
      variantEntry?.lookbook,
      variantEntry?.lookbookMain,
      variantEntry?.lookbook3x4,
      variantEntry?.lookbook_main,
      variantIndex > 0 ? `products/${slug}/${vTag}/lookbook.webp` : null,
      variantIndex > 0 ? `products/${slug}/${vTag}-lookbook.webp` : null,
      variantIndex > 0 ? `products/${slug}-${vTag}-lookbook.webp` : null,
      `products/${slug}/${vPrefix}lookbook.webp`,
      `products/${slug}/lookbook.webp`,
      `products/${slug}/lookbook-3x4.webp`,
      `products/${slug}/lookbook-main.webp`,
      `products/${slug}-lookbook.webp`,
    );

    const isDistinctVariant =
      variantIndex > 0 &&
      Boolean(
        variantEntry &&
          (variantEntry.rackFront ||
            variantEntry.rackCutout2x3 ||
            variantEntry.rackCutout ||
            variantEntry.lookbook ||
            variantEntry.lookbookMain),
      );

    return {
      rackFront,
      rackBack,
      tryonFlat,
      lookbook,
      isDistinctVariant,
    };
  }

  public async ensureCampaignEditorialAssets(
    _forceRegenerate = true,
  ): Promise<CampaignEditorialAssetUrls> {
    const urls = this.getCampaignEditorialUrls();
    const processedDir = resolveRealAssetsProcessedDir();
    const manifest = loadManifest(processedDir);

    if (!processedDir) {
      logger.warn(
        'infra/seeds/real-assets-cache/processed not found — run `node scripts/prepare-real-fashion-assets.mjs` before seeding MinIO',
      );
      return urls;
    }

    const reachable = await this.isMinioReachable();
    if (!reachable) {
      logger.warn(
        {
          endpoint: `${this.config.infra.minioEndpoint}:${this.config.infra.minioPort}`,
        },
        'MinIO unreachable during campaign editorial seed — skipping real photography upload',
      );
      return urls;
    }

    try {
      await this.ensureBuckets();
    } catch {
      return urls;
    }

    const pubBucket = this.config.infra.minioBucketPublic;
    let uploadedCount = 0;

    // 1. Hero poster (always overwrite BOTH canonical atelier-hero-poster.webp and legacy alias hero-atelier-poster.webp)
    const heroFile = resolveCandidateFile(
      processedDir,
      manifest?.campaign?.heroPoster,
      manifest?.campaign?.hero,
      manifest?.heroPoster,
      'campaign/atelier-hero-poster.webp',
      'hero/atelier-hero-poster.webp',
      'atelier-hero-poster.webp',
      'campaign/hero-atelier-poster.webp',
    );
    if (heroFile) {
      try {
        const heroBuf = await readValidatedRealWebp(heroFile, {
          requireAlpha: false,
          label: 'hero-poster',
        });
        await Promise.all([
          this.putWebp(pubBucket, 'seed/atelier-hero-poster.webp', heroBuf),
          this.putWebp(pubBucket, 'seed/hero-atelier-poster.webp', heroBuf),
        ]);
        uploadedCount += 1;
      } catch (error) {
        logger.warn(
          { heroFile, err: error instanceof Error ? error.message : String(error) },
          'Failed to upload real hero poster WebP',
        );
      }
    } else {
      logger.warn('Real hero poster WebP missing from real-assets-cache/processed');
    }

    // 2. Four Atelier craft steps
    for (let stepNum = 1; stepNum <= 4; stepNum += 1) {
      const stepFile = resolveCandidateFile(
        processedDir,
        pickStepFromManifest(manifest, stepNum),
        `campaign/atelier-step-${stepNum}.webp`,
        `atelier/atelier-step-${stepNum}.webp`,
        `atelier/step-${stepNum}.webp`,
        `atelier-step-${stepNum}.webp`,
      );
      if (!stepFile) {
        logger.warn({ stepNum }, 'Real atelier step WebP missing from cache');
        continue;
      }
      try {
        const stepBuf = await readValidatedRealWebp(stepFile, {
          requireAlpha: false,
          label: `atelier-step-${stepNum}`,
        });
        await this.putWebp(pubBucket, `seed/atelier-step-${stepNum}.webp`, stepBuf);
        uploadedCount += 1;
      } catch (error) {
        logger.warn(
          { stepNum, err: error instanceof Error ? error.message : String(error) },
          'Failed to upload real atelier step WebP',
        );
      }
    }

    // 3. Six seasonal collection editorial covers
    for (const seasonSlug of SEASON_SLUGS) {
      const mEntry = manifest?.seasons?.[seasonSlug];
      const manifestPath =
        typeof mEntry === 'string'
          ? mEntry
          : (mEntry?.image ?? mEntry?.cover ?? mEntry?.path);
      const seasonFile = resolveCandidateFile(
        processedDir,
        manifestPath,
        `seasons/${seasonSlug}.webp`,
        `seasons/season-${seasonSlug}.webp`,
        `campaign/season-${seasonSlug}.webp`,
      );
      if (!seasonFile) {
        continue;
      }
      try {
        const seasonBuf = await readValidatedRealWebp(seasonFile, {
          requireAlpha: false,
          label: `season-${seasonSlug}`,
        });
        await this.putWebp(pubBucket, `seed/season-${seasonSlug}.webp`, seasonBuf);
        uploadedCount += 1;
      } catch (error) {
        logger.warn(
          { seasonSlug, err: error instanceof Error ? error.message : String(error) },
          'Failed to upload real seasonal collection WebP',
        );
      }
    }

    // 4. Three packaging editorial photographs (360x360 square studio WebPs)
    for (const pkgCode of PACKAGING_CODES) {
      const mEntry = manifest?.packaging?.[pkgCode];
      const frontManifest =
        typeof mEntry === 'string'
          ? mEntry
          : (mEntry?.image ?? mEntry?.front ?? mEntry?.path);
      const backManifest =
        typeof mEntry === 'string'
          ? mEntry
          : (mEntry?.back ?? mEntry?.image ?? mEntry?.front ?? mEntry?.path);

      const frontFile = resolveCandidateFile(
        processedDir,
        `packaging/${pkgCode}.webp`,
        frontManifest,
        `packaging/${pkgCode}-front.webp`,
        `campaign/packaging-${pkgCode}.webp`,
      );
      const backFile = resolveCandidateFile(
        processedDir,
        backManifest,
        `packaging/${pkgCode}-back.webp`,
        frontFile,
      );
      if (!frontFile) {
        continue;
      }
      try {
        const frontBuf = await readValidatedRealWebp(frontFile, {
          requireAlpha: false,
          label: `packaging-${pkgCode}`,
        });
        const backBuf =
          backFile && backFile !== frontFile
            ? await readValidatedRealWebp(backFile, {
                requireAlpha: false,
                label: `packaging-${pkgCode}-back`,
              })
            : frontBuf;
        await Promise.all([
          this.putWebp(pubBucket, `seed/packaging-${pkgCode}.webp`, frontBuf),
          this.putWebp(pubBucket, `seed/packaging-${pkgCode}-front.webp`, frontBuf),
          this.putWebp(pubBucket, `seed/packaging-${pkgCode}-back.webp`, backBuf),
        ]);
        uploadedCount += 1;
      } catch (error) {
        logger.warn(
          { pkgCode, err: error instanceof Error ? error.message : String(error) },
          'Failed to upload real packaging WebP',
        );
      }
    }

    // 5. Seven Occasion macro fabric detail photographs (512x544 WebP)
    for (const macroKey of OCCASION_MACRO_KEYS) {
      const macroFile = resolveCandidateFile(
        processedDir,
        manifest?.occasionMacros?.[macroKey],
        `occasion-macro/${macroKey}.webp`,
      );
      if (!macroFile) {
        continue;
      }
      try {
        const macroBuf = await readValidatedRealWebp(macroFile, {
          requireAlpha: false,
          label: `occasion-macro-${macroKey}`,
        });
        await this.putWebp(
          pubBucket,
          `seed/occasion-macro-${macroKey}.webp`,
          macroBuf,
        );
        uploadedCount += 1;
      } catch (error) {
        logger.warn(
          {
            macroKey,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to upload real occasion macro fabric WebP',
        );
      }
    }

    // 6. Curated Occasion frameless alpha cutouts (1080x1440 WebP RGBA)
    const cutoutDir = path.join(processedDir, 'occasion-cutouts');
    const cutoutSlugsToUpload = new Set<string>(OCCASION_CUTOUT_SLUGS);
    if (fs.existsSync(cutoutDir)) {
      for (const entry of fs.readdirSync(cutoutDir)) {
        const match = entry.match(/^(.+)-cutout-3x4\.webp$/i);
        if (match?.[1]) {
          cutoutSlugsToUpload.add(match[1]);
        }
      }
    }
    for (const cutoutSlug of cutoutSlugsToUpload) {
      const cutoutFile = resolveCandidateFile(
        processedDir,
        manifest?.occasionCutouts?.[cutoutSlug],
        `occasion-cutouts/${cutoutSlug}-cutout-3x4.webp`,
      );
      if (!cutoutFile) {
        continue;
      }
      try {
        const cutoutBuf = await readValidatedRealWebp(cutoutFile, {
          requireAlpha: true,
          label: `occasion-cutout-${cutoutSlug}`,
        });
        await this.putWebp(
          pubBucket,
          `seed/occasion-cutout-${cutoutSlug}.webp`,
          cutoutBuf,
        );
        uploadedCount += 1;
      } catch (error) {
        logger.warn(
          {
            cutoutSlug,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to upload occasion frameless cutout WebP',
        );
      }
    }

    urls.uploadedCount = uploadedCount;
    return urls;
  }

  public async ensureProductAssets(
    specs: readonly GarmentAssetSpec[],
    _forceRegenerate = true,
  ): Promise<Map<string, GeneratedProductAssetUrls>> {
    const processedDir = resolveRealAssetsProcessedDir();
    const manifest = loadManifest(processedDir);
    const map = new Map<string, GeneratedProductAssetUrls>();

    for (const spec of specs) {
      map.set(spec.slug, this.getPublicAssetUrls(spec.slug, spec.variantCount ?? 1));
    }

    if (!processedDir) {
      logger.warn(
        'infra/seeds/real-assets-cache/processed not found — skipping MinIO upload (deterministic real-asset URLs preserved)',
      );
      return map;
    }

    const reachable = await this.isMinioReachable();
    if (!reachable) {
      logger.warn(
        {
          endpoint: `${this.config.infra.minioEndpoint}:${this.config.infra.minioPort}`,
        },
        'MinIO unreachable during seed — skipping real photography WebP upload (URLs remain deterministic)',
      );
      return map;
    }

    try {
      await this.ensureBuckets();
    } catch (error) {
      logger.warn({ err: error }, 'Could not ensure MinIO buckets during seed');
      return map;
    }

    const pubBucket = this.config.infra.minioBucketPublic;
    const garBucket = this.config.infra.minioBucketGarments;

    for (const spec of specs) {
      const prodUrls = map.get(spec.slug)!;
      const prodEntry = pickManifestProduct(manifest, spec.slug);
      let anyUploaded = false;

      for (const variantUrlSpec of prodUrls.variants) {
        const vIdx = variantUrlSpec.variantIndex;
        const files = this.resolveProductVariantFiles(
          processedDir,
          prodEntry,
          spec.slug,
          vIdx,
        );

        // Skip uploading duplicate keys for secondary variants that reuse primary URLs
        if (vIdx > 0 && !files.isDistinctVariant) {
          variantUrlSpec.uploadedToMinio = prodUrls.variants[0]?.uploadedToMinio ?? false;
          continue;
        }

        if (!files.rackFront || !files.lookbook) {
          logger.warn(
            {
              slug: spec.slug,
              variantIndex: vIdx,
              rackFront: files.rackFront,
              lookbook: files.lookbook,
            },
            'Missing real processed photography files for product variant',
          );
          continue;
        }

        const suffix = vIdx > 0 ? `-v${vIdx}` : '';
        const rackKey = `seed/${spec.slug}${suffix}-rack-2x3.webp`;
        const rackBackKey = `seed/${spec.slug}${suffix}-rack-back-2x3.webp`;
        const flatKey = `seed/${spec.slug}${suffix}-flat-3x4.webp`;
        const flatPreviewKey = `seed/${spec.slug}${suffix}-flat-preview.webp`;
        const lookbookKey = `seed/${spec.slug}${suffix}-lookbook.webp`;

        try {
          // Verify sharp hasAlpha === true on EVERY 2:3 cutout and 3:4 try-on cutout before overwriting MinIO
          const [rackBuf, rackBackBuf, flatBuf, lookbookBuf] = await Promise.all([
            readValidatedRealWebp(files.rackFront, {
              requireAlpha: true,
              label: `${spec.slug}:v${vIdx}:rack-2x3`,
            }),
            readValidatedRealWebp(files.rackBack ?? files.rackFront, {
              requireAlpha: true,
              label: `${spec.slug}:v${vIdx}:rack-back-2x3`,
            }),
            readValidatedRealWebp(files.tryonFlat ?? files.rackFront, {
              requireAlpha: true,
              label: `${spec.slug}:v${vIdx}:flat-3x4`,
            }),
            readValidatedRealWebp(files.lookbook, {
              requireAlpha: false,
              label: `${spec.slug}:v${vIdx}:lookbook`,
            }),
          ]);

          await Promise.all([
            this.putWebp(pubBucket, rackKey, rackBuf),
            this.putWebp(pubBucket, rackBackKey, rackBackBuf),
            this.putWebp(garBucket, flatKey, flatBuf),
            this.putWebp(pubBucket, flatPreviewKey, flatBuf),
            this.putWebp(pubBucket, lookbookKey, lookbookBuf),
          ]);

          variantUrlSpec.uploadedToMinio = true;
          anyUploaded = true;
        } catch (error) {
          logger.warn(
            {
              slug: spec.slug,
              variantIndex: vIdx,
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to validate/upload real photography WebP asset to MinIO',
          );
        }
      }

      prodUrls.uploadedToMinio = anyUploaded;
    }

    return map;
  }
}
