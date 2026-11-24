'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Role } from '@atelier/contracts';
import { adminFetch } from '@/lib/api-client';
import { emitPortalToast } from '@/components/PortalToastBanner';

export interface AiOpsHealthTabProps {
  roles: readonly Role[];
  mfaVerified: boolean;
}

type NodeHealthStatus = 'UP' | 'DEGRADED' | 'DOWN';

interface ClusterNodeHealth {
  name: string;
  port?: number | string;
  status: NodeHealthStatus;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

interface OllamaClusterSummary {
  reachable?: boolean;
  baseUrl?: string;
  activeMainModel?: string;
  activeEmbedModel?: string;
  loadedModels?: string[];
}

interface HealthClusterPayload {
  checkedAt?: string;
  overallStatus?: NodeHealthStatus;
  services?: ClusterNodeHealth[];
  infra?: ClusterNodeHealth[];
  ollama?: OllamaClusterSummary;
}

interface DlqMessageItem {
  routingKey?: string;
  correlationId?: string | null;
  retryCount?: number;
  failureReason?: string | null;
  payload?: unknown;
}

interface DlqQueueEntry {
  name: string;
  messageCount: number;
  state?: string;
  messages?: DlqMessageItem[];
}

interface DlqListPayload {
  queues?: DlqQueueEntry[];
  source?: string;
}

interface RmaExchangeRow {
  productId: string;
  productName?: string;
  skuCode?: string;
  totalRmas?: number;
  sizeExchangeCount?: number;
  sizeExchangeRatePct?: number;
  returnRatePct?: number;
  dominantReasonCode?: string;
}

interface LocalAiFunnelSummary {
  provider?: string;
  badge?: string;
  activeMainModel?: string;
  activeFastModel?: string;
  activeEmbedModel?: string;
  embedDim?: number;
  loadedModels?: string[];
  avgTokensPerSec?: number;
  totalPromptTokens?: number;
  totalEvalTokens?: number;
  localInferenceCostUsd?: number;
  fallbackMode?: boolean;
}

interface AiFunnelPayload {
  localAi?: LocalAiFunnelSummary;
  funnel?: {
    rackOrOutfitInteractions?: number;
    tryOnModalOpens?: number;
    tryOnCompleted?: number;
    tryOnMockCount?: number;
    tryOnFalCount?: number;
    tryOnCacheHitCount?: number;
    addToCartAfterTryOn?: number;
    paidOrders?: number;
  };
  tryon?: {
    totalSessions?: number;
    completedSessions?: number;
    mockCount?: number;
    falCount?: number;
    cacheHitCount?: number;
    openModalSignals?: number;
    addToCartAfterTryOnSignals?: number;
    cacheHitSavingsPct?: number;
    estimatedTotalCostUsd?: number;
  };
  orders?: {
    totalOrders?: number;
    paidOrders?: number;
    deliveredOrders?: number;
    totalRmas?: number;
  };
  payments?: {
    succeededCharges?: number;
    totalPaidVnd?: number;
    totalRefundedVnd?: number;
  };
  copilot?: {
    totalChatTurns?: number;
    semanticCacheHits?: number;
    semanticCacheHitRatePct?: number;
    promptInjectionsBlocked?: number;
    rbacDenials?: number;
    aiProvider?: string;
    modelUsed?: string;
    embedModel?: string;
    tokensPerSec?: number;
    costUsd?: number;
  };
  inventory?: {
    lowStockCount?: number;
    outOfStockCount?: number;
    activeReservationsCount?: number;
    pendingAiDraftPosCount?: number;
  };
  estimatedAiCostPerOrderUsd?: number;
  cacheHitSavingsPct?: number;
  rmaSizeExchangeByProduct?: RmaExchangeRow[];
}

const DEFAULT_DLQ_NAMES = [
  'order.saga.dlq',
  'payment.webhook.dlq',
  'notify.zns.dlq',
  'tryon.jobs.dlq',
] as const;

function normalizeStatus(raw: unknown): NodeHealthStatus {
  const s = String(raw ?? '').toUpperCase();
  if (s === 'UP' || s === 'OK' || s === 'HEALTHY') return 'UP';
  if (s === 'DEGRADED' || s === 'WARN') return 'DEGRADED';
  return 'DOWN';
}

const STATUS_PILL_STYLE: Record<NodeHealthStatus, string> = {
  UP: 'border-[#2E6B47]/45 bg-[#EBF9F1] text-[#1E4B32]',
  DEGRADED: 'border-[#D9822B]/50 bg-[#FFF6E5] text-[#9A5B13]',
  DOWN: 'border-[#8B2E2E]/50 bg-[#FFF5F4] text-[#8B2E2E]',
};

function formatDateTime(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('vi-VN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      day: '2-digit',
      month: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 19);
  }
}

export function AiOpsHealthTab({ roles, mfaVerified }: AiOpsHealthTabProps) {
  const [cluster, setCluster] = useState<HealthClusterPayload | null>(null);
  const [dlqQueues, setDlqQueues] = useState<DlqQueueEntry[]>([]);
  const [funnel, setFunnel] = useState<AiFunnelPayload | null>(null);

  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [expandedPayloadKey, setExpandedPayloadKey] = useState<string | null>(
    null,
  );
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const canManageDlq = roles.includes(Role.SUPER_ADMIN) && mfaVerified;

  const loadOpsData = useCallback(async () => {
    setLoading(true);
    setErrorBanner(null);

    const [healthRes, dlqRes, funnelRes] = await Promise.all([
      adminFetch<HealthClusterPayload>('/api/v1/admin/ops/health-cluster', {
        timeoutMs: 15_000,
      }),
      adminFetch<DlqListPayload>('/api/v1/admin/ops/dlq', {
        timeoutMs: 10_000,
      }),
      adminFetch<AiFunnelPayload>('/api/v1/admin/ops/ai-funnel', {
        timeoutMs: 12_000,
      }),
    ]);

    if (healthRes.ok && healthRes.data) {
      setCluster(healthRes.data);
    }
    if (dlqRes.ok && dlqRes.data) {
      const incoming = Array.isArray(dlqRes.data.queues)
        ? dlqRes.data.queues
        : [];
      const mergedMap = new Map<string, DlqQueueEntry>();
      for (const name of DEFAULT_DLQ_NAMES) {
        mergedMap.set(name, {
          name,
          messageCount: 0,
          state: 'running',
          messages: [],
        });
      }
      for (const q of incoming) {
        mergedMap.set(q.name, q);
      }
      setDlqQueues(Array.from(mergedMap.values()));
    } else if (dlqQueues.length === 0) {
      setDlqQueues(
        DEFAULT_DLQ_NAMES.map((name) => ({
          name,
          messageCount: 0,
          state: 'unavailable',
          messages: [],
        })),
      );
    }
    if (funnelRes.ok && funnelRes.data) {
      setFunnel(funnelRes.data);
    }

    if (!healthRes.ok && !funnelRes.ok) {
      setErrorBanner(
        healthRes.error?.message ||
          'Chưa thể kết nối cụm giám sát /api/v1/admin/ops/*.',
      );
    }
    setLoading(false);
  }, [dlqQueues.length]);

  useEffect(() => {
    void loadOpsData();
  }, [loadOpsData]);

  const handleDlqReplay = async (queueName: string) => {
    if (!canManageDlq) return;
    setBusyAction(`replay-${queueName}`);
    const res = await adminFetch<{ replayedCount?: number }>(
      `/api/v1/admin/ops/dlq/${encodeURIComponent(queueName)}/replay`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    if (res.ok) {
      emitPortalToast({
        kind: 'success',
        title: 'DLQ REPLAY',
        message: `Đã đẩy xử lý lại ${res.data?.replayedCount ?? 1} bản ghi từ ${queueName} (đã ghi audit_logs).`,
      });
      await loadOpsData();
    } else {
      emitPortalToast({
        kind: 'error',
        title: 'DLQ REPLAY LỖI',
        message: res.error?.message || `Không thể replay hàng đợi ${queueName}.`,
      });
    }
    setBusyAction(null);
  };

  const handleDlqPurge = async (queueName: string) => {
    if (!canManageDlq) return;
    setBusyAction(`purge-${queueName}`);
    const res = await adminFetch<unknown>(
      `/api/v1/admin/ops/dlq/${encodeURIComponent(queueName)}/purge`,
      { method: 'DELETE' },
    );
    if (res.ok) {
      emitPortalToast({
        kind: 'success',
        title: 'DLQ PURGE',
        message: `Đã xóa sạch bản ghi lỗi trong ${queueName} (đã ghi audit_logs).`,
      });
      await loadOpsData();
    } else {
      emitPortalToast({
        kind: 'error',
        title: 'DLQ PURGE LỖI',
        message: res.error?.message || `Không thể purge hàng đợi ${queueName}.`,
      });
    }
    setBusyAction(null);
  };

  // Resolved Local Ollama AI status merging health-cluster + ai-funnel
  const localAiStatus = useMemo(() => {
    const infraOllama = (cluster?.infra ?? []).find((n) =>
      n.name.toLowerCase().includes('ollama'),
    );
    const olCluster = cluster?.ollama;
    const olFunnel = funnel?.localAi;

    const reachable =
      olCluster?.reachable ??
      (infraOllama ? normalizeStatus(infraOllama.status) === 'UP' : false);
    const baseUrl =
      olCluster?.baseUrl ??
      (typeof infraOllama?.details?.baseUrl === 'string'
        ? infraOllama.details.baseUrl
        : 'http://127.0.0.1:11434');
    const activeMainModel =
      olFunnel?.activeMainModel ??
      olCluster?.activeMainModel ??
      funnel?.copilot?.modelUsed ??
      'qwen2.5:3b';
    const activeFastModel = olFunnel?.activeFastModel ?? 'qwen2.5:3b';
    const activeEmbedModel =
      olFunnel?.activeEmbedModel ??
      olCluster?.activeEmbedModel ??
      funnel?.copilot?.embedModel ??
      'nomic-embed-text';
    const embedDim = olFunnel?.embedDim ?? 768;
    const loadedModels =
      olFunnel?.loadedModels && olFunnel.loadedModels.length > 0
        ? olFunnel.loadedModels
        : olCluster?.loadedModels && olCluster.loadedModels.length > 0
          ? olCluster.loadedModels
          : Array.isArray(infraOllama?.details?.loadedModels)
            ? (infraOllama.details.loadedModels as string[])
            : [];
    const avgTokensPerSec =
      olFunnel?.avgTokensPerSec ?? funnel?.copilot?.tokensPerSec ?? 0;
    const totalPromptTokens = olFunnel?.totalPromptTokens ?? 0;
    const totalEvalTokens = olFunnel?.totalEvalTokens ?? 0;
    const localCostUsd = olFunnel?.localInferenceCostUsd ?? 0;
    const latencyMs = infraOllama?.latencyMs;

    return {
      reachable,
      status: (reachable ? 'UP' : 'DOWN') as NodeHealthStatus,
      baseUrl,
      activeMainModel,
      activeFastModel,
      activeEmbedModel,
      embedDim,
      loadedModels,
      avgTokensPerSec,
      totalPromptTokens,
      totalEvalTokens,
      localCostUsd,
      latencyMs,
      badge:
        olFunnel?.badge || 'Local AI · Ollama Qwen 2.5 (0₫ / Offline Privacy)',
    };
  }, [cluster, funnel]);

  // Ensure Ollama Local AI (:11434) appears cleanly in the Infra strip
  const infraNodes = useMemo(() => {
    const raw = cluster?.infra ?? [];
    const hasOllama = raw.some((n) => n.name.toLowerCase().includes('ollama'));
    if (hasOllama) return raw;
    return [
      ...raw,
      {
        name: 'Ollama Local AI (:11434)',
        port: 11434,
        status: localAiStatus.status,
        latencyMs: localAiStatus.latencyMs,
      },
    ];
  }, [cluster, localAiStatus.latencyMs, localAiStatus.status]);

  const funnelSteps = useMemo(() => {
    const f = funnel?.funnel;
    const t = funnel?.tryon;
    const o = funnel?.orders;

    const modalOpens = f?.tryOnModalOpens ?? t?.openModalSignals ?? 0;
    const rackInteractions =
      f?.rackOrOutfitInteractions ?? Math.max(modalOpens, 1);
    const completed = f?.tryOnCompleted ?? t?.completedSessions ?? 0;
    const mockCount = f?.tryOnMockCount ?? t?.mockCount ?? 0;
    const falCount = f?.tryOnFalCount ?? t?.falCount ?? 0;
    const cacheHitCount = f?.tryOnCacheHitCount ?? t?.cacheHitCount ?? 0;
    const addToCart =
      f?.addToCartAfterTryOn ?? t?.addToCartAfterTryOnSignals ?? 0;
    const paidOrders =
      f?.paidOrders ?? o?.paidOrders ?? funnel?.payments?.succeededCharges ?? 0;

    const maxVal = Math.max(
      rackInteractions,
      modalOpens,
      completed,
      addToCart,
      paidOrders,
      1,
    );

    return [
      {
        label: '1. Tương tác Sào 3D / Outfit Studio',
        value: rackInteractions,
        pct: Math.round((rackInteractions / maxVal) * 100),
        detail: 'Điểm khởi phát hành trình thử dáng',
      },
      {
        label: '2. Mở phòng Thử đồ AI (Modal)',
        value: modalOpens,
        pct: Math.round((modalOpens / maxVal) * 100),
        detail: 'OPEN_MODAL signal',
      },
      {
        label: '3. Hoàn tất dựng ảnh Try-On',
        value: completed,
        pct: Math.round((completed / maxVal) * 100),
        detail: `MOCK: ${mockCount} · FAL: ${falCount} · CACHE_HIT: ${cacheHitCount}`,
      },
      {
        label: '4. Thêm vào giỏ sau Try-On',
        value: addToCart,
        pct: Math.round((addToCart / maxVal) * 100),
        detail: 'ADD_TO_CART_AFTER_TRYON (fromAiTryon: true)',
      },
      {
        label: '5. Đơn hàng thanh toán thành công',
        value: paidOrders,
        pct: Math.round((paidOrders / maxVal) * 100),
        detail: 'Chuyển đổi doanh thu thực',
      },
    ];
  }, [funnel]);

  const servicesList = cluster?.services ?? [];
  const upCount = servicesList.filter(
    (s) => normalizeStatus(s.status) === 'UP',
  ).length;
  const rmaRows = funnel?.rmaSizeExchangeByProduct ?? [];
  const cacheSavingsPct =
    funnel?.cacheHitSavingsPct ?? funnel?.tryon?.cacheHitSavingsPct ?? 0;
  const estAiCostPerOrder = funnel?.estimatedAiCostPerOrderUsd ?? 0;

  return (
    <div className="space-y-8">
      {/* 0. Prominent Local AI · Ollama Qwen 2.5 Status Card */}
      <section className="rounded-3xl border border-[#B08A4A]/55 bg-[#1C1410] p-6 text-[#FBF7EF] shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#B08A4A]/25 pb-5">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-[#EBCF8F]/50 bg-[#2A1E17] px-3.5 py-1 text-[11px] font-medium text-[#EBCF8F]">
              <span
                className={`h-2 w-2 rounded-full ${
                  localAiStatus.reachable ? 'bg-emerald-400' : 'bg-rose-400'
                }`}
              />
              {localAiStatus.badge}
            </span>
            <h2 className="font-editorial mt-2 text-3xl font-light text-[#FBF7EF]">
              Động cơ AI Nội Bộ · Ollama Qwen 2.5 &amp; Embedding 768-dim
            </h2>
            <p className="mt-1 font-mono text-xs text-[#EBCF8F]/80">
              Endpoint: {localAiStatus.baseUrl} · Zero API Key · 100% Dữ liệu
              giữ tại chỗ
            </p>
          </div>

          <div className="flex items-center gap-2.5">
            <span
              className={`rounded-full border px-3.5 py-1.5 font-mono text-[11px] font-semibold ${
                STATUS_PILL_STYLE[localAiStatus.status]
              }`}
            >
              OLLAMA ENGINE: {localAiStatus.status}
              {typeof localAiStatus.latencyMs === 'number'
                ? ` (${Math.round(localAiStatus.latencyMs)}ms)`
                : ''}
            </span>
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="rounded-2xl border border-[#B08A4A]/30 bg-[#241A14] p-4">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[#EBCF8F]/75">
              Active Main Model
            </p>
            <p className="mt-1 font-mono text-base font-semibold text-[#EBCF8F]">
              {localAiStatus.activeMainModel}
            </p>
            <p className="mt-0.5 text-[11px] text-[#FBF7EF]/65">
              MCP Tool Calling &amp; Copilot
            </p>
          </div>

          <div className="rounded-2xl border border-[#B08A4A]/30 bg-[#241A14] p-4">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[#EBCF8F]/75">
              Fast Model (Tier 1)
            </p>
            <p className="mt-1 font-mono text-base font-semibold text-[#FBF7EF]">
              {localAiStatus.activeFastModel}
            </p>
            <p className="mt-0.5 text-[11px] text-[#FBF7EF]/65">
              Sentiment NLP &amp; Phân loại nhanh
            </p>
          </div>

          <div className="rounded-2xl border border-[#B08A4A]/30 bg-[#241A14] p-4">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[#EBCF8F]/75">
              Embed Model
            </p>
            <p className="mt-1 font-mono text-base font-semibold text-[#FBF7EF]">
              {localAiStatus.activeEmbedModel}
            </p>
            <p className="mt-0.5 font-mono text-[11px] text-[#EBCF8F]/80">
              {localAiStatus.embedDim}-dim Hybrid RAG
            </p>
          </div>

          <div className="rounded-2xl border border-[#B08A4A]/30 bg-[#241A14] p-4">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[#EBCF8F]/75">
              Tốc độ suy luận (Speed)
            </p>
            <p className="mt-1 font-mono text-base font-semibold text-emerald-300">
              {localAiStatus.avgTokensPerSec > 0
                ? `${localAiStatus.avgTokensPerSec.toFixed(1)} tokens/s`
                : 'Sẵn sàng'}
            </p>
            <p className="mt-0.5 font-mono text-[11px] text-[#FBF7EF]/65">
              {localAiStatus.totalPromptTokens}→{localAiStatus.totalEvalTokens}{' '}
              tok
            </p>
          </div>

          <div className="rounded-2xl border border-[#2E6B47]/55 bg-[#1B2C22] p-4">
            <p className="text-[10px] uppercase tracking-[0.14em] text-emerald-200">
              Local Inference Cost
            </p>
            <p className="mt-1 font-mono text-lg font-bold text-emerald-300">
              0₫ (${localAiStatus.localCostUsd.toFixed(2)})
            </p>
            <p className="mt-0.5 text-[11px] text-emerald-100/80">
              Miễn phí 100% · Offline Privacy
            </p>
          </div>
        </div>

        {/* Loaded Models Chip List */}
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[#B08A4A]/20 pt-4 text-xs">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#EBCF8F]/80">
            Mô hình đã nạp trên Ollama ({localAiStatus.loadedModels.length}):
          </span>
          {localAiStatus.loadedModels.length > 0 ? (
            localAiStatus.loadedModels.map((modelName) => (
              <span
                key={modelName}
                className="rounded-full border border-[#EBCF8F]/40 bg-[#2A1E17] px-3 py-0.5 font-mono text-[11px] text-[#EBCF8F]"
              >
                {modelName}
              </span>
            ))
          ) : (
            <span className="font-mono text-[11px] text-[#FBF7EF]/60">
              Đang chờ phản hồi /api/tags từ Ollama (:11434)
            </span>
          )}
        </div>
      </section>

      {/* 1. 11-Service Cluster Health Grid & Infra Strip */}
      <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#B08A4A]/20 pb-5">
          <div>
            <p className="ledger-eyebrow text-[#8A672C]">
              11-Service Cluster Health &amp; Infrastructure Telemetry
            </p>
            <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Giám sát Cụm 11 Microservices ({upCount}/
              {servicesList.length || 11} UP)
            </h2>
            <p className="mt-1 text-xs text-[#7A6A5B]">
              Kiểm tra đồng thời <code>/health</code> &amp; <code>/ready</code>{' '}
              với độ trễ thực tế (<code>latencyMs</code>) và đường truyền{' '}
              <code>traceparent</code> W3C. Cập nhật:{' '}
              <span className="font-mono">
                {formatDateTime(cluster?.checkedAt)}
              </span>
            </p>
          </div>

          <div className="flex items-center gap-2.5">
            {cluster?.overallStatus ? (
              <span
                className={`rounded-full border px-3.5 py-1.5 font-mono text-[11px] font-semibold ${
                  STATUS_PILL_STYLE[normalizeStatus(cluster.overallStatus)]
                }`}
              >
                CLUSTER: {normalizeStatus(cluster.overallStatus)}
              </span>
            ) : null}
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadOpsData()}
              className="rounded-full bg-[#1C1410] px-5 py-2 text-xs uppercase tracking-[0.16em] text-[#EBCF8F] hover:opacity-90 disabled:opacity-50"
            >
              {loading ? 'Đang quét cụm...' : 'Quét lại cụm'}
            </button>
          </div>
        </div>

        {errorBanner ? (
          <div
            role="alert"
            className="mt-4 rounded-2xl border border-[#8B2E2E]/35 bg-[#FFF5F4] px-4 py-3 text-xs text-[#8B2E2E]"
          >
            {errorBanner}
          </div>
        ) : null}

        {/* 11-Service Health Grid */}
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {servicesList.length === 0 ? (
            <p className="col-span-full rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF] p-6 text-center text-xs text-[#7A6A5B]">
              {loading
                ? 'Đang kiểm tra trạng thái 11 dịch vụ...'
                : 'Chưa nhận được phản hồi cụm dịch vụ.'}
            </p>
          ) : (
            servicesList.map((svc) => {
              const st = normalizeStatus(svc.status);
              return (
                <article
                  key={`${svc.name}-${svc.port ?? ''}`}
                  className="rounded-2xl border border-[#B08A4A]/25 bg-[#FBF7EF]/75 p-4 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-semibold text-[#1C1410]">
                      {svc.name}
                    </span>
                    <span
                      className={`rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold ${STATUS_PILL_STYLE[st]}`}
                    >
                      {st}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between font-mono text-[11px] text-[#7A6A5B]">
                    <span>Port :{svc.port ?? '—'}</span>
                    <span className="font-semibold text-[#1C1410]">
                      {typeof svc.latencyMs === 'number'
                        ? `${Math.round(svc.latencyMs)} ms`
                        : '—'}
                    </span>
                  </div>
                </article>
              );
            })
          )}
        </div>

        {/* Infrastructure Health Strip (including Ollama Local AI :11434) */}
        <div className="mt-5 border-t border-[#B08A4A]/20 pt-4">
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-[#8A672C]">
            Hạ tầng lõi (Redis · Meilisearch · MinIO · Mailpit · RabbitMQ :15672
            · Ollama Local AI :11434)
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {infraNodes.map((node) => {
              const st = normalizeStatus(node.status);
              return (
                <span
                  key={node.name}
                  className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 font-mono text-[11px] ${STATUS_PILL_STYLE[st]}`}
                >
                  <strong>{node.name}</strong>
                  <span>{st}</span>
                  {typeof node.latencyMs === 'number' ? (
                    <span className="opacity-75">
                      ({Math.round(node.latencyMs)}ms)
                    </span>
                  ) : null}
                </span>
              );
            })}
          </div>
        </div>
      </section>

      {/* 2. Dead-Letter Queue (*.dlq) Operational Console */}
      <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#B08A4A]/20 pb-4">
          <div>
            <p className="ledger-eyebrow text-[#8A672C]">
              RabbitMQ Dead-Letter Queue (*.dlq) Management Console
            </p>
            <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Quản trị Hàng đợi Lỗi (*.dlq) &amp; Đẩy xử lý lại
            </h2>
            <p className="mt-1 text-xs text-[#7A6A5B]">
              Quan sát toàn bộ bản tin rơi vào <code>order.saga.dlq</code>,{' '}
              <code>payment.webhook.dlq</code>, <code>notify.zns.dlq</code>,{' '}
              <code>tryon.jobs.dlq</code>. Quyền Replay / Purge bị khóa nghiêm
              ngặt cho <code>SUPER_ADMIN</code> đã xác thực 2FA.
            </p>
          </div>

          {!canManageDlq ? (
            <span className="rounded-full border border-[#8B2E2E]/40 bg-[#FFF5F4] px-3.5 py-1.5 font-mono text-[10px] text-[#8B2E2E]">
              READ-ONLY · Cần SUPER_ADMIN + 2FA để Replay / Purge
            </span>
          ) : (
            <span className="rounded-full border border-[#2E6B47]/40 bg-[#F2FBF6] px-3.5 py-1.5 font-mono text-[10px] font-semibold text-[#1E4B32]">
              SUPER_ADMIN 2FA UNLOCKED
            </span>
          )}
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          {dlqQueues.map((queue) => {
            const messages = queue.messages ?? [];
            const hasErrors = queue.messageCount > 0 || messages.length > 0;

            return (
              <article
                key={queue.name}
                className={`rounded-2xl border p-4 text-xs ${
                  hasErrors
                    ? 'border-[#D9822B]/55 bg-[#FFFDF7]'
                    : 'border-[#B08A4A]/25 bg-[#FBF7EF]/65'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-mono text-sm font-bold text-[#1C1410]">
                      {queue.name}
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] text-[#7A6A5B]">
                      Trạng thái: {queue.state ?? 'running'} · Bản tin lỗi:{' '}
                      <strong
                        className={
                          hasErrors ? 'text-[#8B2E2E]' : 'text-[#1E4B32]'
                        }
                      >
                        {queue.messageCount}
                      </strong>
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={
                        !canManageDlq ||
                        busyAction === `replay-${queue.name}` ||
                        !hasErrors
                      }
                      onClick={() => void handleDlqReplay(queue.name)}
                      className="rounded-full bg-[#1C1410] px-3.5 py-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-[#EBCF8F] disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      {busyAction === `replay-${queue.name}`
                        ? 'Đang replay...'
                        : 'Đẩy xử lý lại (Replay/Requeue)'}
                    </button>
                    <button
                      type="button"
                      disabled={
                        !canManageDlq ||
                        busyAction === `purge-${queue.name}` ||
                        !hasErrors
                      }
                      onClick={() => void handleDlqPurge(queue.name)}
                      className="rounded-full border border-[#8B2E2E]/55 px-3.5 py-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-[#8B2E2E] hover:bg-[#8B2E2E] hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      {busyAction === `purge-${queue.name}`
                        ? 'Đang xóa...'
                        : 'Xóa bản ghi lỗi (Purge)'}
                    </button>
                  </div>
                </div>

                {messages.length > 0 ? (
                  <div className="mt-3 space-y-2 border-t border-[#B08A4A]/20 pt-3">
                    {messages.map((msg, idx) => {
                      const key = `${queue.name}-${idx}`;
                      const expanded = expandedPayloadKey === key;
                      return (
                        <div
                          key={key}
                          className="rounded-xl border border-[#B08A4A]/25 bg-white p-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px]">
                            <span className="text-[#8A672C]">
                              corrId: {msg.correlationId ?? '—'}
                            </span>
                            <span className="text-[#8B2E2E]">
                              retry: {msg.retryCount ?? 0} ·{' '}
                              {msg.failureReason ?? 'UNKNOWN_FAILURE'}
                            </span>
                          </div>

                          <button
                            type="button"
                            onClick={() =>
                              setExpandedPayloadKey(expanded ? null : key)
                            }
                            className="mt-1.5 text-[11px] font-medium text-[#1C1410] underline underline-offset-4"
                          >
                            {expanded
                              ? 'Ẩn JSON payload'
                              : 'Xem chi tiết JSON payload'}
                          </button>

                          {expanded ? (
                            <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-[#1C1410] p-3 font-mono text-[10px] text-[#EBCF8F]">
                              {JSON.stringify(msg.payload ?? msg, null, 2)}
                            </pre>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>

      {/* 3. Commerce & AI Ops Telemetry Funnel */}
      <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#B08A4A]/20 pb-5">
          <div>
            <p className="ledger-eyebrow text-[#8A672C]">
              Commerce &amp; AI Ops Telemetry Funnel
            </p>
            <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Phễu Chuyển Đổi AI Try-On, Chi phí AI Nội bộ &amp; Tỷ lệ Đổi Size
              RMA
            </h2>
          </div>
        </div>

        {/* KPI Cards */}
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-2xl border border-[#B08A4A]/30 bg-[#1C1410] p-4 text-[#FBF7EF]">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[#EBCF8F]">
              Estimated AI Cost / Order
            </p>
            <p className="font-editorial mt-1.5 text-4xl text-[#EBCF8F]">
              ${estAiCostPerOrder.toFixed(4)}
            </p>
            <p className="mt-1 text-[11px] text-[#FBF7EF]/70">
              Try-On + Ollama Qwen 2.5 Local AI (0₫ nội bộ)
            </p>
          </div>

          <div className="rounded-2xl border border-[#2E6B47]/35 bg-[#F2FBF6] p-4">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[#1E4B32]">
              CACHE_HIT Tiết kiệm GPU
            </p>
            <p className="font-editorial mt-1.5 text-4xl text-[#1C1410]">
              {cacheSavingsPct.toFixed(1)}%
            </p>
            <p className="mt-1 text-[11px] text-[#1E4B32]">
              Redis SHA-256 Content-Hash Cache (0₫ · &lt; 1s)
            </p>
          </div>

          <div className="rounded-2xl border border-[#B08A4A]/30 bg-[#FBF7EF] p-4">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[#8A672C]">
              Ollama MCP Guardrails
            </p>
            <p className="font-editorial mt-1.5 text-4xl text-[#1C1410]">
              {funnel?.copilot?.promptInjectionsBlocked ?? 0} chặn ·{' '}
              {funnel?.copilot?.rbacDenials ?? 0} 403
            </p>
            <p className="mt-1 text-[11px] text-[#5C4B41]">
              {funnel?.copilot?.totalChatTurns ?? 0} lượt chat · Cache{' '}
              {(funnel?.copilot?.semanticCacheHitRatePct ?? 0).toFixed(0)}%
            </p>
          </div>

          <div className="rounded-2xl border border-[#B08A4A]/30 bg-[#FBF7EF] p-4">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[#8A672C]">
              Tồn kho &amp; Nháp PO AI
            </p>
            <p className="font-editorial mt-1.5 text-4xl text-[#1C1410]">
              {funnel?.inventory?.lowStockCount ?? 0} sắp hết
            </p>
            <p className="mt-1 text-[11px] text-[#5C4B41]">
              {funnel?.inventory?.activeReservationsCount ?? 0} giữ chỗ 15p ·{' '}
              {funnel?.inventory?.pendingAiDraftPosCount ?? 0} PO NHAP_AI
            </p>
          </div>
        </div>

        {/* Visual Funnel Bars */}
        <div className="mt-6 space-y-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[#8A672C]">
            Phễu Chuyển đổi Khách hàng (Rack/Outfit → Try-On → Giỏ hàng → Đơn
            trả tiền)
          </p>
          {funnelSteps.map((step) => (
            <div
              key={step.label}
              className="rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF]/75 p-3.5 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-[#1C1410]">{step.label}</span>
                <span className="font-mono font-semibold text-[#8A672C]">
                  {step.value} ({step.pct}%)
                </span>
              </div>
              <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-[#EBD9B4]/55">
                <div
                  style={{
                    width: `${Math.max(step.pct, step.value > 0 ? 4 : 0)}%`,
                  }}
                  className="h-full rounded-full bg-[#1C1410] transition-all duration-500"
                />
              </div>
              <p className="mt-1 text-[11px] text-[#7A6A5B]">{step.detail}</p>
            </div>
          ))}
        </div>

        {/* RMA Size-Exchange Rate by Product Table */}
        <div className="mt-6 border-t border-[#B08A4A]/20 pt-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[#8A672C]">
            Tỷ lệ Đổi Size RMA theo Sản phẩm (RMA Size-Exchange Rate by Product)
          </p>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[#B08A4A]/25 bg-[#F4EBDA]/65 text-[10px] uppercase tracking-[0.14em] text-[#8A672C]">
                <tr>
                  <th className="px-4 py-2.5">Sản phẩm / SKU</th>
                  <th className="px-4 py-2.5 text-right">Tổng RMA</th>
                  <th className="px-4 py-2.5 text-right">Tỷ lệ Đổi Size</th>
                  <th className="px-4 py-2.5">Nguyên nhân chính</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#B08A4A]/15">
                {rmaRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-4 py-6 text-center text-xs text-[#7A6A5B]"
                    >
                      Chưa có số liệu đổi size RMA theo sản phẩm trong kỳ thống
                      kê hiện tại.
                    </td>
                  </tr>
                ) : (
                  rmaRows.map((row) => (
                    <tr key={`${row.productId}-${row.skuCode ?? ''}`}>
                      <td className="px-4 py-2.5 font-medium text-[#1C1410]">
                        {row.productName || row.productId.slice(0, 12)}
                        {row.skuCode ? (
                          <span className="ml-2 font-mono text-[10px] text-[#7A6A5B]">
                            ({row.skuCode})
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono">
                        {row.totalRmas ?? row.sizeExchangeCount ?? 0}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold text-[#8A672C]">
                        {(
                          row.sizeExchangeRatePct ??
                          row.returnRatePct ??
                          0
                        ).toFixed(1)}
                        %
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[11px] text-[#5C4B41]">
                        {row.dominantReasonCode ?? '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
