import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { PaymentRedisService } from './cache/payment-redis.service';
import { ApiExceptionFilter } from './common/payment-api.exception';
import { loadPaymentPromoConfig, PAYMENT_CONFIG_TOKEN } from './config/env';
import { PaymentDbService } from './db/payment-db.service';
import { PaymentEventPublisherService } from './messaging/payment-event-publisher.service';
import { PaymentsController } from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';
import { PromotionsController } from './promotions/promotions.controller';
import { PromotionsService } from './promotions/promotions.service';
import { PaymentPromoController } from './service.controller';

@Module({
  controllers: [PaymentPromoController, PromotionsController, PaymentsController],
  providers: [
    {
      provide: PAYMENT_CONFIG_TOKEN,
      useFactory: () => loadPaymentPromoConfig(),
    },
    {
      provide: APP_FILTER,
      useClass: ApiExceptionFilter,
    },
    PaymentDbService,
    PaymentRedisService,
    PaymentEventPublisherService,
    PromotionsService,
    PaymentsService,
  ],
})
export class AppModule {}
