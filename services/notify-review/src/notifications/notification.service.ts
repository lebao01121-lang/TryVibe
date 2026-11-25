import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { NotificationChannel } from '@atelier/contracts';
import { createLogger } from '@atelier/observability';
import {
  NOTIFY_CONFIG_TOKEN,
  SERVICE_NAME,
  type NotifyReviewConfig,
} from '../config/env';
import { NotifyDbService } from '../db/notify-db.service';
import { NotifyDlqService } from './notify-dlq.service';
import {
  ZaloZnsClient,
  type ZaloZnsDeliveryMode,
  type ZaloZnsDeliveryStatus,
} from './zalo-zns.client';

export interface OrderConfirmedNotifyInput {
  eventId?: string;
  orderCode: string;
  customerEmail: string;
  customerPhone?: string;
  customerName?: string;
  grandTotalVnd?: number;
  trackingCode?: string;
  shippingMethod?: string;
  paymentMethod?: string;
  simulateZnsFailure?: boolean;
  items?: Array<{
    productName?: string;
    skuCode?: string;
    sizeCode?: string;
    colorName?: string;
    qty?: number;
    unitPriceVnd?: number;
  }>;
}

export interface OrderPackedNotifyInput {
  eventId?: string;
  orderCode: string;
  customerEmail: string;
  customerPhone?: string;
  customerName?: string;
  packPhotoUrl: string;
  trackingCode?: string;
  simulateZnsFailure?: boolean;
}

export interface PoSubmittedNotifyInput {
  eventId?: string;
  poNumber: string;
  supplierEmail: string;
  supplierName?: string;
  supplierPhone?: string;
  expectedDeliveryDate?: string;
  totalAmountVnd?: number;
  notes?: string;
  simulateZnsFailure?: boolean;
  items?: Array<{
    skuCode?: string;
    skuId?: string;
    orderedQty?: number;
    unitCostVnd?: number;
  }>;
}

export interface RmaRejectedNotifyInput {
  eventId?: string;
  rmaId: string;
  rmaCode: string;
  orderCode: string;
  customerEmail: string;
  customerPhone?: string;
  customerName?: string;
  reason: string;
  rejectedBy?: string;
  simulateZnsFailure?: boolean;
}

export interface DirectZnsNotifyInput {
  eventId?: string;
  phone: string;
  templateCode: string;
  subject?: string;
  templateData: Record<string, string | number | boolean | null | undefined>;
  simulateZnsFailure?: boolean;
}

export interface SendSmtpAndLogParams {
  eventId: string;
  recipient: string;
  subject: string;
  html: string;
  text: string;
  templateCode: string;
  payload: Record<string, unknown>;
  znsPhone?: string;
  znsTemplateData?: Record<string, string | number | boolean | null | undefined>;
  simulateZnsFailure?: boolean;
  correlationId: string;
  traceparent?: string;
}

export interface NotificationDispatchResult {
  eventId: string;
  templateCode: string;
  recipient: string;
  subject: string;
  emailStatus: 'SENT' | 'DEDUPLICATED' | 'FAILED' | 'SKIPPED';
  emailLogId: string | null;
  znsStatus: ZaloZnsDeliveryStatus | 'DEDUPLICATED' | 'SKIPPED';
  znsLogId: string | null;
  znsDeliveryMode: ZaloZnsDeliveryMode | null;
  znsProviderMessageId: string | null;
  znsErrorCode: string | null;
  znsErrorMessage: string | null;
  znsRetryCount: number;
  znsDeadLettered: boolean;
  deduplicated: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatVnd(amount: number | undefined): string {
  const safe = typeof amount === 'number' && Number.isFinite(amount) ? Math.round(amount) : 0;
  return `${safe.toLocaleString('vi-VN')} ₫`;
}

function renderAtelierEmailShell(params: {
  eyebrow: string;
  title: string;
  lead: string;
  bodyHtml: string;
  footerNote: string;
}): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="vi"><body style="margin:0;padding:24px;background:#F4EBDA;font-family:\'Be Vietnam Pro\',Inter,Arial,sans-serif;color:#1C1410;">',
    '<div style="max-width:600px;margin:0 auto;background:#FBF7EF;border:1px solid #D9C8A9;border-radius:12px;overflow:hidden;">',
    '<div style="background:#1C1410;color:#FBF7EF;padding:22px 28px;border-bottom:2px solid #B08A4A;">',
    `<p style="margin:0 0 6px;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#EBCF8F;">${escapeHtml(params.eyebrow)}</p>`,
    `<h1 style="margin:0;font-family:Georgia,'Cormorant Garamond',serif;font-size:24px;font-weight:600;color:#FBF7EF;">${escapeHtml(params.title)}</h1>`,
    '</div>',
    '<div style="padding:26px 28px;">',
    `<p style="margin:0 0 18px;font-size:14px;line-height:1.65;color:#3A2D25;">${escapeHtml(params.lead)}</p>`,
    params.bodyHtml,
    '</div>',
    '<div style="padding:18px 28px;background:#F4EBDA;border-top:1px solid #E3D5BD;font-size:12px;color:#665547;line-height:1.5;">',
    `<p style="margin:0;">${escapeHtml(params.footerNote)}</p>`,
    '<p style="margin:6px 0 0;color:#8D6E3B;">TryVibe · Fashion Atelier · Phố Phan Đình Phùng, Ba Đình, Hà Nội</p>',
    '</div>',
    '</div>',
    '</body></html>',
  ].join('');
}

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
export class NotificationService {
  private readonly logger = createLogger(`${SERVICE_NAME}:mail`);
  private readonly transporter: nodemailer.Transporter;

  constructor(
    @Inject(NOTIFY_CONFIG_TOKEN) private readonly config: NotifyReviewConfig,
    @Inject(NotifyDbService) private readonly db: NotifyDbService,
    @Inject(ZaloZnsClient) private readonly zaloZnsClient: ZaloZnsClient,
    @Inject(NotifyDlqService) private readonly notifyDlq: NotifyDlqService,
  ) {
    const { smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass } = this.config.infra;
    const hasAuth = Boolean(smtpUser && smtpPass);
    const useLocalMailpitMode = !hasAuth && isLocalSmtpHost(smtpHost);

    this.transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: useLocalMailpitMode ? false : smtpSecure,
      ...(useLocalMailpitMode ? { ignoreTLS: true } : { requireTLS: !smtpSecure }),
      ...(hasAuth ? { auth: { user: smtpUser, pass: smtpPass } } : {}),
      connectionTimeout: useLocalMailpitMode ? 5000 : 15000,
      greetingTimeout: useLocalMailpitMode ? 5000 : 15000,
      socketTimeout: useLocalMailpitMode ? 8000 : 15000,
    });
  }

  /**
   * Atomically deduplicates `(event_id, 'EMAIL')` and `(event_id, 'ZALO_ZNS')`
   * in `notification_logs` (`UNIQUE(event_id, channel)`) and delivers HTML/text
   * email to Mailpit SMTP (`127.0.0.1:1025`).
   */
  public async sendSmtpAndLog(params: SendSmtpAndLogParams): Promise<NotificationDispatchResult> {
    const emailRowId = randomUUID();
    const insertEmailRes = await this.db.query<{ id: string }>(
      `INSERT INTO notification_logs (
         id, event_id, channel, recipient, template_code, subject,
         payload_jsonb, status, retry_count, sent_at, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7::jsonb, 'SENT', 0, NOW(), NOW()
       )
       ON CONFLICT (event_id, channel) DO NOTHING
       RETURNING id`,
      [
        emailRowId,
        params.eventId,
        NotificationChannel.EMAIL,
        params.recipient,
        params.templateCode,
        params.subject,
        JSON.stringify(params.payload),
      ],
    );

    let emailStatus: 'SENT' | 'DEDUPLICATED' | 'FAILED' = 'DEDUPLICATED';
    let emailLogId: string | null = null;

    if (insertEmailRes.rows.length > 0) {
      emailLogId = insertEmailRes.rows[0].id;
      try {
        await this.transporter.sendMail({
          from: this.config.infra.smtpFrom,
          to: params.recipient,
          subject: params.subject,
          text: params.text,
          html: params.html,
        });
        emailStatus = 'SENT';
        this.logger.info(
          {
            eventId: params.eventId,
            recipient: params.recipient,
            templateCode: params.templateCode,
            smtpHost: this.config.infra.smtpHost,
            smtpPort: this.config.infra.smtpPort,
            correlationId: params.correlationId,
            traceparent: params.traceparent,
          },
          'Dispatched Atelier transactional email via SMTP',
        );
      } catch (error: unknown) {
        emailStatus = 'FAILED';
        await this.db
          .query(
            `UPDATE notification_logs
             SET status = 'FAILED', retry_count = retry_count + 1
             WHERE id = $1`,
            [emailLogId],
          )
          .catch(() => undefined);
        this.logger.warn(
          {
            eventId: params.eventId,
            recipient: params.recipient,
            templateCode: params.templateCode,
            correlationId: params.correlationId,
            err: error instanceof Error ? error.message : String(error),
          },
          'SMTP delivery failed (logged as FAILED in notification_logs)',
        );
      }
    } else {
      this.logger.info(
        {
          eventId: params.eventId,
          channel: NotificationChannel.EMAIL,
          correlationId: params.correlationId,
        },
        'Deduplicated repeat EMAIL notification by (event_id, channel)',
      );
    }

    let znsStatus: ZaloZnsDeliveryStatus | 'DEDUPLICATED' | 'SKIPPED' = 'SKIPPED';
    let znsLogId: string | null = null;
    let znsDeliveryMode: ZaloZnsDeliveryMode | null = null;
    let znsProviderMessageId: string | null = null;
    let znsErrorCode: string | null = null;
    let znsErrorMessage: string | null = null;
    let znsRetryCount = 0;
    let znsDeadLettered = false;

    const znsRecipient = params.znsPhone?.trim();
    if (znsRecipient) {
      const znsOutcome = await this.dispatchZnsAndLog({
        eventId: params.eventId,
        phone: znsRecipient,
        templateCode: params.templateCode,
        subject: params.subject,
        originalPayload: params.payload,
        templateData:
          params.znsTemplateData ?? this.extractFlatTemplateData(params.payload),
        simulateZnsFailure: params.simulateZnsFailure,
        correlationId: params.correlationId,
        traceparent: params.traceparent,
      });

      znsStatus = znsOutcome.status;
      znsLogId = znsOutcome.logId;
      znsDeliveryMode = znsOutcome.deliveryMode;
      znsProviderMessageId = znsOutcome.providerMessageId;
      znsErrorCode = znsOutcome.errorCode;
      znsErrorMessage = znsOutcome.errorMessage;
      znsRetryCount = znsOutcome.retryCount;
      znsDeadLettered = znsOutcome.deadLettered;
    }

    return {
      eventId: params.eventId,
      templateCode: params.templateCode,
      recipient: params.recipient,
      subject: params.subject,
      emailStatus,
      emailLogId,
      znsStatus,
      znsLogId,
      znsDeliveryMode,
      znsProviderMessageId,
      znsErrorCode,
      znsErrorMessage,
      znsRetryCount,
      znsDeadLettered,
      deduplicated: emailStatus === 'DEDUPLICATED',
    };
  }

  private extractFlatTemplateData(
    payload: Record<string, unknown>,
  ): Record<string, string | number | boolean | null> {
    const out: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (
        typeof v === 'string' ||
        typeof v === 'number' ||
        typeof v === 'boolean' ||
        v === null
      ) {
        out[k] = v;
      }
    }
    return out;
  }

  private async dispatchZnsAndLog(params: {
    eventId: string;
    phone: string;
    templateCode: string;
    subject: string;
    originalPayload: Record<string, unknown>;
    templateData: Record<string, string | number | boolean | null | undefined>;
    simulateZnsFailure?: boolean;
    correlationId: string;
    traceparent?: string;
  }): Promise<{
    status: ZaloZnsDeliveryStatus | 'DEDUPLICATED';
    logId: string | null;
    deliveryMode: ZaloZnsDeliveryMode | null;
    providerMessageId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    retryCount: number;
    deadLettered: boolean;
  }> {
    const znsRowId = randomUUID();
    const insertZnsRes = await this.db.query<{ id: string }>(
      `INSERT INTO notification_logs (
         id, event_id, channel, recipient, template_code, subject,
         payload_jsonb, status, retry_count, delivery_mode, sent_at, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7::jsonb, 'PENDING', 0, 'LIVE', NOW(), NOW()
       )
       ON CONFLICT (event_id, channel) DO NOTHING
       RETURNING id`,
      [
        znsRowId,
        params.eventId,
        NotificationChannel.ZALO_ZNS,
        params.phone,
        params.templateCode,
        params.subject,
        JSON.stringify(params.originalPayload),
      ],
    );

    if (insertZnsRes.rows.length === 0) {
      this.logger.info(
        {
          eventId: params.eventId,
          channel: NotificationChannel.ZALO_ZNS,
          correlationId: params.correlationId,
        },
        'Deduplicated repeat ZALO_ZNS notification by (event_id, channel)',
      );
      return {
        status: 'DEDUPLICATED',
        logId: null,
        deliveryMode: null,
        providerMessageId: null,
        errorCode: null,
        errorMessage: null,
        retryCount: 0,
        deadLettered: false,
      };
    }

    const logId = insertZnsRes.rows[0].id;
    const znsResult = await this.zaloZnsClient.sendTemplateMessage({
      phone: params.phone,
      templateCode: params.templateCode,
      templateData: params.templateData,
      trackingId: params.eventId,
      simulateZnsFailure: params.simulateZnsFailure,
    });

    const enrichedPayload = {
      ...params.originalPayload,
      znsFormattedPayload: znsResult.formattedPayload,
    };

    await this.db
      .query(
        `UPDATE notification_logs
         SET recipient = $2,
             payload_jsonb = $3::jsonb,
             status = $4,
             retry_count = $5,
             provider_message_id = $6,
             provider_error_code = $7,
             provider_error_message = $8,
             delivery_mode = $9,
             sent_at = NOW()
         WHERE id = $1`,
        [
          logId,
          znsResult.normalizedPhone ?? params.phone,
          JSON.stringify(enrichedPayload),
          znsResult.status,
          znsResult.retryCount,
          znsResult.providerMessageId,
          znsResult.errorCode,
          znsResult.errorMessage,
          znsResult.deliveryMode,
        ],
      )
      .catch((err: unknown) => {
        this.logger.warn(
          { err: err instanceof Error ? err.message : String(err), logId },
          'Failed to update ZALO_ZNS notification_logs row',
        );
      });

    let deadLettered = false;
    if (znsResult.shouldDeadLetter) {
      deadLettered = await this.notifyDlq.publishFailedZnsToDlq({
        eventId: params.eventId,
        notificationLogId: logId,
        channel: 'ZALO_ZNS',
        recipient: znsResult.normalizedPhone ?? params.phone,
        templateCode: params.templateCode,
        templateId: znsResult.templateId,
        subject: params.subject,
        formattedPayload: znsResult.formattedPayload,
        originalPayload: params.originalPayload,
        errorCode: znsResult.errorCode,
        errorMessage: znsResult.errorMessage,
        retryCount: znsResult.retryCount,
        deliveryMode: znsResult.deliveryMode,
        correlationId: params.correlationId,
        traceparent: params.traceparent,
        failedAt: new Date().toISOString(),
      });
    }

    return {
      status: znsResult.status,
      logId,
      deliveryMode: znsResult.deliveryMode,
      providerMessageId: znsResult.providerMessageId,
      errorCode: znsResult.errorCode,
      errorMessage: znsResult.errorMessage,
      retryCount: znsResult.retryCount,
      deadLettered,
    };
  }

  public async sendDirectZns(
    input: DirectZnsNotifyInput,
    correlationId: string,
    traceparent?: string,
  ): Promise<NotificationDispatchResult> {
    const eventId = input.eventId?.trim() || `zns-direct:${randomUUID()}`;
    const subject = input.subject?.trim() || `TryVibe Atelier · ZNS ${input.templateCode}`;

    const znsOutcome = await this.dispatchZnsAndLog({
      eventId,
      phone: input.phone,
      templateCode: input.templateCode,
      subject,
      originalPayload: input.templateData,
      templateData: input.templateData,
      simulateZnsFailure: input.simulateZnsFailure,
      correlationId,
      traceparent,
    });

    return {
      eventId,
      templateCode: input.templateCode,
      recipient: input.phone,
      subject,
      emailStatus: 'SKIPPED',
      emailLogId: null,
      znsStatus: znsOutcome.status,
      znsLogId: znsOutcome.logId,
      znsDeliveryMode: znsOutcome.deliveryMode,
      znsProviderMessageId: znsOutcome.providerMessageId,
      znsErrorCode: znsOutcome.errorCode,
      znsErrorMessage: znsOutcome.errorMessage,
      znsRetryCount: znsOutcome.retryCount,
      znsDeadLettered: znsOutcome.deadLettered,
      deduplicated: znsOutcome.status === 'DEDUPLICATED',
    };
  }

  public async sendRmaRejected(
    input: RmaRejectedNotifyInput,
    correlationId: string,
    traceparent?: string,
  ): Promise<NotificationDispatchResult> {
    const eventId = input.eventId?.trim() || `rma-rejected:${input.rmaCode}`;
    const subject = `TryVibe Atelier · Cập nhật yêu cầu đổi trả ${input.rmaCode}`;
    const greetingName = input.customerName?.trim() || 'Quý khách';

    const bodyHtml = [
      '<div style="background:#F4EBDA;border:1px solid #DFCFAF;border-radius:8px;padding:16px 18px;margin-bottom:18px;">',
      `<p style="margin:0;font-size:13px;color:#5A493B;">Mã RMA: <strong style="color:#1C1410;">${escapeHtml(input.rmaCode)}</strong></p>`,
      `<p style="margin:6px 0 0;font-size:13px;color:#5A493B;">Đơn hàng gốc: <strong style="color:#1C1410;">${escapeHtml(input.orderCode)}</strong></p>`,
      `<p style="margin:8px 0 0;font-size:13px;color:#8B2E2E;">Lý do từ chối: <strong>${escapeHtml(input.reason)}</strong></p>`,
      '</div>',
      '<p style="margin:0;font-size:13px;color:#5A493B;line-height:1.6;">Nếu bạn cần hỗ trợ thêm hoặc muốn khiếu nại thẩm định, vui lòng phản hồi trực tiếp email này hoặc liên hệ bộ phận Chăm sóc Khách hàng TryVibe Atelier.</p>',
    ].join('');

    const html = renderAtelierEmailShell({
      eyebrow: 'TryVibe Fashion Atelier · RMA Update',
      title: `Thông báo yêu cầu RMA ${input.rmaCode}`,
      lead: `Xin chào ${greetingName}, chúng tôi đã hoàn tất xem xét yêu cầu đổi trả của bạn.`,
      bodyHtml,
      footerNote:
        'TryVibe Atelier luôn đồng hành hỗ trợ kiểm định minh bạch cho mọi thiết kế.',
    });

    const text = [
      `Xin chào ${greetingName},`,
      `Yêu cầu đổi trả ${input.rmaCode} (đơn hàng ${input.orderCode}) chưa đủ điều kiện phê duyệt.`,
      `Lý do: ${input.reason}`,
      'Trân trọng, TryVibe Fashion Atelier.',
    ].join('\n');

    return this.sendSmtpAndLog({
      eventId,
      recipient: input.customerEmail,
      subject,
      html,
      text,
      templateCode: 'RMA_REJECTED_VI',
      payload: {
        rmaId: input.rmaId,
        rmaCode: input.rmaCode,
        orderCode: input.orderCode,
        reason: input.reason,
        rejectedBy: input.rejectedBy ?? null,
      },
      znsPhone: input.customerPhone?.trim() || undefined,
      znsTemplateData: {
        rma_code: input.rmaCode,
        order_code: input.orderCode,
        customer_name: greetingName,
        reason: input.reason,
      },
      simulateZnsFailure: input.simulateZnsFailure,
      correlationId,
      traceparent,
    });
  }

  public async sendOrderConfirmed(
    input: OrderConfirmedNotifyInput,
    correlationId: string,
    traceparent?: string,
  ): Promise<NotificationDispatchResult> {
    const eventId = input.eventId?.trim() || `order-confirmed:${input.orderCode}`;
    const subject = `TryVibe Atelier · Xác nhận đơn hàng ${input.orderCode}`;
    const greetingName = input.customerName?.trim() || 'Quý khách';
    const items = input.items ?? [];

    const itemsRowsHtml = items
      .map((item) => {
        const title = item.productName || item.skuCode || 'Thiết kế TryVibe Atelier';
        const variantBits = [item.colorName, item.sizeCode ? `Size ${item.sizeCode}` : null]
          .filter(Boolean)
          .join(' · ');
        const qty = item.qty ?? 1;
        const price =
          typeof item.unitPriceVnd === 'number' ? formatVnd(item.unitPriceVnd * qty) : '';
        return [
          '<tr>',
          `<td style="padding:10px 0;border-bottom:1px solid #EADFD0;font-size:13px;color:#1C1410;"><strong>${escapeHtml(title)}</strong>${variantBits ? `<br><span style="color:#6F5D4E;font-size:12px;">${escapeHtml(variantBits)}</span>` : ''}</td>`,
          `<td style="padding:10px 8px;border-bottom:1px solid #EADFD0;text-align:center;font-size:13px;color:#3A2D25;">×${qty}</td>`,
          `<td style="padding:10px 0;border-bottom:1px solid #EADFD0;text-align:right;font-size:13px;font-weight:600;color:#1C1410;">${escapeHtml(price)}</td>`,
          '</tr>',
        ].join('');
      })
      .join('');

    const trackingHtml = input.trackingCode
      ? `<p style="margin:12px 0 0;font-size:13px;color:#3A2D25;">Mã vận đơn dự kiến: <strong style="color:#8D6E3B;">${escapeHtml(input.trackingCode)}</strong></p>`
      : '';

    const bodyHtml = [
      `<div style="background:#F4EBDA;border:1px solid #DFCFAF;border-radius:8px;padding:16px 18px;margin-bottom:18px;">`,
      `<p style="margin:0;font-size:13px;color:#5A493B;">Mã đơn hàng: <strong style="color:#1C1410;">${escapeHtml(input.orderCode)}</strong></p>`,
      `<p style="margin:8px 0 0;font-size:15px;color:#1C1410;">Tổng thanh toán: <strong style="color:#8D6E3B;">${escapeHtml(formatVnd(input.grandTotalVnd))}</strong></p>`,
      trackingHtml,
      '</div>',
      items.length > 0
        ? `<table style="width:100%;border-collapse:collapse;margin-bottom:16px;">${itemsRowsHtml}</table>`
        : '',
      '<p style="margin:0;font-size:13px;color:#5A493B;line-height:1.6;">Xưởng may TryVibe đang kiểm chuẩn đường kim mũi chỉ và sẽ gửi ảnh chụp hộp trang phục trước khi niêm phong bàn giao đơn vị vận chuyển.</p>',
    ].join('');

    const html = renderAtelierEmailShell({
      eyebrow: 'TryVibe Fashion Atelier · Order Confirmed',
      title: `Xác nhận đơn hàng ${input.orderCode}`,
      lead: `Xin chào ${greetingName}, TryVibe Atelier đã tiếp nhận và xác nhận thanh toán cho đơn hàng của bạn.`,
      bodyHtml,
      footerNote:
        'Quyền lợi đổi size miễn phí 7 ngày (14 ngày cho hạng GOLD/DIAMOND) · Quà tặng +5 lượt Ướm thử AI đã được cộng vào tài khoản của bạn.',
    });

    const textLines = [
      `Xin chào ${greetingName},`,
      `TryVibe Atelier xác nhận đơn hàng ${input.orderCode}.`,
      `Tổng thanh toán: ${formatVnd(input.grandTotalVnd)}`,
      ...(input.trackingCode ? [`Mã vận đơn: ${input.trackingCode}`] : []),
      ...items.map(
        (item) =>
          `- ${item.productName || item.skuCode || 'Sản phẩm'} (${item.sizeCode || '-'}) x${item.qty ?? 1}`,
      ),
      'Trân trọng, TryVibe Fashion Atelier.',
    ];

    return this.sendSmtpAndLog({
      eventId,
      recipient: input.customerEmail,
      subject,
      html,
      text: textLines.join('\n'),
      templateCode: 'ORDER_CONFIRMED_VI',
      payload: {
        orderCode: input.orderCode,
        grandTotalVnd: input.grandTotalVnd ?? 0,
        trackingCode: input.trackingCode ?? null,
        itemCount: items.length,
      },
      znsPhone: input.customerPhone?.trim() || undefined,
      znsTemplateData: {
        order_code: input.orderCode,
        customer_name: greetingName,
        total_amount: formatVnd(input.grandTotalVnd),
        tracking_code: input.trackingCode ?? '',
      },
      simulateZnsFailure: input.simulateZnsFailure,
      correlationId,
      traceparent,
    });
  }

  public async sendOrderPacked(
    input: OrderPackedNotifyInput,
    correlationId: string,
    traceparent?: string,
  ): Promise<NotificationDispatchResult> {
    const eventId = input.eventId?.trim() || `order-packed:${input.orderCode}`;
    const subject = `TryVibe Atelier · Ảnh chụp hộp trang phục đơn ${input.orderCode} trước khi giao`;
    const greetingName = input.customerName?.trim() || 'Quý khách';

    const bodyHtml = [
      '<div style="background:#F4EBDA;border:1px solid #DFCFAF;border-radius:8px;padding:16px 18px;margin-bottom:18px;">',
      `<p style="margin:0;font-size:13px;color:#5A493B;">Đơn hàng: <strong style="color:#1C1410;">${escapeHtml(input.orderCode)}</strong></p>`,
      input.trackingCode
        ? `<p style="margin:6px 0 0;font-size:13px;color:#5A493B;">Mã vận đơn: <strong style="color:#8D6E3B;">${escapeHtml(input.trackingCode)}</strong></p>`
        : '',
      '</div>',
      '<div style="text-align:center;margin:0 0 18px;">',
      `<img src="${escapeHtml(input.packPhotoUrl)}" alt="Ảnh chụp hộp trang phục đơn ${escapeHtml(input.orderCode)}" style="max-width:100%;border-radius:10px;border:1px solid #D9C8A9;" />`,
      `<p style="margin:10px 0 0;font-size:12px;color:#6F5D4E;">Liên kết ảnh gốc: <a href="${escapeHtml(input.packPhotoUrl)}" style="color:#8D6E3B;">${escapeHtml(input.packPhotoUrl)}</a></p>`,
      '</div>',
      '<p style="margin:0;font-size:13px;color:#5A493B;line-height:1.6;">Trang phục của bạn đã hoàn tất bước là hơi, kiểm chuẩn thông số và đóng hộp lụa chuẩn Atelier trước khi bàn giao giao nhận.</p>',
    ].join('');

    const html = renderAtelierEmailShell({
      eyebrow: 'TryVibe Fashion Atelier · Pack Photo Proof',
      title: `Hộp trang phục đơn ${input.orderCode} đã sẵn sàng`,
      lead: `Xin chào ${greetingName}, xưởng may TryVibe gửi bạn ảnh chụp thực tế hộp trang phục trước khi niêm phong giao đi.`,
      bodyHtml,
      footerNote:
        'Bạn có thể theo dõi hành trình đơn hàng trực tiếp tại trang Chi tiết Đơn hàng trên Storefront.',
    });

    const text = [
      `Xin chào ${greetingName},`,
      `Đơn hàng ${input.orderCode} đã được đóng gói hoàn thiện tại xưởng TryVibe.`,
      ...(input.trackingCode ? [`Mã vận đơn: ${input.trackingCode}`] : []),
      `Ảnh chụp hộp trang phục trước khi giao: ${input.packPhotoUrl}`,
      'Trân trọng, TryVibe Fashion Atelier.',
    ].join('\n');

    return this.sendSmtpAndLog({
      eventId,
      recipient: input.customerEmail,
      subject,
      html,
      text,
      templateCode: 'ORDER_PACKED_PHOTO_VI',
      payload: {
        orderCode: input.orderCode,
        packPhotoUrl: input.packPhotoUrl,
        trackingCode: input.trackingCode ?? null,
      },
      znsPhone: input.customerPhone?.trim() || undefined,
      znsTemplateData: {
        order_code: input.orderCode,
        customer_name: greetingName,
        tracking_code: input.trackingCode ?? '',
        pack_photo_url: input.packPhotoUrl,
      },
      simulateZnsFailure: input.simulateZnsFailure,
      correlationId,
      traceparent,
    });
  }

  public async sendPoSubmitted(
    input: PoSubmittedNotifyInput,
    correlationId: string,
    traceparent?: string,
  ): Promise<NotificationDispatchResult> {
    const eventId = input.eventId?.trim() || `po-submitted:${input.poNumber}`;
    const subject = `TryVibe Atelier B2B · Đơn đặt hàng nhập mới ${input.poNumber}`;
    const supplierLabel = input.supplierName?.trim() || 'Quý đối tác cung ứng';
    const items = input.items ?? [];

    const itemsRowsHtml = items
      .map((item) => {
        const skuLabel = item.skuCode || item.skuId || 'SKU';
        const qty = item.orderedQty ?? 0;
        const unitCost =
          typeof item.unitCostVnd === 'number' ? formatVnd(item.unitCostVnd) : '-';
        const lineTotal =
          typeof item.unitCostVnd === 'number' ? formatVnd(item.unitCostVnd * qty) : '-';
        return [
          '<tr>',
          `<td style="padding:9px 0;border-bottom:1px solid #EADFD0;font-size:13px;color:#1C1410;"><strong>${escapeHtml(skuLabel)}</strong></td>`,
          `<td style="padding:9px 8px;border-bottom:1px solid #EADFD0;text-align:center;font-size:13px;">${qty}</td>`,
          `<td style="padding:9px 8px;border-bottom:1px solid #EADFD0;text-align:right;font-size:13px;">${escapeHtml(unitCost)}</td>`,
          `<td style="padding:9px 0;border-bottom:1px solid #EADFD0;text-align:right;font-size:13px;font-weight:600;">${escapeHtml(lineTotal)}</td>`,
          '</tr>',
        ].join('');
      })
      .join('');

    const bodyHtml = [
      '<div style="background:#F4EBDA;border:1px solid #DFCFAF;border-radius:8px;padding:16px 18px;margin-bottom:18px;">',
      `<p style="margin:0;font-size:13px;color:#5A493B;">Số PO: <strong style="color:#1C1410;">${escapeHtml(input.poNumber)}</strong></p>`,
      input.expectedDeliveryDate
        ? `<p style="margin:6px 0 0;font-size:13px;color:#5A493B;">Ngày giao dự kiến: <strong style="color:#1C1410;">${escapeHtml(input.expectedDeliveryDate)}</strong></p>`
        : '',
      `<p style="margin:6px 0 0;font-size:15px;color:#1C1410;">Tổng giá trị dự kiến: <strong style="color:#8D6E3B;">${escapeHtml(formatVnd(input.totalAmountVnd))}</strong></p>`,
      '</div>',
      items.length > 0
        ? `<table style="width:100%;border-collapse:collapse;margin-bottom:16px;"><thead><tr><th style="text-align:left;padding-bottom:8px;border-bottom:2px solid #D9C8A9;font-size:12px;color:#6F5D4E;">SKU</th><th style="text-align:center;padding-bottom:8px;border-bottom:2px solid #D9C8A9;font-size:12px;color:#6F5D4E;">SL</th><th style="text-align:right;padding-bottom:8px;border-bottom:2px solid #D9C8A9;font-size:12px;color:#6F5D4E;">Đơn giá</th><th style="text-align:right;padding-bottom:8px;border-bottom:2px solid #D9C8A9;font-size:12px;color:#6F5D4E;">Thành tiền</th></tr></thead><tbody>${itemsRowsHtml}</tbody></table>`
        : '',
      '<p style="margin:0;font-size:13px;color:#5A493B;line-height:1.6;">Vui lòng đăng nhập <strong>Cổng Đối tác B2B (Partner Portal)</strong> để xác nhận khả năng đáp ứng và chốt ngày bàn giao lô hàng về kho Hà Nội.</p>',
    ].join('');

    const html = renderAtelierEmailShell({
      eyebrow: 'TryVibe Fashion Atelier · B2B Procurement',
      title: `Đơn đặt hàng nhập mới ${input.poNumber}`,
      lead: `Kính gửi ${supplierLabel}, TryVibe Atelier đã phê duyệt và phát hành đơn đặt hàng nhập chính thức.`,
      bodyHtml,
      footerNote:
        'Email tự động từ hệ thống Thu mua B2B TryVibe Atelier. Công nợ đối soát sẽ được tạo tự động dựa trên số lượng nghiệm thu đạt chuẩn (GRN).',
    });

    const text = [
      `Kính gửi ${supplierLabel},`,
      `TryVibe Atelier phát hành đơn đặt hàng nhập mới: ${input.poNumber}`,
      ...(input.expectedDeliveryDate ? [`Ngày giao dự kiến: ${input.expectedDeliveryDate}`] : []),
      `Tổng giá trị: ${formatVnd(input.totalAmountVnd)}`,
      ...items.map(
        (item) =>
          `- ${item.skuCode || item.skuId || 'SKU'}: SL ${item.orderedQty ?? 0} x ${formatVnd(item.unitCostVnd)}`,
      ),
      'Vui lòng xác nhận trên Cổng Đối tác B2B.',
    ].join('\n');

    return this.sendSmtpAndLog({
      eventId,
      recipient: input.supplierEmail,
      subject,
      html,
      text,
      templateCode: 'B2B_PO_SUBMITTED_VI',
      payload: {
        poNumber: input.poNumber,
        supplierName: supplierLabel,
        expectedDeliveryDate: input.expectedDeliveryDate ?? null,
        totalAmountVnd: input.totalAmountVnd ?? 0,
        itemCount: items.length,
      },
      znsPhone: input.supplierPhone?.trim() || undefined,
      znsTemplateData: {
        po_number: input.poNumber,
        supplier_name: supplierLabel,
        expected_delivery_date: input.expectedDeliveryDate ?? '',
        total_amount: formatVnd(input.totalAmountVnd),
      },
      simulateZnsFailure: input.simulateZnsFailure,
      correlationId,
      traceparent,
    });
  }
}
