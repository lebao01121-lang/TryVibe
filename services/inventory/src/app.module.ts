import { Module } from '@nestjs/common';
import { INVENTORY_CONFIG_TOKEN, loadInventoryConfig } from './config/env';
import { InventoryApiController } from './controllers/inventory.controller';
import { ProcurementController } from './controllers/procurement.controller';
import { InventoryDatabaseService } from './infra/database.service';
import { InventoryRabbitMqService } from './infra/rabbitmq.service';
import { InventoryRedisService } from './infra/redis.service';
import { InventoryController } from './service.controller';
import { InventoryService } from './services/inventory.service';
import { ProcurementService } from './services/procurement.service';

@Module({
  controllers: [InventoryController, InventoryApiController, ProcurementController],
  providers: [
    {
      provide: INVENTORY_CONFIG_TOKEN,
      useFactory: () => loadInventoryConfig(),
    },
    InventoryRedisService,
    InventoryRabbitMqService,
    InventoryDatabaseService,
    InventoryService,
    ProcurementService,
  ],
})
export class AppModule {}
