'use client';

export interface GiftCardPreviewProps {
  note: string;
  visible: boolean;
  inline?: boolean;
}

/**
 * Faithful `.order__card` slanted (-4deg) ivory Atelier gift card
 * displaying monogram `T&V`, live keystroke-synced calligraphic Dancing Script
 * (`var(--cursive)`) message (maxLength 140), and Atelier signature.
 * Supports both floating drawer presentation and inline Checkout presentation.
 */
export function GiftCardPreview({
  note,
  visible,
  inline = false,
}: GiftCardPreviewProps) {
  const trimmed = note.trim();
  const isEmpty = trimmed.length === 0;

  if (inline) {
    return (
      <div
        className="order__card relative mx-auto flex w-full max-w-[380px] flex-col"
        style={{
          aspectRatio: '3 / 2',
          padding: '24px 30px',
          background: 'radial-gradient(ellipse at 30% 20%, #fffdf8, #f6eedd 80%)',
          borderRadius: '6px',
          boxShadow:
            '0 24px 50px -24px rgba(28, 20, 16, 0.35), 0 0 0 1px rgba(176, 138, 74, 0.32)',
          transform: visible ? 'rotate(-4deg)' : 'translateY(12px) rotate(-6deg)',
          opacity: visible ? 1 : 0.6,
          transition:
            'transform 0.65s cubic-bezier(0.22, 0.8, 0.22, 1), opacity 0.45s ease',
          color: '#3a2a20',
        }}
      >
        <span
          className="pointer-events-none absolute inset-[10px] rounded-[3px] border border-[#B08A4A]/45"
          aria-hidden="true"
        />

        <span className="order__mono text-center font-editorial text-[20px] tracking-[0.04em] text-[#B08A4A]">
          T<i className="mx-0.5 text-[0.6em]">&#38;</i>V
        </span>

        <p
          className={`my-1.5 flex flex-1 items-center justify-center overflow-hidden text-center font-script text-[clamp(18px,2vw,25px)] leading-[1.28] font-medium break-words ${
            isEmpty ? 'is-empty opacity-40' : 'opacity-100'
          }`}
          style={{ fontFamily: 'var(--cursive, var(--font-dancing-script), cursive)' }}
        >
          {isEmpty ? 'Viết vài dòng cho người nhận…' : note}
        </p>

        <i className="order__sign text-right font-editorial text-[12px] text-[#8A672C]">
          — TryVibe gửi kèm thiết kế
        </i>
      </div>
    );
  }

  return (
    <div
      aria-hidden="true"
      className="order__card pointer-events-none hidden lg:flex"
      style={{
        position: 'absolute',
        right: 'calc(min(470px, 92vw) + 5vw)',
        bottom: '16vh',
        width: 'min(380px, 30vw)',
        aspectRatio: '3 / 2',
        padding: '28px 34px',
        background: 'radial-gradient(ellipse at 30% 20%, #fffdf8, #f6eedd 80%)',
        borderRadius: '6px',
        boxShadow: '0 40px 80px -30px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(176, 138, 74, 0.25)',
        transform: visible ? 'rotate(-4deg)' : 'translateY(40px) rotate(-7deg)',
        opacity: visible ? 1 : 0,
        transition:
          'transform 0.85s cubic-bezier(0.22, 0.8, 0.22, 1) 0.12s, opacity 0.55s ease 0.12s',
        flexDirection: 'column',
        color: '#3a2a20',
      }}
    >
      {/* Inner gold hairline border */}
      <span
        className="pointer-events-none absolute inset-[10px] rounded-[3px] border border-[#B08A4A]/45"
        aria-hidden="true"
      />

      <span className="order__mono text-center font-editorial text-[22px] tracking-[0.04em] text-[#B08A4A]">
        T<i className="mx-0.5 text-[0.6em]">&#38;</i>V
      </span>

      <p
        id="odCard"
        className={`my-1.5 flex flex-1 items-center justify-center overflow-hidden text-center font-script text-[clamp(20px,1.8vw,28px)] leading-[1.25] font-medium break-words ${
          isEmpty ? 'is-empty opacity-40' : 'opacity-100'
        }`}
        style={{ fontFamily: 'var(--cursive, var(--font-dancing-script), cursive)' }}
      >
        {isEmpty ? 'Viết vài dòng cho người nhận…' : note}
      </p>

      <i className="order__sign text-right font-editorial text-[13px] text-[#8A672C]">
        — TryVibe gửi kèm thiết kế
      </i>
    </div>
  );
}
