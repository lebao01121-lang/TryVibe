'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FitFeedback,
  FitPreference,
  TryOnGarmentCategory,
  TryOnMode,
  type CartDto,
  type CustomerBodyProfileDto,
  type ProductFitStatsDto,
  type ProductReviewsResponseDto,
  type ProductSpuDto,
  type SizeRecommendResponse,
  type VerifiedReviewDto,
} from '@atelier/contracts';
import { ProductStickySubNav } from '@/components/ProductStickySubNav';
import { apiFetch, getStoredSession } from '@/lib/api-client';
import { FORMAT_VND, getPrimaryVariantImage } from '@/lib/catalog-data';
import {
  emitCartUpdated,
  openQuickBagDrawer,
  openVirtualTryOnModal,
  type OpenTryOnOptions,
} from '@/lib/storefront-actions';

export interface ProductDetailClientProps {
  product: ProductSpuDto;
  initialFitStats?: ProductFitStatsDto | null;
  initialReviews?: VerifiedReviewDto[];
  reviewsDegraded?: boolean;
  initialOpenTryOn?: boolean;
}

const FIT_FEEDBACK_LABELS: Record<FitFeedback, string> = {
  [FitFeedback.RUNS_SMALL]: 'Hơi chật',
  [FitFeedback.TRUE_TO_SIZE]: 'Chuẩn size',
  [FitFeedback.RUNS_LARGE]: 'Hơi rộng',
};

const FIT_OPTIONS: Array<{ value: FitPreference; label: string }> = [
  { value: FitPreference.SLIM, label: 'Ôm vừa (Slim)' },
  { value: FitPreference.REGULAR, label: 'Tiêu chuẩn' },
  { value: FitPreference.RELAXED, label: 'Thoải mái' },
];

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

  // Interactive 5-second Honest Size Advisor (zero guessed values before submit)
  const [advisorExpanded, setAdvisorExpanded] = useState(true);
  const [showExtraMeasurements, setShowExtraMeasurements] = useState(false);
  const [heightCm, setHeightCm] = useState(163);
  const [weightKg, setWeightKg] = useState(52);
  const [bustCm, setBustCm] = useState('');
  const [waistCm, setWaistCm] = useState('');
  const [hipCm, setHipCm] = useState('');
  const [fitPreference, setFitPreference] = useState<FitPreference>(
    FitPreference.REGULAR,
  );
  const [sizeLoading, setSizeLoading] = useState(false);
  const [sizeResult, setSizeResult] = useState<SizeRecommendResponse | null>(
    null,
  );
  const [sizeError, setSizeError] = useState<string | null>(null);

  // Verified Fit Reviews state + "Cùng vóc dáng với tôi" (±4cm, ±4kg)
  const [fitStats, setFitStats] = useState<ProductFitStatsDto | null>(
    initialFitStats,
  );
  const [reviews, setReviews] = useState<VerifiedReviewDto[]>(initialReviews);
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

  // Pre-fill measurements silently if customer is logged in with a saved body profile
  useEffect(() => {
    const session = getStoredSession();
    if (!session?.accessToken) return;

    let cancelled = false;
    void apiFetch<CustomerBodyProfileDto>('/bff/v1/customers/me/body-profile', {
      skipAuthRefresh: true,
    }).then((res) => {
      if (cancelled || !res.ok || !res.data) return;
      setProfileBody(res.data);
      setHeightCm(Math.round(res.data.heightCm));
      setWeightKg(Math.round(res.data.weightKg));
      if (res.data.bustCm) setBustCm(String(res.data.bustCm));
      if (res.data.waistCm) setWaistCm(String(res.data.waistCm));
      if (res.data.hipCm) setHipCm(String(res.data.hipCm));
      if (res.data.fitPreference) setFitPreference(res.data.fitPreference);
    });

    return () => {
      cancelled = true;
    };
  }, []);

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

    setSizeLoading(true);
    setSizeError(null);

    const payload: Record<string, unknown> = {
      productId: product.id,
      productSlug: product.slug,
      heightCm,
      weightKg,
      fitPreference,
    };
    if (bustCm && Number(bustCm) >= 50) payload.bustCm = Number(bustCm);
    if (waistCm && Number(waistCm) >= 40) payload.waistCm = Number(waistCm);
    if (hipCm && Number(hipCm) >= 50) payload.hipCm = Number(hipCm);

    const res = await apiFetch<SizeRecommendResponse>(
      '/bff/v1/storefront/size-recommend',
      {
        method: 'POST',
        skipAuthRefresh: true,
        body: JSON.stringify(payload),
      },
    );

    if (res.ok && res.data) {
      setSizeResult(res.data);
      if (res.data.fitStats) {
        setFitStats(res.data.fitStats);
      }
      try {
        window.sessionStorage.setItem(
          'atelier_last_recommended_size',
          res.data.recommendedSize,
        );
      } catch {
        // Ignore private browsing sessionStorage limits
      }
      const matchingSku = activeVariant?.skus.find(
        (s) => s.sizeCode === res.data?.recommendedSize && s.inStock,
      );
      if (matchingSku) {
        setSelectedSkuId(matchingSku.id);
      }
    } else {
      setSizeResult(null);
      setSizeError(
        res.error?.message ||
          'Chưa thể kết nối máy chủ BFF để tính cỡ trang phục từ bảng số đo thực tế.',
      );
    }
    setSizeLoading(false);
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
      }

      const qs = query.toString();
      const res = await apiFetch<ProductReviewsResponseDto>(
        `/bff/v1/storefront/reviews/products/${encodeURIComponent(product.id)}${qs ? `?${qs}` : ''}`,
        { skipAuthRefresh: true },
      );

      if (res.ok && res.data) {
        setReviews(Array.isArray(res.data.reviews) ? res.data.reviews : []);
        if (res.data.fitStats && res.data.fitStats.totalReviews >= 0) {
          setFitStats(res.data.fitStats);
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
    [initialReviews, product.id],
  );

  const handleToggleSameBody = async () => {
    const nextValue = !sameBodyOnly;
    setSameBodyOnly(nextValue);
    const targetH = profileBody ? Math.round(profileBody.heightCm) : heightCm;
    const targetW = profileBody ? Math.round(profileBody.weightKg) : weightKg;
    await fetchFilteredReviews({
      size: selectedReviewSize,
      matchBody: nextValue,
      h: targetH,
      w: targetW,
    });
  };

  const handleReviewSizeChange = async (nextSize: string) => {
    setSelectedReviewSize(nextSize);
    const targetH = profileBody ? Math.round(profileBody.heightCm) : heightCm;
    const targetW = profileBody ? Math.round(profileBody.weightKg) : weightKg;
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

  const effectiveFitStats = sizeResult?.fitStats ?? fitStats;
  const targetFilterHeight = profileBody
    ? Math.round(profileBody.heightCm)
    : heightCm;
  const targetFilterWeight = profileBody
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
                      hàng (sản phẩm còn nguyên tem mác xưởng Tầm Xuân).
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
                    href="#co-van-size-ai"
                    onClick={() => setAdvisorExpanded(true)}
                    className="text-xs text-[#8A672C] underline underline-offset-4 hover:text-[#1C1410]"
                  >
                    Tính size theo số đo thực
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
                        disabled={!sku.inStock}
                        onClick={() => {
                          setSelectedSkuId(sku.id);
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
                  disabled={addingToCart || !activeSku?.inStock}
                  onClick={() => void handleAddToCart()}
                  className="flex-1 rounded-full bg-[#1C1410] px-6 py-3.5 text-center text-xs font-medium uppercase tracking-[0.18em] text-[#EBCF8F] transition-opacity hover:opacity-90 disabled:opacity-45"
                >
                  {addingToCart ? 'Đang thêm vào giỏ...' : 'Thêm vào giỏ'}
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

            {/* Honest Crowd-Calibrated Live AI Size Advisor (Zero hardcoded % before input) */}
            <section
              id="co-van-size-ai"
              className="scroll-mt-36 rounded-3xl border border-[#B08A4A]/35 bg-[#F4EBDA]/65 p-5"
            >
              <button
                type="button"
                onClick={() => setAdvisorExpanded((prev) => !prev)}
                aria-expanded={advisorExpanded}
                className="flex w-full items-center justify-between text-left"
              >
                <div>
                  <p className="atelier-eyebrow text-[#8A672C]">
                    Cố vấn Size AI · Dữ liệu khách mặc thật
                  </p>
                  <h2 className="font-editorial mt-0.5 text-2xl text-[#1C1410]">
                    Tính size của bạn trong 5 giây
                  </h2>
                </div>
                <span className="rounded-full border border-[#B08A4A]/40 bg-white px-3 py-1 text-[11px] text-[#8A672C]">
                  {advisorExpanded ? 'Thu gọn' : 'Mở công cụ'}
                </span>
              </button>

              {advisorExpanded ? (
                <div className="mt-4 space-y-4">
                  <p className="text-xs leading-relaxed text-[#5C4B41]">
                    Hệ thống không hiển thị cỡ đoán trước. Điều chỉnh chiều cao,
                    cân nặng (và tùy chọn 3 vòng) để máy chủ đối chiếu bảng số
                    đo chuẩn kết hợp dữ liệu độ vừa của người mua thực tế.
                  </p>

                  {/* Height & Weight Sliders */}
                  <div className="grid gap-4 sm:grid-cols-2">
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
                        type="range"
                        min={145}
                        max={195}
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
                      className="text-xs text-[#8A672C] underline underline-offset-4 hover:text-[#1C1410]"
                    >
                      {showExtraMeasurements
                        ? 'Ẩn số đo 3 vòng tùy chọn'
                        : '+ Thêm số đo Ngực / Eo / Mông để tăng độ chính xác'}
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
                          Mông (cm)
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

                  {/* Fit Preference Pills */}
                  <div className="flex flex-wrap gap-2">
                    {FIT_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setFitPreference(option.value)}
                        className={`rounded-full px-3.5 py-1.5 text-xs transition-colors ${
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
                    disabled={sizeLoading}
                    onClick={() => void handleComputeSize()}
                    className="w-full rounded-full bg-[#1C1410] py-2.5 text-[11px] font-medium uppercase tracking-[0.18em] text-[#EBCF8F] transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {sizeLoading
                      ? 'Đang đối chiếu bảng số đo...'
                      : 'Đối chiếu bảng số đo thực tế'}
                  </button>

                  {sizeError ? (
                    <p className="text-xs text-[#8B2E2E]">{sizeError}</p>
                  ) : null}

                  {/* Result appears ONLY after real API response */}
                  {sizeResult ? (
                    <div className="space-y-3 rounded-2xl border border-[#B08A4A]/40 bg-[#1C1410] p-4 text-xs text-[#FBF7EF]">
                      <div className="flex items-end justify-between border-b border-[#B08A4A]/25 pb-3">
                        <div>
                          <p className="text-[10px] uppercase tracking-[0.18em] text-[#EBCF8F]">
                            Kết quả đối chiếu
                          </p>
                          <strong className="font-editorial text-3xl text-[#FBF7EF]">
                            Size {sizeResult.recommendedSize}
                          </strong>
                        </div>
                        <div className="text-right">
                          <p className="text-[10px] uppercase tracking-[0.14em] text-[#FBF7EF]/60">
                            Độ tin cậy
                          </p>
                          <span className="font-mono text-sm text-[#EBCF8F]">
                            {Math.round(sizeResult.confidence * 100)} / 100
                          </span>
                        </div>
                      </div>

                      {sizeResult.crowdAdjusted &&
                      sizeResult.crowdAdjustmentReason ? (
                        <div className="rounded-xl border border-[#EBCF8F]/55 bg-[#2A1E17] p-3 text-[#EBCF8F]">
                          <p className="text-[10px] font-semibold uppercase tracking-[0.16em]">
                            Đã hiệu chỉnh từ phản hồi khách mua thực tế
                          </p>
                          <p className="mt-1 leading-relaxed text-[#FBF7EF]/90">
                            {sizeResult.crowdAdjustmentReason}
                          </p>
                        </div>
                      ) : null}

                      {sizeResult.fitNotes.length > 0 ? (
                        <ul className="space-y-1 text-[#FBF7EF]/85">
                          {sizeResult.fitNotes.map((note) => (
                            <li key={note}>• {note}</li>
                          ))}
                        </ul>
                      ) : null}

                      {sizeResult.alternatives.length > 0 ? (
                        <p className="text-[11px] text-[#EBCF8F]/85">
                          Lựa chọn thay thế:{' '}
                          {sizeResult.alternatives
                            .map((alt) => `Size ${alt.sizeCode} (${alt.reason})`)
                            .join(' · ')}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
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

        {/* Verified Fit Reviews Section (#danh-gia-do-vua) */}
        <section
          id="danh-gia-do-vua"
          className="mt-14 scroll-mt-36 rounded-3xl border border-[#B08A4A]/30 bg-white p-6 lg:p-8"
        >
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
            </div>

            {/* Interactive Review Filters & Verified Review Cards */}
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 pb-4">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleToggleSameBody()}
                    aria-pressed={sameBodyOnly}
                    className={`rounded-full border px-4 py-2 text-xs font-medium transition-colors ${
                      sameBodyOnly
                        ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                        : 'border-[#8A672C] bg-[#F4EBDA] text-[#1C1410] hover:bg-[#1C1410] hover:text-[#EBCF8F]'
                    }`}
                  >
                    Cùng vóc dáng với tôi ({targetFilterHeight}cm ·{' '}
                    {targetFilterWeight}kg ±4)
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
                          <span className="rounded-full border border-[#B08A4A]/35 bg-white px-3 py-0.5 text-[11px] font-medium text-[#1C1410]">
                            {FIT_FEEDBACK_LABELS[review.fitFeedback]}
                          </span>
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
