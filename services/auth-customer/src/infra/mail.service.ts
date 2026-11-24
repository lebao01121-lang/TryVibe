import { Inject, Injectable } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { createLogger } from '@atelier/observability';
import { AUTH_CONFIG_TOKEN, type AuthCustomerConfig } from '../config/env';

@Injectable()
export class MailService {
  private readonly logger = createLogger('@atelier/auth-customer:mail');
  private readonly transporter: nodemailer.Transporter;

  constructor(@Inject(AUTH_CONFIG_TOKEN) private readonly config: AuthCustomerConfig) {
    this.transporter = nodemailer.createTransport({
      host: this.config.smtp.host,
      port: this.config.smtp.port,
      secure: false,
      ignoreTLS: true,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 8000,
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
      { to, smtpHost: this.config.smtp.host, smtpPort: this.config.smtp.port, purpose },
      'Sent 2FA Email OTP via SMTP',
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
