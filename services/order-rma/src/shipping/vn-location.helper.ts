import * as crypto from 'node:crypto';
import type { HeaderBag } from '@atelier/observability';
import { extractHeader, timingSafeSecretEqual } from '../common/api-exception';
import type { ShippingZoneType } from './shipping-provider.interface';

export interface ResolvedVnLocation {
  provinceCode: string | null;
  provinceName: string;
  districtCode: string | null;
  districtName: string;
  wardCode: string | null;
  wardName: string;
  region: 'NORTH' | 'CENTRAL' | 'SOUTH';
  zone: ShippingZoneType;
  isHanoi: boolean;
  isHcm: boolean;
  isAhaMoveEligible: boolean;
  isInnerDistrict: boolean;
  estimatedDistanceKm: number;
}

interface ProvinceMeta {
  code: string;
  canonicalName: string;
  aliases: readonly string[];
  region: 'NORTH' | 'CENTRAL' | 'SOUTH';
  distanceFromHanoiKm: number;
}

/**
 * Standardized P1 GSO Administrative Division province table (aligned with
 * `apps/storefront/src/lib/vn-admin-divisions.ts`).
 */
const VN_PROVINCE_META: readonly ProvinceMeta[] = [
  {
    code: '01',
    canonicalName: 'Thành phố Hà Nội',
    aliases: ['ha noi', 'hà nội', 'hanoi', 'hn'],
    region: 'NORTH',
    distanceFromHanoiKm: 12,
  },
  {
    code: '79',
    canonicalName: 'Thành phố Hồ Chí Minh',
    aliases: ['ho chi minh', 'hồ chí minh', 'tp.hcm', 'tphcm', 'hcm', 'sai gon', 'sài gòn'],
    region: 'SOUTH',
    distanceFromHanoiKm: 1680,
  },
  {
    code: '48',
    canonicalName: 'Thành phố Đà Nẵng',
    aliases: ['da nang', 'đà nẵng', 'danang'],
    region: 'CENTRAL',
    distanceFromHanoiKm: 765,
  },
  {
    code: '31',
    canonicalName: 'Thành phố Hải Phòng',
    aliases: ['hai phong', 'hải phòng', 'haiphong'],
    region: 'NORTH',
    distanceFromHanoiKm: 120,
  },
  {
    code: '92',
    canonicalName: 'Thành phố Cần Thơ',
    aliases: ['can tho', 'cần thơ', 'cantho'],
    region: 'SOUTH',
    distanceFromHanoiKm: 1850,
  },
  {
    code: '46',
    canonicalName: 'Tỉnh Thừa Thiên Huế',
    aliases: ['thua thien hue', 'thừa thiên huế', 'hue', 'huế'],
    region: 'CENTRAL',
    distanceFromHanoiKm: 660,
  },
  {
    code: '56',
    canonicalName: 'Tỉnh Khánh Hòa',
    aliases: ['khanh hoa', 'khánh hòa', 'nha trang'],
    region: 'CENTRAL',
    distanceFromHanoiKm: 1280,
  },
  {
    code: '68',
    canonicalName: 'Tỉnh Lâm Đồng',
    aliases: ['lam dong', 'lâm đồng', 'da lat', 'đà lạt'],
    region: 'CENTRAL',
    distanceFromHanoiKm: 1480,
  },
  {
    code: '22',
    canonicalName: 'Tỉnh Quảng Ninh',
    aliases: ['quang ninh', 'quảng ninh', 'ha long', 'hạ long'],
    region: 'NORTH',
    distanceFromHanoiKm: 165,
  },
  {
    code: '74',
    canonicalName: 'Tỉnh Bình Dương',
    aliases: ['binh duong', 'bình dương'],
    region: 'SOUTH',
    distanceFromHanoiKm: 1640,
  },
  {
    code: '75',
    canonicalName: 'Tỉnh Đồng Nai',
    aliases: ['dong nai', 'đồng nai', 'bien hoa', 'biên hòa'],
    region: 'SOUTH',
    distanceFromHanoiKm: 1650,
  },
  {
    code: '27',
    canonicalName: 'Tỉnh Bắc Ninh',
    aliases: ['bac ninh', 'bắc ninh'],
    region: 'NORTH',
    distanceFromHanoiKm: 35,
  },
  {
    code: '49',
    canonicalName: 'Tỉnh Quảng Nam',
    aliases: ['quang nam', 'quảng nam', 'hoi an', 'hội an'],
    region: 'CENTRAL',
    distanceFromHanoiKm: 800,
  },
  {
    code: '77',
    canonicalName: 'Tỉnh Bà Rịa - Vũng Tàu',
    aliases: ['ba ria', 'vung tau', 'vũng tàu', 'bà rịa'],
    region: 'SOUTH',
    distanceFromHanoiKm: 1740,
  },
  {
    code: '40',
    canonicalName: 'Tỉnh Nghệ An',
    aliases: ['nghe an', 'nghệ an', 'vinh'],
    region: 'CENTRAL',
    distanceFromHanoiKm: 300,
  },
  {
    code: '38',
    canonicalName: 'Tỉnh Thanh Hóa',
    aliases: ['thanh hoa', 'thanh hóa'],
    region: 'CENTRAL',
    distanceFromHanoiKm: 160,
  },
];

/**
 * Inner-city GSO district codes for Hà Nội ('01') and TP. Hồ Chí Minh ('79').
 */
const HN_INNER_DISTRICTS = new Set([
  '001', // Ba Đình
  '002', // Hoàn Kiếm
  '003', // Tây Hồ
  '005', // Cầu Giấy
  '006', // Đống Đa
  '007', // Hai Bà Trưng
  '008', // Hoàng Mai
  '009', // Thanh Xuân
]);

const HCM_INNER_DISTRICTS = new Set([
  '760', // Quận 1
  '764', // Quận Gò Vấp
  '765', // Quận Bình Thạnh
  '766', // Quận Tân Bình
  '767', // Quận Tân Phú
  '768', // Quận Phú Nhuận
  '769', // TP Thủ Đức
  '770', // Quận 3
  '771', // Quận 10
  '772', // Quận 11
  '773', // Quận 4
  '774', // Quận 5
  '778', // Quận 7
]);

/**
 * Deterministic GSO district code -> GHN numeric `to_district_id` mapping for
 * live GHN v2 API requests.
 */
const GSO_TO_GHN_DISTRICT_ID: Record<string, number> = {
  '001': 1482, // Ba Đình, HN
  '002': 1484, // Hoàn Kiếm, HN
  '003': 1485, // Tây Hồ, HN
  '004': 1486, // Long Biên, HN
  '005': 1488, // Cầu Giấy, HN
  '006': 1489, // Đống Đa, HN
  '007': 1490, // Hai Bà Trưng, HN
  '008': 1491, // Hoàng Mai, HN
  '009': 1492, // Thanh Xuân, HN
  '019': 3440, // Nam Từ Liêm, HN
  '021': 1493, // Bắc Từ Liêm, HN
  '268': 1542, // Hà Đông, HN
  '760': 1442, // Quận 1, HCM
  '761': 1454, // Quận 12, HCM
  '764': 1461, // Gò Vấp, HCM
  '765': 1462, // Bình Thạnh, HCM
  '766': 1450, // Tân Bình, HCM
  '767': 1451, // Tân Phú, HCM
  '768': 1452, // Phú Nhuận, HCM
  '769': 3695, // TP Thủ Đức, HCM
  '770': 1444, // Quận 3, HCM
  '771': 1452, // Quận 10, HCM
  '772': 1453, // Quận 11, HCM
  '773': 1446, // Quận 4, HCM
  '774': 1447, // Quận 5, HCM
  '775': 1448, // Quận 6, HCM
  '776': 1449, // Quận 8, HCM
  '777': 1458, // Bình Tân, HCM
  '778': 1449, // Quận 7, HCM
  '490': 1526, // Liên Chiểu, ĐN
  '491': 1527, // Thanh Khê, ĐN
  '492': 1528, // Hải Châu, ĐN
  '493': 1529, // Sơn Trà, ĐN
  '494': 1530, // Ngũ Hành Sơn, ĐN
  '495': 1531, // Cẩm Lệ, ĐN
  '303': 1621, // Hồng Bàng, HP
  '304': 1622, // Ngô Quyền, HP
  '305': 1623, // Lê Chân, HP
  '916': 1572, // Ninh Kiều, Cần Thơ
};

const PROVINCE_DEFAULT_GHN_DISTRICT: Record<string, number> = {
  '01': 1482,
  '79': 1442,
  '48': 1528,
  '31': 1621,
  '92': 1572,
  '46': 1536,
  '56': 1566,
  '68': 1552,
  '22': 1630,
  '74': 1533,
  '75': 1534,
  '27': 1615,
  '49': 1538,
  '77': 1560,
  '40': 1640,
  '38': 1635,
};

function stripDiacritics(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

export function normalizeGsoCode(raw: string | undefined | null, padLength?: number): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (padLength && /^\d+$/.test(trimmed) && trimmed.length < padLength) {
    return trimmed.padStart(padLength, '0');
  }
  return trimmed;
}

export function resolveVnLocation(input: {
  provinceCode?: string;
  provinceName?: string;
  districtCode?: string;
  districtName?: string;
  wardCode?: string;
  wardName?: string;
}): ResolvedVnLocation {
  const normProvinceCode = normalizeGsoCode(input.provinceCode, 2);
  const normDistrictCode = normalizeGsoCode(input.districtCode, 3);
  const normWardCode = normalizeGsoCode(input.wardCode, 5);
  const rawProvinceName = input.provinceName?.trim() ?? '';
  const normProvinceText = stripDiacritics(rawProvinceName);

  let meta: ProvinceMeta | undefined;
  if (normProvinceCode) {
    meta = VN_PROVINCE_META.find((p) => p.code === normProvinceCode);
  }
  if (!meta && normProvinceText) {
    meta = VN_PROVINCE_META.find((p) => {
      const canonical = stripDiacritics(p.canonicalName);
      return (
        normProvinceText.includes(canonical) ||
        canonical.includes(normProvinceText) ||
        p.aliases.some((alias) => normProvinceText.includes(stripDiacritics(alias)))
      );
    });
  }

  const provinceCode = meta?.code ?? normProvinceCode ?? null;
  const provinceName = rawProvinceName || meta?.canonicalName || 'Thành phố Hà Nội';
  const districtName = input.districtName?.trim() || 'Quận Hoàn Kiếm';
  const wardName = input.wardName?.trim() || 'Phường Hàng Trống';

  let region: 'NORTH' | 'CENTRAL' | 'SOUTH' = meta?.region ?? 'NORTH';
  if (!meta && provinceCode && /^\d+$/.test(provinceCode)) {
    const codeNum = Number.parseInt(provinceCode, 10);
    if (codeNum <= 37) {
      region = 'NORTH';
    } else if (codeNum <= 68) {
      region = 'CENTRAL';
    } else {
      region = 'SOUTH';
    }
  }

  const isHanoi = provinceCode === '01' || normProvinceText.includes('ha noi');
  const isHcm =
    provinceCode === '79' ||
    normProvinceText.includes('ho chi minh') ||
    normProvinceText.includes('hcm') ||
    normProvinceText.includes('sai gon');

  const zone: ShippingZoneType = isHanoi
    ? 'INTRA_CITY'
    : region === 'NORTH'
      ? 'INTRA_REGION'
      : 'INTER_REGION';

  const normDistrictText = stripDiacritics(districtName);
  const isInnerDistrict =
    (isHanoi &&
      ((normDistrictCode !== null && HN_INNER_DISTRICTS.has(normDistrictCode)) ||
        /ba dinh|hoan kiem|dong da|hai ba trung|cau giay|tay ho|thanh xuan|hoang mai/.test(
          normDistrictText,
        ))) ||
    (isHcm &&
      ((normDistrictCode !== null && HCM_INNER_DISTRICTS.has(normDistrictCode)) ||
        /quan 1\b|quan 3\b|quan 4\b|quan 5\b|quan 7\b|quan 10\b|binh thanh|phu nhuan|tan binh|go vap|thu duc/.test(
          normDistrictText,
        )));

  const estimatedDistanceKm =
    meta?.distanceFromHanoiKm ?? (region === 'NORTH' ? 140 : region === 'CENTRAL' ? 780 : 1700);

  return {
    provinceCode,
    provinceName,
    districtCode: normDistrictCode,
    districtName,
    wardCode: normWardCode,
    wardName,
    region,
    zone,
    isHanoi,
    isHcm,
    isAhaMoveEligible: isHanoi || isHcm,
    isInnerDistrict,
    estimatedDistanceKm,
  };
}

export function resolveGhnDistrictId(location: ResolvedVnLocation): number {
  if (location.districtCode && GSO_TO_GHN_DISTRICT_ID[location.districtCode]) {
    return GSO_TO_GHN_DISTRICT_ID[location.districtCode];
  }
  if (location.provinceCode && PROVINCE_DEFAULT_GHN_DISTRICT[location.provinceCode]) {
    return PROVINCE_DEFAULT_GHN_DISTRICT[location.provinceCode];
  }
  return 1482;
}

export function addHoursIso(hours: number, fromMs: number = Date.now()): string {
  return new Date(fromMs + Math.max(1, hours) * 3_600_000).toISOString();
}

export interface HttpRetryResult {
  ok: boolean;
  status: number;
  json: Record<string, unknown> | null;
  rawText: string;
  attempts: number;
}

/**
 * Executes an external carrier HTTP request with AbortController timeout
 * (default 8000ms) and 1 controlled retry on HTTP 5xx or transient network error.
 */
export async function fetchCarrierJsonWithRetry(
  url: string,
  init: RequestInit,
  options: { timeoutMs?: number; maxRetries?: number; retryDelayMs?: number } = {},
): Promise<HttpRetryResult> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const maxRetries = options.maxRetries ?? 1;
  const retryDelayMs = options.retryDelayMs ?? 350;

  let attempts = 0;
  let lastError: unknown;

  while (attempts <= maxRetries) {
    attempts += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      const rawText = await response.text();
      let json: Record<string, unknown> | null = null;
      if (rawText.trim().length > 0) {
        try {
          const parsed = JSON.parse(rawText) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            json = parsed as Record<string, unknown>;
          }
        } catch {
          json = null;
        }
      }

      if (response.status >= 500 && attempts <= maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempts));
        continue;
      }

      return {
        ok: response.ok,
        status: response.status,
        json,
        rawText,
        attempts,
      };
    } catch (error: unknown) {
      lastError = error;
      if (attempts <= maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempts));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error('Carrier HTTP request exhausted retries');
}

/**
 * Validates provider webhook signature (`x-*-signature` HMAC-SHA256 hex or direct token)
 * or `x-webhook-token` using constant-time comparison (`crypto.timingSafeEqual`).
 */
export function verifyCarrierWebhookSignature(
  headers: HeaderBag,
  rawBody: string | Buffer,
  signatureHeaderNames: readonly string[],
  secret: string,
): boolean {
  if (!secret || secret.trim().length === 0) {
    return false;
  }

  const webhookToken = extractHeader(headers, 'x-webhook-token');
  if (webhookToken && timingSafeSecretEqual(webhookToken, secret)) {
    return true;
  }

  const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const expectedHmacHex = crypto.createHmac('sha256', secret).update(bodyBuf).digest('hex');

  for (const headerName of signatureHeaderNames) {
    const providedRaw = extractHeader(headers, headerName);
    if (!providedRaw) {
      continue;
    }

    const stripped = providedRaw.replace(/^sha256=/i, '').trim();
    const normalizedHex = stripped.toLowerCase();

    if (
      /^[0-9a-f]{64}$/.test(normalizedHex) &&
      timingSafeSecretEqual(normalizedHex, expectedHmacHex)
    ) {
      return true;
    }

    if (timingSafeSecretEqual(providedRaw, secret)) {
      return true;
    }
  }

  return false;
}

export function buildDeterministicEventId(
  provider: string,
  parts: Array<string | number | null | undefined>,
): string {
  const joined = parts
    .map((p) => (p === null || p === undefined ? '' : String(p).trim()))
    .filter(Boolean)
    .join(':');
  if (joined.length > 0 && joined.length <= 120) {
    return `${provider}:${joined}`;
  }
  const digest = crypto.createHash('sha256').update(`${provider}:${joined}`).digest('hex').slice(0, 24);
  return `${provider}:${digest}`;
}
