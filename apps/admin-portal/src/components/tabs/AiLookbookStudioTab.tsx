'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
} from 'react';
import {
  MediaAssetType,
  VirtualModelCode,
  type LookbookSessionDTO,
  type MediaAssetDto,
  type ProductSpuDto,
} from '@atelier/contracts';
import { AnimatedTelemetryNumber } from '@atelier/motion-kit';
import { adminFetch } from '@/lib/api-client';

interface VirtualModelOption {
  code: VirtualModelCode;
  name: string;
  description: string;
  studioBackdrop?: string;
  palette?: string[];
  gender?: string;
  heightCm?: number;
}

interface BackdropPreset {
  id: string;
  label: string;
  hex: string;
  secondaryHex: string;
  prompt: string;
}

const ATELIER_BACKDROPS: readonly BackdropPreset[] = [
  {
    id: 'warm-cream-linen',
    label: 'Kem Ấm Atelier (#EFE6D5)',
    hex: '#EFE6D5',
    secondaryHex: '#E4D4B9',
    prompt:
      'Phông nền Atelier kem ấm #EFE6D5, ánh nắng sớm xuyên khung cửa gỗ Hà Nội cổ, phong cách Quiet Luxury',
  },
  {
    id: 'ivory-daylight',
    label: 'Ngà Sáng Ban Mai (#FBF7EF)',
    hex: '#FBF7EF',
    secondaryHex: '#EFE6D5',
    prompt:
      'Không gian phòng trưng bày nghệ thuật tối giản nền kem ngà #FBF7EF, đá travertine sáng và ánh đèn bảo tàng dịu nhẹ',
  },
  {
    id: 'trang-tien-arch',
    label: 'Vòm Tràng Tiền (#F4EBDA)',
    hex: '#F4EBDA',
    secondaryHex: '#DFCEB4',
    prompt:
      'Sân hiên kiến trúc Đông Dương Tràng Tiền nền kem vôi #F4EBDA lúc hoàng hôn vàng nhạt, độ sâu trường ảnh điện ảnh 85mm',
  },
  {
    id: 'evening-champagne',
    label: 'Dạ Tiệc Cacao (#261B15)',
    hex: '#261B15',
    secondaryHex: '#1C1410',
    prompt:
      'Dạ tiệc sang trọng nền cacao trầm #261B15 cùng ánh đèn champagne ấm áp tôn chất liệu lụa satin',
  },
] as const;

const FALLBACK_VIRTUAL_MODELS: VirtualModelOption[] = [
  {
    code: VirtualModelCode.MODEL_VN_FEMALE_01,
    name: 'Linh Chi · Studio Nắng Sớm (Nữ · 1m68)',
    description: 'Ánh nắng sớm Hà Nội · Tông kem ngà nhẹ bẫng',
    palette: ['#FBF7EF', '#EFE6D5', '#B08A4A'],
  },
  {
    code: VirtualModelCode.MODEL_VN_FEMALE_02,
    name: 'Ngọc Diệp · Atelier Tràng Tiền (Nữ · 1m72)',
    description: 'Kiến trúc Đông Dương · Tôn phom áo blazer & đầm lụa',
    palette: ['#F4EBDA', '#DFCEB4', '#6E5035'],
  },
  {
    code: VirtualModelCode.MODEL_VN_MALE_01,
    name: 'Minh Quân · Heritage Linen (Nam · 1m79)',
    description: 'Dáng chuẩn may đo công sở & sơ mi lụa cao cấp',
    palette: ['#EFE6D5', '#CFC2AE', '#3B2D24'],
  },
  {
    code: VirtualModelCode.MODEL_VN_MALE_02,
    name: 'Hoàng Nam · Evening Tailoring (Nam · 1m82)',
    description: 'Dạ tiệc sang trọng · Ánh đèn champagne trên nền cacao trầm',
    palette: ['#261B15', '#1C1410', '#EBCF8F'],
  },
  {
    code: VirtualModelCode.MODEL_EDITORIAL_UNISEX_01,
    name: 'TryVibe Editorial (Unisex · 1m75)',
    description: 'Tối giản phông nền Ivory #FBF7EF & ánh vàng Champagne',
    palette: ['#FBF7EF', '#EFE6D5', '#B08A4A'],
  },
];

type LookbookSessionExtended = LookbookSessionDTO & {
  autoAttach?: boolean;
  requiresHumanApproval?: boolean;
  draftStatus?: string;
};

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const base64 = result.includes(',') ? (result.split(',')[1] ?? '') : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Không thể đọc tệp ảnh 3:4.'));
    reader.readAsDataURL(file);
  });
}

function normalizeVirtualModel(raw: Record<string, unknown>): VirtualModelOption | null {
  const code = typeof raw.code === 'string' ? (raw.code as VirtualModelCode) : null;
  if (!code) return null;
  const name =
    (typeof raw.displayName === 'string' && raw.displayName.trim()) ||
    (typeof raw.name === 'string' && raw.name.trim()) ||
    code;
  const description =
    (typeof raw.vibe === 'string' && raw.vibe.trim()) ||
    (typeof raw.description === 'string' && raw.description.trim()) ||
    (typeof raw.studioBackdrop === 'string' && raw.studioBackdrop.trim()) ||
    'Người mẫu Studio TryVibe Atelier';
  return {
    code,
    name,
    description,
    studioBackdrop: typeof raw.studioBackdrop === 'string' ? raw.studioBackdrop : undefined,
    palette: Array.isArray(raw.palette)
      ? raw.palette.filter((p): p is string => typeof p === 'string')
      : undefined,
    gender: typeof raw.gender === 'string' ? raw.gender : undefined,
    heightCm: typeof raw.heightCm === 'number' ? raw.heightCm : undefined,
  };
}

function extractList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const key of ['items', 'products', 'list', 'rows', 'models', 'sessions']) {
      if (Array.isArray(obj[key])) {
        return obj[key] as T[];
      }
    }
    if (obj.data && typeof obj.data === 'object') {
      return extractList<T>(obj.data);
    }
  }
  return [];
}

function normalizeCatalogProduct(raw: ProductSpuDto): ProductSpuDto {
  return {
    ...raw,
    variants: Array.isArray(raw.variants) ? raw.variants : [],
  };
}

function getProductFlatImage(
  product: ProductSpuDto | null,
  variantId: string,
): string | null {
  if (!product) return null;
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const variant =
    variants.find((v) => v.id === variantId) ?? variants[0];
  return (
    variant?.tryonFlatPreviewUrl ??
    product.tryonFlatAssetUrl ??
    variant?.lookbookMainUrl ??
    null
  );
}

export function AiLookbookStudioTab() {
  const [products, setProducts] = useState<ProductSpuDto[]>([]);
  const [virtualModels, setVirtualModels] = useState<VirtualModelOption[]>(
    FALLBACK_VIRTUAL_MODELS,
  );
  const [selectedProductId, setSelectedProductId] = useState('');
  const [selectedVariantId, setSelectedVariantId] = useState('');
  const [selectedModelCode, setSelectedModelCode] = useState<VirtualModelCode>(
    VirtualModelCode.MODEL_VN_FEMALE_01,
  );
  const [selectedBackdropId, setSelectedBackdropId] = useState<string>(
    ATELIER_BACKDROPS[0]!.id,
  );
  const [scenePrompt, setScenePrompt] = useState<string>(
    ATELIER_BACKDROPS[0]!.prompt,
  );

  const [sessions, setSessions] = useState<LookbookSessionExtended[]>([]);
  const [loadingInit, setLoadingInit] = useState(true);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [uploadingFlat, setUploadingFlat] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [attachingId, setAttachingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    kind: 'success' | 'error';
    badge?: string;
    message: string;
  } | null>(null);

  const selectedBackdrop = useMemo(
    () =>
      ATELIER_BACKDROPS.find((b) => b.id === selectedBackdropId) ??
      ATELIER_BACKDROPS[0]!,
    [selectedBackdropId],
  );

  const loadBootstrap = useCallback(async () => {
    setLoadingInit(true);
    const [prodRes, modelRes] = await Promise.all([
      adminFetch<unknown>('/api/v1/admin/products?pageSize=50'),
      adminFetch<unknown>('/api/v1/admin/lookbook/virtual-models'),
    ]);

    if (prodRes.ok) {
      const list = extractList<ProductSpuDto>(prodRes.data).map(
        normalizeCatalogProduct,
      );
      setProducts(list);
      if (list.length > 0) {
        setSelectedProductId((prev) =>
          prev && list.some((p) => p.id === prev) ? prev : list[0]!.id,
        );
      } else {
        setSelectedProductId('');
        setSelectedVariantId('');
      }
    } else {
      setFeedback({
        kind: 'error',
        badge: prodRes.error?.code || `HTTP_${prodRes.status || 500}`,
        message:
          prodRes.error?.message ||
          'Không thể tải danh mục sản phẩm từ /api/v1/admin/products.',
      });
    }

    if (modelRes.ok) {
      const rawModels = extractList<Record<string, unknown>>(modelRes.data);
      const normalized = rawModels
        .map(normalizeVirtualModel)
        .filter((m): m is VirtualModelOption => m !== null);
      if (normalized.length > 0) {
        setVirtualModels(normalized);
      }
    }
    setLoadingInit(false);
  }, []);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  const selectedProduct = useMemo(
    () => products.find((p) => p.id === selectedProductId) ?? null,
    [products, selectedProductId],
  );

  useEffect(() => {
    if (!selectedProduct) {
      setSelectedVariantId('');
      return;
    }
    const variants = Array.isArray(selectedProduct.variants)
      ? selectedProduct.variants
      : [];
    setSelectedVariantId((prev) => {
      if (prev && variants.some((v) => v.id === prev)) {
        return prev;
      }
      return variants[0]?.id ?? '';
    });
  }, [selectedProduct]);

  const loadSessionsForProduct = useCallback(async (productId: string) => {
    if (!productId) {
      setSessions([]);
      return;
    }
    setLoadingSessions(true);
    const res = await adminFetch<unknown>(
      `/api/v1/admin/catalog/products/${encodeURIComponent(productId)}/lookbooks`,
    );
    if (res.ok) {
      setSessions(extractList<LookbookSessionDTO>(res.data));
    } else {
      setSessions([]);
    }
    setLoadingSessions(false);
  }, []);

  useEffect(() => {
    if (selectedProductId) {
      void loadSessionsForProduct(selectedProductId);
    }
  }, [selectedProductId, loadSessionsForProduct]);

  const handleSelectProduct = (product: ProductSpuDto) => {
    setSelectedProductId(product.id);
    setSelectedVariantId(product.variants[0]?.id ?? '');
    setFeedback(null);
  };

  const handleUploadFlatLay3x4 = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !selectedProduct) return;
    setUploadingFlat(true);
    setFeedback(null);

    try {
      const fileBase64 = await fileToBase64(file);
      const res = await adminFetch<MediaAssetDto>('/api/v1/admin/media/upload', {
        method: 'POST',
        body: JSON.stringify({
          assetType: MediaAssetType.TRYON_FLAT_3_4,
          fileName: file.name,
          mimeType: file.type || 'image/png',
          fileBase64,
          productId: selectedProduct.id,
          variantId: selectedVariantId || undefined,
        }),
      });
      if (res.ok && res.data) {
        setFeedback({
          kind: 'success',
          badge: '3:4 FLAT-LAY MAGIC BYTES OK',
          message: `Đã chuẩn hóa ảnh phẳng 3:4 (768×1024) cho "${selectedProduct.name}" (${res.data.width ?? 768}×${res.data.height ?? 1024}) — sẵn sàng dựng Lookbook AI (autoAttach=false).`,
        });
        await loadBootstrap();
      } else {
        setFeedback({
          kind: 'error',
          badge: res.error?.code || 'INVALID_MAGIC_BYTES',
          message:
            res.error?.message ||
            'Từ chối tệp giả mạo định dạng (400 INVALID_MAGIC_BYTES) — chỉ chấp nhận ảnh JPEG/PNG/WebP thực.',
        });
      }
    } catch (err) {
      setFeedback({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Lỗi tải ảnh 3:4 Flat-Lay.',
      });
    } finally {
      setUploadingFlat(false);
      event.target.value = '';
    }
  };

  const handleGenerateLookbook = async () => {
    if (!selectedProduct) return;
    if (scenePrompt.trim().length < 3) {
      setFeedback({
        kind: 'error',
        message: 'Vui lòng nhập mô tả bối cảnh chụp (tối thiểu 3 ký tự).',
      });
      return;
    }

    setGenerating(true);
    setFeedback(null);

    const res = await adminFetch<LookbookSessionExtended>(
      `/api/v1/admin/catalog/products/${encodeURIComponent(selectedProduct.id)}/lookbooks`,
      {
        method: 'POST',
        body: JSON.stringify({
          variantId: selectedVariantId || undefined,
          virtualModelCode: selectedModelCode,
          scenePrompt: scenePrompt.trim(),
          backdropHex: selectedBackdrop.hex,
          autoAttach: false,
          requiresHumanApproval: true,
        }),
      },
    );

    if (res.ok && res.data) {
      setFeedback({
        kind: 'success',
        badge: 'NHAP_AI · autoAttach=false',
        message: `Đã sinh bản nháp Lookbook AI (${res.data.virtualModelCode}, phông ${selectedBackdrop.hex}) — khóa chờ kiểm duyệt thủ công trước khi gắn lên Storefront.`,
      });
      await loadSessionsForProduct(selectedProduct.id);
    } else {
      setFeedback({
        kind: 'error',
        message:
          res.error?.message ||
          'Sinh ảnh Lookbook AI thất bại. Kiểm tra dịch vụ ai-tryon (:4009) và catalog-lookbook (:4002).',
      });
    }
    setGenerating(false);
  };

  const handleAttachLookbook = async (session: LookbookSessionExtended) => {
    if (!selectedProduct) return;
    setAttachingId(session.id);
    setFeedback(null);

    const res = await adminFetch<{
      productSlug?: string;
      attachedImageUrl?: string;
      cacheSha256?: string;
      prewarmCacheKey?: string;
      revalidated?: boolean;
    }>(
      `/api/v1/admin/catalog/products/${encodeURIComponent(selectedProduct.id)}/lookbooks/${encodeURIComponent(session.id)}/attach`,
      { method: 'POST', body: JSON.stringify({}) },
    );

    if (res.ok) {
      const hashShort = res.data?.cacheSha256
        ? ` · SHA-256 ${res.data.cacheSha256.slice(0, 12)}…`
        : '';
      setFeedback({
        kind: 'success',
        badge: 'SHA-256 PRE-WARM + REDIS + ISR OK',
        message: `Đã duyệt & gắn 1-chạm ảnh Lookbook cho "${selectedProduct.name}"${hashShort} — đã pre-warm Redis (:6379), xóa storefront:* & gọi /api/revalidate cập nhật Storefront tức thì!`,
      });
      await Promise.all([
        loadSessionsForProduct(selectedProduct.id),
        loadBootstrap(),
      ]);
    } else {
      setFeedback({
        kind: 'error',
        message:
          res.error?.message ||
          'Không thể gắn ảnh Lookbook vào trang sản phẩm.',
      });
    }
    setAttachingId(null);
  };

  const flatPreviewUrl = getProductFlatImage(
    selectedProduct,
    selectedVariantId,
  );

  return (
    <div data-testid="ai-lookbook-studio" className="space-y-8">
      <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#B08A4A]/20 pb-5">
          <div>
            <p className="ledger-eyebrow text-[#8A672C]">
              AI Lookbook Studio · Human-in-the-Loop (autoAttach = false) &amp; 1-Click Pre-warm
            </p>
            <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Phòng Chụp Lookbook Ảo Bằng AI
            </h2>
            <p className="mt-1 text-xs text-[#7A6A5B]">
              Chọn hoặc tải ảnh phẳng <code>3:4</code> (<code>768×1024</code>, kiểm định Magic Bytes),
              chọn người mẫu Studio &amp; phông nền kem ấm Atelier (<code>#EFE6D5</code> / <code>#FBF7EF</code>).
              Mọi ảnh tạo mới mặc định khóa <code>autoAttach=false</code> chờ kiểm duyệt 1-chạm.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#B08A4A]/45 bg-[#EFE6D5] px-3 py-1.5 font-mono text-[10px] font-semibold text-[#1C1410]">
              <span className="relative flex h-2 w-2 items-center justify-center">
                <span
                  aria-hidden="true"
                  className="telemetry-anim telemetry-beacon-ring absolute inset-0 rounded-full bg-emerald-500/75"
                />
                <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-600" />
              </span>
              HITL LOCK · <AnimatedTelemetryNumber value={products.length} /> SPU ·{' '}
              <AnimatedTelemetryNumber value={sessions.length} /> phiên
            </span>
            <button
              type="button"
              disabled={loadingInit}
              onClick={() => void loadBootstrap()}
              className="rounded-full border border-[#B08A4A]/40 bg-[#FBF7EF] px-4 py-2 text-xs text-[#1C1410]"
            >
              {loadingInit ? 'Đang tải...' : 'Làm mới danh mục'}
            </button>
          </div>
        </div>

        {feedback ? (
          <div
            role="status"
            className={`mt-4 rounded-2xl border px-4 py-3 text-xs ${
              feedback.kind === 'success'
                ? 'border-[#2E6B47]/35 bg-[#F2FBF6] text-[#1E4B32]'
                : 'border-[#8B2E2E]/35 bg-[#FFF5F4] text-[#8B2E2E]'
            }`}
          >
            {feedback.badge ? (
              <span
                className={`mr-2 inline-flex items-center rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold ${
                  feedback.kind === 'success'
                    ? 'bg-[#1E4B32] text-white'
                    : 'bg-[#8B2E2E] text-white'
                }`}
              >
                {feedback.badge}
              </span>
            ) : null}
            {feedback.message}
          </div>
        ) : null}

        <div className="mt-6 grid gap-6 lg:grid-cols-[0.95fr_1.15fr]">
          {/* Left Column: Product Picker with 3:4 Flat-Lay Preview */}
          <div className="space-y-4">
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[#8A672C]">
              1. Chọn thiết kế &amp; Biến thể màu (3:4 Flat-Lay)
            </p>

            <div className="max-h-60 space-y-2 overflow-y-auto pr-1">
              {products.map((prod) => {
                const active = prod.id === selectedProduct?.id;
                const thumb = getProductFlatImage(
                  prod,
                  prod.variants[0]?.id ?? '',
                );
                return (
                  <button
                    key={prod.id}
                    type="button"
                    onClick={() => handleSelectProduct(prod)}
                    className={`flex w-full items-center gap-3 rounded-2xl border p-2.5 text-left text-xs transition-colors ${
                      active
                        ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                        : 'border-[#B08A4A]/25 bg-[#FBF7EF] text-[#1C1410] hover:border-[#8A672C]'
                    }`}
                  >
                    {thumb ? (
                      <img
                        src={thumb}
                        alt={prod.name}
                        className="h-12 w-9 shrink-0 rounded-lg bg-[#F8F4EC] object-contain p-0.5"
                      />
                    ) : (
                      <div className="h-12 w-9 shrink-0 rounded-lg bg-[#EBD9B4]/50" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{prod.name}</p>
                      <p className="mt-0.5 truncate text-[10px] opacity-75">
                        {prod.categoryName} · {prod.variants.length} màu ·{' '}
                        {prod.tryonGarmentCategory}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>

            {selectedProduct ? (
              <div className="rounded-2xl border border-[#B08A4A]/25 bg-[#FBF7EF] p-4">
                <div className="flex flex-wrap gap-1.5">
                  {selectedProduct.variants.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => setSelectedVariantId(v.id)}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] ${
                        v.id === selectedVariantId
                          ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                          : 'border-[#B08A4A]/35 bg-white text-[#2B2019]'
                      }`}
                    >
                      <span
                        className="h-2.5 w-2.5 rounded-full border border-black/15"
                        style={{ backgroundColor: v.colorHex }}
                      />
                      {v.colorName}
                    </button>
                  ))}
                </div>

                {flatPreviewUrl ? (
                  <div
                    className="mt-3 overflow-hidden rounded-xl border border-[#B08A4A]/25 p-3"
                    style={{ backgroundColor: selectedBackdrop.hex }}
                  >
                    <img
                      src={flatPreviewUrl}
                      alt={`${selectedProduct.name} 3:4 flat-lay`}
                      className="mx-auto aspect-[3/4] max-h-56 object-contain"
                    />
                  </div>
                ) : null}

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#B08A4A]/20 pt-3">
                  <span className="font-mono text-[10px] text-[#7A6A5B]">
                    Chuẩn 3:4 (768×1024) · Magic Bytes
                  </span>
                  <label className="cursor-pointer rounded-full border border-[#1C1410] bg-white px-3 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-[#1C1410] hover:bg-[#1C1410] hover:text-[#EBCF8F]">
                    {uploadingFlat
                      ? 'Đang kiểm định Magic Bytes...'
                      : 'Tải ảnh 3:4 Flat-Lay mới'}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      disabled={uploadingFlat}
                      onChange={(e) => void handleUploadFlatLay3x4(e)}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>
            ) : null}
          </div>

          {/* Right Column: Pick 1 of 5 Virtual Studio Models + Warm Cream Atelier Backdrop */}
          <div className="space-y-4">
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[#8A672C]">
              2. Chọn Người mẫu Studio Ảo (5 mẫu chuẩn) &amp; Phông nền Atelier
            </p>

            <div className="grid gap-2.5 sm:grid-cols-2">
              {virtualModels.map((model) => {
                const active = model.code === selectedModelCode;
                return (
                  <button
                    key={model.code}
                    type="button"
                    onClick={() => setSelectedModelCode(model.code)}
                    className={`rounded-2xl border p-3.5 text-left text-xs transition-colors ${
                      active
                        ? 'border-[#1C1410] bg-[#1C1410] text-[#FBF7EF]'
                        : 'border-[#B08A4A]/30 bg-[#FBF7EF] text-[#1C1410] hover:border-[#8A672C]'
                    }`}
                  >
                    <p className="font-mono text-[10px] text-[#B08A4A]">
                      {model.code}
                    </p>
                    <p className="mt-1 font-medium">{model.name}</p>
                    <p className="mt-0.5 text-[11px] opacity-75">
                      {model.description}
                    </p>
                  </button>
                );
              })}
            </div>

            <div className="space-y-2">
              <p className="text-[11px] uppercase tracking-[0.14em] text-[#8A672C]">
                Phông nền Atelier (Warm Cream #EFE6D5 / Ivory #FBF7EF)
              </p>
              <div className="grid grid-cols-2 gap-2">
                {ATELIER_BACKDROPS.map((backdrop) => {
                  const active = backdrop.id === selectedBackdropId;
                  return (
                    <button
                      key={backdrop.id}
                      type="button"
                      onClick={() => {
                        setSelectedBackdropId(backdrop.id);
                        setScenePrompt(backdrop.prompt);
                      }}
                      className={`flex items-center gap-2 rounded-2xl border px-3 py-2 text-left text-[11px] transition-colors ${
                        active
                          ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                          : 'border-[#B08A4A]/35 bg-white text-[#2B2019] hover:border-[#8A672C]'
                      }`}
                    >
                      <span
                        className="h-4 w-4 shrink-0 rounded-full border border-black/20"
                        style={{
                          background: `linear-gradient(135deg, ${backdrop.hex} 0%, ${backdrop.secondaryHex} 100%)`,
                        }}
                      />
                      <span className="truncate font-medium">{backdrop.label}</span>
                    </button>
                  );
                })}
              </div>

              <label className="block pt-1 text-xs">
                <span className="text-[11px] uppercase tracking-[0.14em] text-[#8A672C]">
                  Bối cảnh chụp &amp; Ánh sáng (scenePrompt)
                </span>
                <textarea
                  rows={3}
                  value={scenePrompt}
                  onChange={(e) => setScenePrompt(e.target.value)}
                  className="mt-1.5 w-full rounded-2xl border border-[#B08A4A]/35 bg-[#FBF7EF] p-3 text-xs text-[#1C1410] outline-none focus:border-[#1C1410]"
                />
              </label>
            </div>

            <button
              type="button"
              data-testid="lookbook-generate-btn"
              disabled={!selectedProduct || generating}
              onClick={() => void handleGenerateLookbook()}
              className="w-full rounded-full bg-[#1C1410] py-3 text-xs font-medium uppercase tracking-[0.18em] text-[#EBCF8F] transition-opacity hover:opacity-90 disabled:opacity-45"
            >
              {generating
                ? 'Đang dựng bản nháp Lookbook AI (autoAttach=false)...'
                : '✦ Sinh bản nháp Lookbook AI (Chờ duyệt thủ công)'}
            </button>
          </div>
        </div>
      </section>

      {/* Preview Gallery of Generated Lookbook Sessions with 1-Click Attach */}
      <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="ledger-eyebrow text-[#8A672C]">
              Generated Lookbook Sessions ({sessions.length})
            </p>
            <h3 className="font-editorial mt-0.5 text-3xl text-[#1C1410]">
              Thư viện ảnh Lookbook AI của{' '}
              {selectedProduct?.name ?? 'sản phẩm đang chọn'}
            </h3>
          </div>
        </div>

        {loadingSessions ? (
          <p className="mt-4 text-xs text-[#7A6A5B]">
            Đang tải lịch sử Lookbook AI...
          </p>
        ) : sessions.length === 0 ? (
          <div className="mt-4 rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF] p-8 text-center text-xs text-[#7A6A5B]">
            Chưa có phiên ảnh Lookbook AI nào cho sản phẩm này. Chọn người mẫu ở
            trên và nhấn <strong>&ldquo;Sinh ảnh Lookbook AI&rdquo;</strong> để
            tạo ảnh mẫu chuẩn editorial.
          </div>
        ) : (
          <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {sessions.map((session) => {
              const isAttached =
                session.approvedForGallery ||
                String(session.status) === 'ATTACHED';

              return (
                <article
                  key={session.id}
                  className="flex flex-col overflow-hidden rounded-2xl border border-[#B08A4A]/30 bg-[#FBF7EF]"
                >
                  <div className="relative aspect-[3/4] w-full bg-[#1C1410]">
                    {session.resultUrl ? (
                      <img
                        src={session.resultUrl}
                        alt={`Lookbook ${session.virtualModelCode}`}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-xs text-[#EBCF8F]/70">
                        Đang kết xuất ảnh...
                      </div>
                    )}
                    <span
                      className={`absolute top-3 left-3 rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold ${
                        isAttached
                          ? 'bg-[#1E4B32] text-white'
                          : 'bg-[#1C1410]/85 text-[#EBCF8F]'
                      }`}
                    >
                      {isAttached
                        ? 'ATTACHED · Đang trưng bày'
                        : 'NHAP_AI · autoAttach=false'}
                    </span>
                  </div>

                  <div className="flex flex-1 flex-col justify-between space-y-3 p-4 text-xs">
                    <div>
                      <p className="font-mono text-[10px] text-[#8A672C]">
                        {session.virtualModelCode} · {session.providerUsed}
                      </p>
                      <p className="mt-1 line-clamp-2 text-[11px] text-[#5C4B41]">
                        {session.scenePrompt}
                      </p>
                      {!isAttached ? (
                        <p className="mt-1.5 font-mono text-[10px] text-[#8A672C]">
                          requiresHumanApproval: true · Chờ duyệt 1-chạm
                        </p>
                      ) : null}
                    </div>

                    <button
                      type="button"
                      data-testid="lookbook-approve-attach-btn"
                      disabled={attachingId === session.id || !session.resultUrl}
                      onClick={() => void handleAttachLookbook(session)}
                      className={`w-full rounded-full px-4 py-2.5 text-[10px] font-semibold tracking-[0.06em] transition-colors disabled:opacity-50 ${
                        isAttached
                          ? 'border border-[#1E4B32] bg-[#F2FBF6] text-[#1E4B32]'
                          : 'bg-[#1C1410] text-[#EBCF8F] hover:opacity-90'
                      }`}
                    >
                      {attachingId === session.id
                        ? 'Đang duyệt, Pre-warm Redis & Revalidate ISR...'
                        : isAttached
                          ? '✦ Duyệt lại & Pre-warm Cache (Đang trưng bày)'
                          : '✦ Duyệt & Gắn 1-chạm làm Ảnh Trưng Bày / Pre-warm Cache'}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
