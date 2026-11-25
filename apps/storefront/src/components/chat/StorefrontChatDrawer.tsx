'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  TryOnGarmentCategory,
  TryOnMode,
  type ProductSpuDto,
} from '@atelier/contracts';
import { loadSharedBodyProfile } from '@/components/AnatomicalFitVisualizer';
import { apiFetch, getStoredSession, subscribeSession } from '@/lib/api-client';
import { FORMAT_VND, getPrimaryVariantImage } from '@/lib/catalog-data';
import { getOrCreateGuestSessionId } from '@/lib/guest-session';
import {
  openVirtualTryOnModal,
  type OpenTryOnOptions,
} from '@/lib/storefront-actions';

export interface StorefrontChatDrawerProps {
  open: boolean;
  onOpenChange: (nextOpen: boolean) => void;
  hidden?: boolean;
  products?: ProductSpuDto[];
}

interface ChatPolicyCitation {
  id: string;
  title: string;
  source?: string;
  excerpt?: string;
}

interface ChatRecommendedProduct {
  productId: string;
  slug: string;
  name: string;
  thumbnailUrl: string;
  priceVnd: number | null;
  recommendedSize?: string | null;
  colorName?: string | null;
  variantId?: string | null;
  categoryHint?: string | null;
}

interface StylistChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  citations?: ChatPolicyCitation[];
  recommendedProducts?: ChatRecommendedProduct[];
  tier?: string | null;
  model?: string | null;
  blockedInjection?: boolean;
  isError?: boolean;
}

interface PersistedStylistSession {
  sessionId: string;
  messages: StylistChatMessage[];
}

const CHAT_STORAGE_KEY = 'atelier_storefront_stylist_chat_v1';
const MAX_PERSISTED_MESSAGES = 32;

const QUICK_SUGGESTION_CHIPS = [
  'Tư vấn size theo chiều cao cân nặng',
  'Gợi ý phối đồ đi tiệc còn size M',
  'Chính sách đổi trả 7–14 ngày',
  'Bảo mật ảnh thử đồ 15 phút',
] as const;

function createChatSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `stylist-${crypto.randomUUID()}`;
  }
  return `stylist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function createWelcomeMessage(): StylistChatMessage {
  return {
    id: 'stylist-welcome',
    role: 'assistant',
    content:
      'Xin chào quý khách đến với TryVibe Atelier. Tôi là Cố vấn Thời trang riêng — sẵn sàng tư vấn số đo chuẩn phom, gợi ý phối đồ còn hàng đúng size, giải đáp chính sách đổi size 7–14 ngày và cơ chế bảo mật ảnh thử đồ tự xóa sau 15 phút.',
    createdAt: new Date().toISOString(),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickStr(rec: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const val = rec[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
  }
  return null;
}

function pickNum(rec: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const val = rec[key];
    if (typeof val === 'number' && Number.isFinite(val)) {
      return val;
    }
    if (typeof val === 'string' && val.trim().length > 0) {
      const parsed = Number(val);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function normalizeCitations(raw: unknown): ChatPolicyCitation[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatPolicyCitation[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (typeof item === 'string' && item.trim().length > 0) {
      const title = item.trim();
      if (!seen.has(title)) {
        seen.add(title);
        out.push({ id: `cit-${i}`, title });
      }
      continue;
    }
    const rec = asRecord(item);
    if (!rec) continue;
    const title =
      pickStr(rec, 'title', 'documentTitle', 'docTitle', 'policyTitle', 'source', 'sourceId', 'docId', 'id') ??
      'Tài liệu chính sách Atelier';
    const source = pickStr(rec, 'source', 'sourceId', 'section', 'category', 'docId') ?? undefined;
    const excerpt =
      pickStr(rec, 'excerpt', 'snippet', 'summary', 'content', 'quote') ?? undefined;
    const dedupeKey = `${title}|${excerpt?.slice(0, 48) ?? ''}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      id: pickStr(rec, 'id', 'sourceId', 'docId') ?? `cit-${i}`,
      title,
      source: source && source !== title ? source : undefined,
      excerpt: excerpt ? excerpt.slice(0, 180) : undefined,
    });
  }

  return out.slice(0, 5);
}

function normalizeRecommendedProducts(
  rawData: Record<string, unknown>,
  catalogBySlug: Map<string, ProductSpuDto>,
  catalogById: Map<string, ProductSpuDto>,
): ChatRecommendedProduct[] {
  const candidates: unknown[] = [];

  if (Array.isArray(rawData.recommendedProducts)) {
    candidates.push(...rawData.recommendedProducts);
  }
  if (Array.isArray(rawData.suggestedProducts)) {
    candidates.push(...rawData.suggestedProducts);
  }
  if (Array.isArray(rawData.matchedProducts)) {
    candidates.push(...rawData.matchedProducts);
  }
  if (Array.isArray(rawData.products)) {
    candidates.push(...rawData.products);
  }
  if (Array.isArray(rawData.recommendations)) {
    candidates.push(...rawData.recommendations);
  }

  // Also check structured cards if the stylist service returned product cards inside actionCards
  if (Array.isArray(rawData.actionCards)) {
    for (const card of rawData.actionCards) {
      const cardRec = asRecord(card);
      if (!cardRec) continue;
      const payload = asRecord(cardRec.payload);
      if (payload && Array.isArray(payload.products)) {
        candidates.push(...payload.products);
      } else if (payload && Array.isArray(payload.items)) {
        candidates.push(...payload.items);
      }
    }
  }

  const out: ChatRecommendedProduct[] = [];
  const seen = new Set<string>();

  for (const rawItem of candidates) {
    const rec = asRecord(rawItem);
    if (!rec) continue;

    const rawId = pickStr(rec, 'productId', 'id', 'spuId');
    const rawSlug = pickStr(rec, 'slug', 'productSlug');
    const matchedProduct =
      (rawSlug ? catalogBySlug.get(rawSlug) : undefined) ??
      (rawId ? catalogById.get(rawId) : undefined);

    const slug = rawSlug ?? matchedProduct?.slug ?? '';
    const productId = rawId ?? matchedProduct?.id ?? slug;
    const name =
      pickStr(rec, 'name', 'productName', 'title') ?? matchedProduct?.name ?? null;

    if (!name || (!slug && !productId)) continue;
    const dedupeKey = slug || productId;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const primaryImg = matchedProduct
      ? getPrimaryVariantImage(matchedProduct, 0).lookbookUrl
      : '/media/atelier-hero-poster.webp';
    const thumbnailUrl =
      pickStr(
        rec,
        'thumbnailUrl',
        'imageUrl',
        'lookbookMainUrl',
        'flatImageUrl',
        'primaryImageUrl',
        'thumbnail',
        'image',
      ) ?? primaryImg;

    const priceVnd =
      pickNum(
        rec,
        'retailPriceVnd',
        'salePriceVnd',
        'priceVnd',
        'minPriceVnd',
        'price',
      ) ??
      matchedProduct?.minPriceVnd ??
      null;

    const recommendedSize = pickStr(
      rec,
      'recommendedSize',
      'sizeCode',
      'size',
      'suggestedSize',
    );
    const colorName =
      pickStr(rec, 'colorName', 'color') ??
      matchedProduct?.variants[0]?.colorName ??
      null;
    const variantId =
      pickStr(rec, 'variantId') ?? matchedProduct?.variants[0]?.id ?? null;
    const categoryHint =
      pickStr(rec, 'tryonGarmentCategory', 'categorySlug', 'categoryName', 'slot') ??
      matchedProduct?.tryonGarmentCategory ??
      null;

    out.push({
      productId,
      slug: slug || productId,
      name,
      thumbnailUrl,
      priceVnd,
      recommendedSize,
      colorName,
      variantId,
      categoryHint,
    });
  }

  return out.slice(0, 6);
}

function buildTryOnOptionsForRecommendation(
  item: ChatRecommendedProduct,
  matchedProduct?: ProductSpuDto,
): OpenTryOnOptions {
  const garmentRef = {
    productId: matchedProduct?.id ?? item.productId,
    variantId: item.variantId ?? matchedProduct?.variants[0]?.id,
    skuId:
      matchedProduct?.variants[0]?.skus.find(
        (s) =>
          item.recommendedSize &&
          s.sizeCode === item.recommendedSize &&
          s.inStock,
      )?.id ??
      matchedProduct?.variants[0]?.skus.find((s) => s.inStock)?.id ??
      matchedProduct?.variants[0]?.skus[0]?.id,
    slug: matchedProduct?.slug ?? item.slug,
    productName: item.name,
    imageUrl: item.thumbnailUrl,
  };

  const hint =
    `${item.categoryHint ?? ''} ${matchedProduct?.tryonGarmentCategory ?? ''} ${matchedProduct?.categorySlug ?? ''} ${item.slug} ${item.name}`.toLowerCase();

  if (
    matchedProduct?.tryonGarmentCategory === TryOnGarmentCategory.OVERALL ||
    hint.includes('overall') ||
    hint.includes('onepiece') ||
    hint.includes('one_piece') ||
    hint.includes('dam-') ||
    hint.includes('đầm') ||
    hint.includes('ao-dai') ||
    hint.includes('áo dài')
  ) {
    return { mode: TryOnMode.SINGLE, onePiece: garmentRef };
  }

  if (
    matchedProduct?.tryonGarmentCategory === TryOnGarmentCategory.LOWER ||
    hint.includes('lower') ||
    hint.includes('bottom') ||
    hint.includes('quan-') ||
    hint.includes('quần') ||
    hint.includes('chan-vay') ||
    hint.includes('chân váy')
  ) {
    return { mode: TryOnMode.SINGLE, lower: garmentRef };
  }

  if (
    hint.includes('outerwear') ||
    hint.includes('blazer') ||
    hint.includes('ao-khoac') ||
    hint.includes('áo khoác') ||
    hint.includes('trench') ||
    hint.includes('mang-to') ||
    hint.includes('măng tô') ||
    hint.includes('tweed')
  ) {
    return { mode: TryOnMode.SINGLE, outerwear: garmentRef };
  }

  return { mode: TryOnMode.SINGLE, upper: garmentRef };
}

function formatMessageTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat('vi-VN', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return '';
  }
}

export function StorefrontChatDrawer({
  open,
  onOpenChange,
  hidden = false,
  products = [],
}: StorefrontChatDrawerProps) {
  const [sessionId, setSessionId] = useState<string>(() => createChatSessionId());
  const [messages, setMessages] = useState<StylistChatMessage[]>(() => [
    createWelcomeMessage(),
  ]);
  const [hydrated, setHydrated] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [sending, setSending] = useState(false);
  const [customerDisplayName, setCustomerDisplayName] = useState<string | null>(
    null,
  );

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const catalogBySlug = useMemo(() => {
    const map = new Map<string, ProductSpuDto>();
    for (const p of products) {
      map.set(p.slug, p);
    }
    return map;
  }, [products]);

  const catalogById = useMemo(() => {
    const map = new Map<string, ProductSpuDto>();
    for (const p of products) {
      map.set(p.id, p);
    }
    return map;
  }, [products]);

  // Hydrate conversation from sessionStorage once on client mount
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.sessionStorage.getItem(CHAT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistedStylistSession>;
        if (
          parsed &&
          typeof parsed.sessionId === 'string' &&
          parsed.sessionId.trim().length > 0
        ) {
          setSessionId(parsed.sessionId);
        }
        if (Array.isArray(parsed?.messages) && parsed.messages.length > 0) {
          setMessages(parsed.messages.slice(-MAX_PERSISTED_MESSAGES));
        }
      }
    } catch {
      // Ignore storage parsing errors
    } finally {
      setHydrated(true);
    }
  }, []);

  // Persist conversation to sessionStorage
  useEffect(() => {
    if (!hydrated || typeof window === 'undefined') return;
    try {
      const payload: PersistedStylistSession = {
        sessionId,
        messages: messages.slice(-MAX_PERSISTED_MESSAGES),
      };
      window.sessionStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore private browsing storage quota errors
    }
  }, [hydrated, messages, sessionId]);

  // Track authenticated customer identity for personalized greeting
  useEffect(() => {
    const syncIdentity = () => {
      const session = getStoredSession();
      const name =
        session?.user?.fullName?.trim() ||
        session?.user?.email?.split('@')[0] ||
        null;
      setCustomerDisplayName(session?.accessToken ? name : null);
    };
    syncIdentity();
    return subscribeSession(syncIdentity);
  }, []);

  // Auto-close when hidden (e.g. Virtual Try-On modal or camera opens)
  useEffect(() => {
    if (hidden && open) {
      onOpenChange(false);
    }
  }, [hidden, open, onOpenChange]);

  // Close drawer on Escape
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onOpenChange(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);

  // Scroll to bottom when new messages arrive or drawer opens
  useEffect(() => {
    if (!open) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, open, sending]);

  useEffect(() => {
    if (open) {
      const timer = window.setTimeout(() => {
        inputRef.current?.focus();
      }, 120);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [open]);

  const handleResetConversation = useCallback(() => {
    const freshId = createChatSessionId();
    const freshMessages = [createWelcomeMessage()];
    setSessionId(freshId);
    setMessages(freshMessages);
    setInputValue('');
    if (typeof window !== 'undefined') {
      try {
        window.sessionStorage.setItem(
          CHAT_STORAGE_KEY,
          JSON.stringify({ sessionId: freshId, messages: freshMessages }),
        );
      } catch {
        // Ignore storage errors
      }
    }
  }, []);

  const handleSendMessage = useCallback(
    async (rawText: string) => {
      const trimmed = rawText.trim();
      if (!trimmed || sending) return;

      const userMessage: StylistChatMessage = {
        id: `usr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: 'user',
        content: trimmed,
        createdAt: new Date().toISOString(),
      };

      const nextHistory = [...messages, userMessage].slice(-10);
      setMessages((prev) => [...prev, userMessage].slice(-MAX_PERSISTED_MESSAGES));
      setInputValue('');
      setSending(true);

      const guestSessionId = getOrCreateGuestSessionId();
      const bodyProfile = loadSharedBodyProfile();

      const res = await apiFetch<Record<string, unknown>>(
        '/bff/v1/storefront/chat',
        {
          method: 'POST',
          timeoutMs: 35_000,
          body: JSON.stringify({
            message: trimmed,
            prompt: trimmed,
            sessionId,
            guestSessionId,
            history: nextHistory.map((m) => ({
              role: m.role,
              content: m.content,
            })),
            ...(bodyProfile
              ? {
                  bodyProfile: {
                    heightCm: bodyProfile.heightCm,
                    weightKg: bodyProfile.weightKg,
                    fitPreference: bodyProfile.fitPreference,
                    ...(bodyProfile.bustCm ? { bustCm: bodyProfile.bustCm } : {}),
                    ...(bodyProfile.waistCm ? { waistCm: bodyProfile.waistCm } : {}),
                    ...(bodyProfile.hipCm ? { hipCm: bodyProfile.hipCm } : {}),
                  },
                }
              : {}),
          }),
        },
      );

      if (res.ok && res.data) {
        const data = asRecord(res.data) ?? {};
        const replyText =
          pickStr(data, 'reply', 'answer', 'message', 'content', 'text') ??
          'Cảm ơn quý khách đã nhắn tin. Tôi đã tiếp nhận yêu cầu và sẵn sàng hỗ trợ chọn size hoặc phối đồ Atelier.';
        const citations = normalizeCitations(data.citations);
        const recommendedProducts = normalizeRecommendedProducts(
          data,
          catalogBySlug,
          catalogById,
        );
        const blockedInjection = data.blockedInjection === true;
        const tier = pickStr(data, 'tier', 'llmBackend', 'aiProvider');
        const model = pickStr(data, 'model', 'modelUsed');

        const assistantMessage: StylistChatMessage = {
          id: `ast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          role: 'assistant',
          content: replyText,
          createdAt: new Date().toISOString(),
          citations: citations.length > 0 ? citations : undefined,
          recommendedProducts:
            recommendedProducts.length > 0 ? recommendedProducts : undefined,
          tier,
          model,
          blockedInjection,
        };

        setMessages((prev) =>
          [...prev, assistantMessage].slice(-MAX_PERSISTED_MESSAGES),
        );
      } else {
        const fallbackError =
          res.status === 429
            ? 'Quý khách đang gửi tin nhắn khá nhanh. Vui lòng chờ vài giây rồi thử lại để cố vấn phục vụ chu đáo nhất.'
            : res.error?.message ||
              'Cố vấn Stylist đang tạm đồng bộ dữ liệu kho và chính sách. Quý khách vui lòng thử lại sau giây lát.';

        const errorMessage: StylistChatMessage = {
          id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          role: 'assistant',
          content: fallbackError,
          createdAt: new Date().toISOString(),
          isError: true,
        };
        setMessages((prev) =>
          [...prev, errorMessage].slice(-MAX_PERSISTED_MESSAGES),
        );
      }

      setSending(false);
    },
    [catalogById, catalogBySlug, messages, sending, sessionId],
  );

  const handleLaunchTryOn = useCallback(
    (item: ChatRecommendedProduct) => {
      const matched =
        catalogBySlug.get(item.slug) ?? catalogById.get(item.productId);
      onOpenChange(false);
      openVirtualTryOnModal(buildTryOnOptionsForRecommendation(item, matched));
    },
    [catalogById, catalogBySlug, onOpenChange],
  );

  if (hidden) {
    return null;
  }

  return (
    <>
      {/* Floating Quiet Luxury Stylist Trigger (bottom-right, auto-hidden when Try-On/Camera active) */}
      {!open ? (
        <button
          type="button"
          data-testid="storefront-chat-trigger"
          aria-label="Mở Cố vấn Stylist AI TryVibe"
          aria-expanded={open}
          onClick={() => onOpenChange(true)}
          className="fixed right-5 bottom-5 z-[1040] inline-flex cursor-pointer items-center gap-2.5 rounded-full border border-[#B08A4A]/65 bg-[#1C1410] px-4 py-3 text-xs font-medium tracking-[0.12em] text-[#FBF7EF] shadow-[0_18px_42px_-12px_rgba(28,20,16,0.55)] transition-all duration-300 hover:-translate-y-0.5 hover:border-[#EBCF8F] hover:shadow-[0_22px_50px_-12px_rgba(176,138,74,0.48)] sm:right-6 sm:bottom-6"
        >
          <span
            aria-hidden="true"
            className="flex h-7 w-7 items-center justify-center rounded-full border border-[#EBCF8F]/60 bg-[#2B2019] font-editorial text-sm text-[#EBCF8F]"
          >
            ✦
          </span>
          <span className="flex flex-col items-start leading-tight">
            <span className="text-[10px] tracking-[0.18em] uppercase text-[#EBCF8F]">
              Stylist AI
            </span>
            <span className="text-[12px] font-medium tracking-normal text-[#FBF7EF]">
              Tư vấn Atelier
            </span>
          </span>
        </button>
      ) : null}

      {/* Editorial Quiet Luxury Drawer Overlay */}
      {open ? (
        <div className="fixed inset-0 z-[1050] flex justify-end">
          {/* Subtle Espresso Backdrop */}
          <div
            aria-hidden="true"
            onClick={() => onOpenChange(false)}
            className="fixed inset-0 bg-[#1C1410]/45 backdrop-blur-[2px] transition-opacity"
          />

          {/* Slide-over Stylist Panel */}
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Cố vấn Thời trang AI TryVibe Atelier"
            data-testid="storefront-chat-drawer"
            data-lenis-prevent=""
            className="relative z-10 flex h-[100dvh] w-full max-w-[440px] flex-col border-l border-[#B08A4A]/35 bg-[#FBF7EF] text-[#2B2019] shadow-[0_24px_80px_rgba(28,20,16,0.38)]"
          >
            {/* Espresso Header */}
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[#B08A4A]/30 bg-[#1C1410] px-5 py-4 text-[#FBF7EF]">
              <div className="min-w-0">
                <p className="text-[10px] font-medium tracking-[0.22em] uppercase text-[#EBCF8F]">
                  TRYVIBE · STYLIST ATELIER
                </p>
                <h2 className="font-editorial mt-0.5 truncate text-2xl font-light text-[#FBF7EF]">
                  Cố vấn Thời trang Riêng
                </h2>
                <p className="mt-0.5 truncate text-[11px] text-[#EBD9B4]/80">
                  {customerDisplayName
                    ? `Xin chào, ${customerDisplayName}`
                    : 'Khách ghé thăm · Tư vấn size, phối đồ & chính sách'}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleResetConversation}
                  title="Bắt đầu cuộc trò chuyện mới"
                  className="cursor-pointer rounded-full border border-[#B08A4A]/45 bg-[#2B2019] px-2.5 py-1 text-[10px] font-medium tracking-[0.08em] text-[#EBCF8F] transition-colors hover:border-[#EBCF8F] hover:bg-[#3A2B21]"
                >
                  Làm mới
                </button>
                <button
                  type="button"
                  data-testid="storefront-chat-close"
                  aria-label="Đóng cửa sổ tư vấn"
                  onClick={() => onOpenChange(false)}
                  className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-[#EBCF8F]/40 bg-[#2B2019] text-sm text-[#FBF7EF] transition-colors hover:border-[#EBCF8F] hover:bg-[#EBCF8F] hover:text-[#1C1410]"
                >
                  ✕
                </button>
              </div>
            </header>

            {/* 4 Quick Suggestion Chips */}
            <div className="shrink-0 border-b border-[#B08A4A]/20 bg-[#F4EBDA]/75 px-4 py-3">
              <p className="mb-2 text-[10px] font-medium tracking-[0.16em] uppercase text-[#8A672C]">
                Gợi ý câu hỏi nhanh
              </p>
              <div
                data-testid="storefront-chat-suggestions"
                className="flex flex-wrap gap-1.5"
              >
                {QUICK_SUGGESTION_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    disabled={sending}
                    onClick={() => void handleSendMessage(chip)}
                    className="cursor-pointer rounded-full border border-[#B08A4A]/40 bg-[#FBF7EF] px-3 py-1.5 text-left text-[11px] font-medium text-[#2B2019] transition-colors hover:border-[#1C1410] hover:bg-[#1C1410] hover:text-[#EBCF8F] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {chip}
                  </button>
                ))}
              </div>
            </div>

            {/* Conversation Feed */}
            <div
              data-lenis-prevent=""
              className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4"
            >
              {messages.map((msg) => {
                const isUser = msg.role === 'user';
                return (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${
                      isUser ? 'items-end' : 'items-start'
                    }`}
                  >
                    <div
                      className={`max-w-[92%] rounded-2xl px-4 py-3 text-[13px] leading-relaxed shadow-xs ${
                        isUser
                          ? 'rounded-br-sm bg-[#1C1410] text-[#FBF7EF]'
                          : msg.isError
                            ? 'rounded-bl-sm border border-[#8B2E2E]/30 bg-[#FFF5F4] text-[#8B2E2E]'
                            : 'rounded-bl-sm border border-[#B08A4A]/28 bg-white text-[#2B2019]'
                      }`}
                    >
                      {!isUser ? (
                        <div className="mb-1 flex items-center justify-between gap-2 text-[10px] tracking-[0.14em] uppercase text-[#8A672C]">
                          <span>✦ Stylist TryVibe</span>
                          {msg.blockedInjection ? (
                            <span className="rounded-full border border-[#B08A4A]/45 bg-[#F4EBDA] px-2 py-0.5 text-[9px] font-semibold text-[#1C1410]">
                              Bảo vệ dữ liệu
                            </span>
                          ) : null}
                        </div>
                      ) : null}

                      <p className="whitespace-pre-line">{msg.content}</p>

                      {/* RAG Policy Citations */}
                      {!isUser && msg.citations && msg.citations.length > 0 ? (
                        <div
                          data-testid="storefront-chat-citations"
                          className="mt-3 rounded-xl border border-[#B08A4A]/28 bg-[#FBF7EF] p-2.5"
                        >
                          <p className="text-[10px] font-semibold tracking-[0.14em] uppercase text-[#8A672C]">
                            Trích dẫn chính sách Atelier
                          </p>
                          <ul className="mt-1.5 space-y-1.5">
                            {msg.citations.map((cit) => (
                              <li
                                key={cit.id}
                                className="rounded-lg border border-[#B08A4A]/20 bg-white px-2.5 py-1.5 text-[11px] text-[#2B2019]"
                              >
                                <p className="font-medium text-[#1C1410]">
                                  {cit.title}
                                  {cit.source ? (
                                    <span className="ml-1.5 font-mono text-[10px] text-[#8A672C]">
                                      · {cit.source}
                                    </span>
                                  ) : null}
                                </p>
                                {cit.excerpt ? (
                                  <p className="mt-0.5 text-[10.5px] leading-snug text-[#5C4B41]">
                                    {cit.excerpt}
                                  </p>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {/* Recommended Product Cards with PDP link + Direct Virtual Try-On launch */}
                      {!isUser &&
                      msg.recommendedProducts &&
                      msg.recommendedProducts.length > 0 ? (
                        <div className="mt-3 space-y-2">
                          <p className="text-[10px] font-semibold tracking-[0.14em] uppercase text-[#8A672C]">
                            Thiết kế gợi ý còn hàng
                          </p>
                          <div className="space-y-2">
                            {msg.recommendedProducts.map((item) => (
                              <div
                                key={`${msg.id}-${item.slug}-${item.productId}`}
                                data-testid="storefront-chat-product-card"
                                className="flex gap-3 rounded-xl border border-[#B08A4A]/30 bg-[#FBF7EF] p-2.5 transition-colors hover:border-[#8A672C]"
                              >
                                <div className="aspect-[3/4] w-14 shrink-0 overflow-hidden rounded-lg border border-[#B08A4A]/25 bg-[#F4EBDA]">
                                  <img
                                    src={item.thumbnailUrl}
                                    alt={item.name}
                                    loading="lazy"
                                    className="h-full w-full object-cover"
                                  />
                                </div>
                                <div className="flex min-w-0 flex-1 flex-col justify-between">
                                  <div>
                                    <p className="line-clamp-2 text-xs font-medium text-[#1C1410]">
                                      {item.name}
                                    </p>
                                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                      {typeof item.priceVnd === 'number' &&
                                      item.priceVnd > 0 ? (
                                        <span className="font-mono text-[11px] font-semibold text-[#8A672C]">
                                          {FORMAT_VND(item.priceVnd)}
                                        </span>
                                      ) : null}
                                      {item.recommendedSize ? (
                                        <span className="rounded-full bg-[#1C1410] px-2 py-0.5 font-mono text-[10px] font-medium text-[#EBCF8F]">
                                          Size {item.recommendedSize}
                                        </span>
                                      ) : null}
                                      {item.colorName ? (
                                        <span className="text-[10px] text-[#7A6A5B]">
                                          {item.colorName}
                                        </span>
                                      ) : null}
                                    </div>
                                  </div>

                                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                    <Link
                                      href={`/san-pham/${encodeURIComponent(item.slug)}`}
                                      onClick={() => onOpenChange(false)}
                                      className="rounded-full border border-[#B08A4A]/50 bg-white px-2.5 py-1 text-[10.5px] font-medium text-[#1C1410] transition-colors hover:border-[#1C1410] hover:bg-[#F4EBDA]"
                                    >
                                      Xem chi tiết
                                    </Link>
                                    <button
                                      type="button"
                                      data-testid="storefront-chat-tryon-btn"
                                      onClick={() => handleLaunchTryOn(item)}
                                      className="cursor-pointer rounded-full bg-[#1C1410] px-2.5 py-1 text-[10.5px] font-medium text-[#EBCF8F] transition-opacity hover:opacity-90"
                                    >
                                      ✦ Thử đồ AI
                                    </button>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>

                    <span className="mt-1 px-1 font-mono text-[9.5px] text-[#7A6A5B]">
                      {formatMessageTime(msg.createdAt)}
                    </span>
                  </div>
                );
              })}

              {sending ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="inline-flex items-center gap-2 rounded-2xl rounded-bl-sm border border-[#B08A4A]/28 bg-white px-4 py-3 text-xs text-[#5C4B41]"
                >
                  <span className="inline-flex gap-1">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#B08A4A] [animation-delay:-0.2s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#B08A4A] [animation-delay:-0.1s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#B08A4A]" />
                  </span>
                  <span>Stylist đang tra cứu kho và bảng rập Atelier...</span>
                </div>
              ) : null}

              <div ref={messagesEndRef} />
            </div>

            {/* Composer Form */}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleSendMessage(inputValue);
              }}
              className="shrink-0 border-t border-[#B08A4A]/25 bg-white px-4 py-3.5"
            >
              <div className="flex items-center gap-2">
                <input
                  ref={inputRef}
                  type="text"
                  data-testid="storefront-chat-input"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  disabled={sending}
                  maxLength={600}
                  placeholder="Hỏi về size, phối đồ đi tiệc, đổi trả 7–14 ngày..."
                  className="min-w-0 flex-1 rounded-full border border-[#B08A4A]/40 bg-[#FBF7EF] px-4 py-2.5 text-xs text-[#1C1410] placeholder:text-[#7A6A5B] focus:border-[#1C1410] focus:outline-none disabled:opacity-60"
                />
                <button
                  type="submit"
                  data-testid="storefront-chat-send"
                  disabled={sending || inputValue.trim().length === 0}
                  className="shrink-0 cursor-pointer rounded-full bg-[#1C1410] px-4 py-2.5 text-[11px] font-medium tracking-[0.14em] uppercase text-[#EBCF8F] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  Gửi
                </button>
              </div>
              <p className="mt-2 text-center text-[10px] text-[#7A6A5B]">
                Chỉ sử dụng dữ liệu công khai của cửa hàng · Riêng tư &amp; an toàn
              </p>
            </form>
          </aside>
        </div>
      ) : null}
    </>
  );
}
