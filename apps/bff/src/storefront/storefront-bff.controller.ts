import { createHash } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { redactRestrictedFields } from '@atelier/ai-harness';
import {
  createApiErrorResponse,
  createApiResponse,
  ErrorCode,
  Role,
  SeasonAiRestyleRequestSchema,
  type HomepageCampaignDto,
  type JwtAccessPayload,
  type SeasonAiRestyleResponse,
  type StorefrontBootstrapDto,
  type StorefrontOccasionSummary,
  type StorefrontSeasonSummary,
} from '@atelier/contracts';
import { getOrCreateCorrelationId, type HeaderBag } from '@atelier/observability';
import type { Request, Response } from 'express';
import {
  CacheInvalidationService,
  STOREFRONT_BOOTSTRAP_CACHE_KEY,
  STOREFRONT_CATEGORIES_CACHE_KEY,
  STOREFRONT_OCCASIONS_CACHE_KEY,
  STOREFRONT_RACK_CACHE_KEY,
  STOREFRONT_SEASONS_CACHE_KEY,
} from '../common/cache-invalidation.service';
import { HttpProxyService } from '../common/http-proxy.service';
import { BffRedisService } from '../common/redis.service';
import {
  buildCanonicalQueryString,
  stripStorefrontSensitiveFields,
} from '../common/sanitize';
import { BFF_CONFIG_TOKEN, type BffConfig } from '../config/env';
import { CurrentUser, type AuthenticatedRequest } from '../security/auth-types';
import { JwtAuthGuard } from '../security/guards';
import { JwtVerifierService } from '../security/jwt-verifier.service';

export { STOREFRONT_BOOTSTRAP_CACHE_KEY };

const BOOTSTRAP_TTL_SECONDS = 300;
const RACK_TTL_SECONDS = 120;
const OCCASIONS_TTL_SECONDS = 300;
const SEASONS_TTL_SECONDS = 300;
const PRODUCTS_TTL_SECONDS = 60;
const SEASON_RESTYLE_TTL_SECONDS = 604_800; // 7 days
const SAFE_SEASON_SLUG_RE = /^[a-z0-9-]+$/i;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STOREFRONT_CHAT_RATE_LIMIT = 20;
const STOREFRONT_CHAT_GUEST_IP_RATE_LIMIT = 30;
const STOREFRONT_CHAT_RATE_WINDOW_SECONDS = 60;

const STOREFRONT_CHAT_EXTRA_SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'costpricevnd',
  'cost_price_vnd',
  'costprice',
  'cost_price',
  'unitcostvnd',
  'unit_cost_vnd',
  'totalcostvnd',
  'total_cost_vnd',
  'estimatedcostvnd',
  'estimated_cost_vnd',
  'landedcostvnd',
  'landed_cost_vnd',
  'wholesalecostvnd',
  'wholesale_cost_vnd',
  'wholesalepricevnd',
  'wholesale_price_vnd',
  'gianhap',
  'gia_nhap',
  'cogs',
  'suppliercost',
  'supplier_cost',
  'suppliercode',
  'supplier_code',
  'suppliername',
  'supplier_name',
  'supplieremail',
  'supplier_email',
  'purchaseorder',
  'purchase_order',
  'purchaseorders',
  'purchase_orders',
  'pocode',
  'po_code',
  'ponumber',
  'po_number',
  'poid',
  'po_id',
  'draftpo',
  'draft_po',
  'grncode',
  'grn_code',
  'grnid',
  'grn_id',
  'payables',
  'payableid',
  'payable_id',
  'supplierpayable',
  'supplier_payable',
  'supplierbatchcode',
  'supplier_batch_code',
  'marginpct',
  'margin_pct',
  'profitmargin',
  'profit_margin',
  'internalsecret',
  'internal_secret',
  'supplierid',
  'supplier_id',
]);

const STOREFRONT_BLOCKED_ACTION_CARD_TYPES: ReadonlySet<string> = new Set([
  'PO_DRAFT_CREATED',
  'CLEARANCE_DRAFT_CREATED',
  'GARMENT_IMAGE_PROCESSED',
]);

function stripExtraChatInternalFields(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): unknown {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => stripExtraChatInternalFields(item, seen));
    }
    const record = value as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (STOREFRONT_CHAT_EXTRA_SENSITIVE_KEYS.has(key.toLowerCase())) {
        continue;
      }
      if (key === 'actionCards' && Array.isArray(entry)) {
        cleaned[key] = entry
          .filter((card) => {
            if (!card || typeof card !== 'object' || Array.isArray(card)) {
              return false;
            }
            const cardType = String((card as Record<string, unknown>).type ?? '').toUpperCase();
            return !STOREFRONT_BLOCKED_ACTION_CARD_TYPES.has(cardType);
          })
          .map((card) => stripExtraChatInternalFields(card, seen));
        continue;
      }
      cleaned[key] = stripExtraChatInternalFields(entry, seen);
    }
    return cleaned;
  } finally {
    seen.delete(value);
  }
}

function sanitizeStorefrontChatPayload<T>(payload: T): T {
  const step1 = stripStorefrontSensitiveFields(payload);
  const step2 = redactRestrictedFields(step1, [Role.CUSTOMER]);
  return stripExtraChatInternalFields(step2) as T;
}

type SentimentLabelValue = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';

export interface ReviewSentimentSummary {
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
  positivePct: number;
  neutralPct: number;
  negativePct: number;
  averageSentimentScore: number;
  totalScored: number;
}

function deriveSentimentLabel(rawLabel: unknown, rawScore: unknown): SentimentLabelValue {
  if (typeof rawLabel === 'string') {
    const upper = rawLabel.trim().toUpperCase();
    if (upper === 'POSITIVE' || upper === 'NEUTRAL' || upper === 'NEGATIVE') {
      return upper;
    }
  }
  const score = Number(rawScore);
  if (Number.isFinite(score)) {
    if (score >= 0.2) return 'POSITIVE';
    if (score <= -0.2) return 'NEGATIVE';
  }
  return 'NEUTRAL';
}

function normalizeReviewsWithSentiment(
  rawReviews: unknown[],
): {
  reviews: unknown[];
  computedSummary: ReviewSentimentSummary;
} {
  let positiveCount = 0;
  let neutralCount = 0;
  let negativeCount = 0;
  let scoreSum = 0;
  let totalScored = 0;

  const reviews = rawReviews.map((entry) => {
    const rec = asRecord(entry);
    if (!rec) return entry;

    const rawScore = rec.sentimentScore ?? rec.diemCamXucNlp;
    const numericScore =
      rawScore !== null && rawScore !== undefined && Number.isFinite(Number(rawScore))
        ? Number(rawScore)
        : null;
    const sentimentLabel = deriveSentimentLabel(rec.sentimentLabel, numericScore);

    if (sentimentLabel === 'POSITIVE') positiveCount += 1;
    else if (sentimentLabel === 'NEGATIVE') negativeCount += 1;
    else neutralCount += 1;

    if (numericScore !== null) {
      scoreSum += numericScore;
      totalScored += 1;
    }

    return {
      ...rec,
      sentimentScore: numericScore,
      diemCamXucNlp: numericScore,
      sentimentLabel,
    };
  });

  const total = reviews.length;
  const positivePct = total > 0 ? Math.round((positiveCount / total) * 100) : 0;
  const negativePct = total > 0 ? Math.round((negativeCount / total) * 100) : 0;
  const neutralPct = total > 0 ? Math.max(0, 100 - positivePct - negativePct) : 0;
  const averageSentimentScore =
    totalScored > 0 ? Math.round((scoreSum / totalScored) * 1000) / 1000 : 0;

  return {
    reviews,
    computedSummary: {
      positiveCount,
      neutralCount,
      negativeCount,
      positivePct,
      neutralPct,
      negativePct,
      averageSentimentScore,
      totalScored,
    },
  };
}

function enrichReviewEnvelopeWithSentiment(payload: unknown): unknown {
  const sanitized = stripStorefrontSensitiveFields(payload);
  const root = asRecord(sanitized);
  if (!root) return sanitized;

  const dataRec = asRecord(root.data);
  const target = dataRec ?? root;
  if (!Array.isArray(target.reviews)) {
    return sanitized;
  }

  const { reviews, computedSummary } = normalizeReviewsWithSentiment(target.reviews);
  const existingSummary = asRecord(target.sentimentSummary);
  const sentimentSummary = existingSummary
    ? {
        ...computedSummary,
        ...existingSummary,
      }
    : computedSummary;

  if (dataRec) {
    return {
      ...root,
      data: {
        ...dataRec,
        reviews,
        sentimentSummary,
      },
    };
  }

  return {
    ...root,
    reviews,
    sentimentSummary,
  };
}

const HERO_EYEBROW_CANONICAL =
  'FASHION ATELIER · EST. 2019 · MAY ĐO THỦ CÔNG TẠI HÀ NỘI';
const DEFAULT_HERO_POSTER_URL = `${(process.env.MINIO_PUBLIC_URL || 'http://127.0.0.1:9000').replace(/\/$/, '')}/atelier-public/seed/atelier-hero-poster.webp`;

function sanitizeHeroVideoUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('/media/atelier-')
  ) {
    return trimmed;
  }
  return null;
}

const FALLBACK_HOMEPAGE_CAMPAIGN: HomepageCampaignDto = {
  id: 'fallback-homepage-campaign',
  code: 'ATELIER_AW2026_SILK',
  slug: 'tam-xuan-aw2026',
  eyebrow: HERO_EYEBROW_CANONICAL,
  title: 'Tầm Xuân',
  subtitle:
    'Thiết kế may đo thủ công trên lụa tơ tằm và linen hữu cơ — ướm thử dáng thật bằng AI trước khi đặt may.',
  heroTitle: 'Tầm Xuân',
  heroSubtitle:
    'Thiết kế may đo thủ công trên lụa tơ tằm và linen hữu cơ — ướm thử dáng thật bằng AI trước khi đặt may.',
  atelierManifesto:
    'Mỗi thiết kế tại xưởng Tầm Xuân được dựng rập 3D, cắt tay từ vải tự nhiên và hoàn thiện từng mũi khâu thủ công.',
  privacyGuaranteeMinutes: 15,
  heroImageUrl: DEFAULT_HERO_POSTER_URL,
  heroVideoUrl: null,
  heroPosterUrl: DEFAULT_HERO_POSTER_URL,
  ctaLabel: 'Khám phá bộ sưu tập',
  serviceNote: 'May đo theo số đo · Đổi size 7–14 ngày · Xóa ảnh AI sau 15 phút',
  isActive: true,
  updatedAt: '2026-01-01T00:00:00.000Z',
  intro: {
    monogramLeft: 'T',
    monogramAmp: '&',
    monogramRight: 'X',
    tagline: 'May đo thủ công · Hà Nội',
    brandName: 'Tầm Xuân',
    brandSub: 'Fashion Atelier',
  },
  hero: {
    eyebrow: HERO_EYEBROW_CANONICAL,
    title: 'Tầm Xuân',
    lead: 'Thiết kế may đo thủ công trên lụa tơ tằm và linen hữu cơ — ướm thử dáng thật bằng AI trước khi đặt may.',
    primaryCtaLabel: 'Khám phá bộ sưu tập',
    serviceNote: 'May đo theo số đo · Đổi size 7–14 ngày · Xóa ảnh AI sau 15 phút',
    posterUrl: DEFAULT_HERO_POSTER_URL,
    videoWebmUrl: null,
    videoMp4Url: null,
  },
  atelierSteps: [
    {
      stepOrder: 1,
      timeTarget: '08:00',
      title: 'Tuyển chọn lụa & linen',
      description:
        'Kiểm định từng cuộn lụa tơ tằm Bảo Lộc 19 momme và linen hữu cơ theo độ rủ, mật độ sợi và ánh màu tự nhiên.',
      imageUrl: 'http://127.0.0.1:9000/atelier-public/seed/atelier-step-1.webp',
      imageAlt: 'Tuyển chọn lụa tơ tằm và linen tại xưởng Tầm Xuân',
    },
    {
      stepOrder: 2,
      timeTarget: '11:00',
      title: 'Dựng rập & cắt thủ công',
      description:
        'Nghệ nhân dựng rập tỉ lệ chuẩn dáng Việt, căn chính xác đường canh sợi và cắt từng mảnh vải thủ công.',
      imageUrl: 'http://127.0.0.1:9000/atelier-public/seed/atelier-step-2.webp',
      imageAlt: 'Dựng rập và cắt vải thủ công tại xưởng may đo',
    },
    {
      stepOrder: 3,
      timeTarget: '14:30',
      title: 'Khâu tay chi tiết',
      description:
        'Hoàn thiện ve áo, khuyết tay và đường viền lót bằng chỉ lụa mịn để trang phục mềm mại khi cử động.',
      imageUrl: 'http://127.0.0.1:9000/atelier-public/seed/atelier-step-3.webp',
      imageAlt: 'Khâu tay chi tiết thủ công trên nền lụa',
    },
    {
      stepOrder: 4,
      timeTarget: '17:00',
      title: 'Là hơi, kiểm chuẩn & đóng hộp',
      description:
        'Là hơi tạo phom, kiểm chuẩn 12 điểm đường may, đóng hộp signature và gửi ảnh hoàn thiện trước khi giao.',
      imageUrl: 'http://127.0.0.1:9000/atelier-public/seed/atelier-step-4.webp',
      imageAlt: 'Là hơi kiểm chuẩn và đóng hộp quà cao cấp',
    },
  ],
  finale: {
    eyebrow: 'Đặt may & Phòng thử AI',
    leadMain: 'Ghé xưởng hoặc ướm thử trực tuyến —',
    leadEmphasis: 'mỗi đường kim đều chuẩn theo dáng bạn.',
    ctaLabel: 'Khám phá bộ sưu tập',
    showroomInfo: 'Phố Phan Đình Phùng, Ba Đình · Mở cửa 9:00 – 21:00 mỗi ngày',
    wordmark: 'Tầm Xuân',
    featuredVoices: [
      {
        quote:
          'Blazer linen đứng vai rất nhẹ, tôi ướm thử AI trước rồi chọn đúng size S — nhận hàng mặc vừa khít không cần sửa.',
        author: 'Chị Minh Anh · Ba Đình',
        fitMeta: '163cm · 52kg · Mặc Size S (Vừa vai)',
      },
      {
        quote:
          'Sơ mi lụa mát và ít nhăn hơn hẳn hàng công nghiệp, đổi size rất nhanh nhưng lần này tư vấn bảng đo chuẩn ngay từ đầu.',
        author: 'Anh Quang Đức · Tây Hồ',
        fitMeta: '176cm · 70kg · Mặc Size L (Thoải mái)',
      },
      {
        quote:
          'Đầm lụa dự tiệc có độ rủ đẹp và đóng hộp chỉnh chu như quà tặng, yên tâm nhất là ảnh thử đồ tự xóa sau 15 phút.',
        author: 'Chị Thu Hà · Hoàn Kiếm',
        fitMeta: '167cm · 56kg · Mặc Size M (Chuẩn eo)',
      },
    ],
  },
};

const FALLBACK_OCCASIONS: StorefrontOccasionSummary[] = [
  {
    key: 'office',
    slug: 'cong-so-hien-dai',
    name: 'Công sở thanh lịch',
    tagline: 'Đường cắt chuẩn mực, lụa và len nhẹ cho nhịp sống thành thị.',
    themeBg: '#F4EBDA',
    themeInk: '#2B2019',
    themeAccent: '#8A672C',
    isDark: false,
    itemCount: 4,
  },
  {
    key: 'evening',
    slug: 'du-tiec-toi',
    name: 'Tiệc tối & Sự kiện',
    tagline: 'Sắc cacao trầm ấm điểm ánh kim, rủ mềm theo từng bước di chuyển.',
    themeBg: '#1C1410',
    themeInk: '#FBF7EF',
    themeAccent: '#EBCF8F',
    isDark: true,
    itemCount: 4,
  },
  {
    key: 'weekend',
    slug: 'dao-pho-cuoi-tuan',
    name: 'Dạo phố cuối tuần',
    tagline: 'Phom dáng thư thái, chất liệu thoáng nhẹ cho những buổi hẹn gần.',
    themeBg: '#ECEEEB',
    themeInk: '#24302C',
    themeAccent: '#5C736B',
    isDark: false,
    itemCount: 4,
  },
  {
    key: 'resort',
    slug: 'du-lich-resort',
    name: 'Du lịch & Resort',
    tagline: 'Linen nguyên bản và sắc cát ngà ôm trọn ánh nắng biển.',
    themeBg: '#F7EFE3',
    themeInk: '#4A3525',
    themeAccent: '#B57D4C',
    isDark: false,
    itemCount: 4,
  },
  {
    key: 'ceremony',
    slug: 'cuoi-ao-dai',
    name: 'Cưới & Áo dài',
    tagline: 'Trắng ngọc và lụa Bảo Lộc thêu tay cho khoảnh khắc trọn vẹn.',
    themeBg: '#FAF6F0',
    themeInk: '#3A2622',
    themeAccent: '#B08A4A',
    isDark: false,
    itemCount: 4,
  },
  {
    key: 'minimal',
    slug: 'trien-lam-nghe-thuat',
    name: 'Tối giản & Quà tặng',
    tagline: 'Tông hồng phấn đất tinh tế kèm hộp quà signature và thiệp viết tay.',
    themeBg: '#F5ECE9',
    themeInk: '#3F2B28',
    themeAccent: '#A36B63',
    isDark: false,
    itemCount: 4,
  },
];

const FALLBACK_SEASONS: StorefrontSeasonSummary[] = [
  {
    slug: 'xuan-tam-xuan',
    months: 'T1–T2',
    name: 'Xuân Lụa Bảo Lộc',
    shortName: 'Xuân Lụa',
    materialHeadline: 'Lụa Tơ Tằm Bảo Lộc 22 Momme',
    note: 'Lụa Tơ Tằm Bảo Lộc 22 Momme — ánh ngà ấm và phom dáng mềm rủ cho tiết xuân Hà Nội.',
    isCurrent: true,
    isCurrentSeason: true,
  },
  {
    slug: 'ha-pho-co',
    months: 'T3–T4',
    name: 'Hạ Linen Hữu Cơ',
    shortName: 'Hạ Linen',
    materialHeadline: '100% Organic French Linen Thoáng Khí',
    note: '100% Organic French Linen Thoáng Khí — đường cắt khoáng đạt và thoáng nhẹ dưới nắng hạ.',
    isCurrent: false,
    isCurrentSeason: false,
  },
  {
    slug: 'resort-ban-mai',
    months: 'T5–T6',
    name: 'Resort Biển & Lụa Bay',
    shortName: 'Resort Biển',
    materialHeadline: 'Lụa Organza & Tơ Sống Dệt Nhẹ',
    note: 'Lụa Organza & Tơ Sống Dệt Nhẹ — thiết kế nghỉ dưỡng bay bổng đón gió biển ban mai.',
    isCurrent: false,
    isCurrentSeason: false,
  },
  {
    slug: 'thu-hoang-hon',
    months: 'T7–T8',
    name: 'Thu Công Sở Thanh Lịch',
    shortName: 'Thu Công Sở',
    materialHeadline: 'Wool Silk Blend & Crepe Đứng Phom',
    note: 'Wool Silk Blend & Crepe Đứng Phom — blazer dựng vai chuẩn mực và quần âu xếp ly thanh lịch.',
    isCurrent: false,
    isCurrentSeason: false,
  },
  {
    slug: 'dong-cashmere',
    months: 'T9–T10',
    name: 'Dạ Tweed & Cashmere',
    shortName: 'Dạ Tweed',
    materialHeadline: 'Len Cashmere Mông Cổ & Dạ Tweed Dệt Nổi',
    note: 'Len Cashmere Mông Cổ & Dạ Tweed Dệt Nổi — cấu trúc dệt thủ công ấm áp đầy khí chất.',
    isCurrent: false,
    isCurrentSeason: false,
  },
  {
    slug: 'atelier-di-san',
    months: 'T11–T12',
    name: 'Dạ Tiệc Cuối Năm',
    shortName: 'Dạ Tiệc',
    materialHeadline: 'Lụa Satin Ánh Ngọc & Nhung Couture',
    note: 'Lụa Satin Ánh Ngọc & Nhung Couture — đầm cắt thiên bias-cut tôn vinh kỹ nghệ dạ tiệc cuối năm.',
    isCurrent: false,
    isCurrentSeason: false,
  },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unwrapDataPayload(body: unknown): Record<string, unknown> | null {
  const rec = asRecord(body);
  if (!rec) {
    return null;
  }
  const inner = asRecord(rec.data);
  return inner ?? rec;
}

function mergeHomepageCampaign(
  rawCampaign: Record<string, unknown> | null,
): HomepageCampaignDto {
  if (!rawCampaign) {
    return FALLBACK_HOMEPAGE_CAMPAIGN;
  }

  const rawIntro = asRecord(rawCampaign.intro);
  const rawHero = asRecord(rawCampaign.hero);
  const rawFinale = asRecord(rawCampaign.finale);
  const rawSteps = Array.isArray(rawCampaign.atelierSteps)
    ? rawCampaign.atelierSteps
    : null;

  const mergedIntro = {
    ...FALLBACK_HOMEPAGE_CAMPAIGN.intro!,
    ...(rawIntro ?? {}),
  };
  const mergedHero = {
    ...FALLBACK_HOMEPAGE_CAMPAIGN.hero!,
    ...(rawHero ?? {}),
    videoWebmUrl: sanitizeHeroVideoUrl(rawHero?.videoWebmUrl),
    videoMp4Url: sanitizeHeroVideoUrl(rawHero?.videoMp4Url),
  };
  const mergedFinale = {
    ...FALLBACK_HOMEPAGE_CAMPAIGN.finale!,
    ...(rawFinale ?? {}),
    featuredVoices:
      rawFinale && Array.isArray(rawFinale.featuredVoices)
        ? rawFinale.featuredVoices
        : FALLBACK_HOMEPAGE_CAMPAIGN.finale!.featuredVoices,
  };
  const mergedSteps =
    rawSteps && rawSteps.length > 0
      ? rawSteps
      : FALLBACK_HOMEPAGE_CAMPAIGN.atelierSteps!;

  return {
    ...FALLBACK_HOMEPAGE_CAMPAIGN,
    ...(rawCampaign as Partial<HomepageCampaignDto>),
    id: String(rawCampaign.id ?? FALLBACK_HOMEPAGE_CAMPAIGN.id),
    code: String(rawCampaign.code ?? rawCampaign.slug ?? FALLBACK_HOMEPAGE_CAMPAIGN.code),
    eyebrow: String(rawCampaign.eyebrow ?? mergedHero.eyebrow),
    title: String(rawCampaign.title ?? rawCampaign.heroTitle ?? mergedHero.title),
    subtitle: String(rawCampaign.subtitle ?? rawCampaign.heroSubtitle ?? mergedHero.lead),
    ctaLabel: String(rawCampaign.ctaLabel ?? mergedHero.primaryCtaLabel),
    serviceNote: String(rawCampaign.serviceNote ?? mergedHero.serviceNote),
    heroPosterUrl:
      typeof rawCampaign.heroPosterUrl === 'string'
        ? rawCampaign.heroPosterUrl
        : mergedHero.posterUrl,
    heroVideoUrl: sanitizeHeroVideoUrl(rawCampaign.heroVideoUrl ?? mergedHero.videoWebmUrl),
    isActive: typeof rawCampaign.isActive === 'boolean' ? rawCampaign.isActive : true,
    updatedAt: String(rawCampaign.updatedAt ?? new Date().toISOString()),
    intro: mergedIntro as HomepageCampaignDto['intro'],
    hero: mergedHero as HomepageCampaignDto['hero'],
    atelierSteps: mergedSteps as HomepageCampaignDto['atelierSteps'],
    finale: mergedFinale as HomepageCampaignDto['finale'],
  };
}

@Injectable()
export class StorefrontBffService {
  private readonly chatRateWindows = new Map<string, number[]>();

  constructor(
    @Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig,
    @Inject(BffRedisService) private readonly redis: BffRedisService,
    @Inject(HttpProxyService) private readonly proxy: HttpProxyService,
    @Inject(CacheInvalidationService)
    private readonly cacheInvalidation: CacheInvalidationService,
    @Inject(JwtVerifierService) private readonly jwtVerifier: JwtVerifierService,
  ) {}

  async handleBootstrap(req: Request, res: Response): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);

    // Fast path: serve pre-serialized JSON envelope straight from Redis (< 5ms, p95 << 80ms)
    const cachedEnvelopeJson = await this.redis.getSafe(STOREFRONT_BOOTSTRAP_CACHE_KEY);
    if (cachedEnvelopeJson) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Cache-Key', STOREFRONT_BOOTSTRAP_CACHE_KEY);
      res.status(200).type('application/json').send(cachedEnvelopeJson);
      return;
    }

    const [catalogRes, authHealth, catalogHealth, mediaHealth, notifyHealth, tryOnHealth] =
      await Promise.allSettled([
        this.proxy.request({
          method: 'GET',
          url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/bootstrap`,
          correlationId,
          timeoutMs: 4000,
        }),
        this.proxy.request({
          method: 'GET',
          url: `${this.config.upstreams.authCustomerUrl}/health`,
          correlationId,
          timeoutMs: 1500,
        }),
        this.proxy.request({
          method: 'GET',
          url: `${this.config.upstreams.catalogLookbookUrl}/health`,
          correlationId,
          timeoutMs: 1500,
        }),
        this.proxy.request({
          method: 'GET',
          url: `${this.config.upstreams.mediaPipelineUrl}/health`,
          correlationId,
          timeoutMs: 1500,
        }),
        this.proxy.request({
          method: 'GET',
          url: `${this.config.notifyReviewServiceUrl}/health`,
          correlationId,
          timeoutMs: 1500,
        }),
        this.proxy.request({
          method: 'GET',
          url: `${this.config.upstreams.aiTryOnUrl}/health`,
          correlationId,
          timeoutMs: 1500,
        }),
      ]);

    const catalogOk = catalogRes.status === 'fulfilled' && catalogRes.value.ok;
    const catalogData = catalogOk ? unwrapDataPayload(catalogRes.value.body) : null;

    const servicesStatus: Record<string, 'ok' | 'degraded' | 'down'> = {
      bff: 'ok',
      authCustomer:
        authHealth.status === 'fulfilled' && authHealth.value.ok ? 'ok' : 'degraded',
      catalogLookbook:
        catalogHealth.status === 'fulfilled' && catalogHealth.value.ok ? 'ok' : 'degraded',
      mediaPipeline:
        mediaHealth.status === 'fulfilled' && mediaHealth.value.ok ? 'ok' : 'degraded',
      notifyReview:
        notifyHealth.status === 'fulfilled' && notifyHealth.value.ok ? 'ok' : 'degraded',
      aiTryOn:
        tryOnHealth.status === 'fulfilled' && tryOnHealth.value.ok ? 'ok' : 'degraded',
    };

    const rawFeatured = Array.isArray(catalogData?.featuredProducts)
      ? catalogData.featuredProducts
      : [];
    const rawCategories = Array.isArray(catalogData?.categories)
      ? catalogData.categories
      : [];
    const rawOccasions =
      Array.isArray(catalogData?.occasionLookbooks) &&
      catalogData.occasionLookbooks.length > 0
        ? catalogData.occasionLookbooks
        : Array.isArray(catalogData?.occasions)
          ? catalogData.occasions
          : [];
    const rawSeasons = Array.isArray(catalogData?.seasons)
      ? catalogData.seasons
      : Array.isArray(catalogData?.seasonalCollections)
        ? catalogData.seasonalCollections
        : [];
    const rawPackaging = Array.isArray(catalogData?.packagingOptions)
      ? catalogData.packagingOptions
      : [];
    const rawCampaign = asRecord(catalogData?.homepageCampaign ?? catalogData?.campaign);
    const mergedCampaign = mergeHomepageCampaign(rawCampaign);

    const mappedOccasions: StorefrontOccasionSummary[] =
      rawOccasions.length > 0
        ? rawOccasions.map((item, idx) => {
            const o = asRecord(item) ?? {};
            const fallback = FALLBACK_OCCASIONS[idx % FALLBACK_OCCASIONS.length];
            const productSlugs = Array.isArray(o.productSlugs) ? o.productSlugs : [];
            const itemsArr = Array.isArray(o.items) ? o.items : [];
            return {
              key: String(o.key ?? o.slug ?? fallback.key),
              slug: String(o.slug ?? fallback.slug ?? fallback.key),
              name: String(o.name ?? o.title ?? fallback.name),
              tagline: String(o.tagline ?? o.subtitle ?? fallback.tagline),
              themeBg: String(o.themeBg ?? o.paletteBg ?? fallback.themeBg),
              themeInk: String(o.themeInk ?? o.paletteInk ?? fallback.themeInk),
              themeAccent: String(o.themeAccent ?? o.paletteAccent ?? fallback.themeAccent),
              isDark: Boolean(o.isDark ?? fallback.isDark),
              itemCount:
                typeof o.itemCount === 'number'
                  ? o.itemCount
                  : Math.max(productSlugs.length, itemsArr.length, fallback.itemCount),
            };
          })
        : FALLBACK_OCCASIONS;

    const mappedSeasons: StorefrontSeasonSummary[] =
      rawSeasons.length > 0
        ? rawSeasons.map((item, idx) => {
            const s = asRecord(item) ?? {};
            const fallback = FALLBACK_SEASONS[idx % FALLBACK_SEASONS.length];
            const isCurrent = Boolean(
              s.isCurrent ?? s.isCurrentSeason ?? s.isNow ?? fallback.isCurrent,
            );
            return {
              slug: String(s.slug ?? fallback.slug),
              months: String(s.months ?? s.seasonTag ?? fallback.months),
              name: String(s.name ?? s.title ?? fallback.name),
              shortName:
                typeof s.shortName === 'string' && s.shortName.trim()
                  ? s.shortName
                  : fallback.shortName,
              materialHeadline:
                typeof s.materialHeadline === 'string' && s.materialHeadline.trim()
                  ? s.materialHeadline
                  : fallback.materialHeadline,
              note: String(s.note ?? s.subtitle ?? fallback.note),
              isCurrent,
              isCurrentSeason: isCurrent,
              coverAssetUrl:
                typeof s.coverAssetUrl === 'string'
                  ? s.coverAssetUrl
                  : typeof s.heroImageUrl === 'string'
                    ? s.heroImageUrl
                    : null,
              productCount:
                typeof s.productCount === 'number'
                  ? s.productCount
                  : Array.isArray(s.productSlugs)
                    ? s.productSlugs.length
                    : undefined,
              interactiveLookbook:
                (s.interactiveLookbook as StorefrontSeasonSummary['interactiveLookbook']) ??
                null,
              heroProducts: Array.isArray(s.heroProducts)
                ? (s.heroProducts as StorefrontSeasonSummary['heroProducts'])
                : undefined,
            };
          })
        : FALLBACK_SEASONS;

    const hero = mergedCampaign.hero ?? FALLBACK_HOMEPAGE_CAMPAIGN.hero!;

    const payload: StorefrontBootstrapDto = stripStorefrontSensitiveFields({
      brand: mergedCampaign.intro?.brandName
        ? `${mergedCampaign.intro.brandName} · ${mergedCampaign.intro.brandSub}`
        : 'Tầm Xuân · Fashion Atelier',
      platformVersion: '3.0.0',
      campaign: {
        code: mergedCampaign.code,
        title: hero.title || mergedCampaign.title,
        subtitle: hero.lead || mergedCampaign.subtitle,
        eyebrow: hero.eyebrow || mergedCampaign.eyebrow,
        heroVideoUrl:
          sanitizeHeroVideoUrl(hero.videoWebmUrl ?? mergedCampaign.heroVideoUrl) ??
          undefined,
        heroPosterUrl:
          hero.posterUrl ??
          mergedCampaign.heroPosterUrl ??
          DEFAULT_HERO_POSTER_URL,
        ctaLabel: hero.primaryCtaLabel || mergedCampaign.ctaLabel,
        serviceNote: hero.serviceNote || mergedCampaign.serviceNote,
      },
      rackPreviewCount: rawFeatured.length > 0 ? rawFeatured.length : 12,
      occasions: mappedOccasions,
      seasonalCollections: mappedSeasons,
      serviceStatus: {
        bff: catalogOk ? 'ok' : 'degraded',
        aiTryOnMode: this.config.vtonProvider,
        phase: 'phase-3',
      },
      generatedAt: new Date().toISOString(),
      featuredProducts: rawFeatured as StorefrontBootstrapDto['featuredProducts'],
      categories: rawCategories as StorefrontBootstrapDto['categories'],
      occasionLookbooks: rawOccasions as StorefrontBootstrapDto['occasionLookbooks'],
      seasons: rawSeasons as StorefrontBootstrapDto['seasons'],
      packagingOptions: rawPackaging as StorefrontBootstrapDto['packagingOptions'],
      homepageCampaign: mergedCampaign,
      servicesStatus,
    });

    const responseEnvelope = createApiResponse(payload, {
      correlationId,
      service: this.config.serviceName,
    });
    const serializedEnvelope = JSON.stringify(responseEnvelope);

    if (catalogOk) {
      await this.redis.setSafe(
        STOREFRONT_BOOTSTRAP_CACHE_KEY,
        serializedEnvelope,
        BOOTSTRAP_TTL_SECONDS,
      );
    }

    res.setHeader('X-Cache', 'MISS');
    res.setHeader('X-Cache-Key', STOREFRONT_BOOTSTRAP_CACHE_KEY);
    res.status(200).type('application/json').send(serializedEnvelope);
  }

  async handleRackCollection(req: Request, res: Response): Promise<void> {
    await this.handleCachedCatalogProxy({
      cacheKey: STOREFRONT_RACK_CACHE_KEY,
      ttlSeconds: RACK_TTL_SECONDS,
      downstreamPath: '/v1/catalog/rack-showcase',
      req,
      res,
    });
  }

  async handleOccasions(req: Request, res: Response): Promise<void> {
    await this.handleCachedCatalogProxy({
      cacheKey: STOREFRONT_OCCASIONS_CACHE_KEY,
      ttlSeconds: OCCASIONS_TTL_SECONDS,
      downstreamPath: '/v1/catalog/occasions',
      req,
      res,
    });
  }

  async handleSeasons(req: Request, res: Response): Promise<void> {
    await this.handleCachedCatalogProxy({
      cacheKey: STOREFRONT_SEASONS_CACHE_KEY,
      ttlSeconds: SEASONS_TTL_SECONDS,
      downstreamPath: '/v1/catalog/seasons',
      req,
      res,
    });
  }

  async handleSeasonAiRestyle(
    seasonSlug: string,
    body: unknown,
    req: Request,
    res: Response,
  ): Promise<void> {
    const startedAt = performance.now();
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const normalizedSlug = (seasonSlug || '').trim().toLowerCase();

    if (!normalizedSlug || !SAFE_SEASON_SLUG_RE.test(normalizedSlug)) {
      res.status(400).json(
        createApiErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          `Invalid seasonSlug "${seasonSlug}".`,
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
      );
      return;
    }

    const parsed = SeasonAiRestyleRequestSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json(
        createApiErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          'Invalid AI seasonal restyle request payload.',
          { issues: parsed.error.issues },
          { correlationId, service: this.config.serviceName },
        ),
      );
      return;
    }

    const sortedSelections = [...parsed.data.selections].sort((a, b) => {
      const slotCmp = a.slotKey.localeCompare(b.slotKey);
      if (slotCmp !== 0) {
        return slotCmp;
      }
      return a.productId.localeCompare(b.productId);
    });

    const comboKey = sortedSelections
      .map((sel) => {
        const keyToken = sel.colorKey?.trim()
          ? sel.colorKey.trim().toLowerCase()
          : `${sel.variantId.trim()}:${sel.colorHex.trim().replace(/^#/, '').toLowerCase()}`;
        return `${sel.slotKey}:${keyToken}`;
      })
      .join('|');

    const hash = createHash('sha256')
      .update(`${normalizedSlug}|${comboKey}`)
      .digest('hex');
    const cacheKey = `season:restyle:${hash}`;

    const cachedSceneUrl = await this.redis.getSafe(cacheKey);
    if (cachedSceneUrl && cachedSceneUrl.trim().length > 0) {
      const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
      const payload: SeasonAiRestyleResponse = {
        status: 'COMPLETED',
        seasonSlug: normalizedSlug,
        comboKey,
        cacheHit: true,
        sceneImageUrl: cachedSceneUrl.trim(),
        latencyMs,
      };
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Cache-Key', cacheKey);
      res.status(200).json(
        createApiResponse(payload, {
          correlationId,
          service: this.config.serviceName,
        }),
      );
      return;
    }

    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.aiTryonServiceUrl}/v1/tryon/seasons/${encodeURIComponent(normalizedSlug)}/restyle`,
      req,
      body: {
        selections: sortedSelections,
        comboKey,
        hash,
      },
      correlationId,
      timeoutMs: 12_000,
    });

    if (!upstream.ok) {
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Cache-Key', cacheKey);
      this.proxy.sendProxyResponse(res, upstream, (payload) =>
        stripStorefrontSensitiveFields(payload),
      );
      return;
    }

    const upstreamData = unwrapDataPayload(upstream.body);
    const sceneImageUrl =
      typeof upstreamData?.sceneImageUrl === 'string'
        ? upstreamData.sceneImageUrl.trim()
        : '';

    if (!sceneImageUrl) {
      const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
      const failedPayload: SeasonAiRestyleResponse = {
        status: 'FAILED',
        seasonSlug: normalizedSlug,
        comboKey,
        cacheHit: false,
        sceneImageUrl: '',
        latencyMs,
      };
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Cache-Key', cacheKey);
      res.status(502).json(
        createApiResponse(failedPayload, {
          correlationId,
          service: this.config.serviceName,
        }),
      );
      return;
    }

    await this.redis.setSafe(cacheKey, sceneImageUrl, SEASON_RESTYLE_TTL_SECONDS);

    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
    const payload: SeasonAiRestyleResponse = {
      status: 'COMPLETED',
      seasonSlug: normalizedSlug,
      comboKey,
      cacheHit: false,
      sceneImageUrl,
      latencyMs,
    };
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('X-Cache-Key', cacheKey);
    res.status(200).json(
      createApiResponse(payload, {
        correlationId,
        service: this.config.serviceName,
      }),
    );
  }

  async handleListProducts(
    query: Record<string, unknown>,
    req: Request,
    res: Response,
  ): Promise<void> {
    const canonical = buildCanonicalQueryString(query);
    const cacheKey = `bff:storefront:products:${canonical || 'all'}`;
    const querySuffix = canonical ? `?${canonical}` : '';

    await this.handleCachedCatalogProxy({
      cacheKey,
      ttlSeconds: PRODUCTS_TTL_SECONDS,
      downstreamPath: `/v1/catalog/products${querySuffix}`,
      req,
      res,
    });
  }

  async handleProductCompositeBySlug(
    slug: string,
    req: Request,
    res: Response,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const cacheKey = `bff:storefront:product:${slug}`;

    const cachedRaw = await this.redis.getSafe(cacheKey);
    if (cachedRaw) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Cache-Key', cacheKey);
      res.status(200).type('application/json').send(cachedRaw);
      return;
    }

    const productRes = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/products/${encodeURIComponent(slug)}`,
      req,
      correlationId,
      timeoutMs: 4000,
    });

    if (!productRes.ok) {
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Cache-Key', cacheKey);
      this.proxy.sendProxyResponse(res, productRes, (payload) =>
        stripStorefrontSensitiveFields(payload),
      );
      return;
    }

    const rawProduct = unwrapDataPayload(productRes.body);
    if (!rawProduct) {
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Cache-Key', cacheKey);
      this.proxy.sendProxyResponse(res, productRes, (payload) =>
        stripStorefrontSensitiveFields(payload),
      );
      return;
    }

    const sanitizedProduct = stripStorefrontSensitiveFields(rawProduct);
    const productId = typeof sanitizedProduct.id === 'string' ? sanitizedProduct.id : '';

    let fitStats: unknown = sanitizedProduct.fitStats ?? null;
    let reviews: unknown[] = [];
    let sentimentSummary: ReviewSentimentSummary | Record<string, unknown> | null = null;
    let reviewsDegraded = false;

    if (productId) {
      const [reviewsSettled] = await Promise.allSettled([
        this.proxy.request({
          method: 'GET',
          url: `${this.config.notifyReviewServiceUrl}/v1/reviews/products/${encodeURIComponent(productId)}`,
          correlationId,
          timeoutMs: 2000,
        }),
      ]);

      if (reviewsSettled.status === 'fulfilled' && reviewsSettled.value.ok) {
        const reviewsPayload = unwrapDataPayload(reviewsSettled.value.body);
        if (reviewsPayload) {
          if (reviewsPayload.fitStats !== undefined && reviewsPayload.fitStats !== null) {
            fitStats = reviewsPayload.fitStats;
          }
          if (Array.isArray(reviewsPayload.reviews)) {
            const normalized = normalizeReviewsWithSentiment(reviewsPayload.reviews);
            reviews = normalized.reviews;
            const upstreamSummary = asRecord(reviewsPayload.sentimentSummary);
            sentimentSummary = upstreamSummary
              ? { ...normalized.computedSummary, ...upstreamSummary }
              : normalized.computedSummary;
          }
        }
      } else {
        reviewsDegraded = true;
      }
    }

    // Backward-compatible composite: top-level ProductSpuDto fields + product + fitStats + reviews + sentimentSummary + reviewsDegraded
    const compositeData = stripStorefrontSensitiveFields({
      ...sanitizedProduct,
      product: sanitizedProduct,
      fitStats,
      reviews,
      sentimentSummary,
      reviewsDegraded,
    });

    const responseEnvelope = createApiResponse(compositeData, {
      correlationId,
      service: this.config.serviceName,
    });
    const serialized = JSON.stringify(responseEnvelope);

    if (!reviewsDegraded) {
      await this.redis.setSafe(cacheKey, serialized, PRODUCTS_TTL_SECONDS);
    }

    res.setHeader('X-Cache', 'MISS');
    res.setHeader('X-Cache-Key', cacheKey);
    res.status(200).type('application/json').send(serialized);
  }

  async handleListCategories(req: Request, res: Response): Promise<void> {
    await this.handleCachedCatalogProxy({
      cacheKey: STOREFRONT_CATEGORIES_CACHE_KEY,
      ttlSeconds: BOOTSTRAP_TTL_SECONDS,
      downstreamPath: '/v1/catalog/categories',
      req,
      res,
    });
  }

  async handleSizeRecommend(body: unknown, req: Request, res: Response): Promise<void> {
    let forwardedBody = body;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const rec = { ...(body as Record<string, unknown>) };
      if (!rec.productSlug && typeof rec.slug === 'string' && rec.slug.trim()) {
        rec.productSlug = rec.slug.trim();
      }
      if (rec.fitPreference === 'SNUG') {
        rec.fitPreference = 'SLIM';
      } else if (rec.fitPreference === 'TRUE_TO_SIZE') {
        rec.fitPreference = 'REGULAR';
      }
      forwardedBody = rec;
    }

    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/size-recommend`,
      req,
      body: forwardedBody,
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  async handleRagQuery(body: unknown, req: Request, res: Response): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/rag/query`,
      req,
      body,
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  async handleStorefrontChat(
    body: unknown,
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const clientIp = this.proxy.extractClientIp(req);

    // Strip any client-spoofed privileged headers before optional JWT verification
    delete req.headers['x-user-id'];
    delete req.headers['x-user-roles'];
    delete req.headers['x-actor-roles'];
    delete req.headers['x-supplier-id'];
    delete req.headers['x-internal-secret'];
    delete req.headers['x-user-email'];
    delete req.headers['x-user-name'];
    delete req.headers['x-loyalty-tier'];

    const user = await this.jwtVerifier.verifyRequestOptional(req);

    const bodyObj = asRecord(body) ?? {};
    const headerGuestRaw = req.headers['x-guest-session-id'];
    const headerGuest = Array.isArray(headerGuestRaw) ? headerGuestRaw[0] : headerGuestRaw;
    const bodyGuest =
      typeof bodyObj.guestSessionId === 'string' && bodyObj.guestSessionId.trim().length > 0
        ? bodyObj.guestSessionId.trim()
        : undefined;
    const guestSessionId =
      (typeof headerGuest === 'string' && headerGuest.trim().length > 0
        ? headerGuest.trim().slice(0, 128)
        : undefined) ??
      bodyGuest?.slice(0, 128) ??
      `guest-${createHash('sha256').update(clientIp).digest('hex').slice(0, 16)}`;

    // Dedicated sliding-window rate limiter (20 req/min) keyed by userId OR guestSessionId + clientIp
    const bypassHeader = req.headers['x-load-test-bypass'];
    const isRateLimitBypassed =
      this.config.nodeEnv !== 'production' && bypassHeader === '1';

    if (isRateLimitBypassed) {
      res.setHeader('X-RateLimit-Limit', String(STOREFRONT_CHAT_RATE_LIMIT));
      res.setHeader('X-RateLimit-Remaining', String(STOREFRONT_CHAT_RATE_LIMIT));
    } else {
      const rateKey = user
        ? `user:${user.sub}`
        : `guest:${guestSessionId}:${clientIp}`;
      const [primaryWindow, guestIpWindow] = await Promise.all([
        this.incrementChatRateWindow(rateKey, STOREFRONT_CHAT_RATE_WINDOW_SECONDS),
        user
          ? Promise.resolve(null)
          : this.incrementChatRateWindow(
              `guest-ip:${clientIp}`,
              STOREFRONT_CHAT_RATE_WINDOW_SECONDS,
            ),
      ]);
      const primaryExceeded = primaryWindow.count > STOREFRONT_CHAT_RATE_LIMIT;
      const guestIpExceeded =
        guestIpWindow !== null && guestIpWindow.count > STOREFRONT_CHAT_GUEST_IP_RATE_LIMIT;
      const remaining = Math.max(0, STOREFRONT_CHAT_RATE_LIMIT - primaryWindow.count);
      res.setHeader('X-RateLimit-Limit', String(STOREFRONT_CHAT_RATE_LIMIT));
      res.setHeader('X-RateLimit-Remaining', String(remaining));

      if (primaryExceeded || guestIpExceeded) {
        const retryAfter = Math.max(
          1,
          primaryExceeded
            ? primaryWindow.retryAfterSeconds
            : (guestIpWindow?.retryAfterSeconds ?? 1),
        );
        const appliedLimit = primaryExceeded
          ? STOREFRONT_CHAT_RATE_LIMIT
          : STOREFRONT_CHAT_GUEST_IP_RATE_LIMIT;
        res.setHeader('Retry-After', String(retryAfter));
        res.status(429).json(
          createApiErrorResponse(
            ErrorCode.RATE_LIMITED,
            `Bạn đang gửi tin nhắn quá nhanh (giới hạn ${appliedLimit} lượt/phút). Vui lòng thử lại sau ${retryAfter} giây.`,
            {
              bucket: primaryExceeded ? 'storefront_chat' : 'storefront_chat_ip',
              limit: appliedLimit,
              windowSeconds: STOREFRONT_CHAT_RATE_WINDOW_SECONDS,
              retryAfterSeconds: retryAfter,
            },
            { correlationId, service: this.config.serviceName },
          ),
        );
        return;
      }
    }

    const rawMessage =
      typeof bodyObj.message === 'string'
        ? bodyObj.message.trim()
        : typeof bodyObj.prompt === 'string'
          ? bodyObj.prompt.trim()
          : '';
    if (!rawMessage || rawMessage.length > 2000) {
      res.status(400).json(
        createApiErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          'Tin nhắn tư vấn cần có từ 1 đến 2000 ký tự.',
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
      );
      return;
    }

    const existingContext = asRecord(bodyObj.context) ?? {};
    const safeSessionId =
      typeof bodyObj.sessionId === 'string' && bodyObj.sessionId.trim().length > 0
        ? bodyObj.sessionId.trim().slice(0, 128)
        : undefined;
    const safeHistory = Array.isArray(bodyObj.history)
      ? bodyObj.history.slice(-12)
      : undefined;
    const safeBodyProfile = asRecord(bodyObj.bodyProfile) ?? undefined;
    const safeBypassCache =
      typeof bodyObj.bypassCache === 'boolean' ? bodyObj.bypassCache : undefined;

    // HARD-FORCE portal = 'STOREFRONT' and allowlist ONLY safe storefront fields
    // (explicitly ignoring any client-supplied portal, caller, roles, or scope!)
    const forwardedBody: Record<string, unknown> = {
      message: rawMessage,
      portal: 'STOREFRONT',
      guestSessionId,
      ...(safeSessionId ? { sessionId: safeSessionId } : {}),
      ...(safeBypassCache !== undefined ? { bypassCache: safeBypassCache } : {}),
      ...(safeHistory ? { history: safeHistory } : {}),
      ...(safeBodyProfile ? { bodyProfile: safeBodyProfile } : {}),
      context: {
        ...existingContext,
        ...(safeBodyProfile ? { bodyProfile: safeBodyProfile } : {}),
        ...(safeHistory ? { history: safeHistory } : {}),
        portal: 'STOREFRONT',
        actorType: user ? 'CUSTOMER' : 'GUEST_CUSTOMER',
        guestSessionId,
        ...(user ? { userId: user.sub, loyaltyTier: user.loyaltyTier } : {}),
      },
    };

    const upstream = user
      ? await this.proxy.request({
          method: 'POST',
          url: `${this.config.upstreams.mcpCopilotUrl}/v1/copilot/chat`,
          req,
          body: forwardedBody,
          correlationId,
          timeoutMs: 65_000,
          extraHeaders: {
            'x-user-id': user.sub,
            'x-user-roles': Role.CUSTOMER,
            'x-actor-roles': Role.CUSTOMER,
            'x-user-email': user.email,
            'x-loyalty-tier': user.loyaltyTier,
            'x-guest-session-id': guestSessionId,
            'x-client-ip': clientIp,
          },
        })
      : await this.proxy.request({
          method: 'POST',
          url: `${this.config.upstreams.mcpCopilotUrl}/v1/copilot/chat`,
          body: forwardedBody,
          correlationId,
          timeoutMs: 65_000,
          extraHeaders: {
            'x-internal-secret': this.config.internalServiceSecret,
            'x-user-roles': 'GUEST_CUSTOMER',
            'x-actor-roles': 'GUEST_CUSTOMER',
            'x-guest-session-id': guestSessionId,
            'x-client-ip': clientIp,
            'X-Forwarded-For': clientIp,
          },
        });

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      sanitizeStorefrontChatPayload(payload),
    );
  }

  private async incrementChatRateWindow(
    rateKey: string,
    windowSeconds: number,
  ): Promise<{ count: number; retryAfterSeconds: number }> {
    const nowMs = Date.now();
    const windowMs = windowSeconds * 1000;
    const currentSlot = Math.floor(nowMs / windowMs);
    const prevSlot = currentSlot - 1;
    const elapsedRatio = (nowMs % windowMs) / windowMs;
    const prevWeight = 1 - elapsedRatio;

    const hashedKey = createHash('sha256').update(rateKey).digest('hex').slice(0, 24);
    const currentKey = `rl:bff:storefront_chat:${hashedKey}:${currentSlot}`;
    const prevKey = `rl:bff:storefront_chat:${hashedKey}:${prevSlot}`;

    const currentRes = await this.redis.incrWithTtlSafe(currentKey, windowSeconds * 2);
    if (currentRes !== null) {
      const prevRaw = await this.redis.getSafe(prevKey);
      const prevCount = prevRaw ? Number.parseInt(prevRaw, 10) || 0 : 0;
      const weightedCount = Math.ceil(prevCount * prevWeight) + currentRes.count;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((windowMs - (nowMs % windowMs)) / 1000),
      );
      return { count: weightedCount, retryAfterSeconds };
    }

    const cutoff = nowMs - windowMs;
    const existing = this.chatRateWindows.get(rateKey) ?? [];
    const active = existing.filter((ts) => ts > cutoff);
    active.push(nowMs);
    this.chatRateWindows.set(rateKey, active);

    if (this.chatRateWindows.size > 1500) {
      for (const [k, timestamps] of this.chatRateWindows.entries()) {
        if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff) {
          this.chatRateWindows.delete(k);
        }
      }
    }

    const oldest = active[0] ?? nowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000));
    return { count: active.length, retryAfterSeconds };
  }

  async handleListProductReviewsBySlugOrId(
    slugOrId: string,
    query: Record<string, unknown>,
    req: Request,
    res: Response,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const trimmed = (slugOrId || '').trim();
    if (!trimmed) {
      res.status(400).json(
        createApiErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          'Thiếu mã hoặc slug sản phẩm.',
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
      );
      return;
    }

    let resolvedProductId = trimmed;
    if (!UUID_REGEX.test(trimmed)) {
      const cachedRaw = await this.redis.getSafe(`bff:storefront:product:${trimmed}`);
      let foundId: string | null = null;
      if (cachedRaw) {
        try {
          const parsed = JSON.parse(cachedRaw) as unknown;
          const dataObj = unwrapDataPayload(parsed);
          if (typeof dataObj?.id === 'string' && UUID_REGEX.test(dataObj.id)) {
            foundId = dataObj.id;
          }
        } catch {
          foundId = null;
        }
      }

      if (!foundId) {
        const productRes = await this.proxy.request({
          method: 'GET',
          url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/products/${encodeURIComponent(trimmed)}`,
          req,
          correlationId,
          timeoutMs: 3000,
        });
        if (!productRes.ok) {
          this.proxy.sendProxyResponse(res, productRes, (payload) =>
            stripStorefrontSensitiveFields(payload),
          );
          return;
        }
        const productData = unwrapDataPayload(productRes.body);
        if (typeof productData?.id === 'string' && UUID_REGEX.test(productData.id)) {
          foundId = productData.id;
        }
      }

      if (!foundId) {
        res.status(404).json(
          createApiErrorResponse(
            ErrorCode.NOT_FOUND,
            `Không tìm thấy sản phẩm "${trimmed}".`,
            undefined,
            { correlationId, service: this.config.serviceName },
          ),
        );
        return;
      }
      resolvedProductId = foundId;
    }

    await this.handleListProductReviews(resolvedProductId, query, req, res);
  }

  async handleListProductReviews(
    productId: string,
    query: Record<string, unknown>,
    req: Request,
    res: Response,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.notifyReviewServiceUrl}/v1/reviews/products/${encodeURIComponent(productId)}${qs ? `?${qs}` : ''}`,
      req,
      correlationId,
      timeoutMs: 2500,
    });

    if (!upstream.ok && upstream.status === 503) {
      res.status(200).json(
        createApiResponse(
          {
            productId,
            fitStats: null,
            reviews: [],
            sentimentSummary: {
              positiveCount: 0,
              neutralCount: 0,
              negativeCount: 0,
              positivePct: 0,
              neutralPct: 0,
              negativePct: 0,
              averageSentimentScore: 0,
              totalScored: 0,
            },
            total: 0,
            reviewsDegraded: true,
          },
          { correlationId, service: this.config.serviceName },
        ),
      );
      return;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      enrichReviewEnvelopeWithSentiment(payload),
    );
  }

  async handleCreateReview(
    body: unknown,
    req: Request,
    res: Response,
    user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const bodyRec =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const derivedUserName =
      typeof bodyRec.reviewerName === 'string' && bodyRec.reviewerName.trim().length > 0
        ? bodyRec.reviewerName.trim()
        : user.email.split('@')[0] || 'Khách hàng Tầm Xuân';

    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.notifyReviewServiceUrl}/v1/reviews`,
      req,
      body,
      correlationId,
      extraHeaders: {
        'x-user-id': user.sub,
        'x-user-email': user.email,
        'x-user-name': derivedUserName,
      },
    });

    if (upstream.ok) {
      await this.cacheInvalidation.invalidateAndRevalidate(
        ['storefront', 'products', 'rack'],
        ['/', '/bo-suu-tap'],
        correlationId,
      );
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  private async handleCachedCatalogProxy(opts: {
    cacheKey: string;
    ttlSeconds: number;
    downstreamPath: string;
    req: Request;
    res: Response;
  }): Promise<void> {
    const correlationId = getOrCreateCorrelationId(opts.req.headers as HeaderBag);

    const cachedRaw = await this.redis.getSafe(opts.cacheKey);
    if (cachedRaw) {
      opts.res.setHeader('X-Cache', 'HIT');
      opts.res.setHeader('X-Cache-Key', opts.cacheKey);
      opts.res.status(200).type('application/json').send(cachedRaw);
      return;
    }

    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.catalogLookbookUrl}${opts.downstreamPath}`,
      req: opts.req,
      correlationId,
    });

    const sanitizedBody = stripStorefrontSensitiveFields(upstream.body);
    if (upstream.ok) {
      const serialized = JSON.stringify(sanitizedBody);
      await this.redis.setSafe(opts.cacheKey, serialized, opts.ttlSeconds);
      opts.res.setHeader('X-Cache', 'MISS');
      opts.res.setHeader('X-Cache-Key', opts.cacheKey);
      opts.res.status(upstream.status).type('application/json').send(serialized);
      return;
    }

    opts.res.setHeader('X-Cache', 'MISS');
    opts.res.setHeader('X-Cache-Key', opts.cacheKey);
    this.proxy.sendProxyResponse(opts.res, upstream, () => sanitizedBody);
  }
}

@Controller('bff/v1/storefront')
export class StorefrontBffController {
  constructor(
    @Inject(StorefrontBffService) private readonly storefront: StorefrontBffService,
  ) {}

  @Get('bootstrap')
  async getBootstrap(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.storefront.handleBootstrap(req, res);
  }

  @Get('rack-collection')
  async getRackCollection(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.storefront.handleRackCollection(req, res);
  }

  @Get('occasions')
  async getOccasions(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.storefront.handleOccasions(req, res);
  }

  @Get('seasons')
  async getSeasons(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.storefront.handleSeasons(req, res);
  }

  @Post('seasons/:seasonSlug/ai-restyle')
  async restyleSeason(
    @Param('seasonSlug') seasonSlug: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.storefront.handleSeasonAiRestyle(seasonSlug, body, req, res);
  }

  @Get('products')
  async listProducts(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.storefront.handleListProducts(query, req, res);
  }

  @Get('products/:slugOrId/reviews')
  async listProductReviewsBySlugOrId(
    @Param('slugOrId') slugOrId: string,
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.storefront.handleListProductReviewsBySlugOrId(slugOrId, query, req, res);
  }

  @Get('products/:slug')
  async getProductBySlug(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.storefront.handleProductCompositeBySlug(slug, req, res);
  }

  @Post('chat')
  async chatStorefront(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    await this.storefront.handleStorefrontChat(body, req, res);
  }

  @Get('categories')
  async listCategories(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.storefront.handleListCategories(req, res);
  }

  @Post('size-recommend')
  async recommendSize(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.storefront.handleSizeRecommend(body, req, res);
  }

  @Post('rag/query')
  async queryRag(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.storefront.handleRagQuery(body, req, res);
  }

  @Get('reviews/products/:productId')
  async listProductReviews(
    @Param('productId') productId: string,
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.storefront.handleListProductReviews(productId, query, req, res);
  }

  @Post('reviews')
  @UseGuards(JwtAuthGuard)
  async createReview(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    await this.storefront.handleCreateReview(body, req, res, user);
  }
}

@Controller('bff/v1')
export class StorefrontAliasBffController {
  constructor(
    @Inject(StorefrontBffService) private readonly storefront: StorefrontBffService,
  ) {}

  @Get('rack-collection')
  async getRackCollectionAlias(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.storefront.handleRackCollection(req, res);
  }

  @Get('occasions')
  async getOccasionsAlias(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.storefront.handleOccasions(req, res);
  }

  @Get('seasons')
  async getSeasonsAlias(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.storefront.handleSeasons(req, res);
  }

  @Post('seasons/:seasonSlug/ai-restyle')
  async restyleSeasonAlias(
    @Param('seasonSlug') seasonSlug: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.storefront.handleSeasonAiRestyle(seasonSlug, body, req, res);
  }

  @Get('products/:slug')
  async getProductBySlugAlias(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.storefront.handleProductCompositeBySlug(slug, req, res);
  }
}
