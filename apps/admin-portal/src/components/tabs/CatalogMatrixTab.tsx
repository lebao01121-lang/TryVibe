'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Permission,
  SubmissionStatus,
  canReadCostPrice,
  hasPermission,
  type CategoryDto,
  type ProductSpuDto,
  type Role,
  type SkuDto,
  type SupplierProductSubmissionDto,
} from '@atelier/contracts';
import { adminFetch } from '@/lib/api-client';

export interface CatalogMatrixTabProps {
  roles: readonly Role[];
}

const FORMAT_VND = (v: number): string =>
  `${new Intl.NumberFormat('vi-VN').format(v)}₫`;

export function CatalogMatrixTab({ roles }: CatalogMatrixTabProps) {
  const showCostPrice = canReadCostPrice(roles);
  const canWriteCatalog = hasPermission(roles, Permission.CATALOG_PRODUCT_WRITE);

  const [products, setProducts] = useState<ProductSpuDto[]>([]);
  const [categories, setCategories] = useState<CategoryDto[]>([]);
  const [submissions, setSubmissions] = useState<SupplierProductSubmissionDto[]>(
    [],
  );
  const [expandedProductId, setExpandedProductId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Create Product quick form
  const [newName, setNewName] = useState('');
  const [newCategorySlug, setNewCategorySlug] = useState('ao-blazer');
  const [newFabric, setNewFabric] = useState('100% Lụa Tơ Tằm 19 momme');
  const [newPrice, setNewPrice] = useState('2450000');
  const [newCostPrice, setNewCostPrice] = useState('1150000');

  // SKU price edit draft map
  const [skuPriceDrafts, setSkuPriceDrafts] = useState<
    Record<string, { salePriceVnd: string; costPriceVnd: string }>
  >({});

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [prodRes, catRes, subRes] = await Promise.all([
      adminFetch<ProductSpuDto[] | { items: ProductSpuDto[] }>(
        '/api/v1/admin/products',
      ),
      adminFetch<CategoryDto[] | { items: CategoryDto[] }>(
        '/api/v1/admin/categories',
      ),
      adminFetch<
        SupplierProductSubmissionDto[] | { items: SupplierProductSubmissionDto[] }
      >('/api/v1/admin/submissions'),
    ]);

    if (prodRes.ok && prodRes.data) {
      const list = Array.isArray(prodRes.data)
        ? prodRes.data
        : prodRes.data.items ?? [];
      setProducts(list);
      if (list[0] && !expandedProductId) {
        setExpandedProductId(list[0].id);
      }
    }

    if (catRes.ok && catRes.data) {
      const list = Array.isArray(catRes.data)
        ? catRes.data
        : catRes.data.items ?? [];
      setCategories(list);
    }

    if (subRes.ok && subRes.data) {
      const list = Array.isArray(subRes.data)
        ? subRes.data
        : subRes.data.items ?? [];
      setSubmissions(list);
    }
    setLoading(false);
  }, [expandedProductId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleCreateProduct = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canWriteCatalog) return;
    setFeedback(null);

    const payload: Record<string, unknown> = {
      name: newName.trim(),
      categorySlug: newCategorySlug,
      fabricComposition: newFabric.trim(),
      basePriceVnd: Number(newPrice),
      salePriceVnd: Number(newPrice),
      isTryonEnabled: true,
    };
    if (showCostPrice) {
      payload.costPriceVnd = Number(newCostPrice);
    }

    const res = await adminFetch<ProductSpuDto>('/api/v1/admin/products', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      setNewName('');
      setFeedback('Đã tạo SPU sản phẩm mới và xóa cache Storefront.');
      await loadAll();
    } else {
      setFeedback(res.error?.message || 'Tạo sản phẩm thất bại.');
    }
  };

  const handleUpdateSku = async (sku: SkuDto) => {
    if (!canWriteCatalog) return;
    const draft = skuPriceDrafts[sku.id];
    const salePriceVnd = Number(draft?.salePriceVnd ?? sku.salePriceVnd);
    const body: Record<string, unknown> = {
      salePriceVnd,
      basePriceVnd: salePriceVnd,
    };
    if (showCostPrice && draft?.costPriceVnd) {
      body.costPriceVnd = Number(draft.costPriceVnd);
    }

    setFeedback(null);
    const res = await adminFetch<SkuDto>(
      `/api/v1/admin/skus/${encodeURIComponent(sku.id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(body),
      },
    );

    if (res.ok) {
      setFeedback(
        `Đã cập nhật SKU ${sku.skuCode} (${FORMAT_VND(salePriceVnd)}) · Đã ghi audit_logs và xóa cache Redis Storefront.`,
      );
      await loadAll();
    } else {
      setFeedback(res.error?.message || 'Cập nhật SKU thất bại.');
    }
  };

  const handleReviewSubmission = async (
    id: string,
    decision: 'APPROVED' | 'REJECTED',
  ) => {
    setFeedback(null);
    const res = await adminFetch<SupplierProductSubmissionDto>(
      `/api/v1/admin/submissions/${encodeURIComponent(id)}/review`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          decision,
          reviewComment:
            decision === 'APPROVED'
              ? 'Đạt chuẩn chất liệu và thông số kích cỡ Atelier.'
              : 'Cần bổ sung ảnh phẳng 3:4 chuẩn hóa và thông số vòng eo.',
        }),
      },
    );

    if (res.ok) {
      setFeedback(`Đã cập nhật trạng thái đề xuất mẫu đối tác → ${decision}.`);
      await loadAll();
    } else {
      setFeedback(res.error?.message || 'Không thể duyệt đề xuất mẫu.');
    }
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

      {/* RBAC Cost-Price Indicator */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#B08A4A]/30 bg-white px-5 py-3 text-xs">
        <span className="text-[#5C4B41]">
          Chính sách ẩn giá vốn (Layer 5 RBAC Field Redaction):
        </span>
        <span
          className={`rounded-full px-3 py-1 font-mono text-[11px] ${
            showCostPrice
              ? 'bg-[#2E6B47]/15 text-[#2E6B47]'
              : 'bg-[#8A672C]/15 text-[#8A672C]'
          }`}
        >
          {showCostPrice
            ? 'COST_PRICE VISIBLE (SUPER_ADMIN / WAREHOUSE_MANAGER)'
            : 'COST_PRICE HIDDEN & REDACTED (CATALOG_AI_OPERATOR / ORDER_STAFF)'}
        </span>
      </div>

      {/* Create New Product Form */}
      {canWriteCatalog ? (
        <form
          onSubmit={handleCreateProduct}
          className="rounded-3xl border border-[#B08A4A]/25 bg-white p-6"
        >
          <p className="ledger-eyebrow text-[#8A672C]">
            Tạo nhanh SPU sản phẩm mới
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <input
              type="text"
              required
              placeholder="Tên sản phẩm (vd: Áo Lụa Cổ Đổ)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="rounded-xl border border-[#B08A4A]/35 px-3 py-2 text-xs lg:col-span-2"
            />
            <select
              value={newCategorySlug}
              onChange={(e) => setNewCategorySlug(e.target.value)}
              className="rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 text-xs"
            >
              {(categories.length > 0
                ? categories
                : [
                    { slug: 'ao-blazer', name: 'Áo & Blazer' },
                    { slug: 'ao-so-mi', name: 'Áo Sơ Mi' },
                    { slug: 'quan-chan-vay', name: 'Quần & Chân Váy' },
                    { slug: 'dam-du-tiec', name: 'Đầm Dự Tiệc' },
                  ]
              ).map((cat) => (
                <option key={cat.slug} value={cat.slug}>
                  {cat.name}
                </option>
              ))}
            </select>
            <input
              type="number"
              required
              placeholder="Giá bán (VND)"
              value={newPrice}
              onChange={(e) => setNewPrice(e.target.value)}
              className="rounded-xl border border-[#B08A4A]/35 px-3 py-2 font-mono text-xs"
            />
            {showCostPrice ? (
              <input
                type="number"
                placeholder="Giá vốn costPriceVnd"
                value={newCostPrice}
                onChange={(e) => setNewCostPrice(e.target.value)}
                className="rounded-xl border border-[#B08A4A]/35 px-3 py-2 font-mono text-xs"
              />
            ) : null}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <input
              type="text"
              required
              value={newFabric}
              onChange={(e) => setNewFabric(e.target.value)}
              placeholder="Thành phần chất liệu vải"
              className="min-w-[240px] flex-1 rounded-xl border border-[#B08A4A]/35 px-3 py-2 text-xs"
            />
            <button
              type="submit"
              className="rounded-full bg-[#1C1410] px-5 py-2 text-xs uppercase tracking-[0.16em] text-[#EBCF8F]"
            >
              Tạo SPU
            </button>
          </div>
        </form>
      ) : null}

      {/* SPU -> Variant -> SKU Matrix Table */}
      <section className="overflow-hidden rounded-3xl border border-[#B08A4A]/30 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 px-6 py-4">
          <div>
            <p className="ledger-eyebrow text-[#8A672C]">
              Catalog SPU / Variant / SKU Matrix
            </p>
            <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Danh mục sản phẩm ({products.length} SPU)
            </h2>
          </div>
          <button
            type="button"
            onClick={() => void loadAll()}
            className="rounded-full border border-[#B08A4A]/45 px-4 py-1.5 text-xs text-[#8A672C]"
          >
            Làm mới
          </button>
        </div>

        {loading ? (
          <p className="p-6 text-xs text-[#7A6A5B]">Đang tải danh mục SPU/SKU...</p>
        ) : (
          <div className="divide-y divide-[#B08A4A]/15">
            {products.map((product) => {
              const expanded = expandedProductId === product.id;
              const allSkus = product.variants.flatMap((v) =>
                v.skus.map((s) => ({ ...s, colorName: v.colorName })),
              );

              return (
                <div key={product.id} className="p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <strong className="font-editorial text-2xl text-[#1C1410]">
                          {product.name}
                        </strong>
                        <span className="rounded-full bg-[#F4EBDA] px-2.5 py-0.5 font-mono text-[10px] text-[#8A672C]">
                          {product.categorySlug}
                        </span>
                        {product.isTryonEnabled ? (
                          <span className="rounded-full bg-[#1C1410] px-2.5 py-0.5 text-[10px] text-[#EBCF8F]">
                            Try-On Ready
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-xs text-[#7A6A5B]">
                        {product.fabricComposition} · Từ{' '}
                        <strong>{FORMAT_VND(product.minPriceVnd)}</strong> ·{' '}
                        {allSkus.length} SKUs
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        setExpandedProductId(expanded ? null : product.id)
                      }
                      className="rounded-full border border-[#B08A4A]/45 px-4 py-1.5 text-xs text-[#8A672C]"
                    >
                      {expanded ? 'Thu gọn SKU' : 'Mở bảng SKU'}
                    </button>
                  </div>

                  {expanded ? (
                    <div className="mt-4 overflow-x-auto rounded-2xl border border-[#B08A4A]/20">
                      <table className="w-full text-left text-xs">
                        <thead className="border-b border-[#B08A4A]/20 bg-[#F4EBDA]/65 text-[10px] uppercase tracking-[0.14em] text-[#8A672C]">
                          <tr>
                            <th className="px-4 py-2.5">Mã SKU</th>
                            <th className="px-4 py-2.5">Màu / Size</th>
                            <th className="px-4 py-2.5">Giá bán (VND)</th>
                            {showCostPrice ? (
                              <th className="px-4 py-2.5">Giá vốn (costPriceVnd)</th>
                            ) : null}
                            <th className="px-4 py-2.5">Tồn</th>
                            {canWriteCatalog ? (
                              <th className="px-4 py-2.5 text-right">Lưu</th>
                            ) : null}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#B08A4A]/15 font-mono">
                          {allSkus.map((sku) => {
                            const draft = skuPriceDrafts[sku.id];
                            return (
                              <tr key={sku.id}>
                                <td className="px-4 py-2.5 font-semibold text-[#1C1410]">
                                  {sku.skuCode}
                                </td>
                                <td className="px-4 py-2.5 font-sans">
                                  {sku.colorName} · <strong>{sku.sizeCode}</strong>
                                </td>
                                <td className="px-4 py-2.5">
                                  {canWriteCatalog ? (
                                    <input
                                      type="number"
                                      value={
                                        draft?.salePriceVnd ??
                                        String(sku.salePriceVnd)
                                      }
                                      onChange={(e) =>
                                        setSkuPriceDrafts((prev) => ({
                                          ...prev,
                                          [sku.id]: {
                                            salePriceVnd: e.target.value,
                                            costPriceVnd:
                                              prev[sku.id]?.costPriceVnd ??
                                              String(sku.costPriceVnd ?? ''),
                                          },
                                        }))
                                      }
                                      className="w-32 rounded-lg border border-[#B08A4A]/35 px-2.5 py-1 text-xs"
                                    />
                                  ) : (
                                    FORMAT_VND(sku.salePriceVnd)
                                  )}
                                </td>

                                {/* STRICT RBAC: Column completely absent when !canReadCostPrice(roles) */}
                                {showCostPrice ? (
                                  <td className="px-4 py-2.5">
                                    {canWriteCatalog ? (
                                      <input
                                        type="number"
                                        value={
                                          draft?.costPriceVnd ??
                                          String(sku.costPriceVnd ?? '')
                                        }
                                        onChange={(e) =>
                                          setSkuPriceDrafts((prev) => ({
                                            ...prev,
                                            [sku.id]: {
                                              salePriceVnd:
                                                prev[sku.id]?.salePriceVnd ??
                                                String(sku.salePriceVnd),
                                              costPriceVnd: e.target.value,
                                            },
                                          }))
                                        }
                                        className="w-32 rounded-lg border border-[#B08A4A]/35 px-2.5 py-1 text-xs"
                                      />
                                    ) : sku.costPriceVnd !== undefined ? (
                                      FORMAT_VND(sku.costPriceVnd)
                                    ) : (
                                      '—'
                                    )}
                                  </td>
                                ) : null}

                                <td className="px-4 py-2.5 font-sans">
                                  {sku.inStock ? 'Còn hàng' : 'Hết'}
                                </td>
                                {canWriteCatalog ? (
                                  <td className="px-4 py-2.5 text-right font-sans">
                                    <button
                                      type="button"
                                      onClick={() => void handleUpdateSku(sku)}
                                      className="rounded-full bg-[#1C1410] px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-[#EBCF8F]"
                                    >
                                      Lưu
                                    </button>
                                  </td>
                                ) : null}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Supplier Product Submissions Review Queue */}
      <section className="overflow-hidden rounded-3xl border border-[#B08A4A]/30 bg-white">
        <div className="border-b border-[#B08A4A]/20 px-6 py-4">
          <p className="ledger-eyebrow text-[#8A672C]">
            Duyệt mẫu Đối tác Nhà cung cấp (Supplier Submissions)
          </p>
          <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
            Hàng đợi duyệt mẫu mới ({submissions.length})
          </h2>
        </div>

        <div className="divide-y divide-[#B08A4A]/15">
          {submissions.map((sub) => (
            <div
              key={sub.id}
              className="flex flex-wrap items-center justify-between gap-4 px-6 py-4 text-xs"
            >
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="font-editorial text-2xl text-[#1C1410]">
                    {sub.proposedName}
                  </strong>
                  <span className="rounded-full bg-[#F4EBDA] px-2.5 py-0.5 font-mono text-[10px] text-[#8A672C]">
                    {sub.status}
                  </span>
                </div>
                <p className="mt-1 text-[#7A6A5B]">
                  Supplier: <code>{sub.supplierId}</code> · Danh mục:{' '}
                  <code>{sub.proposedCategorySlug}</code> · Chất liệu:{' '}
                  {sub.fabricComposition}
                </p>
                <p className="mt-0.5 font-mono text-[11px] text-[#5C4B41]">
                  Giá lẻ đề xuất: {FORMAT_VND(sub.suggestedRetailVnd)}
                  {showCostPrice && sub.wholesaleCostVnd !== undefined
                    ? ` · Giá sỉ: ${FORMAT_VND(sub.wholesaleCostVnd)}`
                    : ''}
                </p>
              </div>

              {sub.status === SubmissionStatus.PENDING_REVIEW ? (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      void handleReviewSubmission(sub.id, 'APPROVED')
                    }
                    className="rounded-full bg-[#1C1410] px-4 py-1.5 text-[11px] uppercase tracking-[0.14em] text-[#EBCF8F]"
                  >
                    Phê duyệt
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void handleReviewSubmission(sub.id, 'REJECTED')
                    }
                    className="rounded-full border border-[#8B2E2E]/60 px-4 py-1.5 text-[11px] uppercase tracking-[0.14em] text-[#8B2E2E]"
                  >
                    Từ chối
                  </button>
                </div>
              ) : (
                <span className="text-[#7A6A5B]">
                  {sub.reviewComment || 'Đã xử lý'}
                </span>
              )}
            </div>
          ))}

          {submissions.length === 0 ? (
            <p className="p-6 text-center text-xs text-[#7A6A5B]">
              Chưa có đề xuất mẫu từ đối tác nhà cung cấp.
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
