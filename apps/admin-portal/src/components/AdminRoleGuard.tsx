'use client';

import type { ReactNode } from 'react';
import {
  ADMIN_PORTAL_ROLES,
  Portal,
  Role,
  canAccessPortal,
} from '@atelier/contracts';

export interface AdminRoleGuardProps {
  roles: readonly Role[];
  onSignOut?: () => void;
  children: ReactNode;
}

const STRICT_ADMIN_SET = new Set<Role>(ADMIN_PORTAL_ROLES);

export function hasStrictAdminRole(roles: readonly Role[]): boolean {
  if (roles.length === 0) return false;
  if (roles.includes(Role.CUSTOMER) || roles.includes(Role.SUPPLIER)) {
    // Only allow if user genuinely holds an internal admin portal role
    const hasInternal = roles.some((r) => STRICT_ADMIN_SET.has(r));
    if (!hasInternal) return false;
  }
  return (
    roles.some((r) => STRICT_ADMIN_SET.has(r)) &&
    canAccessPortal(roles, Portal.ADMIN_PORTAL)
  );
}

export function AdminRoleGuard({
  roles,
  onSignOut,
  children,
}: AdminRoleGuardProps) {
  if (!hasStrictAdminRole(roles)) {
    return (
      <section
        role="alert"
        aria-live="assertive"
        className="mx-auto my-12 max-w-2xl rounded-3xl border border-[#8B2E2E]/40 bg-[#FFF8F6] p-8 shadow-sm"
      >
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-[#8B2E2E] px-3 py-1 font-mono text-xs font-semibold text-[#FBF7EF]">
            HTTP 403
          </span>
          <span className="ledger-eyebrow text-[#8B2E2E]">
            Truy cập bị từ chối · AdminRoleGuard
          </span>
        </div>

        <h2 className="font-editorial mt-4 text-4xl font-normal text-[#1C1410]">
          Vai trò{' '}
          <code className="font-mono text-2xl">{roles.join(', ') || 'NONE'}</code>{' '}
          không được phép vào Cổng Điều Hành Nội Bộ
        </h2>

        <p className="mt-3 text-sm leading-relaxed text-[#5C4B41]">
          Theo chính sách cách ly vật lý cổng (<code>ADMIN_PORTAL · :3001</code>
          ), tài khoản <strong>CUSTOMER</strong> và <strong>SUPPLIER</strong> bị
          chặn cứng ở cả trình duyệt lẫn Zero-Trust API Gateway. Chỉ 4 vai trò
          nhân sự nội bộ được phép truy cập:
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          {ADMIN_PORTAL_ROLES.map((allowedRole) => (
            <span
              key={allowedRole}
              className="rounded-full border border-[#B08A4A]/45 bg-[#F4EBDA] px-3.5 py-1 font-mono text-xs text-[#2B2019]"
            >
              {allowedRole}
            </span>
          ))}
        </div>

        {onSignOut ? (
          <div className="mt-6 border-t border-[#8B2E2E]/15 pt-5">
            <button
              type="button"
              onClick={onSignOut}
              className="rounded-full bg-[#1C1410] px-6 py-2.5 text-xs uppercase tracking-[0.18em] text-[#EBCF8F] hover:opacity-90"
            >
              Đăng xuất &amp; Đăng nhập tài khoản nội bộ
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  return <>{children}</>;
}
