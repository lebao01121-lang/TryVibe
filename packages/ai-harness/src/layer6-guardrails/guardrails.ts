import {
  ErrorCode,
  type McpToolMode,
  type McpToolName,
} from '@atelier/contracts';

export const MAX_CUSTOMER_NOTE_LENGTH = 300;
export const UNTRUSTED_NOTE_OPEN_TAG = '<untrusted_customer_note>';
export const UNTRUSTED_NOTE_CLOSE_TAG = '</untrusted_customer_note>';

export interface SanitizedCustomerNoteMeta {
  wrapped: string;
  innerText: string;
  originalLength: number;
  wasTruncated: boolean;
  hadBoundaryTags: boolean;
  hadControlChars: boolean;
}

export interface UntrustedDataInjectionScanResult {
  detected: boolean;
  matchedPatterns: string[];
}

export class UntrustedTurnMutationBlockedError extends Error {
  public readonly code = ErrorCode.PROMPT_INJECTION_BLOCKED;
  public readonly httpStatus = 422;
  public readonly toolName: string;
  public readonly toolMode: McpToolMode;

  constructor(toolName: string, toolMode: McpToolMode) {
    super(
      `Security guardrail blocked ${toolMode} tool "${toolName}" during an active untrusted customer-data turn (${ErrorCode.PROMPT_INJECTION_BLOCKED}).`,
    );
    this.name = 'UntrustedTurnMutationBlockedError';
    this.toolName = toolName;
    this.toolMode = toolMode;
  }
}

export interface PromptInjectionRuleMatch {
  ruleId: string;
  severity: 'LOW' | 'HIGH' | 'CRITICAL';
  reason: string;
}

export interface PromptInjectionResult {
  detected: boolean;
  blocked: boolean;
  severity: 'NONE' | 'LOW' | 'HIGH' | 'CRITICAL';
  matchedRules: string[];
  matches: PromptInjectionRuleMatch[];
}

export interface PiiMaskReport {
  maskedText: string;
  phoneCount: number;
  emailCount: number;
  addressCount: number;
  totalRedactions: number;
}

export type HumanInTheLoopDraft<T extends Record<string, unknown>> = Readonly<
  Omit<
    T,
    | 'status'
    | 'autoAttachAsTryOnGarment'
    | 'requiresHumanApproval'
    | 'approvedBy'
    | 'approvedAt'
    | 'actorType'
  > & {
    readonly status: 'NHAP_AI';
    readonly autoAttachAsTryOnGarment: false;
    readonly requiresHumanApproval: true;
    readonly approvedBy: null;
    readonly approvedAt: null;
    readonly actorType: 'AI_COPILOT';
  }
>;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\uFEFF]/g;

const BOUNDARY_TAG_REGEX =
  /<\/?\s*(?:untrusted_customer_note|system|assistant|user|developer|instructions?|prompt|tool_call|tool_response|function_call)[^>]*>|<\|(?:im_start|im_end|endoftext|system|user|assistant)\|>|\[\/?INST\]|<<\/?SYS>>/gi;

const GENERIC_XML_TAG_REGEX = /<\/?[a-zA-Z][a-zA-Z0-9:_-]*(?:\s+[^<>]*)?\/?>/g;

function normalizeForInjectionScan(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

export function sanitizeCustomerNoteWithMeta(
  rawText: string,
  maxLen: number = MAX_CUSTOMER_NOTE_LENGTH,
): SanitizedCustomerNoteMeta {
  const effectiveMaxLen = Math.max(1, Math.floor(maxLen));
  const source = typeof rawText === 'string' ? rawText : String(rawText ?? '');
  const originalLength = Array.from(source).length;

  const hadControlChars = CONTROL_CHARS_REGEX.test(source);
  CONTROL_CHARS_REGEX.lastIndex = 0;

  const hadBoundaryTags =
    BOUNDARY_TAG_REGEX.test(source) || /[<>]/.test(source);
  BOUNDARY_TAG_REGEX.lastIndex = 0;

  let cleaned = source
    .replace(CONTROL_CHARS_REGEX, ' ')
    .replace(BOUNDARY_TAG_REGEX, ' ')
    .replace(GENERIC_XML_TAG_REGEX, ' ')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\s+/g, ' ')
    .trim();

  const chars = Array.from(cleaned);
  const wasTruncated = chars.length > effectiveMaxLen;
  if (wasTruncated) {
    cleaned = chars.slice(0, effectiveMaxLen).join('').trim();
  }

  return {
    wrapped: `${UNTRUSTED_NOTE_OPEN_TAG}${cleaned}${UNTRUSTED_NOTE_CLOSE_TAG}`,
    innerText: cleaned,
    originalLength,
    wasTruncated,
    hadBoundaryTags,
    hadControlChars,
  };
}

export function sanitizeCustomerNote(
  text: string,
  maxLen: number = MAX_CUSTOMER_NOTE_LENGTH,
): string {
  return sanitizeCustomerNoteWithMeta(text, maxLen).wrapped;
}

const PROMPT_OVERRIDE_DIRECTIVE_REGEX =
  /\b(?:system\s+instruction|system\s+prompt|developer\s+instruction|assistant\s+instruction|override\s+instruction)\s*[:-]?/gi;

const EMBEDDED_HIJACK_DIRECTIVE_REGEX =
  /(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions?|prompts?|rules?|directives?|policies?)|\b(?:drop\s+table|truncate\s+table|drop\s+database)\b/gi;

export function wrapUntrustedCustomerNotes(
  notes: readonly string[],
  maxLen: number = MAX_CUSTOMER_NOTE_LENGTH,
): string[] {
  const effectiveMaxLen = Math.max(1, Math.floor(maxLen));
  return (Array.isArray(notes) ? notes : []).map((rawNote) => {
    const source = typeof rawNote === 'string' ? rawNote : String(rawNote ?? '');
    const strippedDirectives = source
      .replace(CONTROL_CHARS_REGEX, ' ')
      .replace(BOUNDARY_TAG_REGEX, ' ')
      .replace(GENERIC_XML_TAG_REGEX, ' ')
      .replace(PROMPT_OVERRIDE_DIRECTIVE_REGEX, ' ')
      .replace(EMBEDDED_HIJACK_DIRECTIVE_REGEX, '[NEUTRALIZED_DIRECTIVE]')
      .replace(/[<>]/g, ' ');
    const piiMasked = maskPii(strippedDirectives).replace(/\s+/g, ' ').trim();
    const chars = Array.from(piiMasked);
    const truncated =
      chars.length > effectiveMaxLen
        ? chars.slice(0, effectiveMaxLen).join('').trim()
        : piiMasked;
    return `${UNTRUSTED_NOTE_OPEN_TAG}${truncated}${UNTRUSTED_NOTE_CLOSE_TAG}`;
  });
}

interface InjectionRuleDefinition {
  ruleId: string;
  severity: 'LOW' | 'HIGH' | 'CRITICAL';
  reason: string;
  pattern: RegExp;
  scanRaw?: boolean;
}

const INJECTION_RULES: readonly InjectionRuleDefinition[] = [
  {
    ruleId: 'XML_BOUNDARY_BREAKOUT',
    severity: 'CRITICAL',
    reason: 'Attempted XML or prompt-delimiter breakout inside untrusted input.',
    pattern:
      /<\/?\s*(?:untrusted_customer_note|system|assistant|developer|instructions?|tool_call)\b|<\|(?:im_start|im_end|system)\|>|\[\/?INST\]|<<\/?SYS>>/i,
    scanRaw: true,
  },
  {
    ruleId: 'IGNORE_PREVIOUS_INSTRUCTIONS',
    severity: 'CRITICAL',
    reason: 'Attempted instruction override (ignore/disregard prior prompts).',
    pattern:
      /(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions?|prompts?|rules?|directives?|policies?)|bo\s+qua\s+(?:tat\s+ca\s+|moi\s+|toan\s+bo\s+)?(?:chi\s+dan|huong\s+dan|quy\s+tac|lenh)/i,
  },
  {
    ruleId: 'HITL_APPROVAL_BYPASS',
    severity: 'CRITICAL',
    reason: 'Attempted to bypass NHAP_AI human-in-the-loop approval or force auto-attach.',
    pattern:
      /(?:set|force|change|override|mark|update)\s+(?:the\s+)?(?:po\s+|order\s+|draft\s+)?(?:status|trang\s*thai)\s*(?:=|to|as|la)?\s*["']?(?:approved|confirmed|published|active|da_duyet)["']?|(?:bypass|skip|disable)\s+(?:nhap_ai|human\s+approval|hitl)|auto[\s_-]*approve|autoattachastryongarment\s*[:=]\s*true|tu\s+dong\s+duyet|bo\s+qua\s+duyet/i,
  },
  {
    ruleId: 'COST_PRICE_EXFILTRATION',
    severity: 'CRITICAL',
    reason: 'Attempted exfiltration of restricted procurement/COGS pricing fields.',
    pattern:
      /(?:reveal|expose|show|dump|leak|print|return|disclose|extract|give\s+me|what\s+is|tell\s+me|tiet\s+lo|hien\s+thi|xuat|hoi|cho\s+(?:toi|minh|em)\s+(?:biet|xem)|gui\s+(?:cho\s+(?:toi|minh)\s+)?)\s+(?:all\s+|the\s+|toan\s+bo\s+)?(?:internal\s+|secret\s+|noi\s+bo\s+|supplier\s+|nha\s+cung\s+cap\s+)?(?:cost_price|costprice(?:vnd)?|unitcost(?:vnd)?|supplier_?cost|gia\s*nhap|gia_nhap|gianhap|cogs|gia\s*von)|(?:costpricevnd|cost_price|supplier\s*cost|gia\s*von|gia\s*nhap)\s+(?:cua|la\s+bao\s+nhieu|noi\s+bo|tu\s+nha\s+cung\s+cap|bao\s+nhieu)/i,
  },
  {
    ruleId: 'SYSTEM_PROMPT_OVERRIDE',
    severity: 'HIGH',
    reason: 'Attempted system prompt extraction or privileged role impersonation.',
    pattern:
      /(?:reveal|print|dump|show|override|replace|hien\s+thi|in\s+ra|tiet\s+lo)\s+(?:your\s+|the\s+)?(?:system\s+prompt|developer\s+prompt|hidden\s+instructions?)|(?:you\s+are\s+now|act\s+as|pretend\s+to\s+be|hay\s+dong\s+vai|tro\s+thanh|gia\s+lam)\s+(?:a\s+|mot\s+)?(?:super_?admin|root|unrestricted\s+ai|system\s+override|admin\s+noi\s+bo)|elevate\s+(?:my\s+)?privileges/i,
  },
  {
    ruleId: 'TOOL_HIJACK_OR_SQLI',
    severity: 'HIGH',
    reason: 'Attempted unauthorized tool hijacking or SQL injection payload.',
    pattern:
      /(?:invoke|execute|call|run)\s+(?:tool\s+)?(?:delete_|drop_|truncate_|grant_|exec_sql|run_shell)|(?:;\s*|\b)(?:drop\s+table|truncate\s+table|drop\s+database)\b|\bunion\s+all?\s+select\b/i,
  },
];

const SEVERITY_ORDER: Record<'NONE' | 'LOW' | 'HIGH' | 'CRITICAL', number> = {
  NONE: 0,
  LOW: 1,
  HIGH: 2,
  CRITICAL: 3,
};

export function detectPromptInjection(text: string): PromptInjectionResult {
  const source = typeof text === 'string' ? text : String(text ?? '');
  const normalized = normalizeForInjectionScan(source);
  const matches: PromptInjectionRuleMatch[] = [];

  for (const rule of INJECTION_RULES) {
    const target = rule.scanRaw ? source : normalized;
    if (rule.pattern.test(target)) {
      matches.push({
        ruleId: rule.ruleId,
        severity: rule.severity,
        reason: rule.reason,
      });
    }
  }

  let severity: 'NONE' | 'LOW' | 'HIGH' | 'CRITICAL' = 'NONE';
  for (const match of matches) {
    if (SEVERITY_ORDER[match.severity] > SEVERITY_ORDER[severity]) {
      severity = match.severity;
    }
  }

  return {
    detected: matches.length > 0,
    blocked: matches.length > 0,
    severity,
    matchedRules: matches.map((m) => m.ruleId),
    matches,
  };
}

const STOREFRONT_PRIVILEGE_RULES: readonly InjectionRuleDefinition[] = [
  {
    ruleId: 'STOREFRONT_COST_OR_SUPPLIER_EXFIL',
    severity: 'CRITICAL',
    reason:
      'Storefront caller attempted to extract restricted costPriceVnd, COGS, margin, or internal supplier pricing.',
    pattern:
      /\b(?:costpricevnd|cost_price|costprice|unitcostvnd|unit_cost|supplier_?cost|wholesale_?cost|gianhap|gia_nhap|cogs)\b|\bgia\s+(?:von|nhap|goc\s+xuong|si\s+nha\s+cung\s+cap)\b|\b(?:bien\s+loi\s+nhuan|loi\s+nhuan\s+gop|chiet\s+khau\s+nha\s+cung\s+cap|supplier\s+(?:cost|price|invoice|payable|id))\b/i,
  },
  {
    ruleId: 'STOREFRONT_ADMIN_TOOL_ESCALATION',
    severity: 'CRITICAL',
    reason:
      'Storefront caller attempted to invoke an Admin/Warehouse mutating tool or NHAP_AI procurement workflow.',
    pattern:
      /\b(?:create_draft_purchase_order|create_purchase_order_draft|validate_and_process_garment_image|get_tryon_demand_signals|analyze_refund_and_sizing_issues|create_clearance_campaign_draft|nhap_ai)\b|(?:tao|lap|gui|duyet|kich\s+hoat|create|submit|approve)\s+(?:ngay\s+|giup\s+|cho\s+(?:toi|minh)\s+)?(?:ban\s+nhap\s+)?(?:don\s+nhap\s+hang|po\s+draft|purchase\s+order|draft\s+purchase\s+order|po\b|nhap\s+kho|don\s+dat\s+nhap)/i,
  },
];

export function detectStorefrontPromptInjection(
  text: string,
): PromptInjectionResult {
  const source = typeof text === 'string' ? text : String(text ?? '');
  const base = detectPromptInjection(source);
  const normalized = normalizeForInjectionScan(source);
  const matches: PromptInjectionRuleMatch[] = [...base.matches];
  const seen = new Set(base.matchedRules);

  for (const rule of STOREFRONT_PRIVILEGE_RULES) {
    const target = rule.scanRaw ? source : normalized;
    if (rule.pattern.test(target) && !seen.has(rule.ruleId)) {
      seen.add(rule.ruleId);
      matches.push({
        ruleId: rule.ruleId,
        severity: rule.severity,
        reason: rule.reason,
      });
    }
  }

  let severity: 'NONE' | 'LOW' | 'HIGH' | 'CRITICAL' = base.severity;
  for (const match of matches) {
    if (SEVERITY_ORDER[match.severity] > SEVERITY_ORDER[severity]) {
      severity = match.severity;
    }
  }

  return {
    detected: matches.length > 0,
    blocked: matches.length > 0,
    severity,
    matchedRules: matches.map((m) => m.ruleId),
    matches,
  };
}

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Matches Vietnamese phone numbers: +84xxxxxxxxx, +84 xxx xxx xxx, 0xxxxxxxxx, 0xxx xxx xxx
const VN_PHONE_REGEX =
  /(?<!\d)(?:\+84[\s.-]?\d{2,3}[\s.-]?\d{3}[\s.-]?\d{3,4}|(?:\+84|0)\d{9}|0\d{3}[\s.-]\d{3}[\s.-]\d{3})(?!\d)/g;

// Matches Vietnamese detailed street addresses (e.g., "Số 125 Phố Huế, Phường Ngô Thì Nhậm, Quận Hai Bà Trưng, Hà Nội", "42/5 Nguyễn Huệ, Q.1, TP.HCM")
const VN_ADDRESS_REGEX =
  /(?:(?<![\p{L}\p{N}_])(?:số(?:\s+nhà)?|so(?:\s+nha)?|địa\s+chỉ|dia\s+chi|ngõ|ngo|ngách|ngach|hẻm|hem|tòa\s+nhà|toa\s+nha|chung\s+cư|chung\s+cu|căn\s+hộ|can\s+ho|đường|duong|phố|pho)(?=\s*:?\s+\S)\s*:?\s*[^\n.;()[\]]{3,90}|\b\d{1,4}(?:\/\d{1,4})*[A-Za-z]?\s+(?:đường|duong|phố|pho|ngõ|ngo|hẻm|hem|P\.|Phường|Phuong|Nguyễn|Nguyen|Trần|Tran|Lê|Le|Phạm|Pham|Võ|Vo|Hai\s+Bà\s+Trưng|Hai\s+Ba\s+Trung|Lý\s+Thường\s+Kiệt|Ly\s+Thuong\s+Kiet|Bà\s+Triệu|Ba\s+Trieu|Cầu\s+Giấy|Cau\s+Giay|Đồng\s+Khởi|Dong\s+Khoi|Cách\s+Mạng|Cach\s+Mang|Kim\s+Mã|Kim\s+Ma|Tràng\s+Tiền|Trang\s+Tien)[^\n.;()[\]]{2,110})(?:,\s*(?:P\.|Phường|Phuong|Xã|Xa|Q\.|Quận|Quan|H\.|Huyện|Huyen|TP\.?|Thành\s+phố|Thanh\s+pho|Tỉnh|Tinh|Hà\s+Nội|Ha\s+Noi|Hồ\s+Chí\s+Minh|Ho\s+Chi\s+Minh|HCM|Đà\s+Nẵng|Da\s+Nang)[^\n,.;()[\]]{0,40})*/giu;

export function maskPiiWithReport(text: string): PiiMaskReport {
  let maskedText = typeof text === 'string' ? text : String(text ?? '');
  let emailCount = 0;
  let phoneCount = 0;
  let addressCount = 0;

  maskedText = maskedText.replace(EMAIL_REGEX, () => {
    emailCount += 1;
    return '[REDACTED_EMAIL]';
  });

  maskedText = maskedText.replace(VN_PHONE_REGEX, () => {
    phoneCount += 1;
    return '[REDACTED_PHONE]';
  });

  maskedText = maskedText.replace(VN_ADDRESS_REGEX, () => {
    addressCount += 1;
    return '[REDACTED_ADDRESS]';
  });

  return {
    maskedText,
    phoneCount,
    emailCount,
    addressCount,
    totalRedactions: phoneCount + emailCount + addressCount,
  };
}

export function maskPii(text: string): string {
  return maskPiiWithReport(text).maskedText;
}

const UNTRUSTED_DATA_INJECTION_RULES: readonly InjectionRuleDefinition[] = [
  {
    ruleId: 'SYSTEM_DIRECTIVE_HEADER',
    severity: 'CRITICAL',
    reason: 'Untrusted customer note contains an embedded SYSTEM/DEVELOPER instruction header.',
    pattern:
      /\b(?:system\s+instruction|system\s+prompt|developer\s+instruction|assistant\s+instruction|admin\s+override|override\s+instruction)\s*[:-]/i,
  },
  {
    ruleId: 'UNTRUSTED_REFUND_HIJACK',
    severity: 'CRITICAL',
    reason: 'Untrusted customer note attempts to force mass refund approval.',
    pattern:
      /(?:duyet\s+hoan\s+tien|hoan\s+tien\s+toan\s+bo|tu\s+dong\s+hoan\s+tien|approve\s+(?:all\s+)?refunds?|refund\s+all\s+orders)/i,
  },
  {
    ruleId: 'UNTRUSTED_PO_HIJACK',
    severity: 'CRITICAL',
    reason: 'Untrusted customer note attempts to trigger an unauthorized purchase order.',
    pattern:
      /(?:dat\s+nhap\s+(?:ngay|them|\d+)|tao\s+(?:ngay\s+)?don\s+nhap|lap\s+nhap\s+don\s+nhap|create\s+purchase\s+order|order\s+\d{2,}\s+(?:units|pcs|shirts|chiec|ao))/i,
  },
  {
    ruleId: 'UNTRUSTED_APPROVAL_OR_DESTRUCTIVE_HIJACK',
    severity: 'CRITICAL',
    reason:
      'Untrusted customer note attempts to hijack PO/refund approval or run destructive commands.',
    pattern:
      /(?:approve|submit|confirm|auto[\s_-]*approve|bypass)\s+(?:all\s+|this\s+|the\s+)?(?:po\b|purchase\s+order|draft|rma|refund)|(?:duyet|xac\s+nhan)\s+(?:ngay\s+|tu\s+dong\s+)?(?:po\b|don\s+nhap|rma)|(?:drop|truncate)\s+(?:table|database|orders?|products?)/i,
  },
];

export function detectPromptInjectionInUntrustedData(
  text: string,
): UntrustedDataInjectionScanResult {
  const source = typeof text === 'string' ? text : String(text ?? '');
  const baseScan = detectPromptInjection(source);
  const normalized = normalizeForInjectionScan(source);
  const matchedSet = new Set<string>(baseScan.matchedRules);

  for (const rule of UNTRUSTED_DATA_INJECTION_RULES) {
    const target = rule.scanRaw ? source : normalized;
    if (rule.pattern.test(target)) {
      matchedSet.add(rule.ruleId);
    }
  }

  const matchedPatterns = Array.from(matchedSet);
  return {
    detected: matchedPatterns.length > 0,
    matchedPatterns,
  };
}

export function assertNoMutatingToolInUntrustedTurn(
  untrustedTurnActive: boolean,
  toolName: McpToolName,
  toolMode: McpToolMode,
): void {
  if (untrustedTurnActive && toolMode === 'MUTATING_DRAFT') {
    throw new UntrustedTurnMutationBlockedError(toolName, toolMode);
  }
}

export function enforceHumanInTheLoop<T extends Record<string, unknown>>(
  draft: T,
): HumanInTheLoopDraft<T> {
  const sanitizedDraft: Record<string, unknown> = { ...draft };
  delete sanitizedDraft.bypassApproval;
  delete sanitizedDraft.forceApprove;
  delete sanitizedDraft.autoApproved;

  const enforced = {
    ...sanitizedDraft,
    status: 'NHAP_AI' as const,
    autoAttachAsTryOnGarment: false as const,
    requiresHumanApproval: true as const,
    approvedBy: null,
    approvedAt: null,
    actorType: 'AI_COPILOT' as const,
  };

  return Object.freeze(enforced) as HumanInTheLoopDraft<T>;
}
