import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  createApiResponse,
  type ApiResponse,
  type OutfitStudioPreviewResponse,
  type SavedOutfitDto,
} from '@atelier/contracts';
import type { HeaderBag } from '@atelier/observability';
import { SERVICE_NAME } from '../config/env';
import { CartOutfitService } from './cart-outfit.service';
import { extractCartActor } from './cart.controller';

@Controller('v1/outfits')
export class OutfitsController {
  constructor(private readonly cartService: CartOutfitService) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  async previewOutfit(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<OutfitStudioPreviewResponse>> {
    const actor = extractCartActor(headers);
    const data = await this.cartService.previewOutfit(body, actor);
    return createApiResponse(data, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post()
  async createSavedOutfit(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<SavedOutfitDto>> {
    const actor = extractCartActor(headers);
    const data = await this.cartService.createSavedOutfit(body, actor);
    return createApiResponse(data, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }

  @Get('me')
  async listMySavedOutfits(
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<SavedOutfitDto[]>> {
    const actor = extractCartActor(headers);
    const data = await this.cartService.listMySavedOutfits(actor);
    return createApiResponse(data, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }

  @Get('share/:shareCode')
  async getSavedOutfitByShareCode(
    @Param('shareCode') shareCode: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<SavedOutfitDto>> {
    const actor = extractCartActor(headers);
    const data = await this.cartService.getSavedOutfitByShareCode(shareCode, actor);
    return createApiResponse(data, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }
}
