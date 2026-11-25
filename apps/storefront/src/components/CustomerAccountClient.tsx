'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import {
  FitPreference,
  OrderStatus,
  type CustomerAddressDto,
  type CustomerBodyProfileDto,
  type OrderDTO,
  type SavedOutfitDto,
  type TryOnQuotaDto,
  type UserSummaryDto,
} from '@atelier/contracts';
import {
  apiFetch,
  clearStoredSession,
  getStoredSession,
  setStoredSession,
} from '@/lib/api-client';
import { FORMAT_VND } from '@/lib/catalog-data';
import {
  VN_PROVINCES,
  getDefaultDivisionSelection,
  getDistrictsByProvinceCode,
  getWardsByDistrictCode,
  selectDistrictCascade,
  selectProvinceCascade,
  selectWardCascade,
  type VnDivisionSelection,
} from '@/lib/vn-admin-divisions';

type AccountTab = 'profile' | 'orders' | 'outfits';

interface ChangePasswordResponse {
  accessToken?: string;
  csrfToken?: string;
  user?: UserSummaryDto;
  message?: string;
  changed?: boolean;
}

const ORDER_STATUS_BADGE: Record<OrderStatus, string> = {
  [OrderStatus.PENDING_RESERVATION]: 'Đang giữ kho',
  [OrderStatus.FAILED_OUT_OF_STOCK]: 'Hết hàng',
  [OrderStatus.AWAITING_PAYMENT]: 'Chờ thanh toán',
  [OrderStatus.CONFIRMED]: 'Đã xác nhận',
  [OrderStatus.PACKING]: 'Đang đóng gói',
  [OrderStatus.SHIPPED]: 'Đang giao vận',
  [OrderStatus.DELIVERED]: 'Đã giao',
  [OrderStatus.COMPLETED]: 'Hoàn tất',
  [OrderStatus.CANCELLED]: 'Đã hủy',
  [OrderStatus.LATE_PAYMENT_NEEDS_REFUND]: 'Chờ hoàn tiền trễ',
};

export function CustomerAccountClient() {
  const [activeTab, setActiveTab] = useState<AccountTab>('profile');
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<UserSummaryDto | null>(null);
  const [quota, setQuota] = useState<TryOnQuotaDto | null>(null);
  const [addresses, setAddresses] = useState<CustomerAddressDto[]>([]);
  const [orders, setOrders] = useState<OrderDTO[]>([]);
  const [savedOutfits, setSavedOutfits] = useState<SavedOutfitDto[]>([]);
  const [copiedOutfitCode, setCopiedOutfitCode] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Body Profile form state
  const [heightCm, setHeightCm] = useState('165');
  const [weightKg, setWeightKg] = useState('54');
  const [bustCm, setBustCm] = useState('');
  const [waistCm, setWaistCm] = useState('');
  const [hipCm, setHipCm] = useState('');
  const [shoulderCm, setShoulderCm] = useState('');
  const [fitPreference, setFitPreference] = useState<FitPreference>(
    FitPreference.REGULAR,
  );
  const [savingProfile, setSavingProfile] = useState(false);

  // New Address form state (cascading official Vietnamese administrative divisions)
  const [recipientName, setRecipientName] = useState('');
  const [phone, setPhone] = useState('');
  const [division, setDivision] = useState<VnDivisionSelection>(() =>
    getDefaultDivisionSelection(),
  );
  const [streetLine, setStreetLine] = useState('');
  const [isDefault, setIsDefault] = useState(true);

  // Change Password form state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const availableDistricts = getDistrictsByProvinceCode(division.provinceCode);
  const availableWards = getWardsByDistrictCode(
    division.provinceCode,
    division.districtCode,
  );

  const loadAccountData = async () => {
    setLoading(true);
    const session = getStoredSession();
    if (!session?.accessToken) {
      setUser(null);
      setLoading(false);
      return;
    }

    const [meRes, profileRes, addrRes, quotaRes, ordersRes, outfitsRes] =
      await Promise.all([
        apiFetch<UserSummaryDto>('/bff/v1/auth/me'),
        apiFetch<CustomerBodyProfileDto>('/bff/v1/customers/me/body-profile'),
        apiFetch<CustomerAddressDto[]>('/bff/v1/customers/me/addresses'),
        apiFetch<TryOnQuotaDto>('/bff/v1/customers/me/tryon-quota'),
        apiFetch<OrderDTO[]>('/bff/v1/storefront/orders/me'),
        apiFetch<SavedOutfitDto[]>('/bff/v1/storefront/outfits/me'),
      ]);

    if (meRes.ok && meRes.data) {
      setUser(meRes.data);
      const current = getStoredSession();
      if (current) {
        setStoredSession({ ...current, user: meRes.data });
      }
    } else if (session.user) {
      setUser(session.user);
    } else {
      setUser(null);
    }

    if (profileRes.ok && profileRes.data) {
      setHeightCm(String(profileRes.data.heightCm));
      setWeightKg(String(profileRes.data.weightKg));
      setBustCm(profileRes.data.bustCm != null ? String(profileRes.data.bustCm) : '');
      setWaistCm(profileRes.data.waistCm != null ? String(profileRes.data.waistCm) : '');
      setHipCm(profileRes.data.hipCm != null ? String(profileRes.data.hipCm) : '');
      setShoulderCm(
        profileRes.data.shoulderCm != null ? String(profileRes.data.shoulderCm) : '',
      );
      setFitPreference(profileRes.data.fitPreference);
    }

    if (addrRes.ok && Array.isArray(addrRes.data)) {
      setAddresses(addrRes.data);
    }
    if (quotaRes.ok && quotaRes.data) {
      setQuota(quotaRes.data);
    }
    if (ordersRes.ok && Array.isArray(ordersRes.data)) {
      setOrders(ordersRes.data);
    }
    if (outfitsRes.ok && Array.isArray(outfitsRes.data)) {
      setSavedOutfits(outfitsRes.data);
    }

    setLoading(false);
  };

  useEffect(() => {
    void loadAccountData();
  }, []);

  const handleSaveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSavingProfile(true);
    setStatusMessage(null);

    const res = await apiFetch<CustomerBodyProfileDto>(
      '/bff/v1/customers/me/body-profile',
      {
        method: 'PUT',
        body: JSON.stringify({
          heightCm: Number(heightCm),
          weightKg: Number(weightKg),
          bustCm: bustCm ? Number(bustCm) : null,
          waistCm: waistCm ? Number(waistCm) : null,
          hipCm: hipCm ? Number(hipCm) : null,
          shoulderCm: shoulderCm ? Number(shoulderCm) : null,
          fitPreference,
        }),
      },
    );

    if (res.ok) {
      setStatusMessage('Đã lưu hồ sơ số đo vào hệ thống thành công.');
    } else {
      setStatusMessage(res.error?.message || 'Lưu hồ sơ số đo thất bại.');
    }
    setSavingProfile(false);
  };

  const handleAddAddress = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatusMessage(null);

    const res = await apiFetch<CustomerAddressDto>(
      '/bff/v1/customers/me/addresses',
      {
        method: 'POST',
        body: JSON.stringify({
          recipientName: recipientName.trim(),
          phone: phone.trim(),
          provinceCode: division.provinceCode,
          provinceName: division.provinceName,
          districtCode: division.districtCode,
          districtName: division.districtName,
          wardCode: division.wardCode,
          wardName: division.wardName,
          streetLine: streetLine.trim(),
          isDefault,
        }),
      },
    );

    if (res.ok) {
      setRecipientName('');
      setPhone('');
      setStreetLine('');
      setStatusMessage('Đã thêm địa chỉ giao hàng mới.');
      await loadAccountData();
    } else {
      setStatusMessage(res.error?.message || 'Không thể thêm địa chỉ mới.');
    }
  };

  const handleChangePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPasswordSuccess(null);
    setPasswordError(null);

    if (!currentPassword) {
      setPasswordError('Vui lòng nhập mật khẩu hiện tại.');
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError('Mật khẩu mới cần có tối thiểu 8 ký tự.');
      return;
    }
    if (newPassword === currentPassword) {
      setPasswordError('Mật khẩu mới phải khác mật khẩu hiện tại.');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setPasswordError('Xác nhận mật khẩu mới không khớp.');
      return;
    }

    setChangingPassword(true);
    const res = await apiFetch<ChangePasswordResponse>(
      '/bff/v1/auth/change-password',
      {
        method: 'POST',
        body: JSON.stringify({
          currentPassword,
          newPassword,
        }),
      },
    );
    setChangingPassword(false);

    if (!res.ok) {
      setPasswordError(
        res.error?.message ||
          'Đổi mật khẩu thất bại. Vui lòng kiểm tra lại mật khẩu hiện tại.',
      );
      return;
    }

    if (res.data?.accessToken) {
      const current = getStoredSession();
      setStoredSession({
        accessToken: res.data.accessToken,
        csrfToken: res.data.csrfToken || current?.csrfToken || '',
        user: res.data.user ?? current?.user ?? user,
      });
    }

    setCurrentPassword('');
    setNewPassword('');
    setConfirmNewPassword('');
    setPasswordSuccess(
      res.data?.message ||
        'Đổi mật khẩu thành công. Phiên bảo mật tài khoản của bạn đã được làm mới.',
    );
  };

  const handleSetDefaultAddress = async (id: string) => {
    const res = await apiFetch<CustomerAddressDto>(
      `/bff/v1/customers/me/addresses/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ isDefault: true }),
      },
    );
    if (res.ok) {
      setStatusMessage('Đã cập nhật địa chỉ giao hàng mặc định.');
      await loadAccountData();
    }
  };

  const handleDeleteAddress = async (id: string) => {
    const res = await apiFetch<unknown>(
      `/bff/v1/customers/me/addresses/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    if (res.ok) {
      setStatusMessage('Đã xóa địa chỉ.');
      await loadAccountData();
    }
  };

  const handleLogout = async () => {
    await apiFetch('/bff/v1/auth/logout', {
      method: 'POST',
      skipAuthRefresh: true,
    });
    clearStoredSession();
    setUser(null);
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl px-6 py-16 text-sm text-[#7A6A5B]">
        Đang tải thông tin tài khoản...
      </div>
    );
  }

  if (!user) {
    return (
      <div className="mx-auto max-w-xl px-6 py-20 text-center">
        <div className="rounded-3xl border border-[#B08A4A]/30 bg-[#FBF7EF] p-10">
          <p className="atelier-eyebrow text-[#8A672C]">Không gian cá nhân</p>
          <h1 className="font-editorial mt-2 text-4xl font-light text-[#1C1410]">
            Đăng nhập để quản lý Hồ sơ &amp; Đơn hàng
          </h1>
          <p className="mt-3 text-sm text-[#7A6A5B]">
            Cập nhật chiều cao, cân nặng, theo dõi hành trình đơn hàng, đổi size
            1 chạm và truy cập tủ đồ Outfit đã lưu của riêng bạn.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Link
              href="/dang-nhap"
              className="rounded-full bg-[#1C1410] px-7 py-3 text-xs uppercase tracking-[0.18em] text-[#EBCF8F]"
            >
              Đăng nhập
            </Link>
            <Link
              href="/dang-ky"
              className="rounded-full border border-[#8A672C] px-7 py-3 text-xs uppercase tracking-[0.18em] text-[#8A672C]"
            >
              Đăng ký mới
            </Link>
          </div>
          <div className="mt-5">
            <Link
              href="/quen-mat-khau"
              data-testid="account-forgot-password-link"
              className="text-xs font-medium text-[#8A672C] underline underline-offset-4 transition-colors hover:text-[#1C1410]"
            >
              Quên mật khẩu?
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-6 py-12 lg:px-10">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#B08A4A]/25 pb-7">
        <div>
          <p className="atelier-eyebrow text-[#8A672C]">
            Thành viên {user.loyaltyTier}
          </p>
          <h1 className="font-editorial mt-1 text-5xl font-light text-[#1C1410]">
            Xin chào, {user.fullName}
          </h1>
          <p className="mt-1 text-xs text-[#7A6A5B]">{user.email}</p>
        </div>

        <button
          type="button"
          onClick={handleLogout}
          className="rounded-full border border-[#8A672C] px-5 py-2 text-xs uppercase tracking-[0.16em] text-[#8A672C] hover:bg-[#1C1410] hover:text-[#EBCF8F]"
        >
          Đăng xuất
        </button>
      </div>

      {statusMessage ? (
        <div
          role="status"
          className="mt-6 rounded-2xl border border-[#B08A4A]/35 bg-[#F4EBDA] px-5 py-3 text-xs text-[#1C1410]"
        >
          {statusMessage}
        </div>
      ) : null}

      {/* Loyalty VIP Tier & Daily AI Try-On Quota */}
      <div className="mt-8 grid gap-5 sm:grid-cols-3">
        <div className="rounded-3xl border border-[#B08A4A]/25 bg-[#1C1410] p-6 text-[#FBF7EF]">
          <p className="atelier-eyebrow text-[#EBCF8F]">Hạng thành viên VIP</p>
          <p className="font-editorial mt-2 text-4xl text-[#EBCF8F]">
            {quota?.loyaltyTier ?? user.loyaltyTier}
          </p>
          <p className="mt-1 text-xs text-[#FBF7EF]/70">
            Ưu tiên nâng hạn mức thử đồ AI và đổi size tận nhà
          </p>
        </div>

        <div className="rounded-3xl border border-[#B08A4A]/25 bg-[#FBF7EF] p-6">
          <p className="atelier-eyebrow text-[#8A672C]">Hạn mức Thử đồ AI hôm nay</p>
          <p className="font-editorial mt-2 text-4xl text-[#1C1410]">
            {quota ? `${quota.remainingToday} / ${quota.dailyLimit}` : '—'}
          </p>
          <p className="mt-1 text-xs text-[#7A6A5B]">
            {quota
              ? `Đã dùng ${quota.usedToday} lượt hôm nay`
              : 'Đang đồng bộ hạn mức từ dịch vụ tài khoản'}
          </p>
        </div>

        <div className="rounded-3xl border border-[#B08A4A]/25 bg-[#F4EBDA]/60 p-6">
          <p className="atelier-eyebrow text-[#8A672C]">Thao tác nhanh</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href="/bo-suu-tap"
              className="rounded-full bg-[#1C1410] px-4 py-2 text-[11px] uppercase tracking-[0.14em] text-[#EBCF8F]"
            >
              Lọc theo Size của tôi
            </Link>
            <Link
              href="/thu-do-ai"
              className="rounded-full border border-[#8A672C] px-4 py-2 text-[11px] uppercase tracking-[0.14em] text-[#8A672C]"
            >
              Phòng thử AI
            </Link>
          </div>
        </div>
      </div>

      {/* Editorial Account Tabs */}
      <div
        className="mt-9 flex flex-wrap gap-2 border-b border-[#B08A4A]/25 pb-4"
        role="tablist"
        aria-label="Danh mục tài khoản"
      >
        {[
          { key: 'profile' as const, label: 'Hồ sơ & Số đo' },
          {
            key: 'orders' as const,
            label: `Đơn hàng & Đổi size (${orders.length})`,
          },
          {
            key: 'outfits' as const,
            label: `Tủ đồ Outfit đã lưu (${savedOutfits.length})`,
          },
        ].map((tab) => {
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(tab.key)}
              className={`rounded-full px-5 py-2.5 text-xs uppercase tracking-[0.16em] transition-colors ${
                active
                  ? 'bg-[#1C1410] font-medium text-[#EBCF8F]'
                  : 'border border-[#B08A4A]/35 bg-white text-[#5C4B41] hover:border-[#8A672C]'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* TAB 1: PROFILE, BODY MEASUREMENTS & ADDRESS BOOK */}
      {activeTab === 'profile' ? (
        <div className="mt-8 grid gap-8 lg:grid-cols-2">
          {/* Body Profile Form */}
          <section className="rounded-3xl border border-[#B08A4A]/25 bg-white p-6">
            <p className="atelier-eyebrow text-[#8A672C]">
              Hồ sơ số đo (CustomerBodyProfile)
            </p>
            <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Cập nhật số đo chuẩn xác
            </h2>
            <form onSubmit={handleSaveProfile} className="mt-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs">
                  <span className="text-[#5C4B41]">Chiều cao (cm)</span>
                  <input
                    type="number"
                    required
                    min={120}
                    max={230}
                    value={heightCm}
                    onChange={(e) => setHeightCm(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2 font-mono text-sm"
                  />
                </label>
                <label className="text-xs">
                  <span className="text-[#5C4B41]">Cân nặng (kg)</span>
                  <input
                    type="number"
                    required
                    min={25}
                    max={200}
                    value={weightKg}
                    onChange={(e) => setWeightKg(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2 font-mono text-sm"
                  />
                </label>
                <label className="text-xs">
                  <span className="text-[#5C4B41]">Ngực (cm)</span>
                  <input
                    type="number"
                    value={bustCm}
                    onChange={(e) => setBustCm(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2 font-mono text-sm"
                  />
                </label>
                <label className="text-xs">
                  <span className="text-[#5C4B41]">Eo (cm)</span>
                  <input
                    type="number"
                    value={waistCm}
                    onChange={(e) => setWaistCm(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2 font-mono text-sm"
                  />
                </label>
                <label className="text-xs">
                  <span className="text-[#5C4B41]">Mông (cm)</span>
                  <input
                    type="number"
                    value={hipCm}
                    onChange={(e) => setHipCm(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2 font-mono text-sm"
                  />
                </label>
                <label className="text-xs">
                  <span className="text-[#5C4B41]">Vai (cm)</span>
                  <input
                    type="number"
                    value={shoulderCm}
                    onChange={(e) => setShoulderCm(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2 font-mono text-sm"
                  />
                </label>
              </div>

              <label className="block text-xs">
                <span className="text-[#5C4B41]">Phong cách mặc ưu tiên</span>
                <select
                  value={fitPreference}
                  onChange={(e) =>
                    setFitPreference(e.target.value as FitPreference)
                  }
                  className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 text-sm"
                >
                  <option value={FitPreference.SLIM}>Ôm vừa (SLIM)</option>
                  <option value={FitPreference.REGULAR}>Tiêu chuẩn (REGULAR)</option>
                  <option value={FitPreference.RELAXED}>Thoải mái (RELAXED)</option>
                </select>
              </label>

              <button
                type="submit"
                disabled={savingProfile}
                className="rounded-full bg-[#1C1410] px-6 py-2.5 text-xs uppercase tracking-[0.18em] text-[#EBCF8F]"
              >
                {savingProfile ? 'Đang lưu...' : 'Lưu hồ sơ số đo'}
              </button>
            </form>
          </section>

          {/* Address Book CRUD */}
          <section className="rounded-3xl border border-[#B08A4A]/25 bg-white p-6">
            <p className="atelier-eyebrow text-[#8A672C]">
              Sổ địa chỉ giao nhận (CustomerAddress)
            </p>
            <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Địa chỉ đã lưu ({addresses.length})
            </h2>

            <div className="mt-4 space-y-3">
              {addresses.map((addr) => (
                <div
                  key={addr.id}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-[#B08A4A]/25 bg-[#FBF7EF] p-4 text-xs"
                >
                  <div>
                    <p className="font-medium text-[#1C1410]">
                      {addr.recipientName} · {addr.phone}
                      {addr.isDefault ? (
                        <span className="ml-2 rounded-full bg-[#1C1410] px-2.5 py-0.5 text-[10px] text-[#EBCF8F]">
                          Mặc định
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-1 text-[#7A6A5B]">
                      {addr.streetLine}, {addr.wardName}, {addr.districtName},{' '}
                      {addr.provinceName}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {!addr.isDefault ? (
                      <button
                        type="button"
                        onClick={() => handleSetDefaultAddress(addr.id)}
                        className="text-[#8A672C] underline underline-offset-2"
                      >
                        Đặt mặc định
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => handleDeleteAddress(addr.id)}
                      className="text-[#8B2E2E] underline underline-offset-2"
                    >
                      Xóa
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <form
              onSubmit={handleAddAddress}
              className="mt-6 space-y-3 border-t border-[#B08A4A]/20 pt-5"
            >
              <p className="text-xs font-medium uppercase tracking-[0.16em] text-[#8A672C]">
                Thêm địa chỉ mới
              </p>
              <div className="grid gap-2.5 sm:grid-cols-2">
                <input
                  type="text"
                  required
                  placeholder="Tên người nhận"
                  value={recipientName}
                  onChange={(e) => setRecipientName(e.target.value)}
                  className="rounded-xl border border-[#B08A4A]/35 px-3 py-2 text-xs"
                />
                <input
                  type="tel"
                  required
                  placeholder="Số điện thoại"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="rounded-xl border border-[#B08A4A]/35 px-3 py-2 text-xs"
                />
                <label className="text-[11px] text-[#5C4B41]">
                  <span>Tỉnh / Thành phố</span>
                  <select
                    required
                    value={division.provinceCode}
                    onChange={(e) => setDivision(selectProvinceCascade(e.target.value))}
                    data-testid="account-province-select"
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 text-xs text-[#1C1410]"
                  >
                    {VN_PROVINCES.map((p) => (
                      <option key={p.code} value={p.code}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-[11px] text-[#5C4B41]">
                  <span>Quận / Huyện</span>
                  <select
                    required
                    value={division.districtCode}
                    onChange={(e) =>
                      setDivision(
                        selectDistrictCascade(division.provinceCode, e.target.value),
                      )
                    }
                    data-testid="account-district-select"
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 text-xs text-[#1C1410]"
                  >
                    {availableDistricts.map((d) => (
                      <option key={d.code} value={d.code}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-[11px] text-[#5C4B41]">
                  <span>Phường / Xã</span>
                  <select
                    required
                    value={division.wardCode}
                    onChange={(e) =>
                      setDivision(
                        selectWardCascade(
                          division.provinceCode,
                          division.districtCode,
                          e.target.value,
                        ),
                      )
                    }
                    data-testid="account-ward-select"
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 text-xs text-[#1C1410]"
                  >
                    {availableWards.map((w) => (
                      <option key={w.code} value={w.code}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-[11px] text-[#5C4B41]">
                  <span>Số nhà, tên đường</span>
                  <input
                    type="text"
                    required
                    placeholder="Số nhà, tên đường"
                    value={streetLine}
                    onChange={(e) => setStreetLine(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 px-3 py-2 text-xs text-[#1C1410]"
                  />
                </label>
              </div>

              <label className="flex items-center gap-2 text-xs text-[#5C4B41]">
                <input
                  type="checkbox"
                  checked={isDefault}
                  onChange={(e) => setIsDefault(e.target.checked)}
                  className="accent-[#B08A4A]"
                />
                Đặt làm địa chỉ giao hàng mặc định
              </label>

              <button
                type="submit"
                className="rounded-full border border-[#1C1410] px-5 py-2 text-xs uppercase tracking-[0.16em] text-[#1C1410] hover:bg-[#1C1410] hover:text-[#EBCF8F]"
              >
                Thêm địa chỉ
              </button>
            </form>
          </section>

          {/* Change Password Security Section */}
          <section
            data-testid="change-password-section"
            className="rounded-3xl border border-[#B08A4A]/25 bg-white p-6 lg:col-span-2"
          >
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="atelier-eyebrow text-[#8A672C]">Bảo mật tài khoản</p>
                <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
                  Đổi mật khẩu
                </h2>
                <p className="mt-1 text-xs text-[#7A6A5B]">
                  Cập nhật mật khẩu định kỳ để bảo vệ hồ sơ số đo, sổ địa chỉ và lịch sử đơn hàng của bạn.
                </p>
              </div>
              <Link
                href="/quen-mat-khau"
                className="text-xs font-medium text-[#8A672C] underline underline-offset-4 hover:text-[#1C1410]"
              >
                Quên mật khẩu hiện tại? Khôi phục qua email
              </Link>
            </div>

            <form
              onSubmit={handleChangePassword}
              className="mt-5 grid gap-4 md:grid-cols-3"
            >
              <label className="text-xs">
                <span className="text-[#5C4B41]">Mật khẩu hiện tại *</span>
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="••••••••"
                  data-testid="change-password-current-input"
                  className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF]/50 px-3.5 py-2.5 text-sm text-[#1C1410] outline-none focus:border-[#8A672C]"
                />
              </label>

              <label className="text-xs">
                <span className="text-[#5C4B41]">Mật khẩu mới (tối thiểu 8 ký tự) *</span>
                <input
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="••••••••"
                  data-testid="change-password-new-input"
                  className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF]/50 px-3.5 py-2.5 text-sm text-[#1C1410] outline-none focus:border-[#8A672C]"
                />
              </label>

              <label className="text-xs">
                <span className="text-[#5C4B41]">Xác nhận mật khẩu mới *</span>
                <input
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={confirmNewPassword}
                  onChange={(e) => setConfirmNewPassword(e.target.value)}
                  placeholder="••••••••"
                  data-testid="change-password-confirm-input"
                  className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF]/50 px-3.5 py-2.5 text-sm text-[#1C1410] outline-none focus:border-[#8A672C]"
                />
              </label>

              <div className="space-y-3 md:col-span-3">
                {passwordSuccess ? (
                  <p
                    role="status"
                    data-testid="change-password-success"
                    className="rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-xs text-emerald-950"
                  >
                    {passwordSuccess}
                  </p>
                ) : null}

                {passwordError ? (
                  <p
                    role="alert"
                    data-testid="change-password-error"
                    className="rounded-xl border border-[#8B2E2E]/35 bg-[#FFF5F4] px-4 py-2.5 text-xs text-[#8B2E2E]"
                  >
                    {passwordError}
                  </p>
                ) : null}

                <button
                  type="submit"
                  disabled={changingPassword}
                  data-testid="change-password-submit-btn"
                  className="rounded-full bg-[#1C1410] px-6 py-2.5 text-xs uppercase tracking-[0.18em] text-[#EBCF8F] transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {changingPassword ? 'Đang cập nhật mật khẩu...' : 'Cập nhật mật khẩu'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {/* TAB 2: ĐƠN HÀNG & ĐỔI SIZE */}
      {activeTab === 'orders' ? (
        <section className="mt-8 space-y-4">
          {orders.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-[#B08A4A]/40 bg-white/75 p-12 text-center">
              <p className="font-editorial text-3xl text-[#1C1410]">
                Bạn chưa có đơn hàng nào tại TryVibe
              </p>
              <p className="mt-2 text-xs text-[#7A6A5B]">
                Khám phá bộ sưu tập mới nhất và nhận ưu đãi Combo khi phối trọn bộ.
              </p>
              <Link href="/bo-suu-tap" className="btn btn--gold mt-6 !py-3">
                Khám phá Bộ sưu tập
              </Link>
            </div>
          ) : (
            <div className="space-y-4">
              {orders.map((order) => (
                <article
                  key={order.id}
                  className="flex flex-wrap items-center justify-between gap-4 rounded-3xl border border-[#B08A4A]/28 bg-white p-5 shadow-sm"
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/don-hang/${encodeURIComponent(order.orderCode)}`}
                        className="font-mono text-sm font-semibold text-[#1C1410] hover:text-[#8A672C]"
                      >
                        #{order.orderCode}
                      </Link>
                      <span className="rounded-full bg-[#1C1410] px-3 py-0.5 text-[10px] uppercase tracking-[0.14em] text-[#EBCF8F]">
                        {ORDER_STATUS_BADGE[order.status] ?? order.status}
                      </span>
                      {order.shipment?.packPhotoUrl ? (
                        <span className="rounded-full border border-[#B08A4A]/45 bg-[#F4EBDA] px-2.5 py-0.5 text-[10px] text-[#8A672C]">
                          Có ảnh hộp quà
                        </span>
                      ) : null}
                    </div>
                    <p className="text-xs text-[#6B5B4C]">
                      {new Date(order.createdAt).toLocaleString('vi-VN')} ·{' '}
                      {order.items.length} thiết kế · {order.paymentMethod} ·{' '}
                      {order.shippingMethod}
                    </p>
                    <p className="font-editorial text-lg text-[#2B2019]">
                      {order.items
                        .slice(0, 2)
                        .map((i) => `${i.productName} (${i.sizeCode})`)
                        .join(' · ')}
                      {order.items.length > 2 ? ` +${order.items.length - 2} mẫu khác` : ''}
                    </p>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <p className="text-[10px] uppercase tracking-[0.18em] text-[#7A6A5B]">
                        Tổng đơn
                      </p>
                      <p className="font-editorial text-2xl text-[#1C1410]">
                        {FORMAT_VND(order.totalAmountVnd)}
                      </p>
                    </div>
                    <Link
                      href={`/don-hang/${encodeURIComponent(order.orderCode)}`}
                      className="rounded-full border border-[#1C1410] px-4 py-2 text-xs uppercase tracking-[0.14em] text-[#1C1410] transition-colors hover:bg-[#1C1410] hover:text-[#EBCF8F]"
                    >
                      {order.status === OrderStatus.DELIVERED
                        ? 'Đổi size / Đánh giá →'
                        : 'Theo dõi đơn →'}
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {/* TAB 3: TỦ ĐỒ OUTFIT ĐÃ LƯU */}
      {activeTab === 'outfits' ? (
        <section className="mt-8">
          {savedOutfits.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-[#B08A4A]/40 bg-white/75 p-12 text-center">
              <p className="font-editorial text-3xl text-[#1C1410]">
                Chưa có bộ phối nào trong Tủ đồ Outfit
              </p>
              <p className="mt-2 text-xs text-[#7A6A5B]">
                Tạo bộ phối 7 tầng tại Outfit Studio và nhấn “Lưu &amp; Chia sẻ Set đồ”
                để lưu vào không gian riêng của bạn.
              </p>
              <Link href="/phoi-do" className="btn btn--gold mt-6 !py-3">
                Mở Outfit Studio
              </Link>
            </div>
          ) : (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {savedOutfits.map((outfit) => (
                <article
                  key={outfit.id}
                  className="flex flex-col justify-between rounded-3xl border border-[#B08A4A]/30 bg-white p-5 shadow-sm"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[11px] text-[#8A672C]">
                        #{outfit.shareCode}
                      </span>
                      <span className="text-[11px] text-[#7A6A5B]">
                        {outfit.slots.length} tầng phối
                      </span>
                    </div>
                    <h3 className="mt-1.5 font-editorial text-2xl leading-snug text-[#1C1410]">
                      {outfit.title}
                    </h3>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {outfit.slots.map((slot, idx) => (
                        <span
                          key={`${outfit.id}-${slot.skuId}-${idx}`}
                          className="rounded-full border border-[#B08A4A]/35 bg-[#FBF7EF] px-2.5 py-0.5 text-[10px] text-[#5C431C]"
                        >
                          {slot.slot} · {slot.productName || slot.sizeCode || 'Atelier'}
                        </span>
                      ))}
                    </div>
                    {outfit.giftNote ? (
                      <p className="mt-3 font-script text-lg text-[#5C4B41]">
                        “{outfit.giftNote}”
                      </p>
                    ) : null}
                  </div>

                  <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-[#B08A4A]/20 pt-3.5">
                    <Link
                      href={`/phoi-do?share=${encodeURIComponent(outfit.shareCode)}`}
                      className="rounded-full bg-[#1C1410] px-4 py-2 text-[11px] uppercase tracking-[0.14em] text-[#EBCF8F]"
                    >
                      Mở trong Studio →
                    </Link>
                    <button
                      type="button"
                      onClick={async () => {
                        const url = `${window.location.origin}/phoi-do?share=${encodeURIComponent(outfit.shareCode)}`;
                        try {
                          await navigator.clipboard.writeText(url);
                          setCopiedOutfitCode(outfit.shareCode);
                        } catch {
                          // ignore clipboard error
                        }
                      }}
                      className="text-xs text-[#8A672C] underline underline-offset-2"
                    >
                      {copiedOutfitCode === outfit.shareCode ? 'Đã sao chép' : 'Chép link'}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
