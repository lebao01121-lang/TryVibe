'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  VirtualModelCode,
  type LookbookSessionDTO,
  type ProductSpuDto,
} from '@atelier/contracts';
import { adminFetch } from '@/lib/api-client';

interface VirtualModelOption {
  code: VirtualModelCode;
  name: string;
  description: string;
  gender?: string;
  heightCm?: number;
}

const FALLBACK_VIRTUAL_MODELS: VirtualModelOption[] = [
  {
    code: VirtualModelCode.MODEL_VN_FEMALE_01,
    name: 'Minh Thư (Nữ · 1m66)',
    description: 'Phong thái thanh lịch Hà Nội, ánh sáng xưởng tự nhiên',
  },
  {
    code: VirtualModelCode.MODEL_VN_FEMALE_02,
    name: 'Lan Anh (Nữ · 1m71)',
    description: 'Editorial tối giản, tôn phom áo blazer & đầm lụa',
  },
  {
    code: VirtualModelCode.MODEL_VN_MALE_01,
    name: 'Quang Minh (Nam · 1m78)',
    description: 'Dáng chuẩn may đo công sở & sơ mi lụa cao cấp',
  },
  {
    code: VirtualModelCode.MODEL_VN_MALE_02,
    name: 'Hoàng Nam (Nam · 1m81)',
    description: 'Phong cách Resort & Linen đương đại',
  },
  {
    code: VirtualModelCode.MODEL_EDITORIAL_UNISEX_01,
    name: 'Studio Muse (Unisex · 1m74)',
    description: 'Tối giản phông nền Ivory & ánh vàng Champagne',
  },
];

const SCENE_PRESETS = [
  'Ánh sáng sớm xuyên qua khung cửa gỗ Hà Nội cổ, phông tường vôi ấm Ivory, phong cách Quiet Luxury',
  'Sân hiên kiến trúc Đông Dương lúc hoàng hôn vàng nhạt, độ sâu trường ảnh điện ảnh 85mm',
  'Không gian phòng trưng bày nghệ thuật tối giản, nền đá travertine kem và ánh đèn bảo tàng dịu nhẹ',
] as const;

function extractList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const key of ['items', 'list', 'rows', 'products', 'models', 'sessions']) {
      if (Array.isArray(obj[key])) {
        return obj[key] as T[];
      }
    }
  }
  return [];
}

function getProductFlatImage(
  product: ProductSpuDto | null,
  variantId: string,
): string | null {
  if (!product) return null;
  const variant =
    product.variants.find((v) => v.id === variantId) ?? product.variants[0];
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
  const [scenePrompt, setScenePrompt] = useState<string>(SCENE_PRESETS[0]);

  const [sessions, setSessions] = useState<LookbookSessionDTO[]>([]);
  const [loadingInit, setLoadingInit] = useState(true);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [attachingId, setAttachingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    kind: 'success' | 'error';
    message: string;
  } | null>(null);

  const loadBootstrap = useCallback(async () => {
    setLoadingInit(true);
    const [prodRes, modelRes] = await Promise.all([
      adminFetch<unknown>('/api/v1/admin/catalog/products'),
      adminFetch<unknown>('/api/v1/admin/lookbook/virtual-models'),
    ]);

    if (prodRes.ok) {
      const list = extractList<ProductSpuDto>(prodRes.data);
      setProducts(list);
      if (list.length > 0) {
        setSelectedProductId((prev) => {
          if (prev && list.some((p) => p.id === prev)) return prev;
          const first = list[0]!;
          setSelectedVariantId(first.variants[0]?.id ?? '');
          return first.id;
        });
      }
    }

    if (modelRes.ok) {
      const models = extractList<VirtualModelOption>(modelRes.data);
      if (models.length > 0) {
        setVirtualModels(models);
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

    const res = await adminFetch<LookbookSessionDTO>(
      `/api/v1/admin/catalog/products/${encodeURIComponent(selectedProduct.id)}/lookbooks`,
      {
        method: 'POST',
        body: JSON.stringify({
          variantId: selectedVariantId || undefined,
          virtualModelCode: selectedModelCode,
          scenePrompt: scenePrompt.trim(),
        }),
      },
    );

    if (res.ok && res.data) {
      setFeedback({
        kind: 'success',
        message: `Đã sinh ảnh Lookbook AI (${res.data.virtualModelCode}) thành công — sẵn sàng xem trước & gắn 1 chạm vào sản phẩm.`,
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

  const handleAttachLookbook = async (session: LookbookSessionDTO) => {
    if (!selectedProduct) return;
    setAttachingId(session.id);
    setFeedback(null);

    const res = await adminFetch<{
      productSlug?: string;
      attachedImageUrl?: string;
    }>(
      `/api/v1/admin/catalog/products/${encodeURIComponent(selectedProduct.id)}/lookbooks/${encodeURIComponent(session.id)}/attach`,
      { method: 'POST', body: JSON.stringify({}) },
    );

    if (res.ok) {
      setFeedback({
        kind: 'success',
        message: `Đã gắn ảnh Lookbook làm ảnh trưng bày chính cho "${selectedProduct.name}" — đã làm mới Storefront On-Demand ISR & Meilisearch!`,
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
    <div className="space-y-8">
      <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#B08A4A]/20 pb-5">
          <div>
            <p className="ledger-eyebrow text-[#8A672C]">
              AI Lookbook Studio · 5 Virtual Studio Models &amp; 1-Click Attach
            </p>
            <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Phòng Chụp Lookbook Ảo Bằng AI
            </h2>
            <p className="mt-1 text-xs text-[#7A6A5B]">
              Chọn sản phẩm có ảnh tách nền phẳng <code>3:4</code>, ghép lên 1
              trong 5 người mẫu chuẩn Tầm Xuân và gắn trực tiếp lên Storefront
              PDP sau khi kiểm duyệt thị giác.
            </p>
          </div>
          <button
            type="button"
            disabled={loadingInit}
            onClick={() => void loadBootstrap()}
            className="rounded-full border border-[#B08A4A]/40 bg-[#FBF7EF] px-4 py-2 text-xs text-[#1C1410]"
          >
            {loadingInit ? 'Đang tải...' : 'Làm mới danh mục'}
          </button>
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
                  <div className="mt-3 overflow-hidden rounded-xl border border-[#B08A4A]/25 bg-[#F8F4EC] p-3">
                    <img
                      src={flatPreviewUrl}
                      alt={`${selectedProduct.name} 3:4 flat-lay`}
                      className="mx-auto aspect-[3/4] max-h-56 object-contain"
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* Right Column: Pick 1 of 5 Virtual Studio Models + Scene Prompt */}
          <div className="space-y-4">
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[#8A672C]">
              2. Chọn Người mẫu Studio Ảo (5 mẫu chuẩn) &amp; Bối cảnh
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
              <label className="block text-xs">
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

              <div className="flex flex-wrap gap-1.5">
                {SCENE_PRESETS.map((preset, idx) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setScenePrompt(preset)}
                    className="rounded-full border border-[#B08A4A]/35 bg-white px-3 py-1 text-[10px] text-[#5C4B41] hover:border-[#1C1410]"
                  >
                    Gợi ý bối cảnh #{idx + 1}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              disabled={!selectedProduct || generating}
              onClick={() => void handleGenerateLookbook()}
              className="w-full rounded-full bg-[#1C1410] py-3 text-xs font-medium uppercase tracking-[0.18em] text-[#EBCF8F] transition-opacity hover:opacity-90 disabled:opacity-45"
            >
              {generating
                ? 'Đang dựng ảnh Lookbook AI...'
                : 'Sinh ảnh Lookbook AI'}
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
                      {isAttached ? 'ATTACHED · Đang trưng bày' : session.status}
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
                    </div>

                    <button
                      type="button"
                      disabled={attachingId === session.id || !session.resultUrl}
                      onClick={() => void handleAttachLookbook(session)}
                      className={`w-full rounded-full px-4 py-2 text-[11px] font-medium uppercase tracking-[0.14em] transition-colors disabled:opacity-50 ${
                        isAttached
                          ? 'border border-[#1E4B32] bg-[#F2FBF6] text-[#1E4B32]'
                          : 'bg-[#1C1410] text-[#EBCF8F] hover:opacity-90'
                      }`}
                    >
                      {attachingId === session.id
                        ? 'Đang gắn lên Storefront...'
                        : isAttached
                          ? 'Gắn lại làm ảnh chính'
                          : 'Gắn làm ảnh trưng bày sản phẩm'}
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
