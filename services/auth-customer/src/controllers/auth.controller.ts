import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  createApiResponse,
  EmailOtpSendRequestSchema,
  LoginRequestSchema,
  RegisterRequestSchema,
  TwoFactorMethodSchema,
  type ApiResponse,
  type LoginResponse,
  type RefreshResponse,
  type TotpSetupResponse,
  type UserSummaryDto,
} from '@atelier/contracts';
import { getCorrelationIdFromRequest, parseWithZod } from '../common/api-exception';
import { SERVICE_NAME } from '../config/env';
import {
  AuthService,
  type ChangePasswordResponse,
  type ForgotPasswordResponse,
  type ResetPasswordResponse,
  type TwoFactorVerifyResponse,
} from '../services/auth.service';
import { CustomerService, type TryOnQuotaViewDto } from '../services/customer.service';

const FlexibleTwoFactorVerifySchema = z.object({
  method: TwoFactorMethodSchema.optional(),
  code: z.string().trim().min(4).max(32),
});

const ForgotPasswordRequestSchema = z.object({
  email: z.string().trim().email().max(255),
});

const ResetPasswordRequestSchema = z
  .object({
    email: z.string().trim().email().max(255).optional(),
    code: z.string().trim().min(4).max(128).optional(),
    otp: z.string().trim().min(4).max(128).optional(),
    token: z.string().trim().min(4).max(256).optional(),
    newPassword: z.string().min(8).max(128),
  })
  .refine((data) => Boolean(data.code || data.otp || data.token), {
    message: 'Vui lòng cung cấp mã xác thực (code) hoặc token khôi phục.',
  });

const ChangePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(128).optional(),
    oldPassword: z.string().min(1).max(128).optional(),
    newPassword: z.string().min(8).max(128),
  })
  .refine((data) => Boolean(data.currentPassword || data.oldPassword), {
    message: 'Vui lòng cung cấp mật khẩu hiện tại (currentPassword).',
  })
  .transform((data) => ({
    currentPassword: (data.currentPassword ?? data.oldPassword) as string,
    newPassword: data.newPassword,
  }));

@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly customerService: CustomerService,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<LoginResponse>> {
    const input = parseWithZod(RegisterRequestSchema, body);
    const data = await this.authService.register(input, req, res);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<LoginResponse>> {
    const input = parseWithZod(LoginRequestSchema, body);
    const data = await this.authService.login(input, req, res);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<RefreshResponse>> {
    const data = await this.authService.refresh(req, res);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<{ loggedOut: boolean }>> {
    const data = await this.authService.logout(req, res);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<ForgotPasswordResponse>> {
    const input = parseWithZod(ForgotPasswordRequestSchema, body);
    const data = await this.authService.forgotPassword(input, req);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<ResetPasswordResponse>> {
    const input = parseWithZod(ResetPasswordRequestSchema, body);
    const data = await this.authService.resetPassword(input, req, res);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<ChangePasswordResponse>> {
    const authUser = await this.authService.authenticateRequest(req);
    const input = parseWithZod(ChangePasswordRequestSchema, body);
    const data = await this.authService.changePassword(authUser, input, req, res);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Get('me')
  async getMe(
    @Req() req: Request,
  ): Promise<ApiResponse<UserSummaryDto & { tryonQuota: TryOnQuotaViewDto }>> {
    const authUser = await this.authService.authenticateRequest(req);
    const [user, tryonQuota] = await Promise.all([
      this.authService.getMe(authUser),
      this.customerService.getTryOnQuota(authUser.sub),
    ]);
    return createApiResponse(
      { ...user, tryonQuota },
      {
        correlationId: getCorrelationIdFromRequest(req),
        service: SERVICE_NAME,
      },
    );
  }

  @Get('tryon-quota')
  async getTryOnQuota(@Req() req: Request): Promise<ApiResponse<TryOnQuotaViewDto>> {
    const authUser = await this.authService.authenticateRequest(req);
    const data = await this.customerService.getTryOnQuota(authUser.sub);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post('2fa/totp/setup')
  @HttpCode(HttpStatus.OK)
  async setupTotp(@Req() req: Request): Promise<ApiResponse<TotpSetupResponse>> {
    const authUser = await this.authService.authenticateRequest(req);
    const data = await this.authService.setupTotp(authUser);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post('2fa/totp/verify')
  @HttpCode(HttpStatus.OK)
  async verifyTotp(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<TwoFactorVerifyResponse>> {
    const authUser = await this.authService.authenticateRequest(req);
    const input = parseWithZod(FlexibleTwoFactorVerifySchema, body);
    const data = await this.authService.verifyTotp(authUser, input.code, req, res);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post('2fa/email-otp/send')
  @HttpCode(HttpStatus.OK)
  async sendEmailOtp(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<
    ApiResponse<{
      sent: boolean;
      maskedEmail: string;
      expiresInSeconds: number;
      purpose: string;
    }>
  > {
    const authUser = await this.authService.authenticateRequest(req);
    const input = parseWithZod(EmailOtpSendRequestSchema, body ?? {});
    const data = await this.authService.sendEmailOtp(authUser, input.purpose);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post('2fa/email-otp/verify')
  @HttpCode(HttpStatus.OK)
  async verifyEmailOtp(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<TwoFactorVerifyResponse>> {
    const authUser = await this.authService.authenticateRequest(req);
    const input = parseWithZod(FlexibleTwoFactorVerifySchema, body);
    const data = await this.authService.verifyEmailOtp(authUser, input.code, req, res);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }
}
