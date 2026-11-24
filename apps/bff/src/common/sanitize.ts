import { RESTRICTED_COST_FIELDS } from '@atelier/contracts';

const STOREFRONT_STRIP_KEYS: ReadonlySet<string> = new Set([
  ...RESTRICTED_COST_FIELDS,
  'costPriceVnd',
  'cost_price_vnd',
  'costPrice',
  'cost_price',
  'giaNhap',
  'gia_nhap',
  'cogs',
  'unitCostVnd',
  'unit_cost_vnd',
  'estimatedCostVnd',
  'estimated_cost_vnd',
  'wholesaleCostVnd',
  'wholesale_cost_vnd',
  'wholesalePriceVnd',
  'wholesale_price_vnd',
  'supplierId',
  'supplier_id',
]);

function isSensitiveStorefrontKey(key: string): boolean {
  if (STOREFRONT_STRIP_KEYS.has(key)) {
    return true;
  }
  const lower = key.toLowerCase();
  return (
    lower === 'costpricevnd' ||
    lower === 'cost_price_vnd' ||
    lower === 'costprice' ||
    lower === 'cost_price' ||
    lower === 'supplierid' ||
    lower === 'supplier_id' ||
    lower === 'wholesalecostvnd' ||
    lower === 'wholesale_cost_vnd' ||
    lower === 'gianhap' ||
    lower === 'gia_nhap' ||
    lower === 'cogs'
  );
}

function stripRecursive(value: unknown, activeAncestors: WeakSet<object>): unknown {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (activeAncestors.has(value)) {
    return undefined;
  }
  activeAncestors.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((item) => stripRecursive(item, activeAncestors));
    }

    const record = value as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (isSensitiveStorefrontKey(key)) {
        continue;
      }
      cleaned[key] = stripRecursive(entry, activeAncestors);
    }
    return cleaned;
  } finally {
    activeAncestors.delete(value);
  }
}

export function stripStorefrontSensitiveFields<T>(payload: T): T {
  return stripRecursive(payload, new WeakSet<object>()) as T;
}

export function buildCanonicalQueryString(
  query: Record<string, unknown>,
): string {
  const pairs: Array<[string, string]> = [];
  for (const [key, rawValue] of Object.entries(query)) {
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    if (Array.isArray(rawValue)) {
      for (const item of rawValue) {
        if (item !== undefined && item !== null && String(item).trim() !== '') {
          pairs.push([key, String(item).trim()]);
        }
      }
    } else {
      const str = String(rawValue).trim();
      if (str !== '') {
        pairs.push([key, str]);
      }
    }
  }

  pairs.sort((a, b) => {
    const keyCmp = a[0].localeCompare(b[0]);
    return keyCmp !== 0 ? keyCmp : a[1].localeCompare(b[1]);
  });

  const params = new URLSearchParams();
  for (const [k, v] of pairs) {
    params.append(k, v);
  }
  return params.toString();
}
