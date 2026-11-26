import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  createApiResponse,
  EmailOtpSendRequestSchema,
  LoginRequestSchema,
  OAuthExchangeRequestSchema,
  RegisterRequestSchema,
  TwoFactorMethodSchema,
  type ApiResponse,
  type LoginResponse,
  type OAuthProvidersStatusResponse,
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
import { OAuthService } from '../services/oauth.service';

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
    private readonly oauthService: OAuthService,
  ) {}

  @Get('oauth/providers')
  getOAuthProviders(@Req() req: Request): ApiResponse<OAuthProvidersStatusResponse> {
    const data = this.oauthService.getProvidersStatus();
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Get('oauth/:provider/start')
  async startOAuth(
    @Param('provider') provider: string,
    @Query('portal') portal: string | undefined,
    @Query('returnTo') returnTo: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { redirectUrl } = await this.oauthService.startOAuth({
      providerRaw: provider,
      portalRaw: portal,
      returnToRaw: returnTo,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(HttpStatus.FOUND, redirectUrl);
  }

  @Get('oauth/:provider/callback')
  async handleOAuthCallback(
    @Param('provider') provider: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const { redirectUrl } = await this.oauthService.handleOAuthCallback({
      providerRaw: provider,
      code,
      state,
      error,
      errorDescription,
      req,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(HttpStatus.FOUND, redirectUrl);
  }

  @Post('oauth/exchange')
  @HttpCode(HttpStatus.OK)
  async exchangeOAuthTicket(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<LoginResponse>> {
    const input = parseWithZod(OAuthExchangeRequestSchema, body);
    const data = await this.oauthService.exchangeOAuthTicket(input.ticket, req, res);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

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
