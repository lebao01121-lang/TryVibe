import { createHmac, timingSafeEqual } from 'node:crypto';
import * as QRCode from 'qrcode';
import { PaymentProvider } from '@atelier/contracts';

export const VIETQR_STANDARD = 'ISO_IEC_18004_EMVCO_NAPAS247' as const;
export const VIETQR_QUIET_ZONE_MODULES = 4 as const;

export interface VietQrPayloadOptions {
  bankBin?: string;
  accountNo?: string;
  accountName?: string;
  description?: string;
}

export interface RenderedVietQrArtifacts {
  qrPayload: string;
  qrStandard: typeof VIETQR_STANDARD;
  qrModuleCount: number;
  qrQuietZoneModules: number;
  qrSvgDataUrl: string;
  qrImageUrl: string;
  rawQrSvgDataUrl: string;
  rawQrPngDataUrl: string;
}

function sanitizeEmvAscii(raw: string, maxLength: number, uppercase: boolean = true): string {
  const cleaned = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9 ._-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const formatted = uppercase ? cleaned.toUpperCase() : cleaned;
  return formatted.slice(0, maxLength);
}

function formatEmvField(tag: string, value: string): string {
  const len = String(Buffer.byteLength(value, 'utf8')).padStart(2, '0');
  return `${tag}${len}${value}`;
}

/**
 * Computes EMVCo CRC16-CCITT (polynomial 0x1021, initial value 0xFFFF).
 */
export function crc16Ccitt(payload: string): string {
  let crc = 0xffff;
  const bytes = Buffer.from(payload, 'utf8');
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i]! << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Verifies EMVCo / VietQR TLV framing and CRC16-CCITT (0xFFFF) checksum.
 */
export function verifyVietQrEmvCoCrc16(payload: string): boolean {
  if (typeof payload !== 'string' || payload.length < 16) {
    return false;
  }
  if (!payload.startsWith('000201')) {
    return false;
  }
  const crcTagHeader = payload.slice(-8, -4);
  const providedCrc = payload.slice(-4);
  if (crcTagHeader !== '6304' || !/^[0-9A-Fa-f]{4}$/.test(providedCrc)) {
    return false;
  }

  // Walk top-level TLV fields to verify structural integrity
  let cursor = 0;
  let sawCrcTag = false;
  while (cursor + 4 <= payload.length) {
    const tag = payload.slice(cursor, cursor + 2);
    const lenStr = payload.slice(cursor + 2, cursor + 4);
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lenStr)) {
      return false;
    }
    const len = Number.parseInt(lenStr, 10);
    const nextCursor = cursor + 4 + len;
    if (nextCursor > payload.length) {
      return false;
    }
    if (tag === '63') {
      if (len !== 4 || nextCursor !== payload.length) {
        return false;
      }
      sawCrcTag = true;
    }
    cursor = nextCursor;
  }
  if (!sawCrcTag || cursor !== payload.length) {
    return false;
  }

  const expectedCrc = crc16Ccitt(payload.slice(0, -4));
  return expectedCrc.toUpperCase() === providedCrc.toUpperCase();
}

/**
 * Builds a genuine VietQR EMVCo NAPAS 247 string with CRC16-CCITT (0xFFFF).
 */
export function buildVietQrPayload(
  orderCode: string,
  amountVnd: number,
  opts: VietQrPayloadOptions = {},
): string {
  const bankBin =
    (opts.bankBin ?? process.env.VIETQR_BANK_BIN?.trim() ?? '970422')
      .replace(/[^0-9]/g, '')
      .slice(0, 8) || '970422';
  const accountNo =
    sanitizeEmvAscii(
      opts.accountNo ?? process.env.VIETQR_ACCOUNT_NO?.trim() ?? '088820269999',
      19,
      true,
    ).replace(/\s+/g, '') || '088820269999';
  const accountName =
    sanitizeEmvAscii(
      opts.accountName ?? process.env.VIETQR_ACCOUNT_NAME?.trim() ?? 'TRYVIBE ATELIER',
      25,
      true,
    ) || 'TRYVIBE ATELIER';
  const description =
    sanitizeEmvAscii(opts.description ?? `TRYVIBE ${orderCode}`, 50, true) ||
    `TRYVIBE ${sanitizeEmvAscii(orderCode, 32, true)}`;

  const exactAmountStr = String(Math.max(0, Math.round(amountVnd)));

  const beneficiaryOrg = formatEmvField('00', bankBin) + formatEmvField('01', accountNo);
  const merchantAccount =
    formatEmvField('00', 'A000000727') +
    formatEmvField('01', beneficiaryOrg) +
    formatEmvField('02', 'QRIBFTTA');
  const additionalData = formatEmvField('08', description);

  const bodyWithoutCrc =
    formatEmvField('00', '01') +
    formatEmvField('01', '12') +
    formatEmvField('38', merchantAccount) +
    formatEmvField('53', '704') +
    formatEmvField('54', exactAmountStr) +
    formatEmvField('58', 'VN') +
    formatEmvField('59', accountName) +
    formatEmvField('62', additionalData) +
    '6304';

  return `${bodyWithoutCrc}${crc16Ccitt(bodyWithoutCrc)}`;
}

function buildQrMatrixPath(
  modules: QRCode.BitMatrix,
  originX: number,
  originY: number,
  cellSize: number,
): string {
  const size = modules.size;
  const commands: string[] = [];
  for (let r = 0; r < size; r += 1) {
    let c = 0;
    while (c < size) {
      if (modules.get(r, c)) {
        const startC = c;
        while (c < size && modules.get(r, c)) {
          c += 1;
        }
        const runLen = c - startC;
        const x = originX + startC * cellSize;
        const y = originY + r * cellSize;
        const w = runLen * cellSize;
        commands.push(`M${x} ${y}h${w}v${cellSize}h-${w}z`);
      } else {
        c += 1;
      }
    }
  }
  return commands.join('');
}

/**
 * Renders a genuine ISO/IEC 18004 QR Code matrix (error correction M, quiet zone >= 4 modules)
 * into a Quiet Luxury Ivory/Gold/Espresso SVG data URL decodable by any phone camera or banking app.
 */
export function buildVietQrSvgDataUrl(
  orderCode: string,
  amountVnd: number,
  qrPayload: string,
): string {
  const qr = QRCode.create(qrPayload, { errorCorrectionLevel: 'M' });
  const moduleCount = qr.modules.size;
  const quietZoneModules = VIETQR_QUIET_ZONE_MODULES;
  const cellSize = 6;
  const framePad = 16;

  const qrBoxSize = (moduleCount + quietZoneModules * 2) * cellSize;
  const svgW = qrBoxSize + framePad * 2;
  const footerHeight = 62;
  const svgH = svgW + footerHeight;

  const matrixOriginX = framePad + quietZoneModules * cellSize;
  const matrixOriginY = framePad + quietZoneModules * cellSize;
  const darkPath = buildQrMatrixPath(qr.modules, matrixOriginX, matrixOriginY, cellSize);

  const formattedVnd = `${Math.round(amountVnd).toLocaleString('en-US').replace(/,/g, '.')} VND`;
  const safeCode = orderCode.replace(/[<>&"']/g, '');

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" role="img" aria-label="VietQR ${safeCode}">`,
    `<rect x="1" y="1" width="${svgW - 2}" height="${svgH - 2}" rx="18" fill="#FBF7EF" stroke="#B08A4A" stroke-width="2"/>`,
    `<rect x="${framePad}" y="${framePad}" width="${qrBoxSize}" height="${qrBoxSize}" rx="10" fill="#FFFFFF"/>`,
    `<path d="${darkPath}" fill="#1C1410" shape-rendering="crispEdges"/>`,
    `<text x="${svgW / 2}" y="${svgW + 16}" text-anchor="middle" font-family="Georgia,serif" font-size="11" letter-spacing="1.4" fill="#8A672C">VIETQR · TRYVIBE ATELIER</text>`,
    `<text x="${svgW / 2}" y="${svgW + 34}" text-anchor="middle" font-family="monospace" font-size="12" font-weight="700" fill="#1C1410">${safeCode}</text>`,
    `<text x="${svgW / 2}" y="${svgW + 50}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#5A4A3E">${formattedVnd}</text>`,
    `</svg>`,
  ].join('');

  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

/**
 * Renders a pure standard black-on-white ISO/IEC 18004 QR Code SVG data URL (quiet zone = 4 modules).
 */
export function buildRawVietQrSvgDataUrl(qrPayload: string): string {
  const qr = QRCode.create(qrPayload, { errorCorrectionLevel: 'M' });
  const moduleCount = qr.modules.size;
  const quietZoneModules = VIETQR_QUIET_ZONE_MODULES;
  const cellSize = 6;
  const totalSize = (moduleCount + quietZoneModules * 2) * cellSize;
  const origin = quietZoneModules * cellSize;
  const darkPath = buildQrMatrixPath(qr.modules, origin, origin, cellSize);

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalSize}" height="${totalSize}" viewBox="0 0 ${totalSize} ${totalSize}" shape-rendering="crispEdges">`,
    `<rect width="${totalSize}" height="${totalSize}" fill="#FFFFFF"/>`,
    `<path d="${darkPath}" fill="#000000"/>`,
    `</svg>`,
  ].join('');

  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

/**
 * Renders a pure standard black-on-white ISO/IEC 18004 QR Code PNG data URL (quiet zone = 4 modules).
 */
export async function buildRawVietQrPngDataUrl(qrPayload: string): Promise<string> {
  return QRCode.toDataURL(qrPayload, {
    errorCorrectionLevel: 'M',
    margin: VIETQR_QUIET_ZONE_MODULES,
    width: 320,
    color: {
      dark: '#000000FF',
      light: '#FFFFFFFF',
    },
  });
}

/**
 * Generates all ISO/IEC 18004 VietQR artifacts (Quiet Luxury SVG + raw matrix SVG & PNG).
 */
export async function renderVietQrArtifacts(
  orderCode: string,
  amountVnd: number,
  qrPayload: string,
): Promise<RenderedVietQrArtifacts> {
  const qr = QRCode.create(qrPayload, { errorCorrectionLevel: 'M' });
  const qrSvgDataUrl = buildVietQrSvgDataUrl(orderCode, amountVnd, qrPayload);
  const rawQrSvgDataUrl = buildRawVietQrSvgDataUrl(qrPayload);
  const rawQrPngDataUrl = await buildRawVietQrPngDataUrl(qrPayload);

  return {
    qrPayload,
    qrStandard: VIETQR_STANDARD,
    qrModuleCount: qr.modules.size,
    qrQuietZoneModules: VIETQR_QUIET_ZONE_MODULES,
    qrSvgDataUrl,
    qrImageUrl: qrSvgDataUrl,
    rawQrSvgDataUrl,
    rawQrPngDataUrl,
  };
}

export function computeHmacSha256Hex(rawPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(rawPayload, 'utf8').digest('hex');
}

export function verifyHmacSha256Signature(
  rawPayload: string,
  providedSignature: string | null | undefined,
  secret: string,
): boolean {
  if (!providedSignature || providedSignature.trim().length === 0) {
    return false;
  }
  const normalizedProvided = providedSignature
    .trim()
    .replace(/^sha256=/i, '')
    .toLowerCase();
  const expected = computeHmacSha256Hex(rawPayload, secret).toLowerCase();

  const bufProvided = Buffer.from(normalizedProvided, 'utf8');
  const bufExpected = Buffer.from(expected, 'utf8');
  if (bufProvided.length !== bufExpected.length) {
    return false;
  }
  return timingSafeEqual(bufProvided, bufExpected);
}

export function normalizeWebhookProviderParam(
  rawProvider: string,
): 'VIETQR' | 'VNPAY' | 'MOMO' | null {
  const normalized = rawProvider.trim().toLowerCase();
  if (normalized === 'vietqr' || normalized === 'payos') {
    return PaymentProvider.VIETQR;
  }
  if (normalized === 'vnpay') {
    return PaymentProvider.VNPAY;
  }
  if (normalized === 'momo') {
    return PaymentProvider.MOMO;
  }
  return null;
}
