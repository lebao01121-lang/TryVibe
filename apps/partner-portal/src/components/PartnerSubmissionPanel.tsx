'use client';

import {
  useCallback,
  useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import {
  MediaAssetType,
  SizeCode,
  type MediaAssetDto,
  type SupplierProductSubmissionDto,
} from '@atelier/contracts';
import { partnerFetch } from '@/lib/api-client';

export interface PartnerSubmissionPanelProps {
  supplierId: string;
}

const CATEGORY_OPTIONS = [
  { slug: 'ao-blazer', name: 'Áo & Blazer' },
  { slug: 'ao-so-mi', name: 'Áo Sơ Mi' },
  { slug: 'quan-chan-vay', name: 'Quần & Chân Váy' },
  { slug: 'dam-du-tiec', name: 'Đầm Dự Tiệc' },
  { slug: 'ao-khoac', name: 'Áo Khoác' },
  { slug: 'phu-kien', name: 'Phụ Kiện' },
] as const;

const ALL_SIZE_CODES: SizeCode[] = [
  SizeCode.XS,
  SizeCode.S,
  SizeCode.M,
  SizeCode.L,
  SizeCode.XL,
];

const FORMAT_VND = (v: number): string =>
  `${new Intl.NumberFormat('vi-VN').format(v)}₫`;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const base64 = result.includes(',') ? result.split(',')[1] ?? '' : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Không thể đọc tệp ảnh.'));
    reader.readAsDataURL(file);
  });
}

export function PartnerSubmissionPanel({
  supplierId,
}: PartnerSubmissionPanelProps) {
  const [submissions, setSubmissions] = useState<SupplierProductSubmissionDto[]>(
    [],
  );
  const [loadingList, setLoadingList] = useState(true);

  // New Submission Form
  const [proposedName, setProposedName] = useState('');
  const [proposedCategorySlug, setProposedCategorySlug] = useState('ao-so-mi');
  const [wholesaleCostVnd, setWholesaleCostVnd] = useState('920000');
  const [suggestedRetailVnd, setSuggestedRetailVnd] = useState('2150000');
  const [fabricComposition, setFabricComposition] = useState(
    '100% Lụa tơ tằm Bảo Lộc 19 momme',
  );
  const [colorName, setColorName] = useState('Kem Ngà');
  const [colorHex, setColorHex] = useState('#EFE7DA');
  const [selectedSizes, setSelectedSizes] = useState<SizeCode[]>([
    SizeCode.S,
    SizeCode.M,
    SizeCode.L,
  ]);
  const [rawSizeSpecs, setRawSizeSpecs] = useState(
    'S: ngực 84 / eo 66; M: ngực 88 / eo 70; L: ngực 93 / eo 75',
  );

  // Uploaded 3:4 Flat-Lay Asset
  const [uploadedAsset, setUploadedAsset] = useState<MediaAssetDto | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{
    kind: 'success' | 'error';
    message: string;
  } | null>(null);

  const loadSubmissions = useCallback(async () => {
    setLoadingList(true);
    const res = await partnerFetch<
      SupplierProductSubmissionDto[] | { items: SupplierProductSubmissionDto[] }
    >('/api/v1/partner/submissions');

    if (res.ok && res.data) {
      const list = Array.isArray(res.data)
        ? res.data
        : res.data.items ?? [];
      setSubmissions(list);
    } else if (!res.ok) {
      setFeedback({
        kind: 'error',
        message:
          res.error?.message ||
          'Không thể tải danh sách đề xuất mẫu của nhà cung cấp.',
      });
    }
    setLoadingList(false);
  }, []);

  useEffect(() => {
    void loadSubmissions();
  }, [loadSubmissions]);

  const toggleSize = (code: SizeCode) => {
    setSelectedSizes((prev) =>
      prev.includes(code) ? prev.filter((s) => s !== code) : [...prev, code],
    );
  };

  const handlePhotoUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploadingPhoto(true);
    setFeedback(null);

    try {
      const fileBase64 = await fileToBase64(file);
      const res = await partnerFetch<MediaAssetDto>('/api/v1/partner/media/upload', {
        method: 'POST',
        body: JSON.stringify({
          assetType: MediaAssetType.TRYON_FLAT_3_4,
          fileName: file.name,
          mimeType: file.type || 'image/png',
          fileBase64,
        }),
      });

      if (res.ok && res.data) {
        setUploadedAsset(res.data);
        setFeedback({
          kind: 'success',
          message: `Đã chuẩn hóa ảnh phẳng 3:4 thành công (assetId: ${res.data.id.slice(0, 10)}...) qua kiểm định Magic Bytes.`,
        });
      } else {
        setFeedback({
          kind: 'error',
          message:
            res.error?.message ||
            `Tải ảnh thất bại (${res.error?.code ?? 'MEDIA_ERROR'}).`,
        });
      }
    } catch (err) {
      setFeedback({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Lỗi đọc tệp ảnh.',
      });
    } finally {
      setUploadingPhoto(false);
      event.target.value = '';
    }
  };

  const handleSubmitProposal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedSizes.length === 0) {
      setFeedback({
        kind: 'error',
        message: 'Vui lòng chọn ít nhất 1 kích cỡ sản xuất.',
      });
      return;
    }

    setSubmitting(true);
    setFeedback(null);

    const res = await partnerFetch<SupplierProductSubmissionDto>(
      '/api/v1/partner/submissions',
      {
        method: 'POST',
        body: JSON.stringify({
          proposedName: proposedName.trim(),
          proposedCategorySlug,
          wholesaleCostVnd: Number(wholesaleCostVnd),
          suggestedRetailVnd: Number(suggestedRetailVnd),
          fabricComposition: fabricComposition.trim(),
          availableSizes: selectedSizes,
          colorName: colorName.trim(),
          colorHex: colorHex.trim(),
          assetIds: uploadedAsset ? [uploadedAsset.id] : [],
          notes: rawSizeSpecs.trim(),
        }),
      },
    );

    if (res.ok && res.data) {
      setProposedName('');
      setUploadedAsset(null);
      setFeedback({
        kind: 'success',
        message: `Đã gửi đề xuất mẫu "${res.data.proposedName}" (Trạng thái: ${res.data.status}) trong phạm vi tenant ${supplierId}.`,
      });
      await loadSubmissions();
    } else {
      setFeedback({
        kind: 'error',
        message: res.error?.message || 'Gửi đề xuất mẫu thất bại.',
      });
    }
    setSubmitting(false);
  };

  return (
    <div className="space-y-8">
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

      {/* Product Submission Form */}
      <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
        <p className="partner-eyebrow text-[#8A672C]">
          Đề xuất Mẫu Mới · POST /api/v1/partner/submissions
        </p>
        <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
          Gửi mẫu trang phục chờ Atelier kiểm duyệt
        </h2>
        <p className="mt-1 text-xs text-[#7A6A5B]">
          Mọi đề xuất và ảnh phẳng 3:4 tải lên tự động gắn khóa{' '}
          <code>supplier_id = {supplierId}</code> từ JWT đã xác thực.
        </p>

        <form onSubmit={handleSubmitProposal} className="mt-5 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-xs">
              <span className="font-medium text-[#5C4B41]">Tên mẫu đề xuất</span>
              <input
                type="text"
                required
                placeholder="Áo Sơ Mi Lụa Cổ Nơ Tay Phồng"
                value={proposedName}
                onChange={(e) => setProposedName(e.target.value)}
                className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3.5 py-2.5 text-sm"
              />
            </label>

            <label className="text-xs">
              <span className="font-medium text-[#5C4B41]">Danh mục</span>
              <select
                value={proposedCategorySlug}
                onChange={(e) => setProposedCategorySlug(e.target.value)}
                className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3.5 py-2.5 text-sm"
              >
                {CATEGORY_OPTIONS.map((cat) => (
                  <option key={cat.slug} value={cat.slug}>
                    {cat.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs">
              <span className="font-medium text-[#5C4B41]">
                Giá nhập sỉ đề xuất (VND)
              </span>
              <input
                type="number"
                required
                min={0}
                value={wholesaleCostVnd}
                onChange={(e) => setWholesaleCostVnd(e.target.value)}
                className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3.5 py-2.5 font-mono text-sm"
              />
            </label>

            <label className="text-xs">
              <span className="font-medium text-[#5C4B41]">
                Giá bán lẻ gợi ý (VND)
              </span>
              <input
                type="number"
                required
                min={0}
                value={suggestedRetailVnd}
                onChange={(e) => setSuggestedRetailVnd(e.target.value)}
                className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3.5 py-2.5 font-mono text-sm"
              />
            </label>

            <label className="text-xs">
              <span className="font-medium text-[#5C4B41]">
                Thành phần chất liệu vải
              </span>
              <input
                type="text"
                required
                value={fabricComposition}
                onChange={(e) => setFabricComposition(e.target.value)}
                className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3.5 py-2.5 text-sm"
              />
            </label>

            <div className="grid grid-cols-[1fr_110px] gap-2.5">
              <label className="text-xs">
                <span className="font-medium text-[#5C4B41]">Tên màu</span>
                <input
                  type="text"
                  required
                  value={colorName}
                  onChange={(e) => setColorName(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2.5 text-sm"
                />
              </label>
              <label className="text-xs">
                <span className="font-medium text-[#5C4B41]">Mã Hex</span>
                <input
                  type="text"
                  required
                  value={colorHex}
                  onChange={(e) => setColorHex(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2.5 font-mono text-sm"
                />
              </label>
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-[#5C4B41]">
              Kích cỡ cung ứng (availableSizes)
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {ALL_SIZE_CODES.map((code) => {
                const active = selectedSizes.includes(code);
                return (
                  <button
                    key={code}
                    type="button"
                    onClick={() => toggleSize(code)}
                    className={`rounded-full px-3.5 py-1 text-xs ${
                      active
                        ? 'bg-[#1C1410] text-[#EBCF8F]'
                        : 'border border-[#B08A4A]/35 bg-[#FBF7EF] text-[#2B2019]'
                    }`}
                  >
                    {code}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="block text-xs">
            <span className="font-medium text-[#5C4B41]">
              Thông số bảng size xưởng thô (raw factory size specs)
            </span>
            <textarea
              rows={2}
              value={rawSizeSpecs}
              onChange={(e) => setRawSizeSpecs(e.target.value)}
              className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3.5 py-2 text-xs"
            />
          </label>

          {/* 3:4 Flat-Lay Photo Upload via /api/v1/partner/media/upload */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-[#B08A4A]/45 bg-[#FBF7EF] p-4">
            <div className="text-xs">
              <p className="font-semibold uppercase tracking-[0.14em] text-[#8A672C]">
                Ảnh trang phục phẳng 3:4 (TRYON_FLAT_3_4)
              </p>
              <p className="mt-0.5 text-[#7A6A5B]">
                {uploadedAsset
                  ? `Đã gắn asset ${uploadedAsset.id} (${uploadedAsset.width ?? 768}×${uploadedAsset.height ?? 1024})`
                  : 'Tải ảnh qua POST /api/v1/partner/media/upload (Magic Bytes + chuẩn hóa 768×1024).'}
              </p>
            </div>

            <label className="cursor-pointer rounded-full border border-[#1C1410] px-4 py-2 text-xs font-medium uppercase tracking-[0.14em] text-[#1C1410] hover:bg-[#1C1410] hover:text-[#EBCF8F]">
              {uploadingPhoto ? 'Đang kiểm định ảnh...' : 'Tải ảnh mẫu (3:4)'}
              <input
                type="file"
                accept="image/*,.jpg,.png,.webp"
                disabled={uploadingPhoto}
                onChange={(e) => void handlePhotoUpload(e)}
                className="hidden"
              />
            </label>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="rounded-full bg-[#1C1410] px-7 py-3 text-xs font-medium uppercase tracking-[0.18em] text-[#EBCF8F] disabled:opacity-50"
          >
            {submitting ? 'Đang gửi đề xuất...' : 'Gửi Đề Xuất Mẫu Mới'}
          </button>
        </form>
      </section>

      {/* Tenant-Isolated Submissions Table */}
      <section className="overflow-hidden rounded-3xl border border-[#B08A4A]/30 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 px-6 py-4">
          <div>
            <p className="partner-eyebrow text-[#8A672C]">
              Danh sách đề xuất mẫu của riêng bạn (Tenant Isolated)
            </p>
            <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Đề xuất đã gửi ({submissions.length})
            </h2>
          </div>
          <span className="rounded-full bg-[#F4EBDA] px-3 py-1 font-mono text-[11px] text-[#8A672C]">
            WHERE supplier_id = &apos;{supplierId}&apos;
          </span>
        </div>

        {loadingList ? (
          <p className="p-6 text-xs text-[#7A6A5B]">
            Đang tải danh sách đề xuất...
          </p>
        ) : (
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
                    <span className="rounded-full bg-[#1C1410] px-2.5 py-0.5 font-mono text-[10px] text-[#EBCF8F]">
                      {sub.status}
                    </span>
                  </div>
                  <p className="mt-1 text-[#7A6A5B]">
                    Danh mục: <code>{sub.proposedCategorySlug}</code> · Chất
                    liệu: {sub.fabricComposition}
                  </p>
                  <p className="mt-0.5 font-mono text-[11px] text-[#5C4B41]">
                    Giá sỉ: {FORMAT_VND(sub.wholesaleCostVnd)} · Giá lẻ đề xuất:{' '}
                    {FORMAT_VND(sub.suggestedRetailVnd)}
                  </p>
                  {sub.reviewComment ? (
                    <p className="mt-1 text-[#8A672C]">
                      Phản hồi từ Atelier: {sub.reviewComment}
                    </p>
                  ) : null}
                </div>

                <div className="text-right font-mono text-[10px] text-[#7A6A5B]">
                  <p>ID: {sub.id.slice(0, 12)}</p>
                  <p>Tenant: {sub.supplierId.slice(0, 12)}...</p>
                </div>
              </div>
            ))}

            {submissions.length === 0 ? (
              <p className="p-6 text-center text-xs text-[#7A6A5B]">
                Chưa có đề xuất mẫu nào thuộc tài khoản nhà cung cấp này.
              </p>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
