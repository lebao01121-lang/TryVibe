import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  createApiResponse,
  CreateCustomerAddressSchema,
  ErrorCode,
  Role,
  UpdateBodyProfileRequestSchema,
  UpdateCustomerAddressSchema,
  type ApiResponse,
  type CustomerAddressDto,
  type CustomerBodyProfileDto,
  type UserSummaryDto,
} from '@atelier/contracts';
import {
  ApiDomainException,
  getCorrelationIdFromRequest,
  parseWithZod,
} from '../common/api-exception';
import { SERVICE_NAME } from '../config/env';
import { AuthService } from '../services/auth.service';
import { CustomerService, type TryOnQuotaViewDto } from '../services/customer.service';

export interface CustomerFullProfileDto {
  user: UserSummaryDto;
  bodyProfile: CustomerBodyProfileDto | null;
  addresses: CustomerAddressDto[];
  tryonQuota: TryOnQuotaViewDto;
}

@Controller('v1')
export class CustomerController {
  constructor(
    private readonly authService: AuthService,
    private readonly customerService: CustomerService,
  ) {}

  @Get(['customers/me/body-profile', 'me/body-profile'])
  async getBodyProfile(
    @Req() req: Request,
  ): Promise<ApiResponse<CustomerBodyProfileDto | null>> {
    const authUser = await this.authService.authenticateRequest(req);
    const data = await this.customerService.getBodyProfile(authUser.sub);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Put(['customers/me/body-profile', 'me/body-profile'])
  async putBodyProfile(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<CustomerBodyProfileDto>> {
    const authUser = await this.authService.authenticateRequest(req);
    const input = parseWithZod(UpdateBodyProfileRequestSchema, body);
    const data = await this.customerService.upsertBodyProfile(authUser.sub, input);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Get(['customers/me/addresses', 'me/addresses'])
  async listAddresses(@Req() req: Request): Promise<ApiResponse<CustomerAddressDto[]>> {
    const authUser = await this.authService.authenticateRequest(req);
    const data = await this.customerService.listAddresses(authUser.sub);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post(['customers/me/addresses', 'me/addresses'])
  @HttpCode(HttpStatus.CREATED)
  async createAddress(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<CustomerAddressDto>> {
    const authUser = await this.authService.authenticateRequest(req);
    const input = parseWithZod(CreateCustomerAddressSchema, body);
    const data = await this.customerService.createAddress(authUser.sub, input);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Patch(['customers/me/addresses/:id', 'me/addresses/:id'])
  async updateAddress(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<CustomerAddressDto>> {
    const authUser = await this.authService.authenticateRequest(req);
    const input = parseWithZod(UpdateCustomerAddressSchema, body);
    const data = await this.customerService.updateAddress(authUser.sub, id, input);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Delete(['customers/me/addresses/:id', 'me/addresses/:id'])
  async deleteAddress(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<ApiResponse<{ deleted: true; id: string }>> {
    const authUser = await this.authService.authenticateRequest(req);
    const data = await this.customerService.deleteAddress(authUser.sub, id);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Get('customers/me/tryon-quota')
  async getTryOnQuota(@Req() req: Request): Promise<ApiResponse<TryOnQuotaViewDto>> {
    const authUser = await this.authService.authenticateRequest(req);
    const data = await this.customerService.getTryOnQuota(authUser.sub);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  /**
   * Strict IDOR-protected customer profile endpoint:
   * Only the owner (`req.user.sub === userId`) or `SUPER_ADMIN` may read;
   * cross-customer requests strictly receive `403 Forbidden`.
   */
  @Get('customers/:userId/profile')
  async getCustomerProfileById(
    @Param('userId') userId: string,
    @Req() req: Request,
  ): Promise<ApiResponse<CustomerFullProfileDto>> {
    const authUser = await this.authService.authenticateRequest(req);
    const isSelf = authUser.sub === userId;
    const isSuperAdmin = authUser.roles.includes(Role.SUPER_ADMIN);

    if (!isSelf && !isSuperAdmin) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Bạn không có quyền truy cập hồ sơ của khách hàng khác.',
      );
    }

    const user = await this.authService.loadUserSummaryById(userId);
    if (!user) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'Không tìm thấy hồ sơ khách hàng.',
      );
    }

    const [bodyProfile, addresses, tryonQuota] = await Promise.all([
      this.customerService.getBodyProfile(userId),
      this.customerService.listAddresses(userId),
      this.customerService.getTryOnQuota(userId),
    ]);

    return createApiResponse(
      { user, bodyProfile, addresses, tryonQuota },
      {
        correlationId: getCorrelationIdFromRequest(req),
        service: SERVICE_NAME,
      },
    );
  }
}
