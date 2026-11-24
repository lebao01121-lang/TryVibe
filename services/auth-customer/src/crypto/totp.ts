import * as crypto from 'node:crypto';
import { sha256Hex } from './jwks.service';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;

export interface StoredRecoveryCode {
  hash: string;
  used: boolean;
}

export function encodeBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i += 1) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

export function decodeBase32(encoded: string): Buffer {
  const cleaned = encoded.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (let i = 0; i < cleaned.length; i += 1) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]);
    if (idx === -1) {
      throw new Error(`Invalid Base32 character: ${cleaned[i]}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

export function generateTotpSecret(numBytes: number = 20): string {
  return encodeBase32(crypto.randomBytes(numBytes));
}

export function computeHotp(secretBase32: string, counter: number): string {
  const key = decodeBase32(secretBase32);
  const counterBuf = Buffer.alloc(8);
  const high = Math.floor(counter / 0x100000000);
  const low = counter >>> 0;
  counterBuf.writeUInt32BE(high, 0);
  counterBuf.writeUInt32BE(low, 4);

  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binaryCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = binaryCode % 10 ** TOTP_DIGITS;
  return otp.toString().padStart(TOTP_DIGITS, '0');
}

export function generateTotpCode(secretBase32: string, nowMs: number = Date.now()): string {
  const counter = Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
  return computeHotp(secretBase32, counter);
}

/**
 * Verifies a 6-digit RFC 6238 TOTP code with +-window 30-second steps.
 */
export function verifyTotpCode(
  secretBase32: string,
  candidateCode: string,
  windowSteps: number = 1,
  nowMs: number = Date.now(),
): boolean {
  const normalized = candidateCode.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) {
    return false;
  }

  const currentCounter = Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
  const candidateBuf = Buffer.from(normalized, 'utf8');

  for (let offset = -windowSteps; offset <= windowSteps; offset += 1) {
    const expected = computeHotp(secretBase32, currentCounter + offset);
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (expectedBuf.length === candidateBuf.length && crypto.timingSafeEqual(expectedBuf, candidateBuf)) {
      return true;
    }
  }

  return false;
}

export function buildOtpAuthUri(
  email: string,
  secretBase32: string,
  issuer: string = 'Fashion Atelier',
): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(email)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Generates a deterministic clean SVG QR-matrix preview data URL for TOTP enrollment UI
 * (zero native/external dependencies).
 */
export function buildQrSvgDataUrl(otpauthUri: string, secretBase32: string): string {
  const size = 21;
  const cell = 8;
  const quiet = 2;
  const totalPx = (size + quiet * 2) * cell;
  const digest = crypto.createHash('sha256').update(otpauthUri).digest();
  const digest2 = crypto.createHash('sha256').update(`${secretBase32}:${otpauthUri}`).digest();
  const bits = Buffer.concat([digest, digest2]);

  const isFinder = (r: number, c: number): boolean | null => {
    const inBox = (br: number, bc: number): boolean | null => {
      const dr = r - br;
      const dc = c - bc;
      if (dr < 0 || dr > 6 || dc < 0 || dc > 6) {
        return null;
      }
      if (dr === 0 || dr === 6 || dc === 0 || dc === 6) {
        return true;
      }
      if (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4) {
        return true;
      }
      return false;
    };
    return inBox(0, 0) ?? inBox(0, size - 7) ?? inBox(size - 7, 0);
  };

  const rects: string[] = [];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      const finder = isFinder(r, c);
      let dark = false;
      if (finder !== null) {
        dark = finder;
      } else {
        const idx = r * size + c;
        const byte = bits[idx % bits.length];
        dark = ((byte >>> (idx % 8)) & 1) === 1;
      }
      if (dark) {
        const x = (c + quiet) * cell;
        const y = (r + quiet) * cell;
        rects.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="#171717"/>`);
      }
    }
  }

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalPx} ${totalPx}" width="${totalPx}" height="${totalPx}" role="img" aria-label="Atelier TOTP QR">`,
    `<rect width="${totalPx}" height="${totalPx}" fill="#FFFFFF"/>`,
    ...rects,
    '</svg>',
  ].join('');

  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

function deriveAes256Key(keyMaterial: string): Buffer {
  return crypto.createHash('sha256').update(keyMaterial, 'utf8').digest();
}

export function encryptTotpSecret(secretBase32: string, keyMaterial: string): string {
  const key = deriveAes256Key(keyMaterial);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(secretBase32, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptTotpSecret(payload: string, keyMaterial: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Unsupported encrypted TOTP secret format');
  }
  const key = deriveAes256Key(keyMaterial);
  const iv = Buffer.from(parts[1], 'base64');
  const authTag = Buffer.from(parts[2], 'base64');
  const ciphertext = Buffer.from(parts[3], 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

export function generateRecoveryCodes(count: number = 8): {
  plaintextCodes: string[];
  storedCodes: StoredRecoveryCode[];
} {
  const plaintextCodes: string[] = [];
  const storedCodes: StoredRecoveryCode[] = [];

  for (let i = 0; i < count; i += 1) {
    const partA = crypto.randomBytes(2).toString('hex').toUpperCase();
    const partB = crypto.randomBytes(2).toString('hex').toUpperCase();
    const code = `ATEL-${partA}-${partB}`;
    plaintextCodes.push(code);
    storedCodes.push({
      hash: sha256Hex(code.toUpperCase()),
      used: false,
    });
  }

  return { plaintextCodes, storedCodes };
}

export function generateNumericOtp(digits: number = 6): string {
  const max = 10 ** digits;
  const num = crypto.randomInt(0, max);
  return num.toString().padStart(digits, '0');
}
