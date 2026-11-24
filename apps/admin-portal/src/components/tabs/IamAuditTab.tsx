'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ALL_ROLES,
  UserStatus,
  type AuditLogDto,
  type Role,
  type UserSummaryDto,
} from '@atelier/contracts';
import { adminFetch } from '@/lib/api-client';

interface ExtendedAuditLog extends AuditLogDto {
  beforeJsonb?: Record<string, unknown> | null;
  afterJsonb?: Record<string, unknown> | null;
}

export function IamAuditTab() {
  const [users, setUsers] = useState<UserSummaryDto[]>([]);
  const [auditLogs, setAuditLogs] = useState<ExtendedAuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [auditSearch, setAuditSearch] = useState('');
  const [actorFilter, setActorFilter] = useState('');
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [usersRes, logsRes] = await Promise.all([
      adminFetch<UserSummaryDto[] | { items: UserSummaryDto[] }>(
        '/api/v1/admin/users',
      ),
      adminFetch<ExtendedAuditLog[] | { items: ExtendedAuditLog[] }>(
        '/api/v1/admin/audit-logs',
      ),
    ]);

    if (usersRes.ok && usersRes.data) {
      const list = Array.isArray(usersRes.data)
        ? usersRes.data
        : usersRes.data.items ?? [];
      setUsers(list);
    } else if (!usersRes.ok) {
      setFeedback(usersRes.error?.message || 'Không tải được danh sách người dùng.');
    }

    if (logsRes.ok && logsRes.data) {
      const list = Array.isArray(logsRes.data)
        ? logsRes.data
        : logsRes.data.items ?? [];
      setAuditLogs(list);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleToggleRole = async (user: UserSummaryDto, role: Role) => {
    const hasRole = user.roles.includes(role);
    const nextRoles = hasRole
      ? user.roles.filter((r) => r !== role)
      : [...user.roles, role];
    if (nextRoles.length === 0) {
      setFeedback('Mỗi tài khoản phải có ít nhất 1 vai trò.');
      return;
    }

    setFeedback(null);
    const res = await adminFetch<UserSummaryDto>(
      `/api/v1/admin/users/${encodeURIComponent(user.id)}/roles`,
      {
        method: 'PATCH',
        body: JSON.stringify({ roles: nextRoles }),
      },
    );

    if (res.ok) {
      setFeedback(
        `Đã cập nhật vai trò cho ${user.email} → [${nextRoles.join(', ')}] (đã nâng permissionVersion & đồng bộ Redis).`,
      );
      await loadData();
    } else {
      setFeedback(res.error?.message || 'Cập nhật vai trò thất bại.');
    }
  };

  const handleToggleStatus = async (user: UserSummaryDto) => {
    const nextStatus =
      user.status === UserStatus.LOCKED ? UserStatus.ACTIVE : UserStatus.LOCKED;
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
      setFeedback(
        `Đã chuyển trạng thái ${user.email} sang ${nextStatus} (thu hồi phiên tức thì qua Redis).`,
      );
      await loadData();
    } else {
      setFeedback(res.error?.message || 'Không thể thay đổi trạng thái tài khoản.');
    }
  };

  const filteredLogs = auditLogs.filter((log) => {
    if (actorFilter && log.actorType !== actorFilter) return false;
    if (!auditSearch.trim()) return true;
    const q = auditSearch.toLowerCase();
    return (
      log.action.toLowerCase().includes(q) ||
      log.resourceType.toLowerCase().includes(q) ||
      (log.correlationId ?? '').toLowerCase().includes(q) ||
      (log.actorEmail ?? '').toLowerCase().includes(q)
    );
  });

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
    <div className="space-y-8">
      {feedback ? (
        <div
          role="status"
          className="rounded-2xl border border-[#B08A4A]/40 bg-[#F4EBDA] px-5 py-3 text-xs text-[#1C1410]"
        >
          {feedback}
        </div>
      ) : null}

      {/* Users & RBAC Table */}
      <section className="overflow-hidden rounded-3xl border border-[#B08A4A]/30 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 px-6 py-4">
          <div>
            <p className="ledger-eyebrow text-[#8A672C]">
              IAM &amp; RBAC · Redis permissionVersion Instant Revocation
            </p>
            <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Quản lý tài khoản &amp; Phân quyền ({users.length})
            </h2>
          </div>
          <button
            type="button"
            onClick={() => void loadData()}
            className="rounded-full border border-[#B08A4A]/45 px-4 py-1.5 text-xs text-[#8A672C] hover:bg-[#F4EBDA]"
          >
            Làm mới
          </button>
        </div>

        {loading ? (
          <p className="p-6 text-xs text-[#7A6A5B]">Đang tải danh sách tài khoản...</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[#B08A4A]/20 bg-[#F4EBDA]/65 text-[10px] uppercase tracking-[0.16em] text-[#8A672C]">
                <tr>
                  <th className="px-5 py-3">Tài khoản</th>
                  <th className="px-5 py-3">Trạng thái / PermVer</th>
                  <th className="px-5 py-3">Gán / Thu hồi vai trò (RBAC)</th>
                  <th className="px-5 py-3 text-right">Khóa / Mở</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#B08A4A]/15">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-[#FBF7EF]">
                    <td className="px-5 py-3.5">
                      <p className="font-medium text-[#1C1410]">{u.fullName}</p>
                      <p className="font-mono text-[11px] text-[#7A6A5B]">{u.email}</p>
                      {u.supplierId ? (
                        <p className="font-mono text-[10px] text-[#8A672C]">
                          supplier_id: {u.supplierId}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-5 py-3.5 font-mono">
                      <span
                        className={`inline-block rounded-full px-2.5 py-0.5 text-[10px] ${
                          u.status === UserStatus.ACTIVE
                            ? 'bg-[#2E6B47]/15 text-[#2E6B47]'
                            : 'bg-[#8B2E2E]/15 text-[#8B2E2E]'
                        }`}
                      >
                        {u.status}
                      </span>
                      <span className="ml-2 text-[11px] text-[#7A6A5B]">
                        v{u.permissionVersion}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex flex-wrap gap-1.5">
                        {ALL_ROLES.map((r) => {
                          const assigned = u.roles.includes(r);
                          return (
                            <button
                              key={r}
                              type="button"
                              onClick={() => void handleToggleRole(u, r)}
                              className={`rounded-full px-2.5 py-1 font-mono text-[10px] transition-colors ${
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
                      <button
                        type="button"
                        onClick={() => void handleToggleStatus(u)}
                        className={`rounded-full px-3.5 py-1.5 text-[11px] font-medium ${
                          u.status === UserStatus.LOCKED
                            ? 'bg-[#2E6B47] text-white'
                            : 'border border-[#8B2E2E]/50 text-[#8B2E2E] hover:bg-[#8B2E2E] hover:text-white'
                        }`}
                      >
                        {u.status === UserStatus.LOCKED ? 'Mở khóa' : 'Khóa'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Searchable Audit Logs + Side-by-Side JSON Diff */}
      <section className="overflow-hidden rounded-3xl border border-[#B08A4A]/30 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 px-6 py-4">
          <div>
            <p className="ledger-eyebrow text-[#8A672C]">
              Nhật ký kiểm toán (audit_logs) · So sánh JSON Trước / Sau
            </p>
            <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Audit Trail ({filteredLogs.length})
            </h2>
          </div>

          <div className="flex flex-wrap gap-2">
            <input
              type="search"
              value={auditSearch}
              onChange={(e) => setAuditSearch(e.target.value)}
              placeholder="Lọc action, resource, correlationId..."
              className="rounded-full border border-[#B08A4A]/35 px-4 py-1.5 text-xs outline-none focus:border-[#8A672C]"
            />
            <select
              value={actorFilter}
              onChange={(e) => setActorFilter(e.target.value)}
              aria-label="Lọc theo loại tác nhân"
              className="rounded-full border border-[#B08A4A]/35 bg-white px-3 py-1.5 text-xs"
            >
              <option value="">Tất cả actor</option>
              <option value="USER">USER</option>
              <option value="AI_COPILOT">AI_COPILOT</option>
              <option value="SYSTEM">SYSTEM</option>
            </select>
          </div>
        </div>

        <div className="divide-y divide-[#B08A4A]/15">
          {filteredLogs.slice(0, 25).map((log) => {
            const expanded = selectedLogId === log.id;
            const { before, after } = getDiffObjects(log);
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
                      {log.resourceId ? ` · ${log.resourceId.slice(0, 12)}` : ''}
                    </span>
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
                      className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-[#8A672C]"
                    >
                      {expanded ? 'Ẩn Diff' : 'Xem JSON Diff'}
                    </button>
                  </div>
                </div>

                {expanded ? (
                  <div className="mt-3 grid gap-3 rounded-2xl border border-[#B08A4A]/25 bg-[#FBF7EF] p-4 md:grid-cols-2">
                    <div>
                      <p className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8B2E2E]">
                        beforeJsonb (Trước thay đổi)
                      </p>
                      <pre className="max-h-56 overflow-auto rounded-xl bg-[#1C1410] p-3 font-mono text-[11px] text-[#FBF7EF]">
                        {JSON.stringify(before ?? {}, null, 2)}
                      </pre>
                    </div>
                    <div>
                      <p className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#2E6B47]">
                        afterJsonb (Sau thay đổi)
                      </p>
                      <pre className="max-h-56 overflow-auto rounded-xl bg-[#1C1410] p-3 font-mono text-[11px] text-[#EBCF8F]">
                        {JSON.stringify(after ?? log.metadata ?? {}, null, 2)}
                      </pre>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}

          {filteredLogs.length === 0 ? (
            <p className="p-6 text-center text-xs text-[#7A6A5B]">
              Chưa có bản ghi kiểm toán khớp từ khóa.
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
