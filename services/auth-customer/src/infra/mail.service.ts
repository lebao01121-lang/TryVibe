import { Inject, Injectable } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { createLogger } from '@atelier/observability';
import { AUTH_CONFIG_TOKEN, type AuthCustomerConfig } from '../config/env';

function isLocalSmtpHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === 'mailpit'
  );
}

@Injectable()
export class MailService {
  private readonly logger = createLogger('@atelier/auth-customer:mail');
  private readonly transporter: nodemailer.Transporter;
  private readonly smtpAuthConfigured: boolean;

  constructor(@Inject(AUTH_CONFIG_TOKEN) private readonly config: AuthCustomerConfig) {
    const { host, port, secure, user, pass } = this.config.smtp;
    const hasAuth = Boolean(user && pass);
    const useLocalMailpitMode = !hasAuth && isLocalSmtpHost(host);
    this.smtpAuthConfigured = hasAuth;

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: useLocalMailpitMode ? false : secure,
      ...(useLocalMailpitMode ? { ignoreTLS: true } : { requireTLS: !secure }),
      ...(hasAuth ? { auth: { user, pass } } : {}),
      connectionTimeout: useLocalMailpitMode ? 5000 : 15000,
      greetingTimeout: useLocalMailpitMode ? 5000 : 15000,
      socketTimeout: useLocalMailpitMode ? 8000 : 15000,
    });
  }

  async sendEmailOtp(params: {
    to: string;
    fullName: string;
    otpCode: string;
    purpose: string;
  }): Promise<void> {
    const { to, fullName, otpCode, purpose } = params;
    const subject = `[Fashion Atelier] Mã xác thực 2FA: ${otpCode}`;
    const text = [
      `Xin chào ${fullName},`,
      '',
      `Mã xác thực OTP 6 chữ số của bạn (${purpose}) tại Fashion Atelier là: ${otpCode}`,
      '',
      'Mã OTP có hiệu lực trong vòng 5 phút (300 giây).',
      'Vui lòng không chia sẻ mã này với bất kỳ ai để đảm bảo an toàn tài khoản.',
      '',
      'Trân trọng,',
      'Fashion Atelier Security Team',
    ].join('\n');

    const html = [
      '<div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #e5e5e5;border-radius:8px;color:#171717">',
      '<p style="letter-spacing:0.18em;font-size:12px;text-transform:uppercase;color:#737373;margin:0 0 12px">Fashion Atelier · Bảo mật 2 lớp (2FA)</p>',
      `<h2 style="font-size:20px;font-weight:600;margin:0 0 12px">Xin chào ${escapeHtml(fullName)},</h2>`,
      `<p style="font-size:14px;line-height:1.6;margin:0 0 16px">Đây là mã xác thực 6 chữ số dành cho phiên đăng nhập (${escapeHtml(purpose)}) của bạn:</p>`,
      `<div style="font-size:32px;font-weight:700;letter-spacing:0.28em;text-align:center;padding:16px 20px;background:#faf8f5;border:1px solid #d6cfc7;border-radius:6px;margin:0 0 16px">${escapeHtml(otpCode)}</div>`,
      '<p style="font-size:13px;color:#525252;line-height:1.5;margin:0">Mã có hiệu lực trong <strong>5 phút</strong>. Nếu bạn không yêu cầu mã này, hãy đổi mật khẩu ngay lập tức.</p>',
      '</div>',
    ].join('');

    await this.transporter.sendMail({
      from: this.config.smtp.from,
      to,
      subject,
      text,
      html,
    });

    this.logger.info(
      {
        to,
        smtpHost: this.config.smtp.host,
        smtpPort: this.config.smtp.port,
        smtpSecure: this.config.smtp.secure,
        smtpAuthConfigured: this.smtpAuthConfigured,
        purpose,
      },
      'Sent 2FA Email OTP via SMTP',
    );
  }

  async sendPasswordResetEmail(params: {
    to: string;
    fullName: string;
    otpCode: string;
    resetLink: string;
    ttlMinutes: number;
  }): Promise<void> {
    const { to, fullName, otpCode, resetLink, ttlMinutes } = params;
    const subject = `[Tầm Xuân · Fashion Atelier] Mã khôi phục mật khẩu: ${otpCode}`;
    const text = [
      `Xin chào ${fullName},`,
      '',
      'Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản Fashion Atelier của bạn.',
      `Mã khôi phục 6 chữ số của bạn là: ${otpCode}`,
      '',
      `Hoặc mở trực tiếp liên kết đặt lại mật khẩu: ${resetLink}`,
      '',
      `Mã khôi phục có hiệu lực trong ${ttlMinutes} phút và chỉ sử dụng một lần.`,
      'Nếu bạn không thực hiện yêu cầu này, vui lòng bỏ qua email này.',
      '',
      'Trân trọng,',
      'Tầm Xuân · Fashion Atelier Security Team',
    ].join('\n');

    const html = [
      '<div style="font-family:Inter,Arial,sans-serif;max-width:540px;margin:0 auto;padding:28px;border:1px solid #d6c5a7;border-radius:12px;background:#fbf7ef;color:#1c1410">',
      '<p style="letter-spacing:0.18em;font-size:11px;text-transform:uppercase;color:#8a672c;margin:0 0 10px">Tầm Xuân · Fashion Atelier · Khôi phục mật khẩu</p>',
      `<h2 style="font-size:22px;font-weight:600;margin:0 0 12px;color:#1c1410">Xin chào ${escapeHtml(fullName)},</h2>`,
      '<p style="font-size:14px;line-height:1.65;margin:0 0 16px;color:#3d2f27">Sử dụng mã OTP 6 chữ số dưới đây tại trang <strong>/quen-mat-khau</strong> để đặt lại mật khẩu tài khoản của bạn:</p>',
      `<div style="font-size:34px;font-weight:700;letter-spacing:0.28em;text-align:center;padding:18px 20px;background:#ffffff;border:1px solid #b08a4a;border-radius:10px;color:#1c1410;margin:0 0 18px">${escapeHtml(otpCode)}</div>`,
      `<p style="text-align:center;margin:0 0 18px"><a href="${escapeHtml(resetLink)}" style="display:inline-block;padding:12px 24px;border-radius:999px;background:#1c1410;color:#ebcf8f;text-decoration:none;font-size:13px;font-weight:600;letter-spacing:0.08em">Mở trang Đặt lại mật khẩu</a></p>`,
      `<p style="font-size:13px;color:#6b5b4c;line-height:1.55;margin:0">Mã có hiệu lực trong <strong>${ttlMinutes} phút</strong> và chỉ dùng 1 lần. Khi đặt lại mật khẩu thành công, toàn bộ phiên đăng nhập cũ sẽ tự động đăng xuất.</p>`,
      '</div>',
    ].join('');

    await this.transporter.sendMail({
      from: this.config.smtp.from,
      to,
      subject,
      text,
      html,
    });

    this.logger.info(
      {
        to,
        smtpHost: this.config.smtp.host,
        smtpPort: this.config.smtp.port,
        smtpSecure: this.config.smtp.secure,
        smtpAuthConfigured: this.smtpAuthConfigured,
        ttlMinutes,
      },
      'Sent Password Reset HTML email via SMTP',
    );
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
