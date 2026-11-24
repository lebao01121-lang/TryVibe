import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { PaymentProvider } from '@atelier/contracts';

function formatEmvField(tag: string, value: string): string {
  const len = String(value.length).padStart(2, '0');
  return `${tag}${len}${value}`;
}

function crc16Ccitt(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i += 1) {
    crc ^= payload.charCodeAt(i) << 8;
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
 * Builds a realistic NAPAS / VietQR EMVCo QR string embedding orderCode & exact VND amount.
 */
export function buildVietQrPayload(orderCode: string, amountVnd: number): string {
  const bankInfo = formatEmvField('00', '970422') + formatEmvField('01', 'ATELIER2026VN');
  const merchantAccount =
    formatEmvField('00', 'A000000727') +
    formatEmvField('01', bankInfo) +
    formatEmvField('02', 'QRIBFTTA');
  const additionalData = formatEmvField('08', `TAMXUAN ${orderCode}`.slice(0, 50));

  const bodyWithoutCrc =
    formatEmvField('00', '01') +
    formatEmvField('01', '12') +
    formatEmvField('38', merchantAccount) +
    formatEmvField('53', '704') +
    formatEmvField('54', String(Math.max(0, Math.round(amountVnd)))) +
    formatEmvField('58', 'VN') +
    formatEmvField('62', additionalData) +
    '6304';

  return `${bodyWithoutCrc}${crc16Ccitt(bodyWithoutCrc)}`;
}

/**
 * Renders a deterministic Quiet Luxury Ivory/Gold/Espresso SVG QR preview data URL.
 */
export function buildVietQrSvgDataUrl(
  orderCode: string,
  amountVnd: number,
  qrPayload: string,
): string {
  const hash = createHash('sha256').update(qrPayload).digest();
  const cells = 21;
  const cellSize = 8;
  const pad = 26;
  const qrWidth = cells * cellSize;
  const svgW = qrWidth + pad * 2;
  const svgH = svgW + 54;

  const rects: string[] = [];

  const isFinder = (r: number, c: number): boolean => {
    const inTopLeft = r < 7 && c < 7;
    const inTopRight = r < 7 && c >= cells - 7;
    const inBottomLeft = r >= cells - 7 && c < 7;
    return inTopLeft || inTopRight || inBottomLeft;
  };

  for (let r = 0; r < cells; r += 1) {
    for (let c = 0; c < cells; c += 1) {
      if (isFinder(r, c)) {
        const lr = r >= cells - 7 ? r - (cells - 7) : r;
        const lc = c >= cells - 7 ? c - (cells - 7) : c;
        const dark =
          lr === 0 ||
          lr === 6 ||
          lc === 0 ||
          lc === 6 ||
          (lr >= 2 && lr <= 4 && lc >= 2 && lc <= 4);
        if (dark) {
          rects.push(
            `<rect x="${pad + c * cellSize}" y="${pad + r * cellSize}" width="${cellSize}" height="${cellSize}" fill="#1C1410"/>`,
          );
        }
      } else {
        const idx = (r * cells + c) % hash.length;
        const bit = (hash[idx] >> ((r + c) % 8)) & 1;
        if (bit === 1) {
          rects.push(
            `<rect x="${pad + c * cellSize}" y="${pad + r * cellSize}" width="${cellSize}" height="${cellSize}" fill="#1C1410"/>`,
          );
        }
      }
    }
  }

  const formattedVnd = `${Math.round(amountVnd).toLocaleString('en-US').replace(/,/g, '.')} VND`;
  const safeCode = orderCode.replace(/[<>&"']/g, '');

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">`,
    `<rect width="100%" height="100%" rx="16" fill="#FBF7EF" stroke="#B08A4A" stroke-width="2"/>`,
    ...rects,
    `<text x="${svgW / 2}" y="${svgW + 14}" text-anchor="middle" font-family="Georgia,serif" font-size="11" fill="#8A672C">VIETQR · TAM XUAN ATELIER</text>`,
    `<text x="${svgW / 2}" y="${svgW + 30}" text-anchor="middle" font-family="monospace" font-size="11" font-weight="700" fill="#1C1410">${safeCode}</text>`,
    `<text x="${svgW / 2}" y="${svgW + 45}" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#5A4A3E">${formattedVnd}</text>`,
    `</svg>`,
  ].join('');

  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

export function buildVnpaySandboxUrl(
  orderCode: string,
  amountVnd: number,
  returnUrl: string,
  secret: string,
): string {
  const params = new URLSearchParams({
    vnp_Version: '2.1.0',
    vnp_Command: 'pay',
    vnp_TmnCode: 'ATELIER01',
    vnp_Amount: String(Math.max(0, Math.round(amountVnd)) * 100),
    vnp_CurrCode: 'VND',
    vnp_TxnRef: orderCode,
    vnp_OrderInfo: `Thanh toan don hang ${orderCode}`,
    vnp_ReturnUrl: returnUrl,
  });
  const secureHash = computeHmacSha256Hex(params.toString(), secret);
  params.set('vnp_SecureHash', secureHash);
  return `https://sandbox.vnpayment.vn/paymentv2/vpcpay.html?${params.toString()}`;
}

export function buildMomoSandboxUrl(
  orderCode: string,
  amountVnd: number,
  returnUrl: string,
  secret: string,
): string {
  const params = new URLSearchParams({
    partnerCode: 'ATELIER_MOMO',
    orderId: orderCode,
    amount: String(Math.max(0, Math.round(amountVnd))),
    orderInfo: `Tam Xuan Atelier ${orderCode}`,
    redirectUrl: returnUrl,
  });
  const signature = computeHmacSha256Hex(params.toString(), secret);
  params.set('signature', signature);
  return `https://test-payment.momo.vn/v2/gateway/pay?${params.toString()}`;
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
