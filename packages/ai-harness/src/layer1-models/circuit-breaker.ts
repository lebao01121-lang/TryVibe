export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  name?: string;
  failureThreshold?: number;
  cooldownMs?: number;
  halfOpenMaxAttempts?: number;
}

export interface CircuitBreakerSnapshot {
  name: string;
  state: CircuitState;
  consecutiveFailures: number;
  failureThreshold: number;
  cooldownMs: number;
  openedAt: number | null;
  totalSuccesses: number;
  totalFailures: number;
}

export class CircuitBreakerOpenError extends Error {
  public readonly circuitName: string;
  public readonly retryAfterMs: number;

  constructor(circuitName: string, retryAfterMs: number) {
    super(
      `Circuit breaker "${circuitName}" is OPEN. Retry after ${Math.max(0, retryAfterMs)}ms.`,
    );
    this.name = 'CircuitBreakerOpenError';
    this.circuitName = circuitName;
    this.retryAfterMs = Math.max(0, retryAfterMs);
  }
}

export class CircuitBreaker {
  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly halfOpenMaxAttempts: number;

  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private halfOpenAttempts = 0;
  private totalSuccesses = 0;
  private totalFailures = 0;

  constructor(options: CircuitBreakerOptions = {}) {
    this.name = options.name ?? 'default-circuit';
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 3);
    this.cooldownMs = Math.max(100, options.cooldownMs ?? 30_000);
    this.halfOpenMaxAttempts = Math.max(1, options.halfOpenMaxAttempts ?? 1);
  }

  public getState(now = Date.now()): CircuitState {
    if (
      this.state === 'OPEN' &&
      this.openedAt !== null &&
      now - this.openedAt >= this.cooldownMs
    ) {
      this.state = 'HALF_OPEN';
      this.halfOpenAttempts = 0;
    }
    return this.state;
  }

  public getSnapshot(now = Date.now()): CircuitBreakerSnapshot {
    const currentState = this.getState(now);
    return {
      name: this.name,
      state: currentState,
      consecutiveFailures: this.consecutiveFailures,
      failureThreshold: this.failureThreshold,
      cooldownMs: this.cooldownMs,
      openedAt: this.openedAt,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
    };
  }

  public async execute<T>(operation: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const currentState = this.getState(now);

    if (currentState === 'OPEN') {
      const elapsed = this.openedAt !== null ? now - this.openedAt : 0;
      throw new CircuitBreakerOpenError(this.name, this.cooldownMs - elapsed);
    }

    if (currentState === 'HALF_OPEN') {
      if (this.halfOpenAttempts >= this.halfOpenMaxAttempts) {
        throw new CircuitBreakerOpenError(this.name, this.cooldownMs);
      }
      this.halfOpenAttempts += 1;
    }

    try {
      const result = await operation();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  public recordSuccess(): void {
    this.totalSuccesses += 1;
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.halfOpenAttempts = 0;
    this.state = 'CLOSED';
  }

  public recordFailure(now = Date.now()): void {
    this.totalFailures += 1;
    this.consecutiveFailures += 1;

    if (
      this.state === 'HALF_OPEN' ||
      this.consecutiveFailures >= this.failureThreshold
    ) {
      this.state = 'OPEN';
      this.openedAt = now;
      this.halfOpenAttempts = 0;
    }
  }

  public forceOpen(now = Date.now()): void {
    this.state = 'OPEN';
    this.openedAt = now;
    this.halfOpenAttempts = 0;
  }

  public reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.halfOpenAttempts = 0;
  }
}
