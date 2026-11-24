import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ADMIN_PORTAL_ROLES,
  ErrorCode,
  HTTP_HEADERS,
  McpToolName,
  McpToolSchemas,
  Permission,
  RESTRICTED_COST_FIELDS,
  Role,
  canReadCostPrice,
  hasPermission,
} from '@atelier/contracts';
import {
  TRACEPARENT_HEADER,
  createChildTraceparent,
} from '@atelier/observability';
import type { McpToolDefinition } from '../layer4-mcp-registry';

export interface CallerAuthContext {
  bearerToken: string;
  userId: string;
  roles: readonly Role[];
  supplierId?: string;
  correlationId: string;
  traceparent?: string;
}

export class SuperuserTokenRejectedError extends Error {
  public readonly code = ErrorCode.FORBIDDEN;
  public readonly reason: string;

  constructor(reason: string) {
    super(`Superuser/service bypass token rejected: ${reason}`);
    this.name = 'SuperuserTokenRejectedError';
    this.reason = reason;
  }
}

export class ToolAuthorizationError extends Error {
  public readonly code = ErrorCode.FORBIDDEN;
  public readonly toolName: string;
  public readonly reason: string;
  public readonly missingPermissions: readonly Permission[];

  constructor(
    toolName: string,
    reason: string,
    missingPermissions: readonly Permission[] = [],
  ) {
    super(`Tool "${toolName}" authorization failed: ${reason}`);
    this.name = 'ToolAuthorizationError';
    this.toolName = toolName;
    this.reason = reason;
    this.missingPermissions = missingPermissions;
  }
}

const FORBIDDEN_TOKEN_PATTERNS: readonly RegExp[] = [
  /superuser/i,
  /service[-_]?role/i,
  /service[-_]?bypass/i,
  /root[-_]?bypass/i,
  /admin[-_]?bypass/i,
  /bypass[-_]?rbac/i,
  /system[-_]?override/i,
  /internal[-_]?master/i,
];

function decodeJwtPayloadUnsafe(
  token: string,
): Record<string, unknown> | null {
  const raw = token.replace(/^Bearer\s+/i, '').trim();
  const segments = raw.split('.');
  if (segments.length !== 3 || !segments[1]) {
    return null;
  }
  try {
    const base64 = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function assertNoSuperuserToken(token: string): void {
  const normalized = (token ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!normalized) {
    throw new SuperuserTokenRejectedError('Missing caller Bearer JWT token.');
  }

  for (const pattern of FORBIDDEN_TOKEN_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new SuperuserTokenRejectedError(
        `Token matched forbidden service/superuser bypass signature (${pattern.source}).`,
      );
    }
  }

  const payload = decodeJwtPayloadUnsafe(normalized);
  if (payload) {
    const suspiciousBooleans = [
      'isSuperuserBypass',
      'bypassRbac',
      'serviceBypass',
      'superuserBypass',
      'skipAuthz',
    ];
    for (const key of suspiciousBooleans) {
      if (payload[key] === true) {
        throw new SuperuserTokenRejectedError(
          `JWT claim "${key}=true" is strictly prohibited in pass-through context.`,
        );
      }
    }

    const tokenType = String(payload.tokenType ?? payload.typ ?? '').toUpperCase();
    if (
      tokenType === 'SERVICE_BYPASS' ||
      tokenType === 'SUPERUSER_BYPASS' ||
      tokenType === 'ROOT_SERVICE'
    ) {
      throw new SuperuserTokenRejectedError(
        `JWT tokenType "${tokenType}" is not permitted.`,
      );
    }

    const subject = String(payload.sub ?? '').toLowerCase();
    if (
      subject === 'root' ||
      subject === 'superuser-bypass' ||
      subject === 'service-account-superuser' ||
      subject === 'system-bypass'
    ) {
      throw new SuperuserTokenRejectedError(
        `JWT subject "${subject}" is not permitted.`,
      );
    }

    const scopeStr = String(payload.scope ?? '');
    if (/superuser|bypass|service_role/i.test(scopeStr)) {
      throw new SuperuserTokenRejectedError(
        `JWT scope "${scopeStr}" attempts privilege bypass.`,
      );
    }
  }
}

export class JwtPassThroughContext {
  private readonly storage = new AsyncLocalStorage<CallerAuthContext>();

  public run<T>(context: CallerAuthContext, callback: () => T): T {
    assertNoSuperuserToken(context.bearerToken);

    const normalizedToken = context.bearerToken.startsWith('Bearer ')
      ? context.bearerToken
      : `Bearer ${context.bearerToken}`;

    const frozenContext: CallerAuthContext = Object.freeze({
      ...context,
      bearerToken: normalizedToken,
      roles: Object.freeze([...context.roles]),
    });

    return this.storage.run(frozenContext, callback);
  }

  public get(): CallerAuthContext | undefined {
    return this.storage.getStore();
  }

  public getOrThrow(): CallerAuthContext {
    const store = this.storage.getStore();
    if (!store) {
      throw new Error(
        'JwtPassThroughContext is not active for the current async execution.',
      );
    }
    return store;
  }

  public buildForwardHeaders(
    extraHeaders: Record<string, string> = {},
  ): Record<string, string> {
    const ctx = this.getOrThrow();
    assertNoSuperuserToken(ctx.bearerToken);

    const headers: Record<string, string> = {
      ...extraHeaders,
      [HTTP_HEADERS.AUTHORIZATION]: ctx.bearerToken,
      [HTTP_HEADERS.CORRELATION_ID]: ctx.correlationId,
    };

    if (ctx.traceparent) {
      headers[TRACEPARENT_HEADER] = createChildTraceparent(ctx.traceparent);
    }

    return headers;
  }
}

export interface ToolAuthorizationDecision {
  allowed: boolean;
  toolName: string;
  code?: ErrorCode;
  reason: string;
  missingPermissions: Permission[];
}

export type AuthorizableTool =
  | McpToolName
  | Pick<
      McpToolDefinition,
      'name' | 'scope' | 'allowedRoles' | 'requiredPermissions'
    >;

function isKnownMcpToolName(value: string): value is McpToolName {
  return Object.values(McpToolName).includes(value as McpToolName);
}

export function authorizeToolCall(
  tool: AuthorizableTool,
  context: CallerAuthContext,
): ToolAuthorizationDecision {
  const toolName = typeof tool === 'string' ? tool : tool.name;

  try {
    assertNoSuperuserToken(context.bearerToken);
  } catch (error) {
    return {
      allowed: false,
      toolName,
      code: ErrorCode.FORBIDDEN,
      reason:
        error instanceof Error
          ? error.message
          : 'Superuser/service bypass token rejected.',
      missingPermissions: [],
    };
  }

  if (!context.roles || context.roles.length === 0) {
    return {
      allowed: false,
      toolName,
      code: ErrorCode.FORBIDDEN,
      reason: 'Caller has no assigned RBAC roles.',
      missingPermissions: [],
    };
  }

  let audience: 'ADMIN' | 'CUSTOMER';
  let requiredPermissions: readonly Permission[];
  let allowedRoles: readonly string[] | undefined;

  if (typeof tool === 'string') {
    if (!isKnownMcpToolName(tool)) {
      return {
        allowed: false,
        toolName,
        code: ErrorCode.NOT_FOUND,
        reason: `Unknown MCP tool "${tool}".`,
        missingPermissions: [],
      };
    }
    const schemaDef = McpToolSchemas[tool];
    audience = schemaDef.audience;
    requiredPermissions = schemaDef.requiredPermissions;
  } else {
    audience = tool.scope;
    requiredPermissions = tool.requiredPermissions as readonly Permission[];
    allowedRoles = tool.allowedRoles;
  }

  if (audience === 'ADMIN') {
    const hasAdminPortalRole = context.roles.some((role) =>
      ADMIN_PORTAL_ROLES.includes(role),
    );
    if (!hasAdminPortalRole) {
      return {
        allowed: false,
        toolName,
        code: ErrorCode.FORBIDDEN,
        reason: `Roles [${context.roles.join(', ')}] are strictly blocked from ADMIN MCP tool "${toolName}".`,
        missingPermissions: [...requiredPermissions],
      };
    }
  }

  if (allowedRoles && allowedRoles.length > 0) {
    const rolePermitted = context.roles.some((role) =>
      allowedRoles.includes(role),
    );
    if (!rolePermitted) {
      return {
        allowed: false,
        toolName,
        code: ErrorCode.FORBIDDEN,
        reason: `Roles [${context.roles.join(', ')}] are not in allowedRoles [${allowedRoles.join(', ')}] for "${toolName}".`,
        missingPermissions: [...requiredPermissions],
      };
    }
  }

  const missingPermissions = requiredPermissions.filter(
    (perm) => !hasPermission(context.roles, perm),
  );

  if (missingPermissions.length > 0) {
    return {
      allowed: false,
      toolName,
      code: ErrorCode.FORBIDDEN,
      reason: `Caller lacks required permissions [${missingPermissions.join(', ')}] for tool "${toolName}".`,
      missingPermissions,
    };
  }

  return {
    allowed: true,
    toolName,
    reason: 'Authorized via caller RBAC roles and fine-grained permissions.',
    missingPermissions: [],
  };
}

export function assertAuthorizedToolCall(
  tool: AuthorizableTool,
  context: CallerAuthContext,
): void {
  const decision = authorizeToolCall(tool, context);
  if (!decision.allowed) {
    throw new ToolAuthorizationError(
      decision.toolName,
      decision.reason,
      decision.missingPermissions,
    );
  }
}

const RESTRICTED_FIELD_SET: ReadonlySet<string> = new Set([
  ...RESTRICTED_COST_FIELDS,
  'cost_price',
  'costPrice',
  'costPriceVnd',
  'cost_price_vnd',
  'giaNhap',
  'gia_nhap',
  'cogs',
  'unitCostVnd',
  'unit_cost_vnd',
  'estimatedCostVnd',
  'estimated_cost_vnd',
  'totalCostVnd',
  'total_cost_vnd',
  'lineCostVnd',
  'line_cost_vnd',
]);

function isRestrictedFieldKey(key: string): boolean {
  if (RESTRICTED_FIELD_SET.has(key)) {
    return true;
  }
  const lower = key.toLowerCase();
  return (
    lower === 'cost_price' ||
    lower === 'costprice' ||
    lower === 'costpricevnd' ||
    lower === 'cost_price_vnd' ||
    lower === 'unitcostvnd' ||
    lower === 'unit_cost_vnd' ||
    lower === 'totalcostvnd' ||
    lower === 'total_cost_vnd' ||
    lower === 'linecostvnd' ||
    lower === 'line_cost_vnd' ||
    lower === 'estimatedcostvnd' ||
    lower === 'estimated_cost_vnd' ||
    lower === 'gianhap' ||
    lower === 'gia_nhap' ||
    lower === 'cogs'
  );
}

function stripRestrictedRecursive(
  value: unknown,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((item) => stripRestrictedRecursive(item, seen));
    }

    const record = value as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};

    for (const [key, entryValue] of Object.entries(record)) {
      if (isRestrictedFieldKey(key)) {
        continue;
      }
      cleaned[key] = stripRestrictedRecursive(entryValue, seen);
    }

    return cleaned;
  } finally {
    seen.delete(value);
  }
}

export function canRolesReadCostFields(
  roles: readonly Role[] | Role,
): boolean {
  const roleList = Array.isArray(roles) ? roles : [roles];
  if (
    roleList.includes(Role.SUPER_ADMIN) ||
    roleList.includes(Role.WAREHOUSE_MANAGER)
  ) {
    return true;
  }
  return canReadCostPrice(roleList);
}

export function redactRestrictedFields<T>(
  payload: T,
  roles: readonly Role[] | Role,
): T {
  if (canRolesReadCostFields(roles)) {
    return payload;
  }
  return stripRestrictedRecursive(payload, new WeakSet<object>()) as T;
}
