import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import {
  createApiResponse,
  ErrorCode,
  type ApiResponse,
} from '@atelier/contracts';
import {
  getOrCreateCorrelationId,
  getOrCreateTraceparent,
  type HeaderBag,
} from '@atelier/observability';
import { assertInternalSecret } from '../common/internal-secret';
import { NOTIFY_CONFIG_TOKEN, type NotifyReviewConfig } from '../config/env';
import {
  NotificationService,
  type NotificationDispatchResult,
} from './notification.service';

const OrderConfirmedPayloadSchema = z.object({
  eventId: z.string().trim().min(1).max(128).optional(),
  orderCode: z.string().trim().min(1).max(64),
  customerEmail: z.string().trim().email(),
  customerPhone: z.string().trim().max(40).optional().nullable(),
  customerName: z.string().trim().max(140).optional().nullable(),
  grandTotalVnd: z.coerce.number().nonnegative().optional(),
  trackingCode: z.string().trim().max(80).optional().nullable(),
  shippingMethod: z.string().trim().max(40).optional().nullable(),
  paymentMethod: z.string().trim().max(40).optional().nullable(),
  simulateZnsFailure: z.boolean().optional(),
  items: z
    .array(
      z.object({
        productName: z.string().optional(),
        skuCode: z.string().optional(),
        sizeCode: z.string().optional(),
        colorName: z.string().optional(),
        qty: z.coerce.number().int().positive().optional(),
        unitPriceVnd: z.coerce.number().nonnegative().optional(),
      }),
    )
    .optional(),
});

const OrderPackedPayloadSchema = z.object({
  eventId: z.string().trim().min(1).max(128).optional(),
  orderCode: z.string().trim().min(1).max(64),
  customerEmail: z.string().trim().email(),
  customerPhone: z.string().trim().max(40).optional().nullable(),
  customerName: z.string().trim().max(140).optional().nullable(),
  packPhotoUrl: z.string().trim().min(1),
  trackingCode: z.string().trim().max(80).optional().nullable(),
  simulateZnsFailure: z.boolean().optional(),
});

const PoSubmittedPayloadSchema = z.object({
  eventId: z.string().trim().min(1).max(128).optional(),
  poNumber: z.string().trim().min(1).max(64),
  supplierEmail: z.string().trim().email(),
  supplierName: z.string().trim().max(160).optional().nullable(),
  supplierPhone: z.string().trim().max(40).optional().nullable(),
  expectedDeliveryDate: z.string().trim().max(40).optional().nullable(),
  totalAmountVnd: z.coerce.number().nonnegative().optional(),
  notes: z.string().trim().max(500).optional().nullable(),
  simulateZnsFailure: z.boolean().optional(),
  items: z
    .array(
      z.object({
        skuCode: z.string().optional(),
        skuId: z.string().optional(),
        orderedQty: z.coerce.number().int().nonnegative().optional(),
        unitCostVnd: z.coerce.number().nonnegative().optional(),
      }),
    )
    .optional(),
});

const RmaRejectedPayloadSchema = z.object({
  eventId: z.string().trim().min(1).max(128).optional(),
  rmaId: z.string().trim().min(1).max(64),
  rmaCode: z.string().trim().min(1).max(64),
  orderCode: z.string().trim().min(1).max(64),
  customerEmail: z.string().trim().email(),
  customerPhone: z.string().trim().max(40).optional().nullable(),
  customerName: z.string().trim().max(140).optional().nullable(),
  reason: z.string().trim().min(1).max(500),
  rejectedBy: z.string().trim().max(140).optional().nullable(),
  simulateZnsFailure: z.boolean().optional(),
});

const DirectZnsPayloadSchema = z.object({
  eventId: z.string().trim().min(1).max(128).optional(),
  phone: z.string().trim().min(8).max(40),
  templateCode: z.string().trim().min(1).max(64).default('ORDER_CONFIRMED_VI'),
  subject: z.string().trim().max(200).optional(),
  templateData: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .default({}),
  simulateZnsFailure: z.boolean().optional(),
});

@Controller('internal/notify')
export class InternalNotifyController {
  constructor(
    @Inject(NOTIFY_CONFIG_TOKEN) private readonly config: NotifyReviewConfig,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  @Post('order-confirmed')
  @HttpCode(HttpStatus.OK)
  async notifyOrderConfirmed(
    @Body() rawBody: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<NotificationDispatchResult>> {
    assertInternalSecret(headers, this.config.internalServiceSecret);
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);

    const parsed = OrderConfirmedPayloadSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid order-confirmed notification payload.',
        details: { issues: parsed.error.flatten() },
      });
    }

    const d = parsed.data;
    const result = await this.notifications.sendOrderConfirmed(
      {
        eventId: d.eventId,
        orderCode: d.orderCode,
        customerEmail: d.customerEmail,
        customerPhone: d.customerPhone ?? undefined,
        customerName: d.customerName ?? undefined,
        grandTotalVnd: d.grandTotalVnd,
        trackingCode: d.trackingCode ?? undefined,
        shippingMethod: d.shippingMethod ?? undefined,
        paymentMethod: d.paymentMethod ?? undefined,
        simulateZnsFailure: d.simulateZnsFailure,
        items: d.items,
      },
      correlationId,
      traceparent,
    );

    return createApiResponse(result, {
      correlationId,
      service: this.config.serviceName,
    });
  }

  @Post('order-packed')
  @HttpCode(HttpStatus.OK)
  async notifyOrderPacked(
    @Body() rawBody: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<NotificationDispatchResult>> {
    assertInternalSecret(headers, this.config.internalServiceSecret);
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);

    const parsed = OrderPackedPayloadSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid order-packed notification payload.',
        details: { issues: parsed.error.flatten() },
      });
    }

    const d = parsed.data;
    const result = await this.notifications.sendOrderPacked(
      {
        eventId: d.eventId,
        orderCode: d.orderCode,
        customerEmail: d.customerEmail,
        customerPhone: d.customerPhone ?? undefined,
        customerName: d.customerName ?? undefined,
        packPhotoUrl: d.packPhotoUrl,
        trackingCode: d.trackingCode ?? undefined,
        simulateZnsFailure: d.simulateZnsFailure,
      },
      correlationId,
      traceparent,
    );

    return createApiResponse(result, {
      correlationId,
      service: this.config.serviceName,
    });
  }

  @Post('po-submitted')
  @HttpCode(HttpStatus.OK)
  async notifyPoSubmitted(
    @Body() rawBody: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<NotificationDispatchResult>> {
    assertInternalSecret(headers, this.config.internalServiceSecret);
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);

    const parsed = PoSubmittedPayloadSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid po-submitted notification payload.',
        details: { issues: parsed.error.flatten() },
      });
    }

    const d = parsed.data;
    const result = await this.notifications.sendPoSubmitted(
      {
        eventId: d.eventId,
        poNumber: d.poNumber,
        supplierEmail: d.supplierEmail,
        supplierName: d.supplierName ?? undefined,
        supplierPhone: d.supplierPhone ?? undefined,
        expectedDeliveryDate: d.expectedDeliveryDate ?? undefined,
        totalAmountVnd: d.totalAmountVnd,
        notes: d.notes ?? undefined,
        simulateZnsFailure: d.simulateZnsFailure,
        items: d.items,
      },
      correlationId,
      traceparent,
    );

    return createApiResponse(result, {
      correlationId,
      service: this.config.serviceName,
    });
  }

  @Post('rma-rejected')
  @HttpCode(HttpStatus.OK)
  async notifyRmaRejected(
    @Body() rawBody: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<NotificationDispatchResult>> {
    assertInternalSecret(headers, this.config.internalServiceSecret);
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);

    const parsed = RmaRejectedPayloadSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid rma-rejected notification payload.',
        details: { issues: parsed.error.flatten() },
      });
    }

    const d = parsed.data;
    const result = await this.notifications.sendRmaRejected(
      {
        eventId: d.eventId,
        rmaId: d.rmaId,
        rmaCode: d.rmaCode,
        orderCode: d.orderCode,
        customerEmail: d.customerEmail,
        customerPhone: d.customerPhone ?? undefined,
        customerName: d.customerName ?? undefined,
        reason: d.reason,
        rejectedBy: d.rejectedBy ?? undefined,
        simulateZnsFailure: d.simulateZnsFailure,
      },
      correlationId,
      traceparent,
    );

    return createApiResponse(result, {
      correlationId,
      service: this.config.serviceName,
    });
  }

  @Post('zns')
  @HttpCode(HttpStatus.OK)
  async notifyDirectZns(
    @Body() rawBody: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<NotificationDispatchResult>> {
    assertInternalSecret(headers, this.config.internalServiceSecret);
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);

    const parsed = DirectZnsPayloadSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid ZNS notification payload.',
        details: { issues: parsed.error.flatten() },
      });
    }

    const d = parsed.data;
    const result = await this.notifications.sendDirectZns(
      {
        eventId: d.eventId,
        phone: d.phone,
        templateCode: d.templateCode,
        subject: d.subject,
        templateData: d.templateData,
        simulateZnsFailure: d.simulateZnsFailure,
      },
      correlationId,
      traceparent,
    );

    return createApiResponse(result, {
      correlationId,
      service: this.config.serviceName,
    });
  }
}
