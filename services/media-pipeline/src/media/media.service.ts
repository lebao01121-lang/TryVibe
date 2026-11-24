import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  ErrorCode,
  MediaAssetStatus,
  MediaAssetStatusSchema,
  MediaAssetType,
  MediaAssetTypeSchema,
  MediaVariantEntrySchema,
  PresignUploadRequestSchema,
  UpdateSpatialMetadataSchema,
  type AssetSpatialMetadataDto,
  type MediaAssetDto,
  type MediaAssetProcessedPayload,
  type MediaVariantEntry,
  type PresignUploadResponse,
} from '@atelier/contracts';
import { createLogger } from '@atelier/observability';
import { MediaApiException } from '../common/media-api.exception';
import {
  MEDIA_CONFIG_TOKEN,
  SERVICE_NAME,
  type MediaPipelineConfig,
} from '../config/env';
import { MediaDbService } from '../db/media-db.service';
import { MediaEventPublisherService } from '../messaging/media-event-publisher.service';
import {
  computeDominantHex,
  detectMagicBytes,
  generateLookbookVariants,
  generateRackCutoutVariants,
  generateTryOnFlatLayVariants,
  inspectAspectAndAlpha,
} from '../pipeline/image-processor';
import { MinioStorageService, type StoredObjectResult } from '../storage/minio-storage.service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_BOUNDING_BOX: Record<string, unknown> = {
  shoulderY: 0.14,
  waistY: 0.44,
  hipY: 0.6,
  hemY: 0.9,
};

const DEFAULT_HANGER_ANCHOR_X = 0.5;
const DEFAULT_HANGER_ANCHOR_Y = 0.14;
const DEFAULT_LAYER_Z_HINT = 10;

const FinalizeOptionsSchema = z.object({
  hangerAnchorX: z.number().min(0).max(1).optional(),
  hangerAnchorY: z.number().min(0).max(1).optional(),
  boundingBoxJsonb: z.record(z.unknown()).nullable().optional(),
  layerZHint: z.number().int().optional(),
  productId: z.string().min(1).optional(),
  variantId: z.string().min(1).optional(),
});

const RegisterSeedAssetItemSchema = z.object({
  id: z.string().uuid(),
  assetType: MediaAssetTypeSchema,
  bucketName: z.string().trim().min(1).max(128).optional(),
  originalKey: z.string().trim().min(1),
  variants: z.record(MediaVariantEntrySchema).nullable().optional(),
  mimeType: z.string().trim().min(1).max(128).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  hasAlpha: z.boolean().optional(),
  dominantHex: z.string().trim().max(16).nullable().optional(),
  hangerAnchorX: z.number().min(0).max(1).optional(),
  hangerAnchorY: z.number().min(0).max(1).optional(),
  boundingBoxJsonb: z.record(z.unknown()).nullable().optional(),
  layerZHint: z.number().int().nullable().optional(),
});

const RegisterSeedAssetsRequestSchema = z.object({
  assets: z.array(RegisterSeedAssetItemSchema),
});

export interface RegisterSeedAssetsResult {
  registered: number;
  spatialInitialized: number;
  totalReceived: number;
  assetIds: string[];
}

export type SpatialMetadataMap = Record<string, AssetSpatialMetadataDto>;

export type UpdateSpatialMetadataResult = MediaAssetDto & AssetSpatialMetadataDto;

interface SpatialMetadataRow {
  asset_id: string;
  hanger_anchor_x: number;
  hanger_anchor_y: number;
  bounding_box_jsonb: Record<string, unknown> | string | null;
  layer_z_hint: number | null;
  updated_at: Date | string;
}

export interface MediaActorContext {
  correlationId: string;
  userId: string | null;
  supplierId: string | null;
}

export interface PresignResult extends PresignUploadResponse {
  publicBaseUrl: string;
}

export interface DirectUploadInput {
  assetType: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  supplierId?: string | null;
  hangerAnchorX?: number;
  hangerAnchorY?: number;
  boundingBoxJsonb?: Record<string, unknown> | null;
  layerZHint?: number;
  productId?: string;
  variantId?: string;
}

export interface ListMediaQuery {
  assetType?: string;
  status?: string;
  supplierId?: string;
  page?: number;
  pageSize?: number;
}

export interface ListMediaResult {
  items: MediaAssetDto[];
  total: number;
  page: number;
  pageSize: number;
}

interface MediaAssetJoinedRow {
  id: string;
  asset_type: MediaAssetType;
  bucket_name: string;
  original_key: string;
  variants_jsonb: Record<string, MediaVariantEntry> | string | null;
  mime_type: string;
  size_bytes: string | number | bigint;
  width: number | null;
  height: number | null;
  has_alpha: boolean;
  dominant_hex: string | null;
  uploaded_by: string | null;
  supplier_id: string | null;
  status: MediaAssetStatus;
  rejection_reason: string | null;
  created_at: Date | string;
  sm_asset_id: string | null;
  hanger_anchor_x: number | null;
  hanger_anchor_y: number | null;
  bounding_box_jsonb: Record<string, unknown> | string | null;
  layer_z_hint: number | null;
  sm_updated_at: Date | string | null;
}

function isValidUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value.trim());
}

function toIsoString(value: Date | string | null | undefined): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return new Date().toISOString();
}

function parseJsonObject<T>(value: T | string | null | undefined, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value;
}

function sanitizeFileName(rawName: string): string {
  const base = path.basename(rawName || 'upload.bin').trim();
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '')
    .slice(0, 120);
  return cleaned || 'upload.bin';
}

function mapAssetTypeToEventType(
  assetType: MediaAssetType,
): MediaAssetProcessedPayload['assetType'] {
  switch (assetType) {
    case MediaAssetType.RACK_CUTOUT_2_3:
      return 'RACK_FRONT';
    case MediaAssetType.STUDIO_LAYER_2_3:
    case MediaAssetType.PACKAGING_LAYER:
      return 'STUDIO_LAYER';
    case MediaAssetType.TRYON_FLAT_3_4:
      return 'GARMENT_FLAT_TRYON';
    case MediaAssetType.LOOKBOOK_PHOTO:
    case MediaAssetType.HERO_VIDEO:
    default:
      return 'LOOKBOOK';
  }
}

@Injectable()
export class MediaService {
  private readonly logger = createLogger(SERVICE_NAME);

  constructor(
    @Inject(MEDIA_CONFIG_TOKEN) private readonly config: MediaPipelineConfig,
    private readonly db: MediaDbService,
    private readonly storage: MinioStorageService,
    private readonly eventPublisher: MediaEventPublisherService,
  ) {}

  private buildPublicObjectUrl(bucket: string, key: string): string {
    const encodedKey = key
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    return `${this.config.publicBaseUrl}/${encodeURIComponent(bucket)}/${encodedKey}`;
  }

  private buildInternalMinioUrl(bucket: string, key: string): string {
    const encodedKey = key
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    return `${this.config.infra.minioPublicUrl}/${encodeURIComponent(bucket)}/${encodedKey}`;
  }

  private resolveBucketAndKey(
    assetId: string,
    assetType: MediaAssetType,
    fileName: string,
  ): { bucketName: string; objectKey: string } {
    const safeName = sanitizeFileName(fileName);
    if (assetType === MediaAssetType.TRYON_FLAT_3_4) {
      return {
        bucketName: this.config.infra.buckets.garments,
        objectKey: `raw/tryon-flat/${assetId}/${safeName}`,
      };
    }
    const prefix = assetType.toLowerCase().replace(/_/g, '-');
    return {
      bucketName: this.config.infra.buckets.public,
      objectKey: `raw/${prefix}/${assetId}/${safeName}`,
    };
  }

  private mapRowToDto(row: MediaAssetJoinedRow): MediaAssetDto {
    const variants = parseJsonObject<Record<string, MediaVariantEntry>>(
      row.variants_jsonb,
      {},
    );

    const previewEntry = variants.preview_url ?? variants['720w'] ?? variants['480w'];
    let publicUrl: string | undefined;
    if (typeof previewEntry === 'string' && previewEntry.length > 0) {
      publicUrl = previewEntry;
    } else if (previewEntry && typeof previewEntry === 'object' && previewEntry.url) {
      publicUrl = previewEntry.url;
    } else if (
      row.bucket_name === this.config.infra.buckets.public &&
      row.status === MediaAssetStatus.READY
    ) {
      publicUrl = this.buildPublicObjectUrl(row.bucket_name, row.original_key);
    }

    let spatialMetadata: AssetSpatialMetadataDto | null = null;
    if (row.sm_asset_id) {
      spatialMetadata = {
        assetId: row.sm_asset_id,
        hangerAnchorX: Number(row.hanger_anchor_x ?? DEFAULT_HANGER_ANCHOR_X),
        hangerAnchorY: Number(row.hanger_anchor_y ?? DEFAULT_HANGER_ANCHOR_Y),
        boundingBoxJsonb: parseJsonObject<Record<string, unknown> | null>(
          row.bounding_box_jsonb,
          null,
        ),
        layerZHint: row.layer_z_hint !== null ? Number(row.layer_z_hint) : null,
        updatedAt: toIsoString(row.sm_updated_at),
      };
    }

    return {
      id: row.id,
      assetType: row.asset_type,
      bucketName: row.bucket_name,
      originalKey: row.original_key,
      ...(publicUrl ? { publicUrl } : {}),
      variants,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes ?? 0),
      width: row.width !== null ? Number(row.width) : null,
      height: row.height !== null ? Number(row.height) : null,
      hasAlpha: Boolean(row.has_alpha),
      dominantHex: row.dominant_hex ?? null,
      uploadedBy: row.uploaded_by ?? null,
      supplierId: row.supplier_id ?? null,
      status: row.status,
      rejectionReason: row.rejection_reason ?? null,
      spatialMetadata,
      createdAt: toIsoString(row.created_at),
    };
  }

  private async fetchJoinedAssetRow(assetId: string): Promise<MediaAssetJoinedRow | null> {
    if (!isValidUuid(assetId)) {
      return null;
    }
    const res = await this.db.query<MediaAssetJoinedRow>(
      `
      SELECT
        m.id,
        m.asset_type,
        m.bucket_name,
        m.original_key,
        m.variants_jsonb,
        m.mime_type,
        m.size_bytes,
        m.width,
        m.height,
        m.has_alpha,
        m.dominant_hex,
        m.uploaded_by,
        m.supplier_id,
        m.status,
        m.rejection_reason,
        m.created_at,
        s.asset_id AS sm_asset_id,
        s.hanger_anchor_x,
        s.hanger_anchor_y,
        s.bounding_box_jsonb,
        s.layer_z_hint,
        s.updated_at AS sm_updated_at
      FROM media_assets m
      LEFT JOIN asset_spatial_metadata s ON s.asset_id = m.id
      WHERE m.id = $1
      LIMIT 1
      `,
      [assetId],
    );
    return res.rows[0] ?? null;
  }

  private async purgeRawAndReject(
    assetId: string,
    bucketName: string,
    objectKey: string,
    rejectionReason: string,
    extra: {
      sizeBytes?: number;
      width?: number | null;
      height?: number | null;
      hasAlpha?: boolean;
    } = {},
  ): Promise<void> {
    try {
      await this.storage.deleteObject(bucketName, objectKey);
    } catch (err: unknown) {
      this.logger.warn(
        {
          assetId,
          bucketName,
          objectKey,
          err: err instanceof Error ? err.message : String(err),
        },
        'Warning while purging rejected object from MinIO',
      );
    }

    await this.db.query(
      `
      UPDATE media_assets
      SET
        status = 'REJECTED',
        rejection_reason = $2,
        size_bytes = COALESCE($3, size_bytes),
        width = COALESCE($4, width),
        height = COALESCE($5, height),
        has_alpha = COALESCE($6, has_alpha)
      WHERE id = $1
      `,
      [
        assetId,
        rejectionReason,
        extra.sizeBytes ?? null,
        extra.width ?? null,
        extra.height ?? null,
        extra.hasAlpha ?? null,
      ],
    );
  }

  async presignUpload(rawBody: unknown, actor: MediaActorContext): Promise<PresignResult> {
    const parsed = PresignUploadRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new MediaApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Dữ liệu yêu cầu presign không hợp lệ. / Invalid presign request payload.',
        { issues: parsed.error.issues },
      );
    }

    const input = parsed.data;
    if (input.sizeBytes > this.config.maxUploadBytes) {
      throw new MediaApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Kích thước tệp vượt quá giới hạn tối đa 10MB. / File size exceeds 10MB limit.',
        { sizeBytes: input.sizeBytes, maxUploadBytes: this.config.maxUploadBytes },
      );
    }

    // Tenant boundary: x-supplier-id header always overrides body supplierId
    let effectiveSupplierId: string | null = actor.supplierId;
    if (!effectiveSupplierId && input.supplierId) {
      if (!isValidUuid(input.supplierId)) {
        throw new MediaApiException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.VALIDATION_ERROR,
          'supplierId phải là UUID hợp lệ. / supplierId must be a valid UUID.',
        );
      }
      effectiveSupplierId = input.supplierId;
    }

    const assetId = randomUUID();
    const { bucketName, objectKey } = this.resolveBucketAndKey(
      assetId,
      input.assetType,
      input.fileName,
    );

    const expiresInSeconds = 300;
    const uploadUrl = await this.storage.presignPutObject(
      bucketName,
      objectKey,
      input.mimeType,
      expiresInSeconds,
    );

    await this.db.query(
      `
      INSERT INTO media_assets (
        id, asset_type, bucket_name, original_key, variants_jsonb,
        mime_type, size_bytes, uploaded_by, supplier_id, status
      )
      VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $6, $7, $8, 'PENDING')
      `,
      [
        assetId,
        input.assetType,
        bucketName,
        objectKey,
        input.mimeType,
        input.sizeBytes,
        actor.userId,
        effectiveSupplierId,
      ],
    );

    return {
      assetId,
      bucketName,
      objectKey,
      uploadUrl,
      method: 'PUT',
      expiresInSeconds,
      requiredHeaders: {
        'Content-Type': input.mimeType,
      },
      publicBaseUrl: this.config.publicBaseUrl,
    };
  }

  async uploadAndFinalize(
    input: DirectUploadInput,
    actor: MediaActorContext,
  ): Promise<MediaAssetDto> {
    const assetTypeParsed = MediaAssetTypeSchema.safeParse(input.assetType);
    if (!assetTypeParsed.success) {
      throw new MediaApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'assetType không hợp lệ. / Invalid assetType.',
        { allowedAssetTypes: Object.values(MediaAssetType) },
      );
    }

    const assetType = assetTypeParsed.data;
    const buffer = input.buffer;

    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new MediaApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Tệp tải lên rỗng. / Uploaded file buffer is empty.',
      );
    }

    if (buffer.length > this.config.maxUploadBytes) {
      throw new MediaApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Kích thước tệp vượt quá giới hạn tối đa 10MB. / File size exceeds 10MB limit.',
        { sizeBytes: buffer.length, maxUploadBytes: this.config.maxUploadBytes },
      );
    }

    let effectiveSupplierId: string | null = actor.supplierId;
    if (!effectiveSupplierId && input.supplierId) {
      if (!isValidUuid(input.supplierId)) {
        throw new MediaApiException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.VALIDATION_ERROR,
          'supplierId phải là UUID hợp lệ. / supplierId must be a valid UUID.',
        );
      }
      effectiveSupplierId = input.supplierId;
    }

    const assetId = randomUUID();
    const declaredMimeType = input.mimeType?.trim() || 'application/octet-stream';
    const { bucketName, objectKey } = this.resolveBucketAndKey(
      assetId,
      assetType,
      input.fileName,
    );

    await this.db.query(
      `
      INSERT INTO media_assets (
        id, asset_type, bucket_name, original_key, variants_jsonb,
        mime_type, size_bytes, uploaded_by, supplier_id, status
      )
      VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $6, $7, $8, 'PENDING')
      `,
      [
        assetId,
        assetType,
        bucketName,
        objectKey,
        declaredMimeType,
        buffer.length,
        actor.userId,
        effectiveSupplierId,
      ],
    );

    // Upload raw object to MinIO first, then run the exact same finalize validation & purge pipeline
    await this.storage.putObject(bucketName, objectKey, buffer, declaredMimeType);

    return this.finalizeAsset(
      assetId,
      {
        hangerAnchorX: input.hangerAnchorX,
        hangerAnchorY: input.hangerAnchorY,
        boundingBoxJsonb: input.boundingBoxJsonb,
        layerZHint: input.layerZHint,
        productId: input.productId,
        variantId: input.variantId,
      },
      actor,
    );
  }

  async finalizeAsset(
    assetId: string,
    rawBody: unknown,
    actor: MediaActorContext,
  ): Promise<MediaAssetDto> {
    const row = await this.fetchJoinedAssetRow(assetId);
    if (!row) {
      throw new MediaApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy tài nguyên media "${assetId}". / Media asset not found.`,
      );
    }

    if (actor.supplierId && row.supplier_id !== actor.supplierId) {
      throw new MediaApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Bạn không có quyền thao tác tài nguyên media của nhà cung cấp khác. / Cross-tenant media access denied.',
      );
    }

    const bodyObj = rawBody && typeof rawBody === 'object' ? rawBody : {};
    const optionsParsed = FinalizeOptionsSchema.safeParse(bodyObj);
    if (!optionsParsed.success) {
      throw new MediaApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Tham số finalize không hợp lệ. / Invalid finalize parameters.',
        { issues: optionsParsed.error.issues },
      );
    }
    const opts = optionsParsed.data;

    // 1. Read actual uploaded bytes from MinIO
    const buffer = await this.storage.getObjectBuffer(row.bucket_name, row.original_key);
    if (!buffer) {
      throw new MediaApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'Không tìm thấy tệp gốc trên MinIO để hoàn tất xử lý. / Raw uploaded object not found in MinIO.',
        { assetId, bucketName: row.bucket_name, objectKey: row.original_key },
      );
    }

    // 2. Hard size check (<= 10MB, non-empty)
    if (buffer.length === 0 || buffer.length > this.config.maxUploadBytes) {
      const reason = buffer.length === 0 ? 'EMPTY_FILE' : 'FILE_SIZE_EXCEEDED';
      await this.purgeRawAndReject(assetId, row.bucket_name, row.original_key, reason, {
        sizeBytes: buffer.length,
      });
      throw new MediaApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        buffer.length === 0
          ? 'Tệp tải lên rỗng và đã bị xóa khỏi lưu trữ. / Uploaded file is empty.'
          : 'Kích thước tệp vượt quá giới hạn 10MB và đã bị xóa khỏi lưu trữ. / File size exceeds 10MB limit.',
        {
          assetId,
          bucketName: row.bucket_name,
          objectKey: row.original_key,
          sizeBytes: buffer.length,
          maxUploadBytes: this.config.maxUploadBytes,
        },
      );
    }

    // 3. Hard Magic Bytes validation
    const magic = detectMagicBytes(buffer);
    const isVideoAsset = row.asset_type === MediaAssetType.HERO_VIDEO;
    const magicValid = isVideoAsset
      ? magic.valid && magic.kind === 'video'
      : magic.valid && magic.kind === 'image';

    if (!magicValid || !magic.mimeType) {
      await this.purgeRawAndReject(
        assetId,
        row.bucket_name,
        row.original_key,
        'INVALID_MAGIC_BYTES',
        { sizeBytes: buffer.length },
      );
      throw new MediaApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.INVALID_MAGIC_BYTES,
        isVideoAsset
          ? 'Tệp video giả mạo hoặc không đúng chữ ký nhị phân (Magic Bytes MP4/WebM). Tệp đã bị xóa khỏi MinIO. / Invalid video Magic Bytes.'
          : 'Tệp giả mạo định dạng: chữ ký nhị phân (Magic Bytes) không khớp JPEG, PNG hoặc WebP. Tệp đã bị xóa khỏi MinIO. / Spoofed file rejected: Magic Bytes do not match JPEG, PNG, or WebP.',
        {
          assetId,
          bucketName: row.bucket_name,
          objectKey: row.original_key,
          declaredMimeType: row.mime_type,
          purgedFromStorage: true,
        },
      );
    }

    // Handle HERO_VIDEO (pass-through after Magic Bytes check)
    if (isVideoAsset) {
      const publicPreviewUrl = this.buildPublicObjectUrl(row.bucket_name, row.original_key);
      const variants: Record<string, MediaVariantEntry> = {
        preview_url: publicPreviewUrl,
      };
      await this.db.query(
        `
        UPDATE media_assets
        SET
          mime_type = $2,
          size_bytes = $3,
          variants_jsonb = $4::jsonb,
          status = 'READY',
          rejection_reason = NULL
        WHERE id = $1
        `,
        [assetId, magic.mimeType, buffer.length, JSON.stringify(variants)],
      );

      const readyRow = await this.fetchJoinedAssetRow(assetId);
      if (!readyRow) {
        throw new MediaApiException(
          HttpStatus.INTERNAL_SERVER_ERROR,
          ErrorCode.INTERNAL_ERROR,
          'Failed to reload finalized video asset.',
        );
      }
      return this.mapRowToDto(readyRow);
    }

    // 4. Inspect image via sharp (also rejects corrupted payloads disguised with valid header bytes)
    let inspection: Awaited<ReturnType<typeof inspectAspectAndAlpha>>;
    try {
      inspection = await inspectAspectAndAlpha(buffer);
    } catch (decodeErr: unknown) {
      await this.purgeRawAndReject(
        assetId,
        row.bucket_name,
        row.original_key,
        'INVALID_MAGIC_BYTES',
        { sizeBytes: buffer.length },
      );
      throw new MediaApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.INVALID_MAGIC_BYTES,
        'Tệp ảnh bị hỏng hoặc không thể giải mã hợp lệ. Tệp đã bị xóa khỏi MinIO. / Corrupted or unreadable image payload.',
        {
          assetId,
          bucketName: row.bucket_name,
          objectKey: row.original_key,
          reason: decodeErr instanceof Error ? decodeErr.message : String(decodeErr),
          purgedFromStorage: true,
        },
      );
    }

    const dominantHex = await computeDominantHex(buffer);
    const publicBucket = this.config.infra.buckets.public;
    const garmentsBucket = this.config.infra.buckets.garments;

    let variants: Record<string, MediaVariantEntry> = {};
    let finalWidth = inspection.width;
    let finalHeight = inspection.height;
    let finalHasAlpha = inspection.hasRealAlpha;
    let publishedBucket: 'atelier-public' | 'atelier-garments' = 'atelier-public';
    let publishedKey = row.original_key;

    // 5. Dual-Format sharp pipeline
    if (
      row.asset_type === MediaAssetType.RACK_CUTOUT_2_3 ||
      row.asset_type === MediaAssetType.STUDIO_LAYER_2_3 ||
      row.asset_type === MediaAssetType.PACKAGING_LAYER
    ) {
      // Strict 2:3 aspect ratio + real alpha transparency enforcement for RACK_CUTOUT_2_3 & STUDIO_LAYER_2_3
      const requiresStrictCutout =
        row.asset_type === MediaAssetType.RACK_CUTOUT_2_3 ||
        row.asset_type === MediaAssetType.STUDIO_LAYER_2_3;

      if (requiresStrictCutout && (!inspection.aspectValid || !inspection.hasRealAlpha)) {
        const reasonsVi: string[] = [];
        const reasonsEn: string[] = [];

        if (!inspection.aspectValid) {
          const pct = (inspection.aspectDeviationPct * 100).toFixed(2);
          reasonsVi.push(
            `Tỷ lệ khung hình ${inspection.width}x${inspection.height} (${inspection.aspectRatio.toFixed(4)}) lệch ${pct}% so với chuẩn 2:3 (cho phép tối đa 2%, phạm vi [0.6533, 0.6800])`,
          );
          reasonsEn.push(
            `Aspect ratio ${inspection.width}x${inspection.height} (${inspection.aspectRatio.toFixed(4)}) deviates ${pct}% from required 2:3 (max 2% tolerance)`,
          );
        }

        if (!inspection.hasRealAlpha) {
          reasonsVi.push(
            `Ảnh thiếu kênh trong suốt nền thật (hasAlpha=${String(inspection.hasAlphaMetadata)}, số góc trong suốt=${inspection.transparentCorners}/4, yêu cầu tối thiểu 3/4 góc có alpha < 10)`,
          );
          reasonsEn.push(
            `Image lacks genuine alpha transparency (hasAlpha=${String(inspection.hasAlphaMetadata)}, transparentCorners=${inspection.transparentCorners}/4, requires >= 3/4 corners with alpha < 10)`,
          );
        }

        const combinedReason = `${reasonsVi.join('; ')}. / ${reasonsEn.join('; ')}.`;
        await this.purgeRawAndReject(assetId, row.bucket_name, row.original_key, combinedReason, {
          sizeBytes: buffer.length,
          width: inspection.width,
          height: inspection.height,
          hasAlpha: inspection.hasRealAlpha,
        });

        throw new MediaApiException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ErrorCode.INVALID_ASPECT_OR_ALPHA,
          combinedReason,
          {
            assetId,
            assetType: row.asset_type,
            bucketName: row.bucket_name,
            objectKey: row.original_key,
            width: inspection.width,
            height: inspection.height,
            aspectRatio: Number(inspection.aspectRatio.toFixed(4)),
            expectedAspectRatio: '2:3 (0.6667 ± 2%)',
            hasAlphaMetadata: inspection.hasAlphaMetadata,
            transparentCorners: inspection.transparentCorners,
            cornerAlphas: inspection.cornerAlphas,
            purgedFromStorage: true,
          },
        );
      }

      const generated = await generateRackCutoutVariants(buffer);
      const key480 = `variants/${assetId}/480w.webp`;
      const key720 = `variants/${assetId}/720w.webp`;

      await Promise.all([
        this.storage.putObject(publicBucket, key480, generated.w480.buffer, generated.w480.mimeType),
        this.storage.putObject(publicBucket, key720, generated.w720.buffer, generated.w720.mimeType),
      ]);

      const url480 = this.buildPublicObjectUrl(publicBucket, key480);
      const url720 = this.buildPublicObjectUrl(publicBucket, key720);

      variants = {
        '480w': {
          key: key480,
          url: url480,
          width: generated.w480.width,
          height: generated.w480.height,
          mimeType: generated.w480.mimeType,
          sizeBytes: generated.w480.sizeBytes,
        },
        '720w': {
          key: key720,
          url: url720,
          width: generated.w720.width,
          height: generated.w720.height,
          mimeType: generated.w720.mimeType,
          sizeBytes: generated.w720.sizeBytes,
        },
        preview_url: url720,
      };

      finalHasAlpha = inspection.hasAlphaMetadata;
      publishedBucket = 'atelier-public';
      publishedKey = key720;

      // Initialize asset_spatial_metadata
      const anchorX = opts.hangerAnchorX ?? DEFAULT_HANGER_ANCHOR_X;
      const anchorY = opts.hangerAnchorY ?? DEFAULT_HANGER_ANCHOR_Y;
      const boundingBox =
        opts.boundingBoxJsonb !== undefined ? opts.boundingBoxJsonb : DEFAULT_BOUNDING_BOX;
      const layerZHint = opts.layerZHint ?? DEFAULT_LAYER_Z_HINT;

      await this.db.query(
        `
        INSERT INTO asset_spatial_metadata (
          asset_id, hanger_anchor_x, hanger_anchor_y, bounding_box_jsonb, layer_z_hint, updated_at
        )
        VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
        ON CONFLICT (asset_id) DO UPDATE SET
          hanger_anchor_x = EXCLUDED.hanger_anchor_x,
          hanger_anchor_y = EXCLUDED.hanger_anchor_y,
          bounding_box_jsonb = EXCLUDED.bounding_box_jsonb,
          layer_z_hint = EXCLUDED.layer_z_hint,
          updated_at = NOW()
        `,
        [assetId, anchorX, anchorY, boundingBox ? JSON.stringify(boundingBox) : null, layerZHint],
      );
    } else if (row.asset_type === MediaAssetType.TRYON_FLAT_3_4) {
      // Flow 2 — AI Try-On Flat-Lay (768x1024 studio neutral backdrop in atelier-garments + preview in atelier-public)
      const generated = await generateTryOnFlatLayVariants(buffer);
      const flatKey = `garments/${assetId}/flat_768x1024.webp`;
      const previewKey = `variants/${assetId}/flat_preview_768x1024.webp`;
      const key720 = `variants/${assetId}/720w.webp`;

      await Promise.all([
        this.storage.putObject(
          garmentsBucket,
          flatKey,
          generated.flat768x1024.buffer,
          generated.flat768x1024.mimeType,
        ),
        this.storage.putObject(
          publicBucket,
          previewKey,
          generated.preview768x1024.buffer,
          generated.preview768x1024.mimeType,
        ),
        this.storage.putObject(
          publicBucket,
          key720,
          generated.w720.buffer,
          generated.w720.mimeType,
        ),
      ]);

      const flatUrl = this.buildInternalMinioUrl(garmentsBucket, flatKey);
      const previewUrl = this.buildPublicObjectUrl(publicBucket, previewKey);
      const url720 = this.buildPublicObjectUrl(publicBucket, key720);

      variants = {
        flat_768x1024: {
          key: flatKey,
          url: flatUrl,
          width: generated.flat768x1024.width,
          height: generated.flat768x1024.height,
          mimeType: generated.flat768x1024.mimeType,
          sizeBytes: generated.flat768x1024.sizeBytes,
        },
        '720w': {
          key: key720,
          url: url720,
          width: generated.w720.width,
          height: generated.w720.height,
          mimeType: generated.w720.mimeType,
          sizeBytes: generated.w720.sizeBytes,
        },
        preview_url: previewUrl,
      };

      finalWidth = generated.flat768x1024.width;
      finalHeight = generated.flat768x1024.height;
      finalHasAlpha = false;
      publishedBucket = 'atelier-garments';
      publishedKey = flatKey;
    } else {
      // Flow 3 — Editorial Lookbook (960w & 1600w WebP into atelier-public)
      const generated = await generateLookbookVariants(buffer);
      const key960 = `variants/${assetId}/960w.webp`;
      const key1600 = `variants/${assetId}/1600w.webp`;

      await Promise.all([
        this.storage.putObject(publicBucket, key960, generated.w960.buffer, generated.w960.mimeType),
        this.storage.putObject(
          publicBucket,
          key1600,
          generated.w1600.buffer,
          generated.w1600.mimeType,
        ),
      ]);

      const url960 = this.buildPublicObjectUrl(publicBucket, key960);
      const url1600 = this.buildPublicObjectUrl(publicBucket, key1600);

      variants = {
        '960w': {
          key: key960,
          url: url960,
          width: generated.w960.width,
          height: generated.w960.height,
          mimeType: generated.w960.mimeType,
          sizeBytes: generated.w960.sizeBytes,
        },
        '1600w': {
          key: key1600,
          url: url1600,
          width: generated.w1600.width,
          height: generated.w1600.height,
          mimeType: generated.w1600.mimeType,
          sizeBytes: generated.w1600.sizeBytes,
        },
        preview_url: url960,
      };

      publishedBucket = 'atelier-public';
      publishedKey = key1600;
    }

    await this.db.query(
      `
      UPDATE media_assets
      SET
        mime_type = $2,
        size_bytes = $3,
        width = $4,
        height = $5,
        has_alpha = $6,
        dominant_hex = $7,
        variants_jsonb = $8::jsonb,
        status = 'READY',
        rejection_reason = NULL
      WHERE id = $1
      `,
      [
        assetId,
        magic.mimeType,
        buffer.length,
        finalWidth,
        finalHeight,
        finalHasAlpha,
        dominantHex,
        JSON.stringify(variants),
      ],
    );

    // 6. Publish media.asset.processed domain event (non-fatal if RabbitMQ offline)
    const eventPayload: MediaAssetProcessedPayload = {
      assetId,
      productId: opts.productId ?? 'unassigned',
      ...(opts.variantId ? { variantId: opts.variantId } : {}),
      bucket: publishedBucket,
      objectKey: publishedKey,
      assetType: mapAssetTypeToEventType(row.asset_type),
      widthPx: finalWidth,
      heightPx: finalHeight,
      hasAlphaChannel: finalHasAlpha,
      autoAttachAsTryOnGarment: false,
      requiresHumanApproval: true,
    };
    await this.eventPublisher.publishMediaAssetProcessed(eventPayload, actor.correlationId);

    const updatedRow = await this.fetchJoinedAssetRow(assetId);
    if (!updatedRow) {
      throw new MediaApiException(
        HttpStatus.INTERNAL_SERVER_ERROR,
        ErrorCode.INTERNAL_ERROR,
        'Failed to reload finalized media asset.',
      );
    }

    return this.mapRowToDto(updatedRow);
  }

  async listAssets(query: ListMediaQuery, actor: MediaActorContext): Promise<ListMediaResult> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.assetType) {
      const parsedType = MediaAssetTypeSchema.safeParse(query.assetType);
      if (!parsedType.success) {
        throw new MediaApiException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.VALIDATION_ERROR,
          'Giá trị lọc assetType không hợp lệ. / Invalid assetType filter.',
        );
      }
      params.push(parsedType.data);
      conditions.push(`m.asset_type = $${params.length}`);
    }

    if (query.status) {
      const parsedStatus = MediaAssetStatusSchema.safeParse(query.status);
      if (!parsedStatus.success) {
        throw new MediaApiException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.VALIDATION_ERROR,
          'Giá trị lọc status không hợp lệ. / Invalid status filter.',
        );
      }
      params.push(parsedStatus.data);
      conditions.push(`m.status = $${params.length}`);
    }

    // Strict tenant isolation: x-supplier-id header overrides query param
    const effectiveSupplierId = actor.supplierId ?? (query.supplierId?.trim() || null);
    if (effectiveSupplierId) {
      if (!isValidUuid(effectiveSupplierId)) {
        throw new MediaApiException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.VALIDATION_ERROR,
          'supplierId phải là UUID hợp lệ. / supplierId must be a valid UUID.',
        );
      }
      params.push(effectiveSupplierId);
      conditions.push(`m.supplier_id = $${params.length}`);
    }

    const page = Math.max(1, Number.isFinite(query.page) ? Math.trunc(query.page as number) : 1);
    const pageSize = Math.min(
      100,
      Math.max(1, Number.isFinite(query.pageSize) ? Math.trunc(query.pageSize as number) : 20),
    );
    const offset = (page - 1) * pageSize;

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await this.db.query<{ total: string | number }>(
      `SELECT COUNT(*)::int AS total FROM media_assets m ${whereClause}`,
      params,
    );
    const total = Number(countRes.rows[0]?.total ?? 0);

    const listParams = [...params, pageSize, offset];
    const limitParam = `$${listParams.length - 1}`;
    const offsetParam = `$${listParams.length}`;

    const rowsRes = await this.db.query<MediaAssetJoinedRow>(
      `
      SELECT
        m.id,
        m.asset_type,
        m.bucket_name,
        m.original_key,
        m.variants_jsonb,
        m.mime_type,
        m.size_bytes,
        m.width,
        m.height,
        m.has_alpha,
        m.dominant_hex,
        m.uploaded_by,
        m.supplier_id,
        m.status,
        m.rejection_reason,
        m.created_at,
        s.asset_id AS sm_asset_id,
        s.hanger_anchor_x,
        s.hanger_anchor_y,
        s.bounding_box_jsonb,
        s.layer_z_hint,
        s.updated_at AS sm_updated_at
      FROM media_assets m
      LEFT JOIN asset_spatial_metadata s ON s.asset_id = m.id
      ${whereClause}
      ORDER BY m.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}
      `,
      listParams,
    );

    return {
      items: rowsRes.rows.map((row: MediaAssetJoinedRow) => this.mapRowToDto(row)),
      total,
      page,
      pageSize,
    };
  }

  async getAssetById(assetId: string, actor: MediaActorContext): Promise<MediaAssetDto> {
    const row = await this.fetchJoinedAssetRow(assetId);
    if (!row) {
      throw new MediaApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy tài nguyên media "${assetId}". / Media asset not found.`,
      );
    }

    if (actor.supplierId && row.supplier_id !== actor.supplierId) {
      throw new MediaApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Bạn không có quyền xem tài nguyên media của nhà cung cấp khác. / Cross-tenant media access denied.',
      );
    }

    return this.mapRowToDto(row);
  }

  async getSpatialMetadataMap(): Promise<SpatialMetadataMap> {
    const res = await this.db.query<SpatialMetadataRow>(
      `
      SELECT
        asset_id,
        hanger_anchor_x,
        hanger_anchor_y,
        bounding_box_jsonb,
        layer_z_hint,
        updated_at
      FROM asset_spatial_metadata
      `,
    );

    const map: SpatialMetadataMap = {};
    for (const row of res.rows) {
      map[row.asset_id] = {
        assetId: row.asset_id,
        hangerAnchorX: Number(row.hanger_anchor_x ?? DEFAULT_HANGER_ANCHOR_X),
        hangerAnchorY: Number(row.hanger_anchor_y ?? DEFAULT_HANGER_ANCHOR_Y),
        boundingBoxJsonb: parseJsonObject<Record<string, unknown> | null>(
          row.bounding_box_jsonb,
          null,
        ),
        layerZHint: row.layer_z_hint !== null ? Number(row.layer_z_hint) : null,
        updatedAt: toIsoString(row.updated_at),
      };
    }

    return map;
  }

  async registerSeedAssets(rawBody: unknown): Promise<RegisterSeedAssetsResult> {
    const parsed = RegisterSeedAssetsRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new MediaApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Danh sách seed assets đăng ký không hợp lệ. / Invalid register-seed-assets payload.',
        { issues: parsed.error.issues },
      );
    }

    const { assets } = parsed.data;
    if (assets.length === 0) {
      return {
        registered: 0,
        spatialInitialized: 0,
        totalReceived: 0,
        assetIds: [],
      };
    }

    let registered = 0;
    let spatialInitialized = 0;

    await this.db.transaction(async (tx) => {
      for (const item of assets) {
        const bucketName = item.bucketName || this.config.infra.buckets.public;
        const variants = item.variants ?? {};
        const mimeType = item.mimeType || 'image/webp';
        const sizeBytes = item.sizeBytes ?? 0;
        const hasAlpha = item.hasAlpha ?? true;

        const assetRes = await tx.query<{ id: string }>(
          `
          INSERT INTO media_assets (
            id,
            asset_type,
            bucket_name,
            original_key,
            variants_jsonb,
            mime_type,
            size_bytes,
            width,
            height,
            has_alpha,
            dominant_hex,
            status
          )
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, 'READY')
          ON CONFLICT (id) DO NOTHING
          RETURNING id
          `,
          [
            item.id,
            item.assetType,
            bucketName,
            item.originalKey,
            JSON.stringify(variants),
            mimeType,
            sizeBytes,
            item.width ?? null,
            item.height ?? null,
            hasAlpha,
            item.dominantHex ?? null,
          ],
        );
        if (assetRes.rows.length > 0) {
          registered += 1;
        }

        const anchorX = item.hangerAnchorX ?? DEFAULT_HANGER_ANCHOR_X;
        const anchorY = item.hangerAnchorY ?? DEFAULT_HANGER_ANCHOR_Y;
        const boundingBox =
          item.boundingBoxJsonb !== undefined ? item.boundingBoxJsonb : DEFAULT_BOUNDING_BOX;
        const layerZHint =
          item.layerZHint !== undefined ? item.layerZHint : DEFAULT_LAYER_Z_HINT;

        const spatialRes = await tx.query<{ asset_id: string }>(
          `
          INSERT INTO asset_spatial_metadata (
            asset_id,
            hanger_anchor_x,
            hanger_anchor_y,
            bounding_box_jsonb,
            layer_z_hint,
            updated_at
          )
          VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
          ON CONFLICT (asset_id) DO UPDATE SET
            hanger_anchor_x = EXCLUDED.hanger_anchor_x,
            hanger_anchor_y = EXCLUDED.hanger_anchor_y,
            updated_at = NOW()
          WHERE ABS(asset_spatial_metadata.hanger_anchor_y - 0.06) < 0.005
          RETURNING asset_id
          `,
          [
            item.id,
            anchorX,
            anchorY,
            boundingBox !== null ? JSON.stringify(boundingBox) : null,
            layerZHint,
          ],
        );
        if (spatialRes.rows.length > 0) {
          spatialInitialized += 1;
        }
      }
    });

    return {
      registered,
      spatialInitialized,
      totalReceived: assets.length,
      assetIds: assets.map((item) => item.id),
    };
  }

  async updateSpatialMetadata(
    assetId: string,
    rawBody: unknown,
    actor: MediaActorContext,
  ): Promise<UpdateSpatialMetadataResult> {
    const parsed = UpdateSpatialMetadataSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new MediaApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Tọa độ neo không gian (spatial metadata) không hợp lệ. / Invalid spatial metadata payload.',
        { issues: parsed.error.issues },
      );
    }

    const row = await this.fetchJoinedAssetRow(assetId);
    if (!row) {
      throw new MediaApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy tài nguyên media "${assetId}". / Media asset not found.`,
      );
    }

    if (actor.supplierId && row.supplier_id !== actor.supplierId) {
      throw new MediaApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Bạn không có quyền hiệu chỉnh tài nguyên media của nhà cung cấp khác. / Cross-tenant media access denied.',
      );
    }

    const input = parsed.data;
    const existingBox = parseJsonObject<Record<string, unknown> | null>(
      row.bounding_box_jsonb,
      DEFAULT_BOUNDING_BOX,
    );
    const nextBoundingBox =
      input.boundingBoxJsonb !== undefined ? input.boundingBoxJsonb : existingBox;
    const nextLayerZHint =
      input.layerZHint !== undefined
        ? input.layerZHint
        : (row.layer_z_hint ?? DEFAULT_LAYER_Z_HINT);

    await this.db.query(
      `
      INSERT INTO asset_spatial_metadata (
        asset_id, hanger_anchor_x, hanger_anchor_y, bounding_box_jsonb, layer_z_hint, updated_at
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
      ON CONFLICT (asset_id) DO UPDATE SET
        hanger_anchor_x = EXCLUDED.hanger_anchor_x,
        hanger_anchor_y = EXCLUDED.hanger_anchor_y,
        bounding_box_jsonb = EXCLUDED.bounding_box_jsonb,
        layer_z_hint = EXCLUDED.layer_z_hint,
        updated_at = NOW()
      `,
      [
        assetId,
        input.hangerAnchorX,
        input.hangerAnchorY,
        nextBoundingBox !== null ? JSON.stringify(nextBoundingBox) : null,
        nextLayerZHint,
      ],
    );

    const updated = await this.fetchJoinedAssetRow(assetId);
    if (!updated) {
      throw new MediaApiException(
        HttpStatus.INTERNAL_SERVER_ERROR,
        ErrorCode.INTERNAL_ERROR,
        'Failed to reload updated media spatial metadata.',
      );
    }

    const dto = this.mapRowToDto(updated);
    const spatialMetadata: AssetSpatialMetadataDto = dto.spatialMetadata ?? {
      assetId,
      hangerAnchorX: input.hangerAnchorX,
      hangerAnchorY: input.hangerAnchorY,
      boundingBoxJsonb: nextBoundingBox,
      layerZHint: nextLayerZHint,
      updatedAt: new Date().toISOString(),
    };

    return {
      ...dto,
      ...spatialMetadata,
      spatialMetadata,
    };
  }

  async getPublicObject(bucket: string, rawKey: string): Promise<StoredObjectResult> {
    const cleanBucket = bucket.trim();
    const cleanKey = rawKey.replace(/^\/+/, '');

    // Hard privacy rule: NEVER serve atelier-private-tryon unsigned -> 403 Forbidden
    if (cleanBucket === this.config.infra.buckets.privateTryOn) {
      throw new MediaApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Truy cập công khai không ký tên vào atelier-private-tryon bị nghiêm cấm (403). / Unsigned access to atelier-private-tryon is strictly forbidden.',
        { bucket: cleanBucket },
      );
    }

    // Allow atelier-public freely, or strictly authorized preview prefixes on atelier-garments
    const isPublicBucket = cleanBucket === this.config.infra.buckets.public;
    const isAuthorizedPreview =
      cleanBucket === this.config.infra.buckets.garments && cleanKey.startsWith('previews/');

    if (!isPublicBucket && !isAuthorizedPreview) {
      throw new MediaApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Bucket hoặc đối tượng này không được phép truy cập công khai. / Public access denied for requested bucket or object.',
        { bucket: cleanBucket },
      );
    }

    if (!cleanKey || cleanKey.includes('..') || cleanKey.includes('\0')) {
      throw new MediaApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Đường dẫn đối tượng không hợp lệ. / Invalid object key.',
      );
    }

    const stored = await this.storage.getObjectWithMeta(cleanBucket, cleanKey);
    if (!stored) {
      throw new MediaApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'Không tìm thấy đối tượng media trên MinIO. / Requested media object was not found.',
        { bucket: cleanBucket, key: cleanKey },
      );
    }

    return stored;
  }
}
