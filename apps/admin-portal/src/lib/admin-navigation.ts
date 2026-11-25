import {
  ADMIN_PORTAL_ROLES,
  Permission,
  Role,
  hasPermission,
} from '@atelier/contracts';

export type AdminTabKey =
  | 'dashboard'
  | 'orders'
  | 'payments'
  | 'inventory'
  | 'procurement'
  | 'catalog'
  | 'categories'
  | 'promotions'
  | 'media'
  | 'campaign'
  | 'customers'
  | 'iam'
  | 'lookbook'
  | 'tryon-hub'
  | 'rag-kb'
  | 'ops'
  | 'reports';

export type AdminNavGroupId =
  | 'operations'
  | 'catalog_people'
  | 'ai_hub'
  | 'analytics';

export type AdminNavBadgeTone = 'gold' | 'emerald' | 'amber' | 'rose';

export interface AdminNavItem {
  key: AdminTabKey;
  label: string;
  shortLabel: string;
  group: AdminNavGroupId;
  pathSlug: string;
  subtitle: string;
  badgeText?: string;
  badgeTone?: AdminNavBadgeTone;
}

export interface AdminNavGroup {
  id: AdminNavGroupId;
  label: string;
  items: readonly AdminNavItem[];
}

export const ADMIN_NAV_GROUPS: readonly AdminNavGroup[] = [
  {
    id: 'operations',
    label: 'VẬN HÀNH TRUNG TÂM',
    items: [
      {
        key: 'dashboard',
        label: 'Tổng quan hệ thống',
        shortLabel: 'Tổng quan',
        group: 'operations',
        pathSlug: '/admin/dashboard',
        subtitle:
          'Trung tâm điều hành & sổ cái vận hành thời gian thực TryVibe Fashion Atelier',
      },
      {
        key: 'orders',
        label: 'Đơn hàng & RMA',
        shortLabel: 'Đơn & RMA',
        group: 'operations',
        pathSlug: '/admin/orders',
        subtitle:
          'Đóng gói hộp quà, giao vận, hủy/hoàn tất đơn, in phiếu giao & kiểm định QC đổi size',
      },
      {
        key: 'payments',
        label: 'Giao dịch & Hoàn tiền',
        shortLabel: 'Thanh toán',
        group: 'operations',
        pathSlug: '/admin/payments',
        subtitle:
          'Sổ cái giao dịch VietQR/VNPay/MoMo/COD, hoàn tiền một phần & đối soát Webhook HMAC',
      },
      {
        key: 'inventory',
        label: 'Tồn kho & Giữ chỗ',
        shortLabel: 'Tồn kho',
        group: 'operations',
        pathSlug: '/admin/inventory',
        subtitle:
          'Sổ cái tồn kho đa kho, kiểm kê điều chỉnh, chuyển kho nội bộ & giữ chỗ 15 phút',
      },
      {
        key: 'procurement',
        label: 'Thu mua B2B · PO & GRN',
        shortLabel: 'Thu mua B2B',
        group: 'operations',
        pathSlug: '/admin/procurement',
        subtitle:
          'Đơn đặt hàng nhập PO đa SKU, nhà cung cấp, nghiệm thu GRN & tất toán công nợ',
      },
    ],
  },
  {
    id: 'catalog_people',
    label: 'QUẢN LÝ DANH MỤC & CMS',
    items: [
      {
        key: 'catalog',
        label: 'Sản phẩm SPU/SKU',
        shortLabel: 'Sản phẩm',
        group: 'catalog_people',
        pathSlug: '/admin/catalog',
        subtitle:
          'Quản trị bộ sưu tập SPU/SKU, thêm biến thể, bảng giá & duyệt mẫu đối tác gửi lên',
      },
      {
        key: 'categories',
        label: 'Danh mục & Bảng Size',
        shortLabel: 'Danh mục',
        group: 'catalog_people',
        pathSlug: '/admin/categories',
        subtitle:
          'Cây danh mục phân cấp & quản trị thông số rập, bảng size theo độ co giãn chất liệu',
      },
      {
        key: 'promotions',
        label: 'Khuyến mãi & Voucher',
        shortLabel: 'Khuyến mãi',
        group: 'catalog_people',
        pathSlug: '/admin/promotions',
        subtitle:
          'Chiến dịch voucher, phê duyệt bản nháp xả hàng NHAP_AI (HITL) & đồng bộ Storefront',
        badgeText: 'HITL',
        badgeTone: 'gold',
      },
      {
        key: 'media',
        label: 'Media & Anchor 3D',
        shortLabel: 'Media 3D',
        group: 'catalog_people',
        pathSlug: '/admin/media',
        subtitle:
          'Xử lý ảnh tách nền, ảnh phẳng Try-On, bounding box pixel & gắn điểm neo Sào đồ 3D',
      },
      {
        key: 'campaign',
        label: 'Chiến dịch & CMS',
        shortLabel: 'Editorial CMS',
        group: 'catalog_people',
        pathSlug: '/admin/campaign',
        subtitle:
          'Điều phối Chiến dịch Trang chủ, bộ sưu tập Dịp mặc (Occasions) & 6 Mùa Lookbook',
      },
      {
        key: 'customers',
        label: 'Khách hàng & Kiểm duyệt',
        shortLabel: 'CRM & Review',
        group: 'catalog_people',
        pathSlug: '/admin/customers',
        subtitle:
          'Khách hàng VIP & tín nhiệm COD, kiểm duyệt đánh giá NLP & nhật ký Email / ZNS',
      },
      {
        key: 'iam',
        label: 'Nhân sự & IAM',
        shortLabel: 'Nhân sự IAM',
        group: 'catalog_people',
        pathSlug: '/admin/iam',
        subtitle:
          'Ma trận phân quyền Zero-Trust RBAC, tạo/reset 2FA tài khoản & Audit Logs phân trang',
      },
    ],
  },
  {
    id: 'ai_hub',
    label: 'TRÍ TUỆ NHÂN TẠO (AI HUB)',
    items: [
      {
        key: 'lookbook',
        label: 'AI Lookbook Studio',
        shortLabel: 'Lookbook AI',
        group: 'ai_hub',
        pathSlug: '/admin/lookbook',
        subtitle:
          'Dựng ảnh người mẫu ảo 3:4 kèm khóa Human-in-the-Loop & pre-warm cache Redis',
        badgeText: 'AI',
        badgeTone: 'gold',
      },
      {
        key: 'tryon-hub',
        label: 'Phòng Thử Đồ & Tín hiệu',
        shortLabel: 'Thử Đồ AI',
        group: 'ai_hub',
        pathSlug: '/admin/tryon-hub',
        subtitle:
          'Phễu chuyển đổi VTON, tín hiệu nhu cầu theo size & kiểm soát tự hủy ảnh 15 phút',
        badgeText: 'MỚI',
        badgeTone: 'emerald',
      },
      {
        key: 'rag-kb',
        label: 'Tri thức AI (RAG)',
        shortLabel: 'Tri thức RAG',
        group: 'ai_hub',
        pathSlug: '/admin/rag-kb',
        subtitle:
          'Quản trị kho tri thức Vector HNSW (768d), phân đoạn & thử nghiệm truy xuất Hybrid RRF k=60',
        badgeText: 'RAG',
        badgeTone: 'emerald',
      },
      {
        key: 'ops',
        label: 'AI Ops, Health & DLQ',
        shortLabel: 'AI Ops',
        group: 'ai_hub',
        pathSlug: '/admin/ops',
        subtitle:
          'Giám sát cụm 11 Microservices, động cơ Ollama Qwen 2.5 & hàng đợi lỗi DLQ',
        badgeText: 'LLM',
        badgeTone: 'gold',
      },
    ],
  },
  {
    id: 'analytics',
    label: 'PHÂN TÍCH & ĐỐI SOÁT',
    items: [
      {
        key: 'reports',
        label: 'Phân tích BI & Đối soát',
        shortLabel: 'Phân tích BI',
        group: 'analytics',
        pathSlug: '/admin/reports',
        subtitle:
          'Doanh thu ròng, giá vốn COGS, biên lợi nhuận gộp (Layer 5 RBAC) & xuất CSV UTF-8 BOM',
      },
    ],
  },
] as const;

export const ALL_ADMIN_NAV_ITEMS: readonly AdminNavItem[] =
  ADMIN_NAV_GROUPS.flatMap((group) => [...group.items]);

const NAV_ITEM_BY_KEY: Readonly<Record<AdminTabKey, AdminNavItem>> =
  ALL_ADMIN_NAV_ITEMS.reduce(
    (acc, item) => {
      acc[item.key] = item;
      return acc;
    },
    {} as Record<AdminTabKey, AdminNavItem>,
  );

export function getAdminNavItem(key: AdminTabKey): AdminNavItem {
  return NAV_ITEM_BY_KEY[key];
}

export function canAccessAdminTab(
  roles: readonly Role[],
  key: AdminTabKey,
): boolean {
  if (!roles || roles.length === 0) {
    return false;
  }

  const isAuthenticatedAdmin = roles.some((role) =>
    ADMIN_PORTAL_ROLES.includes(role),
  );
  if (!isAuthenticatedAdmin) {
    return false;
  }

  const isSuperAdmin = roles.includes(Role.SUPER_ADMIN);
  const isWarehouse = roles.includes(Role.WAREHOUSE_MANAGER);
  const isOrderStaff = roles.includes(Role.ORDER_STAFF);
  const isCatalogAi = roles.includes(Role.CATALOG_AI_OPERATOR);

  switch (key) {
    case 'dashboard':
      return true;
    case 'orders':
      return (
        (isSuperAdmin || isOrderStaff) &&
        hasPermission(roles, Permission.ORDER_READ)
      );
    case 'payments':
      return (
        (isSuperAdmin || isOrderStaff) &&
        (hasPermission(roles, Permission.ORDER_READ) ||
          hasPermission(roles, Permission.ORDER_REFUND_APPROVE))
      );
    case 'inventory':
      return (
        (isSuperAdmin || isWarehouse || isOrderStaff) &&
        hasPermission(roles, Permission.INVENTORY_STOCK_READ)
      );
    case 'procurement':
      return (
        (isSuperAdmin || isWarehouse) &&
        hasPermission(roles, Permission.INVENTORY_PO_READ)
      );
    case 'catalog':
      return (
        hasPermission(roles, Permission.CATALOG_PRODUCT_READ) ||
        hasPermission(roles, Permission.CATALOG_PRODUCT_WRITE)
      );
    case 'categories':
      return isSuperAdmin || isCatalogAi;
    case 'promotions':
      return isSuperAdmin || isCatalogAi || isOrderStaff;
    case 'media':
      return (
        isSuperAdmin ||
        hasPermission(roles, Permission.CATALOG_MEDIA_PROCESS) ||
        hasPermission(roles, Permission.CATALOG_PRODUCT_WRITE)
      );
    case 'campaign':
      return isSuperAdmin || isCatalogAi;
    case 'customers':
      return isSuperAdmin || isOrderStaff || isCatalogAi;
    case 'iam':
      return (
        isSuperAdmin ||
        hasPermission(roles, Permission.ADMIN_RBAC_MANAGE) ||
        hasPermission(roles, Permission.ADMIN_AUDIT_READ)
      );
    case 'lookbook':
      return (
        (isSuperAdmin || isCatalogAi) &&
        hasPermission(roles, Permission.CATALOG_PRODUCT_WRITE)
      );
    case 'tryon-hub':
      return isSuperAdmin || isCatalogAi || isWarehouse;
    case 'rag-kb':
      return (
        (isSuperAdmin || isCatalogAi) &&
        (isSuperAdmin ||
          (hasPermission(roles, Permission.CATALOG_PRODUCT_WRITE) &&
            hasPermission(roles, Permission.CATALOG_AI_APPROVE)))
      );
    case 'ops':
      return isSuperAdmin || isWarehouse;
    case 'reports':
      return isSuperAdmin || isWarehouse || isOrderStaff || isCatalogAi;
    default:
      return false;
  }
}

export function getVisibleAdminTabs(roles: readonly Role[]): AdminNavItem[] {
  return ALL_ADMIN_NAV_ITEMS.filter((item) =>
    canAccessAdminTab(roles, item.key),
  );
}

export function getVisibleAdminNavGroups(
  roles: readonly Role[],
): AdminNavGroup[] {
  return ADMIN_NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => canAccessAdminTab(roles, item.key)),
  })).filter((group) => group.items.length > 0);
}

export function getDefaultAdminTab(roles: readonly Role[]): AdminTabKey {
  const visible = getVisibleAdminTabs(roles);
  if (visible.some((item) => item.key === 'dashboard')) {
    return 'dashboard';
  }
  return visible[0]?.key ?? 'dashboard';
}
