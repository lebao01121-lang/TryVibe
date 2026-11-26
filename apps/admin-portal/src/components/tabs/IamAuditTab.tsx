'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import {
  ALL_PERMISSIONS,
  ALL_ROLES,
  Permission,
  Role,
  UserStatus,
  type AuditLogDto,
  type SupplierDTO,
  type UserSummaryDto,
} from '@atelier/contracts';
import {
  AnimatedTelemetryNumber,
  LiveStackedHealthBar,
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

export interface IamAuditTabProps {
  roles?: readonly Role[];
  mfaVerified?: boolean;
  currentUserId?: string;
  darkMode?: boolean;
  onRefreshOverview?: () => void;
}

interface RoleDetailRow {
  id: string;
  code: Role;
  role: Role;
  name: string;
  description?: string;
  permissions: Permission[];
}

interface ExtendedAuditLog extends AuditLogDto {
  beforeJsonb?: Record<string, unknown> | null;
  afterJsonb?: Record<string, unknown> | null;
}

const PERMISSION_GROUPS: ReadonlyArray<{
  label: string;
  items: readonly Permission[];
}> = [
  {
    label: 'Danh mục & Media',
    items: [
      Permission.CATALOG_PRODUCT_READ,
      Permission.CATALOG_PRODUCT_WRITE,
      Permission.CATALOG_AI_APPROVE,
      Permission.CATALOG_MEDIA_PROCESS,
    ],
  },
  {
    label: 'Kho & Thu mua B2B',
    items: [
      Permission.INVENTORY_STOCK_READ,
      Permission.INVENTORY_STOCK_WRITE,
      Permission.INVENTORY_PO_READ,
      Permission.INVENTORY_PO_CREATE,
      Permission.INVENTORY_PO_APPROVE,
      Permission.INVENTORY_GRN_APPROVE,
    ],
  },
  {
    label: 'Đơn hàng & RMA',
    items: [
      Permission.ORDER_READ,
      Permission.ORDER_MANAGE,
      Permission.ORDER_REFUND_APPROVE,
      Permission.ORDER_RMA_MANAGE,
    ],
  },
  {
    label: 'Giá vốn & Tài chính (Layer 5)',
    items: [
      Permission.FINANCE_COST_PRICE_READ,
      Permission.PROCUREMENT_COST_PRICE_READ,
    ],
  },
  {
    label: 'AI Hub & Partner Portal',
    items: [
      Permission.TRYON_SIGNALS_READ,
      Permission.COPILOT_ACCESS,
      Permission.CUSTOMER_COPILOT_ACCESS,
      Permission.SUPPLIER_PORTAL_ACCESS,
      Permission.SUPPLIER_PO_CONFIRM,
    ],
  },
  {
    label: 'Quản trị IAM & Audit',
    items: [Permission.ADMIN_RBAC_MANAGE, Permission.ADMIN_AUDIT_READ],
  },
];

function computeChangedKeys(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string[] {
  const keys = new Set<string>([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);
  const changed: string[] = [];
  for (const key of keys) {
    const a = JSON.stringify(before?.[key]);
    const b = JSON.stringify(after?.[key]);
    if (a !== b) changed.push(key);
  }
  return changed;
}

export function IamAuditTab({
  roles: callerRolesProp,
  mfaVerified: callerMfaProp,
  currentUserId: callerUserIdProp,
  onRefreshOverview,
}: IamAuditTabProps) {
  const session = getAdminSession();
  const callerRoles = useMemo<readonly Role[]>(
    () =>
      callerRolesProp && callerRolesProp.length > 0
        ? callerRolesProp
        : (session?.user.roles ?? []),
    [callerRolesProp, session?.user.roles],
  );
  const callerMfaVerified =
    callerMfaProp !== undefined
      ? callerMfaProp
      : Boolean(session?.mfaVerified);
  const currentUserId = callerUserIdProp ?? session?.user.id ?? '';
  const canReset2Fa =
    callerRoles.includes(Role.SUPER_ADMIN) && callerMfaVerified;

  // Users & Roles Matrix state
  const [users, setUsers] = useState<UserSummaryDto[]>([]);
  const [roleMatrix, setRoleMatrix] = useState<RoleDetailRow[]>([]);
  const [draftRolePerms, setDraftRolePerms] = useState<
    Record<string, Permission[]>
  >({});
  const [suppliers, setSuppliers] = useState<SupplierDTO[]>([]);
  const [selectedRoleCode, setSelectedRoleCode] = useState<Role>(
    Role.CATALOG_AI_OPERATOR,
  );
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    kind: 'success' | 'error';
    message: string;
  } | null>(null);

  // Create User Modal state
  const [showCreateUserModal, setShowCreateUserModal] = useState(false);
  const [newFullName, setNewFullName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newRoles, setNewRoles] = useState<Role[]>([Role.ORDER_STAFF]);
  const [newSupplierId, setNewSupplierId] = useState('');

  // Confirm Soft-Delete / Reset 2FA Modal state
  const [confirmDeactivateUser, setConfirmDeactivateUser] =
    useState<UserSummaryDto | null>(null);
  const [confirmReset2FaUser, setConfirmReset2FaUser] =
    useState<UserSummaryDto | null>(null);

  // Server-side Paginated Audit Logs state
  const [auditLogs, setAuditLogs] = useState<ExtendedAuditLog[]>([]);
  const [auditPagination, setAuditPagination] = useState<PaginationMeta>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 1,
  });
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditPage, setAuditPage] = useState(1);
  const [auditLimit, setAuditLimit] = useState(20);
  const [auditActionFilter, setAuditActionFilter] = useState('');
  const [auditActorFilter, setAuditActorFilter] = useState('');
  const [auditActorTypeFilter, setAuditActorTypeFilter] = useState('');
  const [auditFromDate, setAuditFromDate] = useState('');
  const [auditToDate, setAuditToDate] = useState('');
  const [appliedFiltersNonce, setAppliedFiltersNonce] = useState(0);
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);

  const loadAuditLogs = useCallback(async () => {
    setAuditLoading(true);
    const qs = buildQueryString({
      page: auditPage,
      limit: auditLimit,
      action: auditActionFilter.trim() || undefined,
      actor: auditActorFilter.trim() || undefined,
      actorType: auditActorTypeFilter || undefined,
      from: auditFromDate ? `${auditFromDate}T00:00:00.000Z` : undefined,
      to: auditToDate ? `${auditToDate}T23:59:59.999Z` : undefined,
    });

    const logsRes = await adminFetch<unknown>(`/api/v1/admin/audit-logs${qs}`);
    if (logsRes.ok) {
      const parsed = extractPaginatedList<ExtendedAuditLog>(
        logsRes.data,
        ['items', 'logs', 'list'],
        auditLimit,
      );
      if (Array.isArray(logsRes.data) && parsed.items.length > auditLimit) {
        const start = (auditPage - 1) * auditLimit;
        setAuditLogs(parsed.items.slice(start, start + auditLimit));
        setAuditPagination({
          page: auditPage,
          limit: auditLimit,
          total: parsed.items.length,
          totalPages: Math.max(1, Math.ceil(parsed.items.length / auditLimit)),
        });
      } else {
        setAuditLogs(parsed.items);
        setAuditPagination(parsed.pagination);
      }
    }
    setAuditLoading(false);
  }, [
    auditActionFilter,
    auditActorFilter,
    auditActorTypeFilter,
    auditFromDate,
    auditLimit,
    auditPage,
    auditToDate,
  ]);

  const loadUsersAndRoles = useCallback(async () => {
    setLoading(true);
    const [usersRes, rolesRes, supRes] = await Promise.all([
      adminFetch<unknown>('/api/v1/admin/users'),
      adminFetch<unknown>('/api/v1/admin/roles'),
      adminFetch<unknown>('/api/v1/admin/procurement/suppliers'),
    ]);

    if (usersRes.ok) {
      setUsers(
        extractList<UserSummaryDto>(usersRes.data, ['items', 'users', 'list']),
      );
    } else {
      setFeedback({
        kind: 'error',
        message:
          usersRes.error?.message || 'Không tải được danh sách người dùng.',
      });
    }

    if (rolesRes.ok) {
      const rawRoles = extractList<RoleDetailRow>(rolesRes.data, [
        'items',
        'roles',
        'list',
      ]);
      const normalized: RoleDetailRow[] = rawRoles.map((r) => ({
        ...r,
        id: r.id || r.code || r.role,
        code: (r.code || r.role) as Role,
        role: (r.role || r.code) as Role,
        name: r.name || r.code || r.role,
        permissions: Array.isArray(r.permissions) ? r.permissions : [],
      }));
      setRoleMatrix(normalized);
      const draft: Record<string, Permission[]> = {};
      for (const r of normalized) {
        draft[r.id] = [...r.permissions];
      }
      setDraftRolePerms(draft);
    }

    if (supRes.ok) {
      const supList = extractList<SupplierDTO>(supRes.data, [
        'items',
        'suppliers',
        'list',
      ]);
      setSuppliers(supList);
      if (supList.length > 0) {
        setNewSupplierId((prev) => prev || supList[0]!.id);
      }
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    void loadUsersAndRoles();
  }, [loadUsersAndRoles]);

  useEffect(() => {
    void loadAuditLogs();
  }, [loadAuditLogs, appliedFiltersNonce]);

  const activeRoleRow = useMemo(
    () =>
      roleMatrix.find(
        (r) => r.code === selectedRoleCode || r.role === selectedRoleCode,
      ) ?? roleMatrix[0],
    [roleMatrix, selectedRoleCode],
  );

  const activeRoleDirty = useMemo(() => {
    if (!activeRoleRow) return false;
    const orig = [...activeRoleRow.permissions].sort().join(',');
    const draft = [...(draftRolePerms[activeRoleRow.id] ?? [])]
      .sort()
      .join(',');
    return orig !== draft;
  }, [activeRoleRow, draftRolePerms]);

  const handleToggleMatrixPerm = (roleId: string, perm: Permission) => {
    setDraftRolePerms((prev) => {
      const current = prev[roleId] ?? [];
      const exists = current.includes(perm);
      return {
        ...prev,
        [roleId]: exists
          ? current.filter((p) => p !== perm)
          : [...current, perm],
      };
    });
  };

  const handleSaveRolePermissions = async (roleRow: RoleDetailRow) => {
    const nextPerms = draftRolePerms[roleRow.id] ?? [];
    setBusyAction(`role-perms-${roleRow.id}`);
    setFeedback(null);

    const res = await adminFetch<RoleDetailRow>(
      `/api/v1/admin/roles/${encodeURIComponent(roleRow.id)}/permissions`,
      {
        method: 'PUT',
        body: JSON.stringify({ permissions: nextPerms }),
      },
    );

    if (res.ok) {
      const msg = `Đã lưu Ma trận phân quyền cho vai trò ${roleRow.code} (${nextPerms.length} quyền) & nâng permissionVersion trên Redis.`;
      setFeedback({ kind: 'success', message: msg });
      emitPortalToast({
        kind: 'success',
        title: 'PHÂN QUYỀN VAI TRÒ',
        message: msg,
      });
      await Promise.all([loadUsersAndRoles(), loadAuditLogs()]);
    } else {
      setFeedback({
        kind: 'error',
        message:
          res.error?.message ||
          `Cập nhật phân quyền cho ${roleRow.code} thất bại.`,
      });
    }
    setBusyAction(null);
  };

  const handleToggleRole = async (user: UserSummaryDto, role: Role) => {
    const hasRole = user.roles.includes(role);
    const nextRoles = hasRole
      ? user.roles.filter((r) => r !== role)
      : [...user.roles, role];
    if (nextRoles.length === 0) {
      setFeedback({
        kind: 'error',
        message: 'Mỗi tài khoản phải có ít nhất 1 vai trò.',
      });
      return;
    }

    setBusyAction(`user-role-${user.id}`);
    setFeedback(null);
    const res = await adminFetch<UserSummaryDto>(
      `/api/v1/admin/users/${encodeURIComponent(user.id)}/roles`,
      {
        method: 'PATCH',
        body: JSON.stringify({ roles: nextRoles }),
      },
    );

    if (res.ok) {
      const msg = `Đã cập nhật vai trò cho ${user.email} → [${nextRoles.join(', ')}] (đã nâng permissionVersion & đồng bộ Redis).`;
      setFeedback({ kind: 'success', message: msg });
      emitPortalToast({ kind: 'success', title: 'CẬP NHẬT RBAC', message: msg });
      await Promise.all([loadUsersAndRoles(), loadAuditLogs()]);
    } else {
      setFeedback({
        kind: 'error',
        message: res.error?.message || 'Cập nhật vai trò thất bại.',
      });
    }
    setBusyAction(null);
  };

  const handleToggleStatus = async (user: UserSummaryDto) => {
    const nextStatus =
      user.status === UserStatus.LOCKED ? UserStatus.ACTIVE : UserStatus.LOCKED;
    setBusyAction(`user-status-${user.id}`);
    setFeedback(null);

    const res = await adminFetch<UserSummaryDto>(
      `/api/v1/admin/users/${encodeURIComponent(user.id)}/status`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          status: nextStatus,
          reason: `Updated from Admin IAM tab to ${nextStatus}`,
        }),
      },
    );

    if (res.ok) {
      const msg = `Đã chuyển trạng thái ${user.email} sang ${nextStatus} (thu hồi phiên tức thì qua Redis).`;
      setFeedback({ kind: 'success', message: msg });
      emitPortalToast({ kind: 'info', title: 'TRẠNG THÁI TÀI KHOẢN', message: msg });
      await Promise.all([loadUsersAndRoles(), loadAuditLogs()]);
      onRefreshOverview?.();
    } else {
      setFeedback({
        kind: 'error',
        message:
          res.error?.message || 'Không thể thay đổi trạng thái tài khoản.',
      });
    }
    setBusyAction(null);
  };

  const handleCreateUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!newFullName.trim() || !newEmail.trim() || newPassword.length < 8) {
      setFeedback({
        kind: 'error',
        message: 'Họ tên, email hợp lệ và mật khẩu tối thiểu 8 ký tự là bắt buộc.',
      });
      return;
    }
    if (newRoles.length === 0) {
      setFeedback({
        kind: 'error',
        message: 'Vui lòng chọn ít nhất 1 vai trò cho tài khoản.',
      });
      return;
    }
    const isSupplierAccount = newRoles.includes(Role.SUPPLIER);
    if (isSupplierAccount && !newSupplierId.trim()) {
      setFeedback({
        kind: 'error',
        message: 'Tài khoản SUPPLIER bắt buộc phải gắn Nhà cung cấp (supplierId).',
      });
      return;
    }

    setBusyAction('create-user');
    setFeedback(null);

    const res = await adminFetch<UserSummaryDto>('/api/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        fullName: newFullName.trim(),
        email: newEmail.trim().toLowerCase(),
        password: newPassword,
        phone: newPhone.trim() || undefined,
        roles: newRoles,
        supplierId: isSupplierAccount ? newSupplierId.trim() : null,
      }),
    });

    if (res.ok) {
      const msg = `Đã tạo tài khoản ${newEmail.trim().toLowerCase()} với vai trò [${newRoles.join(', ')}].`;
      setFeedback({ kind: 'success', message: msg });
      emitPortalToast({ kind: 'success', title: 'TẠO TÀI KHOẢN', message: msg });
      setShowCreateUserModal(false);
      setNewFullName('');
      setNewEmail('');
      setNewPassword('');
      setNewPhone('');
      setNewRoles([Role.ORDER_STAFF]);
      await Promise.all([loadUsersAndRoles(), loadAuditLogs()]);
      onRefreshOverview?.();
    } else {
      setFeedback({
        kind: 'error',
        message: res.error?.message || 'Không thể tạo tài khoản người dùng mới.',
      });
    }
    setBusyAction(null);
  };

  const handleConfirmSoftDeleteUser = async () => {
    if (!confirmDeactivateUser) return;
    setBusyAction(`delete-user-${confirmDeactivateUser.id}`);
    setFeedback(null);

    const res = await adminFetch<unknown>(
      `/api/v1/admin/users/${encodeURIComponent(confirmDeactivateUser.id)}`,
      { method: 'DELETE' },
    );

    if (res.ok) {
      const msg = `Đã vô hiệu hóa / xóa mềm tài khoản ${confirmDeactivateUser.email} và thu hồi toàn bộ phiên đăng nhập trên Redis.`;
      setFeedback({ kind: 'success', message: msg });
      emitPortalToast({ kind: 'info', title: 'VÔ HIỆU HÓA USER', message: msg });
      setConfirmDeactivateUser(null);
      await Promise.all([loadUsersAndRoles(), loadAuditLogs()]);
      onRefreshOverview?.();
    } else {
      setFeedback({
        kind: 'error',
        message:
          res.error?.message ||
          `Không thể vô hiệu hóa tài khoản ${confirmDeactivateUser.email}.`,
      });
    }
    setBusyAction(null);
  };

  const handleConfirmReset2Fa = async () => {
    if (!confirmReset2FaUser || !canReset2Fa) return;
    setBusyAction(`reset-2fa-${confirmReset2FaUser.id}`);
    setFeedback(null);

    const res = await adminFetch<unknown>(
      `/api/v1/admin/users/${encodeURIComponent(confirmReset2FaUser.id)}/reset-2fa`,
      { method: 'POST', body: JSON.stringify({}) },
    );

    if (res.ok) {
      const msg = `Đã Reset 2FA cho ${confirmReset2FaUser.email} và thu hồi phiên MFA hiện tại — người dùng sẽ thiết lập lại 2FA ở lần đăng nhập kế tiếp.`;
      setFeedback({ kind: 'success', message: msg });
      emitPortalToast({ kind: 'success', title: 'RESET 2FA', message: msg });
      setConfirmReset2FaUser(null);
      await Promise.all([loadUsersAndRoles(), loadAuditLogs()]);
    } else {
      setFeedback({
        kind: 'error',
        message:
          res.error?.message ||
          `Không thể Reset 2FA cho ${confirmReset2FaUser.email}.`,
      });
    }
    setBusyAction(null);
  };

  const getDiffObjects = (log: ExtendedAuditLog) => {
    const before =
      log.beforeJsonb ??
      (log.metadata?.beforeJsonb as Record<string, unknown> | undefined) ??
      (log.metadata?.before as Record<string, unknown> | undefined) ??
      null;
    const after =
      log.afterJsonb ??
      (log.metadata?.afterJsonb as Record<string, unknown> | undefined) ??
      (log.metadata?.after as Record<string, unknown> | undefined) ??
      null;
    return { before, after };
  };

  return (
    <div data-testid="iam-audit-tab" className="space-y-8">
      {feedback ? (
        <div
          role="status"
          className={`rounded-2xl border px-5 py-3 text-xs ${
            feedback.kind === 'success'
              ? 'border-[#2E6B47]/35 bg-[#F2FBF6] text-[#1E4B32]'
              : 'border-[#8B2E2E]/35 bg-[#FFF5F4] text-[#8B2E2E]'
          }`}
        >
          {feedback.message}
        </div>
      ) : null}

      {/* Section 1: Users & RBAC Table + Create User / Deactivate / Reset 2FA */}
      <section className="overflow-hidden rounded-3xl border border-[#B08A4A]/30 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 px-6 py-4">
          <div>
            <p className="ledger-eyebrow text-[#8A672C]">
              IAM &amp; RBAC · Redis permissionVersion Instant Revocation
            </p>
            <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Quản lý tài khoản &amp; Phân quyền (
              <AnimatedTelemetryNumber value={users.length} />)
            </h2>
            <div className="mt-2 max-w-md">
              <LiveStackedHealthBar
                heightClass="h-2"
                segments={[
                  {
                    id: 'active',
                    label: 'Hoạt động',
                    value: users.filter((u) => u.status === UserStatus.ACTIVE)
                      .length,
                    tone: 'emerald',
                  },
                  {
                    id: 'inactive',
                    label: 'Tạm khóa / Khác',
                    value: users.filter((u) => u.status !== UserStatus.ACTIVE)
                      .length,
                    tone: 'amber',
                  },
                ]}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="btn-open-create-user"
              onClick={() => setShowCreateUserModal(true)}
              className="rounded-full bg-[#1C1410] px-4 py-2 text-xs font-medium text-[#EBCF8F] hover:opacity-90"
            >
              + Tạo tài khoản mới
            </button>
            <button
              type="button"
              onClick={() => void loadUsersAndRoles()}
              className="rounded-full border border-[#B08A4A]/45 px-4 py-1.5 text-xs text-[#8A672C] hover:bg-[#F4EBDA]"
            >
              Làm mới
            </button>
          </div>
        </div>

        {loading ? (
          <p className="p-6 text-xs text-[#7A6A5B]">
            Đang tải danh sách tài khoản...
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[#B08A4A]/20 bg-[#F4EBDA]/65 text-[10px] uppercase tracking-[0.16em] text-[#8A672C]">
                <tr>
                  <th className="px-5 py-3">Tài khoản</th>
                  <th className="px-5 py-3">Trạng thái / MFA / Ver</th>
                  <th className="px-5 py-3">Gán / Thu hồi vai trò (RBAC)</th>
                  <th className="px-5 py-3 text-right">Thao tác bảo mật</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#B08A4A]/15">
                {users.map((u) => {
                  const isSelf = u.id === currentUserId;
                  return (
                    <tr key={u.id} className="hover:bg-[#FBF7EF]">
                      <td className="px-5 py-3.5">
                        <p className="font-medium text-[#1C1410]">
                          {u.fullName}
                          {isSelf ? (
                            <span className="ml-1.5 rounded bg-[#F4EBDA] px-1.5 py-0.5 font-mono text-[9.5px] text-[#8A672C]">
                              BẠN
                            </span>
                          ) : null}
                        </p>
                        <p className="font-mono text-[11px] text-[#7A6A5B]">
                          {u.email}
                        </p>
                        {u.supplierId ? (
                          <p className="font-mono text-[10px] text-[#8A672C]">
                            supplier_id: {u.supplierId}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-5 py-3.5 font-mono">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span
                            className={`inline-block rounded-full px-2.5 py-0.5 text-[10px] ${
                              u.status === UserStatus.ACTIVE
                                ? 'bg-[#2E6B47]/15 text-[#2E6B47]'
                                : 'bg-[#8B2E2E]/15 text-[#8B2E2E]'
                            }`}
                          >
                            {u.status}
                          </span>
                          <span
                            className={`inline-block rounded-full px-2 py-0.5 text-[10px] ${
                              u.mfaEnabled
                                ? 'bg-[#1C1410] text-[#EBCF8F]'
                                : 'bg-[#F4EBDA] text-[#7A6A5B]'
                            }`}
                          >
                            {u.mfaEnabled ? '2FA ON' : '2FA OFF'}
                          </span>
                          <span className="text-[11px] text-[#7A6A5B]">
                            v{u.permissionVersion}
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex flex-wrap gap-1.5">
                          {ALL_ROLES.map((r) => {
                            const assigned = u.roles.includes(r);
                            return (
                              <button
                                key={r}
                                type="button"
                                disabled={busyAction === `user-role-${u.id}`}
                                onClick={() => void handleToggleRole(u, r)}
                                className={`rounded-full px-2.5 py-1 font-mono text-[10px] transition-colors disabled:opacity-50 ${
                                  assigned
                                    ? 'bg-[#1C1410] text-[#EBCF8F]'
                                    : 'border border-[#B08A4A]/30 bg-white text-[#7A6A5B] hover:border-[#1C1410]'
                                }`}
                              >
                                {assigned ? '✓ ' : '+ '}
                                {r}
                              </button>
                            );
                          })}
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <div className="inline-flex flex-wrap justify-end gap-1.5">
                          <button
                            type="button"
                            disabled={
                              isSelf || busyAction === `user-status-${u.id}`
                            }
                            onClick={() => void handleToggleStatus(u)}
                            className={`rounded-full px-3 py-1.5 text-[10.5px] font-medium disabled:opacity-40 ${
                              u.status === UserStatus.LOCKED
                                ? 'bg-[#2E6B47] text-white'
                                : 'border border-[#D9822B]/55 text-[#9A5B13] hover:bg-[#FFF6E5]'
                            }`}
                          >
                            {u.status === UserStatus.LOCKED
                              ? 'Mở khóa'
                              : 'Khóa'}
                          </button>

                          {canReset2Fa ? (
                            <button
                              type="button"
                              data-testid={`btn-reset-2fa-${u.id}`}
                              onClick={() => setConfirmReset2FaUser(u)}
                              className="rounded-full border border-[#B08A4A]/55 bg-[#FBF7EF] px-3 py-1.5 text-[10.5px] font-medium text-[#1C1410] hover:bg-[#1C1410] hover:text-[#EBCF8F]"
                            >
                              Reset 2FA
                            </button>
                          ) : null}

                          <button
                            type="button"
                            disabled={isSelf}
                            data-testid={`btn-deactivate-user-${u.id}`}
                            onClick={() => setConfirmDeactivateUser(u)}
                            className="rounded-full border border-[#8B2E2E]/50 px-3 py-1.5 text-[10.5px] font-medium text-[#8B2E2E] hover:bg-[#8B2E2E] hover:text-white disabled:opacity-35"
                          >
                            Vô hiệu hóa
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Section 2: Role Permissions Matrix (GET /api/v1/admin/roles & PUT /api/v1/admin/roles/:id/permissions) */}
      <section
        data-testid="role-permissions-matrix"
        className="overflow-hidden rounded-3xl border border-[#B08A4A]/30 bg-white p-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="ledger-eyebrow text-[#8A672C]">
              Role-Based Access Control Matrix · PUT /api/v1/admin/roles/:id/permissions
            </p>
            <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Ma trận Phân quyền cấp Vai trò ({roleMatrix.length} vai trò ·{' '}
              {ALL_PERMISSIONS.length} quyền)
            </h2>
            <p className="mt-1 text-xs text-[#7A6A5B]">
              Chọn vai trò để bật/tắt chi tiết từng mã quyền. Khi lưu, hệ thống
              tự động nâng <code>permissionVersion</code> cho toàn bộ tài khoản
              thuộc vai trò đó trên Redis.
            </p>
          </div>

          {activeRoleRow ? (
            <div className="flex items-center gap-2">
              {activeRoleDirty ? (
                <button
                  type="button"
                  onClick={() =>
                    setDraftRolePerms((prev) => ({
                      ...prev,
                      [activeRoleRow.id]: [...activeRoleRow.permissions],
                    }))
                  }
                  className="rounded-full border border-[#B08A4A]/45 px-4 py-2 text-xs text-[#5C4B41]"
                >
                  Hoàn tác
                </button>
              ) : null}
              <button
                type="button"
                data-testid="btn-save-role-permissions"
                disabled={
                  !activeRoleDirty ||
                  busyAction === `role-perms-${activeRoleRow.id}`
                }
                onClick={() => void handleSaveRolePermissions(activeRoleRow)}
                className="rounded-full bg-[#1C1410] px-5 py-2 text-xs font-medium uppercase tracking-[0.14em] text-[#EBCF8F] hover:opacity-90 disabled:opacity-45"
              >
                {busyAction === `role-perms-${activeRoleRow.id}`
                  ? 'Đang lưu...'
                  : `Lưu phân quyền ${activeRoleRow.code}`}
              </button>
            </div>
          ) : null}
        </div>

        {/* Role Selector Tabs */}
        <div className="mt-4 flex flex-wrap gap-2">
          {roleMatrix.map((roleRow) => {
            const active = activeRoleRow?.id === roleRow.id;
            const permCount = (draftRolePerms[roleRow.id] ?? []).length;
            return (
              <button
                key={roleRow.id}
                type="button"
                onClick={() => setSelectedRoleCode(roleRow.code)}
                className={`rounded-full px-3.5 py-1.5 font-mono text-[11px] transition-colors ${
                  active
                    ? 'bg-[#1C1410] text-[#EBCF8F]'
                    : 'border border-[#B08A4A]/35 bg-[#FBF7EF] text-[#5C4B41] hover:border-[#1C1410]'
                }`}
              >
                {roleRow.code} ({permCount})
              </button>
            );
          })}
        </div>

        {/* Grouped Interactive Checkboxes for Active Role */}
        {activeRoleRow ? (
          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {PERMISSION_GROUPS.map((group) => {
              const assignedSet = new Set(
                draftRolePerms[activeRoleRow.id] ?? [],
              );
              return (
                <div
                  key={group.label}
                  className="rounded-2xl border border-[#B08A4A]/25 bg-[#FBF7EF]/75 p-4"
                >
                  <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8A672C]">
                    {group.label}
                  </p>
                  <div className="mt-3 space-y-2">
                    {group.items.map((perm) => {
                      const checked = assignedSet.has(perm);
                      const isLockedSuperAdminSelf =
                        activeRoleRow.code === Role.SUPER_ADMIN &&
                        perm === Permission.ADMIN_RBAC_MANAGE;
                      return (
                        <label
                          key={perm}
                          className={`flex cursor-pointer items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs transition-colors ${
                            checked
                              ? 'border-[#1C1410]/35 bg-white text-[#1C1410]'
                              : 'border-transparent bg-white/50 text-[#7A6A5B]'
                          }`}
                        >
                          <span className="font-mono text-[11px]">{perm}</span>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={isLockedSuperAdminSelf}
                            onChange={() =>
                              handleToggleMatrixPerm(activeRoleRow.id, perm)
                            }
                            className="h-4 w-4 accent-[#1C1410]"
                          />
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-4 rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF] p-6 text-center text-xs text-[#7A6A5B]">
            Chưa tải được cấu hình vai trò từ <code>GET /api/v1/admin/roles</code>.
          </p>
        )}
      </section>

      {/* Section 3: Server-Side Paginated Audit Logs + Side-by-Side JSON Diff */}
      <section className="overflow-hidden rounded-3xl border border-[#B08A4A]/30 bg-white">
        <div className="border-b border-[#B08A4A]/20 px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="ledger-eyebrow text-[#8A672C]">
                Nhật ký kiểm toán (audit_logs) · Phân trang máy chủ &amp; So
                sánh JSON Trước / Sau
              </p>
              <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
                Audit Trail ({auditPagination.total} bản ghi)
              </h2>
            </div>
            <span className="font-mono text-[11px] text-[#7A6A5B]">
              Trang {auditPagination.page} / {auditPagination.totalPages}
            </span>
          </div>

          {/* Server-Side Filter Controls */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setAuditPage(1);
              setAppliedFiltersNonce((n) => n + 1);
            }}
            className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-6"
          >
            <input
              type="text"
              value={auditActionFilter}
              onChange={(e) => setAuditActionFilter(e.target.value)}
              placeholder="Lọc action (VD: ORDER_CANCELLED)..."
              className="rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-1.5 text-xs outline-none focus:border-[#1C1410]"
            />
            <input
              type="text"
              value={auditActorFilter}
              onChange={(e) => setAuditActorFilter(e.target.value)}
              placeholder="Lọc actor (email / ID)..."
              className="rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-1.5 text-xs outline-none focus:border-[#1C1410]"
            />
            <select
              value={auditActorTypeFilter}
              onChange={(e) => {
                setAuditActorTypeFilter(e.target.value);
                setAuditPage(1);
              }}
              aria-label="Lọc theo loại tác nhân"
              className="rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-1.5 text-xs"
            >
              <option value="">Tất cả loại actor</option>
              <option value="USER">USER</option>
              <option value="AI_COPILOT">AI_COPILOT</option>
              <option value="SYSTEM">SYSTEM</option>
            </select>
            <input
              type="date"
              value={auditFromDate}
              onChange={(e) => setAuditFromDate(e.target.value)}
              aria-label="Từ ngày"
              title="Từ ngày"
              className="rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-1.5 font-mono text-xs"
            />
            <input
              type="date"
              value={auditToDate}
              onChange={(e) => setAuditToDate(e.target.value)}
              aria-label="Đến ngày"
              title="Đến ngày"
              className="rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-1.5 font-mono text-xs"
            />
            <div className="flex gap-1.5">
              <button
                type="submit"
                className="flex-1 rounded-xl bg-[#1C1410] px-3 py-1.5 text-xs font-medium text-[#EBCF8F]"
              >
                Lọc
              </button>
              <button
                type="button"
                onClick={() => {
                  setAuditActionFilter('');
                  setAuditActorFilter('');
                  setAuditActorTypeFilter('');
                  setAuditFromDate('');
                  setAuditToDate('');
                  setAuditPage(1);
                  setAppliedFiltersNonce((n) => n + 1);
                }}
                className="rounded-xl border border-[#B08A4A]/40 px-3 py-1.5 text-xs text-[#5C4B41]"
              >
                Xóa
              </button>
            </div>
          </form>
        </div>

        <div className="divide-y divide-[#B08A4A]/15">
          {auditLoading ? (
            <p className="p-6 text-center text-xs text-[#7A6A5B]">
              Đang truy vấn nhật ký kiểm toán...
            </p>
          ) : auditLogs.length === 0 ? (
            <p className="p-6 text-center text-xs text-[#7A6A5B]">
              Chưa có bản ghi kiểm toán khớp bộ lọc.
            </p>
          ) : (
            auditLogs.map((log) => {
              const expanded = selectedLogId === log.id;
              const { before, after } = getDiffObjects(log);
              const changedKeys = computeChangedKeys(before, after);

              return (
                <div key={log.id} className="px-6 py-3.5 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span className="rounded-full bg-[#1C1410] px-2.5 py-0.5 font-mono text-[10px] text-[#EBCF8F]">
                        {log.actorType}
                      </span>
                      <strong className="font-mono text-[#1C1410]">
                        {log.action}
                      </strong>
                      <span className="text-[#7A6A5B]">
                        {log.resourceType}
                        {log.resourceId
                          ? ` · ${log.resourceId.slice(0, 14)}`
                          : ''}
                      </span>
                      {log.actorEmail ? (
                        <span className="rounded bg-[#F4EBDA] px-2 py-0.5 font-mono text-[10px] text-[#5C4B41]">
                          {log.actorEmail}
                        </span>
                      ) : null}
                    </div>

                    <div className="flex items-center gap-3">
                      {log.correlationId ? (
                        <span className="font-mono text-[10px] text-[#8A672C]">
                          corr: {log.correlationId.slice(0, 14)}
                        </span>
                      ) : null}
                      <span className="font-mono text-[10px] text-[#7A6A5B]">
                        {new Date(log.createdAt).toLocaleString('vi-VN')}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedLogId(expanded ? null : log.id)
                        }
                        className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-[#8A672C] hover:bg-[#F4EBDA]"
                      >
                        {expanded ? 'Ẩn Diff' : 'Xem JSON Diff'}
                      </button>
                    </div>
                  </div>

                  {expanded ? (
                    <div className="mt-3 space-y-2.5 rounded-2xl border border-[#B08A4A]/25 bg-[#FBF7EF] p-4">
                      {changedKeys.length > 0 ? (
                        <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
                          <span className="font-semibold text-[#5C4B41]">
                            Trường thay đổi:
                          </span>
                          {changedKeys.map((k) => (
                            <span
                              key={k}
                              className="rounded-full border border-[#B08A4A]/40 bg-white px-2 py-0.5 font-mono text-[10px] text-[#8A672C]"
                            >
                              {k}
                            </span>
                          ))}
                        </div>
                      ) : null}

                      <div className="grid gap-3 md:grid-cols-2">
                        <div>
                          <p className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8B2E2E]">
                            beforeJsonb (Trước thay đổi)
                          </p>
                          <pre className="max-h-60 overflow-auto rounded-xl bg-[#1C1410] p-3 font-mono text-[11px] text-[#FBF7EF]">
                            {JSON.stringify(before ?? {}, null, 2)}
                          </pre>
                        </div>
                        <div>
                          <p className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#2E6B47]">
                            afterJsonb (Sau thay đổi)
                          </p>
                          <pre className="max-h-60 overflow-auto rounded-xl bg-[#1C1410] p-3 font-mono text-[11px] text-[#EBCF8F]">
                            {JSON.stringify(
                              after ?? log.metadata ?? {},
                              null,
                              2,
                            )}
                          </pre>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>

        {/* True Server-Side Pagination Footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#B08A4A]/20 bg-[#FBF7EF]/60 px-6 py-3.5 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-[#7A6A5B]">Số dòng / trang:</span>
            <select
              value={auditLimit}
              onChange={(e) => {
                setAuditLimit(Number(e.target.value));
                setAuditPage(1);
              }}
              aria-label="Số dòng nhật ký mỗi trang"
              className="rounded-lg border border-[#B08A4A]/35 bg-white px-2.5 py-1 font-mono text-[11px]"
            >
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
            <span className="font-mono text-[11px] text-[#7A6A5B]">
              · Tổng {auditPagination.total} bản ghi
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={auditPage <= 1 || auditLoading}
              onClick={() => setAuditPage((p) => Math.max(1, p - 1))}
              className="rounded-full border border-[#B08A4A]/45 bg-white px-3.5 py-1 text-[11px] text-[#1C1410] hover:bg-[#F4EBDA] disabled:opacity-40"
            >
              ← Trang trước
            </button>
            <span className="font-mono text-[11px] font-semibold text-[#1C1410]">
              Trang {auditPagination.page} / {auditPagination.totalPages}
            </span>
            <button
              type="button"
              disabled={
                auditPage >= auditPagination.totalPages || auditLoading
              }
              onClick={() =>
                setAuditPage((p) =>
                  Math.min(auditPagination.totalPages, p + 1),
                )
              }
              className="rounded-full border border-[#B08A4A]/45 bg-white px-3.5 py-1 text-[11px] text-[#1C1410] hover:bg-[#F4EBDA] disabled:opacity-40"
            >
              Trang sau →
            </button>
          </div>
        </div>
      </section>

      {/* MODAL: Tạo tài khoản User (Internal Staff OR SUPPLIER with supplierId dropdown) */}
      {showCreateUserModal ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Tạo tài khoản người dùng mới"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#1C1410]/70 p-4 backdrop-blur-sm"
        >
          <form
            onSubmit={handleCreateUser}
            className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-3xl border border-[#B08A4A]/40 bg-[#FBF7EF] p-6 shadow-2xl"
          >
            <div className="flex items-start justify-between border-b border-[#B08A4A]/20 pb-3">
              <div>
                <p className="ledger-eyebrow text-[#8A672C]">
                  IAM Account Provisioning · POST /api/v1/admin/users
                </p>
                <h3 className="font-editorial mt-0.5 text-3xl text-[#1C1410]">
                  Tạo tài khoản nhân sự / đối tác
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateUserModal(false)}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-xs text-[#5C4B41]"
              >
                Đóng
              </button>
            </div>

            <div className="mt-4 space-y-3.5 text-xs">
              <label className="block">
                <span className="uppercase tracking-[0.12em] text-[#8A672C]">
                  Họ và tên *
                </span>
                <input
                  type="text"
                  required
                  value={newFullName}
                  onChange={(e) => setNewFullName(e.target.value)}
                  placeholder="VD: Trần Minh Anh"
                  className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 text-xs"
                />
              </label>

              <label className="block">
                <span className="uppercase tracking-[0.12em] text-[#8A672C]">
                  Email đăng nhập *
                </span>
                <input
                  type="email"
                  required
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="nhanvien@atelier.local"
                  className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 font-mono text-xs"
                />
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="uppercase tracking-[0.12em] text-[#8A672C]">
                    Mật khẩu (≥ 8 ký tự) *
                  </span>
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Atelier@2026!"
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 font-mono text-xs"
                  />
                </label>

                <label className="block">
                  <span className="uppercase tracking-[0.12em] text-[#8A672C]">
                    Số điện thoại
                  </span>
                  <input
                    type="text"
                    value={newPhone}
                    onChange={(e) => setNewPhone(e.target.value)}
                    placeholder="0901234567"
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 font-mono text-xs"
                  />
                </label>
              </div>

              <div>
                <span className="uppercase tracking-[0.12em] text-[#8A672C]">
                  Gán vai trò (RBAC) *
                </span>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {ALL_ROLES.map((r) => {
                    const selected = newRoles.includes(r);
                    return (
                      <button
                        key={r}
                        type="button"
                        onClick={() =>
                          setNewRoles((prev) =>
                            prev.includes(r)
                              ? prev.filter((item) => item !== r)
                              : [...prev, r],
                          )
                        }
                        className={`rounded-full px-3 py-1 font-mono text-[10.5px] transition-colors ${
                          selected
                            ? 'bg-[#1C1410] text-[#EBCF8F]'
                            : 'border border-[#B08A4A]/35 bg-white text-[#5C4B41]'
                        }`}
                      >
                        {selected ? '✓ ' : '+ '}
                        {r}
                      </button>
                    );
                  })}
                </div>
              </div>

              {newRoles.includes(Role.SUPPLIER) ? (
                <label className="block rounded-2xl border border-[#B08A4A]/40 bg-white p-3.5">
                  <span className="font-semibold uppercase tracking-[0.12em] text-[#8A672C]">
                    Liên kết Nhà cung cấp (supplierId) *
                  </span>
                  {suppliers.length > 0 ? (
                    <select
                      value={newSupplierId}
                      onChange={(e) => setNewSupplierId(e.target.value)}
                      required
                      className="mt-1.5 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-2 text-xs"
                    >
                      <option value="">-- Chọn nhà cung cấp --</option>
                      {suppliers.map((sup) => (
                        <option key={sup.id} value={sup.id}>
                          {sup.code} · {sup.name} ({sup.contactEmail})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      required
                      value={newSupplierId}
                      onChange={(e) => setNewSupplierId(e.target.value)}
                      placeholder="Nhập UUID supplierId..."
                      className="mt-1.5 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-2 font-mono text-xs"
                    />
                  )}
                </label>
              ) : null}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCreateUserModal(false)}
                className="rounded-full border border-[#B08A4A]/40 px-4 py-2 text-xs text-[#5C4B41]"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={busyAction === 'create-user'}
                className="rounded-full bg-[#1C1410] px-6 py-2 text-xs font-medium uppercase tracking-[0.14em] text-[#EBCF8F] disabled:opacity-50"
              >
                {busyAction === 'create-user'
                  ? 'Đang tạo tài khoản...'
                  : 'Tạo tài khoản'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {/* MODAL: Confirm Deactivate / Soft-Delete User */}
      {confirmDeactivateUser ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Xác nhận vô hiệu hóa tài khoản"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#1C1410]/70 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-md rounded-3xl border border-[#8B2E2E]/40 bg-[#FBF7EF] p-6 shadow-2xl">
            <p className="ledger-eyebrow text-[#8B2E2E]">
              Soft-Delete &amp; Redis Session Revocation
            </p>
            <h3 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Vô hiệu hóa tài khoản?
            </h3>
            <p className="mt-2 text-xs text-[#5C4B41]">
              Tài khoản <strong>{confirmDeactivateUser.email}</strong> sẽ bị vô
              hiệu hóa (soft-delete) và toàn bộ token/phiên hiện tại bị thu hồi
              tức thì trên Redis.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDeactivateUser(null)}
                className="rounded-full border border-[#B08A4A]/40 px-4 py-2 text-xs text-[#5C4B41]"
              >
                Hủy
              </button>
              <button
                type="button"
                disabled={
                  busyAction === `delete-user-${confirmDeactivateUser.id}`
                }
                onClick={() => void handleConfirmSoftDeleteUser()}
                className="rounded-full bg-[#8B2E2E] px-5 py-2 text-xs font-medium uppercase tracking-[0.14em] text-white disabled:opacity-50"
              >
                {busyAction === `delete-user-${confirmDeactivateUser.id}`
                  ? 'Đang xử lý...'
                  : 'Xác nhận vô hiệu hóa'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* MODAL: Confirm Reset 2FA (SUPER_ADMIN + mfaVerified ONLY) */}
      {confirmReset2FaUser && canReset2Fa ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Xác nhận Reset 2FA"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#1C1410]/70 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-md rounded-3xl border border-[#B08A4A]/50 bg-[#FBF7EF] p-6 shadow-2xl">
            <p className="ledger-eyebrow text-[#8A672C]">
              Super Admin Step-Up · Reset 2FA TOTP
            </p>
            <h3 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Reset xác thực 2FA?
            </h3>
            <p className="mt-2 text-xs text-[#5C4B41]">
              Thao tác sẽ xóa khóa TOTP của{' '}
              <strong>{confirmReset2FaUser.email}</strong>, thu hồi các phiên
              MFA hiện có trên Redis và yêu cầu người dùng thiết lập lại 2FA mới
              ở lần đăng nhập tiếp theo.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmReset2FaUser(null)}
                className="rounded-full border border-[#B08A4A]/40 px-4 py-2 text-xs text-[#5C4B41]"
              >
                Hủy
              </button>
              <button
                type="button"
                disabled={busyAction === `reset-2fa-${confirmReset2FaUser.id}`}
                onClick={() => void handleConfirmReset2Fa()}
                className="rounded-full bg-[#1C1410] px-5 py-2 text-xs font-medium uppercase tracking-[0.14em] text-[#EBCF8F] disabled:opacity-50"
              >
                {busyAction === `reset-2fa-${confirmReset2FaUser.id}`
                  ? 'Đang reset 2FA...'
                  : 'Xác nhận Reset 2FA'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
