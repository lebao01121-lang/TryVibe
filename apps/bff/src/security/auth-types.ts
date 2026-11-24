import {
  createParamDecorator,
  SetMetadata,
  type CustomDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { JwtAccessPayload, Permission } from '@atelier/contracts';
import type { Request } from 'express';

export interface AuthenticatedRequest extends Request {
  user?: JwtAccessPayload;
  correlationId?: string;
}

export const REQUIRED_PERMISSIONS_METADATA_KEY = 'atelier:required_permissions';
export const REQUIRED_ANY_PERMISSIONS_METADATA_KEY = 'atelier:required_any_permissions';

export function RequirePermissions(
  ...permissions: Permission[]
): CustomDecorator<string> {
  return SetMetadata(REQUIRED_PERMISSIONS_METADATA_KEY, permissions);
}

export function RequireAnyPermission(
  ...permissions: Permission[]
): CustomDecorator<string> {
  return SetMetadata(REQUIRED_ANY_PERMISSIONS_METADATA_KEY, permissions);
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtAccessPayload => {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.user) {
      throw new Error('CurrentUser decorator used on an unauthenticated route.');
    }
    return req.user;
  },
);
