'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type AtelierToastTone = 'gold' | 'success' | 'warning' | 'error';

export interface AtelierToastDetail {
  message: string;
  tone?: AtelierToastTone;
  durationMs?: number;
}

interface ToastItem {
  id: string;
  message: string;
  tone: AtelierToastTone;
}

export const ATELIER_TOAST_EVENT = 'atelier:toast';

const MAX_VISIBLE_TOASTS = 3;
const DEFAULT_DURATION_MS = 3600;

export function showAtelierToast(
  message: string,
  tone: AtelierToastTone = 'gold',
  durationMs = DEFAULT_DURATION_MS,
): void {
  if (typeof window === 'undefined' || !message.trim()) {
    return;
  }
  const detail: AtelierToastDetail = {
    message: message.normalize('NFC').trim(),
    tone,
    durationMs,
  };
  window.dispatchEvent(
    new CustomEvent<AtelierToastDetail>(ATELIER_TOAST_EVENT, { detail }),
  );
}

const TONE_STYLES: Record<
  AtelierToastTone,
  { border: string; dot: string; label: string }
> = {
  gold: {
    border: 'border-[#EBCF8F]/45 bg-[#1C1410]/94 text-[#FBF7EF]',
    dot: 'bg-[#EBCF8F]',
    label: 'Atelier',
  },
  success: {
    border: 'border-[#B08A4A]/65 bg-[#1C1410]/95 text-[#FBF7EF]',
    dot: 'bg-[#9ED2A1]',
    label: 'Hoàn tất',
  },
  warning: {
    border: 'border-[#D9A441]/70 bg-[#2A1E17]/95 text-[#FBF7EF]',
    dot: 'bg-[#EBCF8F]',
    label: 'Lưu ý',
  },
  error: {
    border: 'border-[#C96B5B]/75 bg-[#2A1815]/95 text-[#FBF7EF]',
    dot: 'bg-[#E58D7D]',
    label: 'Thông báo',
  },
};

export function AtelierToastProvider() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());

  const dismissToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  useEffect(() => {
    const handleToastEvent = (event: Event) => {
      const custom = event as CustomEvent<AtelierToastDetail>;
      const rawMessage = custom.detail?.message;
      if (!rawMessage || typeof rawMessage !== 'string') return;

      const tone: AtelierToastTone = custom.detail?.tone ?? 'gold';
      const durationMs = Math.max(
        1800,
        Math.min(10000, custom.detail?.durationMs ?? DEFAULT_DURATION_MS),
      );
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      setToasts((prev) => {
        const next = [
          ...prev,
          { id, message: rawMessage.normalize('NFC'), tone },
        ];
        if (next.length > MAX_VISIBLE_TOASTS) {
          const evicted = next.slice(0, next.length - MAX_VISIBLE_TOASTS);
          evicted.forEach((item) => {
            const oldTimer = timersRef.current.get(item.id);
            if (oldTimer !== undefined) {
              window.clearTimeout(oldTimer);
              timersRef.current.delete(item.id);
            }
          });
          return next.slice(-MAX_VISIBLE_TOASTS);
        }
        return next;
      });

      const timer = window.setTimeout(() => {
        timersRef.current.delete(id);
        setToasts((prev) => prev.filter((item) => item.id !== id));
      }, durationMs);
      timersRef.current.set(id, timer);
    };

    window.addEventListener(ATELIER_TOAST_EVENT, handleToastEvent);
    return () => {
      window.removeEventListener(ATELIER_TOAST_EVENT, handleToastEvent);
      timersRef.current.forEach((timer) => window.clearTimeout(timer));
      timersRef.current.clear();
    };
  }, []);

  if (toasts.length === 0) {
    return null;
  }

  return (
    <div
      className="pointer-events-none fixed right-4 bottom-6 z-[110] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2.5 sm:right-6"
      role="status"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((toast) => {
        const style = TONE_STYLES[toast.tone] ?? TONE_STYLES.gold;
        return (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-start justify-between gap-3 rounded-2xl border px-4 py-3.5 shadow-[0_18px_46px_-18px_rgba(28,20,16,0.72)] backdrop-blur-md transition-all ${style.border}`}
          >
            <div className="flex items-start gap-2.5">
              <span
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${style.dot}`}
                aria-hidden="true"
              />
              <div>
                <p className="text-[10px] tracking-[0.22em] uppercase text-[#EBCF8F]/85">
                  {style.label}
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-[#FBF7EF]">
                  {toast.message}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              aria-label="Đóng thông báo"
              className="shrink-0 rounded-full px-1.5 py-0.5 text-xs text-[#EBCF8F]/70 transition-colors hover:text-[#EBCF8F]"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
