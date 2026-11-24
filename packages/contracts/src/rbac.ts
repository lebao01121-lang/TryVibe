import { z } from 'zod';

export const Role = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  CATALOG_AI_OPERATOR: 'CATALOG_AI_OPERATOR',
  WAREHOUSE_MANAGER: 'WAREHOUSE_MANAGER',
  ORDER_STAFF: 'ORDER_STAFF',
  SUPPLIER: 'SUPPLIER',
  CUSTOMER: 'CUSTOMER',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

export const ALL_ROLES: readonly Role[] = [
  Role.SUPER_ADMIN,
  Role.CATALOG_AI_OPERATOR,
  Role.WAREHOUSE_MANAGER,
  Role.ORDER_STAFF,
  Role.SUPPLIER,
  Role.CUSTOMER,
] as const;

export const RoleSchema = z.enum([
  Role.SUPER_ADMIN,
  Role.CATALOG_AI_OPERATOR,
  Role.WAREHOUSE_MANAGER,
  Role.ORDER_STAFF,
  Role.SUPPLIER,
  Role.CUSTOMER,
]);

export const Portal = {
  STOREFRONT: 'STOREFRONT',
  ADMIN_PORTAL: 'ADMIN_PORTAL',
  PARTNER_PORTAL: 'PARTNER_PORTAL',
} as const;

export type Portal = (typeof Portal)[keyof typeof Portal];

export const PortalSchema = z.enum([
  Portal.STOREFRONT,
  Portal.ADMIN_PORTAL,
  Portal.PARTNER_PORTAL,
]);

export const ADMIN_PORTAL_ROLES: readonly Role[] = [
  Role.SUPER_ADMIN,
  Role.CATALOG_AI_OPERATOR,
  Role.WAREHOUSE_MANAGER,
  Role.ORDER_STAFF,
] as const;

export const PARTNER_PORTAL_ROLES: readonly Role[] = [Role.SUPPLIER] as const;

export const STOREFRONT_ROLES: readonly Role[] = [
  Role.CUSTOMER,
  Role.SUPER_ADMIN,
  Role.CATALOG_AI_OPERATOR,
  Role.WAREHOUSE_MANAGER,
  Role.ORDER_STAFF,
  Role.SUPPLIER,
] as const;

export const ROLE_PORTAL_MATRIX: Readonly<Record<Role, readonly Portal[]>> = {
  [Role.SUPER_ADMIN]: [Portal.ADMIN_PORTAL, Portal.STOREFRONT],
  [Role.CATALOG_AI_OPERATOR]: [Portal.ADMIN_PORTAL, Portal.STOREFRONT],
  [Role.WAREHOUSE_MANAGER]: [Portal.ADMIN_PORTAL, Portal.STOREFRONT],
  [Role.ORDER_STAFF]: [Portal.ADMIN_PORTAL, Portal.STOREFRONT],
  [Role.SUPPLIER]: [Portal.PARTNER_PORTAL, Portal.STOREFRONT],
  [Role.CUSTOMER]: [Portal.STOREFRONT],
} as const;

export function canAccessPortal(roles: readonly Role[] | Role, portal: Portal): boolean {
  const roleList: readonly Role[] = typeof roles === 'string' ? [roles] : roles;
  return roleList.some((role) => ROLE_PORTAL_MATRIX[role]?.includes(portal) ?? false);
}

export const Permission = {
  CATALOG_PRODUCT_READ: 'catalog.product.read',
  CATALOG_PRODUCT_WRITE: 'catalog.product.write',
  CATALOG_AI_APPROVE: 'catalog.ai.approve',
  CATALOG_MEDIA_PROCESS: 'catalog.media.process',
  INVENTORY_STOCK_READ: 'inventory.stock.read',
  INVENTORY_STOCK_WRITE: 'inventory.stock.write',
  INVENTORY_PO_READ: 'inventory.po.read',
  INVENTORY_PO_CREATE: 'inventory.po.create',
  INVENTORY_PO_APPROVE: 'inventory.po.approve',
  INVENTORY_GRN_APPROVE: 'inventory.grn.approve',
  ORDER_READ: 'order.read',
  ORDER_MANAGE: 'order.manage',
  ORDER_REFUND_APPROVE: 'order.refund.approve',
  ORDER_RMA_MANAGE: 'order.rma.manage',
  FINANCE_COST_PRICE_READ: 'finance.cost_price.read',
  PROCUREMENT_COST_PRICE_READ: 'procurement.cost_price.read',
  SUPPLIER_PORTAL_ACCESS: 'supplier.portal.access',
  SUPPLIER_PO_CONFIRM: 'supplier.po.confirm',
  TRYON_SIGNALS_READ: 'tryon.signals.read',
  COPILOT_ACCESS: 'copilot.access',
  CUSTOMER_COPILOT_ACCESS: 'customer.copilot.access',
  ADMIN_RBAC_MANAGE: 'admin.rbac.manage',
  ADMIN_AUDIT_READ: 'admin.audit.read',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permission);

export const PermissionSchema = z.enum([
  Permission.CATALOG_PRODUCT_READ,
  Permission.CATALOG_PRODUCT_WRITE,
  Permission.CATALOG_AI_APPROVE,
  Permission.CATALOG_MEDIA_PROCESS,
  Permission.INVENTORY_STOCK_READ,
  Permission.INVENTORY_STOCK_WRITE,
  Permission.INVENTORY_PO_READ,
  Permission.INVENTORY_PO_CREATE,
  Permission.INVENTORY_PO_APPROVE,
  Permission.INVENTORY_GRN_APPROVE,
  Permission.ORDER_READ,
  Permission.ORDER_MANAGE,
  Permission.ORDER_REFUND_APPROVE,
  Permission.ORDER_RMA_MANAGE,
  Permission.FINANCE_COST_PRICE_READ,
  Permission.PROCUREMENT_COST_PRICE_READ,
  Permission.SUPPLIER_PORTAL_ACCESS,
  Permission.SUPPLIER_PO_CONFIRM,
  Permission.TRYON_SIGNALS_READ,
  Permission.COPILOT_ACCESS,
  Permission.CUSTOMER_COPILOT_ACCESS,
  Permission.ADMIN_RBAC_MANAGE,
  Permission.ADMIN_AUDIT_READ,
]);

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  [Role.SUPER_ADMIN]: [
    Permission.CATALOG_PRODUCT_READ,
    Permission.CATALOG_PRODUCT_WRITE,
    Permission.CATALOG_AI_APPROVE,
    Permission.CATALOG_MEDIA_PROCESS,
    Permission.INVENTORY_STOCK_READ,
    Permission.INVENTORY_STOCK_WRITE,
    Permission.INVENTORY_PO_READ,
    Permission.INVENTORY_PO_CREATE,
    Permission.INVENTORY_PO_APPROVE,
    Permission.INVENTORY_GRN_APPROVE,
    Permission.ORDER_READ,
    Permission.ORDER_MANAGE,
    Permission.ORDER_REFUND_APPROVE,
    Permission.ORDER_RMA_MANAGE,
    Permission.FINANCE_COST_PRICE_READ,
    Permission.PROCUREMENT_COST_PRICE_READ,
    Permission.TRYON_SIGNALS_READ,
    Permission.COPILOT_ACCESS,
    Permission.CUSTOMER_COPILOT_ACCESS,
    Permission.ADMIN_RBAC_MANAGE,
    Permission.ADMIN_AUDIT_READ,
  ],
  [Role.CATALOG_AI_OPERATOR]: [
    Permission.CATALOG_PRODUCT_READ,
    Permission.CATALOG_PRODUCT_WRITE,
    Permission.CATALOG_AI_APPROVE,
    Permission.CATALOG_MEDIA_PROCESS,
    Permission.INVENTORY_STOCK_READ,
    Permission.TRYON_SIGNALS_READ,
    Permission.COPILOT_ACCESS,
  ],
  [Role.WAREHOUSE_MANAGER]: [
    Permission.CATALOG_PRODUCT_READ,
    Permission.INVENTORY_STOCK_READ,
    Permission.INVENTORY_STOCK_WRITE,
    Permission.INVENTORY_PO_READ,
    Permission.INVENTORY_PO_CREATE,
    Permission.INVENTORY_PO_APPROVE,
    Permission.INVENTORY_GRN_APPROVE,
    Permission.PROCUREMENT_COST_PRICE_READ,
    Permission.TRYON_SIGNALS_READ,
    Permission.COPILOT_ACCESS,
  ],
  [Role.ORDER_STAFF]: [
    Permission.CATALOG_PRODUCT_READ,
    Permission.INVENTORY_STOCK_READ,
    Permission.ORDER_READ,
    Permission.ORDER_MANAGE,
    Permission.ORDER_RMA_MANAGE,
    Permission.COPILOT_ACCESS,
  ],
  [Role.SUPPLIER]: [
    Permission.SUPPLIER_PORTAL_ACCESS,
    Permission.SUPPLIER_PO_CONFIRM,
    Permission.INVENTORY_PO_READ,
  ],
  [Role.CUSTOMER]: [Permission.CATALOG_PRODUCT_READ, Permission.CUSTOMER_COPILOT_ACCESS],
} as const;

export function hasPermission(roles: readonly Role[] | Role, permission: Permission): boolean {
  const roleList: readonly Role[] = typeof roles === 'string' ? [roles] : roles;
  return roleList.some((role) => ROLE_PERMISSIONS[role]?.includes(permission) ?? false);
}

export function hasAnyPermission(
  roles: readonly Role[] | Role,
  permissions: readonly Permission[],
): boolean {
  return permissions.some((permission) => hasPermission(roles, permission));
}

export const RESTRICTED_COST_FIELDS = [
  'cost_price',
  'costPrice',
  'costPriceVnd',
  'cost_price_vnd',
  'giaNhap',
  'gia_nhap',
  'cogs',
] as const;

export function canReadCostPrice(roles: readonly Role[] | Role): boolean {
  return hasAnyPermission(roles, [
    Permission.FINANCE_COST_PRICE_READ,
    Permission.PROCUREMENT_COST_PRICE_READ,
  ]);
}
