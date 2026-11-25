'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent,
} from 'react';
import {
  MediaAssetType,
  type MediaAssetDto,
  type ProductSpuDto,
  type Role,
} from '@atelier/contracts';
import { adminFetch, type AdminStoredSession } from '@/lib/api-client';
import { emitPortalToast } from '../PortalToastBanner';

export interface MediaStudioNotifyPayload {
  kind: 'success' | 'error' | 'info';
  title?: string;
  message: string;
}

export interface MediaStudioTabProps {
  roles?: readonly Role[];
  session?: AdminStoredSession | null;
  mfaVerified?: boolean;
  darkMode?: boolean;
  onNotify?: (payload: MediaStudioNotifyPayload) => void;
  onRefreshOverview?: () => void;
}

type AttachSlotKey =
  | 'RACK_FRONT'
  | 'RACK_BACK'
  | 'TRYON_FLAT'
  | 'STUDIO_LAYER'
  | 'LOOKBOOK_MAIN';

interface PixelBoundingBoxView {
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  normalizedX: number | null;
  normalizedY: number | null;
  normalizedWidth: number | null;
  normalizedHeight: number | null;
  imageWidth: number | null;
  imageHeight: number | null;
  computedFromPixels: boolean;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const base64 = result.includes(',') ? (result.split(',')[1] ?? '') : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Không thể đọc tệp ảnh.'));
    reader.readAsDataURL(file);
  });
}

function getAssetPreviewUrl(asset: MediaAssetDto): string | null {
  if (asset.publicUrl) return asset.publicUrl;
  const variants = asset.variants ?? {};
  for (const key of ['720w', 'preview_url', '480w', 'flat_768x1024', '960w']) {
    const entry = variants[key];
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object' && 'url' in entry) {
      return entry.url;
    }
  }
  return null;
}

function parseBoundingBox(
  raw: Record<string, unknown> | null | undefined,
): PixelBoundingBoxView | null {
  if (!raw || typeof raw !== 'object') return null;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

  const x = num(raw.x);
  const y = num(raw.y);
  const width = num(raw.width);
  const height = num(raw.height);
  const normalizedX = num(raw.normalizedX);
  const normalizedY = num(raw.normalizedY);
  const normalizedWidth = num(raw.normalizedWidth);
  const normalizedHeight = num(raw.normalizedHeight);
  const imageWidth = num(raw.imageWidth);
  const imageHeight = num(raw.imageHeight);

  if (
    x === null &&
    y === null &&
    width === null &&
    height === null &&
    normalizedX === null &&
    normalizedY === null
  ) {
    return null;
  }

  return {
    x,
    y,
    width,
    height,
    normalizedX,
    normalizedY,
    normalizedWidth,
    normalizedHeight,
    imageWidth,
    imageHeight,
    computedFromPixels: Boolean(raw.computedFromPixels),
  };
}

function defaultSlotForAssetType(assetType: MediaAssetType): AttachSlotKey {
  if (assetType === MediaAssetType.RACK_CUTOUT_2_3) return 'RACK_FRONT';
  if (assetType === MediaAssetType.TRYON_FLAT_3_4) return 'TRYON_FLAT';
  if (assetType === MediaAssetType.STUDIO_LAYER_2_3) return 'STUDIO_LAYER';
  return 'LOOKBOOK_MAIN';
}

function extractList<T>(data: unknown, keys: string[]): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const rec = data as Record<string, unknown>;
    for (const k of keys) {
      if (Array.isArray(rec[k])) return rec[k] as T[];
    }
  }
  return [];
}

export function MediaStudioTab({
  darkMode = false,
  onNotify,
  onRefreshOverview,
}: MediaStudioTabProps) {
  const notify = useCallback(
    (payload: MediaStudioNotifyPayload) => {
      if (onNotify) onNotify(payload);
      else emitPortalToast(payload);
    },
    [onNotify],
  );

  const [assets, setAssets] = useState<MediaAssetDto[]>([]);
  const [products, setProducts] = useState<ProductSpuDto[]>([]);
  const [libraryFilter, setLibraryFilter] = useState<'RACK_ONLY' | 'ALL'>(
    'RACK_ONLY',
  );
  const [assetType, setAssetType] = useState<MediaAssetType>(
    MediaAssetType.RACK_CUTOUT_2_3,
  );
  const [uploading, setUploading] = useState(false);
  const [uploadFeedback, setUploadFeedback] = useState<{
    kind: 'success' | 'error';
    code?: string;
    message: string;
    isrConfirmed?: boolean;
  } | null>(null);

  // Interactive Visual Anchor Calibrator state
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [anchorX, setAnchorX] = useState(0.5);
  const [anchorY, setAnchorY] = useState(0.06);
  const [layerZHint, setLayerZHint] = useState(10);
  const [dragging, setDragging] = useState(false);
  const [draggingPreview, setDraggingPreview] = useState(false);
  const [savingAnchor, setSavingAnchor] = useState(false);
  const [swayPreviewEnabled, setSwayPreviewEnabled] = useState(true);
  const [swayAngleDeg, setSwayAngleDeg] = useState(0);
  const [showBboxOverlay, setShowBboxOverlay] = useState(true);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const brassPreviewRef = useRef<HTMLDivElement | null>(null);

  // Delete Asset state
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Quick 1-click Attach to SPU / Variant state
  const [attachProductId, setAttachProductId] = useState('');
  const [attachVariantId, setAttachVariantId] = useState('');
  const [attachSlot, setAttachSlot] = useState<AttachSlotKey>('RACK_FRONT');
  const [attaching, setAttaching] = useState(false);

  const selectedAsset = useMemo(
    () => assets.find((a) => a.id === selectedAssetId) ?? null,
    [assets, selectedAssetId],
  );

  const selectedBoundingBox = useMemo(
    () => parseBoundingBox(selectedAsset?.spatialMetadata?.boundingBoxJsonb),
    [selectedAsset],
  );

  const selectedAttachProduct = useMemo(
    () => products.find((p) => p.id === attachProductId) ?? null,
    [products, attachProductId],
  );

  const rackAssetsCount = useMemo(
    () =>
      assets.filter((a) => a.assetType === MediaAssetType.RACK_CUTOUT_2_3)
        .length,
    [assets],
  );

  const visibleAssets = useMemo(() => {
    if (libraryFilter === 'RACK_ONLY') {
      const rackList = assets.filter(
        (a) => a.assetType === MediaAssetType.RACK_CUTOUT_2_3,
      );
      return rackList.length > 0 ? rackList : assets;
    }
    return assets;
  }, [assets, libraryFilter]);

  const selectAssetForCalibration = useCallback((asset: MediaAssetDto) => {
    setSelectedAssetId(asset.id);
    setAnchorX(asset.spatialMetadata?.hangerAnchorX ?? 0.5);
    setAnchorY(asset.spatialMetadata?.hangerAnchorY ?? 0.06);
    setLayerZHint(asset.spatialMetadata?.layerZHint ?? 10);
    setAttachSlot(defaultSlotForAssetType(asset.assetType));
    setConfirmDeleteId(null);
  }, []);

  const loadAssets = useCallback(async () => {
    const [mediaRes, prodRes] = await Promise.all([
      adminFetch<MediaAssetDto[] | { items: MediaAssetDto[] }>(
        '/api/v1/admin/media?limit=100',
      ),
      adminFetch<unknown>('/api/v1/admin/products?limit=100'),
    ]);

    if (mediaRes.ok && mediaRes.data) {
      const list = Array.isArray(mediaRes.data)
        ? mediaRes.data
        : (mediaRes.data.items ?? []);
      setAssets(list);
      setSelectedAssetId((currentId) => {
        if (currentId && list.some((a) => a.id === currentId)) {
          return currentId;
        }
        const firstRack =
          list.find((a) => a.assetType === MediaAssetType.RACK_CUTOUT_2_3) ??
          list[0];
        if (firstRack) {
          setAnchorX(firstRack.spatialMetadata?.hangerAnchorX ?? 0.5);
          setAnchorY(firstRack.spatialMetadata?.hangerAnchorY ?? 0.06);
          setLayerZHint(firstRack.spatialMetadata?.layerZHint ?? 10);
          setAttachSlot(defaultSlotForAssetType(firstRack.assetType));
          return firstRack.id;
        }
        return null;
      });
    }

    if (prodRes.ok) {
      const prodList = extractList<ProductSpuDto>(prodRes.data, [
        'items',
        'products',
        'list',
      ]);
      setProducts(prodList);
      setAttachProductId((cur) => {
        if (cur && prodList.some((p) => p.id === cur)) return cur;
        return prodList[0]?.id ?? '';
      });
    }
  }, []);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  // Keep variant dropdown synced when selected SPU changes
  useEffect(() => {
    const variants = selectedAttachProduct?.variants ?? [];
    if (variants.length === 0) {
      setAttachVariantId('');
    } else if (!variants.some((v) => v.id === attachVariantId)) {
      setAttachVariantId(variants[0]?.id ?? '');
    }
  }, [selectedAttachProduct, attachVariantId]);

  // Subtle pendulum sway preview around exact calibrated (anchorX, anchorY) pivot
  useEffect(() => {
    if (!swayPreviewEnabled) {
      setSwayAngleDeg(0);
      return;
    }
    let rafId = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const elapsedSec = (now - start) / 1000;
      setSwayAngleDeg(Math.sin(elapsedSec * 1.45) * 2.2);
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [swayPreviewEnabled]);

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setUploadFeedback(null);

    try {
      const fileBase64 = await fileToBase64(file);
      const res = await adminFetch<MediaAssetDto>('/api/v1/admin/media/upload', {
        method: 'POST',
        body: JSON.stringify({
          assetType,
          fileName: file.name,
          mimeType: file.type || 'image/png',
          fileBase64,
        }),
      });

      if (res.ok && res.data) {
        setUploadFeedback({
          kind: 'success',
          message: `Đã chuẩn hóa thành công (${res.data.assetType}) · ${res.data.width ?? '?'}×${res.data.height ?? '?'} · Alpha: ${res.data.hasAlpha ? 'Có' : 'Không'} · Màu chủ đạo: ${res.data.dominantHex ?? '—'}`,
        });
        selectAssetForCalibration(res.data);
        await loadAssets();
        onRefreshOverview?.();
      } else {
        setUploadFeedback({
          kind: 'error',
          code: res.error?.code,
          message:
            res.error?.message ||
            'Ảnh không đạt quy chuẩn kiểm định (Magic Bytes / Tỷ lệ 2:3 Alpha / 3:4 Flat-Lay).',
        });
      }
    } catch (err) {
      setUploadFeedback({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Lỗi tải tệp lên.',
      });
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  };

  const updateCrosshairFromPointer = (
    event: PointerEvent<HTMLDivElement>,
    targetEl: HTMLDivElement | null = stageRef.current,
  ) => {
    const rect = targetEl?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const nx = Math.min(
      1,
      Math.max(0, (event.clientX - rect.left) / rect.width),
    );
    const ny = Math.min(
      1,
      Math.max(0, (event.clientY - rect.top) / rect.height),
    );
    setAnchorX(Number(nx.toFixed(4)));
    setAnchorY(Number(ny.toFixed(4)));
  };

  const handleSaveSpatialMetadata = async () => {
    if (!selectedAsset) return;
    setSavingAnchor(true);
    setUploadFeedback(null);

    const existingBbox = selectedAsset.spatialMetadata?.boundingBoxJsonb ?? null;

    const res = await adminFetch<unknown>(
      `/api/v1/admin/media/${encodeURIComponent(selectedAsset.id)}/spatial-metadata`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          hangerAnchorX: anchorX,
          hangerAnchorY: anchorY,
          layerZHint,
          ...(existingBbox ? { boundingBoxJsonb: existingBbox } : {}),
        }),
      },
    );

    if (res.ok) {
      const msg = `Đã đồng bộ spatial-metadata (x=${anchorX.toFixed(4)}, y=${anchorY.toFixed(4)}, z=${layerZHint}) lên catalog-lookbook:4002 · Xóa Redis storefront:rack:v1 & storefront:bootstrap:v1 · Kích hoạt /api/revalidate cho <ClothingRack3D />`;
      setUploadFeedback({
        kind: 'success',
        isrConfirmed: true,
        message: msg,
      });
      notify({ kind: 'success', title: 'ANCHOR 3D SYNCED', message: msg });
      await loadAssets();
    } else {
      setUploadFeedback({
        kind: 'error',
        code: res.error?.code,
        message: res.error?.message || 'Lưu spatial-metadata thất bại.',
      });
    }
    setSavingAnchor(false);
  };

  const handleDeleteAsset = async (asset: MediaAssetDto) => {
    setDeletingId(asset.id);
    const res = await adminFetch<unknown>(
      `/api/v1/admin/media/${encodeURIComponent(asset.id)}`,
      { method: 'DELETE' },
    );
    setDeletingId(null);
    setConfirmDeleteId(null);

    if (res.ok) {
      const msg = `Đã xóa asset ${asset.originalKey} khỏi thư viện Media Pipeline.`;
      setUploadFeedback({ kind: 'success', message: msg });
      notify({ kind: 'success', title: 'XÓA ASSET MEDIA', message: msg });
      if (selectedAssetId === asset.id) {
        setSelectedAssetId(null);
      }
      await loadAssets();
      onRefreshOverview?.();
    } else {
      const msg = res.error?.message || 'Không thể xóa asset Media này.';
      setUploadFeedback({
        kind: 'error',
        code: res.error?.code,
        message: msg,
      });
      notify({ kind: 'error', title: 'XÓA THẤT BẠI', message: msg });
    }
  };

  const handleAttachToProduct = async () => {
    if (!selectedAsset || !attachProductId) return;
    const url = getAssetPreviewUrl(selectedAsset);
    setAttaching(true);
    const res = await adminFetch<unknown>(
      `/api/v1/admin/media/${encodeURIComponent(selectedAsset.id)}/attach`,
      {
        method: 'POST',
        body: JSON.stringify({
          productId: attachProductId,
          variantId: attachVariantId || null,
          assetId: selectedAsset.id,
          url: url ?? undefined,
          slot: attachSlot,
        }),
      },
    );
    setAttaching(false);

    if (res.ok) {
      const prodName = selectedAttachProduct?.name ?? attachProductId;
      const msg = `Đã gắn nhanh asset ${selectedAsset.originalKey} vào "${prodName}" (${attachSlot}) và xóa cache Storefront.`;
      setUploadFeedback({ kind: 'success', isrConfirmed: true, message: msg });
      notify({ kind: 'success', title: 'GẮN MEDIA THÀNH CÔNG', message: msg });
      onRefreshOverview?.();
    } else {
      const msg =
        res.error?.message || 'Không thể gắn asset vào SPU / Variant.';
      setUploadFeedback({
        kind: 'error',
        code: res.error?.code,
        message: msg,
      });
      notify({ kind: 'error', title: 'GẮN MEDIA THẤT BẠI', message: msg });
    }
  };

  const previewUrl = selectedAsset ? getAssetPreviewUrl(selectedAsset) : null;

  // Theme tokens
  const cardCls = darkMode
    ? 'border-[#B08A4A]/30 bg-[#1A130E] text-[#FBF7EF]'
    : 'border-[#B08A4A]/30 bg-white text-[#1C1410]';
  const subCardCls = darkMode
    ? 'border-[#B08A4A]/25 bg-[#231912] text-[#FBF7EF]'
    : 'border-[#B08A4A]/25 bg-[#FBF7EF] text-[#1C1410]';
  const mutedCls = darkMode ? 'text-[#B4A391]' : 'text-[#7A6A5B]';
  const goldTextCls = darkMode ? 'text-[#EBCF8F]' : 'text-[#8A672C]';
  const inputCls = darkMode
    ? 'border-[#B08A4A]/35 bg-[#140E0A] text-[#FBF7EF] focus:border-[#EBCF8F]'
    : 'border-[#B08A4A]/35 bg-white text-[#1C1410] focus:border-[#1C1410]';

  return (
    <div data-testid="media-studio-tab" className="space-y-8">
      {/* Dual Upload Pipeline Panel */}
      <section className={`rounded-3xl border p-6 ${cardCls}`}>
        <p className={`ledger-eyebrow ${goldTextCls}`}>
          Dual Media Studio · Kiểm định Magic Bytes + Pixel BoundingBox + Sharp Pipeline
        </p>
        <h2 className="font-editorial mt-1 text-3xl">
          Tải lên &amp; Chuẩn hóa ảnh 2:3 Alpha / 3:4 Flat-Lay
        </h2>
        <p className={`mt-1 text-xs ${mutedCls}`}>
          Hệ thống kiểm tra Magic Bytes thực của tệp (từ chối{' '}
          <code>400 INVALID_MAGIC_BYTES</code> nếu giả mạo đuôi), tự động quét
          pixel thực tính <code>boundingBoxJsonb</code>, kiểm tra tỷ lệ 2:3 + nền
          trong suốt Alpha hoặc căn giữa <code>768×1024</code> cho{' '}
          <code>TRYON_FLAT_3_4</code>.
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <select
            value={assetType}
            onChange={(e) => setAssetType(e.target.value as MediaAssetType)}
            aria-label="Chọn chuẩn ảnh đầu ra"
            className={`rounded-full border px-4 py-2 text-xs font-medium ${inputCls}`}
          >
            <option value={MediaAssetType.RACK_CUTOUT_2_3}>
              RACK_CUTOUT_2_3 (720×1080 WebP Alpha · 3D Rack)
            </option>
            <option value={MediaAssetType.TRYON_FLAT_3_4}>
              TRYON_FLAT_3_4 (768×1024 Flat-Lay · AI Try-On)
            </option>
            <option value={MediaAssetType.STUDIO_LAYER_2_3}>
              STUDIO_LAYER_2_3 (Lớp Mix &amp; Match 2:3 Alpha)
            </option>
            <option value={MediaAssetType.LOOKBOOK_PHOTO}>
              LOOKBOOK_PHOTO (960w / 1600w Editorial)
            </option>
          </select>

          <label
            className={`cursor-pointer rounded-full px-5 py-2 text-xs uppercase tracking-[0.16em] hover:opacity-90 ${
              darkMode
                ? 'bg-[#EBCF8F] text-[#1C1410] font-semibold'
                : 'bg-[#1C1410] text-[#EBCF8F]'
            }`}
          >
            {uploading ? 'Đang kiểm định & xử lý...' : 'Chọn tệp ảnh để tải lên'}
            <input
              type="file"
              accept="image/*,.jpg,.png,.webp"
              disabled={uploading}
              onChange={(e) => void handleFileChange(e)}
              className="hidden"
            />
          </label>
        </div>

        {uploadFeedback ? (
          <div
            role="status"
            className={`mt-4 rounded-2xl border px-4 py-3 text-xs ${
              uploadFeedback.kind === 'success'
                ? darkMode
                  ? 'border-emerald-500/45 bg-emerald-950/50 text-emerald-200'
                  : 'border-[#2E6B47]/35 bg-[#F2FBF6] text-[#1E4B32]'
                : darkMode
                  ? 'border-rose-500/45 bg-rose-950/50 text-rose-200'
                  : 'border-[#8B2E2E]/35 bg-[#FFF5F4] text-[#8B2E2E]'
            }`}
          >
            {uploadFeedback.isrConfirmed ? (
              <span className="mr-2 inline-flex items-center rounded-full bg-[#1E4B32] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-white">
                Redis + On-Demand ISR OK
              </span>
            ) : null}
            {uploadFeedback.code ? (
              <strong className="mr-2 font-mono">[{uploadFeedback.code}]</strong>
            ) : null}
            {uploadFeedback.message}
          </div>
        ) : null}
      </section>

      {/* Interactive Visual Anchor Calibrator + Live Brass Rack Hanger Preview */}
      <section
        data-testid="visual-anchor-calibrator"
        className={`rounded-3xl border p-6 ${cardCls}`}
      >
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#B08A4A]/20 pb-5">
          <div>
            <p className={`ledger-eyebrow ${goldTextCls}`}>
              Visual Anchor Calibrator (2:3) · Đồng bộ Sào Treo 3D &amp; Pixel BoundingBox
            </p>
            <h3 className="font-editorial mt-1 text-3xl">
              Hiệu chỉnh tâm móc treo, Tọa độ BoundingBox &amp; Gắn nhanh SPU
            </h3>
            <p className={`mt-1 text-xs ${mutedCls}`}>
              Kéo thả tâm đồng thau bên trái để định vị{' '}
              <code>(hangerAnchorX, hangerAnchorY)</code>, kiểm tra vùng pixel{' '}
              <code>boundingBoxJsonb</code> và gắn trực tiếp vào SPU / Variant.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowBboxOverlay((prev) => !prev)}
              className={`rounded-full border px-3.5 py-1.5 text-xs transition-colors ${
                showBboxOverlay
                  ? 'border-[#B08A4A] bg-[#B08A4A]/18 text-[#8A672C] dark:text-[#EBCF8F]'
                  : 'border-[#B08A4A]/35'
              }`}
            >
              {showBboxOverlay ? 'Đang hiện khung BBox' : 'Hiện khung BBox'}
            </button>

            <button
              type="button"
              onClick={() => setSwayPreviewEnabled((prev) => !prev)}
              className={`rounded-full border px-4 py-1.5 text-xs transition-colors ${
                swayPreviewEnabled
                  ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                  : 'border-[#B08A4A]/40'
              }`}
            >
              {swayPreviewEnabled
                ? 'Đang bật mô phỏng đung đưa'
                : 'Bật mô phỏng đung đưa'}
            </button>
          </div>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-[290px_290px_1fr]">
          {/* Column 1: Interactive 2:3 Crosshair Calibration Stage */}
          <div>
            <p className={`text-[11px] font-medium uppercase tracking-[0.16em] ${goldTextCls}`}>
              1. Khung căn chỉnh tâm (Kéo thả)
            </p>

            <div
              ref={stageRef}
              data-testid="visual-anchor-stage"
              tabIndex={0}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 0.02 : 0.005;
                if (e.key === 'ArrowLeft') {
                  e.preventDefault();
                  setAnchorX((x) => Number(Math.max(0, x - step).toFixed(4)));
                } else if (e.key === 'ArrowRight') {
                  e.preventDefault();
                  setAnchorX((x) => Number(Math.min(1, x + step).toFixed(4)));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setAnchorY((y) => Number(Math.max(0, y - step).toFixed(4)));
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setAnchorY((y) => Number(Math.min(1, y + step).toFixed(4)));
                }
              }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                setDragging(true);
                updateCrosshairFromPointer(e, stageRef.current);
              }}
              onPointerMove={(e) => {
                if (!dragging) return;
                updateCrosshairFromPointer(e, stageRef.current);
              }}
              onPointerUp={(e) => {
                e.currentTarget.releasePointerCapture(e.pointerId);
                setDragging(false);
              }}
              className="relative mt-3 aspect-[2/3] w-full cursor-crosshair select-none overflow-hidden rounded-2xl border border-[#B08A4A]/45 bg-[#1C1410] focus:outline-none focus:ring-2 focus:ring-[#EBCF8F]"
              style={{
                backgroundImage:
                  'radial-gradient(rgba(235,207,143,0.16) 1px, transparent 1px)',
                backgroundSize: '18px 18px',
              }}
            >
              <div
                className="pointer-events-none absolute right-0 left-0 top-[6%] z-10 h-1 opacity-75"
                style={{
                  background:
                    'linear-gradient(180deg, #F8E5B8 0%, #C59B56 60%, #735420 100%)',
                }}
              />
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt="Garment cutout calibration canvas"
                  draggable={false}
                  className="pointer-events-none h-full w-full object-contain"
                />
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-center text-xs text-[#EBCF8F]/70">
                  Chọn hoặc tải lên 1 ảnh 2:3 để căn chỉnh tọa độ móc treo
                </div>
              )}

              {/* Pixel-Computed BoundingBox Visual Overlay */}
              {showBboxOverlay &&
              selectedBoundingBox &&
              selectedBoundingBox.normalizedX !== null &&
              selectedBoundingBox.normalizedY !== null &&
              selectedBoundingBox.normalizedWidth !== null &&
              selectedBoundingBox.normalizedHeight !== null ? (
                <div
                  data-testid="media-bbox-overlay"
                  className="pointer-events-none absolute z-10 rounded-sm border border-dashed border-emerald-400/90 bg-emerald-400/10"
                  style={{
                    left: `${selectedBoundingBox.normalizedX * 100}%`,
                    top: `${selectedBoundingBox.normalizedY * 100}%`,
                    width: `${selectedBoundingBox.normalizedWidth * 100}%`,
                    height: `${selectedBoundingBox.normalizedHeight * 100}%`,
                  }}
                />
              ) : null}

              {/* Brass Crosshair Overlay */}
              <div
                className="pointer-events-none absolute top-0 bottom-0 w-px bg-[#EBCF8F]/75"
                style={{ left: `${anchorX * 100}%` }}
              />
              <div
                className="pointer-events-none absolute right-0 left-0 h-px bg-[#EBCF8F]/75"
                style={{ top: `${anchorY * 100}%` }}
              />
              <div
                className="pointer-events-none absolute -ml-3 -mt-3 flex h-6 w-6 items-center justify-center rounded-full border-2 border-[#EBCF8F] bg-[#1C1410]/85 text-[10px] text-[#EBCF8F] shadow"
                style={{ left: `${anchorX * 100}%`, top: `${anchorY * 100}%` }}
              >
                +
              </div>
            </div>
          </div>

          {/* Column 2: Live 2:3 Brass Rack Hanger Preview */}
          <div>
            <p className={`text-[11px] font-medium uppercase tracking-[0.16em] ${goldTextCls}`}>
              2. Xem trước trên Sào Treo Đồng Thau
            </p>

            <div
              ref={brassPreviewRef}
              data-testid="visual-anchor-brass-preview"
              aria-label="Xem trước trang phục treo trên sào đồng thau 2:3"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                setDraggingPreview(true);
                updateCrosshairFromPointer(e, brassPreviewRef.current);
              }}
              onPointerMove={(e) => {
                if (!draggingPreview) return;
                updateCrosshairFromPointer(e, brassPreviewRef.current);
              }}
              onPointerUp={(e) => {
                e.currentTarget.releasePointerCapture(e.pointerId);
                setDraggingPreview(false);
              }}
              className="relative mt-3 aspect-[2/3] w-full cursor-grab select-none overflow-hidden rounded-2xl border border-[#B08A4A]/45 bg-[#1C1410] active:cursor-grabbing"
              style={{
                backgroundImage:
                  'radial-gradient(circle at 50% 24%, rgba(235,207,143,0.22), rgba(28,20,16,0.96) 68%)',
              }}
            >
              <div
                className="pointer-events-none absolute right-0 left-0 top-[7%] z-20 h-2.5 shadow-[0_3px_12px_rgba(0,0,0,0.55)]"
                style={{
                  background:
                    'linear-gradient(180deg, #F8E5B8 0%, #C59B56 48%, #735420 100%)',
                }}
              />
              <svg
                viewBox="0 0 120 70"
                aria-hidden="true"
                className="pointer-events-none absolute left-1/2 top-[4.5%] z-20 h-14 w-24 -translate-x-1/2"
              >
                <ellipse
                  cx="60"
                  cy="14"
                  rx="7"
                  ry="9"
                  fill="none"
                  stroke="#EBCF8F"
                  strokeWidth="3.2"
                />
                <path
                  d="M 60 22 L 60 39 C 60 44, 65 47, 65 51 C 65 56, 55 56, 55 51"
                  fill="none"
                  stroke="#EBCF8F"
                  strokeWidth="2.8"
                  strokeLinecap="round"
                />
                <path
                  d="M 60 46 L 26 62 M 60 46 L 94 62"
                  fill="none"
                  stroke="#B08A4A"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                />
                <circle cx="60" cy="49" r="3" fill="#F8E5B8" />
              </svg>

              {previewUrl ? (
                <div
                  className="pointer-events-none absolute left-1/2 top-[17.5%] z-10 aspect-[2/3] w-[76%]"
                  style={{
                    transformOrigin: `${anchorX * 100}% ${anchorY * 100}%`,
                    transform: `translate(${-anchorX * 100}%, ${-anchorY * 100}%) rotate(${swayAngleDeg.toFixed(2)}deg)`,
                  }}
                >
                  <img
                    src={previewUrl}
                    alt="Xem trước móc treo sào đồng thau"
                    draggable={false}
                    className="h-full w-full object-contain drop-shadow-[0_14px_24px_rgba(0,0,0,0.65)]"
                  />
                </div>
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-center text-xs text-[#EBCF8F]/65">
                  Chọn ảnh 2:3 để xem mô phỏng treo thực tế trên thanh đồng thau
                </div>
              )}

              <div className="pointer-events-none absolute right-2.5 bottom-2.5 left-2.5 z-30 flex items-center justify-between rounded-xl border border-[#EBCF8F]/25 bg-[#1C1410]/80 px-3 py-1.5 font-mono text-[10px] text-[#EBCF8F] backdrop-blur-sm">
                <span>X: {anchorX.toFixed(3)}</span>
                <span>Y: {anchorY.toFixed(3)}</span>
                <span>Z: {layerZHint}</span>
              </div>
            </div>
          </div>

          {/* Column 3: Controls, Pixel BoundingBox Telemetry, Quick Attach & Asset Library */}
          <div className="flex flex-col justify-between space-y-5">
            <div className="space-y-4">
              {/* Anchor Inputs */}
              <div className="grid gap-3 sm:grid-cols-3">
                <label className={`rounded-2xl border p-3.5 ${subCardCls}`}>
                  <span className={`block text-[10px] uppercase tracking-[0.16em] ${goldTextCls}`}>
                    hangerAnchorX
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={anchorX}
                    onChange={(e) =>
                      setAnchorX(
                        Math.min(1, Math.max(0, Number(e.target.value) || 0)),
                      )
                    }
                    className={`mt-1 w-full rounded-lg border px-2 py-1 font-mono text-sm font-semibold outline-none ${inputCls}`}
                  />
                </label>

                <label className={`rounded-2xl border p-3.5 ${subCardCls}`}>
                  <span className={`block text-[10px] uppercase tracking-[0.16em] ${goldTextCls}`}>
                    hangerAnchorY
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={anchorY}
                    onChange={(e) =>
                      setAnchorY(
                        Math.min(1, Math.max(0, Number(e.target.value) || 0)),
                      )
                    }
                    className={`mt-1 w-full rounded-lg border px-2 py-1 font-mono text-sm font-semibold outline-none ${inputCls}`}
                  />
                </label>

                <label className={`rounded-2xl border p-3.5 ${subCardCls}`}>
                  <span className={`block text-[10px] uppercase tracking-[0.16em] ${goldTextCls}`}>
                    layerZHint
                  </span>
                  <input
                    type="number"
                    value={layerZHint}
                    onChange={(e) => setLayerZHint(Number(e.target.value))}
                    className={`mt-1 w-full rounded-lg border px-2 py-1 font-mono text-sm font-semibold outline-none ${inputCls}`}
                  />
                </label>
              </div>

              {/* Save Anchor + Delete Selected Asset */}
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  data-testid="visual-anchor-save-btn"
                  disabled={!selectedAsset || savingAnchor}
                  onClick={() => void handleSaveSpatialMetadata()}
                  className={`rounded-full px-5 py-2.5 text-xs font-medium uppercase tracking-[0.14em] transition-opacity hover:opacity-90 disabled:opacity-40 ${
                    darkMode
                      ? 'bg-[#EBCF8F] text-[#1C1410] font-semibold'
                      : 'bg-[#1C1410] text-[#EBCF8F]'
                  }`}
                >
                  {savingAnchor
                    ? 'Đang lưu & làm mới ISR...'
                    : 'Lưu tọa độ neo & Làm mới Storefront'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAnchorX(0.5);
                    setAnchorY(0.06);
                    setLayerZHint(10);
                  }}
                  className="rounded-full border border-[#B08A4A]/40 px-3.5 py-2.5 text-xs"
                >
                  Chuẩn (0.50, 0.06)
                </button>

                {selectedAsset ? (
                  confirmDeleteId === selectedAsset.id ? (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        data-testid="media-delete-confirm-btn"
                        disabled={deletingId === selectedAsset.id}
                        onClick={() => void handleDeleteAsset(selectedAsset)}
                        className="rounded-full bg-[#8B2E2E] px-3.5 py-2 text-xs font-semibold text-white"
                      >
                        {deletingId === selectedAsset.id
                          ? 'Đang xóa...'
                          : 'Xác nhận xóa Asset'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="rounded-full border border-[#B08A4A]/40 px-3 py-2 text-xs"
                      >
                        Hủy
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      data-testid="media-delete-asset-btn"
                      onClick={() => setConfirmDeleteId(selectedAsset.id)}
                      className="rounded-full border border-[#8B2E2E]/50 px-3.5 py-2.5 text-xs text-[#8B2E2E] hover:bg-[#8B2E2E]/10 dark:text-rose-300"
                    >
                      Xóa Asset
                    </button>
                  )
                ) : null}
              </div>

              {/* Pixel-Computed BoundingBox Telemetry Panel */}
              <div
                data-testid="media-bbox-telemetry"
                className={`rounded-2xl border p-3.5 text-xs ${subCardCls}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className={`font-mono text-[10px] font-semibold uppercase tracking-[0.14em] ${goldTextCls}`}>
                    Pixel-Computed boundingBoxJsonb
                  </p>
                  {selectedBoundingBox ? (
                    <span
                      className={`rounded-full px-2 py-0.5 font-mono text-[9.5px] font-semibold ${
                        selectedBoundingBox.computedFromPixels
                          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                          : 'bg-amber-500/15 text-amber-800 dark:text-amber-300'
                      }`}
                    >
                      {selectedBoundingBox.computedFromPixels
                        ? 'COMPUTED FROM PIXELS'
                        : 'METADATA'}
                    </span>
                  ) : null}
                </div>

                {selectedBoundingBox ? (
                  <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[11px] sm:grid-cols-4">
                    <div>
                      <span className={`block text-[9.5px] ${mutedCls}`}>
                        Pixel (x, y)
                      </span>
                      <strong>
                        {selectedBoundingBox.x ?? '—'}, {selectedBoundingBox.y ?? '—'}
                      </strong>
                    </div>
                    <div>
                      <span className={`block text-[9.5px] ${mutedCls}`}>
                        Size (w × h)
                      </span>
                      <strong>
                        {selectedBoundingBox.width ?? '—'} ×{' '}
                        {selectedBoundingBox.height ?? '—'} px
                      </strong>
                    </div>
                    <div>
                      <span className={`block text-[9.5px] ${mutedCls}`}>
                        Norm (x, y)
                      </span>
                      <strong>
                        {selectedBoundingBox.normalizedX !== null
                          ? selectedBoundingBox.normalizedX.toFixed(3)
                          : '—'}
                        ,{' '}
                        {selectedBoundingBox.normalizedY !== null
                          ? selectedBoundingBox.normalizedY.toFixed(3)
                          : '—'}
                      </strong>
                    </div>
                    <div>
                      <span className={`block text-[9.5px] ${mutedCls}`}>
                        Norm (w × h)
                      </span>
                      <strong>
                        {selectedBoundingBox.normalizedWidth !== null
                          ? selectedBoundingBox.normalizedWidth.toFixed(3)
                          : '—'}{' '}
                        ×{' '}
                        {selectedBoundingBox.normalizedHeight !== null
                          ? selectedBoundingBox.normalizedHeight.toFixed(3)
                          : '—'}
                      </strong>
                    </div>
                  </div>
                ) : (
                  <p className={`mt-1.5 text-[11px] ${mutedCls}`}>
                    Chưa có tọa độ <code>boundingBoxJsonb</code> cho asset này
                    (tải ảnh mới qua Sharp Pipeline để tự động tính từ pixel thực).
                  </p>
                )}
              </div>

              {/* 1-Click Quick Attach to SPU / Variant */}
              <div
                data-testid="media-quick-attach-panel"
                className={`rounded-2xl border p-3.5 text-xs ${subCardCls}`}
              >
                <p className={`font-mono text-[10px] font-semibold uppercase tracking-[0.14em] ${goldTextCls}`}>
                  Gắn nhanh vào SPU / Variant · POST /api/v1/admin/media/:assetId/attach
                </p>
                <div className="mt-2.5 grid gap-2 sm:grid-cols-3">
                  <select
                    value={attachProductId}
                    onChange={(e) => setAttachProductId(e.target.value)}
                    aria-label="Chọn SPU cần gắn ảnh"
                    className={`rounded-xl border px-2.5 py-1.5 text-xs outline-none ${inputCls}`}
                  >
                    {products.length === 0 ? (
                      <option value="">Đang tải SPU...</option>
                    ) : (
                      products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))
                    )}
                  </select>

                  <select
                    value={attachVariantId}
                    onChange={(e) => setAttachVariantId(e.target.value)}
                    aria-label="Chọn Variant màu sắc"
                    className={`rounded-xl border px-2.5 py-1.5 text-xs outline-none ${inputCls}`}
                  >
                    <option value="">Toàn bộ SPU / Mặc định</option>
                    {(selectedAttachProduct?.variants ?? []).map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.colorName} ({v.colorHex})
                      </option>
                    ))}
                  </select>

                  <select
                    value={attachSlot}
                    onChange={(e) =>
                      setAttachSlot(e.target.value as AttachSlotKey)
                    }
                    aria-label="Chọn vị trí hiển thị ảnh"
                    className={`rounded-xl border px-2.5 py-1.5 font-mono text-[11px] outline-none ${inputCls}`}
                  >
                    <option value="RACK_FRONT">RACK_FRONT (Sào 3D trước)</option>
                    <option value="RACK_BACK">RACK_BACK (Sào 3D sau)</option>
                    <option value="TRYON_FLAT">TRYON_FLAT (Ảnh thử đồ AI)</option>
                    <option value="STUDIO_LAYER">STUDIO_LAYER (Mix &amp; Match)</option>
                    <option value="LOOKBOOK_MAIN">LOOKBOOK_MAIN (Ảnh chính PDP)</option>
                  </select>
                </div>

                <div className="mt-2.5 flex items-center justify-between gap-2">
                  <span className={`truncate font-mono text-[10px] ${mutedCls}`}>
                    {selectedAsset
                      ? `Asset: ${selectedAsset.originalKey}`
                      : 'Chưa chọn asset'}
                  </span>
                  <button
                    type="button"
                    data-testid="media-quick-attach-btn"
                    disabled={!selectedAsset || !attachProductId || attaching}
                    onClick={() => void handleAttachToProduct()}
                    className={`shrink-0 rounded-full px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] disabled:opacity-45 ${
                      darkMode
                        ? 'bg-[#EBCF8F] text-[#1C1410]'
                        : 'bg-[#1C1410] text-[#EBCF8F]'
                    }`}
                  >
                    {attaching ? 'Đang gắn...' : 'Gắn nhanh vào SPU / Variant'}
                  </button>
                </div>
              </div>
            </div>

            {/* Asset Library Picker with RACK_CUTOUT_2_3 Filter */}
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className={`ledger-eyebrow ${goldTextCls}`}>
                  Thư viện Media ({visibleAssets.length} / {assets.length})
                </p>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setLibraryFilter('RACK_ONLY')}
                    className={`rounded-full px-3 py-1 text-[11px] transition-colors ${
                      libraryFilter === 'RACK_ONLY'
                        ? 'bg-[#1C1410] text-[#EBCF8F]'
                        : 'border border-[#B08A4A]/35'
                    }`}
                  >
                    RACK_CUTOUT_2_3 ({rackAssetsCount})
                  </button>
                  <button
                    type="button"
                    onClick={() => setLibraryFilter('ALL')}
                    className={`rounded-full px-3 py-1 text-[11px] transition-colors ${
                      libraryFilter === 'ALL'
                        ? 'bg-[#1C1410] text-[#EBCF8F]'
                        : 'border border-[#B08A4A]/35'
                    }`}
                  >
                    Tất cả ({assets.length})
                  </button>
                </div>
              </div>

              <div className="mt-3 grid max-h-60 gap-2 overflow-y-auto sm:grid-cols-2">
                {visibleAssets.map((asset) => {
                  const active = selectedAsset?.id === asset.id;
                  const thumbUrl = getAssetPreviewUrl(asset);
                  return (
                    <button
                      key={asset.id}
                      type="button"
                      onClick={() => selectAssetForCalibration(asset)}
                      className={`flex items-center gap-2.5 rounded-2xl border p-2.5 text-left text-xs transition-colors ${
                        active
                          ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                          : `${subCardCls} hover:border-[#8A672C]`
                      }`}
                    >
                      {thumbUrl ? (
                        <img
                          src={thumbUrl}
                          alt={asset.originalKey}
                          className="h-12 w-8 shrink-0 rounded-lg bg-[#1C1410]/85 object-contain p-0.5"
                        />
                      ) : (
                        <div className="h-12 w-8 shrink-0 rounded-lg bg-[#1C1410]/15" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-1 font-mono text-[10px]">
                          <span className="truncate">{asset.assetType}</span>
                          <span>
                            (
                            {(
                              asset.spatialMetadata?.hangerAnchorX ?? 0.5
                            ).toFixed(2)}
                            ,{' '}
                            {(
                              asset.spatialMetadata?.hangerAnchorY ?? 0.06
                            ).toFixed(2)}
                            )
                          </span>
                        </div>
                        <p className="mt-0.5 truncate font-mono text-[11px] opacity-80">
                          {asset.originalKey}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
