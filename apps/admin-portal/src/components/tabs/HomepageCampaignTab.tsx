'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import {
  MediaAssetType,
  type AtelierStep,
  type CampaignFinale,
  type CampaignHero,
  type CampaignIntro,
  type FeaturedVoice,
  type HomepageCampaignDto,
  type MediaAssetDto,
  type Role,
} from '@atelier/contracts';
import { adminFetch, type AdminStoredSession } from '@/lib/api-client';
import { emitPortalToast } from '../PortalToastBanner';

export interface HomepageCampaignNotifyPayload {
  kind: 'success' | 'error' | 'info';
  title?: string;
  message: string;
}

export interface HomepageCampaignTabProps {
  roles?: readonly Role[];
  session?: AdminStoredSession | null;
  mfaVerified?: boolean;
  darkMode?: boolean;
  onNotify?: (payload: HomepageCampaignNotifyPayload) => void;
  onRefreshOverview?: () => void;
}

type MediaPickerTarget =
  | { kind: 'heroPoster' }
  | { kind: 'heroVideoWebm' }
  | { kind: 'heroVideoMp4' }
  | { kind: 'stepImage'; stepIndex: number };

const EMPTY_INTRO: CampaignIntro = {
  monogramLeft: '',
  monogramAmp: '&',
  monogramRight: '',
  tagline: '',
  brandName: '',
  brandSub: '',
};

const EMPTY_HERO: CampaignHero = {
  eyebrow: '',
  title: '',
  lead: '',
  primaryCtaLabel: '',
  serviceNote: '',
  posterUrl: '',
  videoWebmUrl: '',
  videoMp4Url: '',
};

const EMPTY_FINALE: CampaignFinale = {
  eyebrow: '',
  leadMain: '',
  leadEmphasis: '',
  ctaLabel: '',
  showroomInfo: '',
  wordmark: '',
  featuredVoices: [],
};

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const base64 = result.includes(',') ? (result.split(',')[1] ?? '') : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Không thể đọc tệp từ thiết bị.'));
    reader.readAsDataURL(file);
  });
}

function resolveMediaAssetUrl(asset: MediaAssetDto): string | null {
  if (asset.publicUrl) return asset.publicUrl;
  const variants = asset.variants ?? {};
  for (const key of ['1600w', '960w', '720w', 'preview_url', '480w', 'flat_768x1024']) {
    const entry = variants[key];
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object' && 'url' in entry) {
      return entry.url;
    }
  }
  return null;
}

function extractList<T>(data: unknown, keys: string[]): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const rec = data as Record<string, unknown>;
    for (const k of keys) {
      if (Array.isArray(rec[k])) return rec[k] as T[];
    }
  }
  return [];
}

export function HomepageCampaignTab({
  darkMode = false,
  onNotify,
  onRefreshOverview,
}: HomepageCampaignTabProps) {
  const notify = useCallback(
    (payload: HomepageCampaignNotifyPayload) => {
      if (onNotify) onNotify(payload);
      else emitPortalToast(payload);
    },
    [onNotify],
  );

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [intro, setIntro] = useState<CampaignIntro>(EMPTY_INTRO);
  const [hero, setHero] = useState<CampaignHero>(EMPTY_HERO);
  const [atelierSteps, setAtelierSteps] = useState<AtelierStep[]>([]);
  const [finale, setFinale] = useState<CampaignFinale>(EMPTY_FINALE);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    kind: 'success' | 'error';
    message: string;
  } | null>(null);

  // Media Library Picker & Direct Upload state
  const [pickerTarget, setPickerTarget] = useState<MediaPickerTarget | null>(
    null,
  );
  const [mediaAssets, setMediaAssets] = useState<MediaAssetDto[]>([]);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaSearch, setMediaSearch] = useState('');
  const [mediaTypeFilter, setMediaTypeFilter] = useState<string>('ALL');
  const [uploadingFieldKey, setUploadingFieldKey] = useState<string | null>(
    null,
  );

  const loadCampaign = useCallback(async () => {
    setLoading(true);
    setFeedback(null);
    const res = await adminFetch<HomepageCampaignDto>(
      '/api/v1/admin/homepage-campaign',
    );
    if (res.ok && res.data) {
      if (res.data.intro) setIntro(res.data.intro);
      if (res.data.hero) {
        setHero({
          ...res.data.hero,
          posterUrl: res.data.hero.posterUrl ?? res.data.heroPosterUrl ?? '',
          videoWebmUrl: res.data.hero.videoWebmUrl ?? '',
          videoMp4Url: res.data.hero.videoMp4Url ?? res.data.heroVideoUrl ?? '',
        });
      }
      if (Array.isArray(res.data.atelierSteps)) {
        setAtelierSteps(res.data.atelierSteps);
      }
      if (res.data.finale) setFinale(res.data.finale);
      setUpdatedAt(res.data.updatedAt ?? null);
    } else if (!res.ok) {
      setFeedback({
        kind: 'error',
        message:
          res.error?.message ||
          'Chưa thể tải cấu hình chiến dịch trang chủ từ BFF.',
      });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadCampaign();
  }, [loadCampaign]);

  const loadMediaLibrary = useCallback(async () => {
    setMediaLoading(true);
    const res = await adminFetch<unknown>('/api/v1/admin/media?limit=100');
    if (res.ok) {
      setMediaAssets(
        extractList<MediaAssetDto>(res.data, ['items', 'assets', 'list']),
      );
    }
    setMediaLoading(false);
  }, []);

  const openMediaPicker = (target: MediaPickerTarget) => {
    setPickerTarget(target);
    setMediaSearch('');
    setMediaTypeFilter(
      target.kind === 'heroVideoWebm' || target.kind === 'heroVideoMp4'
        ? MediaAssetType.HERO_VIDEO
        : 'ALL',
    );
    void loadMediaLibrary();
  };

  const applyUrlToTarget = useCallback(
    (target: MediaPickerTarget, url: string) => {
      if (target.kind === 'heroPoster') {
        setHero((prev) => ({ ...prev, posterUrl: url }));
      } else if (target.kind === 'heroVideoWebm') {
        setHero((prev) => ({ ...prev, videoWebmUrl: url }));
      } else if (target.kind === 'heroVideoMp4') {
        setHero((prev) => ({ ...prev, videoMp4Url: url }));
      } else if (target.kind === 'stepImage') {
        setAtelierSteps((prev) =>
          prev.map((step, i) =>
            i === target.stepIndex ? { ...step, imageUrl: url } : step,
          ),
        );
      }
    },
    [],
  );

  const handleDirectUpload = async (
    target: MediaPickerTarget,
    fieldKey: string,
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploadingFieldKey(fieldKey);

    try {
      const fileBase64 = await fileToBase64(file);
      const isVideoTarget =
        target.kind === 'heroVideoWebm' || target.kind === 'heroVideoMp4';
      const uploadType = isVideoTarget
        ? MediaAssetType.HERO_VIDEO
        : MediaAssetType.LOOKBOOK_PHOTO;

      const res = await adminFetch<MediaAssetDto>('/api/v1/admin/media/upload', {
        method: 'POST',
        timeoutMs: 30_000,
        body: JSON.stringify({
          assetType: uploadType,
          fileName: file.name,
          mimeType:
            file.type || (isVideoTarget ? 'video/mp4' : 'image/webp'),
          fileBase64,
        }),
      });

      if (res.ok && res.data) {
        const url = resolveMediaAssetUrl(res.data);
        if (url) {
          applyUrlToTarget(target, url);
          notify({
            kind: 'success',
            title: 'TẢI LÊN MEDIA PIPELINE',
            message: `Đã tải lên ${file.name} và tự động điền URL vào chiến dịch.`,
          });
        } else {
          notify({
            kind: 'error',
            title: 'THIẾU URL PUBLIC',
            message: 'Media Pipeline đã xử lý tệp nhưng không trả về publicUrl.',
          });
        }
      } else {
        notify({
          kind: 'error',
          title: 'TẢI LÊN THẤT BẠI',
          message:
            res.error?.message ||
            'Không thể tải tệp qua Media Pipeline (kiểm tra Magic Bytes / định dạng).',
        });
      }
    } catch (err) {
      notify({
        kind: 'error',
        title: 'LỖI ĐỌC TỆP',
        message: err instanceof Error ? err.message : 'Lỗi tải tệp lên.',
      });
    } finally {
      setUploadingFieldKey(null);
      event.target.value = '';
    }
  };

  const filteredMediaAssets = useMemo(() => {
    const q = mediaSearch.trim().toLowerCase();
    return mediaAssets.filter((asset) => {
      if (mediaTypeFilter !== 'ALL' && asset.assetType !== mediaTypeFilter) {
        return false;
      }
      if (q) {
        const hay = `${asset.originalKey} ${asset.assetType} ${asset.publicUrl ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [mediaAssets, mediaSearch, mediaTypeFilter]);

  const updateStep = (index: number, patch: Partial<AtelierStep>) => {
    setAtelierSteps((prev) =>
      prev.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    );
  };

  const updateVoice = (index: number, patch: Partial<FeaturedVoice>) => {
    setFinale((prev) => ({
      ...prev,
      featuredVoices: prev.featuredVoices.map((voice, i) =>
        i === index ? { ...voice, ...patch } : voice,
      ),
    }));
  };

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setFeedback(null);

    const normalizedHero: CampaignHero = {
      ...hero,
      videoWebmUrl: hero.videoWebmUrl?.trim() ? hero.videoWebmUrl.trim() : null,
      videoMp4Url: hero.videoMp4Url?.trim() ? hero.videoMp4Url.trim() : null,
    };

    const res = await adminFetch<HomepageCampaignDto>(
      '/api/v1/admin/homepage-campaign',
      {
        method: 'PUT',
        body: JSON.stringify({
          tagline: intro.tagline,
          eyebrow: normalizedHero.eyebrow,
          title: normalizedHero.title,
          subtitle: normalizedHero.lead,
          ctaLabel: normalizedHero.primaryCtaLabel,
          serviceNote: normalizedHero.serviceNote,
          heroPosterUrl: normalizedHero.posterUrl || null,
          heroVideoUrl:
            normalizedHero.videoMp4Url || normalizedHero.videoWebmUrl || null,
          intro,
          hero: normalizedHero,
          atelierSteps,
          finale,
        }),
      },
    );

    if (res.ok && res.data) {
      setUpdatedAt(res.data.updatedAt ?? new Date().toISOString());
      const msg =
        'Đã lưu Chiến dịch Trang chủ thành công! Redis cache storefront:bootstrap:v1 đã được xóa tức thì và ghi nhận HOMEPAGE_CAMPAIGN_UPDATED vào audit_logs.';
      setFeedback({ kind: 'success', message: msg });
      notify({
        kind: 'success',
        title: 'CHIẾN DỊCH TRANG CHỦ',
        message: msg,
      });
      onRefreshOverview?.();
    } else {
      const msg = res.error?.message || 'Lưu Chiến dịch Trang chủ thất bại.';
      setFeedback({ kind: 'error', message: msg });
      notify({
        kind: 'error',
        title: 'LƯU THẤT BẠI',
        message: msg,
      });
    }
    setSaving(false);
  };

  // Theme tokens
  const cardCls = darkMode
    ? 'border-[#B08A4A]/30 bg-[#1A130E] text-[#FBF7EF]'
    : 'border-[#B08A4A]/25 bg-[#FFFDF9] text-[#1C1410]';
  const subCardCls = darkMode
    ? 'border-[#B08A4A]/25 bg-[#231912] text-[#FBF7EF]'
    : 'border-[#B08A4A]/25 bg-[#FBF7EF] text-[#1C1410]';
  const mutedCls = darkMode ? 'text-[#B4A391]' : 'text-[#7A6A5B]';
  const secondaryCls = darkMode ? 'text-[#DFD2C2]' : 'text-[#5C4B41]';
  const goldTextCls = darkMode ? 'text-[#EBCF8F]' : 'text-[#8A672C]';
  const inputCls = darkMode
    ? 'border-[#B08A4A]/35 bg-[#140E0A] text-[#FBF7EF] placeholder:text-[#8E7D6B] focus:border-[#EBCF8F]'
    : 'border-[#B08A4A]/35 bg-white text-[#1C1410] placeholder:text-[#7A6A5B] focus:border-[#1C1410]';

  const renderMediaFieldToolbar = (
    target: MediaPickerTarget,
    fieldKey: string,
    accept: string,
    currentUrl: string | null | undefined,
    isVideo = false,
  ) => {
    const isUploading = uploadingFieldKey === fieldKey;
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {currentUrl && !isVideo ? (
          <img
            src={currentUrl}
            alt="Xem trước ảnh"
            className="h-10 w-10 shrink-0 rounded-lg border border-[#B08A4A]/35 object-cover"
          />
        ) : null}
        <button
          type="button"
          data-testid={`campaign-media-picker-${fieldKey}`}
          onClick={() => openMediaPicker(target)}
          className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
            darkMode
              ? 'border-[#B08A4A]/45 bg-[#231912] text-[#EBCF8F] hover:bg-[#2F2117]'
              : 'border-[#B08A4A]/45 bg-[#FBF7EF] text-[#5C4B41] hover:border-[#1C1410]'
          }`}
        >
          Chọn từ Thư viện Media
        </button>

        <label
          data-testid={`campaign-media-upload-${fieldKey}`}
          className={`cursor-pointer rounded-full px-3 py-1 text-[11px] font-medium transition-opacity hover:opacity-90 ${
            darkMode
              ? 'bg-[#EBCF8F] text-[#1C1410]'
              : 'bg-[#1C1410] text-[#EBCF8F]'
          }`}
        >
          {isUploading ? 'Đang tải lên...' : 'Tải lên Media Pipeline'}
          <input
            type="file"
            accept={accept}
            disabled={isUploading}
            onChange={(e) => void handleDirectUpload(target, fieldKey, e)}
            className="hidden"
          />
        </label>
      </div>
    );
  };

  if (loading) {
    return (
      <p className={`text-xs ${mutedCls}`}>
        Đang tải cấu hình Chiến dịch Trang chủ (Homepage Campaign)...
      </p>
    );
  }

  return (
    <form onSubmit={handleSave} className="space-y-6">
      <div
        className={`flex flex-wrap items-center justify-between gap-4 rounded-3xl border p-6 ${cardCls}`}
      >
        <div>
          <p className={`ledger-eyebrow ${goldTextCls}`}>
            Homepage Campaign CMS · Media Library Picker &amp; Redis Auto-Invalidation
          </p>
          <h2 className="font-editorial mt-1 text-3xl">
            Chỉnh sửa Chiến dịch Trang chủ Storefront
          </h2>
          {updatedAt ? (
            <p className={`mt-1 font-mono text-[11px] ${mutedCls}`}>
              Cập nhật lần cuối: {new Date(updatedAt).toLocaleString('vi-VN')}
            </p>
          ) : null}
        </div>

        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={() => void loadCampaign()}
            className={`rounded-full border px-4 py-2 text-xs ${
              darkMode
                ? 'border-[#B08A4A]/45 text-[#EBCF8F]'
                : 'border-[#B08A4A]/45 text-[#8A672C]'
            }`}
          >
            Tải lại
          </button>
          <button
            type="submit"
            disabled={saving}
            className={`rounded-full px-6 py-2 text-xs font-medium uppercase tracking-[0.16em] disabled:opacity-50 ${
              darkMode
                ? 'bg-[#EBCF8F] text-[#1C1410]'
                : 'bg-[#1C1410] text-[#EBCF8F]'
            }`}
          >
            {saving ? 'Đang lưu & xóa cache...' : 'Lưu chiến dịch (PUT)'}
          </button>
        </div>
      </div>

      {feedback ? (
        <div
          role="status"
          className={`rounded-2xl border px-5 py-3.5 text-xs ${
            feedback.kind === 'success'
              ? darkMode
                ? 'border-emerald-500/45 bg-emerald-950/50 text-emerald-200'
                : 'border-[#2E6B47]/35 bg-[#F2FBF6] text-[#1E4B32]'
              : darkMode
                ? 'border-rose-500/45 bg-rose-950/50 text-rose-200'
                : 'border-[#8B2E2E]/35 bg-[#FFF5F4] text-[#8B2E2E]'
          }`}
        >
          {feedback.message}
        </div>
      ) : null}

      {/* Section 1: Intro Curtain & Brand Monogram */}
      <section className={`rounded-3xl border p-6 ${cardCls}`}>
        <p className={`ledger-eyebrow ${goldTextCls}`}>
          1. Màn mở màn (Intro Curtain) &amp; Nhận diện Header
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <label className="text-xs">
            <span className={secondaryCls}>Monogram Trái</span>
            <input
              type="text"
              value={intro.monogramLeft}
              onChange={(e) =>
                setIntro({ ...intro, monogramLeft: e.target.value })
              }
              className={`mt-1 w-full rounded-xl border px-3 py-2 text-sm outline-none ${inputCls}`}
            />
          </label>
          <label className="text-xs">
            <span className={secondaryCls}>Ký tự nối (&amp;)</span>
            <input
              type="text"
              value={intro.monogramAmp}
              onChange={(e) =>
                setIntro({ ...intro, monogramAmp: e.target.value })
              }
              className={`mt-1 w-full rounded-xl border px-3 py-2 text-sm outline-none ${inputCls}`}
            />
          </label>
          <label className="text-xs">
            <span className={secondaryCls}>Monogram Phải</span>
            <input
              type="text"
              value={intro.monogramRight}
              onChange={(e) =>
                setIntro({ ...intro, monogramRight: e.target.value })
              }
              className={`mt-1 w-full rounded-xl border px-3 py-2 text-sm outline-none ${inputCls}`}
            />
          </label>
          <label className="text-xs">
            <span className={secondaryCls}>Tên thương hiệu (brandName)</span>
            <input
              type="text"
              value={intro.brandName}
              onChange={(e) =>
                setIntro({ ...intro, brandName: e.target.value })
              }
              className={`mt-1 w-full rounded-xl border px-3 py-2 text-sm outline-none ${inputCls}`}
            />
          </label>
          <label className="text-xs">
            <span className={secondaryCls}>Phụ đề nhỏ (brandSub)</span>
            <input
              type="text"
              value={intro.brandSub}
              onChange={(e) => setIntro({ ...intro, brandSub: e.target.value })}
              className={`mt-1 w-full rounded-xl border px-3 py-2 text-sm outline-none ${inputCls}`}
            />
          </label>
          <label className="text-xs">
            <span className={secondaryCls}>Khẩu hiệu mở màn (tagline)</span>
            <input
              type="text"
              value={intro.tagline}
              onChange={(e) => setIntro({ ...intro, tagline: e.target.value })}
              className={`mt-1 w-full rounded-xl border px-3 py-2 text-sm outline-none ${inputCls}`}
            />
          </label>
        </div>
      </section>

      {/* Section 2: Hero Editorial & Media Assets */}
      <section className={`rounded-3xl border p-6 ${cardCls}`}>
        <p className={`ledger-eyebrow ${goldTextCls}`}>
          2. Hero Editorial (#top) &amp; Media Hình ảnh / Video
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="text-xs">
            <span className={secondaryCls}>Eyebrow</span>
            <input
              type="text"
              value={hero.eyebrow}
              onChange={(e) => setHero({ ...hero, eyebrow: e.target.value })}
              className={`mt-1 w-full rounded-xl border px-3 py-2 text-sm outline-none ${inputCls}`}
            />
          </label>
          <label className="text-xs">
            <span className={secondaryCls}>Tiêu đề Shimmer (title)</span>
            <input
              type="text"
              value={hero.title}
              onChange={(e) => setHero({ ...hero, title: e.target.value })}
              className={`mt-1 w-full rounded-xl border px-3 py-2 text-sm outline-none ${inputCls}`}
            />
          </label>
          <label className="text-xs sm:col-span-2">
            <span className={secondaryCls}>Mô tả dẫn nhập (lead)</span>
            <textarea
              rows={2}
              value={hero.lead}
              onChange={(e) => setHero({ ...hero, lead: e.target.value })}
              className={`mt-1 w-full rounded-xl border px-3 py-2 text-sm outline-none ${inputCls}`}
            />
          </label>
          <label className="text-xs">
            <span className={secondaryCls}>Nút CTA chính (primaryCtaLabel)</span>
            <input
              type="text"
              value={hero.primaryCtaLabel}
              onChange={(e) =>
                setHero({ ...hero, primaryCtaLabel: e.target.value })
              }
              className={`mt-1 w-full rounded-xl border px-3 py-2 text-sm outline-none ${inputCls}`}
            />
          </label>
          <label className="text-xs">
            <span className={secondaryCls}>Dòng dịch vụ (serviceNote)</span>
            <input
              type="text"
              value={hero.serviceNote}
              onChange={(e) =>
                setHero({ ...hero, serviceNote: e.target.value })
              }
              className={`mt-1 w-full rounded-xl border px-3 py-2 text-sm outline-none ${inputCls}`}
            />
          </label>

          {/* Hero Poster URL with Picker + Direct Upload */}
          <div className={`rounded-2xl border p-3.5 text-xs sm:col-span-2 ${subCardCls}`}>
            <span className={`font-medium ${secondaryCls}`}>
              Ảnh Poster Hero (hero.posterUrl)
            </span>
            <input
              type="text"
              value={hero.posterUrl}
              onChange={(e) => setHero({ ...hero, posterUrl: e.target.value })}
              placeholder="https://.../hero-poster.webp"
              className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono text-xs outline-none ${inputCls}`}
            />
            {renderMediaFieldToolbar(
              { kind: 'heroPoster' },
              'hero-poster',
              'image/webp,image/png,image/jpeg',
              hero.posterUrl,
            )}
          </div>

          {/* Video WebM URL */}
          <div className={`rounded-2xl border p-3.5 text-xs ${subCardCls}`}>
            <span className={`font-medium ${secondaryCls}`}>
              Video Hero WebM (hero.videoWebmUrl)
            </span>
            <input
              type="text"
              value={hero.videoWebmUrl ?? ''}
              onChange={(e) =>
                setHero({ ...hero, videoWebmUrl: e.target.value })
              }
              placeholder="URL video .webm (tùy chọn)"
              className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono text-xs outline-none ${inputCls}`}
            />
            {renderMediaFieldToolbar(
              { kind: 'heroVideoWebm' },
              'hero-video-webm',
              'video/webm,video/*,image/*',
              hero.videoWebmUrl,
              true,
            )}
          </div>

          {/* Video MP4 URL */}
          <div className={`rounded-2xl border p-3.5 text-xs ${subCardCls}`}>
            <span className={`font-medium ${secondaryCls}`}>
              Video Hero MP4 (hero.videoMp4Url)
            </span>
            <input
              type="text"
              value={hero.videoMp4Url ?? ''}
              onChange={(e) =>
                setHero({ ...hero, videoMp4Url: e.target.value })
              }
              placeholder="URL video .mp4 (tùy chọn)"
              className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono text-xs outline-none ${inputCls}`}
            />
            {renderMediaFieldToolbar(
              { kind: 'heroVideoMp4' },
              'hero-video-mp4',
              'video/mp4,video/*,image/*',
              hero.videoMp4Url,
              true,
            )}
          </div>
        </div>
      </section>

      {/* Section 3: 4 Atelier Steps (Golden Thread) */}
      <section className={`rounded-3xl border p-6 ${cardCls}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={`ledger-eyebrow ${goldTextCls}`}>
            3. Hành trình Xưởng may (atelierSteps · #atelier)
          </p>
          <button
            type="button"
            onClick={() =>
              setAtelierSteps((prev) => [
                ...prev,
                {
                  stepOrder: prev.length + 1,
                  timeTarget: '18:00',
                  title: `Công đoạn ${prev.length + 1}`,
                  description: 'Mô tả công đoạn thủ công tại xưởng.',
                  imageUrl: '',
                  imageAlt: 'Ảnh công đoạn xưởng may',
                },
              ])
            }
            className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-[11px]"
          >
            + Thêm bước
          </button>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {atelierSteps.map((step, idx) => (
            <div
              key={`step-${step.stepOrder}-${idx}`}
              className={`space-y-3 rounded-2xl border p-4 ${subCardCls}`}
            >
              <div className="flex items-center justify-between">
                <p className={`font-mono text-[11px] font-semibold ${goldTextCls}`}>
                  Bước 0{step.stepOrder}
                </p>
                {atelierSteps.length > 1 ? (
                  <button
                    type="button"
                    onClick={() =>
                      setAtelierSteps((prev) =>
                        prev
                          .filter((_, i) => i !== idx)
                          .map((s, orderIdx) => ({
                            ...s,
                            stepOrder: orderIdx + 1,
                          })),
                      )
                    }
                    className="text-[10.5px] text-[#8B2E2E] hover:underline dark:text-rose-300"
                  >
                    Xóa bước
                  </button>
                ) : null}
              </div>

              <div className="grid grid-cols-[110px_1fr] gap-2.5">
                <label className="text-xs">
                  <span className={secondaryCls}>Mốc giờ</span>
                  <input
                    type="text"
                    value={step.timeTarget}
                    onChange={(e) =>
                      updateStep(idx, { timeTarget: e.target.value })
                    }
                    className={`mt-1 w-full rounded-lg border px-2.5 py-1.5 font-mono text-xs outline-none ${inputCls}`}
                  />
                </label>
                <label className="text-xs">
                  <span className={secondaryCls}>Tiêu đề công đoạn</span>
                  <input
                    type="text"
                    value={step.title}
                    onChange={(e) => updateStep(idx, { title: e.target.value })}
                    className={`mt-1 w-full rounded-lg border px-2.5 py-1.5 text-xs outline-none ${inputCls}`}
                  />
                </label>
              </div>

              <label className="block text-xs">
                <span className={secondaryCls}>Mô tả chi tiết</span>
                <textarea
                  rows={2}
                  value={step.description}
                  onChange={(e) =>
                    updateStep(idx, { description: e.target.value })
                  }
                  className={`mt-1 w-full rounded-lg border px-2.5 py-1.5 text-xs outline-none ${inputCls}`}
                />
              </label>

              <div className="space-y-1.5 text-xs">
                <span className={secondaryCls}>
                  Ảnh công đoạn (atelierSteps[{idx}].imageUrl)
                </span>
                <input
                  type="text"
                  value={step.imageUrl}
                  onChange={(e) =>
                    updateStep(idx, { imageUrl: e.target.value })
                  }
                  placeholder="https://.../atelier-step.webp"
                  className={`w-full rounded-lg border px-2.5 py-1.5 font-mono text-[11px] outline-none ${inputCls}`}
                />
                {renderMediaFieldToolbar(
                  { kind: 'stepImage', stepIndex: idx },
                  `step-${idx}`,
                  'image/webp,image/png,image/jpeg',
                  step.imageUrl,
                )}
              </div>

              <label className="block text-xs">
                <span className={secondaryCls}>Chú thích ảnh (imageAlt)</span>
                <input
                  type="text"
                  value={step.imageAlt}
                  onChange={(e) =>
                    updateStep(idx, { imageAlt: e.target.value })
                  }
                  className={`mt-1 w-full rounded-lg border px-2.5 py-1.5 text-xs outline-none ${inputCls}`}
                />
              </label>
            </div>
          ))}
        </div>
      </section>

      {/* Section 4: Finale & Featured Voices */}
      <section className={`rounded-3xl border p-6 ${cardCls}`}>
        <p className={`ledger-eyebrow ${goldTextCls}`}>
          4. Finale, Wordmark &amp; Đánh giá Xác thực (#contact)
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="text-xs">
            <span className={secondaryCls}>Dòng chính (leadMain)</span>
            <input
              type="text"
              value={finale.leadMain}
              onChange={(e) =>
                setFinale({ ...finale, leadMain: e.target.value })
              }
              className={`mt-1 w-full rounded-xl border px-3 py-2 text-sm outline-none ${inputCls}`}
            />
          </label>
          <label className="text-xs">
            <span className={secondaryCls}>
              Dòng nhấn in nghiêng (leadEmphasis)
            </span>
            <input
              type="text"
              value={finale.leadEmphasis}
              onChange={(e) =>
                setFinale({ ...finale, leadEmphasis: e.target.value })
              }
              className={`mt-1 w-full rounded-xl border px-3 py-2 text-sm outline-none ${inputCls}`}
            />
          </label>
          <label className="text-xs">
            <span className={secondaryCls}>
              Thông tin Showroom (showroomInfo)
            </span>
            <input
              type="text"
              value={finale.showroomInfo}
              onChange={(e) =>
                setFinale({ ...finale, showroomInfo: e.target.value })
              }
              className={`mt-1 w-full rounded-xl border px-3 py-2 text-sm outline-none ${inputCls}`}
            />
          </label>
          <label className="text-xs">
            <span className={secondaryCls}>
              Chữ rọi sáng khổ lớn (wordmark)
            </span>
            <input
              type="text"
              value={finale.wordmark}
              onChange={(e) =>
                setFinale({ ...finale, wordmark: e.target.value })
              }
              className={`mt-1 w-full rounded-xl border px-3 py-2 text-sm outline-none ${inputCls}`}
            />
          </label>
        </div>

        <div className="mt-6 space-y-3">
          <p className={`text-xs font-semibold uppercase tracking-[0.16em] ${goldTextCls}`}>
            Đánh giá xác thực (featuredVoices)
          </p>
          <div className="grid gap-3 lg:grid-cols-3">
            {finale.featuredVoices.map((voice, vIdx) => (
              <div
                key={`voice-${vIdx}`}
                className={`space-y-2 rounded-2xl border p-3.5 text-xs ${subCardCls}`}
              >
                <input
                  type="text"
                  value={voice.author}
                  onChange={(e) =>
                    updateVoice(vIdx, { author: e.target.value })
                  }
                  placeholder="Tên khách hàng"
                  className={`w-full rounded-lg border px-2.5 py-1.5 text-xs font-medium outline-none ${inputCls}`}
                />
                <input
                  type="text"
                  value={voice.fitMeta}
                  onChange={(e) =>
                    updateVoice(vIdx, { fitMeta: e.target.value })
                  }
                  placeholder="Số đo & Size đã mặc"
                  className={`w-full rounded-lg border px-2.5 py-1.5 font-mono text-[11px] outline-none ${inputCls}`}
                />
                <textarea
                  rows={2}
                  value={voice.quote}
                  onChange={(e) => updateVoice(vIdx, { quote: e.target.value })}
                  placeholder="Trích dẫn đánh giá"
                  className={`w-full rounded-lg border px-2.5 py-1.5 text-xs outline-none ${inputCls}`}
                />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* MediaStudio Library Picker Modal */}
      {pickerTarget ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Thư viện MediaStudio"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#0D0805]/65 p-4 backdrop-blur-xs"
        >
          <div
            className={`flex max-h-[85vh] w-full max-w-3xl flex-col rounded-3xl border p-6 shadow-2xl ${cardCls}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#B08A4A]/20 pb-4">
              <div>
                <p className={`ledger-eyebrow ${goldTextCls}`}>
                  MediaStudio Library Picker · /api/v1/admin/media
                </p>
                <h3 className="font-editorial mt-0.5 text-2xl">
                  Chọn tài nguyên Media cho Chiến dịch Trang chủ
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setPickerTarget(null)}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-xs"
              >
                Đóng
              </button>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <select
                value={mediaTypeFilter}
                onChange={(e) => setMediaTypeFilter(e.target.value)}
                className={`rounded-full border px-3 py-1.5 text-xs outline-none ${inputCls}`}
              >
                <option value="ALL">Mọi định dạng Media</option>
                <option value={MediaAssetType.LOOKBOOK_PHOTO}>
                  LOOKBOOK_PHOTO
                </option>
                <option value={MediaAssetType.HERO_VIDEO}>HERO_VIDEO</option>
                <option value={MediaAssetType.RACK_CUTOUT_2_3}>
                  RACK_CUTOUT_2_3
                </option>
                <option value={MediaAssetType.TRYON_FLAT_3_4}>
                  TRYON_FLAT_3_4
                </option>
                <option value={MediaAssetType.STUDIO_LAYER_2_3}>
                  STUDIO_LAYER_2_3
                </option>
              </select>
              <input
                type="search"
                value={mediaSearch}
                onChange={(e) => setMediaSearch(e.target.value)}
                placeholder="Tìm theo key hoặc đường dẫn..."
                className={`flex-1 rounded-full border px-3.5 py-1.5 text-xs outline-none ${inputCls}`}
              />
              <button
                type="button"
                onClick={() => void loadMediaLibrary()}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1.5 text-xs"
              >
                Tải lại
              </button>
            </div>

            <div className="mt-4 flex-1 overflow-y-auto">
              {mediaLoading ? (
                <p className={`py-8 text-center text-xs ${mutedCls}`}>
                  Đang tải danh sách tài nguyên từ Media Pipeline...
                </p>
              ) : filteredMediaAssets.length === 0 ? (
                <p className={`py-8 text-center text-xs ${mutedCls}`}>
                  Không có tệp Media nào khớp bộ lọc. Bạn có thể dùng nút &quot;Tải
                  lên Media Pipeline&quot; ngay bên cạnh ô URL.
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {filteredMediaAssets.map((asset) => {
                    const url = resolveMediaAssetUrl(asset);
                    const isVideo =
                      asset.assetType === MediaAssetType.HERO_VIDEO ||
                      asset.mimeType.startsWith('video/');
                    return (
                      <button
                        key={asset.id}
                        type="button"
                        disabled={!url}
                        onClick={() => {
                          if (!url) return;
                          applyUrlToTarget(pickerTarget, url);
                          setPickerTarget(null);
                          notify({
                            kind: 'info',
                            title: 'ĐÃ CHỌN MEDIA',
                            message: `Đã gắn ${asset.originalKey} vào biểu mẫu chiến dịch.`,
                          });
                        }}
                        className={`flex flex-col overflow-hidden rounded-2xl border p-2.5 text-left transition-all hover:border-[#B08A4A] disabled:opacity-45 ${subCardCls}`}
                      >
                        <div className="flex h-32 w-full items-center justify-center overflow-hidden rounded-xl bg-[#16100C]">
                          {url && !isVideo ? (
                            <img
                              src={url}
                              alt={asset.originalKey}
                              className="h-full w-full object-contain"
                            />
                          ) : (
                            <span className="font-mono text-[10px] text-[#EBCF8F]">
                              {asset.assetType}
                            </span>
                          )}
                        </div>
                        <p className={`mt-2 font-mono text-[10px] ${goldTextCls}`}>
                          {asset.assetType}
                          {asset.width && asset.height
                            ? ` · ${asset.width}×${asset.height}`
                            : ''}
                        </p>
                        <p className="mt-0.5 truncate font-mono text-[11px]">
                          {asset.originalKey}
                        </p>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </form>
  );
}
