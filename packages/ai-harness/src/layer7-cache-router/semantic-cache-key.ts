import { createHash } from 'node:crypto';

export interface SemanticCacheKeyInput {
  intent: string;
  role: string;
  locale?: string;
  filters?: Record<string, string | number | boolean | null | undefined>;
}

export interface SemanticCacheKeyResult {
  key: string;
  normalizedSignature: string;
}

function normalizeTextSegment(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s:_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class SemanticCacheKeyBuilder {
  public build(input: SemanticCacheKeyInput): SemanticCacheKeyResult {
    const normalizedIntent = normalizeTextSegment(input.intent);
    const normalizedRole = input.role.trim().toUpperCase();
    const normalizedLocale = (input.locale ?? 'vi-VN').trim().toLowerCase();

    const sortedFilters: Record<string, string | number | boolean> = {};
    if (input.filters) {
      for (const key of Object.keys(input.filters).sort()) {
        const value = input.filters[key];
        if (value !== undefined && value !== null) {
          sortedFilters[key] =
            typeof value === 'string' ? normalizeTextSegment(value) : value;
        }
      }
    }

    const normalizedSignature = JSON.stringify({
      intent: normalizedIntent,
      role: normalizedRole,
      locale: normalizedLocale,
      filters: sortedFilters,
    });

    const key = createHash('sha256').update(normalizedSignature).digest('hex');
    return { key, normalizedSignature };
  }
}
