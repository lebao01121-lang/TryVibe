import { z } from 'zod';
import { PermissionSchema, Role, RoleSchema } from './rbac';

export const UserStatus = {
  ACTIVE: 'ACTIVE',
  LOCKED: 'LOCKED',
  PENDING: 'PENDING',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];
export const UserStatusSchema = z.enum([UserStatus.ACTIVE, UserStatus.LOCKED, UserStatus.PENDING]);

export const LoyaltyTier = {
  BRONZE: 'BRONZE',
  SILVER: 'SILVER',
  GOLD: 'GOLD',
  DIAMOND: 'DIAMOND',
} as const;
export type LoyaltyTier = (typeof LoyaltyTier)[keyof typeof LoyaltyTier];
export const LoyaltyTierSchema = z.enum([
  LoyaltyTier.BRONZE,
  LoyaltyTier.SILVER,
  LoyaltyTier.GOLD,
  LoyaltyTier.DIAMOND,
]);

export const TwoFactorMethod = {
  TOTP: 'TOTP',
  EMAIL_OTP: 'EMAIL_OTP',
} as const;
export type TwoFactorMethod = (typeof TwoFactorMethod)[keyof typeof TwoFactorMethod];
export const TwoFactorMethodSchema = z.enum([TwoFactorMethod.TOTP, TwoFactorMethod.EMAIL_OTP]);

export const FitPreference = {
  SLIM: 'SLIM',
  REGULAR: 'REGULAR',
  RELAXED: 'RELAXED',
} as const;
export type FitPreference = (typeof FitPreference)[keyof typeof FitPreference];
export const FitPreferenceSchema = z.enum([
  FitPreference.SLIM,
  FitPreference.REGULAR,
  FitPreference.RELAXED,
]);

export const AuditActorType = {
  USER: 'USER',
  AI_COPILOT: 'AI_COPILOT',
  SYSTEM: 'SYSTEM',
} as const;
export type AuditActorType = (typeof AuditActorType)[keyof typeof AuditActorType];
export const AuditActorTypeSchema = z.enum([
  AuditActorType.USER,
  AuditActorType.AI_COPILOT,
  AuditActorType.SYSTEM,
]);

export const MFA_REQUIRED_ROLES: readonly Role[] = [
  Role.SUPER_ADMIN,
  Role.WAREHOUSE_MANAGER,
  Role.SUPPLIER,
] as const;

export function isMfaRequiredForRoles(roles: readonly Role[] | Role): boolean {
  const roleList: readonly Role[] = typeof roles === 'string' ? [roles] : roles;
  return roleList.some((role) => MFA_REQUIRED_ROLES.includes(role));
}

export const JwtAccessPayloadSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  roles: z.array(RoleSchema),
  permissions: z.array(PermissionSchema),
  permissionVersion: z.number().int().nonnegative(),
  mfaVerified: z.boolean(),
  supplierId: z.string().min(1).nullable(),
  loyaltyTier: LoyaltyTierSchema,
  jti: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type JwtAccessPayload = z.infer<typeof JwtAccessPayloadSchema>;

export const UserSummaryDtoSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  fullName: z.string().min(1),
  phone: z.string().nullable().optional(),
  status: UserStatusSchema,
  roles: z.array(RoleSchema),
  permissions: z.array(PermissionSchema),
  permissionVersion: z.number().int().nonnegative(),
  mfaEnabled: z.boolean(),
  mfaVerified: z.boolean().optional(),
  supplierId: z.string().nullable(),
  loyaltyTier: LoyaltyTierSchema,
  createdAt: z.string(),
  updatedAt: z.string().optional(),
});
export type UserSummaryDto = z.infer<typeof UserSummaryDtoSchema>;

export const RegisterRequestSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8).max(128),
  fullName: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(8).max(20).optional(),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(128),
  totpCode: z.string().trim().min(4).max(16).optional(),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  accessToken: z.string().min(1),
  csrfToken: z.string().min(1),
  mfaRequired: z.boolean(),
  user: UserSummaryDtoSchema,
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const RefreshResponseSchema = z.object({
  accessToken: z.string().min(1),
  csrfToken: z.string().min(1),
  user: UserSummaryDtoSchema.optional(),
});
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;

export const TotpSetupResponseSchema = z.object({
  secret: z.string().min(1),
  otpauthUri: z.string().min(1),
  qrSvgDataUrl: z.string().min(1),
  recoveryCodes: z.array(z.string().min(1)).min(1),
});
export type TotpSetupResponse = z.infer<typeof TotpSetupResponseSchema>;

export const TwoFactorVerifyRequestSchema = z.object({
  method: TwoFactorMethodSchema,
  code: z.string().trim().min(4).max(32),
});
export type TwoFactorVerifyRequest = z.infer<typeof TwoFactorVerifyRequestSchema>;

export const EmailOtpSendRequestSchema = z.object({
  email: z.string().trim().email().optional(),
  purpose: z.enum(['MFA_LOGIN', 'VERIFY_EMAIL', 'STEP_UP']).default('MFA_LOGIN'),
});
export type EmailOtpSendRequest = z.infer<typeof EmailOtpSendRequestSchema>;

export const CustomerBodyProfileDtoSchema = z.object({
  userId: z.string().min(1).optional(),
  heightCm: z.number().min(120).max(230),
  weightKg: z.number().min(25).max(200),
  bustCm: z.number().min(50).max(180).nullable().optional(),
  waistCm: z.number().min(40).max(170).nullable().optional(),
  hipCm: z.number().min(50).max(190).nullable().optional(),
  shoulderCm: z.number().min(28).max(70).nullable().optional(),
  fitPreference: FitPreferenceSchema,
  updatedAt: z.string(),
});
export type CustomerBodyProfileDto = z.infer<typeof CustomerBodyProfileDtoSchema>;

export const UpdateBodyProfileRequestSchema = z.object({
  heightCm: z.number().min(120).max(230),
  weightKg: z.number().min(25).max(200),
  bustCm: z.number().min(50).max(180).nullable().optional(),
  waistCm: z.number().min(40).max(170).nullable().optional(),
  hipCm: z.number().min(50).max(190).nullable().optional(),
  shoulderCm: z.number().min(28).max(70).nullable().optional(),
  fitPreference: FitPreferenceSchema.default(FitPreference.REGULAR),
});
export type UpdateBodyProfileRequest = z.infer<typeof UpdateBodyProfileRequestSchema>;

export const CustomerAddressDtoSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  recipientName: z.string().min(1),
  phone: z.string().min(8).max(20),
  provinceCode: z.string().min(1),
  provinceName: z.string().min(1),
  districtCode: z.string().min(1),
  districtName: z.string().min(1),
  wardCode: z.string().min(1),
  wardName: z.string().min(1),
  streetLine: z.string().min(1),
  isDefault: z.boolean(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type CustomerAddressDto = z.infer<typeof CustomerAddressDtoSchema>;

export const CreateCustomerAddressSchema = z.object({
  recipientName: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(8).max(20),
  provinceCode: z.string().trim().min(1).max(32),
  provinceName: z.string().trim().min(1).max(120),
  districtCode: z.string().trim().min(1).max(32),
  districtName: z.string().trim().min(1).max(120),
  wardCode: z.string().trim().min(1).max(32),
  wardName: z.string().trim().min(1).max(120),
  streetLine: z.string().trim().min(1).max(255),
  isDefault: z.boolean().default(false),
});
export type CreateCustomerAddressRequest = z.infer<typeof CreateCustomerAddressSchema>;

export const UpdateCustomerAddressSchema = CreateCustomerAddressSchema.partial();
export type UpdateCustomerAddressRequest = z.infer<typeof UpdateCustomerAddressSchema>;

export const TryOnQuotaDtoSchema = z.object({
  userId: z.string().min(1),
  loyaltyTier: LoyaltyTierSchema,
  dailyLimit: z.number().int().nonnegative(),
  usedToday: z.number().int().nonnegative(),
  remainingToday: z.number().int().nonnegative(),
  resetAt: z.string(),
});
export type TryOnQuotaDto = z.infer<typeof TryOnQuotaDtoSchema>;

export const UpdateUserRolesSchema = z.object({
  roles: z.array(RoleSchema).min(1),
  supplierId: z.string().min(1).nullable().optional(),
});
export type UpdateUserRolesRequest = z.infer<typeof UpdateUserRolesSchema>;

export const UpdateUserStatusSchema = z.object({
  status: UserStatusSchema,
  reason: z.string().max(300).optional(),
});
export type UpdateUserStatusRequest = z.infer<typeof UpdateUserStatusSchema>;

export const RoleWithPermissionsDtoSchema = z.object({
  role: RoleSchema,
  permissions: z.array(PermissionSchema),
  description: z.string().optional(),
});
export type RoleWithPermissionsDto = z.infer<typeof RoleWithPermissionsDtoSchema>;

export const UpdateRolePermissionsSchema = z.object({
  permissions: z.array(PermissionSchema),
});
export type UpdateRolePermissionsRequest = z.infer<typeof UpdateRolePermissionsSchema>;

export const AuditLogDtoSchema = z.object({
  id: z.string().min(1),
  actorId: z.string().nullable(),
  actorEmail: z.string().nullable().optional(),
  actorType: AuditActorTypeSchema,
  action: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: z.string().nullable(),
  correlationId: z.string().nullable(),
  ipAddress: z.string().nullable().optional(),
  metadata: z.record(z.unknown()),
  createdAt: z.string(),
});
export type AuditLogDto = z.infer<typeof AuditLogDtoSchema>;

export const CreateAuditLogInputSchema = z.object({
  actorId: z.string().nullable().optional(),
  actorEmail: z.string().nullable().optional(),
  actorType: AuditActorTypeSchema,
  action: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: z.string().nullable().optional(),
  correlationId: z.string().nullable().optional(),
  ipAddress: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type CreateAuditLogInput = z.infer<typeof CreateAuditLogInputSchema>;
