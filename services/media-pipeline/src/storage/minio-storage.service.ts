import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createLogger } from '@atelier/observability';
import {
  MEDIA_CONFIG_TOKEN,
  SERVICE_NAME,
  type MediaPipelineConfig,
} from '../config/env';

export interface StoredObjectResult {
  buffer: Buffer;
  contentType: string;
  contentLength: number;
  etag?: string;
}

function isS3NotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const err = error as {
    name?: string;
    Code?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const status = err.$metadata?.httpStatusCode;
  const code = err.name ?? err.Code ?? err.code ?? '';
  return (
    status === 404 ||
    code === 'NoSuchKey' ||
    code === 'NotFound' ||
    code === 'NoSuchBucket'
  );
}

function isBucketAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const err = error as {
    name?: string;
    Code?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const status = err.$metadata?.httpStatusCode;
  const code = err.name ?? err.Code ?? err.code ?? '';
  return (
    status === 409 ||
    code === 'BucketAlreadyOwnedByYou' ||
    code === 'BucketAlreadyExists'
  );
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  const withTransform = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof withTransform.transformToByteArray === 'function') {
    const arr = await withTransform.transformToByteArray();
    return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  }
  if (Symbol.asyncIterator in (body as Record<symbol, unknown>)) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | Buffer | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error('Unsupported S3 response body stream type');
}

@Injectable()
export class MinioStorageService implements OnModuleInit {
  private readonly logger = createLogger(SERVICE_NAME);
  private readonly s3Client: S3Client;
  private bucketsInitialized = false;

  constructor(@Inject(MEDIA_CONFIG_TOKEN) private readonly config: MediaPipelineConfig) {
    this.s3Client = new S3Client({
      endpoint: this.config.infra.minioEndpointUrl,
      forcePathStyle: true,
      region: 'us-east-1',
      credentials: {
        accessKeyId: this.config.infra.minioAccessKey,
        secretAccessKey: this.config.infra.minioSecretKey,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBuckets();
  }

  async ensureBuckets(): Promise<boolean> {
    const requiredBuckets = [
      this.config.infra.buckets.public,
      this.config.infra.buckets.garments,
      this.config.infra.buckets.privateTryOn,
    ];

    try {
      for (const bucket of requiredBuckets) {
        try {
          await this.s3Client.send(new HeadBucketCommand({ Bucket: bucket }));
        } catch (headErr: unknown) {
          if (isS3NotFoundError(headErr)) {
            try {
              await this.s3Client.send(new CreateBucketCommand({ Bucket: bucket }));
              this.logger.info({ bucket }, 'Created missing MinIO bucket');
            } catch (createErr: unknown) {
              if (!isBucketAlreadyExistsError(createErr)) {
                throw createErr;
              }
            }
          } else {
            throw headErr;
          }
        }
      }
      this.bucketsInitialized = true;
      this.logger.info(
        {
          endpoint: this.config.infra.minioEndpointUrl,
          buckets: requiredBuckets,
        },
        'MinIO object storage buckets verified',
      );
      return true;
    } catch (error: unknown) {
      this.bucketsInitialized = false;
      this.logger.warn(
        {
          endpoint: this.config.infra.minioEndpointUrl,
          err: error instanceof Error ? error.message : String(error),
        },
        'MinIO bucket initialization deferred (storage temporarily unreachable at boot)',
      );
      return false;
    }
  }

  async checkHealth(): Promise<{ ok: boolean; latencyMs: number; detail: string }> {
    const start = Date.now();
    try {
      if (!this.bucketsInitialized) {
        const initialized = await this.ensureBuckets();
        if (!initialized) {
          return {
            ok: false,
            latencyMs: Date.now() - start,
            detail: `MinIO ${this.config.infra.minioEndpointUrl} unreachable`,
          };
        }
      } else {
        await this.s3Client.send(
          new HeadBucketCommand({ Bucket: this.config.infra.buckets.public }),
        );
      }
      return {
        ok: true,
        latencyMs: Date.now() - start,
        detail: `MinIO ${this.config.infra.minioEndpointUrl} (${Object.values(this.config.infra.buckets).join(', ')}) ready`,
      };
    } catch (error: unknown) {
      this.bucketsInitialized = false;
      return {
        ok: false,
        latencyMs: Date.now() - start,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async presignPutObject(
    bucket: string,
    key: string,
    contentType: string,
    expiresInSeconds: number = 300,
  ): Promise<string> {
    if (!this.bucketsInitialized) {
      await this.ensureBuckets();
    }
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(this.s3Client, command, { expiresIn: expiresInSeconds });
  }

  async putObject(
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    if (!this.bucketsInitialized) {
      await this.ensureBuckets();
    }
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
      }),
    );
  }

  async getObjectWithMeta(bucket: string, key: string): Promise<StoredObjectResult | null> {
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );
      const buffer = await bodyToBuffer(response.Body);
      return {
        buffer,
        contentType: response.ContentType || 'application/octet-stream',
        contentLength: response.ContentLength ?? buffer.length,
        etag: response.ETag,
      };
    } catch (error: unknown) {
      if (isS3NotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async getObjectBuffer(bucket: string, key: string): Promise<Buffer | null> {
    const result = await this.getObjectWithMeta(bucket, key);
    return result ? result.buffer : null;
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
  }
}
