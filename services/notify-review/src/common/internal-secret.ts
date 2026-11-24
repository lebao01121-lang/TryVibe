import * as crypto from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { ErrorCode } from '@atelier/contracts';
import type { HeaderBag } from '@atelier/observability';

export function readHeader(headers: HeaderBag, key: string): string | undefined {
  const direct = headers[key] ?? headers[key.toLowerCase()];
  if (Array.isArray(direct)) {
    return direct[0];
  }
  return typeof direct === 'string' && direct.trim() !== '' ? direct.trim() : undefined;
}

export function timingSafeSecretEqual(provided: string, expected: string): boolean {
  const bufA = Buffer.from(provided, 'utf8');
  const bufB = Buffer.from(expected, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function hasValidInternalSecret(headers: HeaderBag, expectedSecret: string): boolean {
  const provided = readHeader(headers, 'x-internal-secret');
  if (!provided || !expectedSecret) {
    return false;
  }
  return timingSafeSecretEqual(provided, expectedSecret);
}

export function assertInternalSecret(headers: HeaderBag, expectedSecret: string): void {
  if (!hasValidInternalSecret(headers, expectedSecret)) {
    throw new ForbiddenException({
      code: ErrorCode.FORBIDDEN,
      message: 'Invalid or missing x-internal-secret header.',
    });
  }
}
