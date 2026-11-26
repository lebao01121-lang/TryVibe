'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  CopilotActionCardType,
  Permission,
  Role,
  canReadCostPrice,
  hasPermission,
  type CopilotActionCard,
  type CopilotChatResponseDTO,
} from '@atelier/contracts';
import { adminFetch } from '@/lib/api-client';
import { emitPortalToast } from './PortalToastBanner';

export interface McpCopilotDrawerProps {
  activeRole: Role;
  twoFactorVerified: boolean;
  isOpen: boolean;
  onToggleOpen: () => void;
  initialPrompt?: string | null;
  onConsumeInitialPrompt?: () => void;
  onPromotionApproved?: (promotionId: string) => void;
  onRefreshOverview?: () => void;
}

interface SafetyReportMeta {
  untrustedNotesWrapped?: number;
  promptInjectionDetected?: boolean;
  matchedPatterns?: string[];
  mutatingToolsDisabled?: boolean;
}

type ExtendedCopilotResponse = CopilotChatResponseDTO & {
  traceId?: string;
  safetyReport?: SafetyReportMeta;
  llmBackend?: 'ollama' | 'gemini' | 'rule_fallback';
  geminiConfigured?: boolean;
};

interface OllamaEngineSnapshot {
  reachable: boolean;
  activeMainModel: string;
  activeEmbedModel: string;
  loadedModels: string[];
  lastTokensPerSec: number | null;
}

interface HealthClusterMiniPayload {
  ollama?: {
    reachable?: boolean;
    activeMainModel?: string;
    activeEmbedModel?: string;
    loadedModels?: string[];
  };
}

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  promptText?: string;
  response?: ExtendedCopilotResponse;
  errorCode?: string;
}

interface TurnFeedbackState {
  status: 'idle' | 'selecting_reason' | 'submitting' | 'saved' | 'error';
  rating?: 'UP' | 'DOWN';
  reason?: string;
  customReason?: string;
  showCustomInput?: boolean;
  errorMessage?: string;
}

const COPILOT_DOWN_REASON_CHIPS = [
  'Sai số liệu',
  'Thiếu trích dẫn',
  'Gợi ý chưa khớp tồn kho',
  'Khác',
] as const;

const FORMAT_VND = (amount: number): string =>
  `${new Intl.NumberFormat('vi-VN').format(amount)}₫`;

function getPromptChipsForRole(role: Role): Array<{ label: string; prompt: string }> {
  const chips: Array<{ label: string; prompt: string }> = [];

  if (role === Role.SUPER_ADMIN || role === Role.WAREHOUSE_MANAGER) {
    chips.push({
      label: 'Tín hiệu Try-On & Lập nháp PO size M',
      prompt:
        'Kiểm tra các mẫu áo đang được thử đồ nhiều trong tuần qua mà sắp hết size M và lập nháp đơn nhập hàng',
    });
  }

  if (role === Role.SUPER_ADMIN || role === Role.ORDER_STAFF) {
    chips.push({
      label: 'Phân tích hoàn trả & độ vừa kích cỡ',
      prompt:
        'Phân tích hoàn trả RMA và độ vừa kích cỡ trong 30 ngày qua cho mẫu áo blazer linen',
    });
  }

  if (role === Role.SUPER_ADMIN || role === Role.CATALOG_AI_OPERATOR) {
    chips.push({
      label: 'Kiểm định ảnh áo phẳng 3:4',
      prompt:
        'Kiểm định ảnh áo phẳng 3:4 chuẩn phòng thử đồ AI và tạo bản nháp xem trước',
    });
  }

  chips.push({
    label: 'Tính size chuẩn (156cm / 46kg)',
    prompt:
      'Tính size chuẩn calculate_verified_size cho khách cao 156cm nặng 46kg mẫu áo blazer linen',
  });

  chips.push({
    label: 'Chính sách đổi size 7–14 ngày',
    prompt:
      'Tóm tắt chính sách đổi size 7–14 ngày và 3 tiêu chí kiểm định QC hoàn kho',
  });

  return chips;
}

function resolveTurnTelemetry(resp: ExtendedCopilotResponse) {
  const ot = resp.ollamaTelemetry;
  const llmBackend =
    resp.llmBackend ??
    (resp.modelUsed?.startsWith('gemini:')
      ? 'gemini'
      : (ot?.aiProvider ?? resp.aiProvider ?? (resp.fallbackUsed ? 'rule_fallback' : 'ollama')));
  const aiProvider = ot?.aiProvider ?? resp.aiProvider ?? (resp.fallbackUsed ? 'rule_fallback' : 'ollama');
  const modelUsed = ot?.modelUsed ?? resp.modelUsed;
  const embedModel = ot?.embedModel ?? resp.embedModel ?? 'nomic-embed-text';
  const tokensPerSec =
    typeof ot?.tokensPerSec === 'number'
      ? ot.tokensPerSec
      : typeof resp.tokensPerSec === 'number'
        ? resp.tokensPerSec
        : null;
  const promptEvalCount = ot?.promptEvalCount ?? resp.promptEvalCount ?? null;
  const evalCount = ot?.evalCount ?? resp.evalCount ?? null;
  const costUsd = ot?.costUsd ?? resp.costUsd ?? 0;

  return {
    aiProvider,
    llmBackend,
    modelUsed,
    embedModel,
    tokensPerSec,
    promptEvalCount,
    evalCount,
    costUsd,
  };
}

export function McpCopilotDrawer({
  activeRole,
  twoFactorVerified,
  isOpen,
  onToggleOpen,
  initialPrompt,
  onConsumeInitialPrompt,
  onPromotionApproved,
  onRefreshOverview,
}: McpCopilotDrawerProps) {
  const [inputMessage, setInputMessage] = useState('');
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const lastConsumedPromptRef = useRef<string | null>(null);
  const [cardStates, setCardStates] = useState<
    Record<string, { busy?: boolean; doneLabel?: string; error?: string }>
  >({});
  const [turnFeedbacks, setTurnFeedbacks] = useState<
    Record<string, TurnFeedbackState>
  >({});
  const [ollamaInfo, setOllamaInfo] = useState<OllamaEngineSnapshot>({
    reachable: true,
    activeMainModel: 'qwen2.5:3b',
    activeEmbedModel: 'nomic-embed-text',
    loadedModels: [],
    lastTokensPerSec: null,
  });

  const canSeeCost = canReadCostPrice(activeRole);
  const canApprovePo =
    twoFactorVerified &&
    hasPermission(activeRole, Permission.INVENTORY_PO_APPROVE);
  const canApproveMedia =
    twoFactorVerified &&
    hasPermission(activeRole, Permission.CATALOG_AI_APPROVE);
  const canApprovePromotion =
    (activeRole === Role.SUPER_ADMIN ? twoFactorVerified : true) &&
    (activeRole === Role.SUPER_ADMIN ||
      hasPermission(activeRole, Permission.CATALOG_AI_APPROVE) ||
      hasPermission(activeRole, Permission.CATALOG_PRODUCT_WRITE));
  const canProbeCluster =
    (activeRole === Role.SUPER_ADMIN ||
      activeRole === Role.WAREHOUSE_MANAGER) &&
    twoFactorVerified;

  const promptChips = getPromptChipsForRole(activeRole);

  // Silently fetch live Ollama engine status & loaded models when drawer opens
  useEffect(() => {
    if (!isOpen || !canProbeCluster) return;

    let cancelled = false;
    void adminFetch<HealthClusterMiniPayload>('/api/v1/admin/ops/health-cluster', {
      skipAuthRefresh: true,
      timeoutMs: 5000,
    }).then((res) => {
      if (cancelled || !res.ok || !res.data?.ollama) return;
      const ol = res.data.ollama;
      setOllamaInfo((prev) => ({
        ...prev,
        reachable: ol.reachable ?? prev.reachable,
        activeMainModel: ol.activeMainModel || prev.activeMainModel,
        activeEmbedModel: ol.activeEmbedModel || prev.activeEmbedModel,
        loadedModels: Array.isArray(ol.loadedModels)
          ? ol.loadedModels
          : prev.loadedModels,
      }));
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen, canProbeCluster]);

  const sendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    const userTurnId = `u-${Date.now()}`;
    setTurns((prev) => [
      ...prev,
      { id: userTurnId, role: 'user', text: trimmed },
    ]);
    setInputMessage('');
    setSending(true);

    const res = await adminFetch<ExtendedCopilotResponse>(
      '/api/v1/admin/copilot/chat',
      {
        method: 'POST',
        timeoutMs: 35_000,
        body: JSON.stringify({
          message: trimmed,
          sessionId,
          portal: 'ADMIN_PORTAL',
        }),
      },
    );

    if (res.ok && res.data) {
      if (res.data.sessionId) {
        setSessionId(res.data.sessionId);
      }
      const telem = resolveTurnTelemetry(res.data);
      setOllamaInfo((prev) => ({
        ...prev,
        reachable: telem.aiProvider === 'ollama' ? true : prev.reachable,
        activeMainModel:
          telem.aiProvider === 'ollama' && telem.modelUsed
            ? telem.modelUsed
            : prev.activeMainModel,
        activeEmbedModel: telem.embedModel || prev.activeEmbedModel,
        lastTokensPerSec:
          telem.tokensPerSec != null && telem.tokensPerSec > 0
            ? telem.tokensPerSec
            : prev.lastTokensPerSec,
      }));
      setTurns((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          text: res.data!.reply,
          promptText: trimmed,
          response: res.data!,
        },
      ]);
    } else {
      setTurns((prev) => [
        ...prev,
        {
          id: `e-${Date.now()}`,
          role: 'error',
          errorCode: res.error?.code || `HTTP_${res.status}`,
          text:
            res.error?.message ||
            'Yêu cầu tới MCP Copilot bị từ chối hoặc máy chủ chưa phản hồi.',
        },
      ]);
    }
    setSending(false);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void sendMessage(inputMessage);
  };

  const handleSubmitFeedback = async (
    turn: ChatTurn,
    rating: 'UP' | 'DOWN',
    reason?: string,
  ) => {
    const resp = turn.response;
    const traceId = resp?.traceId || resp?.correlationId || turn.id;
    const trimmedReason = reason?.trim() || undefined;

    setTurnFeedbacks((prev) => ({
      ...prev,
      [turn.id]: {
        ...(prev[turn.id] ?? {}),
        status: 'submitting',
        rating,
        reason: trimmedReason,
        errorMessage: undefined,
      },
    }));

    const res = await adminFetch<unknown>('/api/v1/admin/copilot/feedback', {
      method: 'POST',
      body: JSON.stringify({
        traceId,
        sessionId: resp?.sessionId ?? sessionId,
        portal: 'ADMIN_PORTAL',
        rating,
        ...(trimmedReason ? { reason: trimmedReason } : {}),
        promptText: turn.promptText ?? '',
        responseText: turn.text,
        prompt: turn.promptText ?? '',
        response: turn.text,
      }),
    });

    if (res.ok) {
      setTurnFeedbacks((prev) => ({
        ...prev,
        [turn.id]: {
          status: 'saved',
          rating,
          reason: trimmedReason,
        },
      }));
    } else {
      setTurnFeedbacks((prev) => ({
        ...prev,
        [turn.id]: {
          ...(prev[turn.id] ?? {}),
          status: 'error',
          rating,
          reason: trimmedReason,
          errorMessage:
            res.error?.message ||
            'Chưa thể gửi phản hồi Copilot. Vui lòng thử lại.',
        },
      }));
    }
  };

  const handleApprovePoCard = async (card: CopilotActionCard) => {
    if (!canApprovePo) return;
    const poId =
      card.entityId ||
      (typeof card.payload.poId === 'string' ? card.payload.poId : null) ||
      (typeof card.payload.id === 'string' ? card.payload.id : null);

    if (!poId) {
      setCardStates((prev) => ({
        ...prev,
        [card.id]: { error: 'Thiếu mã PO để duyệt phát hành.' },
      }));
      return;
    }

    setCardStates((prev) => ({ ...prev, [card.id]: { busy: true } }));

    const endpoint =
      card.approveEndpoint && card.approveEndpoint.startsWith('/api/')
        ? card.approveEndpoint
        : `/api/v1/admin/procurement/purchase-orders/${encodeURIComponent(poId)}/submit`;

    const res = await adminFetch<unknown>(endpoint, {
      method: 'POST',
      body: JSON.stringify({}),
    });

    if (res.ok) {
      setCardStates((prev) => ({
        ...prev,
        [card.id]: {
          doneLabel: 'Đã duyệt gửi Đối tác (CHO_NCC_XAC_NHAN)',
        },
      }));
    } else {
      setCardStates((prev) => ({
        ...prev,
        [card.id]: {
          error: res.error?.message || 'Không thể duyệt phát hành PO.',
        },
      }));
    }
  };

  const handleConfirmGarmentCard = async (card: CopilotActionCard) => {
    if (!canApproveMedia) return;
    setCardStates((prev) => ({ ...prev, [card.id]: { busy: true } }));

    if (card.approveEndpoint && card.approveEndpoint.startsWith('/api/')) {
      const res = await adminFetch<unknown>(card.approveEndpoint, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (res.ok) {
        setCardStates((prev) => ({
          ...prev,
          [card.id]: { doneLabel: 'Đã xác nhận gắn ảnh thử đồ' },
        }));
      } else {
        setCardStates((prev) => ({
          ...prev,
          [card.id]: {
            error: res.error?.message || 'Không thể gắn ảnh thử đồ.',
          },
        }));
      }
      return;
    }

    setCardStates((prev) => ({
      ...prev,
      [card.id]: {
        doneLabel:
          'Đã duyệt thủ công — mở AI Lookbook Studio / Media Studio để gắn ảnh',
      },
    }));
  };

  const handleApproveClearanceCard = async (card: CopilotActionCard) => {
    if (!canApprovePromotion) return;
    const promoId =
      card.entityId ||
      (typeof card.payload.promotionId === 'string'
        ? card.payload.promotionId
        : null) ||
      (typeof card.payload.id === 'string' ? card.payload.id : null) ||
      (typeof card.payload.draftId === 'string' ? card.payload.draftId : null);

    if (!promoId) {
      setCardStates((prev) => ({
        ...prev,
        [card.id]: {
          error: 'Thiếu mã chiến dịch khuyến mãi để phê duyệt kích hoạt.',
        },
      }));
      return;
    }

    setCardStates((prev) => ({ ...prev, [card.id]: { busy: true } }));

    const endpoint =
      card.approveEndpoint && card.approveEndpoint.startsWith('/api/')
        ? card.approveEndpoint
        : `/api/v1/admin/promotions/${encodeURIComponent(promoId)}/approve-draft`;

    const res = await adminFetch<unknown>(endpoint, {
      method: 'POST',
      body: JSON.stringify({}),
    });

    if (res.ok) {
      const codeLabel =
        typeof card.payload.code === 'string' ? ` (${card.payload.code})` : '';
      setCardStates((prev) => ({
        ...prev,
        [card.id]: {
          doneLabel: `Đã phê duyệt & Kích hoạt Chiến dịch${codeLabel} → ACTIVE`,
        },
      }));
      emitPortalToast({
        kind: 'success',
        title: 'HITL CHIẾN DỊCH KHUYẾN MÃI',
        message: `Đã phê duyệt & kích hoạt chiến dịch xả kho${codeLabel} lên Storefront.`,
      });
      onPromotionApproved?.(promoId);
      onRefreshOverview?.();
    } else {
      setCardStates((prev) => ({
        ...prev,
        [card.id]: {
          error:
            res.error?.message ||
            'Không thể phê duyệt & kích hoạt chiến dịch khuyến mãi.',
        },
      }));
    }
  };

  // Close slide-over drawer cleanly on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onToggleOpen();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onToggleOpen]);

  // Support 1-click handoff prompts from modules such as AiTryOnAnalyticsTab
  useEffect(() => {
    const trimmed = initialPrompt?.trim();
    if (!trimmed) {
      lastConsumedPromptRef.current = null;
      return;
    }
    if (!isOpen) return;
    if (lastConsumedPromptRef.current === trimmed) return;
    lastConsumedPromptRef.current = trimmed;
    onConsumeInitialPrompt?.();
    if (sending) {
      setInputMessage(trimmed);
    } else {
      void sendMessage(trimmed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialPrompt]);

  if (!isOpen) {
    return (
      <div className="fixed right-5 bottom-5 z-40">
        <div className="telemetry-copilot-halo-wrap shadow-[0_18px_42px_-12px_rgba(22,16,12,0.78)] transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-[0_22px_48px_-12px_rgba(176,138,74,0.48)]">
          <span
            aria-hidden="true"
            className="telemetry-anim telemetry-copilot-halo-ring"
          />
          <button
            type="button"
            data-testid="copilot-floating-launcher"
            onClick={onToggleOpen}
            aria-label="Mở Trợ lý Điều hành AI MCP Copilot"
            className="group relative z-10 flex items-center gap-3 rounded-[14px] bg-gradient-to-r from-[#19120D] via-[#221811] to-[#16100C] px-4 py-2.5 text-left text-[#FBF7EF]"
          >
            <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#EBCF8F]/35 bg-[#B08A4A]/20 text-[#EBCF8F]">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-5 w-5"
                aria-hidden="true"
              >
                <path d="M12 3v3" />
                <rect x="4" y="6" width="16" height="12" rx="3" />
                <path d="M9 11h.01" />
                <path d="M15 11h.01" />
                <path d="M9 15c1 .8 2 .8 3 .8s2 0 3-.8" />
                <path d="M2 12h2" />
                <path d="M20 12h2" />
              </svg>
              <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5 items-center justify-center">
                {ollamaInfo.reachable ? (
                  <span
                    aria-hidden="true"
                    className="telemetry-anim telemetry-beacon-ring absolute inset-0 rounded-full bg-emerald-400/75"
                  />
                ) : null}
                <span
                  className={`relative h-2.5 w-2.5 rounded-full ring-2 ring-[#19120D] ${
                    ollamaInfo.reachable ? 'bg-emerald-400' : 'bg-amber-400'
                  }`}
                />
              </span>
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-[0.11em] text-[#FBF7EF]">
                  TRỢ LÝ ĐIỀU HÀNH AI
                </span>
                <span className="rounded-md border border-[#EBCF8F]/40 bg-[#B08A4A]/20 px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-[0.06em] text-[#EBCF8F]">
                  LLM + MCP
                </span>
              </span>
              <span className="mt-0.5 block font-mono text-[10px] text-[#EBCF8F]/80">
                Ollama {ollamaInfo.activeMainModel} · MCP + HITL
                {turns.length > 0 ? ` · ${turns.length} lượt` : ''}
              </span>
            </span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onToggleOpen}
        className="fixed inset-0 z-40 bg-[#0D0805]/50 backdrop-blur-[2px]"
      />
      <aside
        data-testid="mcp-copilot-drawer"
        aria-label="MCP Copilot Drawer"
        className="adm-drawer-enter fixed top-0 right-0 bottom-0 z-50 flex w-full max-w-[440px] flex-col border-l border-[#B08A4A]/35 bg-[#16100C] text-[#FBF7EF] shadow-[-24px_0_64px_-16px_rgba(0,0,0,0.65)]"
      >
      {/* Header + Quiet Luxury Local Ollama Badge */}
      <div className="border-b border-[#B08A4A]/20 px-5 py-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="ledger-eyebrow text-[#EBCF8F]">
              MCP Copilot · Port 4010 · 8-Layer Harness
            </p>
            <h2 className="font-editorial mt-0.5 text-2xl font-light text-[#FBF7EF]">
              Trợ lý Điều hành (Human-in-the-Loop)
            </h2>
          </div>
          <button
            type="button"
            onClick={onToggleOpen}
            className="shrink-0 rounded-full border border-[#EBCF8F]/35 px-3 py-1 text-[11px] uppercase tracking-[0.16em] text-[#EBCF8F] hover:bg-[#2A1E17]"
          >
            Thu gọn
          </button>
        </div>

        {/* Local AI Ollama Quiet Luxury Pill Badge */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#EBCF8F]/55 bg-[#2A1E17] px-3 py-1 text-[10px] font-medium tracking-[0.06em] text-[#EBCF8F]">
            <span
              className={`h-2 w-2 rounded-full ${
                ollamaInfo.reachable ? 'bg-emerald-400' : 'bg-amber-400'
              }`}
            />
            Local AI · Ollama Qwen 2.5 (0₫ / Offline Privacy)
          </span>
        </div>

        {/* Live Ollama Model, Speed & Loaded Models Strip */}
        <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[10px] text-[#FBF7EF]/75">
          <span className="rounded bg-[#241A14] px-2 py-0.5 text-[#EBCF8F]">
            Model: {ollamaInfo.activeMainModel}
          </span>
          {ollamaInfo.lastTokensPerSec != null ? (
            <span className="rounded bg-[#241A14] px-2 py-0.5 text-emerald-300">
              {ollamaInfo.lastTokensPerSec.toFixed(1)} tokens/s
            </span>
          ) : null}
          {ollamaInfo.loadedModels.length > 0 ? (
            <span className="rounded bg-[#241A14] px-2 py-0.5">
              {ollamaInfo.loadedModels.length} models nạp sẵn
            </span>
          ) : null}
        </div>
      </div>

      {/* Role & Guardrail Banner */}
      <div className="border-b border-[#B08A4A]/15 bg-[#241A14] px-5 py-3 text-[11px]">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[#EBCF8F]">
            JWT Pass-Through · {activeRole}
          </span>
          <span className="rounded-full border border-[#EBCF8F]/35 px-2 py-0.5 font-mono text-[10px] text-[#EBCF8F]">
            STRICT NHAP_AI
          </span>
        </div>
        <p className="mt-1 text-[#FBF7EF]/70">
          Chạy 100% nội bộ qua <strong>Ollama Qwen 2.5 Local AI</strong> (0₫),
          khóa mọi lệnh ghi ở <code>NHAP_AI</code> và cách ly ghi chú khách
          hàng trong sandbox.
        </p>
      </div>

      {/* Quick 1-Click Role-Appropriate Prompt Chips */}
      <div className="border-b border-[#B08A4A]/15 px-5 py-3">
        <p className="text-[10px] uppercase tracking-[0.16em] text-[#EBCF8F]/75">
          Gợi ý tác vụ nhanh theo vai trò
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {promptChips.map((chip) => (
            <button
              key={chip.label}
              type="button"
              disabled={sending}
              onClick={() => void sendMessage(chip.prompt)}
              className="rounded-full border border-[#B08A4A]/45 bg-[#2A1E17] px-3 py-1 text-left text-[11px] text-[#EBCF8F] transition-colors hover:bg-[#B08A4A] hover:text-[#1C1410] disabled:opacity-45"
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>

      {/* Conversation Stream */}
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {turns.length === 0 ? (
          <div className="rounded-2xl border border-[#B08A4A]/25 bg-[#241A14] p-4 text-xs text-[#FBF7EF]/75">
            <p className="font-medium text-[#EBCF8F]">
              Sẵn sàng suy luận nội bộ · Ollama Qwen 2.5 Local AI
            </p>
            <p className="mt-1.5 leading-relaxed">
              Chọn 1 câu lệnh nhanh phía trên hoặc nhập yêu cầu phân tích tồn
              kho, tín hiệu thử đồ AI, RMA hay kiểm định ảnh 3:4 để gọi công cụ
              MCP thực tế qua BFF.
            </p>
          </div>
        ) : null}

        {turns.map((turn) => {
          if (turn.role === 'user') {
            return (
              <div key={turn.id} className="flex justify-end">
                <div className="max-w-[88%] rounded-2xl rounded-tr-sm bg-[#B08A4A] px-4 py-2.5 text-xs text-[#1C1410]">
                  {turn.text}
                </div>
              </div>
            );
          }

          if (turn.role === 'error') {
            return (
              <div
                key={turn.id}
                role="alert"
                className="rounded-2xl border border-[#E57373]/45 bg-[#3B1D1D] p-3.5 text-xs text-[#FFD6D6]"
              >
                <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em]">
                  [{turn.errorCode}]
                </p>
                <p className="mt-1">{turn.text}</p>
              </div>
            );
          }

          const resp = turn.response;
          const safety = resp?.safetyReport;
          const telem = resp ? resolveTurnTelemetry(resp) : null;
          const hasUntrustedSandbox =
            Boolean(safety?.promptInjectionDetected) ||
            Boolean(
              safety?.untrustedNotesWrapped && safety.untrustedNotesWrapped > 0,
            ) ||
            Boolean(resp?.guardrailBlocked);

          return (
            <div key={turn.id} className="space-y-3">
              {/* Assistant Reply Bubble */}
              <div className="rounded-2xl rounded-tl-sm border border-[#B08A4A]/30 bg-[#241A14] p-4 text-xs">
                {resp && telem ? (
                  <div className="mb-2 flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-[#EBCF8F]/85">
                    <span className="rounded bg-[#1C1410] px-2 py-0.5">
                      Tier {resp.tierUsed}
                    </span>
                    <span className="rounded bg-[#1C1410] px-2 py-0.5">
                      {telem.llmBackend === 'gemini'
                        ? `Gemini API · ${telem.modelUsed}`
                        : telem.aiProvider === 'ollama'
                          ? `Ollama · ${telem.modelUsed}`
                          : telem.modelUsed}
                    </span>
                    {telem.tokensPerSec != null && telem.tokensPerSec > 0 ? (
                      <span className="rounded bg-[#1E4B32] px-2 py-0.5 text-emerald-100">
                        {telem.tokensPerSec.toFixed(1)} tok/s
                      </span>
                    ) : null}
                    {resp.cacheHit ? (
                      <span className="rounded bg-[#1E4B32] px-2 py-0.5 text-white">
                        CACHE_HIT
                      </span>
                    ) : null}
                  </div>
                ) : null}

                {/* Untrusted Customer Data Sandbox Badge */}
                {hasUntrustedSandbox ? (
                  <div
                    data-testid="copilot-untrusted-sandbox-badge"
                    className="mb-2.5 rounded-xl border border-[#EBCF8F]/55 bg-[#332316] p-2.5 text-[11px] text-[#EBCF8F]"
                  >
                    <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em]">
                      UNTRUSTED CUSTOMER DATA SANDBOX ACTIVE
                    </p>
                    <p className="mt-0.5 text-[#FBF7EF]/85">
                      {safety?.promptInjectionDetected
                        ? 'Đã phát hiện & cô lập chỉ thị Prompt Injection trong ghi chú khách hàng — khóa toàn bộ công cụ ghi (0 hành động trái phép).'
                        : `Đã bọc an toàn ${safety?.untrustedNotesWrapped ?? 1} ghi chú khách hàng trong <untrusted_customer_note>.`}
                    </p>
                  </div>
                ) : null}

                <p className="whitespace-pre-line leading-relaxed text-[#FBF7EF]/92">
                  {turn.text}
                </p>

                {/* Per-Message Ollama Telemetry Footer */}
                {telem ? (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#B08A4A]/15 pt-2 font-mono text-[10px] text-[#EBCF8F]/75">
                    <span>
                      {telem.llmBackend === 'gemini'
                        ? `Gemini API (${telem.modelUsed})`
                        : telem.aiProvider === 'ollama'
                          ? `Ollama Qwen 2.5 (${telem.modelUsed})`
                          : 'RuleBased Fallback'}
                      {telem.evalCount != null
                        ? ` · ${telem.promptEvalCount ?? 0}→${telem.evalCount} tok`
                        : ''}
                    </span>
                    <span className="text-emerald-300">
                      {telem.tokensPerSec != null && telem.tokensPerSec > 0
                        ? `${telem.tokensPerSec.toFixed(1)} tokens/s · `
                        : ''}
                      {telem.costUsd === 0
                        ? '0₫ ($0.00)'
                        : `$${telem.costUsd.toFixed(4)}`}
                    </span>
                  </div>
                ) : null}

                {/* Tool Execution Trace */}
                {resp && resp.toolTraces.length > 0 ? (
                  <div className="mt-3 border-t border-[#B08A4A]/20 pt-2.5">
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#EBCF8F]/75">
                      Tool Execution Trace ({resp.toolTraces.length})
                    </p>
                    <ul className="mt-1.5 space-y-1">
                      {resp.toolTraces.map((trace, idx) => (
                        <li
                          key={`${trace.toolName}-${idx}`}
                          className="flex flex-wrap items-center justify-between gap-1 rounded-lg bg-[#1C1410] px-2.5 py-1.5 font-mono text-[10px]"
                        >
                          <span className="text-[#EBCF8F]">
                            {trace.toolName}
                          </span>
                          <span className="text-[#FBF7EF]/70">
                            {trace.authorized ? 'AUTH_OK' : '403_DENIED'} ·{' '}
                            {trace.mode} · {Math.round(trace.latencyMs)}ms
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {/* Hybrid RAG Citations */}
                {resp && resp.citations.length > 0 ? (
                  <div className="mt-3 border-t border-[#B08A4A]/20 pt-2.5">
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#EBCF8F]/75">
                      Hybrid RAG Citations · 768-dim ({resp.citations.length})
                    </p>
                    <div className="mt-1.5 space-y-1.5">
                      {resp.citations.map((cit) => (
                        <div
                          key={cit.sourceId}
                          className="rounded-lg border border-[#B08A4A]/20 bg-[#1C1410]/80 p-2 text-[11px]"
                        >
                          <p className="font-medium text-[#EBCF8F]">
                            {cit.title}{' '}
                            <span className="font-mono text-[10px] opacity-70">
                              ({cit.score.toFixed(2)})
                            </span>
                          </p>
                          <p className="mt-0.5 line-clamp-2 text-[#FBF7EF]/75">
                            {cit.snippet}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {/* Assistant Feedback (👍 Hữu ích / 👎 Cần cải thiện) */}
                {(() => {
                  const fb = turnFeedbacks[turn.id] ?? { status: 'idle' };
                  const isBusy = fb.status === 'submitting';

                  if (fb.status === 'saved') {
                    return (
                      <div
                        data-testid="copilot-feedback-saved"
                        className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#B08A4A]/20 pt-2.5 text-[11px] text-emerald-300"
                      >
                        <span className="font-medium">
                          ✓ Đã ghi nhận phản hồi
                          {fb.rating === 'UP'
                            ? ' (👍 Hữu ích)'
                            : fb.reason
                              ? ` (👎 ${fb.reason})`
                              : ' (👎 Cần cải thiện)'}
                        </span>
                      </div>
                    );
                  }

                  return (
                    <div className="mt-3 border-t border-[#B08A4A]/20 pt-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          data-testid="copilot-feedback-up"
                          disabled={isBusy}
                          onClick={() => void handleSubmitFeedback(turn, 'UP')}
                          className="inline-flex items-center gap-1 rounded-full border border-[#B08A4A]/35 bg-[#1C1410] px-2.5 py-1 text-[10px] font-medium text-[#EBCF8F] transition-colors hover:border-emerald-400/60 hover:bg-emerald-950/60 hover:text-emerald-200 disabled:opacity-45"
                        >
                          👍 Hữu ích
                        </button>
                        <button
                          type="button"
                          data-testid="copilot-feedback-down"
                          disabled={isBusy}
                          onClick={() =>
                            setTurnFeedbacks((prev) => ({
                              ...prev,
                              [turn.id]: {
                                ...(prev[turn.id] ?? {}),
                                status:
                                  prev[turn.id]?.status === 'selecting_reason'
                                    ? 'idle'
                                    : 'selecting_reason',
                                rating: 'DOWN',
                                errorMessage: undefined,
                              },
                            }))
                          }
                          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors disabled:opacity-45 ${
                            fb.status === 'selecting_reason'
                              ? 'border-rose-400/70 bg-rose-950/70 text-rose-200'
                              : 'border-[#B08A4A]/35 bg-[#1C1410] text-[#FBF7EF]/80 hover:border-rose-400/60 hover:bg-rose-950/50 hover:text-rose-200'
                          }`}
                        >
                          👎 Cần cải thiện
                        </button>
                        {isBusy ? (
                          <span className="font-mono text-[10px] text-[#EBCF8F]/70">
                            Đang lưu phản hồi...
                          </span>
                        ) : null}
                      </div>

                      {fb.status === 'selecting_reason' ? (
                        <div className="mt-2 space-y-2 rounded-xl border border-[#B08A4A]/25 bg-[#1C1410]/90 p-2.5">
                          <p className="text-[10px] uppercase tracking-[0.12em] text-[#EBCF8F]/75">
                            Chọn lý do cần cải thiện:
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {COPILOT_DOWN_REASON_CHIPS.map((chip) => (
                              <button
                                key={chip}
                                type="button"
                                disabled={isBusy}
                                onClick={() => {
                                  if (chip === 'Khác') {
                                    setTurnFeedbacks((prev) => ({
                                      ...prev,
                                      [turn.id]: {
                                        ...(prev[turn.id] ?? {
                                          status: 'selecting_reason',
                                        }),
                                        status: 'selecting_reason',
                                        rating: 'DOWN',
                                        showCustomInput: true,
                                      },
                                    }));
                                  } else {
                                    void handleSubmitFeedback(
                                      turn,
                                      'DOWN',
                                      chip,
                                    );
                                  }
                                }}
                                className="rounded-full border border-[#B08A4A]/40 bg-[#2A1E17] px-2.5 py-1 text-[10px] text-[#EBCF8F] transition-colors hover:bg-[#B08A4A] hover:text-[#1C1410] disabled:opacity-45"
                              >
                                {chip}
                              </button>
                            ))}
                          </div>

                          {fb.showCustomInput ? (
                            <div className="flex gap-1.5 pt-1">
                              <input
                                type="text"
                                value={fb.customReason ?? ''}
                                onChange={(e) =>
                                  setTurnFeedbacks((prev) => ({
                                    ...prev,
                                    [turn.id]: {
                                      ...(prev[turn.id] ?? {
                                        status: 'selecting_reason',
                                      }),
                                      status: 'selecting_reason',
                                      showCustomInput: true,
                                      customReason: e.target.value,
                                    },
                                  }))
                                }
                                placeholder="Mô tả ngắn vấn đề (tùy chọn)..."
                                className="min-w-0 flex-1 rounded-full border border-[#B08A4A]/40 bg-[#241A14] px-3 py-1 text-[11px] text-[#FBF7EF] placeholder:text-[#FBF7EF]/45 outline-none focus:border-[#EBCF8F]"
                              />
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() =>
                                  void handleSubmitFeedback(
                                    turn,
                                    'DOWN',
                                    fb.customReason?.trim() || 'Khác',
                                  )
                                }
                                className="rounded-full bg-[#EBCF8F] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#1C1410] disabled:opacity-45"
                              >
                                Gửi
                              </button>
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      {fb.status === 'error' && fb.errorMessage ? (
                        <p className="mt-1.5 text-[10px] text-rose-300">
                          {fb.errorMessage}
                        </p>
                      ) : null}
                    </div>
                  );
                })()}
              </div>

              {/* Live Interactive Action Cards */}
              {resp && resp.actionCards.length > 0
                ? resp.actionCards.map((card, cardIdx) => {
                    const cardState = cardStates[card.id];
                    const itemsList = Array.isArray(card.payload.items)
                      ? (card.payload.items as Array<Record<string, unknown>>)
                      : [];
                    const previewUrl =
                      typeof card.payload.previewUrl === 'string'
                        ? card.payload.previewUrl
                        : null;

                    return (
                      <article
                        key={card.id}
                        data-testid="copilot-action-card"
                        style={
                          { '--row-idx': cardIdx } as React.CSSProperties
                        }
                        className="telemetry-anim telemetry-row-stagger telemetry-row-flash rounded-2xl border border-[#B08A4A]/50 bg-[#FBF7EF] p-4 text-xs text-[#2B2019]"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="rounded-full bg-[#1C1410] px-2.5 py-0.5 font-mono text-[10px] font-semibold text-[#EBCF8F]">
                              {card.status}
                            </span>
                            {typeof card.payload.nguonTao === 'string' ||
                            typeof card.payload.createdSource === 'string' ? (
                              <span className="rounded-full border border-[#B08A4A]/45 bg-white px-2 py-0.5 font-mono text-[10px] text-[#8A672C]">
                                nguonTao:{' '}
                                {String(
                                  card.payload.nguonTao ??
                                    card.payload.createdSource,
                                )}
                              </span>
                            ) : null}
                          </div>
                          <span className="font-mono text-[10px] text-[#8A672C]">
                            {card.type}
                          </span>
                        </div>

                        <h3 className="font-editorial mt-2 text-2xl text-[#1C1410]">
                          {card.title}
                        </h3>
                        <p className="mt-1 text-[11px] leading-relaxed text-[#5C4B41]">
                          {card.summary}
                        </p>

                        {/* PO_DRAFT_CREATED Payload Details */}
                        {card.type ===
                        CopilotActionCardType.PO_DRAFT_CREATED ? (
                          <div className="mt-3 space-y-2">
                            {itemsList.length > 0 ? (
                              <ul className="space-y-1 rounded-xl bg-[#F4EBDA]/80 p-2.5 font-mono text-[11px]">
                                {itemsList.map((line, i) => {
                                  const unitCost =
                                    typeof line.unitCostVnd === 'number'
                                      ? line.unitCostVnd
                                      : typeof line.cost_price === 'number'
                                        ? line.cost_price
                                        : null;
                                  return (
                                    <li
                                      key={i}
                                      className="flex items-center justify-between"
                                    >
                                      <span>
                                        {String(
                                          line.skuCode ?? line.skuId ?? 'SKU',
                                        )}{' '}
                                        ×{' '}
                                        {String(
                                          line.orderedQty ??
                                            line.quantity ??
                                            1,
                                        )}
                                      </span>
                                      <span>
                                        {canSeeCost && unitCost != null
                                          ? `${FORMAT_VND(unitCost)}/sp`
                                          : '[RBAC]'}
                                      </span>
                                    </li>
                                  );
                                })}
                              </ul>
                            ) : null}

                            {cardState?.doneLabel ? (
                              <p className="rounded-xl border border-[#2E6B47]/35 bg-[#F2FBF6] px-3 py-2 text-[11px] font-medium text-[#1E4B32]">
                                {cardState.doneLabel}
                              </p>
                            ) : (
                              <button
                                type="button"
                                data-testid="copilot-po-approve-btn"
                                disabled={!canApprovePo || cardState?.busy}
                                onClick={() => void handleApprovePoCard(card)}
                                className="w-full rounded-full bg-[#1C1410] px-4 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-[#EBCF8F] disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                {cardState?.busy
                                  ? 'Đang duyệt gửi Đối tác...'
                                  : 'Duyệt gửi Đối tác'}
                              </button>
                            )}

                            {!canApprovePo ? (
                              <p className="text-[10px] text-[#8B2E2E]">
                                {!twoFactorVerified
                                  ? 'Cần xác thực 2FA để duyệt đơn nhập hàng.'
                                  : `Vai trò ${activeRole} không có quyền inventory.po.approve.`}
                              </p>
                            ) : null}
                          </div>
                        ) : null}

                        {/* GARMENT_IMAGE_PROCESSED Payload Details */}
                        {card.type ===
                        CopilotActionCardType.GARMENT_IMAGE_PROCESSED ? (
                          <div className="mt-3 space-y-2">
                            <div className="flex flex-wrap gap-1.5 font-mono text-[10px]">
                              <span className="rounded bg-[#1C1410] px-2 py-0.5 text-[#EBCF8F]">
                                attached: false
                              </span>
                              <span className="rounded bg-[#F4EBDA] px-2 py-0.5 text-[#8A672C]">
                                autoAttachAsTryOnGarment: false
                              </span>
                            </div>

                            {previewUrl ? (
                              <img
                                src={previewUrl}
                                alt="Garment draft preview"
                                className="max-h-36 w-full rounded-xl bg-white object-contain p-2"
                              />
                            ) : null}

                            {cardState?.doneLabel ? (
                              <p className="rounded-xl border border-[#2E6B47]/35 bg-[#F2FBF6] px-3 py-2 text-[11px] font-medium text-[#1E4B32]">
                                {cardState.doneLabel}
                              </p>
                            ) : (
                              <button
                                type="button"
                                disabled={!canApproveMedia || cardState?.busy}
                                onClick={() =>
                                  void handleConfirmGarmentCard(card)
                                }
                                className="w-full rounded-full bg-[#1C1410] px-4 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-[#EBCF8F] disabled:opacity-40"
                              >
                                {cardState?.busy
                                  ? 'Đang xác nhận...'
                                  : 'Xác nhận gắn ảnh thử đồ'}
                              </button>
                            )}
                          </div>
                        ) : null}

                        {/* CLEARANCE_CAMPAIGN_DRAFT: 1-Click HITL Promotion Activation */}
                        {card.type ===
                        CopilotActionCardType.CLEARANCE_CAMPAIGN_DRAFT ? (
                          <div className="mt-3 space-y-2.5">
                            <div className="space-y-1 rounded-xl bg-[#F4EBDA]/80 p-2.5 font-mono text-[11px] text-[#2B2019]">
                              {typeof card.payload.code === 'string' ? (
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-[#7A6A5B]">Mã Voucher</span>
                                  <strong className="rounded bg-[#1C1410] px-2 py-0.5 text-[#EBCF8F]">
                                    {card.payload.code}
                                  </strong>
                                </div>
                              ) : null}
                              {(typeof card.payload.discountPercent === 'number' ||
                                typeof card.payload.discountValue === 'number') ? (
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-[#7A6A5B]">Mức giảm xả kho</span>
                                  <strong className="text-[#1E4B32]">
                                    {String(
                                      card.payload.discountPercent ??
                                        card.payload.discountValue,
                                    )}
                                    %
                                  </strong>
                                </div>
                              ) : null}
                              {Array.isArray(card.payload.targetSkuCodes) &&
                              card.payload.targetSkuCodes.length > 0 ? (
                                <div className="pt-1 text-[10px] text-[#5C4B41]">
                                  SKU áp dụng:{' '}
                                  {(card.payload.targetSkuCodes as unknown[])
                                    .map(String)
                                    .join(', ')}
                                </div>
                              ) : null}
                            </div>

                            {cardState?.doneLabel ? (
                              <p
                                data-testid="copilot-clearance-approved-badge"
                                className="rounded-xl border border-[#2E6B47]/35 bg-[#F2FBF6] px-3 py-2 text-[11px] font-medium text-[#1E4B32]"
                              >
                                ✓ {cardState.doneLabel}
                              </p>
                            ) : (
                              <button
                                type="button"
                                data-testid="copilot-clearance-approve-btn"
                                disabled={!canApprovePromotion || cardState?.busy}
                                onClick={() =>
                                  void handleApproveClearanceCard(card)
                                }
                                className="w-full rounded-full bg-[#1C1410] px-4 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-[#EBCF8F] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                {cardState?.busy
                                  ? 'Đang phê duyệt & kích hoạt...'
                                  : 'Phê duyệt & Kích hoạt Chiến dịch'}
                              </button>
                            )}

                            {!canApprovePromotion ? (
                              <p className="text-[10px] text-[#8B2E2E]">
                                {!twoFactorVerified
                                  ? 'Cần xác thực 2FA để phê duyệt chiến dịch khuyến mãi.'
                                  : `Vai trò ${activeRole} không có quyền phê duyệt chiến dịch khuyến mãi.`}
                              </p>
                            ) : null}
                          </div>
                        ) : null}

                        {/* SIZING_ADJUSTMENT_PROPOSAL */}
                        {card.type ===
                        CopilotActionCardType.SIZING_ADJUSTMENT_PROPOSAL ? (
                          <div className="mt-2.5 rounded-xl bg-[#F4EBDA]/80 p-2.5 text-[11px] text-[#5C4B41]">
                            Đề xuất chỉ đọc / nháp nội bộ — nhân sự xem xét và
                            áp dụng trong phân hệ chuyên môn.
                          </div>
                        ) : null}

                        {cardState?.error ? (
                          <p className="mt-2 text-[11px] text-[#8B2E2E]">
                            {cardState.error}
                          </p>
                        ) : null}
                      </article>
                    );
                  })
                : null}
            </div>
          );
        })}

        {sending ? (
          <div className="relative overflow-hidden rounded-2xl border border-[#EBCF8F]/45 bg-[#241A14] px-4 py-3 text-xs text-[#EBCF8F]">
            <span
              aria-hidden="true"
              className="telemetry-anim telemetry-sheen opacity-40"
            />
            <div className="relative flex items-center gap-2.5">
              <span className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center">
                <span
                  aria-hidden="true"
                  className="telemetry-anim telemetry-beacon-ring absolute inset-0 rounded-full bg-emerald-400/75"
                />
                <span className="relative h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              <span>
                Ollama Qwen 2.5 Local AI đang thực thi công cụ qua BFF với JWT của
                bạn...
              </span>
            </div>
          </div>
        ) : null}
      </div>

      {/* Chat Composer */}
      <form
        onSubmit={handleSubmit}
        className="border-t border-[#B08A4A]/25 bg-[#150F0C] p-4"
      >
        <div className="flex gap-2">
          <input
            type="text"
            data-testid="copilot-input"
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            placeholder="Nhập câu hỏi vận hành cho Ollama MCP Copilot..."
            disabled={sending}
            className="min-w-0 flex-1 rounded-full border border-[#B08A4A]/40 bg-[#241A14] px-4 py-2 text-xs text-[#FBF7EF] placeholder:text-[#FBF7EF]/45 outline-none focus:border-[#EBCF8F]"
          />
          <button
            type="submit"
            data-testid="copilot-send-btn"
            disabled={sending || !inputMessage.trim()}
            className="rounded-full bg-[#EBCF8F] px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-[#1C1410] disabled:opacity-40"
          >
            Gửi
          </button>
        </div>
      </form>
      </aside>
    </>
  );
}
