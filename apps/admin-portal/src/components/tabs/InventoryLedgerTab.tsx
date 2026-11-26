'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import {
  InventoryLedgerReason,
  Permission,
  ReservationStatus,
  WarehouseType,
  hasPermission,
  type InventoryLedgerEntryDto,
  type Role,
  type StockLevelAdminDto,
  type StockReservationAdminDto,
  type WarehouseDto,
} from '@atelier/contracts';
import {
  AnimatedTelemetryNumber,
  LiveStackedHealthBar,
  LiveStreamProgressBar,
} from '@atelier/motion-kit';
import {
  adminFetch,
  buildQueryString,
  extractList,
  extractPaginatedList,
  getAdminSession,
  type PaginationMeta,
} from '@/lib/api-client';
import { emitPortalToast } from '../PortalToastBanner';

export interface InventoryLedgerTabProps {
  roles?: readonly Role[];
  darkMode?: boolean;
  onRefreshOverview?: () => void;
}

interface ExtendedStockLevel extends StockLevelAdminDto {
  damagedQty?: number;
  lowStockThreshold?: number;
}

interface ExtendedLedgerEntry extends Omit<InventoryLedgerEntryDto, 'reason'> {
  reason: string;
  movementType?: string;
  skuCode?: string;
  sku?: string;
  reasonCode?: string;
  deltaQty?: number;
  deltaDamaged?: number;
  beforeQty?: number;
  afterQty?: number;
  transferRef?: string | null;
  referenceCode?: string | null;
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 19);
  }
}

function formatSignedDelta(value: number): string {
  if (value > 0) return `+${value}`;
  return String(value);
}

const RESERVATION_STATUS_META: Record<
  ReservationStatus,
  { label: string; className: string }
> = {
  [ReservationStatus.ACTIVE]: {
    label: 'ACTIVE · Đang giữ chỗ',
    className: 'border-[#B08A4A]/55 bg-[#FFF8EB] text-[#8A5A12]',
  },
  [ReservationStatus.COMMITTED]: {
    label: 'COMMITTED · Đã chốt đơn',
    className: 'border-[#2E6B47]/40 bg-[#F2FBF6] text-[#1E4B32]',
  },
  [ReservationStatus.EXPIRED]: {
    label: 'EXPIRED · Hết hạn 15p',
    className: 'border-[#7A6A5B]/35 bg-[#F4EBDA]/65 text-[#5C4B41]',
  },
  [ReservationStatus.RELEASED]: {
    label: 'RELEASED · Đã hoàn tồn',
    className: 'border-[#5C4B41]/35 bg-[#F8F5F0] text-[#5C4B41]',
  },
};

const LEDGER_REASON_LABELS: Record<string, string> = {
  [InventoryLedgerReason.INITIAL_SEED]: 'Khởi tạo tồn',
  [InventoryLedgerReason.RESERVE]: 'Giữ chỗ (Reserve)',
  [InventoryLedgerReason.COMMIT]: 'Chốt đơn (Commit)',
  [InventoryLedgerReason.RELEASE_EXPIRED]: 'Tự nhả hết hạn',
  [InventoryLedgerReason.CANCEL_RELEASE]: 'Hủy giữ chỗ',
  [InventoryLedgerReason.GRN_INBOUND]: 'Nhập kho GRN',
  [InventoryLedgerReason.RMA_RESTOCK]: 'Hoàn kho RMA',
  [InventoryLedgerReason.ADJUSTMENT]: 'Kiểm kê / Điều chỉnh',
  TRANSFER_OUT: 'Xuất chuyển kho',
  TRANSFER_IN: 'Nhập chuyển kho',
};

const ADJUSTMENT_REASON_CODES = [
  { code: 'CYCLE_COUNT', label: 'CYCLE_COUNT · Kiểm kê định kỳ' },
  { code: 'DAMAGE_WRITE_OFF', label: 'DAMAGE_WRITE_OFF · Ghi nhận hàng lỗi / hư hỏng' },
  { code: 'FOUND_STOCK', label: 'FOUND_STOCK · Tìm thấy tồn kho dư' },
  { code: 'SAMPLE_PULL', label: 'SAMPLE_PULL · Xuất mẫu chụp Lookbook / Showroom' },
  { code: 'CORRECTION', label: 'CORRECTION · Hiệu chỉnh sai lệch sổ sách' },
] as const;

const LEDGER_TYPE_OPTIONS = [
  { value: 'ALL', label: 'Tất cả loại biến động' },
  { value: 'ADJUSTMENT', label: 'Kiểm kê / Điều chỉnh' },
  { value: 'TRANSFER_OUT', label: 'Chuyển kho đi (TRANSFER_OUT)' },
  { value: 'TRANSFER_IN', label: 'Chuyển kho đến (TRANSFER_IN)' },
  { value: 'GRN_INBOUND', label: 'Nhập kho GRN' },
  { value: 'RESERVE', label: 'Giữ chỗ 15p' },
  { value: 'COMMIT', label: 'Chốt đơn' },
  { value: 'CANCEL_RELEASE', label: 'Hủy giữ chỗ' },
  { value: 'RELEASE_EXPIRED', label: 'Hết hạn giữ chỗ' },
  { value: 'RMA_RESTOCK', label: 'Hoàn kho RMA' },
] as const;

type StockStatusFilter = 'ALL' | 'LOW' | 'OUT' | 'RESERVED';
type ReservationStatusFilter = 'ALL' | ReservationStatus;

export function InventoryLedgerTab({
  roles,
  onRefreshOverview,
}: InventoryLedgerTabProps) {
  const effectiveRoles = useMemo<readonly Role[]>(
    () =>
      roles && roles.length > 0
        ? roles
        : (getAdminSession()?.user.roles ?? []),
    [roles],
  );
  const canWriteInventory = hasPermission(
    effectiveRoles,
    Permission.INVENTORY_STOCK_WRITE,
  );

  const [warehouses, setWarehouses] = useState<WarehouseDto[]>([]);
  const [stockLevels, setStockLevels] = useState<ExtendedStockLevel[]>([]);
  const [reservations, setReservations] = useState<StockReservationAdminDto[]>(
    [],
  );
  const [ledger, setLedger] = useState<ExtendedLedgerEntry[]>([]);
  const [ledgerPagination, setLedgerPagination] = useState<PaginationMeta>({
    page: 1,
    limit: 15,
    total: 0,
    totalPages: 1,
  });

  const [loading, setLoading] = useState(true);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // Stock & Reservations Filters
  const [selectedWarehouseCode, setSelectedWarehouseCode] =
    useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [stockStatusFilter, setStockStatusFilter] =
    useState<StockStatusFilter>('ALL');
  const [reservationFilter, setReservationFilter] =
    useState<ReservationStatusFilter>('ALL');

  // Server-side Ledger Filters & Pagination
  const [ledgerPage, setLedgerPage] = useState(1);
  const [ledgerLimit, setLedgerLimit] = useState(15);
  const [ledgerWarehouseFilter, setLedgerWarehouseFilter] = useState('ALL');
  const [ledgerTypeFilter, setLedgerTypeFilter] = useState('ALL');
  const [ledgerSkuQuery, setLedgerSkuQuery] = useState('');

  // Modal 1: Stock Adjustment
  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [adjSkuKey, setAdjSkuKey] = useState('');
  const [adjWarehouseCode, setAdjWarehouseCode] = useState('CENTRAL_WH');
  const [adjDeltaAvailable, setAdjDeltaAvailable] = useState(0);
  const [adjDeltaDamaged, setAdjDeltaDamaged] = useState(0);
  const [adjReasonCode, setAdjReasonCode] = useState<string>('CYCLE_COUNT');
  const [adjNote, setAdjNote] = useState('');

  // Modal 2: Inter-Warehouse Transfer
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [trSkuKey, setTrSkuKey] = useState('');
  const [trFromWarehouse, setTrFromWarehouse] = useState('CENTRAL_WH');
  const [trToWarehouse, setTrToWarehouse] = useState('HN_ATELIER');
  const [trQuantity, setTrQuantity] = useState(1);
  const [trNote, setTrNote] = useState('');

  // Modal 3: Warehouse Manager
  const [showWarehouseModal, setShowWarehouseModal] = useState(false);
  const [editingWhCode, setEditingWhCode] = useState<string | null>(null);
  const [whCode, setWhCode] = useState('');
  const [whName, setWhName] = useState('');
  const [whType, setWhType] = useState<WarehouseType>(WarehouseType.SHOWROOM);
  const [whCity, setWhCity] = useState('Hà Nội');
  const [whAddress, setWhAddress] = useState('');
  const [whPriority, setWhPriority] = useState(10);
  const [whIsActive, setWhIsActive] = useState(true);

  // Inline safetyThreshold edit state
  const [editingThresholdRowId, setEditingThresholdRowId] = useState<
    string | null
  >(null);
  const [thresholdDraftValue, setThresholdDraftValue] = useState(3);

  const loadLedger = useCallback(
    async (
      page = ledgerPage,
      limit = ledgerLimit,
      whCodeFilter = ledgerWarehouseFilter,
      typeFilter = ledgerTypeFilter,
      skuFilter = ledgerSkuQuery,
    ) => {
      setLedgerLoading(true);
      const qs = buildQueryString({
        page,
        limit,
        warehouseCode: whCodeFilter !== 'ALL' ? whCodeFilter : undefined,
        movementType: typeFilter !== 'ALL' ? typeFilter : undefined,
        reason: typeFilter !== 'ALL' ? typeFilter : undefined,
        sku: skuFilter.trim() || undefined,
      });

      const res = await adminFetch<unknown>(
        `/api/v1/admin/inventory/ledger${qs}`,
      );
      if (res.ok) {
        const parsed = extractPaginatedList<ExtendedLedgerEntry>(
          res.data,
          ['items', 'ledger', 'rows', 'list'],
          limit,
        );
        // Client-side pagination fallback when upstream returns an unpaginated full array
        if (
          Array.isArray(res.data) &&
          parsed.items.length > limit
        ) {
          const start = (page - 1) * limit;
          setLedger(parsed.items.slice(start, start + limit));
          setLedgerPagination({
            page,
            limit,
            total: parsed.items.length,
            totalPages: Math.max(1, Math.ceil(parsed.items.length / limit)),
          });
        } else {
          setLedger(parsed.items);
          setLedgerPagination(parsed.pagination);
        }
      }
      setLedgerLoading(false);
    },
    [
      ledgerLimit,
      ledgerPage,
      ledgerSkuQuery,
      ledgerTypeFilter,
      ledgerWarehouseFilter,
    ],
  );

  const loadAllInventoryData = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);

    const [whRes, stockRes, resvRes] = await Promise.all([
      adminFetch<unknown>('/api/v1/admin/inventory/warehouses'),
      adminFetch<unknown>('/api/v1/admin/inventory/stock-levels'),
      adminFetch<unknown>('/api/v1/admin/inventory/reservations'),
    ]);

    const failed = [whRes, stockRes, resvRes].find((r) => !r.ok);
    if (failed && !whRes.ok && !stockRes.ok) {
      setErrorMessage(
        failed.error?.message ||
          'Không thể tải dữ liệu tồn kho đa kho. Kiểm tra quyền INVENTORY_STOCK_READ và dịch vụ inventory (:4004).',
      );
    }

    const whList = whRes.ok
      ? extractList<WarehouseDto>(whRes.data, ['items', 'warehouses', 'list'])
      : [];
    const stockList = stockRes.ok
      ? extractList<ExtendedStockLevel>(stockRes.data, [
          'items',
          'stockLevels',
          'list',
        ])
      : [];
    const resvList = resvRes.ok
      ? extractList<StockReservationAdminDto>(resvRes.data, [
          'items',
          'reservations',
          'list',
        ])
      : [];

    if (whRes.ok) setWarehouses(whList);
    if (stockRes.ok) setStockLevels(stockList);
    if (resvRes.ok) setReservations(resvList);

    if (stockList.length > 0) {
      const firstKey = stockList[0]!.skuCode || stockList[0]!.skuId;
      setAdjSkuKey((prev) => prev || firstKey);
      setTrSkuKey((prev) => prev || firstKey);
    }
    if (whList.length > 0) {
      setAdjWarehouseCode((prev) =>
        whList.some((w) => w.code === prev) ? prev : whList[0]!.code,
      );
      setTrFromWarehouse((prev) =>
        whList.some((w) => w.code === prev) ? prev : whList[0]!.code,
      );
      if (whList.length > 1) {
        setTrToWarehouse((prev) =>
          whList.some((w) => w.code === prev) ? prev : whList[1]!.code,
        );
      }
    }

    await loadLedger();
    setLastSyncedAt(new Date().toISOString());
    setLoading(false);
  }, [loadLedger]);

  useEffect(() => {
    void loadAllInventoryData();
  }, [loadAllInventoryData]);

  useEffect(() => {
    void loadLedger(
      ledgerPage,
      ledgerLimit,
      ledgerWarehouseFilter,
      ledgerTypeFilter,
      ledgerSkuQuery,
    );
  }, [
    ledgerPage,
    ledgerLimit,
    ledgerWarehouseFilter,
    ledgerTypeFilter,
    ledgerSkuQuery,
    loadLedger,
  ]);

  const uniqueSkus = useMemo(() => {
    const map = new Map<
      string,
      { key: string; skuId: string; skuCode: string; productId: string }
    >();
    for (const row of stockLevels) {
      const key = row.skuCode || row.skuId;
      if (!map.has(key)) {
        map.set(key, {
          key,
          skuId: row.skuId,
          skuCode: row.skuCode || row.skuId,
          productId: row.productId,
        });
      }
    }
    return Array.from(map.values());
  }, [stockLevels]);

  const warehouseOptions = useMemo(() => {
    if (warehouses.length > 0) return warehouses;
    return [
      {
        id: 'CENTRAL_WH',
        code: 'CENTRAL_WH',
        name: 'Kho Trung Tâm',
        warehouseType: WarehouseType.CENTRAL,
        city: 'Hà Nội',
        isActive: true,
        priority: 1,
      },
      {
        id: 'HN_ATELIER',
        code: 'HN_ATELIER',
        name: 'Showroom Hà Nội',
        warehouseType: WarehouseType.SHOWROOM,
        city: 'Hà Nội',
        isActive: true,
        priority: 2,
      },
      {
        id: 'HCM_SHOWROOM',
        code: 'HCM_SHOWROOM',
        name: 'Showroom TP.HCM',
        warehouseType: WarehouseType.SHOWROOM,
        city: 'TP.HCM',
        isActive: true,
        priority: 3,
      },
    ];
  }, [warehouses]);

  const sourceTransferRow = useMemo(() => {
    return stockLevels.find(
      (r) =>
        (r.skuCode === trSkuKey || r.skuId === trSkuKey) &&
        r.warehouseCode === trFromWarehouse,
    );
  }, [stockLevels, trFromWarehouse, trSkuKey]);

  const adjustTargetRow = useMemo(() => {
    return stockLevels.find(
      (r) =>
        (r.skuCode === adjSkuKey || r.skuId === adjSkuKey) &&
        r.warehouseCode === adjWarehouseCode,
    );
  }, [adjSkuKey, adjWarehouseCode, stockLevels]);

  // Per-warehouse aggregate metrics
  const warehouseStatsMap = useMemo(() => {
    const map = new Map<
      string,
      {
        skuRows: number;
        available: number;
        reserved: number;
        committed: number;
        lowStockCount: number;
        outOfStockCount: number;
      }
    >();

    for (const row of stockLevels) {
      const curr = map.get(row.warehouseCode) ?? {
        skuRows: 0,
        available: 0,
        reserved: 0,
        committed: 0,
        lowStockCount: 0,
        outOfStockCount: 0,
      };
      curr.skuRows += 1;
      curr.available += row.availableQty;
      curr.reserved += row.reservedQty;
      curr.committed += row.committedQty;
      const threshold = row.safetyThreshold ?? row.lowStockThreshold ?? 3;
      if (row.availableQty === 0) {
        curr.outOfStockCount += 1;
      } else if (row.availableQty <= threshold || row.lowStockWarning) {
        curr.lowStockCount += 1;
      }
      map.set(row.warehouseCode, curr);
    }
    return map;
  }, [stockLevels]);

  const kpiTotals = useMemo(() => {
    let available = 0;
    let reserved = 0;
    let committed = 0;
    let lowStockCount = 0;
    let outOfStockCount = 0;

    for (const row of stockLevels) {
      if (
        selectedWarehouseCode !== 'ALL' &&
        row.warehouseCode !== selectedWarehouseCode
      ) {
        continue;
      }
      available += row.availableQty;
      reserved += row.reservedQty;
      committed += row.committedQty;
      const threshold = row.safetyThreshold ?? row.lowStockThreshold ?? 3;
      if (row.availableQty === 0) {
        outOfStockCount += 1;
      } else if (row.availableQty <= threshold || row.lowStockWarning) {
        lowStockCount += 1;
      }
    }

    return {
      available,
      reserved,
      committed,
      lowStockCount,
      outOfStockCount,
    };
  }, [stockLevels, selectedWarehouseCode]);

  const filteredStockLevels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return stockLevels.filter((row) => {
      if (
        selectedWarehouseCode !== 'ALL' &&
        row.warehouseCode !== selectedWarehouseCode
      ) {
        return false;
      }
      const threshold = row.safetyThreshold ?? row.lowStockThreshold ?? 3;
      if (stockStatusFilter === 'OUT' && row.availableQty !== 0) {
        return false;
      }
      if (
        stockStatusFilter === 'LOW' &&
        !(
          row.availableQty >= 1 &&
          (row.availableQty <= threshold || row.lowStockWarning)
        )
      ) {
        return false;
      }
      if (stockStatusFilter === 'RESERVED' && row.reservedQty <= 0) {
        return false;
      }
      if (q) {
        const hay = [
          row.skuCode ?? '',
          row.skuId,
          row.productId,
          row.warehouseCode,
          row.warehouseName,
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [stockLevels, selectedWarehouseCode, stockStatusFilter, searchQuery]);

  const filteredReservations = useMemo(() => {
    return reservations.filter((item) => {
      if (
        reservationFilter !== 'ALL' &&
        item.status !== reservationFilter
      ) {
        return false;
      }
      if (
        selectedWarehouseCode !== 'ALL' &&
        item.warehouseCode &&
        item.warehouseCode !== selectedWarehouseCode &&
        !item.items.some((li) => li.warehouseCode === selectedWarehouseCode)
      ) {
        return false;
      }
      return true;
    });
  }, [reservations, reservationFilter, selectedWarehouseCode]);

  // Write Handlers
  const handleSubmitAdjustment = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canWriteInventory) return;
    if (!adjSkuKey.trim() || !adjWarehouseCode) {
      setErrorMessage('Vui lòng chọn SKU và Kho cần điều chỉnh tồn.');
      return;
    }
    if (adjDeltaAvailable === 0 && adjDeltaDamaged === 0) {
      setErrorMessage(
        'Vui lòng nhập chênh lệch Available hoặc Damaged khác 0.',
      );
      return;
    }

    setBusyAction('adjust');
    setErrorMessage(null);
    const matchedSku = uniqueSkus.find((s) => s.key === adjSkuKey);

    const res = await adminFetch<unknown>(
      '/api/v1/admin/inventory/adjustments',
      {
        method: 'POST',
        body: JSON.stringify({
          sku: matchedSku?.skuCode || adjSkuKey.trim(),
          skuId: matchedSku?.skuId,
          warehouseCode: adjWarehouseCode,
          deltaAvailable: Number(adjDeltaAvailable),
          deltaDamaged: Number(adjDeltaDamaged),
          reasonCode: adjReasonCode,
          note: adjNote.trim() || undefined,
        }),
      },
    );

    if (res.ok) {
      emitPortalToast({
        kind: 'success',
        title: 'KIỂM KÊ & ĐIỀU CHỈNH TỒN',
        message: `Đã điều chỉnh tồn kho ${adjSkuKey} tại ${adjWarehouseCode} (Avl ${formatSignedDelta(adjDeltaAvailable)}, Damaged ${formatSignedDelta(adjDeltaDamaged)}) và ghi sổ cái bất biến.`,
      });
      setShowAdjustModal(false);
      setAdjDeltaAvailable(0);
      setAdjDeltaDamaged(0);
      setAdjNote('');
      await loadAllInventoryData();
      onRefreshOverview?.();
    } else {
      setErrorMessage(
        res.error?.message ||
          'Điều chỉnh tồn kho thất bại. Kiểm tra số tồn sau điều chỉnh ≥ 0 và phiên 2FA.',
      );
    }
    setBusyAction(null);
  };

  const handleSubmitTransfer = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canWriteInventory) return;
    if (!trSkuKey.trim() || !trFromWarehouse || !trToWarehouse) {
      setErrorMessage('Vui lòng chọn đầy đủ SKU, Kho xuất và Kho nhận.');
      return;
    }
    if (trFromWarehouse === trToWarehouse) {
      setErrorMessage('Kho xuất và Kho nhận phải khác nhau.');
      return;
    }
    if (trQuantity <= 0) {
      setErrorMessage('Số lượng chuyển kho phải lớn hơn 0.');
      return;
    }

    setBusyAction('transfer');
    setErrorMessage(null);
    const matchedSku = uniqueSkus.find((s) => s.key === trSkuKey);

    const res = await adminFetch<{ transferRef?: string }>(
      '/api/v1/admin/inventory/transfers',
      {
        method: 'POST',
        body: JSON.stringify({
          sku: matchedSku?.skuCode || trSkuKey.trim(),
          skuId: matchedSku?.skuId,
          fromWarehouseCode: trFromWarehouse,
          toWarehouseCode: trToWarehouse,
          quantity: Number(trQuantity),
          note: trNote.trim() || undefined,
        }),
      },
    );

    if (res.ok) {
      const refText = res.data?.transferRef
        ? ` (Mã phiếu ${res.data.transferRef})`
        : '';
      emitPortalToast({
        kind: 'success',
        title: 'CHUYỂN KHO NỘI BỘ',
        message: `Đã chuyển ${trQuantity} × ${trSkuKey} từ ${trFromWarehouse} → ${trToWarehouse}${refText}.`,
      });
      setShowTransferModal(false);
      setTrQuantity(1);
      setTrNote('');
      await loadAllInventoryData();
      onRefreshOverview?.();
    } else {
      setErrorMessage(
        res.error?.message ||
          'Chuyển kho nội bộ thất bại. Kiểm tra tồn kho khả dụng tại kho nguồn.',
      );
    }
    setBusyAction(null);
  };

  const openWarehouseCreateForm = () => {
    setEditingWhCode(null);
    setWhCode('');
    setWhName('');
    setWhType(WarehouseType.SHOWROOM);
    setWhCity('Hà Nội');
    setWhAddress('');
    setWhPriority(10);
    setWhIsActive(true);
  };

  const openWarehouseEditForm = (wh: WarehouseDto) => {
    setEditingWhCode(wh.code);
    setWhCode(wh.code);
    setWhName(wh.name);
    setWhType(wh.warehouseType);
    setWhCity(wh.city);
    setWhAddress(wh.address ?? '');
    setWhPriority(wh.priority);
    setWhIsActive(wh.isActive);
  };

  const handleSaveWarehouse = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canWriteInventory) return;
    const normalizedCode = whCode.trim().toUpperCase().replace(/\s+/g, '_');
    if (!normalizedCode || !whName.trim()) {
      setErrorMessage('Mã kho và Tên kho là bắt buộc.');
      return;
    }

    setBusyAction('warehouse');
    setErrorMessage(null);

    const isEdit = Boolean(editingWhCode);
    const url = isEdit
      ? `/api/v1/admin/inventory/warehouses/${encodeURIComponent(editingWhCode!)}`
      : '/api/v1/admin/inventory/warehouses';

    const res = await adminFetch<WarehouseDto>(url, {
      method: isEdit ? 'PATCH' : 'POST',
      body: JSON.stringify({
        code: normalizedCode,
        name: whName.trim(),
        warehouseType: whType,
        city: whCity.trim() || 'Hà Nội',
        address: whAddress.trim() || undefined,
        priority: Number(whPriority) || 10,
        isActive: whIsActive,
      }),
    });

    if (res.ok) {
      emitPortalToast({
        kind: 'success',
        title: 'QUẢN LÝ KHO',
        message: isEdit
          ? `Đã cập nhật kho ${normalizedCode} (${whName.trim()}).`
          : `Đã tạo mới kho ${normalizedCode} (${whName.trim()}).`,
      });
      openWarehouseCreateForm();
      await loadAllInventoryData();
    } else {
      setErrorMessage(
        res.error?.message || 'Không thể lưu thông tin kho hàng.',
      );
    }
    setBusyAction(null);
  };

  const handleSaveSafetyThreshold = async (row: ExtendedStockLevel) => {
    if (!canWriteInventory) return;
    const nextVal = Math.max(0, Math.floor(Number(thresholdDraftValue) || 0));
    const skuParam = row.skuCode || row.skuId;
    setBusyAction(`threshold-${row.id}`);
    setErrorMessage(null);

    const res = await adminFetch<unknown>(
      `/api/v1/admin/inventory/stock/${encodeURIComponent(skuParam)}/threshold`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          safetyThreshold: nextVal,
          warehouseCode: row.warehouseCode,
          skuId: row.skuId,
        }),
      },
    );

    if (res.ok) {
      emitPortalToast({
        kind: 'success',
        title: 'NGƯỠNG CẢNH BÁO TỒN',
        message: `Đã cập nhật ngưỡng an toàn SKU ${skuParam} (${row.warehouseCode}) → ${nextVal}.`,
      });
      setEditingThresholdRowId(null);
      await loadAllInventoryData();
    } else {
      setErrorMessage(
        res.error?.message || 'Không thể cập nhật ngưỡng cảnh báo tồn kho.',
      );
    }
    setBusyAction(null);
  };

  const openQuickAdjustForRow = (row: ExtendedStockLevel) => {
    setAdjSkuKey(row.skuCode || row.skuId);
    setAdjWarehouseCode(row.warehouseCode);
    setAdjDeltaAvailable(0);
    setAdjDeltaDamaged(0);
    setAdjReasonCode('CYCLE_COUNT');
    setAdjNote('');
    setShowAdjustModal(true);
  };

  const openQuickTransferForRow = (row: ExtendedStockLevel) => {
    setTrSkuKey(row.skuCode || row.skuId);
    setTrFromWarehouse(row.warehouseCode);
    const otherWh = warehouseOptions.find((w) => w.code !== row.warehouseCode);
    if (otherWh) setTrToWarehouse(otherWh.code);
    setTrQuantity(1);
    setTrNote('');
    setShowTransferModal(true);
  };

  return (
    <div data-testid="inventory-ledger-tab" className="space-y-8">
      {/* Header & Operational Action Bar */}
      <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="ledger-eyebrow text-[#8A672C]">
                Multi-Warehouse Inventory &amp; Soft Reservations Ledger
              </p>
              {!canWriteInventory ? (
                <span
                  data-testid="inventory-readonly-badge"
                  className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/45 bg-amber-50 px-3 py-0.5 font-mono text-[10px] font-semibold text-amber-800"
                >
                  🔒 Chế độ chỉ đọc tồn kho (INVENTORY_STOCK_READ)
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[#2E6B47]/35 bg-[#F2FBF6] px-3 py-0.5 font-mono text-[10px] font-semibold text-[#1E4B32]">
                  ● Toàn quyền Kiểm kê &amp; Chuyển kho
                </span>
              )}
            </div>
            <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Tồn kho đa kho &amp; Vận hành Sổ cái Tồn
            </h2>
            <p className="mt-1 text-xs text-[#7A6A5B]">
              Theo dõi thời gian thực{' '}
              <code>Available / Reserved / Committed / Damaged</code> trên các
              kho chuẩn (<code>CENTRAL_WH</code>, <code>HN_ATELIER</code>,{' '}
              <code>HCM_SHOWROOM</code>), điều chỉnh kiểm kê, chuyển kho nội bộ
              và nhật ký giữ chỗ 15 phút.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {canWriteInventory ? (
              <>
                <button
                  type="button"
                  data-testid="btn-open-inventory-adjust"
                  onClick={() => setShowAdjustModal(true)}
                  className="rounded-full bg-[#1C1410] px-4 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-[#EBCF8F] hover:opacity-90"
                >
                  ± Kiểm kê / Điều chỉnh
                </button>
                <button
                  type="button"
                  data-testid="btn-open-inventory-transfer"
                  onClick={() => setShowTransferModal(true)}
                  className="rounded-full border border-[#1C1410] bg-[#FBF7EF] px-4 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-[#1C1410] hover:bg-[#1C1410] hover:text-[#EBCF8F]"
                >
                  ⇄ Chuyển kho nội bộ
                </button>
                <button
                  type="button"
                  data-testid="btn-open-warehouse-manager"
                  onClick={() => {
                    openWarehouseCreateForm();
                    setShowWarehouseModal(true);
                  }}
                  className="rounded-full border border-[#B08A4A]/50 bg-white px-4 py-2 text-[11px] font-medium text-[#8A672C] hover:bg-[#F4EBDA]"
                >
                  Quản lý Kho ({warehouses.length})
                </button>
              </>
            ) : null}

            <button
              type="button"
              disabled={loading}
              onClick={() => void loadAllInventoryData()}
              className="rounded-full border border-[#B08A4A]/45 bg-[#FBF7EF] px-4 py-2 text-xs text-[#1C1410] hover:bg-[#F4EBDA] disabled:opacity-50"
            >
              {loading ? 'Đang tải...' : 'Làm mới'}
            </button>
          </div>
        </div>

        {lastSyncedAt ? (
          <p className="mt-2 font-mono text-[10.5px] text-[#7A6A5B]">
            Đồng bộ sổ cái lúc: {formatDateTime(lastSyncedAt)}
          </p>
        ) : null}

        {errorMessage ? (
          <div
            role="alert"
            className="mt-4 rounded-2xl border border-[#8B2E2E]/35 bg-[#FFF5F4] px-4 py-3 text-xs text-[#8B2E2E]"
          >
            {errorMessage}
          </div>
        ) : null}

        {/* Warehouse Summary Filter Pills */}
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <button
            type="button"
            onClick={() => setSelectedWarehouseCode('ALL')}
            className={`rounded-2xl border p-4 text-left transition-colors ${
              selectedWarehouseCode === 'ALL'
                ? 'border-[#1C1410] bg-[#1C1410] text-[#FBF7EF]'
                : 'border-[#B08A4A]/30 bg-[#FBF7EF] text-[#1C1410] hover:border-[#8A672C]'
            }`}
          >
            <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.16em]">
              <span className="font-mono">ALL_WAREHOUSES</span>
              <span>{warehouses.length} kho</span>
            </div>
            <p className="font-editorial mt-1 text-xl">Toàn hệ thống kho</p>
            <p className="mt-1 font-mono text-[11px] opacity-80">
              {stockLevels.length} bản ghi SKU
            </p>
          </button>

          {warehouses.map((wh) => {
            const active = selectedWarehouseCode === wh.code;
            const stats = warehouseStatsMap.get(wh.code);
            return (
              <button
                key={wh.id}
                type="button"
                onClick={() => setSelectedWarehouseCode(wh.code)}
                className={`rounded-2xl border p-4 text-left transition-colors ${
                  active
                    ? 'border-[#1C1410] bg-[#1C1410] text-[#FBF7EF]'
                    : 'border-[#B08A4A]/30 bg-[#FBF7EF] text-[#1C1410] hover:border-[#8A672C]'
                }`}
              >
                <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.14em]">
                  <span className="font-mono font-semibold text-[#B08A4A]">
                    {wh.code}
                  </span>
                  <span>
                    {!wh.isActive
                      ? 'Ngưng hoạt động'
                      : wh.warehouseType === WarehouseType.CENTRAL
                        ? 'Kho tổng'
                        : 'Showroom'}
                  </span>
                </div>
                <p className="mt-1 truncate text-sm font-medium">{wh.name}</p>
                <p className="mt-1 font-mono text-[11px] opacity-80">
                  Avl {stats?.available ?? 0} · Res {stats?.reserved ?? 0} · Com{' '}
                  {stats?.committed ?? 0}
                </p>
              </button>
            );
          })}
        </div>

        {/* KPI Totals Strip */}
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <div className="rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF] p-3.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[#7A6A5B]">
              Sẵn bán (Available)
            </p>
            <p className="mt-1 font-mono text-2xl font-semibold text-[#1C1410]">
              <AnimatedTelemetryNumber value={kpiTotals.available} />
            </p>
          </div>
          <div className="rounded-2xl border border-[#B08A4A]/30 bg-[#FFF8EB] p-3.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[#8A5A12]">
              Đang giữ chỗ (Reserved)
            </p>
            <p className="mt-1 font-mono text-2xl font-semibold text-[#8A5A12]">
              <AnimatedTelemetryNumber value={kpiTotals.reserved} />
            </p>
          </div>
          <div className="rounded-2xl border border-[#2E6B47]/25 bg-[#F2FBF6] p-3.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[#1E4B32]">
              Đã chốt đơn (Committed)
            </p>
            <p className="mt-1 font-mono text-2xl font-semibold text-[#1E4B32]">
              <AnimatedTelemetryNumber value={kpiTotals.committed} />
            </p>
          </div>
          <div className="rounded-2xl border border-[#D9822B]/35 bg-[#FFF6E5] p-3.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[#9A5B13]">
              Dưới ngưỡng cảnh báo
            </p>
            <p className="mt-1 font-mono text-2xl font-semibold text-[#9A5B13]">
              <AnimatedTelemetryNumber value={kpiTotals.lowStockCount} />
            </p>
          </div>
          <div className="rounded-2xl border border-[#8B2E2E]/35 bg-[#FFF5F4] p-3.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[#8B2E2E]">
              Hết hàng (0)
            </p>
            <p className="mt-1 font-mono text-2xl font-semibold text-[#8B2E2E]">
              <AnimatedTelemetryNumber value={kpiTotals.outOfStockCount} />
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF]/75 px-4 py-3">
          <LiveStackedHealthBar
            segments={[
              {
                id: 'available',
                label: 'Sẵn bán',
                value: kpiTotals.available,
                tone: 'emerald',
              },
              {
                id: 'reserved',
                label: 'Đang giữ chỗ 15p',
                value: kpiTotals.reserved,
                tone: 'amber',
              },
              {
                id: 'committed',
                label: 'Đã chốt đơn',
                value: kpiTotals.committed,
                tone: 'gold',
              },
            ]}
          />
        </div>
      </section>

      {/* Searchable & Filterable SKU Stock Table with Inline safetyThreshold Edit */}
      <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="ledger-eyebrow text-[#8A672C]">
              Bảng tồn kho theo SKU &amp; Kho ({filteredStockLevels.length} dòng)
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Tìm theo SKU code, SKU UUID, kho..."
              className="w-64 rounded-full border border-[#B08A4A]/40 bg-[#FBF7EF] px-4 py-1.5 text-xs text-[#1C1410] outline-none focus:border-[#1C1410]"
            />

            {(
              [
                ['ALL', 'Tất cả'],
                ['LOW', 'Sắp hết'],
                ['OUT', 'Hết hàng (0)'],
                ['RESERVED', 'Đang giữ chỗ'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setStockStatusFilter(key)}
                className={`rounded-full px-3.5 py-1.5 text-[11px] transition-colors ${
                  stockStatusFilter === key
                    ? 'bg-[#1C1410] text-[#EBCF8F]'
                    : 'border border-[#B08A4A]/35 bg-[#FBF7EF] text-[#5C4B41]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-[#B08A4A]/25 bg-[#F4EBDA]/65 text-[10px] uppercase tracking-[0.14em] text-[#8A672C]">
              <tr>
                <th className="px-3.5 py-3">Kho</th>
                <th className="px-3.5 py-3">SKU</th>
                <th className="px-3.5 py-3 text-right">Available</th>
                <th className="px-3.5 py-3 text-right">Reserved</th>
                <th className="px-3.5 py-3 text-right">Committed</th>
                <th className="px-3.5 py-3 text-right">Damaged</th>
                <th className="px-3.5 py-3 text-right">Ngưỡng an toàn</th>
                <th className="px-3.5 py-3">Trạng thái</th>
                {canWriteInventory ? (
                  <th className="px-3.5 py-3 text-right">Thao tác</th>
                ) : (
                  <th className="px-3.5 py-3">Cập nhật</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#B08A4A]/15">
              {filteredStockLevels.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    className="px-4 py-8 text-center text-xs text-[#7A6A5B]"
                  >
                    {loading
                      ? 'Đang tải bảng tồn kho...'
                      : 'Không có dòng SKU nào khớp bộ lọc hiện tại.'}
                  </td>
                </tr>
              ) : (
                filteredStockLevels.slice(0, 150).map((row) => {
                  const threshold =
                    row.safetyThreshold ?? row.lowStockThreshold ?? 3;
                  const isOut = row.availableQty === 0;
                  const isLow =
                    !isOut &&
                    (row.availableQty <= threshold || row.lowStockWarning);
                  const isEditingThreshold = editingThresholdRowId === row.id;

                  return (
                    <tr key={row.id} className="hover:bg-[#FBF7EF]/70">
                      <td className="px-3.5 py-2.5">
                        <span className="rounded-md bg-[#F4EBDA] px-2 py-0.5 font-mono text-[11px] font-medium text-[#1C1410]">
                          {row.warehouseCode}
                        </span>
                      </td>
                      <td className="px-3.5 py-2.5 font-mono">
                        <p className="font-semibold text-[#1C1410]">
                          {row.skuCode || row.skuId.slice(0, 14)}
                        </p>
                        <p className="text-[10px] text-[#7A6A5B]">
                          {row.skuId.slice(0, 18)}…
                        </p>
                      </td>
                      <td className="px-3.5 py-2.5 text-right font-mono font-semibold text-[#1C1410]">
                        <span>{row.availableQty}</span>
                        <div className="ml-auto mt-1 w-20">
                          <LiveStreamProgressBar
                            percent={Math.min(
                              100,
                              Math.round(
                                (row.availableQty /
                                  Math.max(1, threshold * 2)) *
                                  100,
                              ),
                            )}
                            tone={isOut ? 'crimson' : isLow ? 'amber' : 'emerald'}
                            height="xs"
                            ariaLabel={`Tồn kho ${row.availableQty} so với ngưỡng an toàn ${threshold}`}
                          />
                        </div>
                      </td>
                      <td className="px-3.5 py-2.5 text-right font-mono text-[#8A5A12]">
                        {row.reservedQty}
                      </td>
                      <td className="px-3.5 py-2.5 text-right font-mono text-[#1E4B32]">
                        {row.committedQty}
                      </td>
                      <td className="px-3.5 py-2.5 text-right font-mono text-[#8B2E2E]">
                        {row.damagedQty ?? 0}
                      </td>
                      <td className="px-3.5 py-2.5 text-right font-mono">
                        {isEditingThreshold && canWriteInventory ? (
                          <div className="inline-flex items-center justify-end gap-1">
                            <input
                              type="number"
                              min={0}
                              max={10000}
                              value={thresholdDraftValue}
                              onChange={(e) =>
                                setThresholdDraftValue(Number(e.target.value))
                              }
                              aria-label="Ngưỡng cảnh báo an toàn"
                              className="w-16 rounded-lg border border-[#1C1410] bg-white px-2 py-1 text-right font-mono text-xs text-[#1C1410]"
                            />
                            <button
                              type="button"
                              disabled={busyAction === `threshold-${row.id}`}
                              onClick={() =>
                                void handleSaveSafetyThreshold(row)
                              }
                              className="rounded-lg bg-[#1C1410] px-2 py-1 text-[10px] text-[#EBCF8F] disabled:opacity-50"
                            >
                              ✓
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingThresholdRowId(null)}
                              className="rounded-lg border border-[#B08A4A]/40 px-2 py-1 text-[10px] text-[#5C4B41]"
                            >
                              ×
                            </button>
                          </div>
                        ) : (
                          <div className="inline-flex items-center justify-end gap-1.5">
                            <span className="text-[#5C4B41]">{threshold}</span>
                            {canWriteInventory ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingThresholdRowId(row.id);
                                  setThresholdDraftValue(threshold);
                                }}
                                title="Sửa ngưỡng cảnh báo an toàn"
                                className="rounded border border-[#B08A4A]/35 px-1.5 py-0.5 text-[10px] text-[#8A672C] hover:bg-[#F4EBDA]"
                              >
                                Sửa
                              </button>
                            ) : null}
                          </div>
                        )}
                      </td>
                      <td className="px-3.5 py-2.5">
                        {isOut ? (
                          <span className="inline-flex rounded-full border border-[#8B2E2E]/40 bg-[#FFF5F4] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-[#8B2E2E]">
                            Out of Stock
                          </span>
                        ) : isLow ? (
                          <span className="inline-flex rounded-full border border-[#D9822B]/45 bg-[#FFF6E5] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-[#9A5B13]">
                            Low Stock · Còn {row.availableQty}
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full border border-[#2E6B47]/35 bg-[#F2FBF6] px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-[#1E4B32]">
                            Ổn định
                          </span>
                        )}
                      </td>
                      {canWriteInventory ? (
                        <td className="px-3.5 py-2.5 text-right">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => openQuickAdjustForRow(row)}
                              className="rounded-full border border-[#B08A4A]/45 bg-[#FBF7EF] px-2.5 py-1 text-[10px] font-medium text-[#1C1410] hover:bg-[#1C1410] hover:text-[#EBCF8F]"
                            >
                              ± Điều chỉnh
                            </button>
                            <button
                              type="button"
                              onClick={() => openQuickTransferForRow(row)}
                              className="rounded-full border border-[#B08A4A]/35 bg-white px-2.5 py-1 text-[10px] font-medium text-[#8A672C] hover:bg-[#F4EBDA]"
                            >
                              ⇄ Chuyển
                            </button>
                          </div>
                        </td>
                      ) : (
                        <td className="px-3.5 py-2.5 font-mono text-[11px] text-[#7A6A5B]">
                          {formatDateTime(row.updatedAt)}
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Bottom 2-Column Operational Panels: Soft Reservations & Paginated Inventory Ledger */}
      <div className="grid gap-6 xl:grid-cols-2">
        {/* 15-Minute Soft Reservations Panel */}
        <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="ledger-eyebrow text-[#8A672C]">
                15-Minute Soft Reservations ({filteredReservations.length})
              </p>
              <h3 className="font-editorial mt-0.5 text-2xl text-[#1C1410]">
                Phiếu giữ chỗ tạm thời
              </h3>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  'ALL',
                  ReservationStatus.ACTIVE,
                  ReservationStatus.COMMITTED,
                  ReservationStatus.EXPIRED,
                  ReservationStatus.RELEASED,
                ] as const
              ).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setReservationFilter(st)}
                  className={`rounded-full px-2.5 py-1 font-mono text-[10px] transition-colors ${
                    reservationFilter === st
                      ? 'bg-[#1C1410] text-[#EBCF8F]'
                      : 'border border-[#B08A4A]/30 bg-[#FBF7EF] text-[#5C4B41]'
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4 max-h-[440px] space-y-3 overflow-y-auto pr-1">
            {filteredReservations.length === 0 ? (
              <p className="rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF] p-6 text-center text-xs text-[#7A6A5B]">
                Chưa có phiếu giữ chỗ nào trong bộ lọc hiện tại.
              </p>
            ) : (
              filteredReservations.map((resv) => {
                const badge = RESERVATION_STATUS_META[resv.status];
                return (
                  <article
                    key={resv.id}
                    className="rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF]/75 p-4 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono font-semibold text-[#1C1410]">
                        {resv.referenceId}
                      </span>
                      <span
                        className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-medium ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-[#5C4B41]">
                      <span className="rounded bg-white px-2 py-0.5 font-mono">
                        {resv.reservationType}
                      </span>
                      <span>Hết hạn: {formatDateTime(resv.expiresAt)}</span>
                      <span>Tạo: {formatDateTime(resv.createdAt)}</span>
                    </div>

                    {resv.items.length > 0 ? (
                      <ul className="mt-2 space-y-1 font-mono text-[11px] text-[#2B2019]">
                        {resv.items.map((line, idx) => (
                          <li key={`${resv.id}-${line.skuId}-${idx}`}>
                            • {line.warehouseCode} · {line.skuId.slice(0, 14)}… ×{' '}
                            <strong>{line.qty}</strong>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </article>
                );
              })
            )}
          </div>
        </section>

        {/* Server-Side Paginated Immutable Inventory Ledger */}
        <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="ledger-eyebrow text-[#8A672C]">
                Immutable Inventory Ledger ({ledgerPagination.total} bút toán)
              </p>
              <h3 className="font-editorial mt-0.5 text-2xl text-[#1C1410]">
                Sổ cái biến động tồn kho (Phân trang)
              </h3>
            </div>
            <span className="font-mono text-[10px] text-[#7A6A5B]">
              Trang {ledgerPagination.page} / {ledgerPagination.totalPages}
            </span>
          </div>

          {/* Ledger Filters */}
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <select
              value={ledgerWarehouseFilter}
              onChange={(e) => {
                setLedgerWarehouseFilter(e.target.value);
                setLedgerPage(1);
              }}
              aria-label="Lọc sổ cái theo kho"
              className="rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-1.5 text-xs text-[#1C1410]"
            >
              <option value="ALL">Tất cả kho</option>
              {warehouseOptions.map((wh) => (
                <option key={wh.code} value={wh.code}>
                  {wh.code}
                </option>
              ))}
            </select>

            <select
              value={ledgerTypeFilter}
              onChange={(e) => {
                setLedgerTypeFilter(e.target.value);
                setLedgerPage(1);
              }}
              aria-label="Lọc sổ cái theo loại biến động"
              className="rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-1.5 text-xs text-[#1C1410]"
            >
              {LEDGER_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            <input
              type="search"
              value={ledgerSkuQuery}
              onChange={(e) => {
                setLedgerSkuQuery(e.target.value);
                setLedgerPage(1);
              }}
              placeholder="Lọc mã SKU..."
              className="rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-1.5 text-xs text-[#1C1410] outline-none focus:border-[#1C1410]"
            />
          </div>

          <div className="mt-4 max-h-[380px] space-y-2.5 overflow-y-auto pr-1">
            {ledgerLoading ? (
              <p className="rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF] p-6 text-center text-xs text-[#7A6A5B]">
                Đang tải sổ cái biến động...
              </p>
            ) : ledger.length === 0 ? (
              <p className="rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF] p-6 text-center text-xs text-[#7A6A5B]">
                Chưa có dòng sổ cái nào khớp bộ lọc.
              </p>
            ) : (
              ledger.map((entry) => {
                const reasonKey = entry.movementType || entry.reason;
                const displayDeltaAvl =
                  entry.deltaAvailable ?? entry.deltaQty ?? 0;
                const refText =
                  entry.referenceId || entry.transferRef || entry.referenceCode;
                return (
                  <article
                    key={entry.id}
                    className="rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF]/75 p-3.5 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-[#1C1410] px-2.5 py-0.5 font-mono text-[10px] text-[#EBCF8F]">
                          {LEDGER_REASON_LABELS[reasonKey] ?? reasonKey}
                        </span>
                        {entry.reasonCode ? (
                          <span className="rounded bg-[#F4EBDA] px-1.5 py-0.5 font-mono text-[10px] text-[#5C4B41]">
                            {entry.reasonCode}
                          </span>
                        ) : null}
                        {entry.warehouseCode ? (
                          <span className="font-mono text-[11px] font-semibold text-[#8A672C]">
                            {entry.warehouseCode}
                          </span>
                        ) : null}
                      </div>
                      <span className="font-mono text-[10px] text-[#7A6A5B]">
                        {formatDateTime(entry.createdAt)}
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[11px]">
                      <span className="text-[#1C1410]">
                        SKU {entry.skuCode || entry.sku || `${entry.skuId.slice(0, 14)}…`}
                      </span>
                      <div className="flex flex-wrap items-center gap-2.5">
                        <span
                          className={
                            displayDeltaAvl < 0
                              ? 'font-semibold text-[#8B2E2E]'
                              : displayDeltaAvl > 0
                                ? 'font-semibold text-[#1E4B32]'
                                : 'text-[#7A6A5B]'
                          }
                        >
                          Avl {formatSignedDelta(displayDeltaAvl)}
                        </span>
                        {entry.deltaReserved ? (
                          <span className="text-[#8A5A12]">
                            Res {formatSignedDelta(entry.deltaReserved)}
                          </span>
                        ) : null}
                        {entry.deltaCommitted ? (
                          <span className="text-[#1E4B32]">
                            Com {formatSignedDelta(entry.deltaCommitted)}
                          </span>
                        ) : null}
                        {entry.deltaDamaged ? (
                          <span className="text-[#8B2E2E]">
                            Dmg {formatSignedDelta(entry.deltaDamaged)}
                          </span>
                        ) : null}
                        <span className="rounded bg-white px-2 py-0.5 font-semibold text-[#1C1410]">
                          Số dư: {entry.balanceAvailable ?? entry.afterQty ?? '—'}
                        </span>
                      </div>
                    </div>

                    {refText || entry.note ? (
                      <p className="mt-1.5 text-[11px] text-[#5C4B41]">
                        {refText ? `Ref: ${refText}` : ''}
                        {refText && entry.note ? ' · ' : ''}
                        {entry.note ?? ''}
                      </p>
                    ) : null}
                  </article>
                );
              })
            )}
          </div>

          {/* Pagination Footer */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-[#B08A4A]/20 pt-3 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-[#7A6A5B]">Hiển thị:</span>
              <select
                value={ledgerLimit}
                onChange={(e) => {
                  setLedgerLimit(Number(e.target.value));
                  setLedgerPage(1);
                }}
                aria-label="Số dòng sổ cái mỗi trang"
                className="rounded-lg border border-[#B08A4A]/35 bg-[#FBF7EF] px-2 py-1 font-mono text-[11px]"
              >
                <option value={10}>10</option>
                <option value={15}>15</option>
                <option value={30}>30</option>
                <option value={50}>50</option>
              </select>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={ledgerPage <= 1 || ledgerLoading}
                onClick={() => setLedgerPage((p) => Math.max(1, p - 1))}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-[11px] text-[#1C1410] hover:bg-[#F4EBDA] disabled:opacity-40"
              >
                ← Trước
              </button>
              <span className="font-mono text-[11px] text-[#5C4B41]">
                {ledgerPagination.page} / {ledgerPagination.totalPages}
              </span>
              <button
                type="button"
                disabled={
                  ledgerPage >= ledgerPagination.totalPages || ledgerLoading
                }
                onClick={() =>
                  setLedgerPage((p) =>
                    Math.min(ledgerPagination.totalPages, p + 1),
                  )
                }
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-[11px] text-[#1C1410] hover:bg-[#F4EBDA] disabled:opacity-40"
              >
                Sau →
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* MODAL 1: Kiểm kê / Điều chỉnh tồn */}
      {showAdjustModal && canWriteInventory ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Kiểm kê và Điều chỉnh tồn kho"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#1C1410]/70 p-4 backdrop-blur-sm"
        >
          <form
            onSubmit={handleSubmitAdjustment}
            className="w-full max-w-lg rounded-3xl border border-[#B08A4A]/40 bg-[#FBF7EF] p-6 shadow-2xl"
          >
            <div className="flex items-start justify-between border-b border-[#B08A4A]/20 pb-3">
              <div>
                <p className="ledger-eyebrow text-[#8A672C]">
                  Atomic Inventory Adjustment
                </p>
                <h3 className="font-editorial mt-0.5 text-3xl text-[#1C1410]">
                  Kiểm kê &amp; Điều chỉnh tồn kho
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowAdjustModal(false)}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-xs text-[#5C4B41]"
              >
                Đóng
              </button>
            </div>

            <div className="mt-4 space-y-3.5 text-xs">
              <label className="block">
                <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                  Kho hàng
                </span>
                <select
                  value={adjWarehouseCode}
                  onChange={(e) => setAdjWarehouseCode(e.target.value)}
                  required
                  className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 text-xs"
                >
                  {warehouseOptions.map((wh) => (
                    <option key={wh.code} value={wh.code}>
                      {wh.code} · {wh.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                  SKU cần kiểm kê
                </span>
                <select
                  value={adjSkuKey}
                  onChange={(e) => setAdjSkuKey(e.target.value)}
                  required
                  className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 font-mono text-xs"
                >
                  {uniqueSkus.map((sku) => (
                    <option key={sku.key} value={sku.key}>
                      {sku.skuCode} ({sku.skuId.slice(0, 10)}…)
                    </option>
                  ))}
                </select>
              </label>

              {adjustTargetRow ? (
                <div className="rounded-xl border border-[#B08A4A]/25 bg-white px-3 py-2 font-mono text-[11px] text-[#5C4B41]">
                  Tồn hiện tại tại <strong>{adjWarehouseCode}</strong>: Available{' '}
                  <strong className="text-[#1C1410]">
                    {adjustTargetRow.availableQty}
                  </strong>{' '}
                  · Damaged{' '}
                  <strong className="text-[#8B2E2E]">
                    {adjustTargetRow.damagedQty ?? 0}
                  </strong>
                  {' → Sau điều chỉnh: '}
                  <strong>
                    Avl {adjustTargetRow.availableQty + adjDeltaAvailable}
                  </strong>
                </div>
              ) : null}

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                    Chênh lệch Available (±)
                  </span>
                  <input
                    type="number"
                    value={adjDeltaAvailable}
                    onChange={(e) =>
                      setAdjDeltaAvailable(Number(e.target.value))
                    }
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 font-mono text-xs"
                  />
                </label>

                <label className="block">
                  <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                    Chênh lệch Damaged (±)
                  </span>
                  <input
                    type="number"
                    value={adjDeltaDamaged}
                    onChange={(e) => setAdjDeltaDamaged(Number(e.target.value))}
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 font-mono text-xs"
                  />
                </label>
              </div>

              <label className="block">
                <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                  Mã lý do (Reason Code)
                </span>
                <select
                  value={adjReasonCode}
                  onChange={(e) => setAdjReasonCode(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 text-xs"
                >
                  {ADJUSTMENT_REASON_CODES.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                  Ghi chú biên bản kiểm kê
                </span>
                <textarea
                  rows={2}
                  value={adjNote}
                  onChange={(e) => setAdjNote(e.target.value)}
                  placeholder="VD: Kiểm đếm thực tế khu kệ A2 cuối tháng..."
                  className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white p-2.5 text-xs"
                />
              </label>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowAdjustModal(false)}
                className="rounded-full border border-[#B08A4A]/40 px-4 py-2 text-xs text-[#5C4B41]"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={busyAction === 'adjust'}
                className="rounded-full bg-[#1C1410] px-6 py-2 text-xs font-medium uppercase tracking-[0.16em] text-[#EBCF8F] disabled:opacity-50"
              >
                {busyAction === 'adjust'
                  ? 'Đang ghi sổ cái...'
                  : 'Xác nhận điều chỉnh'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {/* MODAL 2: Chuyển kho nội bộ */}
      {showTransferModal && canWriteInventory ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Chuyển kho nội bộ"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#1C1410]/70 p-4 backdrop-blur-sm"
        >
          <form
            onSubmit={handleSubmitTransfer}
            className="w-full max-w-lg rounded-3xl border border-[#B08A4A]/40 bg-[#FBF7EF] p-6 shadow-2xl"
          >
            <div className="flex items-start justify-between border-b border-[#B08A4A]/20 pb-3">
              <div>
                <p className="ledger-eyebrow text-[#8A672C]">
                  Inter-Warehouse Stock Transfer (TRANSFER_OUT + TRANSFER_IN)
                </p>
                <h3 className="font-editorial mt-0.5 text-3xl text-[#1C1410]">
                  Chuyển kho nội bộ
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowTransferModal(false)}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-xs text-[#5C4B41]"
              >
                Đóng
              </button>
            </div>

            <div className="mt-4 space-y-3.5 text-xs">
              <label className="block">
                <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                  SKU cần điều chuyển
                </span>
                <select
                  value={trSkuKey}
                  onChange={(e) => setTrSkuKey(e.target.value)}
                  required
                  className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 font-mono text-xs"
                >
                  {uniqueSkus.map((sku) => (
                    <option key={sku.key} value={sku.key}>
                      {sku.skuCode} ({sku.skuId.slice(0, 10)}…)
                    </option>
                  ))}
                </select>
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                    Kho xuất (Nguồn)
                  </span>
                  <select
                    value={trFromWarehouse}
                    onChange={(e) => setTrFromWarehouse(e.target.value)}
                    required
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 text-xs"
                  >
                    {warehouseOptions.map((wh) => (
                      <option key={wh.code} value={wh.code}>
                        {wh.code} · {wh.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                    Kho nhận (Đích)
                  </span>
                  <select
                    value={trToWarehouse}
                    onChange={(e) => setTrToWarehouse(e.target.value)}
                    required
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 text-xs"
                  >
                    {warehouseOptions.map((wh) => (
                      <option key={wh.code} value={wh.code}>
                        {wh.code} · {wh.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="rounded-xl border border-[#B08A4A]/25 bg-white px-3 py-2 font-mono text-[11px] text-[#5C4B41]">
                Khả dụng tại <strong>{trFromWarehouse}</strong>:{' '}
                <strong className="text-[#1C1410]">
                  {sourceTransferRow?.availableQty ?? 0}
                </strong>{' '}
                chiếc
                {trFromWarehouse === trToWarehouse ? (
                  <span className="ml-2 font-semibold text-[#8B2E2E]">
                    (Kho nguồn và đích phải khác nhau)
                  </span>
                ) : null}
              </div>

              <label className="block">
                <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                  Số lượng chuyển
                </span>
                <input
                  type="number"
                  min={1}
                  max={Math.max(1, sourceTransferRow?.availableQty ?? 10000)}
                  required
                  value={trQuantity}
                  onChange={(e) => setTrQuantity(Number(e.target.value))}
                  className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 font-mono text-xs"
                />
              </label>

              <label className="block">
                <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                  Ghi chú điều chuyển
                </span>
                <input
                  type="text"
                  value={trNote}
                  onChange={(e) => setTrNote(e.target.value)}
                  placeholder="VD: Bổ sung size M trưng bày cuối tuần cho Showroom..."
                  className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 text-xs"
                />
              </label>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowTransferModal(false)}
                className="rounded-full border border-[#B08A4A]/40 px-4 py-2 text-xs text-[#5C4B41]"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={
                  busyAction === 'transfer' || trFromWarehouse === trToWarehouse
                }
                className="rounded-full bg-[#1C1410] px-6 py-2 text-xs font-medium uppercase tracking-[0.16em] text-[#EBCF8F] disabled:opacity-50"
              >
                {busyAction === 'transfer'
                  ? 'Đang điều chuyển...'
                  : 'Xác nhận chuyển kho'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {/* MODAL 3: Quản lý Kho (Create / Edit Warehouses) */}
      {showWarehouseModal && canWriteInventory ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Quản lý Danh sách Kho"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#1C1410]/70 p-4 backdrop-blur-sm"
        >
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-[#B08A4A]/40 bg-[#FBF7EF] p-6 shadow-2xl">
            <div className="flex items-start justify-between border-b border-[#B08A4A]/20 pb-3">
              <div>
                <p className="ledger-eyebrow text-[#8A672C]">
                  Warehouse Network CRUD
                </p>
                <h3 className="font-editorial mt-0.5 text-3xl text-[#1C1410]">
                  Quản lý Hệ thống Kho &amp; Showroom
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowWarehouseModal(false)}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-xs text-[#5C4B41]"
              >
                Đóng
              </button>
            </div>

            {/* Existing Warehouses List */}
            <div className="mt-4 space-y-2">
              {warehouses.map((wh) => (
                <div
                  key={wh.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[#B08A4A]/25 bg-white px-4 py-2.5 text-xs"
                >
                  <div>
                    <span className="font-mono font-bold text-[#1C1410]">
                      {wh.code}
                    </span>{' '}
                    · <span className="font-medium">{wh.name}</span>{' '}
                    <span className="text-[11px] text-[#7A6A5B]">
                      ({wh.city} · {wh.warehouseType} · Ưu tiên {wh.priority})
                    </span>
                    {!wh.isActive ? (
                      <span className="ml-2 rounded-full bg-[#FFF5F4] px-2 py-0.5 font-mono text-[10px] text-[#8B2E2E]">
                        INACTIVE
                      </span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => openWarehouseEditForm(wh)}
                    className="rounded-full border border-[#B08A4A]/45 px-3 py-1 text-[11px] text-[#8A672C] hover:bg-[#F4EBDA]"
                  >
                    Chỉnh sửa
                  </button>
                </div>
              ))}
            </div>

            {/* Create / Edit Warehouse Form */}
            <form
              onSubmit={handleSaveWarehouse}
              className="mt-5 rounded-2xl border border-[#B08A4A]/30 bg-white p-4 text-xs"
            >
              <div className="mb-3 flex items-center justify-between">
                <p className="font-semibold text-[#1C1410]">
                  {editingWhCode
                    ? `Chỉnh sửa kho: ${editingWhCode}`
                    : '+ Thêm kho / showroom mới'}
                </p>
                {editingWhCode ? (
                  <button
                    type="button"
                    onClick={openWarehouseCreateForm}
                    className="text-[11px] text-[#8A672C] underline"
                  >
                    Chuyển sang tạo mới
                  </button>
                ) : null}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="uppercase tracking-[0.12em] text-[#8A672C]">
                    Mã kho (Code)
                  </span>
                  <input
                    type="text"
                    required
                    disabled={Boolean(editingWhCode)}
                    value={whCode}
                    onChange={(e) => setWhCode(e.target.value)}
                    placeholder="VD: DN_ATELIER"
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-2 font-mono text-xs disabled:opacity-60"
                  />
                </label>

                <label className="block">
                  <span className="uppercase tracking-[0.12em] text-[#8A672C]">
                    Tên kho
                  </span>
                  <input
                    type="text"
                    required
                    value={whName}
                    onChange={(e) => setWhName(e.target.value)}
                    placeholder="VD: Showroom TryVibe Đà Nẵng"
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-2 text-xs"
                  />
                </label>

                <label className="block">
                  <span className="uppercase tracking-[0.12em] text-[#8A672C]">
                    Loại kho
                  </span>
                  <select
                    value={whType}
                    onChange={(e) => setWhType(e.target.value as WarehouseType)}
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-2 text-xs"
                  >
                    <option value={WarehouseType.CENTRAL}>
                      CENTRAL · Kho tổng
                    </option>
                    <option value={WarehouseType.SHOWROOM}>
                      SHOWROOM · Cửa hàng
                    </option>
                  </select>
                </label>

                <label className="block">
                  <span className="uppercase tracking-[0.12em] text-[#8A672C]">
                    Thành phố
                  </span>
                  <input
                    type="text"
                    required
                    value={whCity}
                    onChange={(e) => setWhCity(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-2 text-xs"
                  />
                </label>

                <label className="block sm:col-span-2">
                  <span className="uppercase tracking-[0.12em] text-[#8A672C]">
                    Địa chỉ
                  </span>
                  <input
                    type="text"
                    value={whAddress}
                    onChange={(e) => setWhAddress(e.target.value)}
                    placeholder="Số nhà, đường, quận/huyện..."
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-2 text-xs"
                  />
                </label>

                <label className="block">
                  <span className="uppercase tracking-[0.12em] text-[#8A672C]">
                    Độ ưu tiên xuất hàng
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={999}
                    value={whPriority}
                    onChange={(e) => setWhPriority(Number(e.target.value))}
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-2 font-mono text-xs"
                  />
                </label>

                <label className="flex items-center gap-2 pt-5">
                  <input
                    type="checkbox"
                    checked={whIsActive}
                    onChange={(e) => setWhIsActive(e.target.checked)}
                    className="h-4 w-4 accent-[#1C1410]"
                  />
                  <span className="font-medium text-[#1C1410]">
                    Kho đang hoạt động (isActive)
                  </span>
                </label>
              </div>

              <div className="mt-4 flex justify-end">
                <button
                  type="submit"
                  disabled={busyAction === 'warehouse'}
                  className="rounded-full bg-[#1C1410] px-5 py-2 text-xs font-medium uppercase tracking-[0.14em] text-[#EBCF8F] disabled:opacity-50"
                >
                  {busyAction === 'warehouse'
                    ? 'Đang lưu...'
                    : editingWhCode
                      ? 'Cập nhật kho'
                      : 'Tạo kho mới'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
