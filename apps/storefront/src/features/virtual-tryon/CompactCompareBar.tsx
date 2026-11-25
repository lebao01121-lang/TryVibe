'use client';

import { useEffect, useState } from 'react';
import { FORMAT_VND } from '@/lib/catalog-data';

export interface SavedTryOnLook {
  id: string;
  title: string;
  subtitle: string;
  priceVnd: number;
  resultDataUrl: string;
  createdAt: number;
  garmentSummary: string;
}

export interface CompactCompareBarProps {
  savedLooks: SavedTryOnLook[];
  activeLookId: string | null;
  canSaveCurrent: boolean;
  onSaveCurrent: () => void;
  onSelectLook: (look: SavedTryOnLook) => void;
  onRemoveLook: (id: string) => void;
  onRetakePhoto: () => void;
  onDownloadResult: () => void;
  canDownload: boolean;
}

const MAX_COMPARE_SLOTS = 3;

/**
 * Compact bottom-left control & comparison tray rendered directly below the 3:4
 * Smart Mirror / Result stage inside the 100svh studio layout.
 */
export function CompactCompareBar({
  savedLooks,
  activeLookId,
  canSaveCurrent,
  onSaveCurrent,
  onSelectLook,
  onRemoveLook,
  onRetakePhoto,
  onDownloadResult,
  canDownload,
}: CompactCompareBarProps) {
  const [compareOpen, setCompareOpen] = useState(false);
  const [leftCompareId, setLeftCompareId] = useState<string | null>(null);
  const [rightCompareId, setRightCompareId] = useState<string | null>(null);

  // Keep side-by-side comparison selections synced when savedLooks change
  useEffect(() => {
    if (savedLooks.length < 2) {
      setCompareOpen(false);
      setLeftCompareId(savedLooks[0]?.id ?? null);
      setRightCompareId(null);
      return;
    }

    const leftValid = savedLooks.some((l) => l.id === leftCompareId);
    const rightValid =
      savedLooks.some((l) => l.id === rightCompareId) &&
      rightCompareId !== leftCompareId;

    if (!leftValid) {
      setLeftCompareId(savedLooks[0].id);
    }
    if (!rightValid) {
      const nextRight =
        savedLooks.find((l) => l.id !== (leftValid ? leftCompareId : savedLooks[0].id)) ??
        savedLooks[1];
      setRightCompareId(nextRight.id);
    }
  }, [savedLooks, leftCompareId, rightCompareId]);

  useEffect(() => {
    if (!compareOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setCompareOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [compareOpen]);

  const slots = Array.from(
    { length: MAX_COMPARE_SLOTS },
    (_, idx) => savedLooks[idx] ?? null,
  );
  const isFull = savedLooks.length >= MAX_COMPARE_SLOTS;
  const saveDisabled = !canSaveCurrent || isFull;

  const leftLook =
    savedLooks.find((l) => l.id === leftCompareId) ?? savedLooks[0] ?? null;
  const rightLook =
    savedLooks.find((l) => l.id === rightCompareId && l.id !== leftLook?.id) ??
    savedLooks.find((l) => l.id !== leftLook?.id) ??
    null;

  return (
    <>
      <div
        data-testid="tryon-compact-compare-bar"
        className="flex w-full flex-wrap items-center justify-between gap-2.5 rounded-2xl border border-[#B08A4A]/28 bg-[#1E1510]/92 px-3 py-2 text-[#FBF7EF] shadow-lg"
      >
        {/* Left: Primary Save + Retake + Download Controls */}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <button
            type="button"
            data-testid="tryon-save-look-btn"
            disabled={saveDisabled}
            onClick={onSaveCurrent}
            title={
              isFull
                ? 'Khay đã đủ 3/3 bộ — xóa bớt 1 bộ để lưu thêm'
                : 'Lưu chân dung thử đồ hiện tại vào khay so sánh'
            }
            className="inline-flex w-fit max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-[#EBCF8F]/60 bg-[#2B2019] px-3 py-1.5 text-[11px] font-medium text-[#EBCF8F] transition-all hover:border-[#EBCF8F] hover:bg-[#38291F] disabled:cursor-not-allowed disabled:opacity-45"
          >
            <span aria-hidden="true">✦</span>
            <span className="truncate">
              Lưu vào khay so sánh ({savedLooks.length}/{MAX_COMPARE_SLOTS})
            </span>
          </button>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              data-testid="tryon-retake-btn"
              onClick={onRetakePhoto}
              className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-[#B08A4A]/30 bg-[#16100C] px-2.5 py-1 text-[10px] font-medium text-[#F4EBDA]/85 transition-colors hover:border-[#EBCF8F]/65 hover:text-[#EBCF8F]"
            >
              <span aria-hidden="true">↺</span>
              <span>Chụp / Đổi ảnh khác</span>
            </button>

            <button
              type="button"
              data-testid="tryon-download-btn"
              disabled={!canDownload}
              onClick={onDownloadResult}
              className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-[#B08A4A]/30 bg-[#16100C] px-2.5 py-1 text-[10px] font-medium text-[#F4EBDA]/85 transition-colors hover:border-[#EBCF8F]/65 hover:text-[#EBCF8F] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span aria-hidden="true">⬇</span>
              <span>Tải ảnh</span>
            </button>

            {savedLooks.length >= 2 ? (
              <button
                type="button"
                data-testid="tryon-compare-two-btn"
                onClick={() => setCompareOpen(true)}
                className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-gradient-to-r from-[#EBCF8F] to-[#C8A25D] px-2.5 py-1 text-[10px] font-semibold text-[#1C1410] shadow-sm transition-all hover:brightness-105"
              >
                <span>Đối chiếu 2 bộ</span>
              </button>
            ) : null}
          </div>
        </div>

        {/* Right: 3 Compact 52×68px Thumbnails (01, 02, 03) */}
        <ul
          data-testid="tryon-saved-thumbnails"
          aria-label="3 khe lưu đối chiếu dáng thử"
          className="flex shrink-0 items-center gap-1.5"
        >
          {slots.map((look, idx) => {
            if (!look) {
              return (
                <li
                  key={`compare-empty-${idx}`}
                  data-testid={`tryon-saved-empty-${idx}`}
                  className="flex h-[68px] w-[52px] flex-col items-center justify-center rounded-lg border border-dashed border-[#B08A4A]/28 bg-[#16100C]/80 text-center"
                >
                  <span className="font-editorial text-xs text-[#EBCF8F]/55">
                    0{idx + 1}
                  </span>
                </li>
              );
            }

            const isSelected = look.id === activeLookId;
            return (
              <li
                key={look.id}
                data-testid={`tryon-saved-look-${idx}`}
                className={`group relative h-[68px] w-[52px] overflow-hidden rounded-lg border bg-[#140E0B] transition-all ${
                  isSelected
                    ? 'border-[#EBCF8F] ring-1 ring-[#EBCF8F]'
                    : 'border-[#B08A4A]/40 hover:border-[#EBCF8F]/80'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectLook(look)}
                  title={`Xem lại: ${look.title}`}
                  className="block h-full w-full cursor-pointer"
                >
                  <img
                    src={look.resultDataUrl}
                    alt={look.title}
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                  <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#140E0B]/95 to-transparent px-1 pt-2 pb-0.5 text-left font-mono text-[8px] text-[#EBCF8F]">
                    0{idx + 1}
                  </span>
                </button>

                <button
                  type="button"
                  data-testid={`tryon-remove-look-${idx}`}
                  aria-label={`Xóa bộ 0${idx + 1} (${look.title})`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemoveLook(look.id);
                  }}
                  className="absolute top-0.5 right-0.5 z-10 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full border border-[#EBCF8F]/45 bg-[#1C1410]/90 text-[10px] leading-none text-[#EBCF8F] transition-colors hover:border-red-300 hover:bg-red-900 hover:text-white"
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Side-by-Side 2-Look Comparison Modal Overlay */}
      {compareOpen && leftLook && rightLook ? (
        <div
          data-testid="tryon-compare-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Đối chiếu trực tiếp 2 bộ trang phục"
          className="fixed inset-0 z-[1300] flex items-center justify-center bg-[#140E0B]/88 p-4 backdrop-blur-md"
          onClick={() => setCompareOpen(false)}
        >
          <div
            className="flex max-h-[92svh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-[#B08A4A]/45 bg-[#1C1410] text-[#FBF7EF] shadow-[0_32px_96px_-20px_rgba(0,0,0,0.9)]"
            onClick={(event) => event.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-3 border-b border-[#B08A4A]/25 bg-[#18110D] px-5 py-3.5">
              <div>
                <p className="text-[10px] font-medium tracking-[0.22em] uppercase text-[#EBCF8F]">
                  Đối Chiếu Trực Tiếp · Atelier Compare
                </p>
                <h3 className="mt-0.5 font-editorial text-xl text-[#FBF7EF]">
                  So sánh 2 bộ trang phục đã lưu
                </h3>
              </div>

              <button
                type="button"
                data-testid="tryon-compare-close-btn"
                onClick={() => setCompareOpen(false)}
                className="cursor-pointer rounded-full border border-[#B08A4A]/40 bg-[#2B2019] px-3.5 py-1.5 text-xs font-medium text-[#F4EBDA] transition-colors hover:border-[#EBCF8F] hover:text-[#EBCF8F]"
              >
                ✕ Đóng đối chiếu
              </button>
            </div>

            {/* Optional selector pills when all 3 slots are filled */}
            {savedLooks.length === 3 ? (
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#B08A4A]/18 bg-[#211813] px-5 py-2 text-[11px]">
                <div className="flex items-center gap-1.5">
                  <span className="text-[#EBD9B4]/70">Khung Trái:</span>
                  {savedLooks.map((look, i) => (
                    <button
                      key={`pick-left-${look.id}`}
                      type="button"
                      disabled={look.id === rightLook.id}
                      onClick={() => setLeftCompareId(look.id)}
                      className={`cursor-pointer rounded-full px-2.5 py-0.5 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                        look.id === leftLook.id
                          ? 'bg-[#EBCF8F] text-[#1C1410]'
                          : 'border border-[#B08A4A]/35 text-[#FBF7EF]/80 hover:border-[#EBCF8F]'
                      }`}
                    >
                      Bộ 0{i + 1}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-1.5">
                  <span className="text-[#EBD9B4]/70">Khung Phải:</span>
                  {savedLooks.map((look, i) => (
                    <button
                      key={`pick-right-${look.id}`}
                      type="button"
                      disabled={look.id === leftLook.id}
                      onClick={() => setRightCompareId(look.id)}
                      className={`cursor-pointer rounded-full px-2.5 py-0.5 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                        look.id === rightLook.id
                          ? 'bg-[#EBCF8F] text-[#1C1410]'
                          : 'border border-[#B08A4A]/35 text-[#FBF7EF]/80 hover:border-[#EBCF8F]'
                      }`}
                    >
                      Bộ 0{i + 1}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Side-by-side 2-look 3:4 portrait comparison grid */}
            <div className="grid flex-1 grid-cols-2 gap-4 overflow-y-auto p-4 sm:p-5">
              {[
                { label: 'Lựa chọn A', look: leftLook, testId: 'compare-card-left' },
                { label: 'Lựa chọn B', look: rightLook, testId: 'compare-card-right' },
              ].map(({ label, look, testId }) => (
                <div
                  key={look.id}
                  data-testid={testId}
                  className="flex flex-col overflow-hidden rounded-xl border border-[#B08A4A]/35 bg-[#16100C]"
                >
                  <div className="relative aspect-[3/4] w-full overflow-hidden bg-[#120C09]">
                    <img
                      src={look.resultDataUrl}
                      alt={look.title}
                      className="h-full w-full object-cover"
                    />
                    <span className="absolute top-2.5 left-2.5 rounded-full border border-[#EBCF8F]/45 bg-[#1C1410]/85 px-2.5 py-0.5 text-[10px] tracking-[0.14em] uppercase text-[#EBCF8F] backdrop-blur-sm">
                      {label}
                    </span>
                  </div>

                  <div className="flex flex-1 flex-col justify-between gap-2 p-3">
                    <div>
                      <p className="truncate text-sm font-medium text-[#FBF7EF]">
                        {look.title}
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-[#EBD9B4]/70">
                        {look.garmentSummary || look.subtitle}
                      </p>
                    </div>

                    <div className="flex items-center justify-between gap-2 pt-1">
                      <span className="font-mono text-xs font-semibold text-[#EBCF8F]">
                        {FORMAT_VND(look.priceVnd)}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          onSelectLook(look);
                          setCompareOpen(false);
                        }}
                        className="cursor-pointer rounded-full bg-gradient-to-r from-[#EBCF8F] to-[#C8A25D] px-3 py-1 text-[10px] font-semibold tracking-[0.08em] uppercase text-[#1C1410] transition-all hover:brightness-105"
                      >
                        Chọn bộ này
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
