'use client';

import { useId } from 'react';
import styles from './outfit-studio.module.css';

export interface StudioGiftCardProps {
  value: string;
  onChange: (nextValue: string) => void;
  maxLength?: number;
}

/**
 * Interactive -4deg tilted art-paper gift card resting on a warm sand backing mat,
 * styled in handwritten Dancing Script (`var(--cursive)`).
 */
export function StudioGiftCard({
  value,
  onChange,
  maxLength = 140,
}: StudioGiftCardProps) {
  const inputId = useId();

  return (
    <div data-testid="studio-gift-card" className="space-y-2">
      <div className="flex items-center justify-between">
        <label
          htmlFor={inputId}
          className="text-[11px] font-medium tracking-[0.2em] uppercase text-[#8A672C]"
        >
          Lời nhắn thiệp viết tay
        </label>
        <span className="font-mono text-[10px] text-[#7A6A5B]">
          {value.length}/{maxLength}
        </span>
      </div>

      {/* Warm sand backing mat */}
      <div className={styles.giftCardMat}>
        {/* -4deg tilted art-paper cream card */}
        <div
          className={`${styles.giftCardPaper} px-4 py-3`}
          style={{ transform: 'rotate(-4deg)' }}
        >
          {/* Inner hairline gold border */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-[6px] rounded-[5px] border border-[#B08A4A]/25"
          />

          <div className="relative z-10 flex items-center justify-between border-b border-[#B08A4A]/20 pb-1.5">
            <span className="text-[9px] font-medium tracking-[0.22em] uppercase text-[#8A672C]">
              GIFT CARD · TRYVIBE ATELIER
            </span>
            <span className="font-mono text-[9.5px] text-[#7A6A5B]">
              {value.length}/{maxLength}
            </span>
          </div>

          <textarea
            id={inputId}
            data-testid="studio-gift-note-input"
            rows={2}
            maxLength={maxLength}
            value={value}
            onChange={(event) => onChange(event.target.value.slice(0, maxLength))}
            placeholder="Chúc nàng một đêm tiệc thật rạng rỡ..."
            aria-label="Lời nhắn thiệp viết tay"
            className={`${styles.giftCardTextarea} relative z-10 mt-1.5 w-full resize-none border-0 p-0 outline-none`}
            style={{
              fontFamily: 'var(--cursive, var(--font-dancing-script), cursive)',
              fontSize: '21px',
              lineHeight: 1.45,
              color: '#2B2019',
            }}
          />

          <div className="relative z-10 flex items-center justify-between pt-0.5">
            <span className="text-[9px] tracking-[0.16em] uppercase text-[#8A672C]/75">
              Viết tay mực nâu cacao
            </span>
            <span className="font-editorial text-[11px] italic text-[#8A672C]">
              — TryVibe
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
