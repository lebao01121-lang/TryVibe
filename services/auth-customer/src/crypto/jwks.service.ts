import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import {
  JwtAccessPayloadSchema,
  type JwtAccessPayload,
  type LoyaltyTier,
  type Permission,
  type Role,
} from '@atelier/contracts';
import { createLogger } from '@atelier/observability';
import { AUTH_CONFIG_TOKEN, type AuthCustomerConfig } from '../config/env';

export interface PublicRsaJwk {
  kty: 'RSA';
  use: 'sig';
  alg: 'RS256';
  kid: string;
  n: string;
  e: string;
}

export interface JwksDocument {
  keys: PublicRsaJwk[];
}

export interface SignAccessTokenInput {
  sub: string;
  email: string;
  roles: Role[];
  permissions: Permission[];
  permissionVersion: number;
  mfaVerified: boolean;
  supplierId: string | null;
  loyaltyTier: LoyaltyTier;
}

export interface SignedAccessTokenResult {
  token: string;
  payload: JwtAccessPayload;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

function base64UrlDecodeToBuffer(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function generateOpaqueToken(byteLength: number = 48): string {
  return crypto.randomBytes(byteLength).toString('base64url');
}

export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function constantTimeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

@Injectable()
export class JwksService implements OnModuleInit {
  private readonly logger = createLogger('@atelier/auth-customer:jwks');
  private privateKey!: crypto.KeyObject;
  private publicKey!: crypto.KeyObject;
  private kid!: string;
  private publicJwk!: PublicRsaJwk;
  private initialized = false;

  constructor(@Inject(AUTH_CONFIG_TOKEN) private readonly config: AuthCustomerConfig) {}

  onModuleInit(): void {
    this.ensureKeysLoaded();
  }

  ensureKeysLoaded(): void {
    if (this.initialized) {
      return;
    }

    const keyDir = this.config.jwt.keyDir;
    const privatePemPath = path.join(keyDir, 'private.pem');
    const publicPemPath = path.join(keyDir, 'public.pem');
    const kidPath = path.join(keyDir, 'kid.txt');

    fs.mkdirSync(keyDir, { recursive: true });

    let privatePem: string | null = null;
    let publicPem: string | null = null;
    let loadedKid: string | null = null;

    if (fs.existsSync(privatePemPath) && fs.existsSync(publicPemPath) && fs.existsSync(kidPath)) {
      try {
        privatePem = fs.readFileSync(privatePemPath, 'utf8');
        publicPem = fs.readFileSync(publicPemPath, 'utf8');
        loadedKid = fs.readFileSync(kidPath, 'utf8').trim();
        this.privateKey = crypto.createPrivateKey(privatePem);
        this.publicKey = crypto.createPublicKey(publicPem);
        if (!loadedKid) {
          throw new Error('Empty kid.txt');
        }
        this.kid = loadedKid;
      } catch (error) {
        this.logger.warn(
          { err: error, keyDir },
          'Existing RS256 keypair invalid; regenerating 2048-bit RSA keypair',
        );
        privatePem = null;
        publicPem = null;
        loadedKid = null;
      }
    }

    if (!privatePem || !publicPem || !loadedKid) {
      const pair = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: {
          type: 'spki',
          format: 'pem',
        },
        privateKeyEncoding: {
          type: 'pkcs8',
          format: 'pem',
        },
      });

      const normalizedPrivate = pair.privateKey.replace(/\r\n/g, '\n');
      const normalizedPublic = pair.publicKey.replace(/\r\n/g, '\n');
      const generatedKid = `atelier-rs256-${sha256Hex(normalizedPublic).slice(0, 16)}`;

      fs.writeFileSync(privatePemPath, normalizedPrivate, { encoding: 'utf8', mode: 0o600 });
      fs.writeFileSync(publicPemPath, normalizedPublic, { encoding: 'utf8', mode: 0o644 });
      fs.writeFileSync(kidPath, `${generatedKid}\n`, { encoding: 'utf8', mode: 0o644 });

      this.privateKey = crypto.createPrivateKey(normalizedPrivate);
      this.publicKey = crypto.createPublicKey(normalizedPublic);
      this.kid = generatedKid;

      this.logger.info({ kid: this.kid, keyDir }, 'Generated persistent RS256 2048-bit JWT keypair');
    } else {
      this.logger.info({ kid: this.kid, keyDir }, 'Loaded persistent RS256 2048-bit JWT keypair');
    }

    const exportedJwk = this.publicKey.export({ format: 'jwk' }) as {
      kty?: string;
      n?: string;
      e?: string;
    };

    if (exportedJwk.kty !== 'RSA' || !exportedJwk.n || !exportedJwk.e) {
      throw new Error('Failed to export valid RSA public JWK.');
    }

    this.publicJwk = {
      kty: 'RSA',
      use: 'sig',
      alg: 'RS256',
      kid: this.kid,
      n: exportedJwk.n,
      e: exportedJwk.e,
    };

    this.initialized = true;
  }

  getKid(): string {
    this.ensureKeysLoaded();
    return this.kid;
  }

  getJwks(): JwksDocument {
    this.ensureKeysLoaded();
    return {
      keys: [this.publicJwk],
    };
  }

  signAccessToken(input: SignAccessTokenInput): SignedAccessTokenResult {
    this.ensureKeysLoaded();

    const nowSec = Math.floor(Date.now() / 1000);
    const payload: JwtAccessPayload = {
      sub: input.sub,
      email: input.email,
      roles: [...input.roles],
      permissions: [...input.permissions],
      permissionVersion: input.permissionVersion,
      mfaVerified: input.mfaVerified,
      supplierId: input.supplierId,
      loyaltyTier: input.loyaltyTier,
      jti: crypto.randomUUID(),
      iat: nowSec,
      exp: nowSec + this.config.jwt.accessTtlSeconds,
    };

    const header = {
      alg: 'RS256',
      typ: 'JWT',
      kid: this.kid,
    };

    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), this.privateKey);
    const token = `${signingInput}.${base64UrlEncode(signature)}`;

    return { token, payload };
  }

  verifyAccessToken(token: string): JwtAccessPayload {
    this.ensureKeysLoaded();

    const segments = token.split('.');
    if (segments.length !== 3) {
      throw new Error('Malformed JWT structure');
    }

    const [encodedHeader, encodedPayload, encodedSignature] = segments;
    const headerRaw = base64UrlDecodeToBuffer(encodedHeader).toString('utf8');
    const header = JSON.parse(headerRaw) as { alg?: string; kid?: string };

    if (header.alg !== 'RS256') {
      throw new Error(`Unsupported JWT algorithm: ${String(header.alg)}`);
    }

    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = base64UrlDecodeToBuffer(encodedSignature);

    const valid = crypto.verify(
      'RSA-SHA256',
      Buffer.from(signingInput, 'utf8'),
      this.publicKey,
      signature,
    );
    if (!valid) {
      throw new Error('Invalid RS256 JWT signature');
    }

    const payloadRaw = base64UrlDecodeToBuffer(encodedPayload).toString('utf8');
    const parsedPayload = JwtAccessPayloadSchema.parse(JSON.parse(payloadRaw));

    const nowSec = Math.floor(Date.now() / 1000);
    if (parsedPayload.exp <= nowSec) {
      throw new Error('JWT access token expired');
    }

    return parsedPayload;
  }
}
