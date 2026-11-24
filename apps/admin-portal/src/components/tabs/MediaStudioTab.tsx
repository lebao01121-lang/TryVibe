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
import { MediaAssetType, type MediaAssetDto } from '@atelier/contracts';
import { adminFetch } from '@/lib/api-client';

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

export function MediaStudioTab() {
  const [assets, setAssets] = useState<MediaAssetDto[]>([]);
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
  const [savingAnchor, setSavingAnchor] = useState(false);
  const [swayPreviewEnabled, setSwayPreviewEnabled] = useState(true);
  const [swayAngleDeg, setSwayAngleDeg] = useState(0);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const selectedAsset = useMemo(
    () => assets.find((a) => a.id === selectedAssetId) ?? null,
    [assets, selectedAssetId],
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
  }, []);

  const loadAssets = useCallback(async () => {
    const res = await adminFetch<MediaAssetDto[] | { items: MediaAssetDto[] }>(
      '/api/v1/admin/media',
    );
    if (res.ok && res.data) {
      const list = Array.isArray(res.data)
        ? res.data
        : (res.data.items ?? []);
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
          return firstRack.id;
        }
        return null;
      });
    }
  }, []);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

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

  const updateCrosshairFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = stageRef.current?.getBoundingClientRect();
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

    const res = await adminFetch<unknown>(
      `/api/v1/admin/media/${encodeURIComponent(selectedAsset.id)}/spatial-metadata`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          hangerAnchorX: anchorX,
          hangerAnchorY: anchorY,
          layerZHint,
          boundingBoxJsonb: {
            shoulderY: 0.14,
            waistY: 0.44,
            hipY: 0.6,
            hemY: 0.9,
          },
        }),
      },
    );

    if (res.ok) {
      setUploadFeedback({
        kind: 'success',
        isrConfirmed: true,
        message: `Đã lưu tọa độ neo (x=${anchorX.toFixed(4)}, y=${anchorY.toFixed(4)}, z=${layerZHint}) cho asset ${selectedAsset.id.slice(0, 12)}... · Đã xóa Redis Cache & kích hoạt On-Demand ISR`,
      });
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

  const previewUrl = selectedAsset ? getAssetPreviewUrl(selectedAsset) : null;

  return (
    <div className="space-y-8">
      {/* Dual Upload Pipeline Panel */}
      <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
        <p className="ledger-eyebrow text-[#8A672C]">
          Dual Media Studio · Kiểm định Magic Bytes + Sharp Pipeline
        </p>
        <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
          Tải lên &amp; Chuẩn hóa ảnh 2:3 Alpha / 3:4 Flat-Lay
        </h2>
        <p className="mt-1 text-xs text-[#7A6A5B]">
          Hệ thống kiểm tra Magic Bytes thực của tệp (từ chối{' '}
          <code>400 INVALID_MAGIC_BYTES</code> nếu giả mạo đuôi), kiểm tra tỷ lệ
          2:3 + nền trong suốt Alpha (từ chối{' '}
          <code>422 INVALID_ASPECT_OR_ALPHA</code>), hoặc tự động căn giữa{' '}
          <code>768×1024</code> cho <code>TRYON_FLAT_3_4</code>.
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <select
            value={assetType}
            onChange={(e) => setAssetType(e.target.value as MediaAssetType)}
            aria-label="Chọn chuẩn ảnh đầu ra"
            className="rounded-full border border-[#B08A4A]/40 bg-[#FBF7EF] px-4 py-2 text-xs font-medium text-[#1C1410]"
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

          <label className="cursor-pointer rounded-full bg-[#1C1410] px-5 py-2 text-xs uppercase tracking-[0.16em] text-[#EBCF8F] hover:opacity-90">
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
                ? 'border-[#2E6B47]/35 bg-[#F2FBF6] text-[#1E4B32]'
                : 'border-[#8B2E2E]/35 bg-[#FFF5F4] text-[#8B2E2E]'
            }`}
          >
            {uploadFeedback.isrConfirmed ? (
              <span className="mr-2 inline-flex items-center rounded-full bg-[#1E4B32] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-white">
                Redis + On-Demand ISR OK
              </span>
            ) : null}
            {uploadFeedback.code ? (
              <strong className="mr-2 font-mono">
                [{uploadFeedback.code}]
              </strong>
            ) : null}
            {uploadFeedback.message}
          </div>
        ) : null}
      </section>

      {/* Interactive Drag-and-Drop Visual Anchor Calibrator + Live Brass Rack Hanger Preview */}
      <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#B08A4A]/20 pb-5">
          <div>
            <p className="ledger-eyebrow text-[#8A672C]">
              Visual Anchor Calibrator (2:3) · Đồng bộ Sào Treo 3D
            </p>
            <h3 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Hiệu chỉnh tâm móc treo đồng thau &amp; Xem trước trực tiếp
            </h3>
            <p className="mt-1 text-xs text-[#7A6A5B]">
              Kéo thả tâm đồng thau bên trái để định vị{' '}
              <code>(hangerAnchorX, hangerAnchorY)</code> và quan sát trang phục
              treo thực tế trên thanh đồng thau bên phải trước khi làm mới
              Storefront.
            </p>
          </div>

          <button
            type="button"
            onClick={() => setSwayPreviewEnabled((prev) => !prev)}
            className={`rounded-full border px-4 py-1.5 text-xs transition-colors ${
              swayPreviewEnabled
                ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                : 'border-[#B08A4A]/40 bg-[#FBF7EF] text-[#5C4B41]'
            }`}
          >
            {swayPreviewEnabled
              ? 'Đang bật mô phỏng đung đưa móc treo'
              : 'Bật mô phỏng đung đưa móc treo'}
          </button>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-[290px_290px_1fr]">
          {/* Column 1: Interactive 2:3 Crosshair Calibration Stage */}
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[#8A672C]">
              1. Khung căn chỉnh tâm (Kéo thả)
            </p>

            <div
              ref={stageRef}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                setDragging(true);
                updateCrosshairFromPointer(e);
              }}
              onPointerMove={(e) => {
                if (!dragging) return;
                updateCrosshairFromPointer(e);
              }}
              onPointerUp={(e) => {
                e.currentTarget.releasePointerCapture(e.pointerId);
                setDragging(false);
              }}
              className="relative mt-3 aspect-[2/3] w-full cursor-crosshair select-none overflow-hidden rounded-2xl border border-[#B08A4A]/45 bg-[#1C1410]"
              style={{
                backgroundImage:
                  'radial-gradient(rgba(235,207,143,0.16) 1px, transparent 1px)',
                backgroundSize: '18px 18px',
              }}
            >
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
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[#8A672C]">
              2. Xem trước trên Sào Treo Đồng Thau
            </p>

            <div
              aria-label="Xem trước trang phục treo trên sào đồng thau 2:3"
              className="relative mt-3 aspect-[2/3] w-full overflow-hidden rounded-2xl border border-[#B08A4A]/45 bg-[#1C1410]"
              style={{
                backgroundImage:
                  'radial-gradient(circle at 50% 24%, rgba(235,207,143,0.22), rgba(28,20,16,0.96) 68%)',
              }}
            >
              {/* Horizontal Metallic Brass Rail Bar */}
              <div
                className="pointer-events-none absolute right-0 left-0 top-[7%] z-20 h-2.5 shadow-[0_3px_12px_rgba(0,0,0,0.55)]"
                style={{
                  background:
                    'linear-gradient(180deg, #F8E5B8 0%, #C59B56 48%, #735420 100%)',
                }}
              />

              {/* Brass Ring + Hanger Hook pinned to (50%, 17%) */}
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

              {/* Suspended 2:3 Garment locked at normalized (anchorX, anchorY) */}
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

          {/* Column 3: Numeric Controls, Save + ISR Button & Asset Picker */}
          <div className="flex flex-col justify-between space-y-6">
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="rounded-2xl border border-[#B08A4A]/25 bg-[#FBF7EF] p-3.5">
                  <span className="block text-[10px] uppercase tracking-[0.16em] text-[#8A672C]">
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
                    className="mt-1 w-full rounded-lg border border-[#B08A4A]/35 bg-white px-2 py-1 font-mono text-sm font-semibold text-[#1C1410]"
                  />
                </label>

                <label className="rounded-2xl border border-[#B08A4A]/25 bg-[#FBF7EF] p-3.5">
                  <span className="block text-[10px] uppercase tracking-[0.16em] text-[#8A672C]">
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
                    className="mt-1 w-full rounded-lg border border-[#B08A4A]/35 bg-white px-2 py-1 font-mono text-sm font-semibold text-[#1C1410]"
                  />
                </label>

                <label className="rounded-2xl border border-[#B08A4A]/25 bg-[#FBF7EF] p-3.5">
                  <span className="block text-[10px] uppercase tracking-[0.16em] text-[#8A672C]">
                    layerZHint
                  </span>
                  <input
                    type="number"
                    value={layerZHint}
                    onChange={(e) => setLayerZHint(Number(e.target.value))}
                    className="mt-1 w-full rounded-lg border border-[#B08A4A]/35 bg-white px-2 py-1 font-mono text-sm font-semibold text-[#1C1410]"
                  />
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  disabled={!selectedAsset || savingAnchor}
                  onClick={() => void handleSaveSpatialMetadata()}
                  className="rounded-full bg-[#1C1410] px-6 py-2.5 text-xs font-medium uppercase tracking-[0.16em] text-[#EBCF8F] transition-opacity hover:opacity-90 disabled:opacity-40"
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
                  className="rounded-full border border-[#B08A4A]/40 bg-[#FBF7EF] px-4 py-2.5 text-xs text-[#5C4B41] hover:border-[#8A672C]"
                >
                  Đặt về chuẩn (0.50, 0.06)
                </button>
              </div>
            </div>

            {/* Asset Library Picker with RACK_CUTOUT_2_3 Filter */}
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="ledger-eyebrow text-[#8A672C]">
                  Thư viện Media ({visibleAssets.length} / {assets.length})
                </p>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setLibraryFilter('RACK_ONLY')}
                    className={`rounded-full px-3 py-1 text-[11px] transition-colors ${
                      libraryFilter === 'RACK_ONLY'
                        ? 'bg-[#1C1410] text-[#EBCF8F]'
                        : 'border border-[#B08A4A]/35 bg-[#FBF7EF] text-[#5C4B41]'
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
                        : 'border border-[#B08A4A]/35 bg-[#FBF7EF] text-[#5C4B41]'
                    }`}
                  >
                    Tất cả ({assets.length})
                  </button>
                </div>
              </div>

              <div className="mt-3 grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2">
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
                          : 'border-[#B08A4A]/25 bg-[#FBF7EF] text-[#2B2019] hover:border-[#8A672C]'
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
                            ({(asset.spatialMetadata?.hangerAnchorX ?? 0.5).toFixed(2)},{' '}
                            {(asset.spatialMetadata?.hangerAnchorY ?? 0.06).toFixed(2)})
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
