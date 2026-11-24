'use client';

import type { TryOnMode } from '@atelier/contracts';
import { FORMAT_VND } from '@/lib/catalog-data';

export interface SavedTryOnLook {
  id: string;
  imageDataUrl: string;
  label: string;
  totalPriceVnd: number;
  mode: TryOnMode;
  tabMode: 'camera' | 'photo' | 'mannequin';
  garmentSummary: string[];
  sizeCode: string;
  createdAt: string;
}

export const MAX_SAVED_TRYON_LOOKS = 3;

export const MAX_LOOKS_LIMIT_WARNING =
  'Khay so sánh chỉ lưu tối đa 3 bộ trong phiên — hãy xóa bớt 1 bộ cũ để lưu bộ phối mới.';

export interface SavedTryOnLooksTrayProps {
  looks: SavedTryOnLook[];
  activeLookId: string | null;
  maxLooks?: number;
  limitWarning?: string | null;
  onDismissWarning?: () => void;
  onSelectLook: (look: SavedTryOnLook) => void;
  onDeleteLook: (lookId: string) => void;
}

export function SavedTryOnLooksTray({
  looks,
  activeLookId,
  maxLooks = MAX_SAVED_TRYON_LOOKS,
  limitWarning = null,
  onDismissWarning,
  onSelectLook,
  onDeleteLook,
}: SavedTryOnLooksTrayProps) {
  const slots = Array.from({ length: maxLooks }, (_, idx) => looks[idx] ?? null);

  return (
    <section
      data-testid="tryon-saved-looks-tray"
      aria-label="Khay so sánh các bộ đã lưu"
      className="rounded-2xl border border-[#B08A4A]/28 bg-[#241A14]/82 p-3 text-[#FBF7EF]"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-medium tracking-[0.2em] uppercase text-[#EBCF8F]">
            Khay so sánh dáng thử
          </p>
          <p className="text-[11px] text-[#FBF7EF]/60">
            Nhấn ảnh đã chụp để đối chiếu trực tiếp
          </p>
        </div>

        <span
          data-testid="tryon-saved-tray-count"
          className={`shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-[11px] ${
            looks.length >= maxLooks
              ? 'border-[#EBCF8F]/75 bg-[#EBCF8F]/15 text-[#EBCF8F]'
              : 'border-[#B08A4A]/35 bg-[#1C1410] text-[#EBCF8F]/90'
          }`}
        >
          {looks.length}/{maxLooks}
        </span>
      </div>

      {limitWarning ? (
        <div
          data-testid="tryon-saved-limit-alert"
          role="alert"
          className="mt-2.5 flex items-start justify-between gap-2 rounded-xl border border-[#EBCF8F]/65 bg-gradient-to-r from-[#34251A] to-[#261B14] px-3 py-2 text-[11px] leading-snug text-[#F5E1B8] shadow-md"
        >
          <span>{limitWarning}</span>
          {onDismissWarning ? (
            <button
              type="button"
              onClick={onDismissWarning}
              aria-label="Đóng cảnh báo khay so sánh"
              className="shrink-0 text-xs text-[#EBCF8F] hover:text-[#FBF7EF]"
            >
              ×
            </button>
          ) : null}
        </div>
      ) : null}

      <ul className="mt-2.5 grid grid-cols-3 gap-2">
        {slots.map((look, idx) => {
          if (!look) {
            return (
              <li
                key={`empty-slot-${idx}`}
                className="flex aspect-[3/4] flex-col items-center justify-center rounded-xl border border-dashed border-[#B08A4A]/25 bg-[#19120E]/65 px-2 text-center"
              >
                <span className="font-editorial text-base text-[#EBCF8F]/50">
                  0{idx + 1}
                </span>
                <span className="mt-0.5 text-[10px] text-[#FBF7EF]/40">
                  Chưa lưu
                </span>
              </li>
            );
          }

          const isSelected = look.id === activeLookId;
          return (
            <li
              key={look.id}
              data-testid={`tryon-saved-look-${idx}`}
              className={`group relative overflow-hidden rounded-xl border bg-[#16100C] transition-all ${
                isSelected
                  ? 'border-[#EBCF8F] ring-1 ring-[#EBCF8F]'
                  : 'border-[#B08A4A]/35 hover:border-[#EBCF8F]/80'
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectLook(look)}
                className="block w-full text-left"
                title={`Xem đối chiếu: ${look.label}`}
              >
                <div className="relative aspect-[3/4] w-full overflow-hidden bg-[#120C09]">
                  <img
                    src={look.imageDataUrl}
                    alt={look.label}
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                  />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#140E0B]/95 via-[#140E0B]/60 to-transparent px-1.5 pt-5 pb-1.5">
                    <p className="truncate text-[10px] font-medium text-[#FBF7EF]">
                      {look.label}
                    </p>
                    <p className="font-mono text-[9px] text-[#EBCF8F]">
                      {FORMAT_VND(look.totalPriceVnd)}
                    </p>
                  </div>
                </div>
              </button>

              <button
                type="button"
                data-testid={`tryon-delete-look-${idx}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteLook(look.id);
                }}
                aria-label={`Xóa bộ đã lưu ${look.label}`}
                className="absolute top-1.5 right-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-[#EBCF8F]/40 bg-[#1C1410]/88 text-[11px] leading-none text-[#EBCF8F] transition-colors hover:border-red-300 hover:bg-red-900/90 hover:text-white"
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
