import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import multer from 'multer';
import type { Response } from 'express';
import {
  createApiResponse,
  ErrorCode,
  type ApiResponse,
  type MediaAssetDto,
} from '@atelier/contracts';
import { getOrCreateCorrelationId, type HeaderBag } from '@atelier/observability';
import { MediaApiException } from '../common/media-api.exception';
import {
  isAllowedCorsOrigin,
  MEDIA_CONFIG_TOKEN,
  SERVICE_NAME,
  type MediaPipelineConfig,
} from '../config/env';
import {
  MediaService,
  type ListMediaResult,
  type MediaActorContext,
  type PresignResult,
  type RegisterSeedAssetsResult,
  type SpatialMetadataMap,
  type UpdateSpatialMetadataResult,
} from './media.service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UploadedFilePayload {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

function readSingleHeader(headers: HeaderBag, name: string): string | null {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (typeof candidate !== 'string') {
    return null;
  }
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractActorContext(headers: HeaderBag): MediaActorContext {
  const correlationId = getOrCreateCorrelationId(headers);
  const rawUserId = readSingleHeader(headers, 'x-user-id');
  const rawSupplierId = readSingleHeader(headers, 'x-supplier-id');

  const userId = rawUserId && UUID_REGEX.test(rawUserId) ? rawUserId : null;

  let supplierId: string | null = null;
  if (rawSupplierId !== null) {
    if (!UUID_REGEX.test(rawSupplierId)) {
      throw new MediaApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Header x-supplier-id phải là UUID hợp lệ. / Invalid x-supplier-id UUID header.',
      );
    }
    supplierId = rawSupplierId;
  }

  return {
    correlationId,
    userId,
    supplierId,
  };
}

function parseOptionalNumber(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  const num = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(num) ? num : undefined;
}

function parseOptionalRecord(raw: unknown): Record<string, unknown> | null | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === null || raw === '') {
    return null;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return undefined;
}

function inferMimeTypeFromFileName(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  return 'application/octet-stream';
}

function decodeBase64Upload(rawBase64: string): { buffer: Buffer; dataUriMimeType: string | null } {
  const trimmed = rawBase64.trim();
  const dataUriMatch = /^data:([^;]+);base64,([\s\S]+)$/i.exec(trimmed);
  if (dataUriMatch) {
    const mime = dataUriMatch[1].trim();
    const cleaned = dataUriMatch[2].replace(/\s+/g, '');
    return {
      buffer: Buffer.from(cleaned, 'base64'),
      dataUriMimeType: mime || null,
    };
  }
  return {
    buffer: Buffer.from(trimmed.replace(/\s+/g, ''), 'base64'),
    dataUriMimeType: null,
  };
}

@Controller('v1/media')
export class MediaController {
  constructor(
    @Inject(MEDIA_CONFIG_TOKEN) private readonly config: MediaPipelineConfig,
    private readonly mediaService: MediaService,
  ) {}

  @Get('internal/spatial-map')
  async getInternalSpatialMap(
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<SpatialMetadataMap>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.mediaService.getSpatialMetadataMap();
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('internal/register-seed-assets')
  @HttpCode(HttpStatus.OK)
  async registerSeedAssets(
    @Body() body: Record<string, unknown>,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<RegisterSeedAssetsResult>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.mediaService.registerSeedAssets(body);
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('presign')
  async presign(
    @Body() body: Record<string, unknown>,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<PresignResult>> {
    const actor = extractActorContext(headers);
    const data = await this.mediaService.presignUpload(body, actor);
    return createApiResponse(data, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('upload')
  @UseInterceptors(
    AnyFilesInterceptor({
      storage: multer.memoryStorage(),
      limits: {
        fileSize: 25 * 1024 * 1024,
        files: 2,
      },
    }),
  )
  async upload(
    @UploadedFiles() files: UploadedFilePayload[] | undefined,
    @Body() body: Record<string, unknown>,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<MediaAssetDto>> {
    const actor = extractActorContext(headers);
    const payload = body && typeof body === 'object' ? body : {};

    const multipartFile =
      Array.isArray(files) && files.length > 0
        ? (files.find((f) => f.fieldname === 'file') ?? files[0])
        : undefined;

    const assetType = typeof payload.assetType === 'string' ? payload.assetType.trim() : '';
    if (!assetType) {
      throw new MediaApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Thiếu trường bắt buộc assetType. / Missing required field "assetType".',
      );
    }

    let buffer: Buffer;
    let fileName: string;
    let mimeType: string;

    if (multipartFile) {
      buffer = multipartFile.buffer;
      fileName =
        (typeof payload.fileName === 'string' && payload.fileName.trim()) ||
        multipartFile.originalname ||
        'upload.bin';
      mimeType =
        (typeof payload.mimeType === 'string' && payload.mimeType.trim()) ||
        multipartFile.mimetype ||
        inferMimeTypeFromFileName(fileName);
    } else if (typeof payload.fileBase64 === 'string' && payload.fileBase64.trim().length > 0) {
      const decoded = decodeBase64Upload(payload.fileBase64);
      buffer = decoded.buffer;
      fileName =
        (typeof payload.fileName === 'string' && payload.fileName.trim()) ||
        `upload-${Date.now()}.bin`;
      mimeType =
        (typeof payload.mimeType === 'string' && payload.mimeType.trim()) ||
        decoded.dataUriMimeType ||
        inferMimeTypeFromFileName(fileName);
    } else {
      throw new MediaApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Yêu cầu phải gửi multipart/form-data (trường "file") hoặc JSON kèm "fileBase64". / Upload requires multipart "file" or JSON "fileBase64".',
      );
    }

    const result = await this.mediaService.uploadAndFinalize(
      {
        assetType,
        fileName,
        mimeType,
        buffer,
        supplierId: typeof payload.supplierId === 'string' ? payload.supplierId : null,
        hangerAnchorX: parseOptionalNumber(payload.hangerAnchorX),
        hangerAnchorY: parseOptionalNumber(payload.hangerAnchorY),
        boundingBoxJsonb: parseOptionalRecord(payload.boundingBoxJsonb),
        layerZHint: parseOptionalNumber(payload.layerZHint),
        productId: typeof payload.productId === 'string' ? payload.productId : undefined,
        variantId: typeof payload.variantId === 'string' ? payload.variantId : undefined,
      },
      actor,
    );

    return createApiResponse(result, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }

  @Get('public/:bucket')
  async streamPublicBucketRoot(
    @Param('bucket') bucket: string,
  ): Promise<never> {
    await this.mediaService.getPublicObject(bucket, '');
    throw new MediaApiException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.VALIDATION_ERROR,
      'Thiếu khóa đối tượng media. / Missing object key.',
    );
  }

  @Get('public/:bucket/*key')
  async streamPublicObject(
    @Param('bucket') bucket: string,
    @Param('key') rawKey: string | string[],
    @Headers() headers: HeaderBag,
    @Res() res: Response,
  ): Promise<void> {
    let objectKey: string;
    try {
      objectKey = Array.isArray(rawKey)
        ? rawKey.map((part) => decodeURIComponent(part)).join('/')
        : decodeURIComponent(String(rawKey ?? ''));
    } catch {
      throw new MediaApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Đường dẫn đối tượng chứa ký tự mã hóa URL không hợp lệ. / Malformed URL-encoded object key.',
      );
    }

    const stored = await this.mediaService.getPublicObject(bucket, objectKey);

    const origin = readSingleHeader(headers, 'origin');
    if (origin && isAllowedCorsOrigin(origin, this.config.corsAllowedOrigins)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    } else if (!origin) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Type', stored.contentType);
    res.setHeader('Content-Length', String(stored.buffer.length));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (stored.etag) {
      res.setHeader('ETag', stored.etag);
    }

    res.status(HttpStatus.OK).send(stored.buffer);
  }

  @Get()
  async listAssets(
    @Query('assetType') assetType: string | undefined,
    @Query('status') status: string | undefined,
    @Query('supplierId') supplierId: string | undefined,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<ListMediaResult>> {
    const actor = extractActorContext(headers);
    const data = await this.mediaService.listAssets(
      {
        assetType,
        status,
        supplierId,
        page: page ? Number.parseInt(page, 10) : undefined,
        pageSize: pageSize ? Number.parseInt(pageSize, 10) : undefined,
      },
      actor,
    );
    return createApiResponse(data, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }

  @Get(':assetId')
  async getAssetById(
    @Param('assetId') assetId: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<MediaAssetDto>> {
    const actor = extractActorContext(headers);
    const data = await this.mediaService.getAssetById(assetId, actor);
    return createApiResponse(data, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post(':assetId/finalize')
  @HttpCode(HttpStatus.OK)
  async finalizeAsset(
    @Param('assetId') assetId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<MediaAssetDto>> {
    const actor = extractActorContext(headers);
    const data = await this.mediaService.finalizeAsset(assetId, body, actor);
    return createApiResponse(data, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }

  @Patch(':assetId/spatial-metadata')
  async updateSpatialMetadata(
    @Param('assetId') assetId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<UpdateSpatialMetadataResult>> {
    const actor = extractActorContext(headers);
    const data = await this.mediaService.updateSpatialMetadata(assetId, body, actor);
    return createApiResponse(data, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }
}
