'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FitFeedback,
  TryOnGarmentCategory,
  TryOnMode,
  type CartDto,
  type CustomerBodyProfileDto,
  type ProductFitStatsDto,
  type ProductReviewsResponseDto,
  type ProductSpuDto,
  type VerifiedReviewDto,
} from '@atelier/contracts';
import {
  AnatomicalFitVisualizer,
  BODY_FIT_PREFERENCE_OPTIONS,
  BODY_PROFILE_UPDATED_EVENT,
  isCanonicalSizeCode,
  loadSharedBodyProfile,
  mapApiFitToProfileFit,
  saveSharedBodyProfile,
  type BodyProfileFitPreference,
  type CanonicalSizeCode,
  type ExtendedSizeRecommendResponse,
  type SharedBodyProfileV1,
} from '@/components/AnatomicalFitVisualizer';
import { ProductStickySubNav } from '@/components/ProductStickySubNav';
import { apiFetch, getStoredSession } from '@/lib/api-client';
import { FORMAT_VND, getPrimaryVariantImage } from '@/lib/catalog-data';
import {
  emitCartUpdated,
  openQuickBagDrawer,
  openVirtualTryOnModal,
  type OpenTryOnOptions,
} from '@/lib/storefront-actions';

export type ReviewSentimentLabel = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';

export interface ReviewSentimentSummary {
  positivePct: number;
  neutralPct: number;
  negativePct: number;
  positiveCount?: number;
  neutralCount?: number;
  negativeCount?: number;
  averageSentimentScore?: number | null;
  totalScored: number;
}

type ReviewWithSentiment = VerifiedReviewDto & {
  sentimentLabel?: ReviewSentimentLabel | string | null;
  diemCamXucNlp?: number | null;
};

type ExtendedProductReviewsResponse = Omit<
  ProductReviewsResponseDto,
  'reviews'
> & {
  reviews: ReviewWithSentiment[];
  sentimentSummary?: Partial<ReviewSentimentSummary> | null;
};

export interface ProductDetailClientProps {
  product: ProductSpuDto;
  initialFitStats?: ProductFitStatsDto | null;
  initialReviews?: ReviewWithSentiment[];
  initialSentimentSummary?: ReviewSentimentSummary | null;
  reviewsDegraded?: boolean;
  initialOpenTryOn?: boolean;
}

const FIT_FEEDBACK_LABELS: Record<FitFeedback, string> = {
  [FitFeedback.RUNS_SMALL]: 'Hơi chật',
  [FitFeedback.TRUE_TO_SIZE]: 'Chuẩn size',
  [FitFeedback.RUNS_LARGE]: 'Hơi rộng',
};

const SENTIMENT_BADGE_CONFIG: Record<
  ReviewSentimentLabel,
  { label: string; badgeClass: string; dotClass: string }
> = {
  POSITIVE: {
    label: 'Tích cực',
    badgeClass:
      'border-[#2E6B47]/30 bg-[#F2FBF6] text-[#1E4B32]',
    dotClass: 'bg-[#2E6B47]',
  },
  NEUTRAL: {
    label: 'Trung lập',
    badgeClass:
      'border-[#B08A4A]/35 bg-[#F4EBDA]/80 text-[#7A5B26]',
    dotClass: 'bg-[#B08A4A]',
  },
  NEGATIVE: {
    label: 'Cần lưu ý',
    badgeClass:
      'border-[#8B2E2E]/30 bg-[#FFF5F4] text-[#8B2E2E]',
    dotClass: 'bg-[#8B2E2E]',
  },
};

function resolveReviewSentimentLabel(
  review: ReviewWithSentiment,
): ReviewSentimentLabel | null {
  if (typeof review.sentimentLabel === 'string') {
    const upper = review.sentimentLabel.trim().toUpperCase();
    if (upper === 'POSITIVE' || upper === 'NEUTRAL' || upper === 'NEGATIVE') {
      return upper;
    }
  }
  const score =
    typeof review.sentimentScore === 'number' &&
    Number.isFinite(review.sentimentScore)
      ? review.sentimentScore
      : typeof review.diemCamXucNlp === 'number' &&
          Number.isFinite(review.diemCamXucNlp)
        ? review.diemCamXucNlp
        : null;
  if (score === null) {
    return null;
  }
  if (score >= 0.2) return 'POSITIVE';
  if (score <= -0.2) return 'NEGATIVE';
  return 'NEUTRAL';
}

function normalizeSentimentSummary(
  raw: Partial<ReviewSentimentSummary> | null | undefined,
): ReviewSentimentSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const countFromBuckets =
    (typeof raw.positiveCount === 'number' && Number.isFinite(raw.positiveCount)
      ? Math.max(0, Math.round(raw.positiveCount))
      : 0) +
    (typeof raw.neutralCount === 'number' && Number.isFinite(raw.neutralCount)
      ? Math.max(0, Math.round(raw.neutralCount))
      : 0) +
    (typeof raw.negativeCount === 'number' && Number.isFinite(raw.negativeCount)
      ? Math.max(0, Math.round(raw.negativeCount))
      : 0);
  const rawTotalScored =
    typeof raw.totalScored === 'number' && Number.isFinite(raw.totalScored)
      ? Math.max(0, Math.round(raw.totalScored))
      : 0;
  const totalScored = Math.max(rawTotalScored, countFromBuckets);
  const positivePct =
    typeof raw.positivePct === 'number' && Number.isFinite(raw.positivePct)
      ? Math.max(0, Math.min(100, Math.round(raw.positivePct)))
      : null;
  if (positivePct === null || totalScored <= 0) return null;
  const neutralPct =
    typeof raw.neutralPct === 'number' && Number.isFinite(raw.neutralPct)
      ? Math.max(0, Math.min(100, Math.round(raw.neutralPct)))
      : Math.max(0, 100 - positivePct);
  const negativePct =
    typeof raw.negativePct === 'number' && Number.isFinite(raw.negativePct)
      ? Math.max(0, Math.min(100, Math.round(raw.negativePct)))
      : Math.max(0, 100 - positivePct - neutralPct);
  return {
    positivePct,
    neutralPct,
    negativePct,
    averageSentimentScore:
      typeof raw.averageSentimentScore === 'number' &&
      Number.isFinite(raw.averageSentimentScore)
        ? raw.averageSentimentScore
        : null,
    totalScored,
  };
}

function computeSentimentSummaryFromReviews(
  list: ReviewWithSentiment[],
): ReviewSentimentSummary | null {
  let positive = 0;
  let neutral = 0;
  let negative = 0;
  let scoreSum = 0;
  let scoreCount = 0;

  for (const rev of list) {
    const label = resolveReviewSentimentLabel(rev);
    if (!label) continue;
    if (label === 'POSITIVE') positive += 1;
    else if (label === 'NEGATIVE') negative += 1;
    else neutral += 1;

    const score =
      typeof rev.sentimentScore === 'number' &&
      Number.isFinite(rev.sentimentScore)
        ? rev.sentimentScore
        : typeof rev.diemCamXucNlp === 'number' &&
            Number.isFinite(rev.diemCamXucNlp)
          ? rev.diemCamXucNlp
          : null;
    if (score !== null) {
      scoreSum += score;
      scoreCount += 1;
    }
  }

  const totalScored = positive + neutral + negative;
  if (totalScored <= 0) return null;

  const buckets = [
    { key: 'POSITIVE' as const, raw: (positive / totalScored) * 100 },
    { key: 'NEUTRAL' as const, raw: (neutral / totalScored) * 100 },
    { key: 'NEGATIVE' as const, raw: (negative / totalScored) * 100 },
  ].map((b) => ({
    ...b,
    floored: Math.floor(b.raw),
    remainder: b.raw - Math.floor(b.raw),
  }));

  let remainderPoints = 100 - buckets.reduce((acc, b) => acc + b.floored, 0);
  const ranked = [...buckets].sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < ranked.length && remainderPoints > 0; i += 1) {
    ranked[i]!.floored += 1;
    remainderPoints -= 1;
  }

  const byKey = new Map(ranked.map((b) => [b.key, b.floored]));
  return {
    positivePct: byKey.get('POSITIVE') ?? 0,
    neutralPct: byKey.get('NEUTRAL') ?? 0,
    negativePct: byKey.get('NEGATIVE') ?? 0,
    averageSentimentScore:
      scoreCount > 0 ? Math.round((scoreSum / scoreCount) * 1000) / 1000 : null,
    totalScored,
  };
}

function formatHeightMeters(heightCm: number | null): string | null {
  if (!heightCm || !Number.isFinite(heightCm)) return null;
  const meters = Math.floor(heightCm / 100);
  const remainder = Math.round(heightCm % 100)
    .toString()
    .padStart(2, '0');
  return `${meters}m${remainder}`;
}

function formatReviewDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

export function ProductDetailClient({
  product,
  initialFitStats = null,
  initialReviews = [],
  initialSentimentSummary = null,
  reviewsDegraded = false,
  initialOpenTryOn = false,
}: ProductDetailClientProps) {
  const [selectedVariantIdx, setSelectedVariantIdx] = useState(0);
  const [activeImageMode, setActiveImageMode] = useState<'lookbook' | 'flat'>(
    'lookbook',
  );
  const [zoomOpen, setZoomOpen] = useState(false);
  const [openAccordion, setOpenAccordion] = useState<
    'fabric' | 'care' | 'policy'
  >('fabric');

  const activeVariant =
    product.variants[selectedVariantIdx] ?? product.variants[0];

  const [selectedSkuId, setSelectedSkuId] = useState<string>(
    activeVariant?.skus.find((s) => s.inStock)?.id ??
      activeVariant?.skus[0]?.id ??
      '',
  );

  // Add-to-cart real BFF state
  const [addingToCart, setAddingToCart] = useState(false);
  const [cartFeedback, setCartFeedback] = useState<{
    kind: 'success' | 'error';
    message: string;
  } | null>(null);

  // Interactive 5-second Honest Size Advisor (zero guessed values before body profile)
  const [savedBodyProfile, setSavedBodyProfile] =
    useState<SharedBodyProfileV1 | null>(null);
  const [advisorExpanded, setAdvisorExpanded] = useState(false);
  const [showExtraMeasurements, setShowExtraMeasurements] = useState(false);
  const [heightCm, setHeightCm] = useState(163);
  const [weightKg, setWeightKg] = useState(52);
  const [bustCm, setBustCm] = useState('');
  const [waistCm, setWaistCm] = useState('');
  const [hipCm, setHipCm] = useState('');
  const [fitPreference, setFitPreference] =
    useState<BodyProfileFitPreference>('TRUE_TO_SIZE');
  const [sizeLoading, setSizeLoading] = useState(false);
  const [sizeResult, setSizeResult] =
    useState<ExtendedSizeRecommendResponse | null>(null);
  const [visualizerSize, setVisualizerSize] = useState<CanonicalSizeCode>('M');
  const [sizeError, setSizeError] = useState<string | null>(null);

  // Verified Fit Reviews state + "Cùng vóc dáng với tôi" (±4cm, ±4kg) + Verified Buyer Sentiment
  const [fitStats, setFitStats] = useState<ProductFitStatsDto | null>(
    initialFitStats,
  );
  const [reviews, setReviews] = useState<ReviewWithSentiment[]>(initialReviews);
  const [sentimentSummary, setSentimentSummary] =
    useState<ReviewSentimentSummary | null>(initialSentimentSummary);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [reviewsError, setReviewsError] = useState<string | null>(null);
  const [selectedReviewSize, setSelectedReviewSize] = useState<string>('ALL');
  const [sameBodyOnly, setSameBodyOnly] = useState(false);
  const [profileBody, setProfileBody] = useState<CustomerBodyProfileDto | null>(
    null,
  );

  const initialTryOnTriggeredRef = useRef(false);

  const activeSku =
    activeVariant?.skus.find((sku) => sku.id === selectedSkuId) ??
    activeVariant?.skus[0];

  const { lookbookUrl, flatUrl } = getPrimaryVariantImage(
    product,
    selectedVariantIdx,
  );

  const activePriceVnd =
    activeSku?.salePriceVnd ?? activeSku?.basePriceVnd ?? product.minPriceVnd;

  const availableSizeCodes = useMemo(() => {
    const set = new Set<string>();
    for (const variant of product.variants) {
      for (const sku of variant.skus) {
        set.add(sku.sizeCode);
      }
    }
    return Array.from(set);
  }, [product.variants]);

  const buildTryOnLaunchOptions = useCallback((): OpenTryOnOptions => {
    const garmentRef = {
      productId: product.id,
      variantId: activeVariant?.id,
      skuId: activeSku?.id,
      slug: product.slug,
    };

    if (product.tryonGarmentCategory === TryOnGarmentCategory.OVERALL) {
      return {
        mode: TryOnMode.SINGLE,
        onePiece: garmentRef,
      };
    }
    if (product.tryonGarmentCategory === TryOnGarmentCategory.LOWER) {
      return {
        mode: TryOnMode.SINGLE,
        lower: garmentRef,
      };
    }
    return {
      mode: TryOnMode.SINGLE,
      upper: garmentRef,
    };
  }, [
    activeSku?.id,
    activeVariant?.id,
    product.id,
    product.slug,
    product.tryonGarmentCategory,
  ]);

  const handleOpenTryOn = useCallback(() => {
    openVirtualTryOnModal(buildTryOnLaunchOptions());
  }, [buildTryOnLaunchOptions]);

  // Honor `?tryon=1` query param cleanly once on mount
  useEffect(() => {
    if (!initialOpenTryOn || initialTryOnTriggeredRef.current) return;
    initialTryOnTriggeredRef.current = true;
    openVirtualTryOnModal(buildTryOnLaunchOptions());
  }, [initialOpenTryOn, buildTryOnLaunchOptions]);

  const syncSelectedSkuToSize = useCallback(
    (sizeCode: CanonicalSizeCode) => {
      setVisualizerSize(sizeCode);
      const matchingSku =
        activeVariant?.skus.find((s) => s.sizeCode === sizeCode && s.inStock) ??
        activeVariant?.skus.find((s) => s.sizeCode === sizeCode);
      if (matchingSku && matchingSku.inStock) {
        setSelectedSkuId(matchingSku.id);
      }
    },
    [activeVariant],
  );

  const runSizeRecommendation = useCallback(
    async (
      profileInput: {
        heightCm: number;
        weightKg: number;
        bustCm?: number;
        waistCm?: number;
        hipCm?: number;
        fitPreference: BodyProfileFitPreference;
      },
      persistProfile: boolean,
    ) => {
      setSizeLoading(true);
      setSizeError(null);

      const payload: Record<string, unknown> = {
        productId: product.id,
        productSlug: product.slug,
        slug: product.slug,
        heightCm: profileInput.heightCm,
        weightKg: profileInput.weightKg,
        fitPreference: profileInput.fitPreference,
      };
      if (profileInput.bustCm && profileInput.bustCm >= 50) {
        payload.bustCm = profileInput.bustCm;
      }
      if (profileInput.waistCm && profileInput.waistCm >= 40) {
        payload.waistCm = profileInput.waistCm;
      }
      if (profileInput.hipCm && profileInput.hipCm >= 50) {
        payload.hipCm = profileInput.hipCm;
      }

      const res = await apiFetch<ExtendedSizeRecommendResponse>(
        '/bff/v1/storefront/size-recommend',
        {
          method: 'POST',
          skipAuthRefresh: true,
          body: JSON.stringify(payload),
        },
      );

      if (res.ok && res.data) {
        const recSize: CanonicalSizeCode = isCanonicalSizeCode(
          res.data.recommendedSize,
        )
          ? res.data.recommendedSize
          : 'M';
        setSizeResult(res.data);
        setVisualizerSize(recSize);
        if (res.data.fitStats) {
          setFitStats(res.data.fitStats);
        }
        syncSelectedSkuToSize(recSize);

        if (persistProfile) {
          const nextProfile: SharedBodyProfileV1 = {
            heightCm: profileInput.heightCm,
            weightKg: profileInput.weightKg,
            ...(profileInput.bustCm ? { bustCm: profileInput.bustCm } : {}),
            ...(profileInput.waistCm ? { waistCm: profileInput.waistCm } : {}),
            ...(profileInput.hipCm ? { hipCm: profileInput.hipCm } : {}),
            fitPreference: profileInput.fitPreference,
            recommendedSize: recSize,
            updatedAt: Date.now(),
          };
          saveSharedBodyProfile(nextProfile);
          setSavedBodyProfile(nextProfile);
          setAdvisorExpanded(false);
        }
      } else {
        setSizeResult(null);
        setSizeError(
          res.error?.message ||
            'Chưa thể kết nối máy chủ BFF để tính cỡ trang phục từ bảng số đo thực tế.',
        );
      }
      setSizeLoading(false);
    },
    [product.id, product.slug, syncSelectedSkuToSize],
  );

  // Hydrate ONLY from saved `atelier_body_profile_v1` (or logged-in customer profile) — NEVER fake defaults
  useEffect(() => {
    let cancelled = false;
    const localProfile = loadSharedBodyProfile();

    if (localProfile) {
      setSavedBodyProfile(localProfile);
      setHeightCm(localProfile.heightCm);
      setWeightKg(localProfile.weightKg);
      if (localProfile.bustCm) setBustCm(String(localProfile.bustCm));
      if (localProfile.waistCm) setWaistCm(String(localProfile.waistCm));
      if (localProfile.hipCm) setHipCm(String(localProfile.hipCm));
      setFitPreference(localProfile.fitPreference);
      void runSizeRecommendation(localProfile, false);
    }

    const session = getStoredSession();
    if (session?.accessToken) {
      void apiFetch<CustomerBodyProfileDto>(
        '/bff/v1/customers/me/body-profile',
        { skipAuthRefresh: true },
      ).then((res) => {
        if (cancelled || !res.ok || !res.data) return;
        setProfileBody(res.data);
        if (!localProfile) {
          const mapped: SharedBodyProfileV1 = {
            heightCm: Math.round(res.data.heightCm),
            weightKg: Math.round(res.data.weightKg),
            ...(res.data.bustCm ? { bustCm: res.data.bustCm } : {}),
            ...(res.data.waistCm ? { waistCm: res.data.waistCm } : {}),
            ...(res.data.hipCm ? { hipCm: res.data.hipCm } : {}),
            fitPreference: mapApiFitToProfileFit(res.data.fitPreference),
            updatedAt: Date.now(),
          };
          setSavedBodyProfile(mapped);
          setHeightCm(mapped.heightCm);
          setWeightKg(mapped.weightKg);
          if (mapped.bustCm) setBustCm(String(mapped.bustCm));
          if (mapped.waistCm) setWaistCm(String(mapped.waistCm));
          if (mapped.hipCm) setHipCm(String(mapped.hipCm));
          setFitPreference(mapped.fitPreference);
          void runSizeRecommendation(mapped, false);
        }
      });
    }

    const onBodyProfileUpdated = (event: Event) => {
      const detail = (event as CustomEvent<SharedBodyProfileV1>).detail;
      const latest = detail ?? loadSharedBodyProfile();
      if (!latest) return;
      setSavedBodyProfile(latest);
      setHeightCm(latest.heightCm);
      setWeightKg(latest.weightKg);
      setBustCm(latest.bustCm ? String(latest.bustCm) : '');
      setWaistCm(latest.waistCm ? String(latest.waistCm) : '');
      setHipCm(latest.hipCm ? String(latest.hipCm) : '');
      setFitPreference(latest.fitPreference);
    };

    window.addEventListener(BODY_PROFILE_UPDATED_EVENT, onBodyProfileUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener(
        BODY_PROFILE_UPDATED_EVENT,
        onBodyProfileUpdated,
      );
    };
  }, [runSizeRecommendation]);

  // Close zoom modal on Escape
  useEffect(() => {
    if (!zoomOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setZoomOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [zoomOpen]);

  const handleVariantChange = (idx: number) => {
    setSelectedVariantIdx(idx);
    setCartFeedback(null);
    const nextVariant = product.variants[idx];
    const nextSku =
      nextVariant?.skus.find((s) => s.inStock) ?? nextVariant?.skus[0];
    setSelectedSkuId(nextSku?.id ?? '');
  };

  const handleAddToCart = async () => {
    if (!activeSku || !activeSku.inStock) {
      setCartFeedback({
        kind: 'error',
        message: 'Kích cỡ đang chọn tạm hết hàng. Vui lòng chọn kích cỡ khác.',
      });
      return;
    }

    setAddingToCart(true);
    setCartFeedback(null);

    const res = await apiFetch<CartDto>('/bff/v1/storefront/cart/items', {
      method: 'POST',
      skipAuthRefresh: true,
      body: JSON.stringify({
        skuId: activeSku.id,
        productId: product.id,
        variantId: activeVariant?.id,
        qty: 1,
        fromAiTryon: false,
      }),
    });

    if (res.ok && res.data) {
      emitCartUpdated(res.data);
      setCartFeedback({
        kind: 'success',
        message: `Đã thêm ${product.name} (${activeVariant?.colorName} · Size ${activeSku.sizeCode}) vào giỏ hàng.`,
      });
      openQuickBagDrawer(null);
    } else {
      setCartFeedback({
        kind: 'error',
        message:
          res.error?.message ||
          'Chưa thể thêm vào giỏ hàng lúc này. Vui lòng thử lại.',
      });
    }
    setAddingToCart(false);
  };

  const handleComputeSize = async () => {
    if (
      !Number.isFinite(heightCm) ||
      !Number.isFinite(weightKg) ||
      heightCm < 120 ||
      weightKg < 25
    ) {
      setSizeError('Vui lòng chọn chiều cao (cm) và cân nặng (kg) hợp lệ.');
      return;
    }

    const parsedBust = bustCm && Number(bustCm) >= 50 ? Number(bustCm) : undefined;
    const parsedWaist =
      waistCm && Number(waistCm) >= 40 ? Number(waistCm) : undefined;
    const parsedHip = hipCm && Number(hipCm) >= 50 ? Number(hipCm) : undefined;

    await runSizeRecommendation(
      {
        heightCm,
        weightKg,
        bustCm: parsedBust,
        waistCm: parsedWaist,
        hipCm: parsedHip,
        fitPreference,
      },
      true,
    );

    if (sameBodyOnly) {
      void fetchFilteredReviews({
        size: selectedReviewSize,
        matchBody: true,
        h: heightCm,
        w: weightKg,
      });
    }
  };

  const fetchFilteredReviews = useCallback(
    async (opts: { size: string; matchBody: boolean; h: number; w: number }) => {
      setReviewsLoading(true);
      setReviewsError(null);

      const query = new URLSearchParams();
      if (opts.size && opts.size !== 'ALL') {
        query.set('size', opts.size);
      }
      if (opts.matchBody) {
        query.set('heightCm', String(opts.h));
        query.set('weightKg', String(opts.w));
        query.set('toleranceCm', '4');
        query.set('toleranceKg', '4');
      }

      const qs = query.toString();
      let res = await apiFetch<ExtendedProductReviewsResponse>(
        `/bff/v1/storefront/products/${encodeURIComponent(product.slug)}/reviews${qs ? `?${qs}` : ''}`,
        { skipAuthRefresh: true },
      );
      if (!res.ok && res.status === 404) {
        res = await apiFetch<ExtendedProductReviewsResponse>(
          `/bff/v1/storefront/reviews/products/${encodeURIComponent(product.id)}${qs ? `?${qs}` : ''}`,
          { skipAuthRefresh: true },
        );
      }

      if (res.ok && res.data) {
        const nextReviews = Array.isArray(res.data.reviews)
          ? res.data.reviews
          : [];
        setReviews(nextReviews);
        if (res.data.fitStats && res.data.fitStats.totalReviews >= 0) {
          setFitStats(res.data.fitStats);
        }
        const normalizedSummary = normalizeSentimentSummary(
          res.data.sentimentSummary,
        );
        if (normalizedSummary) {
          setSentimentSummary(normalizedSummary);
        } else if (nextReviews.length > 0) {
          setSentimentSummary(computeSentimentSummaryFromReviews(nextReviews));
        }
      } else {
        let localList = [...initialReviews];
        if (opts.size && opts.size !== 'ALL') {
          localList = localList.filter((r) => r.sizePurchased === opts.size);
        }
        if (opts.matchBody) {
          localList = localList.filter(
            (r) =>
              r.reviewerHeightCm != null &&
              r.reviewerWeightKg != null &&
              Math.abs(r.reviewerHeightCm - opts.h) <= 4 &&
              Math.abs(r.reviewerWeightKg - opts.w) <= 4,
          );
        }
        setReviews(localList);
        setReviewsError(
          res.error?.message ||
            'Đang lọc trên dữ liệu đánh giá đã tải gần nhất.',
        );
      }
      setReviewsLoading(false);
    },
    [initialReviews, product.id, product.slug],
  );

  const handleToggleSameBody = async () => {
    const nextValue = !sameBodyOnly;
    setSameBodyOnly(nextValue);
    const targetH = savedBodyProfile
      ? savedBodyProfile.heightCm
      : profileBody
        ? Math.round(profileBody.heightCm)
        : heightCm;
    const targetW = savedBodyProfile
      ? savedBodyProfile.weightKg
      : profileBody
        ? Math.round(profileBody.weightKg)
        : weightKg;
    await fetchFilteredReviews({
      size: selectedReviewSize,
      matchBody: nextValue,
      h: targetH,
      w: targetW,
    });
  };

  const handleReviewSizeChange = async (nextSize: string) => {
    setSelectedReviewSize(nextSize);
    const targetH = savedBodyProfile
      ? savedBodyProfile.heightCm
      : profileBody
        ? Math.round(profileBody.heightCm)
        : heightCm;
    const targetW = savedBodyProfile
      ? savedBodyProfile.weightKg
      : profileBody
        ? Math.round(profileBody.weightKg)
        : weightKg;
    await fetchFilteredReviews({
      size: nextSize,
      matchBody: sameBodyOnly,
      h: targetH,
      w: targetW,
    });
  };

  const handleJumpToBuy = () => {
    const buyEl = document.getElementById('pdp-buy');
    if (buyEl) {
      buyEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // Silently hydrate live sentimentSummary & sentimentLabel fields on mount when SSR didn't include summary
  useEffect(() => {
    if (reviewsDegraded || initialSentimentSummary) return undefined;
    let cancelled = false;
    void (async () => {
      let res = await apiFetch<ExtendedProductReviewsResponse>(
        `/bff/v1/storefront/products/${encodeURIComponent(product.slug)}/reviews`,
        { skipAuthRefresh: true, timeoutMs: 3500 },
      );
      if (!res.ok && res.status === 404) {
        res = await apiFetch<ExtendedProductReviewsResponse>(
          `/bff/v1/storefront/reviews/products/${encodeURIComponent(product.id)}`,
          { skipAuthRefresh: true, timeoutMs: 3500 },
        );
      }
      if (cancelled || !res.ok || !res.data) return;
      const summary = normalizeSentimentSummary(res.data.sentimentSummary);
      if (summary) {
        setSentimentSummary(summary);
      }
      if (Array.isArray(res.data.reviews) && res.data.reviews.length > 0) {
        const freshReviews = res.data.reviews;
        setReviews((prev) => {
          if (prev.length === 0) return freshReviews;
          const prevMissingSentiment = prev.some(
            (r) => !resolveReviewSentimentLabel(r),
          );
          return prevMissingSentiment ? freshReviews : prev;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialSentimentSummary, product.id, product.slug, reviewsDegraded]);

  const effectiveFitStats = sizeResult?.fitStats ?? fitStats;
  const effectiveSentimentSummary = useMemo(
    () => sentimentSummary ?? computeSentimentSummaryFromReviews(reviews),
    [reviews, sentimentSummary],
  );
  const targetFilterHeight = savedBodyProfile
    ? savedBodyProfile.heightCm
    : profileBody
      ? Math.round(profileBody.heightCm)
      : heightCm;
  const targetFilterWeight = savedBodyProfile
    ? savedBodyProfile.weightKg
    : profileBody
      ? Math.round(profileBody.weightKg)
      : weightKg;

  return (
    <>
      <ProductStickySubNav
        productName={product.name}
        priceVnd={activePriceVnd}
        colorName={activeVariant?.colorName}
        isTryonEnabled={product.isTryonEnabled}
        totalReviews={effectiveFitStats?.totalReviews ?? reviews.length}
        sentinelId="pdp-hero-sentinel"
        onOpenTryOn={handleOpenTryOn}
        onJumpToSizeAdvisor={() => setAdvisorExpanded(true)}
        onJumpToBuy={handleJumpToBuy}
      />

      <div className="mx-auto max-w-7xl px-6 py-10 lg:px-10">
        {/* Top Hero Sentinel (crossing this reveals ProductStickySubNav) */}
        <div id="pdp-hero-sentinel" className="pb-6">
          <nav aria-label="Breadcrumb" className="text-xs text-[#7A6A5B]">
            <Link href="/" className="hover:text-[#8A672C]">
              Trang chủ
            </Link>{' '}
            /{' '}
            <Link href="/bo-suu-tap" className="hover:text-[#8A672C]">
              Bộ sưu tập
            </Link>{' '}
            /{' '}
            <Link
              href={`/bo-suu-tap/${product.categorySlug}`}
              className="hover:text-[#8A672C]"
            >
              {product.categoryName}
            </Link>{' '}
            / <span className="text-[#1C1410]">{product.name}</span>
          </nav>

          <div className="mt-4 flex flex-wrap items-end justify-between gap-4 border-b border-[#B08A4A]/20 pb-5">
            <div>
              <p className="atelier-eyebrow text-[#8A672C]">
                {product.brandName} · {product.categoryName}
              </p>
              <h1 className="font-editorial mt-1.5 text-4xl font-light text-[#1C1410] sm:text-5xl">
                {product.name}
              </h1>
            </div>
            {effectiveFitStats && effectiveFitStats.totalReviews > 0 ? (
              <a
                href="#danh-gia-do-vua"
                className="inline-flex items-center gap-2 rounded-full border border-[#B08A4A]/35 bg-[#F4EBDA]/80 px-4 py-1.5 text-xs text-[#1C1410] transition-colors hover:border-[#8A672C]"
              >
                <span className="text-[#B08A4A]" aria-hidden="true">
                  ★
                </span>
                <strong className="font-mono">
                  {effectiveFitStats.averageRating.toFixed(1)}
                </strong>
                <span className="text-[#7A6A5B]">
                  ({effectiveFitStats.totalReviews} đánh giá độ vừa)
                </span>
              </a>
            ) : null}
          </div>
        </div>

        {/* Editorial 60/40 Layout */}
        <div className="mt-4 grid gap-10 lg:grid-cols-[1.45fr_1fr] lg:items-start">
          {/* Left 60%: High-Res Gallery + Zoom + Lookbook/3:4 Flat-Lay Toggle + Accordion */}
          <div id="pdp-overview" className="scroll-mt-36 space-y-5">
            <div className="group relative overflow-hidden rounded-3xl border border-[#B08A4A]/30 bg-[#1C1410]">
              <button
                type="button"
                onClick={() => setZoomOpen(true)}
                aria-label="Phóng to ảnh sản phẩm toàn màn hình"
                className="block w-full cursor-zoom-in text-left"
              >
                <div className="aspect-[3/4] w-full">
                  <img
                    src={activeImageMode === 'lookbook' ? lookbookUrl : flatUrl}
                    alt={`${product.name} (${activeImageMode === 'lookbook' ? 'Ảnh Lookbook' : 'Ảnh tách nền phẳng 3:4'})`}
                    className={`h-full w-full transition-transform duration-500 group-hover:scale-[1.02] ${
                      activeImageMode === 'flat'
                        ? 'bg-[#F8F4EC] object-contain p-6'
                        : 'object-cover'
                    }`}
                  />
                </div>
              </button>

              <div className="pointer-events-none absolute top-4 left-4 flex items-center gap-2">
                <span className="rounded-full bg-[#1C1410]/80 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-[#EBCF8F] backdrop-blur-sm">
                  {activeImageMode === 'lookbook'
                    ? 'Editorial Lookbook'
                    : 'Flat-Lay 3:4 · Chuẩn ướm thử AI'}
                </span>
              </div>

              <button
                type="button"
                onClick={() => setZoomOpen(true)}
                className="absolute right-4 bottom-4 rounded-full border border-[#EBCF8F]/45 bg-[#1C1410]/80 px-3.5 py-1.5 text-[11px] uppercase tracking-[0.14em] text-[#EBCF8F] backdrop-blur-sm transition-colors hover:bg-[#1C1410]"
              >
                Phóng to 1:1
              </button>
            </div>

            {/* Lookbook vs 3:4 Flat-Lay Comparison Switcher */}
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setActiveImageMode('lookbook')}
                className={`flex items-center gap-3 rounded-2xl border p-3 text-left text-xs transition-colors ${
                  activeImageMode === 'lookbook'
                    ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                    : 'border-[#B08A4A]/30 bg-white text-[#2B2019] hover:border-[#8A672C]'
                }`}
              >
                <img
                  src={lookbookUrl}
                  alt="Xem trước Lookbook"
                  className="h-14 w-11 shrink-0 rounded-lg object-cover"
                />
                <div>
                  <p className="font-medium uppercase tracking-[0.14em]">
                    Ảnh Lookbook
                  </p>
                  <p className="mt-0.5 text-[11px] opacity-75">
                    Trình diễn phom dáng &amp; độ rủ tự nhiên
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setActiveImageMode('flat')}
                className={`flex items-center gap-3 rounded-2xl border p-3 text-left text-xs transition-colors ${
                  activeImageMode === 'flat'
                    ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                    : 'border-[#B08A4A]/30 bg-white text-[#2B2019] hover:border-[#8A672C]'
                }`}
              >
                <img
                  src={flatUrl}
                  alt="Xem trước tách nền phẳng 3:4"
                  className="h-14 w-11 shrink-0 rounded-lg bg-[#F8F4EC] object-contain p-1"
                />
                <div>
                  <p className="font-medium uppercase tracking-[0.14em]">
                    Ảnh tách nền phẳng 3:4
                  </p>
                  <p className="mt-0.5 text-[11px] opacity-75">
                    Chuẩn 768×1024 cho phòng thử đồ AI
                  </p>
                </div>
              </button>
            </div>

            {/* Fabric, Care & Policy Accordion */}
            <div className="divide-y divide-[#B08A4A]/20 overflow-hidden rounded-3xl border border-[#B08A4A]/25 bg-white">
              <div>
                <button
                  type="button"
                  onClick={() => setOpenAccordion('fabric')}
                  aria-expanded={openAccordion === 'fabric'}
                  className="flex w-full items-center justify-between px-6 py-4 text-left"
                >
                  <span className="atelier-eyebrow text-[#1C1410]">
                    Chất liệu, Định lượng &amp; Phom dáng
                  </span>
                  <span className="font-mono text-sm text-[#8A672C]">
                    {openAccordion === 'fabric' ? '−' : '+'}
                  </span>
                </button>
                {openAccordion === 'fabric' ? (
                  <div className="space-y-2 px-6 pb-5 text-sm leading-relaxed text-[#5C4B41]">
                    <p>
                      <strong className="text-[#1C1410]">Thành phần:</strong>{' '}
                      {product.fabricComposition}
                    </p>
                    <p>
                      <strong className="text-[#1C1410]">
                        Định lượng &amp; Phom:
                      </strong>{' '}
                      {product.fabricWeight} · Phom {product.fitType} · Độ co
                      giãn {product.stretchLevel}
                    </p>
                    {product.description ? <p>{product.description}</p> : null}
                    {product.fitCalibrationNote ? (
                      <p className="rounded-xl border border-[#B08A4A]/25 bg-[#FBF7EF] px-3.5 py-2.5 text-xs text-[#8A672C]">
                        <strong>Ghi chú xưởng may:</strong>{' '}
                        {product.fitCalibrationNote}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div>
                <button
                  type="button"
                  onClick={() => setOpenAccordion('care')}
                  aria-expanded={openAccordion === 'care'}
                  className="flex w-full items-center justify-between px-6 py-4 text-left"
                >
                  <span className="atelier-eyebrow text-[#1C1410]">
                    Hướng dẫn bảo quản sợi tự nhiên
                  </span>
                  <span className="font-mono text-sm text-[#8A672C]">
                    {openAccordion === 'care' ? '−' : '+'}
                  </span>
                </button>
                {openAccordion === 'care' ? (
                  <ul className="space-y-1.5 px-6 pb-5 text-sm text-[#5C4B41]">
                    <li>
                      • Giặt tay nhẹ với nước lạnh dưới 30°C hoặc giặt khô cao
                      cấp để giữ độ bóng mờ nguyên bản của sợi vải.
                    </li>
                    <li>
                      • Không vắt xoắn mạnh; phơi trên móc gỗ vai rộng trong
                      bóng râm thoáng gió.
                    </li>
                    <li>
                      • Là hơi nước ở nhiệt độ thấp từ mặt trái để bảo toàn cấu
                      trúc đường may lộn giấu chỉ.
                    </li>
                  </ul>
                ) : null}
              </div>

              <div>
                <button
                  type="button"
                  onClick={() => setOpenAccordion('policy')}
                  aria-expanded={openAccordion === 'policy'}
                  className="flex w-full items-center justify-between px-6 py-4 text-left"
                >
                  <span className="atelier-eyebrow text-[#1C1410]">
                    Đổi size 7–14 ngày &amp; Quyền riêng tư AI
                  </span>
                  <span className="font-mono text-sm text-[#8A672C]">
                    {openAccordion === 'policy' ? '−' : '+'}
                  </span>
                </button>
                {openAccordion === 'policy' ? (
                  <div className="space-y-2 px-6 pb-5 text-sm text-[#5C4B41]">
                    <p>
                      • Miễn phí đổi kích cỡ trong vòng 7–14 ngày kể từ khi nhận
                      hàng (sản phẩm còn nguyên tem mác xưởng TryVibe).
                    </p>
                    <p>
                      • Ảnh khách hàng tải lên khi ướm thử AI được cách ly tại
                      phân vùng riêng tư và tự động xóa cứng sau 15 phút.
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {/* Right 40% Sticky Column: Swatches, Sizes, Real Cart/Try-On CTAs, Honest Size Advisor */}
          <div
            id="pdp-buy"
            className="scroll-mt-36 space-y-6 lg:sticky lg:top-36"
          >
            <div className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6 shadow-[0_14px_40px_rgba(28,20,16,0.05)]">
              {product.subtitle ? (
                <p className="text-sm text-[#7A6A5B]">{product.subtitle}</p>
              ) : null}

              <div className="mt-2 flex flex-wrap items-baseline gap-3">
                <span className="font-editorial text-4xl text-[#8A672C]">
                  {FORMAT_VND(activePriceVnd)}
                </span>
                {activeSku && activeSku.salePriceVnd < activeSku.basePriceVnd ? (
                  <span className="font-editorial text-xl text-[#7A6A5B] line-through">
                    {FORMAT_VND(activeSku.basePriceVnd)}
                  </span>
                ) : null}
                {activeSku ? (
                  <span className="rounded-full bg-[#F4EBDA] px-3 py-1 font-mono text-[11px] text-[#5C4B41]">
                    SKU: {activeSku.skuCode}
                  </span>
                ) : null}
              </div>

              {/* Color Swatches */}
              <div className="mt-6">
                <p className="atelier-eyebrow text-[#8A672C]">
                  Màu sắc: {activeVariant?.colorName}
                </p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {product.variants.map((variant, idx) => (
                    <button
                      key={variant.id}
                      type="button"
                      onClick={() => handleVariantChange(idx)}
                      className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs transition-colors ${
                        idx === selectedVariantIdx
                          ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                          : 'border-[#B08A4A]/35 bg-[#FBF7EF] text-[#2B2019] hover:border-[#8A672C]'
                      }`}
                    >
                      <span
                        className="h-3.5 w-3.5 rounded-full border border-white/40"
                        style={{ backgroundColor: variant.colorHex }}
                      />
                      {variant.colorName}
                    </button>
                  ))}
                </div>
              </div>

              {/* Size Pills */}
              <div className="mt-6">
                <div className="flex items-center justify-between gap-2">
                  <p className="atelier-eyebrow text-[#8A672C]">
                    Kích cỡ ({activeSku?.inStock ? 'Còn hàng' : 'Tạm hết'})
                  </p>
                  <a
                    href="#pdp-size-advisor"
                    onClick={() => setAdvisorExpanded(true)}
                    className="text-xs text-[#8A672C] underline underline-offset-4 hover:text-[#1C1410]"
                  >
                    ✦ Tính chuẩn Size của bạn
                  </a>
                </div>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {(activeVariant?.skus ?? []).map((sku) => {
                    const selected = sku.id === activeSku?.id;
                    const isRecommended =
                      sizeResult?.recommendedSize === sku.sizeCode;
                    return (
                      <button
                        key={sku.id}
                        type="button"
                        data-testid={`pdp-size-btn-${sku.sizeCode}`}
                        disabled={!sku.inStock}
                        onClick={() => {
                          setSelectedSkuId(sku.id);
                          if (isCanonicalSizeCode(sku.sizeCode)) {
                            setVisualizerSize(sku.sizeCode);
                          }
                          setCartFeedback(null);
                        }}
                        className={`relative min-w-14 rounded-2xl border px-4 py-2.5 text-xs font-medium transition-colors ${
                          selected
                            ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                            : sku.inStock
                              ? 'border-[#B08A4A]/35 bg-[#FBF7EF] text-[#1C1410] hover:border-[#8A672C]'
                              : 'cursor-not-allowed border-[#7A6A5B]/20 bg-[#F4EBDA]/40 text-[#7A6A5B]/60 line-through'
                        }`}
                      >
                        {sku.sizeCode}
                        {isRecommended ? (
                          <span
                            title="Khớp kết quả vừa tính"
                            className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[#B08A4A] align-middle"
                          />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Primary CTAs: Real Add-to-Cart + Real VirtualTryOnModal */}
              <div className="mt-6 flex flex-col gap-2.5 sm:flex-row">
                <button
                  type="button"
                  data-testid="pdp-add-to-cart-btn"
                  disabled={addingToCart || !activeSku?.inStock}
                  onClick={() => void handleAddToCart()}
                  className="flex-1 rounded-full bg-[#1C1410] px-6 py-3.5 text-center text-xs font-medium uppercase tracking-[0.18em] text-[#EBCF8F] transition-opacity hover:opacity-90 disabled:opacity-45"
                >
                  {addingToCart
                    ? 'Đang thêm vào giỏ...'
                    : `THÊM VÀO GIỎ HÀNG${activeSku ? ` · SIZE ${activeSku.sizeCode}` : ''}`}
                </button>
                {product.isTryonEnabled ? (
                  <button
                    type="button"
                    onClick={handleOpenTryOn}
                    className="rounded-full border border-[#8A672C] bg-[#F4EBDA] px-5 py-3.5 text-xs font-medium uppercase tracking-[0.14em] text-[#1C1410] transition-colors hover:bg-[#1C1410] hover:text-[#EBCF8F]"
                  >
                    Mặc thử qua Camera AI
                  </button>
                ) : null}
              </div>

              {cartFeedback ? (
                <p
                  role="status"
                  className={`mt-3 rounded-xl border px-3.5 py-2 text-xs ${
                    cartFeedback.kind === 'success'
                      ? 'border-[#2E6B47]/35 bg-[#F2FBF6] text-[#1E4B32]'
                      : 'border-[#8B2E2E]/35 bg-[#FFF5F4] text-[#8B2E2E]'
                  }`}
                >
                  {cartFeedback.message}
                </p>
              ) : null}
            </div>

            {/* Honest Crowd-Calibrated Live AI Size Advisor + 4-Zone AnatomicalFitVisualizer */}
            <section
              id="pdp-size-advisor"
              data-testid="pdp-size-advisor"
              className="scroll-mt-36 rounded-3xl border border-[#B08A4A]/35 bg-[#F4EBDA]/65 p-5"
            >
              <span id="co-van-size-ai" className="scroll-mt-36" />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="atelier-eyebrow text-[#8A672C]">
                    Cố vấn Size AI · Dữ liệu khách mặc thật
                  </p>
                  <h2 className="font-editorial mt-0.5 text-2xl text-[#1C1410]">
                    {sizeResult
                      ? `Size đề xuất cho bạn: Size ${sizeResult.recommendedSize}`
                      : 'Tư vấn kích cỡ chuẩn theo vóc dáng'}
                  </h2>
                </div>
                {savedBodyProfile ? (
                  <button
                    type="button"
                    data-testid="pdp-edit-size-profile-btn"
                    onClick={() => setAdvisorExpanded((prev) => !prev)}
                    aria-expanded={advisorExpanded}
                    className="cursor-pointer rounded-full border border-[#B08A4A]/45 bg-white px-3.5 py-1 text-[11px] font-medium text-[#8A672C] transition-colors hover:border-[#1C1410] hover:text-[#1C1410]"
                  >
                    {advisorExpanded ? 'Thu gọn số đo' : 'Chỉnh số đo'}
                  </button>
                ) : null}
              </div>

              {/* Honest CTA when NO body profile is saved yet — ZERO fake hardcoded size/percentage */}
              {!savedBodyProfile && !advisorExpanded ? (
                <div className="mt-4 space-y-3">
                  <p className="text-xs leading-relaxed text-[#5C4B41]">
                    Hệ thống không hiển thị cỡ đoán trước. Nhập chiều cao &amp;
                    cân nặng trong 5 giây để phân tích 4 vùng{' '}
                    <strong className="text-[#1C1410]">
                      Vai · Ngực · Eo · Hông
                    </strong>{' '}
                    và tự động đồng bộ cỡ chuẩn vào giỏ hàng.
                  </p>
                  <button
                    type="button"
                    data-testid="pdp-calculate-size-cta"
                    onClick={() => setAdvisorExpanded(true)}
                    className="w-full cursor-pointer rounded-full bg-[#1C1410] px-5 py-3 text-xs font-medium tracking-[0.14em] text-[#EBCF8F] transition-opacity hover:opacity-90"
                  >
                    ✦ Tính chuẩn Size của bạn trong 5 giây
                  </button>
                </div>
              ) : null}

              {advisorExpanded ? (
                <div className="mt-4 space-y-4">
                  <p className="text-xs leading-relaxed text-[#5C4B41]">
                    Điều chỉnh chiều cao (145–190cm), cân nặng (40–95kg) và tùy
                    chọn 3 vòng để đối chiếu bảng rập xưởng kết hợp phản hồi độ
                    vừa của khách hàng đã mua thật.
                  </p>

                  {/* Height & Weight Sliders */}
                  <div className="grid gap-3.5 sm:grid-cols-2">
                    <div className="rounded-2xl border border-[#B08A4A]/25 bg-white p-3.5">
                      <div className="flex items-center justify-between text-xs">
                        <label
                          htmlFor="pdp-advisor-height"
                          className="uppercase tracking-[0.14em] text-[#8A672C]"
                        >
                          Chiều cao
                        </label>
                        <span className="font-mono font-semibold text-[#1C1410]">
                          {heightCm} cm
                        </span>
                      </div>
                      <input
                        id="pdp-advisor-height"
                        data-testid="pdp-height-slider"
                        type="range"
                        min={145}
                        max={190}
                        value={heightCm}
                        onChange={(e) => setHeightCm(Number(e.target.value))}
                        className="mt-2.5 w-full accent-[#B08A4A]"
                      />
                    </div>

                    <div className="rounded-2xl border border-[#B08A4A]/25 bg-white p-3.5">
                      <div className="flex items-center justify-between text-xs">
                        <label
                          htmlFor="pdp-advisor-weight"
                          className="uppercase tracking-[0.14em] text-[#8A672C]"
                        >
                          Cân nặng
                        </label>
                        <span className="font-mono font-semibold text-[#1C1410]">
                          {weightKg} kg
                        </span>
                      </div>
                      <input
                        id="pdp-advisor-weight"
                        data-testid="pdp-weight-slider"
                        type="range"
                        min={40}
                        max={95}
                        value={weightKg}
                        onChange={(e) => setWeightKg(Number(e.target.value))}
                        className="mt-2.5 w-full accent-[#B08A4A]"
                      />
                    </div>
                  </div>

                  {/* Optional 3 Measurements */}
                  <div>
                    <button
                      type="button"
                      onClick={() => setShowExtraMeasurements((prev) => !prev)}
                      className="cursor-pointer text-xs text-[#8A672C] underline underline-offset-4 hover:text-[#1C1410]"
                    >
                      {showExtraMeasurements
                        ? 'Ẩn số đo 3 vòng tùy chọn'
                        : '+ Thêm số đo Ngực / Eo / Hông (tùy chọn)'}
                    </button>

                    {showExtraMeasurements ? (
                      <div className="mt-2.5 grid grid-cols-3 gap-2.5">
                        <label className="text-[11px] text-[#5C4B41]">
                          Ngực (cm)
                          <input
                            type="number"
                            min={60}
                            max={150}
                            placeholder="VD: 84"
                            value={bustCm}
                            onChange={(e) => setBustCm(e.target.value)}
                            className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-2.5 py-1.5 font-mono text-xs text-[#1C1410]"
                          />
                        </label>
                        <label className="text-[11px] text-[#5C4B41]">
                          Eo (cm)
                          <input
                            type="number"
                            min={45}
                            max={140}
                            placeholder="VD: 66"
                            value={waistCm}
                            onChange={(e) => setWaistCm(e.target.value)}
                            className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-2.5 py-1.5 font-mono text-xs text-[#1C1410]"
                          />
                        </label>
                        <label className="text-[11px] text-[#5C4B41]">
                          Hông (cm)
                          <input
                            type="number"
                            min={65}
                            max={160}
                            placeholder="VD: 90"
                            value={hipCm}
                            onChange={(e) => setHipCm(e.target.value)}
                            className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-2.5 py-1.5 font-mono text-xs text-[#1C1410]"
                          />
                        </label>
                      </div>
                    ) : null}
                  </div>

                  {/* Fit Preference Pills: Ôm vừa | Chuẩn phom | Thoải mái */}
                  <div className="flex flex-wrap gap-2">
                    {BODY_FIT_PREFERENCE_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        data-testid={`pdp-fit-pref-${option.value}`}
                        onClick={() => setFitPreference(option.value)}
                        className={`cursor-pointer rounded-full px-3.5 py-1.5 text-xs transition-colors ${
                          fitPreference === option.value
                            ? 'bg-[#1C1410] text-[#EBCF8F]'
                            : 'border border-[#B08A4A]/35 bg-white text-[#2B2019]'
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    data-testid="pdp-submit-size-btn"
                    disabled={sizeLoading}
                    onClick={() => void handleComputeSize()}
                    className="w-full cursor-pointer rounded-full bg-[#1C1410] py-2.5 text-[11px] font-medium uppercase tracking-[0.18em] text-[#EBCF8F] transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {sizeLoading
                      ? 'Đang phân tích 4 vùng phom...'
                      : 'Tính & Lưu Size chuẩn của tôi'}
                  </button>
                </div>
              ) : null}

              {sizeError ? (
                <p className="mt-3 text-xs text-[#8B2E2E]">{sizeError}</p>
              ) : null}

              {/* Real Result + <AnatomicalFitVisualizer /> appears ONLY after real API response */}
              {sizeResult ? (
                <div className="mt-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[#B08A4A]/35 bg-[#1C1410] px-4 py-3 text-xs text-[#FBF7EF]">
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.16em] text-[#EBCF8F]">
                        Đề xuất cho vóc dáng {targetFilterHeight}cm ·{' '}
                        {targetFilterWeight}kg
                      </p>
                      <strong
                        data-testid="pdp-recommended-size-badge"
                        className="font-editorial text-2xl text-[#FBF7EF]"
                      >
                        Size {sizeResult.recommendedSize}
                      </strong>
                    </div>
                    <span className="rounded-full border border-[#EBCF8F]/40 bg-[#2A1E17] px-3 py-1 font-mono text-[11px] text-[#EBCF8F]">
                      Độ tin cậy {Math.round(sizeResult.confidence * 100)} / 100
                    </span>
                  </div>

                  <AnatomicalFitVisualizer
                    recommendedSize={
                      isCanonicalSizeCode(sizeResult.recommendedSize)
                        ? sizeResult.recommendedSize
                        : 'M'
                    }
                    selectedSize={visualizerSize}
                    onSelectSize={(nextSize) => syncSelectedSkuToSize(nextSize)}
                    fitZones={sizeResult.fitZones}
                    allSizesFitZones={sizeResult.allSizesFitZones}
                    availableSizes={(['XS', 'S', 'M', 'L', 'XL'] as const).map(
                      (code) => ({
                        sizeCode: code,
                        inStock: Boolean(
                          activeVariant?.skus.some(
                            (s) => s.sizeCode === code && s.inStock,
                          ),
                        ),
                      }),
                    )}
                    estimatedMeasurements={sizeResult.estimatedMeasurements}
                    rationaleVi={sizeResult.rationaleVi}
                    crowdAdjusted={Boolean(sizeResult.crowdAdjusted)}
                    crowdAdjustmentReason={
                      sizeResult.crowdAdjustmentReason ?? null
                    }
                    theme="dark"
                    compact
                  />
                </div>
              ) : null}
            </section>
          </div>
        </div>

        {/* Real Size Chart Table */}
        {product.sizeChart && product.sizeChart.rows.length > 0 ? (
          <section className="mt-12 rounded-3xl border border-[#B08A4A]/25 bg-white p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="atelier-eyebrow text-[#8A672C]">
                Bảng thông số chuẩn · {product.sizeChart.name}
              </p>
              {sizeResult ? (
                <span className="rounded-full bg-[#1C1410] px-3 py-1 font-mono text-[11px] text-[#EBCF8F]">
                  Hàng nổi bật: Size {sizeResult.recommendedSize}
                </span>
              ) : null}
            </div>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-[#B08A4A]/25 bg-[#F4EBDA]/65 uppercase tracking-[0.14em] text-[#8A672C]">
                  <tr>
                    <th className="px-4 py-3">Size</th>
                    <th className="px-4 py-3">Chiều cao (cm)</th>
                    <th className="px-4 py-3">Cân nặng (kg)</th>
                    <th className="px-4 py-3">Ngực (cm)</th>
                    <th className="px-4 py-3">Eo (cm)</th>
                    <th className="px-4 py-3">Mông (cm)</th>
                    <th className="px-4 py-3">Vai (cm)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#B08A4A]/15 font-mono">
                  {product.sizeChart.rows.map((row) => {
                    const highlighted =
                      sizeResult?.recommendedSize === row.sizeCode;
                    return (
                      <tr
                        key={row.sizeCode}
                        className={highlighted ? 'bg-[#F4EBDA]/75' : undefined}
                      >
                        <td className="px-4 py-2.5 font-semibold text-[#1C1410]">
                          {row.sizeCode}
                        </td>
                        <td className="px-4 py-2.5">
                          {row.heightMinCm} – {row.heightMaxCm}
                        </td>
                        <td className="px-4 py-2.5">
                          {row.weightMinKg} – {row.weightMaxKg}
                        </td>
                        <td className="px-4 py-2.5">{row.bustCm ?? '—'}</td>
                        <td className="px-4 py-2.5">{row.waistCm ?? '—'}</td>
                        <td className="px-4 py-2.5">{row.hipCm ?? '—'}</td>
                        <td className="px-4 py-2.5">{row.shoulderCm ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {/* Verified Fit Reviews Section (#pdp-reviews & #danh-gia-do-vua) */}
        <section
          id="pdp-reviews"
          data-testid="pdp-reviews"
          className="mt-14 scroll-mt-36 rounded-3xl border border-[#B08A4A]/30 bg-white p-6 lg:p-8"
        >
          <span id="danh-gia-do-vua" className="scroll-mt-36" />
          <div className="grid gap-8 lg:grid-cols-[0.95fr_1.35fr]">
            {/* Fit Stats Distribution Panel */}
            <div className="space-y-5 rounded-3xl border border-[#B08A4A]/25 bg-[#FBF7EF] p-6">
              <div>
                <p className="atelier-eyebrow text-[#8A672C]">
                  Đánh giá độ vừa · Đã xác thực đơn hàng
                </p>
                <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
                  Phản hồi thực tế từ khách đã mặc
                </h2>
              </div>

              {reviewsDegraded ? (
                <div className="rounded-2xl border border-[#B08A4A]/40 bg-[#F4EBDA]/75 p-3.5 text-xs text-[#5C4B41]">
                  Dịch vụ đánh giá chi tiết đang tạm đồng bộ. Thông tin sản phẩm
                  và đặt mua vẫn hoạt động bình thường.
                </div>
              ) : null}

              {effectiveFitStats ? (
                <div className="space-y-4">
                  <div className="flex items-end justify-between border-b border-[#B08A4A]/20 pb-4">
                    <div>
                      <p className="font-editorial text-5xl text-[#1C1410]">
                        {effectiveFitStats.averageRating.toFixed(1)}
                        <span className="ml-1 text-xl text-[#8A672C]">
                          / 5
                        </span>
                      </p>
                      <p className="mt-1 text-xs text-[#7A6A5B]">
                        Dựa trên {effectiveFitStats.totalReviews} lượt đánh giá
                        độ vừa
                      </p>
                    </div>
                    <span className="rounded-full bg-[#1C1410] px-3.5 py-1 text-[11px] uppercase tracking-[0.14em] text-[#EBCF8F]">
                      {FIT_FEEDBACK_LABELS[effectiveFitStats.dominantFeedback]}
                    </span>
                  </div>

                  {/* 3-Segment Horizontal Fit Distribution Bar */}
                  <div className="space-y-2.5">
                    <div
                      aria-label="Biểu đồ phân bổ độ vừa 3 mức"
                      className="flex h-3.5 w-full overflow-hidden rounded-full bg-[#EBD9B4]/55"
                    >
                      <div
                        style={{ width: `${effectiveFitStats.runsSmallPct}%` }}
                        className="bg-[#8B4B3B] transition-all duration-500"
                        title={`Hơi chật ${effectiveFitStats.runsSmallPct}%`}
                      />
                      <div
                        style={{ width: `${effectiveFitStats.trueToSizePct}%` }}
                        className="bg-[#1C1410] transition-all duration-500"
                        title={`Chuẩn size ${effectiveFitStats.trueToSizePct}%`}
                      />
                      <div
                        style={{ width: `${effectiveFitStats.runsLargePct}%` }}
                        className="bg-[#B08A4A] transition-all duration-500"
                        title={`Hơi rộng ${effectiveFitStats.runsLargePct}%`}
                      />
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-center text-xs">
                      <div className="rounded-xl border border-[#B08A4A]/20 bg-white px-2 py-2">
                        <p className="text-[10px] uppercase tracking-[0.12em] text-[#8B4B3B]">
                          Hơi chật
                        </p>
                        <p className="mt-0.5 font-mono font-semibold text-[#1C1410]">
                          {effectiveFitStats.runsSmallPct}%
                        </p>
                      </div>
                      <div className="rounded-xl border border-[#1C1410]/25 bg-white px-2 py-2">
                        <p className="text-[10px] uppercase tracking-[0.12em] text-[#1C1410]">
                          Chuẩn size
                        </p>
                        <p className="mt-0.5 font-mono font-semibold text-[#1C1410]">
                          {effectiveFitStats.trueToSizePct}%
                        </p>
                      </div>
                      <div className="rounded-xl border border-[#B08A4A]/30 bg-white px-2 py-2">
                        <p className="text-[10px] uppercase tracking-[0.12em] text-[#8A672C]">
                          Hơi rộng
                        </p>
                        <p className="mt-0.5 font-mono font-semibold text-[#1C1410]">
                          {effectiveFitStats.runsLargePct}%
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-[#7A6A5B]">
                  Chưa có thống kê tổng hợp độ vừa cho thiết kế này.
                </p>
              )}

              {/* Verified Buyer Positive Sentiment Summary Pill & Breakdown Bar */}
              {effectiveSentimentSummary &&
              effectiveSentimentSummary.totalScored > 0 ? (
                <div
                  data-testid="pdp-sentiment-summary"
                  className="space-y-2.5 rounded-2xl border border-[#B08A4A]/28 bg-white p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-[#8A672C]">
                      Cảm nhận khách đã mua · NLP xác thực
                    </span>
                    <span
                      data-testid="pdp-positive-sentiment-pct"
                      className="inline-flex items-center gap-1.5 rounded-full border border-[#2E6B47]/30 bg-[#F2FBF6] px-3 py-1 font-mono text-[11px] font-semibold text-[#1E4B32]"
                    >
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 rounded-full bg-[#2E6B47]"
                      />
                      <span>
                        {effectiveSentimentSummary.positivePct}% Đánh giá tích
                        cực
                      </span>
                    </span>
                  </div>

                  <div
                    aria-label="Phân bổ cảm nhận đánh giá đã xác thực"
                    className="flex h-2 w-full overflow-hidden rounded-full bg-[#F4EBDA]"
                  >
                    <div
                      style={{
                        width: `${effectiveSentimentSummary.positivePct}%`,
                      }}
                      className="bg-[#2E6B47] transition-all duration-500"
                      title={`Tích cực ${effectiveSentimentSummary.positivePct}%`}
                    />
                    <div
                      style={{
                        width: `${effectiveSentimentSummary.neutralPct}%`,
                      }}
                      className="bg-[#B08A4A] transition-all duration-500"
                      title={`Trung lập ${effectiveSentimentSummary.neutralPct}%`}
                    />
                    <div
                      style={{
                        width: `${effectiveSentimentSummary.negativePct}%`,
                      }}
                      className="bg-[#8B2E2E] transition-all duration-500"
                      title={`Cần lưu ý ${effectiveSentimentSummary.negativePct}%`}
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#5C4B41]">
                    <span className="inline-flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-[#2E6B47]" />
                      Tích cực{' '}
                      <strong className="font-mono text-[#1C1410]">
                        {effectiveSentimentSummary.positivePct}%
                      </strong>
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-[#B08A4A]" />
                      Trung lập{' '}
                      <strong className="font-mono text-[#1C1410]">
                        {effectiveSentimentSummary.neutralPct}%
                      </strong>
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-[#8B2E2E]" />
                      Cần lưu ý{' '}
                      <strong className="font-mono text-[#1C1410]">
                        {effectiveSentimentSummary.negativePct}%
                      </strong>
                    </span>
                  </div>
                </div>
              ) : null}
            </div>

            {/* Interactive Review Filters & Verified Review Cards */}
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 pb-4">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="pdp-same-body-filter-btn"
                    onClick={() => void handleToggleSameBody()}
                    aria-pressed={sameBodyOnly}
                    className={`cursor-pointer rounded-full border px-4 py-2 text-xs font-medium transition-colors ${
                      sameBodyOnly
                        ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                        : 'border-[#8A672C] bg-[#F4EBDA] text-[#1C1410] hover:bg-[#1C1410] hover:text-[#EBCF8F]'
                    }`}
                  >
                    Xem đánh giá của người cùng vóc dáng với tôi (±4cm, ±4kg) ·{' '}
                    <span className="font-mono">
                      {targetFilterHeight}cm / {targetFilterWeight}kg
                    </span>
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleReviewSizeChange('ALL')}
                    className={`rounded-full px-3 py-1 text-[11px] transition-colors ${
                      selectedReviewSize === 'ALL'
                        ? 'bg-[#1C1410] text-[#EBCF8F]'
                        : 'border border-[#B08A4A]/30 bg-[#FBF7EF] text-[#5C4B41]'
                    }`}
                  >
                    Tất cả size
                  </button>
                  {availableSizeCodes.map((size) => (
                    <button
                      key={size}
                      type="button"
                      onClick={() => void handleReviewSizeChange(size)}
                      className={`rounded-full px-3 py-1 font-mono text-[11px] transition-colors ${
                        selectedReviewSize === size
                          ? 'bg-[#1C1410] text-[#EBCF8F]'
                          : 'border border-[#B08A4A]/30 bg-[#FBF7EF] text-[#5C4B41]'
                      }`}
                    >
                      {size}
                    </button>
                  ))}
                </div>
              </div>

              {sameBodyOnly ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[#B08A4A]/30 bg-[#FBF7EF] px-4 py-2.5 text-xs text-[#5C4B41]">
                  <span>
                    Đang hiển thị đánh giá từ khách hàng cao{' '}
                    <strong>
                      {targetFilterHeight - 4}–{targetFilterHeight + 4}cm
                    </strong>{' '}
                    và nặng{' '}
                    <strong>
                      {targetFilterWeight - 4}–{targetFilterWeight + 4}kg
                    </strong>
                    .
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      void fetchFilteredReviews({
                        size: selectedReviewSize,
                        matchBody: true,
                        h: heightCm,
                        w: weightKg,
                      })
                    }
                    className="font-medium text-[#8A672C] underline underline-offset-4"
                  >
                    Cập nhật theo số đo đang kéo
                  </button>
                </div>
              ) : null}

              {reviewsError ? (
                <p className="text-xs text-[#8A672C]">{reviewsError}</p>
              ) : null}

              {reviewsLoading ? (
                <div className="rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF] p-8 text-center text-xs text-[#7A6A5B]">
                  Đang lọc đánh giá độ vừa thực tế...
                </div>
              ) : reviews.length === 0 ? (
                <div className="rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF] p-8 text-center">
                  <p className="font-editorial text-2xl text-[#1C1410]">
                    Chưa có đánh giá khớp bộ lọc hiện tại
                  </p>
                  <p className="mt-1 text-xs text-[#7A6A5B]">
                    Thử mở rộng phạm vi kích cỡ hoặc tắt bộ lọc vóc dáng để xem
                    toàn bộ nhận xét thực tế.
                  </p>
                </div>
              ) : (
                <div className="space-y-3.5">
                  {reviews.map((review) => {
                    const heightLabel = formatHeightMeters(
                      review.reviewerHeightCm,
                    );
                    const snapshotParts = [
                      heightLabel,
                      review.reviewerWeightKg != null
                        ? `${Math.round(review.reviewerWeightKg)}kg`
                        : null,
                      `Đã mua Size ${review.sizePurchased}`,
                    ].filter(Boolean);
                    const sentimentLabel = resolveReviewSentimentLabel(review);
                    const sentimentBadge = sentimentLabel
                      ? SENTIMENT_BADGE_CONFIG[sentimentLabel]
                      : null;

                    return (
                      <article
                        key={review.id}
                        className="rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF]/70 p-4"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2.5">
                            <strong className="text-sm font-medium text-[#1C1410]">
                              {review.reviewerName}
                            </strong>
                            <span
                              className="font-mono text-xs text-[#B08A4A]"
                              aria-label={`${review.rating} trên 5 sao`}
                            >
                              {'★'.repeat(review.rating)}
                              {'☆'.repeat(Math.max(0, 5 - review.rating))}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {sentimentBadge && sentimentLabel ? (
                              <span
                                data-testid="pdp-review-sentiment-badge"
                                data-sentiment={sentimentLabel}
                                title={
                                  typeof review.sentimentScore === 'number' &&
                                  Number.isFinite(review.sentimentScore)
                                    ? `${sentimentLabel} (${review.sentimentScore >= 0 ? '+' : ''}${review.sentimentScore.toFixed(2)})`
                                    : sentimentLabel
                                }
                                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10.5px] font-medium ${sentimentBadge.badgeClass}`}
                              >
                                <span
                                  aria-hidden="true"
                                  className={`h-1.5 w-1.5 rounded-full ${sentimentBadge.dotClass}`}
                                />
                                {sentimentBadge.label}
                              </span>
                            ) : null}
                            <span className="rounded-full border border-[#B08A4A]/35 bg-white px-3 py-0.5 text-[11px] font-medium text-[#1C1410]">
                              {FIT_FEEDBACK_LABELS[review.fitFeedback]}
                            </span>
                          </div>
                        </div>

                        <p className="mt-1.5 font-mono text-[11px] text-[#8A672C]">
                          {snapshotParts.join(' · ')}
                        </p>

                        <p className="mt-2 text-sm leading-relaxed text-[#2B2019]">
                          {review.comment}
                        </p>

                        <p className="mt-2 text-[10px] uppercase tracking-[0.14em] text-[#7A6A5B]">
                          Đã xác thực đơn hàng ·{' '}
                          {formatReviewDate(review.createdAt)}
                        </p>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>

      {/* Fullscreen Lightbox Zoom Modal */}
      {zoomOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Phóng to hình ảnh sản phẩm"
          onClick={() => setZoomOpen(false)}
          className="fixed inset-0 z-[85] flex items-center justify-center bg-[#1C1410]/92 p-4 backdrop-blur-md"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative flex max-h-[92vh] max-w-4xl flex-col items-center gap-3"
          >
            <div className="flex w-full items-center justify-between text-xs text-[#EBCF8F]">
              <span>
                {product.name} ·{' '}
                {activeImageMode === 'lookbook'
                  ? 'Lookbook'
                  : 'Flat-Lay 3:4'}
              </span>
              <button
                type="button"
                onClick={() => setZoomOpen(false)}
                className="rounded-full border border-[#EBCF8F]/45 px-4 py-1 uppercase tracking-[0.16em]"
              >
                Đóng (ESC)
              </button>
            </div>
            <img
              src={activeImageMode === 'lookbook' ? lookbookUrl : flatUrl}
              alt={`${product.name} ảnh phóng to`}
              className="max-h-[82vh] w-auto rounded-2xl border border-[#B08A4A]/35 bg-[#F8F4EC] object-contain"
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
