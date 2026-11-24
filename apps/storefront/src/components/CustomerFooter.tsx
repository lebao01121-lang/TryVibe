import Link from 'next/link';

export function CustomerFooter() {
  return (
    <footer className="border-t border-[#B08A4A]/25 bg-[#1C1410] text-[#FBF7EF]">
      <div className="mx-auto grid max-w-7xl gap-10 px-6 py-14 md:grid-cols-3 lg:px-10">
        <div>
          <p className="font-editorial text-2xl text-[#EBCF8F]">
            Tầm Xuân Fashion Atelier
          </p>
          <p className="mt-3 text-sm leading-relaxed text-[#FBF7EF]/75">
            Xưởng may đo thủ công tại Hà Nội. Tuyển chọn lụa tơ tằm Bảo Lộc,
            linen tự nhiên và dạ Merino trong phom dáng vượt thời gian.
          </p>
          <p className="mt-4 text-xs tracking-wider text-[#EBCF8F]/80">
            18 Hàng Trống, Hoàn Kiếm, Hà Nội · 09:00 – 21:00 hằng ngày
          </p>
        </div>

        <div>
          <p className="atelier-eyebrow text-[#EBCF8F]">Khám phá Atelier</p>
          <ul className="mt-4 space-y-2.5 text-sm text-[#FBF7EF]/80">
            <li>
              <Link href="/bo-suu-tap" className="hover:text-[#EBCF8F]">
                Bộ sưu tập &amp; Dress Code
              </Link>
            </li>
            <li>
              <Link href="/phoi-do" className="hover:text-[#EBCF8F]">
                Mix &amp; Match Outfit Studio
              </Link>
            </li>
            <li>
              <Link href="/thu-do-ai" className="hover:text-[#EBCF8F]">
                Phòng Thử Đồ AI Riêng Tư
              </Link>
            </li>
            <li>
              <Link href="/thanh-toan" className="hover:text-[#EBCF8F]">
                Thanh toán &amp; Gói quà thủ công
              </Link>
            </li>
          </ul>
        </div>

        <div>
          <p className="atelier-eyebrow text-[#EBCF8F]">Chăm sóc khách hàng</p>
          <ul className="mt-4 space-y-2.5 text-sm text-[#FBF7EF]/80">
            <li>
              <Link href="/tai-khoan" className="hover:text-[#EBCF8F]">
                Hồ sơ số đo &amp; Bảng thông số
              </Link>
            </li>
            <li>Đổi size miễn phí tận nhà trong 14 ngày</li>
            <li>Giao hỏa tốc 2 giờ tại nội thành Hà Nội &amp; TP.HCM</li>
            <li>Ảnh thử đồ AI tự động hủy sau 15 phút bảo mật</li>
          </ul>
        </div>
      </div>

      <div className="border-t border-[#B08A4A]/15 px-6 py-5 text-center text-xs tracking-widest text-[#FBF7EF]/55">
        © 2026 Tầm Xuân Fashion Atelier · Bản quyền trải nghiệm khách hàng
      </div>
    </footer>
  );
}
