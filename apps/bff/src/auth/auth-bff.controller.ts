import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Injectable,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { JwtAccessPayload } from '@atelier/contracts';
import type { Request, Response } from 'express';
import { HttpProxyService } from '../common/http-proxy.service';
import { BFF_CONFIG_TOKEN, type BffConfig } from '../config/env';
import { CurrentUser } from '../security/auth-types';
import { CsrfOriginGuard, JwtAuthGuard } from '../security/guards';

@Injectable()
export class AuthProxyService {
  constructor(
    @Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig,
    @Inject(HttpProxyService) private readonly proxy: HttpProxyService,
  ) {}

  async forwardAuth(
    method: string,
    downstreamPath: string,
    req: Request,
    res: Response,
    body?: unknown,
    extraHeaders?: Record<string, string | undefined>,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method,
      url: `${this.config.upstreams.authCustomerUrl}${downstreamPath}`,
      req,
      body,
      extraHeaders,
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  async forwardAuthRedirect(
    downstreamPath: string,
    req: Request,
    res: Response,
  ): Promise<void> {
    const rawOriginal = req.originalUrl || req.url || '';
    const qIdx = rawOriginal.indexOf('?');
    const querySuffix = qIdx >= 0 ? rawOriginal.slice(qIdx) : '';

    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.authCustomerUrl}${downstreamPath}${querySuffix}`,
      req,
      redirect: 'manual',
      disableRetry: true,
    });
    this.proxy.sendProxyResponse(res, upstream);
  }
}

@Controller('bff/v1/auth')
export class StorefrontAuthBffController {
  constructor(@Inject(AuthProxyService) private readonly authProxy: AuthProxyService) {}

  @Get('oauth/providers')
  async oauthProviders(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.authProxy.forwardAuth('GET', '/v1/auth/oauth/providers', req, res);
  }

  @Get('oauth/:provider/start')
  async oauthStart(
    @Param('provider') provider: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.authProxy.forwardAuthRedirect(
      `/v1/auth/oauth/${encodeURIComponent(provider)}/start`,
      req,
      res,
    );
  }

  @Get('oauth/:provider/callback')
  async oauthCallback(
    @Param('provider') provider: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.authProxy.forwardAuthRedirect(
      `/v1/auth/oauth/${encodeURIComponent(provider)}/callback`,
      req,
      res,
    );
  }

  @Post('oauth/exchange')
  async oauthExchange(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/oauth/exchange', req, res, body);
  }

  @Post('register')
  async register(@Req() req: Request, @Res() res: Response, @Body() body: unknown): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/register', req, res, body);
  }

  @Post('login')
  async login(@Req() req: Request, @Res() res: Response, @Body() body: unknown): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/login', req, res, body);
  }

  @Post('refresh')
  @UseGuards(CsrfOriginGuard)
  async refresh(@Req() req: Request, @Res() res: Response, @Body() body: unknown): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/refresh', req, res, body);
  }

  @Post('logout')
  @UseGuards(CsrfOriginGuard)
  async logout(@Req() req: Request, @Res() res: Response, @Body() body: unknown): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/logout', req, res, body);
  }

  @Post('forgot-password')
  async forgotPassword(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/forgot-password', req, res, body);
  }

  @Post('reset-password')
  async resetPassword(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/reset-password', req, res, body);
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/change-password', req, res, body);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.authProxy.forwardAuth('GET', '/v1/auth/me', req, res);
  }

  @Post('2fa/totp/setup')
  @UseGuards(JwtAuthGuard)
  async totpSetup(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/2fa/totp/setup', req, res, body);
  }

  @Post('2fa/totp/verify')
  @UseGuards(JwtAuthGuard)
  async totpVerify(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/2fa/totp/verify', req, res, body);
  }

  @Post('2fa/email-otp/send')
  @UseGuards(JwtAuthGuard)
  async emailOtpSend(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/2fa/email-otp/send', req, res, body);
  }

  @Post('2fa/email-otp/verify')
  @UseGuards(JwtAuthGuard)
  async emailOtpVerify(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/2fa/email-otp/verify', req, res, body);
  }
}

@Controller('api/v1/auth')
export class ApiAuthBffController {
  constructor(@Inject(AuthProxyService) private readonly authProxy: AuthProxyService) {}

  @Get('oauth/providers')
  async oauthProviders(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.authProxy.forwardAuth('GET', '/v1/auth/oauth/providers', req, res);
  }

  @Get('oauth/:provider/start')
  async oauthStart(
    @Param('provider') provider: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.authProxy.forwardAuthRedirect(
      `/v1/auth/oauth/${encodeURIComponent(provider)}/start`,
      req,
      res,
    );
  }

  @Get('oauth/:provider/callback')
  async oauthCallback(
    @Param('provider') provider: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.authProxy.forwardAuthRedirect(
      `/v1/auth/oauth/${encodeURIComponent(provider)}/callback`,
      req,
      res,
    );
  }

  @Post('oauth/exchange')
  async oauthExchange(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/oauth/exchange', req, res, body);
  }

  @Post('register')
  async register(@Req() req: Request, @Res() res: Response, @Body() body: unknown): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/register', req, res, body);
  }

  @Post('login')
  async login(@Req() req: Request, @Res() res: Response, @Body() body: unknown): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/login', req, res, body);
  }

  @Post('refresh')
  @UseGuards(CsrfOriginGuard)
  async refresh(@Req() req: Request, @Res() res: Response, @Body() body: unknown): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/refresh', req, res, body);
  }

  @Post('logout')
  @UseGuards(CsrfOriginGuard)
  async logout(@Req() req: Request, @Res() res: Response, @Body() body: unknown): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/logout', req, res, body);
  }

  @Post('forgot-password')
  async forgotPassword(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/forgot-password', req, res, body);
  }

  @Post('reset-password')
  async resetPassword(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/reset-password', req, res, body);
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/change-password', req, res, body);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.authProxy.forwardAuth('GET', '/v1/auth/me', req, res);
  }

  @Post('2fa/totp/setup')
  @UseGuards(JwtAuthGuard)
  async totpSetup(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/2fa/totp/setup', req, res, body);
  }

  @Post('2fa/totp/verify')
  @UseGuards(JwtAuthGuard)
  async totpVerify(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/2fa/totp/verify', req, res, body);
  }

  @Post('2fa/email-otp/send')
  @UseGuards(JwtAuthGuard)
  async emailOtpSend(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/2fa/email-otp/send', req, res, body);
  }

  @Post('2fa/email-otp/verify')
  @UseGuards(JwtAuthGuard)
  async emailOtpVerify(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    await this.authProxy.forwardAuth('POST', '/v1/auth/2fa/email-otp/verify', req, res, body);
  }
}

@Controller('bff/v1/customers/me')
@UseGuards(JwtAuthGuard)
export class CustomerBffController {
  constructor(@Inject(AuthProxyService) private readonly authProxy: AuthProxyService) {}

  private buildVerifiedIdentityHeaders(
    req: Request,
    user: JwtAccessPayload,
  ): Record<string, string> {
    delete req.headers['x-user-id'];
    delete req.headers['x-actor-roles'];
    delete req.headers['x-supplier-id'];
    delete req.headers['x-internal-secret'];
    return {
      'x-user-id': user.sub,
      'x-actor-roles': user.roles.join(','),
    };
  }

  @Get('body-profile')
  async getBodyProfile(
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    await this.authProxy.forwardAuth(
      'GET',
      '/v1/customers/me/body-profile',
      req,
      res,
      undefined,
      this.buildVerifiedIdentityHeaders(req, user),
    );
  }

  @Put('body-profile')
  async updateBodyProfile(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    await this.authProxy.forwardAuth(
      'PUT',
      '/v1/customers/me/body-profile',
      req,
      res,
      body,
      this.buildVerifiedIdentityHeaders(req, user),
    );
  }

  @Get('addresses')
  async listAddresses(
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    await this.authProxy.forwardAuth(
      'GET',
      '/v1/customers/me/addresses',
      req,
      res,
      undefined,
      this.buildVerifiedIdentityHeaders(req, user),
    );
  }

  @Post('addresses')
  async createAddress(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    await this.authProxy.forwardAuth(
      'POST',
      '/v1/customers/me/addresses',
      req,
      res,
      body,
      this.buildVerifiedIdentityHeaders(req, user),
    );
  }

  @Patch('addresses/:id')
  async updateAddress(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    await this.authProxy.forwardAuth(
      'PATCH',
      `/v1/customers/me/addresses/${encodeURIComponent(id)}`,
      req,
      res,
      body,
      this.buildVerifiedIdentityHeaders(req, user),
    );
  }

  @Delete('addresses/:id')
  async deleteAddress(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    await this.authProxy.forwardAuth(
      'DELETE',
      `/v1/customers/me/addresses/${encodeURIComponent(id)}`,
      req,
      res,
      undefined,
      this.buildVerifiedIdentityHeaders(req, user),
    );
  }

  @Get('tryon-quota')
  async getTryOnQuota(
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    await this.authProxy.forwardAuth(
      'GET',
      '/v1/customers/me/tryon-quota',
      req,
      res,
      undefined,
      this.buildVerifiedIdentityHeaders(req, user),
    );
  }
}

@Controller('api/v1/customers')
@UseGuards(JwtAuthGuard)
export class CustomerProfileApiController {
  constructor(@Inject(AuthProxyService) private readonly authProxy: AuthProxyService) {}

  @Get(':userId/profile')
  async getCustomerProfile(
    @Param('userId') userId: string,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    delete req.headers['x-user-id'];
    delete req.headers['x-actor-roles'];
    delete req.headers['x-supplier-id'];
    delete req.headers['x-internal-secret'];

    await this.authProxy.forwardAuth(
      'GET',
      `/v1/customers/${encodeURIComponent(userId)}/profile`,
      req,
      res,
      undefined,
      {
        'x-user-id': user.sub,
        'x-actor-roles': user.roles.join(','),
      },
    );
  }
}
