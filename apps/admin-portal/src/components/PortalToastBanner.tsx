'use client';

import { useEffect, useState } from 'react';

export interface PortalToastItem {
  id: string;
  kind: 'success' | 'error' | 'info';
  title?: string;
  message: string;
}

const TOAST_EVENT_NAME = 'atelier:admin-portal-toast';

export function emitPortalToast(input: Omit<PortalToastItem, 'id'>): void {
  if (typeof window === 'undefined') return;
  const item: PortalToastItem = {
    ...input,
    id: `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  };
  window.dispatchEvent(new CustomEvent<PortalToastItem>(TOAST_EVENT_NAME, { detail: item }));
}

export function PortalToastBanner() {
  const [items, setItems] = useState<PortalToastItem[]>([]);

  useEffect(() => {
    const timers = new Map<string, number>();

    const onToast = (event: Event) => {
      const detail = (event as CustomEvent<PortalToastItem>).detail;
      if (!detail?.message) return;
      setItems((prev) => [...prev.slice(-3), detail]);

      const timer = window.setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== detail.id));
        timers.delete(detail.id);
      }, 4500);
      timers.set(detail.id, timer);
    };

    window.addEventListener(TOAST_EVENT_NAME, onToast);
    return () => {
      window.removeEventListener(TOAST_EVENT_NAME, onToast);
      timers.forEach((timerId) => window.clearTimeout(timerId));
      timers.clear();
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-5 bottom-5 z-50 flex w-full max-w-sm flex-col gap-2.5"
    >
      {items.map((item) => {
        const toneClass =
          item.kind === 'success'
            ? 'border-[#2E6B47]/50 bg-[#F2FBF6] text-[#1E4B32]'
            : item.kind === 'error'
              ? 'border-[#8B2E2E]/50 bg-[#FFF5F4] text-[#8B2E2E]'
              : 'border-[#B08A4A]/50 bg-[#1C1410] text-[#EBCF8F]';

        return (
          <div
            key={item.id}
            role="status"
            className={`pointer-events-auto flex items-start justify-between gap-3 rounded-2xl border px-4 py-3 text-xs shadow-lg ${toneClass}`}
          >
            <div>
              {item.title ? (
                <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em]">
                  {item.title}
                </p>
              ) : null}
              <p className="mt-0.5 leading-relaxed">{item.message}</p>
            </div>
            <button
              type="button"
              onClick={() =>
                setItems((prev) => prev.filter((t) => t.id !== item.id))
              }
              aria-label="Đóng thông báo"
              className="shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[11px] opacity-70 hover:opacity-100"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
