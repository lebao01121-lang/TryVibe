'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  AtelierStep,
  CampaignFinale,
  CampaignHero,
  CampaignIntro,
  FeaturedVoice,
  HomepageCampaignDto,
} from '@atelier/contracts';
import { adminFetch } from '@/lib/api-client';

const EMPTY_INTRO: CampaignIntro = {
  monogramLeft: 'T',
  monogramAmp: '&',
  monogramRight: 'X',
  tagline: 'May đo thủ công · Hà Nội',
  brandName: 'Tầm Xuân',
  brandSub: 'Fashion Atelier',
};

const EMPTY_HERO: CampaignHero = {
  eyebrow: 'Fashion Atelier · Est. 2019 · Hà Nội',
  title: 'Tầm Xuân',
  lead: 'Thiết kế may đo thủ công trên lụa tơ tằm và linen hữu cơ — ướm thử dáng thật bằng AI trước khi đặt may.',
  primaryCtaLabel: 'Khám phá bộ sưu tập',
  serviceNote: 'May đo theo số đo · Đổi size 7–14 ngày · Xóa ảnh AI sau 15 phút',
  posterUrl: 'http://127.0.0.1:9000/atelier-public/seed/hero-atelier-poster.webp',
  videoWebmUrl: '/media/rose-desk.webm',
  videoMp4Url: '/media/rose-desk.mp4',
};

const EMPTY_STEPS: AtelierStep[] = [
  {
    stepOrder: 1,
    timeTarget: '08:00',
    title: 'Tuyển chọn lụa & linen',
    description: 'Kiểm tra từng thước vải tự nhiên dưới ánh sáng sớm.',
    imageUrl: 'http://127.0.0.1:9000/atelier-public/seed/atelier-step-1.webp',
    imageAlt: 'Tuyển chọn vải tại xưởng',
  },
  {
    stepOrder: 2,
    timeTarget: '11:00',
    title: 'Dựng rập & cắt thủ công',
    description: 'Dựng rập 3D chuẩn tỷ lệ hình thể người Việt.',
    imageUrl: 'http://127.0.0.1:9000/atelier-public/seed/atelier-step-2.webp',
    imageAlt: 'Dựng rập và cắt vải thủ công',
  },
  {
    stepOrder: 3,
    timeTarget: '14:30',
    title: 'Khâu tay chi tiết',
    description: 'May lộn giấu chỉ và đính khuy sừng thủ công.',
    imageUrl: 'http://127.0.0.1:9000/atelier-public/seed/atelier-step-3.webp',
    imageAlt: 'Khâu tay chi tiết tại xưởng',
  },
  {
    stepOrder: 4,
    timeTarget: '17:00',
    title: 'Là hơi, kiểm chuẩn & đóng hộp',
    description: 'Hoàn thiện bằng hơi nước và đóng hộp quà kèm thiệp viết tay.',
    imageUrl: 'http://127.0.0.1:9000/atelier-public/seed/atelier-step-4.webp',
    imageAlt: 'Kiểm chuẩn và đóng hộp giao khách',
  },
];

const EMPTY_FINALE: CampaignFinale = {
  eyebrow: 'Đặt may & Phòng thử AI',
  leadMain: 'Ghé xưởng hoặc ướm thử trực tuyến —',
  leadEmphasis: 'mỗi đường kim đều chuẩn theo dáng bạn.',
  ctaLabel: 'Khám phá bộ sưu tập',
  showroomInfo: 'Phố Phan Đình Phùng, Ba Đình · Mở cửa 9:00 – 21:00 mỗi ngày',
  wordmark: 'Tầm Xuân',
  featuredVoices: [
    {
      quote: 'Bề mặt lụa bóng mờ rất sang, vai áo đứng phom tự nhiên.',
      author: 'Chị Minh Anh · Ba Đình',
      fitMeta: '163cm · 52kg · Mặc Size S (Vừa vai)',
    },
    {
      quote: 'Tư vấn bảng số đo chính xác, hộp quà hoàn thiện rất tinh tế.',
      author: 'Anh Quang Đức · Tây Hồ',
      fitMeta: '176cm · 70kg · Mặc Size L (Thoải mái)',
    },
    {
      quote: 'Đường may lộn giấu chỉ êm nhẹ, mặc cả ngày rất dễ chịu.',
      author: 'Chị Thu Hà · Hoàn Kiếm',
      fitMeta: '167cm · 56kg · Mặc Size M (Chuẩn eo)',
    },
  ],
};

export function HomepageCampaignTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [intro, setIntro] = useState<CampaignIntro>(EMPTY_INTRO);
  const [hero, setHero] = useState<CampaignHero>(EMPTY_HERO);
  const [atelierSteps, setAtelierSteps] = useState<AtelierStep[]>(EMPTY_STEPS);
  const [finale, setFinale] = useState<CampaignFinale>(EMPTY_FINALE);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    kind: 'success' | 'error';
    message: string;
  } | null>(null);

  const loadCampaign = useCallback(async () => {
    setLoading(true);
    const res = await adminFetch<HomepageCampaignDto>(
      '/api/v1/admin/homepage-campaign',
    );
    if (res.ok && res.data) {
      if (res.data.intro) setIntro(res.data.intro);
      if (res.data.hero) setHero(res.data.hero);
      if (res.data.atelierSteps && res.data.atelierSteps.length > 0) {
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

  const updateStep = (
    index: number,
    patch: Partial<AtelierStep>,
  ) => {
    setAtelierSteps((prev) =>
      prev.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    );
  };

  const updateVoice = (
    index: number,
    patch: Partial<FeaturedVoice>,
  ) => {
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

    const res = await adminFetch<HomepageCampaignDto>(
      '/api/v1/admin/homepage-campaign',
      {
        method: 'PUT',
        body: JSON.stringify({
          tagline: intro.tagline,
          eyebrow: hero.eyebrow,
          title: hero.title,
          subtitle: hero.lead,
          ctaLabel: hero.primaryCtaLabel,
          serviceNote: hero.serviceNote,
          intro,
          hero,
          atelierSteps,
          finale,
        }),
      },
    );

    if (res.ok && res.data) {
      setUpdatedAt(res.data.updatedAt ?? new Date().toISOString());
      setFeedback({
        kind: 'success',
        message:
          'Đã lưu Chiến dịch Trang chủ thành công! Redis cache storefront:bootstrap:v1 đã được xóa tức thì và ghi nhận HOMEPAGE_CAMPAIGN_UPDATED vào audit_logs.',
      });
    } else {
      setFeedback({
        kind: 'error',
        message:
          res.error?.message || 'Lưu Chiến dịch Trang chủ thất bại.',
      });
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <p className="text-xs text-[#7A6A5B]">
        Đang tải cấu hình Chiến dịch Trang chủ (Homepage Campaign)...
      </p>
    );
  }

  return (
    <form onSubmit={handleSave} className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
        <div>
          <p className="ledger-eyebrow text-[#8A672C]">
            Homepage Campaign CMS · Redis storefront:bootstrap:v1 Auto-Invalidation
          </p>
          <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
            Chỉnh sửa Chiến dịch Trang chủ Storefront
          </h2>
          {updatedAt ? (
            <p className="mt-1 font-mono text-[11px] text-[#7A6A5B]">
              Cập nhật lần cuối: {new Date(updatedAt).toLocaleString('vi-VN')}
            </p>
          ) : null}
        </div>

        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={() => void loadCampaign()}
            className="rounded-full border border-[#B08A4A]/45 px-4 py-2 text-xs text-[#8A672C]"
          >
            Tải lại
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-full bg-[#1C1410] px-6 py-2 text-xs font-medium uppercase tracking-[0.16em] text-[#EBCF8F] disabled:opacity-50"
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
              ? 'border-[#2E6B47]/35 bg-[#F2FBF6] text-[#1E4B32]'
              : 'border-[#8B2E2E]/35 bg-[#FFF5F4] text-[#8B2E2E]'
          }`}
        >
          {feedback.message}
        </div>
      ) : null}

      {/* Section 1: Intro Curtain & Brand Monogram */}
      <section className="rounded-3xl border border-[#B08A4A]/25 bg-white p-6">
        <p className="ledger-eyebrow text-[#8A672C]">
          1. Màn mở màn (Intro Curtain) &amp; Nhận diện Header
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <label className="text-xs">
            <span className="text-[#5C4B41]">Monogram Trái</span>
            <input
              type="text"
              value={intro.monogramLeft}
              onChange={(e) =>
                setIntro({ ...intro, monogramLeft: e.target.value })
              }
              className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs">
            <span className="text-[#5C4B41]">Ký tự nối (&amp;)</span>
            <input
              type="text"
              value={intro.monogramAmp}
              onChange={(e) =>
                setIntro({ ...intro, monogramAmp: e.target.value })
              }
              className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs">
            <span className="text-[#5C4B41]">Monogram Phải</span>
            <input
              type="text"
              value={intro.monogramRight}
              onChange={(e) =>
                setIntro({ ...intro, monogramRight: e.target.value })
              }
              className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs">
            <span className="text-[#5C4B41]">Tên thương hiệu (brandName)</span>
            <input
              type="text"
              value={intro.brandName}
              onChange={(e) =>
                setIntro({ ...intro, brandName: e.target.value })
              }
              className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs">
            <span className="text-[#5C4B41]">Phụ đề nhỏ (brandSub)</span>
            <input
              type="text"
              value={intro.brandSub}
              onChange={(e) =>
                setIntro({ ...intro, brandSub: e.target.value })
              }
              className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs">
            <span className="text-[#5C4B41]">Khẩu hiệu mở màn (tagline)</span>
            <input
              type="text"
              value={intro.tagline}
              onChange={(e) => setIntro({ ...intro, tagline: e.target.value })}
              className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2 text-sm"
            />
          </label>
        </div>
      </section>

      {/* Section 2: Hero Editorial */}
      <section className="rounded-3xl border border-[#B08A4A]/25 bg-white p-6">
        <p className="ledger-eyebrow text-[#8A672C]">2. Hero Editorial (#top)</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="text-xs">
            <span className="text-[#5C4B41]">Eyebrow</span>
            <input
              type="text"
              value={hero.eyebrow}
              onChange={(e) => setHero({ ...hero, eyebrow: e.target.value })}
              className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs">
            <span className="text-[#5C4B41]">Tiêu đề Shimmer (title)</span>
            <input
              type="text"
              value={hero.title}
              onChange={(e) => setHero({ ...hero, title: e.target.value })}
              className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs sm:col-span-2">
            <span className="text-[#5C4B41]">Mô tả dẫn nhập (lead)</span>
            <textarea
              rows={2}
              value={hero.lead}
              onChange={(e) => setHero({ ...hero, lead: e.target.value })}
              className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs">
            <span className="text-[#5C4B41]">Nút CTA chính (primaryCtaLabel)</span>
            <input
              type="text"
              value={hero.primaryCtaLabel}
              onChange={(e) =>
                setHero({ ...hero, primaryCtaLabel: e.target.value })
              }
              className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs">
            <span className="text-[#5C4B41]">Dòng dịch vụ (serviceNote)</span>
            <input
              type="text"
              value={hero.serviceNote}
              onChange={(e) =>
                setHero({ ...hero, serviceNote: e.target.value })
              }
              className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2 text-sm"
            />
          </label>
        </div>
      </section>

      {/* Section 3: 4 Atelier Steps (Golden Thread) */}
      <section className="rounded-3xl border border-[#B08A4A]/25 bg-white p-6">
        <p className="ledger-eyebrow text-[#8A672C]">
          3. Hành trình Xưởng may 4 bước (atelierSteps · #atelier)
        </p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {atelierSteps.map((step, idx) => (
            <div
              key={step.stepOrder}
              className="space-y-3 rounded-2xl border border-[#B08A4A]/25 bg-[#FBF7EF] p-4"
            >
              <p className="font-mono text-[11px] font-semibold text-[#8A672C]">
                Bước 0{step.stepOrder}
              </p>
              <div className="grid grid-cols-[110px_1fr] gap-2.5">
                <label className="text-xs">
                  <span className="text-[#5C4B41]">Mốc giờ</span>
                  <input
                    type="text"
                    value={step.timeTarget}
                    onChange={(e) =>
                      updateStep(idx, { timeTarget: e.target.value })
                    }
                    className="mt-1 w-full rounded-lg border border-[#B08A4A]/35 bg-white px-2.5 py-1.5 font-mono text-xs"
                  />
                </label>
                <label className="text-xs">
                  <span className="text-[#5C4B41]">Tiêu đề công đoạn</span>
                  <input
                    type="text"
                    value={step.title}
                    onChange={(e) => updateStep(idx, { title: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-[#B08A4A]/35 bg-white px-2.5 py-1.5 text-xs"
                  />
                </label>
              </div>
              <label className="block text-xs">
                <span className="text-[#5C4B41]">Mô tả chi tiết</span>
                <textarea
                  rows={2}
                  value={step.description}
                  onChange={(e) =>
                    updateStep(idx, { description: e.target.value })
                  }
                  className="mt-1 w-full rounded-lg border border-[#B08A4A]/35 bg-white px-2.5 py-1.5 text-xs"
                />
              </label>
            </div>
          ))}
        </div>
      </section>

      {/* Section 4: Finale & Featured Voices */}
      <section className="rounded-3xl border border-[#B08A4A]/25 bg-white p-6">
        <p className="ledger-eyebrow text-[#8A672C]">
          4. Finale, Wordmark &amp; Đánh giá Xác thực (#contact)
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="text-xs">
            <span className="text-[#5C4B41]">Dòng chính (leadMain)</span>
            <input
              type="text"
              value={finale.leadMain}
              onChange={(e) =>
                setFinale({ ...finale, leadMain: e.target.value })
              }
              className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs">
            <span className="text-[#5C4B41]">Dòng nhấn in nghiêng (leadEmphasis)</span>
            <input
              type="text"
              value={finale.leadEmphasis}
              onChange={(e) =>
                setFinale({ ...finale, leadEmphasis: e.target.value })
              }
              className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs">
            <span className="text-[#5C4B41]">Thông tin Showroom (showroomInfo)</span>
            <input
              type="text"
              value={finale.showroomInfo}
              onChange={(e) =>
                setFinale({ ...finale, showroomInfo: e.target.value })
              }
              className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs">
            <span className="text-[#5C4B41]">Chữ rọi sáng khổ lớn (wordmark)</span>
            <input
              type="text"
              value={finale.wordmark}
              onChange={(e) =>
                setFinale({ ...finale, wordmark: e.target.value })
              }
              className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2 text-sm"
            />
          </label>
        </div>

        <div className="mt-6 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8A672C]">
            Đánh giá xác thực (featuredVoices)
          </p>
          <div className="grid gap-3 lg:grid-cols-3">
            {finale.featuredVoices.map((voice, vIdx) => (
              <div
                key={`voice-${vIdx}`}
                className="space-y-2 rounded-2xl border border-[#B08A4A]/25 bg-[#FBF7EF] p-3.5 text-xs"
              >
                <input
                  type="text"
                  value={voice.author}
                  onChange={(e) =>
                    updateVoice(vIdx, { author: e.target.value })
                  }
                  placeholder="Tên khách hàng"
                  className="w-full rounded-lg border border-[#B08A4A]/35 bg-white px-2.5 py-1.5 text-xs font-medium"
                />
                <input
                  type="text"
                  value={voice.fitMeta}
                  onChange={(e) =>
                    updateVoice(vIdx, { fitMeta: e.target.value })
                  }
                  placeholder="Số đo & Size đã mặc"
                  className="w-full rounded-lg border border-[#B08A4A]/35 bg-white px-2.5 py-1.5 font-mono text-[11px]"
                />
                <textarea
                  rows={2}
                  value={voice.quote}
                  onChange={(e) => updateVoice(vIdx, { quote: e.target.value })}
                  placeholder="Trích dẫn đánh giá"
                  className="w-full rounded-lg border border-[#B08A4A]/35 bg-white px-2.5 py-1.5 text-xs"
                />
              </div>
            ))}
          </div>
        </div>
      </section>
    </form>
  );
}
