import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CartRedisService } from './cache/cart-redis.service';
import { CartOutfitService } from './cart/cart-outfit.service';
import { CartController } from './cart/cart.controller';
import { OutfitsController } from './cart/outfits.controller';
import { UpstreamClientService } from './clients/upstream.client';
import { ApiExceptionFilter } from './common/cart-api.exception';
import { CART_CONFIG_TOKEN, loadCartOutfitConfig } from './config/env';
import { CartDbService } from './db/cart-db.service';
import { CartOutfitController } from './service.controller';

@Module({
  controllers: [CartOutfitController, CartController, OutfitsController],
  providers: [
    {
      provide: CART_CONFIG_TOKEN,
      useFactory: () => loadCartOutfitConfig(),
    },
    {
      provide: APP_FILTER,
      useClass: ApiExceptionFilter,
    },
    CartDbService,
    CartRedisService,
    UpstreamClientService,
    CartOutfitService,
  ],
})
export class AppModule {}
