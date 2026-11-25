'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BiAnalyticsRange,
  canReadCostPrice,
  type BiAnalyticsSummaryDto,
  type BiSeriesPointDto,
  type Role,
} from '@atelier/contracts';
import { adminFetch, downloadUtf8BomCsv } from '@/lib/api-client';
import { DownloadIcon, ShieldLockIcon } from '../AdminIcons';
import { emitPortalToast } from '../PortalToastBanner';

export interface AnalyticsBiTabProps {
  roles: readonly Role[];
  darkMode?: boolean;
}

const FORMAT_VND = (amount: number): string =>
  `${new Intl.NumberFormat('vi-VN').format(Math.round(amount))}₫`;

function formatVndCompact(amount: number): string {
  if (Math.abs(amount) >= 1_000_000_000) {
    return `${(amount / 1_000_000_000).toFixed(2)} tỷ₫`;
  }
  if (Math.abs(amount) >= 1_000_000) {
    return `${(amount / 1_000_000).toFixed(1)} tr₫`;
  }
  return FORMAT_VND(amount);
}

function formatShortDate(raw: string): string {
  const parts = raw.slice(0, 10).split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}`;
  }
  return raw;
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16);
  }
}

export function AnalyticsBiTab({
  roles,
  darkMode = false,
}: AnalyticsBiTabProps) {
  const [range, setRange] = useState<BiAnalyticsRange>(BiAnalyticsRange.D30);
  const [biData, setBiData] = useState<BiAnalyticsSummaryDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const callerCanReadCost = canReadCostPrice(roles);

  const loadAnalytics = useCallback(
    async (targetRange: BiAnalyticsRange, notify = false) => {
      setLoading(true);
      setErrorMessage(null);
      const res = await adminFetch<BiAnalyticsSummaryDto>(
        `/api/v1/admin/analytics/bi?range=${encodeURIComponent(targetRange)}`,
        { timeoutMs: 15_000 },
      );

      if (res.ok && res.data) {
        setBiData(res.data);
        if (notify) {
          emitPortalToast({
            kind: 'success',
            title: 'PHÂN TÍCH BI',
            message: `Đã đồng bộ báo cáo doanh thu & hiệu suất (${targetRange}).`,
          });
        }
      } else {
        setErrorMessage(
          res.error?.message ||
            'Chưa thể tải dữ liệu phân tích BI từ BFF (/api/v1/admin/analytics/bi).',
        );
      }
      setLoading(false);
    },
    [],
  );

  useEffect(() => {
    void loadAnalytics(range, false);
  }, [loadAnalytics, range]);

  /**
   * Strict Layer 5 Zero-Trust Redaction detection:
   * Never render fake/placeholder COGS or Gross Margin values when API sets
   * `costDataRedacted: true`, omits COGS fields, or caller lacks cost permission.
   */
  const isCostRedacted = useMemo(() => {
    if (!callerCanReadCost) return true;
    if (!biData) return false;
    if (biData.costDataRedacted) return true;
    return (
      biData.cogsVnd === undefined &&
      biData.totalCogsVnd === undefined &&
      biData.grossMarginVnd === undefined
    );
  }, [biData, callerCanReadCost]);

  const authorizedCogsVnd = !isCostRedacted
    ? (biData?.cogsVnd ?? biData?.totalCogsVnd)
    : undefined;
  const authorizedGrossMarginVnd = !isCostRedacted
    ? biData?.grossMarginVnd
    : undefined;
  const authorizedGrossMarginPct = !isCostRedacted
    ? biData?.grossMarginPct
    : undefined;

  // Chart calculations
  const series = useMemo<BiSeriesPointDto[]>(
    () => biData?.series ?? [],
    [biData],
  );

  const chartMaxVnd = useMemo(() => {
    let max = 0;
    for (const pt of series) {
      max = Math.max(max, pt.netRevenueVnd || 0);
      if (!isCostRedacted && typeof pt.cogsVnd === 'number') {
        max = Math.max(max, pt.cogsVnd);
      }
    }
    return Math.max(max, 1);
  }, [isCostRedacted, series]);

  const svgPoints = useMemo(() => {
    if (series.length === 0) return { areaPath: '', linePath: '', bars: [] as Array<{ x: number; w: number; revH: number; revY: number; cogsH: number; cogsY: number; point: BiSeriesPointDto; idx: number }> };
    const width = 820;
    const height = 220;
    const padX = 20;
    const padTop = 18;
    const padBottom = 26;
    const plotW = width - padX * 2;
    const plotH = height - padTop - padBottom;
    const stepX = plotW / Math.max(series.length, 1);
    const barW = Math.max(4, Math.min(26, stepX * (isCostRedacted ? 0.56 : 0.36)));

    const coords: Array<{ x: number; y: number }> = [];
    const bars = series.map((point, idx) => {
      const centerX = padX + stepX * idx + stepX / 2;
      const revRatio = Math.min(1, (point.netRevenueVnd || 0) / chartMaxVnd);
      const revH = Math.max(2, revRatio * plotH);
      const revY = padTop + (plotH - revH);
      coords.push({ x: centerX, y: revY });

      const cogsVal =
        !isCostRedacted && typeof point.cogsVnd === 'number'
          ? point.cogsVnd
          : 0;
      const cogsRatio = Math.min(1, cogsVal / chartMaxVnd);
      const cogsH = !isCostRedacted && cogsVal > 0 ? Math.max(2, cogsRatio * plotH) : 0;
      const cogsY = padTop + (plotH - cogsH);

      return {
        x: centerX,
        w: barW,
        revH,
        revY,
        cogsH,
        cogsY,
        point,
        idx,
      };
    });

    const linePath = coords
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(' ');
    const baseY = padTop + plotH;
    const areaPath =
      coords.length > 0
        ? `${linePath} L ${coords[coords.length - 1]!.x.toFixed(1)} ${baseY.toFixed(1)} L ${coords[0]!.x.toFixed(1)} ${baseY.toFixed(1)} Z`
        : '';

    return { areaPath, linePath, bars };
  }, [chartMaxVnd, isCostRedacted, series]);

  // Authorized-only UTF-8 BOM CSV Export
  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  const handleExportSeriesCsv = () => {
    if (!biData) return;
    const headers = isCostRedacted
      ? [
          'Ngày',
          'Doanh thu ròng (VND)',
          'Hoàn tiền (VND)',
          'Số đơn hàng',
          'Số phiếu RMA',
        ]
      : [
          'Ngày',
          'Doanh thu ròng (VND)',
          'Giá vốn COGS (VND)',
          'Biên lợi nhuận gộp (VND)',
          'Biên lợi nhuận (%)',
          'Hoàn tiền (VND)',
          'Số đơn hàng',
          'Số phiếu RMA',
        ];

    const rows = biData.series.map((pt) =>
      isCostRedacted
        ? [pt.date, pt.netRevenueVnd, pt.refundedVnd, pt.orderCount, pt.rmaCount]
        : [
            pt.date,
            pt.netRevenueVnd,
            pt.cogsVnd ?? '',
            pt.grossMarginVnd ?? '',
            pt.grossMarginPct ?? '',
            pt.refundedVnd,
            pt.orderCount,
            pt.rmaCount,
          ],
    );

    downloadUtf8BomCsv(
      `tam-xuan-bi-doanh-thu-${range}-${dateStamp}.csv`,
      headers,
      rows,
    );
    emitPortalToast({
      kind: 'success',
      title: 'XUẤT BÁO CÁO BI (CSV)',
      message: isCostRedacted
        ? `Đã xuất ${rows.length} dòng doanh thu chuẩn UTF-8 BOM (đã tự động ẩn cột Giá vốn theo Layer 5 RBAC).`
        : `Đã xuất ${rows.length} dòng báo cáo Doanh thu, COGS & Biên lợi nhuận chuẩn UTF-8 BOM.`,
    });
  };

  const handleExportTopSkusCsv = () => {
    if (!biData) return;
    const headers = isCostRedacted
      ? ['Mã SKU', 'Tên sản phẩm', 'Số lượng bán', 'Doanh thu ròng (VND)']
      : [
          'Mã SKU',
          'Tên sản phẩm',
          'Số lượng bán',
          'Doanh thu ròng (VND)',
          'Giá vốn COGS (VND)',
          'Lợi nhuận gộp (VND)',
          'Biên lợi nhuận (%)',
        ];

    const rows = biData.topSkus.map((sku) =>
      isCostRedacted
        ? [sku.skuCode, sku.productName, sku.unitsSold, sku.netRevenueVnd]
        : [
            sku.skuCode,
            sku.productName,
            sku.unitsSold,
            sku.netRevenueVnd,
            sku.cogsVnd ?? '',
            sku.grossMarginVnd ?? '',
            sku.grossMarginPct ?? '',
          ],
    );

    downloadUtf8BomCsv(
      `tam-xuan-bi-top-sku-${range}-${dateStamp}.csv`,
      headers,
      rows,
    );
    emitPortalToast({
      kind: 'success',
      title: 'XUẤT TOP SKU (CSV)',
      message: `Đã xuất ${rows.length} dòng Top SKU bán chạy chuẩn UTF-8 BOM.`,
    });
  };

  // Theme classes
  const cardCls = darkMode
    ? 'border-[#B08A4A]/30 bg-[#1A130E] text-[#FBF7EF]'
    : 'border-[#B08A4A]/25 bg-[#FFFDF9] text-[#1C1410]';
  const subCardCls = darkMode
    ? 'border-[#B08A4A]/25 bg-[#231912] text-[#FBF7EF]'
    : 'border-[#B08A4A]/20 bg-[#FBF7EF] text-[#1C1410]';
  const mutedCls = darkMode ? 'text-[#B4A391]' : 'text-[#7A6A5B]';
  const goldTextCls = darkMode ? 'text-[#EBCF8F]' : 'text-[#8A672C]';
  const tableHeadCls = darkMode
    ? 'border-b border-[#B08A4A]/25 bg-[#241A13] text-[#EBCF8F]'
    : 'border-b border-[#B08A4A]/20 bg-[#F4EBDA]/75 text-[#8A672C]';
  const rowHoverCls = darkMode ? 'hover:bg-[#251B14]' : 'hover:bg-[#FBF7EF]/85';

  const hoveredBar =
    hoveredIdx !== null ? (svgPoints.bars[hoveredIdx] ?? null) : null;

  return (
    <div data-testid="analytics-bi-tab" className="space-y-6">
      {/* Header + Range Toggle + CSV Export */}
      <section className={`rounded-3xl border p-6 ${cardCls}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className={`ledger-eyebrow ${goldTextCls}`}>
              Business Intelligence · Revenue, COGS, Gross Margin &amp; RMA
              Analytics
            </p>
            <h2 className="font-editorial mt-1 text-3xl font-normal tracking-tight">
              Phân tích BI &amp; Đối soát Hiệu suất Kinh doanh
            </h2>
            <p className={`mt-1 text-xs leading-relaxed ${mutedCls}`}>
              Tổng hợp thời gian thực từ đơn hàng, thanh toán, đổi trả RMA và
              giá vốn danh mục. Hỗ trợ xuất Excel CSV chuẩn{' '}
              <code>UTF-8 BOM (\uFEFF)</code> chỉ gồm các trường được cấp phép.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Range Selector */}
            <div className="inline-flex rounded-full border border-[#B08A4A]/35 p-0.5">
              {(
                [
                  [BiAnalyticsRange.D7, '7 ngày'],
                  [BiAnalyticsRange.D30, '30 ngày'],
                  [BiAnalyticsRange.D90, '90 ngày'],
                ] as const
              ).map(([key, label]) => {
                const active = range === key;
                return (
                  <button
                    key={key}
                    type="button"
                    data-testid={`bi-range-${key}`}
                    onClick={() => setRange(key)}
                    className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
                      active
                        ? darkMode
                          ? 'bg-[#EBCF8F] text-[#1C1410]'
                          : 'bg-[#1C1410] text-[#EBCF8F]'
                        : mutedCls
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              data-testid="btn-export-bi-csv"
              disabled={!biData}
              onClick={handleExportSeriesCsv}
              className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold disabled:opacity-45 ${
                darkMode
                  ? 'bg-[#EBCF8F] text-[#1C1410]'
                  : 'bg-[#1C1410] text-[#EBCF8F]'
              }`}
            >
              <DownloadIcon size={14} />
              Xuất CSV BI
            </button>

            <button
              type="button"
              disabled={!biData}
              onClick={handleExportTopSkusCsv}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-xs font-medium disabled:opacity-45 ${
                darkMode
                  ? 'border-[#EBCF8F]/40 text-[#EBCF8F] hover:bg-[#231912]'
                  : 'border-[#B08A4A]/50 bg-white text-[#1C1410] hover:bg-[#F4EBDA]'
              }`}
            >
              <DownloadIcon size={13} />
              CSV Top SKU
            </button>

            <button
              type="button"
              disabled={loading}
              onClick={() => void loadAnalytics(range, true)}
              className="rounded-full border border-[#B08A4A]/40 px-3.5 py-2 text-xs disabled:opacity-50"
            >
              {loading ? 'Đang tải...' : 'Làm mới'}
            </button>
          </div>
        </div>

        {biData?.generatedAt ? (
          <p className={`mt-2 font-mono text-[10.5px] ${mutedCls}`}>
            Kỳ đối soát: {biData.from.slice(0, 10)} → {biData.to.slice(0, 10)} ·
            Cập nhật: {formatDateTime(biData.generatedAt)}
          </p>
        ) : null}

        {errorMessage ? (
          <div
            role="alert"
            className={`mt-4 rounded-2xl border px-4 py-3 text-xs ${
              darkMode
                ? 'border-rose-500/45 bg-rose-950/40 text-rose-200'
                : 'border-[#8B2E2E]/35 bg-[#FFF5F4] text-[#8B2E2E]'
            }`}
          >
            {errorMessage}
          </div>
        ) : null}

        {/* Explicit Layer 5 Zero-Trust Redaction Banner when COGS/Margin redacted */}
        {isCostRedacted ? (
          <div
            data-testid="bi-layer5-redaction-banner"
            role="note"
            className={`mt-4 flex items-start gap-3 rounded-2xl border px-4 py-3.5 text-xs ${
              darkMode
                ? 'border-[#EBCF8F]/40 bg-[#261C14] text-[#EBCF8F]'
                : 'border-[#B08A4A]/55 bg-[#FFF8EB] text-[#7A5316]'
            }`}
          >
            <ShieldLockIcon size={18} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold">
                Dữ liệu Giá vốn &amp; Biên lợi nhuận được bảo vệ bởi Layer 5
                Redaction
              </p>
              <p className="mt-0.5 opacity-90">
                Vai trò hiện tại không có quyền{' '}
                <code>finance.cost_price.read</code> hoặc{' '}
                <code>procurement.cost_price.read</code>. BFF đã tự động loại bỏ
                hoàn toàn các trường Giá vốn (COGS) và Biên lợi nhuận khỏi dữ
                liệu phản hồi và tệp xuất CSV.
              </p>
            </div>
          </div>
        ) : null}

        {/* 4 Executive KPI Cards */}
        <div className="mt-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
          {/* Card 1: Net Revenue */}
          <div className={`rounded-2xl border p-4 ${subCardCls}`}>
            <p
              className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${mutedCls}`}
            >
              Doanh thu ròng (Net Revenue)
            </p>
            <p
              className={`adm-tabular mt-1.5 font-mono text-2xl font-bold ${goldTextCls}`}
            >
              {biData ? FORMAT_VND(biData.netRevenueVnd) : '—'}
            </p>
            <p className={`mt-1.5 text-[11px] ${mutedCls}`}>
              Hoàn tiền:{' '}
              <strong className="font-mono">
                {biData ? FORMAT_VND(biData.refundedVnd) : '—'}
              </strong>
            </p>
          </div>

          {/* Card 2: COGS (Hidden cleanly when Layer 5 redacted) */}
          <div className={`rounded-2xl border p-4 ${subCardCls}`}>
            <p
              className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${mutedCls}`}
            >
              Giá vốn hàng bán (COGS)
            </p>
            {isCostRedacted ? (
              <div className="mt-2 flex items-center gap-1.5 font-mono text-xs font-semibold text-[#B08A4A]">
                <ShieldLockIcon size={15} />
                <span>Ẩn theo Layer 5 RBAC</span>
              </div>
            ) : (
              <p className="adm-tabular mt-1.5 font-mono text-2xl font-bold">
                {authorizedCogsVnd !== undefined
                  ? FORMAT_VND(authorizedCogsVnd)
                  : '—'}
              </p>
            )}
            <p className={`mt-1.5 text-[11px] ${mutedCls}`}>
              {isCostRedacted
                ? 'Không hiển thị dữ liệu giá nhập'
                : 'Tính theo đơn giá vốn SKU thực xuất'}
            </p>
          </div>

          {/* Card 3: Gross Margin VND & % (Hidden cleanly when Layer 5 redacted) */}
          <div className={`rounded-2xl border p-4 ${subCardCls}`}>
            <p
              className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${mutedCls}`}
            >
              Biên lợi nhuận gộp (Gross Margin)
            </p>
            {isCostRedacted ? (
              <div className="mt-2 flex items-center gap-1.5 font-mono text-xs font-semibold text-[#B08A4A]">
                <ShieldLockIcon size={15} />
                <span>Ẩn theo Layer 5 RBAC</span>
              </div>
            ) : (
              <div className="mt-1.5 flex items-baseline gap-2">
                <span
                  className={`adm-tabular font-mono text-2xl font-bold ${
                    darkMode ? 'text-emerald-300' : 'text-[#1E4B32]'
                  }`}
                >
                  {authorizedGrossMarginVnd !== undefined
                    ? FORMAT_VND(authorizedGrossMarginVnd)
                    : '—'}
                </span>
                {authorizedGrossMarginPct !== undefined ? (
                  <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-mono text-[11px] font-semibold text-emerald-600">
                    {authorizedGrossMarginPct.toFixed(1)}%
                  </span>
                ) : null}
              </div>
            )}
            <p className={`mt-1.5 text-[11px] ${mutedCls}`}>
              {isCostRedacted
                ? 'Bảo vệ biên lợi nhuận nội bộ'
                : 'Doanh thu ròng − Giá vốn hàng bán'}
            </p>
          </div>

          {/* Card 4: Orders & RMA Rate */}
          <div className={`rounded-2xl border p-4 ${subCardCls}`}>
            <p
              className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${mutedCls}`}
            >
              Đơn hàng &amp; Tỷ lệ RMA
            </p>
            <p className="adm-tabular mt-1.5 font-mono text-2xl font-bold">
              {biData ? `${biData.orderCount} đơn` : '—'}
            </p>
            <p className={`mt-1.5 text-[11px] ${mutedCls}`}>
              RMA:{' '}
              <strong className="font-mono">
                {biData ? biData.rmaCount : 0} phiếu
              </strong>
              {biData && typeof biData.rmaRatePct === 'number'
                ? ` (${biData.rmaRatePct.toFixed(1)}%)`
                : ''}
            </p>
          </div>
        </div>
      </section>

      {/* Interactive Bar / Area Chart: Revenue vs COGS */}
      <section className={`rounded-3xl border p-6 ${cardCls}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className={`ledger-eyebrow ${goldTextCls}`}>
              Time-Series Performance Chart ({range})
            </p>
            <h3 className="font-editorial mt-0.5 text-2xl">
              {isCostRedacted
                ? 'Biểu đồ Doanh thu ròng theo ngày'
                : 'Biểu đồ Doanh thu ròng vs Giá vốn hàng bán (COGS)'}
            </h3>
          </div>

          <div className="flex items-center gap-4 text-[11px]">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-[#B08A4A]" />
              Doanh thu ròng
            </span>
            {!isCostRedacted ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm bg-[#2E6B47]" />
                Giá vốn COGS
              </span>
            ) : null}
          </div>
        </div>

        {loading && !biData ? (
          <p className={`py-14 text-center text-xs ${mutedCls}`}>
            Đang tổng hợp biểu đồ BI...
          </p>
        ) : series.length === 0 ? (
          <p className={`py-14 text-center text-xs ${mutedCls}`}>
            Chưa có dữ liệu chuỗi thời gian cho khoảng thời gian đã chọn.
          </p>
        ) : (
          <div className="mt-4">
            {/* Hover Inspector Strip */}
            <div
              className={`mb-3 flex min-h-[38px] flex-wrap items-center justify-between gap-2 rounded-2xl border px-4 py-2 font-mono text-[11px] ${subCardCls}`}
            >
              {hoveredBar ? (
                <>
                  <span>
                    Ngày: <strong>{hoveredBar.point.date}</strong> · Đơn:{' '}
                    <strong>{hoveredBar.point.orderCount}</strong> · RMA:{' '}
                    <strong>{hoveredBar.point.rmaCount}</strong>
                  </span>
                  <span className="flex flex-wrap items-center gap-3">
                    <span className={goldTextCls}>
                      Doanh thu: {FORMAT_VND(hoveredBar.point.netRevenueVnd)}
                    </span>
                    {!isCostRedacted &&
                    typeof hoveredBar.point.cogsVnd === 'number' ? (
                      <span>
                        COGS: {FORMAT_VND(hoveredBar.point.cogsVnd)}
                      </span>
                    ) : null}
                    {!isCostRedacted &&
                    typeof hoveredBar.point.grossMarginVnd === 'number' ? (
                      <span className="text-emerald-600">
                        Lãi gộp: {FORMAT_VND(hoveredBar.point.grossMarginVnd)}
                      </span>
                    ) : null}
                  </span>
                </>
              ) : (
                <span className={mutedCls}>
                  Di chuột lên từng cột ngày để xem chi tiết doanh thu
                  {!isCostRedacted ? ', giá vốn COGS & lãi gộp' : ' & số đơn'}.
                </span>
              )}
            </div>

            <div className="w-full overflow-x-auto">
              <svg
                viewBox="0 0 820 220"
                className="h-56 w-full min-w-[540px]"
                role="img"
                aria-label="Biểu đồ doanh thu theo ngày"
              >
                <defs>
                  <linearGradient id="biRevArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#B08A4A" stopOpacity="0.28" />
                    <stop offset="100%" stopColor="#B08A4A" stopOpacity="0.02" />
                  </linearGradient>
                </defs>

                {/* Horizontal Guide Lines */}
                {[0.25, 0.5, 0.75, 1].map((pct) => {
                  const y = 18 + (1 - pct) * 176;
                  return (
                    <g key={pct}>
                      <line
                        x1="20"
                        x2="800"
                        y1={y}
                        y2={y}
                        stroke={darkMode ? '#3A2C22' : '#EBD9B4'}
                        strokeDasharray="3 4"
                      />
                      <text
                        x="22"
                        y={y - 3}
                        fontSize="9"
                        fill={darkMode ? '#B4A391' : '#7A6A5B'}
                        fontFamily="monospace"
                      >
                        {formatVndCompact(chartMaxVnd * pct)}
                      </text>
                    </g>
                  );
                })}

                {/* Smooth Area Under Net Revenue */}
                {svgPoints.areaPath ? (
                  <path d={svgPoints.areaPath} fill="url(#biRevArea)" />
                ) : null}
                {svgPoints.linePath ? (
                  <path
                    d={svgPoints.linePath}
                    fill="none"
                    stroke="#B08A4A"
                    strokeWidth="2"
                  />
                ) : null}

                {/* Bars */}
                {svgPoints.bars.map((bar) => {
                  const isHovered = hoveredIdx === bar.idx;
                  const showLabel =
                    series.length <= 14 ||
                    bar.idx % Math.ceil(series.length / 10) === 0 ||
                    bar.idx === series.length - 1;
                  return (
                    <g
                      key={bar.point.date}
                      onMouseEnter={() => setHoveredIdx(bar.idx)}
                      onMouseLeave={() => setHoveredIdx(null)}
                      className="cursor-pointer"
                    >
                      {/* Net Revenue Bar */}
                      <rect
                        x={
                          isCostRedacted
                            ? bar.x - bar.w / 2
                            : bar.x - bar.w - 1
                        }
                        y={bar.revY}
                        width={bar.w}
                        height={bar.revH}
                        rx="3"
                        fill={isHovered ? '#EBCF8F' : '#B08A4A'}
                        opacity={isHovered ? 1 : 0.85}
                      />

                      {/* COGS Bar (Authorized Only) */}
                      {!isCostRedacted && bar.cogsH > 0 ? (
                        <rect
                          x={bar.x + 1}
                          y={bar.cogsY}
                          width={bar.w}
                          height={bar.cogsH}
                          rx="3"
                          fill="#2E6B47"
                          opacity={isHovered ? 1 : 0.8}
                        />
                      ) : null}

                      {showLabel ? (
                        <text
                          x={bar.x}
                          y="212"
                          textAnchor="middle"
                          fontSize="9"
                          fill={darkMode ? '#B4A391' : '#7A6A5B'}
                          fontFamily="monospace"
                        >
                          {formatShortDate(bar.point.date)}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
        )}
      </section>

      {/* Bottom 2-Column Analytical Tables: Top Selling SKUs & High RMA Rate SKUs */}
      <div className="grid gap-6 xl:grid-cols-2">
        {/* Table 1: Top Selling SKUs */}
        <section className={`overflow-hidden rounded-3xl border ${cardCls}`}>
          <div className="border-b border-[#B08A4A]/20 px-6 py-4">
            <p className={`ledger-eyebrow ${goldTextCls}`}>
              Best Sellers ({biData?.topSkus.length ?? 0} SKU)
            </p>
            <h3 className="font-editorial mt-0.5 text-2xl">
              Top SKU Bán chạy nhất
            </h3>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead
                className={`text-[10px] uppercase tracking-[0.14em] ${tableHeadCls}`}
              >
                <tr>
                  <th className="px-4 py-3">SKU / Sản phẩm</th>
                  <th className="px-3 py-3 text-right">SL bán</th>
                  <th className="px-3 py-3 text-right">Doanh thu ròng</th>
                  {!isCostRedacted ? (
                    <th className="px-4 py-3 text-right">Lãi gộp</th>
                  ) : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#B08A4A]/15">
                {!biData || biData.topSkus.length === 0 ? (
                  <tr>
                    <td
                      colSpan={isCostRedacted ? 3 : 4}
                      className={`px-4 py-8 text-center text-xs ${mutedCls}`}
                    >
                      Chưa có dữ liệu SKU bán chạy trong kỳ {range}.
                    </td>
                  </tr>
                ) : (
                  biData.topSkus.map((sku) => (
                    <tr key={sku.skuId} className={rowHoverCls}>
                      <td className="px-4 py-3">
                        <p className="font-medium">{sku.productName}</p>
                        <p className={`font-mono text-[10.5px] ${mutedCls}`}>
                          {sku.skuCode}
                        </p>
                      </td>
                      <td className="adm-tabular px-3 py-3 text-right font-mono font-semibold">
                        {sku.unitsSold}
                      </td>
                      <td
                        className={`adm-tabular px-3 py-3 text-right font-mono font-semibold ${goldTextCls}`}
                      >
                        {FORMAT_VND(sku.netRevenueVnd)}
                      </td>
                      {!isCostRedacted ? (
                        <td className="adm-tabular px-4 py-3 text-right font-mono">
                          {typeof sku.grossMarginVnd === 'number' ? (
                            <span
                              className={
                                darkMode ? 'text-emerald-300' : 'text-[#1E4B32]'
                              }
                            >
                              {FORMAT_VND(sku.grossMarginVnd)}
                              {typeof sku.grossMarginPct === 'number'
                                ? ` (${sku.grossMarginPct.toFixed(0)}%)`
                                : ''}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                      ) : null}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Table 2: High RMA Rate SKUs */}
        <section className={`overflow-hidden rounded-3xl border ${cardCls}`}>
          <div className="border-b border-[#B08A4A]/20 px-6 py-4">
            <p className={`ledger-eyebrow ${goldTextCls}`}>
              Fit &amp; Quality Risk Alert ({biData?.highRmaSkus.length ?? 0}{' '}
              SKU)
            </p>
            <h3 className="font-editorial mt-0.5 text-2xl">
              Top SKU có Tỷ lệ Đổi trả (RMA) cao
            </h3>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead
                className={`text-[10px] uppercase tracking-[0.14em] ${tableHeadCls}`}
              >
                <tr>
                  <th className="px-4 py-3">SKU / Sản phẩm</th>
                  <th className="px-3 py-3 text-right">RMA / Bán</th>
                  <th className="px-3 py-3 text-right">Tỷ lệ RMA</th>
                  <th className="px-4 py-3">Lý do chủ đạo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#B08A4A]/15">
                {!biData || biData.highRmaSkus.length === 0 ? (
                  <tr>
                    <td
                      colSpan={4}
                      className={`px-4 py-8 text-center text-xs ${mutedCls}`}
                    >
                      Chưa ghi nhận SKU có tỷ lệ đổi trả bất thường trong kỳ{' '}
                      {range}.
                    </td>
                  </tr>
                ) : (
                  biData.highRmaSkus.map((sku) => {
                    const highRisk = sku.rmaRatePct >= 15;
                    return (
                      <tr key={sku.skuId} className={rowHoverCls}>
                        <td className="px-4 py-3">
                          <p className="font-medium">{sku.productName}</p>
                          <p className={`font-mono text-[10.5px] ${mutedCls}`}>
                            {sku.skuCode}
                          </p>
                        </td>
                        <td className="adm-tabular px-3 py-3 text-right font-mono">
                          <strong>{sku.rmaCount}</strong> / {sku.unitsSold}
                        </td>
                        <td className="adm-tabular px-3 py-3 text-right font-mono">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${
                              highRisk
                                ? 'bg-rose-500/15 text-rose-600'
                                : 'bg-amber-500/15 text-amber-600'
                            }`}
                          >
                            {sku.rmaRatePct.toFixed(1)}%
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px]">
                          {sku.dominantReasonCode}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
