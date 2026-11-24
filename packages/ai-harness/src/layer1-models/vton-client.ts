import { createHash } from 'node:crypto';
import { CircuitBreaker, type CircuitState } from './circuit-breaker';

export type VtonProvider = 'mock' | 'fal';

export const DEFAULT_VTON_TIMEOUT_MS = 45_000;
export const DEFAULT_VTON_PURGE_MINUTES = 15;

export interface VtonClientOptions {
  provider?: VtonProvider;
  falApiKey?: string;
  falEndpoint?: string;
  timeoutMs?: number;
  circuitBreaker?: CircuitBreaker;
}

export interface VtonTryOnRequest {
  personImageUrl: string;
  garmentImageUrl: string;
  garmentCategory: 'upper_body' | 'lower_body' | 'dresses' | 'outerwear';
  correlationId: string;
}

export interface VtonTryOnResult {
  jobId: string;
  provider: VtonProvider;
  status: 'COMPLETED' | 'FALLBACK_MOCK';
  outputImageUrl: string;
  aspectRatio: '3:4';
  resolution: '768x1024';
  purgeAfterMinutes: number;
  latencyMs: number;
  estimatedCostUsd: number;
  circuitState: CircuitState;
}

export class VTONProviderClient {
  private readonly provider: VtonProvider;
  private readonly falApiKey: string;
  private readonly falEndpoint: string;
  private readonly timeoutMs: number;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(options: VtonClientOptions = {}) {
    const envProvider = (process.env.VTON_PROVIDER ?? 'mock').toLowerCase();
    this.provider =
      options.provider ?? (envProvider === 'fal' ? 'fal' : 'mock');
    this.falApiKey = (options.falApiKey ?? process.env.FAL_KEY ?? '').trim();
    this.falEndpoint =
      options.falEndpoint ?? 'https://queue.fal.run/fal-ai/idm-vton';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_VTON_TIMEOUT_MS;
    this.circuitBreaker =
      options.circuitBreaker ??
      new CircuitBreaker({
        name: 'vton-provider-client',
        failureThreshold: 3,
        cooldownMs: 45_000,
      });
  }

  public getProvider(): VtonProvider {
    return this.provider;
  }

  public getTimeoutMs(): number {
    return this.timeoutMs;
  }

  public getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }

  private buildMockResult(
    request: VtonTryOnRequest,
    startedAt: number,
    status: 'COMPLETED' | 'FALLBACK_MOCK',
  ): VtonTryOnResult {
    const digest = createHash('sha256')
      .update(
        `${request.personImageUrl}|${request.garmentImageUrl}|${request.garmentCategory}`,
      )
      .digest('hex')
      .slice(0, 12);

    return {
      jobId: `vton_mock_${digest}`,
      provider: 'mock',
      status,
      outputImageUrl: `minio://atelier-private-tryon/results/${digest}.webp`,
      aspectRatio: '3:4',
      resolution: '768x1024',
      purgeAfterMinutes: DEFAULT_VTON_PURGE_MINUTES,
      latencyMs: Date.now() - startedAt,
      estimatedCostUsd: 0,
      circuitState: this.circuitBreaker.getState(),
    };
  }

  public async runTryOn(request: VtonTryOnRequest): Promise<VtonTryOnResult> {
    const startedAt = Date.now();

    if (this.provider === 'mock' || this.falApiKey.length === 0) {
      return this.buildMockResult(
        request,
        startedAt,
        this.provider === 'mock' ? 'COMPLETED' : 'FALLBACK_MOCK',
      );
    }

    return this.circuitBreaker.execute(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(this.falEndpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Key ${this.falApiKey}`,
            'X-Correlation-Id': request.correlationId,
          },
          body: JSON.stringify({
            human_image_url: request.personImageUrl,
            garment_image_url: request.garmentImageUrl,
            category: request.garmentCategory,
          }),
        });

        if (!response.ok) {
          throw new Error(
            `FAL VTON provider responded with HTTP ${response.status}`,
          );
        }

        const data = (await response.json()) as {
          request_id?: string;
          image?: { url?: string };
        };

        return {
          jobId: data.request_id ?? `vton_fal_${Date.now()}`,
          provider: 'fal',
          status: 'COMPLETED',
          outputImageUrl:
            data.image?.url ??
            `minio://atelier-private-tryon/results/${request.correlationId}.webp`,
          aspectRatio: '3:4',
          resolution: '768x1024',
          purgeAfterMinutes: DEFAULT_VTON_PURGE_MINUTES,
          latencyMs: Date.now() - startedAt,
          estimatedCostUsd: 0.04,
          circuitState: this.circuitBreaker.getState(),
        };
      } finally {
        clearTimeout(timer);
      }
    });
  }
}
