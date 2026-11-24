import { Module } from '@nestjs/common';
import { UpstreamServicesClient } from './clients/upstream-services.client';
import { loadOrderRmaConfig, ORDER_CONFIG_TOKEN } from './config/env';
import { InternalOrderController } from './controllers/internal.controller';
import { OrdersController } from './controllers/orders.controller';
import { RmaController } from './controllers/rma.controller';
import { OrderDbService } from './db/order-db.service';
import { OrderRabbitMqService } from './infra/rabbitmq.service';
import { OrderRmaController } from './service.controller';
import { OrderRmaService } from './services/order-rma.service';

@Module({
  controllers: [
    OrderRmaController,
    OrdersController,
    RmaController,
    InternalOrderController,
  ],
  providers: [
    {
      provide: ORDER_CONFIG_TOKEN,
      useFactory: () => loadOrderRmaConfig(),
    },
    OrderDbService,
    OrderRabbitMqService,
    UpstreamServicesClient,
    OrderRmaService,
  ],
})
export class AppModule {}
