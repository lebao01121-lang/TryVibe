import { Module } from '@nestjs/common';
import { AUTH_CONFIG_TOKEN, loadAuthCustomerConfig } from './config/env';
import { AuthController } from './controllers/auth.controller';
import { CustomerController } from './controllers/customer.controller';
import { IamController } from './controllers/iam.controller';
import { InternalAuthController } from './controllers/internal-auth.controller';
import { JwksService } from './crypto/jwks.service';
import { DatabaseService } from './infra/database.service';
import { MailService } from './infra/mail.service';
import { AuthRedisService } from './infra/redis.service';
import { AuthCustomerController } from './service.controller';
import { AuditService } from './services/audit.service';
import { AuthService } from './services/auth.service';
import { CustomerService } from './services/customer.service';
import { IamService } from './services/iam.service';
import { OAuthService } from './services/oauth.service';

@Module({
  controllers: [
    AuthCustomerController,
    AuthController,
    CustomerController,
    IamController,
    InternalAuthController,
  ],
  providers: [
    {
      provide: AUTH_CONFIG_TOKEN,
      useFactory: () => loadAuthCustomerConfig(),
    },
    AuthRedisService,
    DatabaseService,
    JwksService,
    MailService,
    AuditService,
    AuthService,
    OAuthService,
    CustomerService,
    IamService,
  ],
})
export class AppModule {}
