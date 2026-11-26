export interface SePayBankDirectoryEntry {
  bankBin: string;
  bankCode: string;
  bankName: string;
  aliases: readonly string[];
}

export interface SePayBankMeta {
  bankBin: string;
  bankCode: string;
  bankName: string;
}

/**
 * Complete Vietnamese NAPAS 247 / SePay supported bank directory.
 * Maps BIN <-> SePay QR bank code <-> Vietnamese display name.
 */
export const SEPAY_BANK_DIRECTORY: readonly SePayBankDirectoryEntry[] = [
  {
    bankBin: '970422',
    bankCode: 'MB',
    bankName: 'MB Bank (Ngân hàng TMCP Quân đội)',
    aliases: ['MB', 'MBBANK', 'MB BANK', 'QUAN DOI', 'MILITARY BANK'],
  },
  {
    bankBin: '970436',
    bankCode: 'VCB',
    bankName: 'Vietcombank (Ngân hàng TMCP Ngoại thương Việt Nam)',
    aliases: ['VCB', 'VIETCOMBANK', 'NGOAI THUONG'],
  },
  {
    bankBin: '970407',
    bankCode: 'TCB',
    bankName: 'Techcombank (Ngân hàng TMCP Kỹ thương Việt Nam)',
    aliases: ['TCB', 'TECHCOMBANK', 'KY THUONG'],
  },
  {
    bankBin: '970415',
    bankCode: 'ICB',
    bankName: 'VietinBank (Ngân hàng TMCP Công thương Việt Nam)',
    aliases: ['ICB', 'VIETINBANK', 'VIETIN', 'CTG', 'CONG THUONG'],
  },
  {
    bankBin: '970418',
    bankCode: 'BIDV',
    bankName: 'BIDV (Ngân hàng TMCP Đầu tư và Phát triển Việt Nam)',
    aliases: ['BIDV', 'BID', 'DAU TU VA PHAT TRIEN'],
  },
  {
    bankBin: '970416',
    bankCode: 'ACB',
    bankName: 'ACB (Ngân hàng TMCP Á Châu)',
    aliases: ['ACB', 'ACHAU', 'A CHAU'],
  },
  {
    bankBin: '970432',
    bankCode: 'VPB',
    bankName: 'VPBank (Ngân hàng TMCP Việt Nam Thịnh Vượng)',
    aliases: ['VPB', 'VPBANK', 'VP BANK', 'THINH VUONG'],
  },
  {
    bankBin: '970423',
    bankCode: 'TPB',
    bankName: 'TPBank (Ngân hàng TMCP Tiên Phong)',
    aliases: ['TPB', 'TPBANK', 'TP BANK', 'TIEN PHONG'],
  },
  {
    bankBin: '970403',
    bankCode: 'STB',
    bankName: 'Sacombank (Ngân hàng TMCP Sài Gòn Thương Tín)',
    aliases: ['STB', 'SACOMBANK', 'SAI GON THUONG TIN'],
  },
  {
    bankBin: '970405',
    bankCode: 'VBA',
    bankName: 'Agribank (Ngân hàng Nông nghiệp và Phát triển Nông thôn)',
    aliases: ['VBA', 'AGRIBANK', 'AGRI', 'NONG NGHIEP'],
  },
  {
    bankBin: '970441',
    bankCode: 'VIB',
    bankName: 'VIB (Ngân hàng TMCP Quốc tế Việt Nam)',
    aliases: ['VIB', 'QUOC TE'],
  },
  {
    bankBin: '970437',
    bankCode: 'HDB',
    bankName: 'HDBank (Ngân hàng TMCP Phát triển TP.HCM)',
    aliases: ['HDB', 'HDBANK', 'HD BANK'],
  },
  {
    bankBin: '970443',
    bankCode: 'SHB',
    bankName: 'SHB (Ngân hàng TMCP Sài Gòn - Hà Nội)',
    aliases: ['SHB', 'SAI GON HA NOI'],
  },
  {
    bankBin: '970448',
    bankCode: 'OCB',
    bankName: 'OCB (Ngân hàng TMCP Phương Đông)',
    aliases: ['OCB', 'PHUONG DONG'],
  },
  {
    bankBin: '970426',
    bankCode: 'MSB',
    bankName: 'MSB (Ngân hàng TMCP Hàng Hải Việt Nam)',
    aliases: ['MSB', 'MARITIMEBANK', 'MARITIME', 'HANG HAI'],
  },
  {
    bankBin: '970431',
    bankCode: 'EIB',
    bankName: 'Eximbank (Ngân hàng TMCP Xuất Nhập Khẩu Việt Nam)',
    aliases: ['EIB', 'EXIMBANK', 'EXIM'],
  },
  {
    bankBin: '970449',
    bankCode: 'LPB',
    bankName: 'LPBank (Ngân hàng TMCP Lộc Phát Việt Nam)',
    aliases: ['LPB', 'LPBANK', 'LIENVIETPOSTBANK', 'LIEN VIET'],
  },
  {
    bankBin: '970428',
    bankCode: 'NAB',
    bankName: 'Nam A Bank (Ngân hàng TMCP Nam Á)',
    aliases: ['NAB', 'NAMABANK', 'NAM A BANK', 'NAMA'],
  },
  {
    bankBin: '970454',
    bankCode: 'VCCB',
    bankName: 'BVBank / Timo (Ngân hàng TMCP Bản Việt)',
    aliases: ['VCCB', 'TIMO', 'BVBANK', 'VIETCAPITALBANK', 'BAN VIET'],
  },
  {
    bankBin: '546034',
    bankCode: 'CAKE',
    bankName: 'CAKE by VPBank',
    aliases: ['CAKE', 'CAKEBYVPBANK', 'CAKE BY VPBANK'],
  },
  {
    bankBin: '546035',
    bankCode: 'UBANK',
    bankName: 'Ubank by VPBank',
    aliases: ['UBANK', 'UBANKBYVPBANK', 'UBANK BY VPBANK'],
  },
  {
    bankBin: '970440',
    bankCode: 'SEAB',
    bankName: 'SeABank (Ngân hàng TMCP Đông Nam Á)',
    aliases: ['SEAB', 'SEABANK', 'SEA BANK', 'DONG NAM A'],
  },
  {
    bankBin: '970425',
    bankCode: 'ABB',
    bankName: 'ABBANK (Ngân hàng TMCP An Bình)',
    aliases: ['ABB', 'ABBANK', 'AN BINH'],
  },
  {
    bankBin: '970409',
    bankCode: 'BAB',
    bankName: 'Bac A Bank (Ngân hàng TMCP Bắc Á)',
    aliases: ['BAB', 'BACABANK', 'BAC A BANK'],
  },
  {
    bankBin: '970438',
    bankCode: 'BVB',
    bankName: 'BaoViet Bank (Ngân hàng TMCP Bảo Việt)',
    aliases: ['BVB', 'BAOVIETBANK', 'BAO VIET'],
  },
  {
    bankBin: '970452',
    bankCode: 'KLB',
    bankName: 'KienLongBank (Ngân hàng TMCP Kiên Long)',
    aliases: ['KLB', 'KIENLONGBANK', 'KIEN LONG'],
  },
  {
    bankBin: '970419',
    bankCode: 'NCB',
    bankName: 'NCB (Ngân hàng TMCP Quốc Dân)',
    aliases: ['NCB', 'QUOC DAN'],
  },
  {
    bankBin: '970430',
    bankCode: 'PGB',
    bankName: 'PGBank (Ngân hàng TMCP Thịnh vượng và Phát triển)',
    aliases: ['PGB', 'PGBANK', 'PG BANK'],
  },
  {
    bankBin: '970412',
    bankCode: 'PVCB',
    bankName: 'PVcomBank (Ngân hàng TMCP Đại Chúng Việt Nam)',
    aliases: ['PVCB', 'PVCOMBANK', 'PVCOM'],
  },
  {
    bankBin: '970429',
    bankCode: 'SCB',
    bankName: 'SCB (Ngân hàng TMCP Sài Gòn)',
    aliases: ['SCB', 'SAIGON COMMERCIAL BANK'],
  },
  {
    bankBin: '970427',
    bankCode: 'VAB',
    bankName: 'VietABank (Ngân hàng TMCP Việt Á)',
    aliases: ['VAB', 'VIETABANK', 'VIET A'],
  },
  {
    bankBin: '970433',
    bankCode: 'VIETBANK',
    bankName: 'VietBank (Ngân hàng TMCP Việt Nam Thương Tín)',
    aliases: ['VIETBANK', 'VIET BANK'],
  },
  {
    bankBin: '970457',
    bankCode: 'WVN',
    bankName: 'Woori Bank Việt Nam',
    aliases: ['WVN', 'WOORI', 'WOORIBANK'],
  },
  {
    bankBin: '970424',
    bankCode: 'SHBVN',
    bankName: 'Shinhan Bank Việt Nam',
    aliases: ['SHBVN', 'SHINHAN', 'SHINHANBANK'],
  },
  {
    bankBin: '422589',
    bankCode: 'CIMB',
    bankName: 'CIMB Bank Việt Nam',
    aliases: ['CIMB', 'CIMBBANK'],
  },
  {
    bankBin: '668888',
    bankCode: 'KBANK',
    bankName: 'KBank Việt Nam',
    aliases: ['KBANK', 'KASIKORNBANK'],
  },
  {
    bankBin: '458761',
    bankCode: 'HSBC',
    bankName: 'HSBC Việt Nam',
    aliases: ['HSBC'],
  },
  {
    bankBin: '970446',
    bankCode: 'COOPBANK',
    bankName: 'Co-opBank (Ngân hàng Hợp tác xã Việt Nam)',
    aliases: ['COOPBANK', 'COOP'],
  },
  {
    bankBin: '970400',
    bankCode: 'SGB',
    bankName: 'SaigonBank (Ngân hàng TMCP Sài Gòn Công Thương)',
    aliases: ['SGB', 'SAIGONBANK', 'SGICB'],
  },
  {
    bankBin: '970439',
    bankCode: 'PBVN',
    bankName: 'Public Bank Việt Nam',
    aliases: ['PBVN', 'PUBLICBANK', 'PUBLIC BANK'],
  },
  {
    bankBin: '970406',
    bankCode: 'DOB',
    bankName: 'DongA Bank (Ngân hàng TMCP Đông Á)',
    aliases: ['DOB', 'DONGABANK', 'DONG A'],
  },
  {
    bankBin: '970408',
    bankCode: 'GPB',
    bankName: 'GPBank (Ngân hàng TM TNHH MTV Dầu Khí Toàn Cầu)',
    aliases: ['GPB', 'GPBANK'],
  },
  {
    bankBin: '970434',
    bankCode: 'IVB',
    bankName: 'Indovina Bank',
    aliases: ['IVB', 'INDOVINA'],
  },
  {
    bankBin: '970421',
    bankCode: 'VRB',
    bankName: 'VRB (Ngân hàng Liên doanh Việt - Nga)',
    aliases: ['VRB', 'VIET NGA'],
  },
] as const;

function normalizeBankToken(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

export function resolveSePayBankMeta(
  bankCodeOrName?: string | null,
  bankBin?: string | null,
): SePayBankMeta {
  const defaultEntry = SEPAY_BANK_DIRECTORY[0]!;
  const rawCode = bankCodeOrName?.trim() ?? '';
  const rawBin = (bankBin?.trim() ?? '').replace(/[^0-9]/g, '');

  if (rawCode) {
    const token = normalizeBankToken(rawCode);
    const byCode = SEPAY_BANK_DIRECTORY.find(
      (entry) =>
        normalizeBankToken(entry.bankCode) === token ||
        entry.bankBin === rawCode ||
        entry.aliases.some((alias) => normalizeBankToken(alias) === token),
    );
    if (byCode) {
      return {
        bankBin: byCode.bankBin,
        bankCode: byCode.bankCode,
        bankName: byCode.bankName,
      };
    }
  }

  if (rawBin) {
    const byBin = SEPAY_BANK_DIRECTORY.find((entry) => entry.bankBin === rawBin);
    if (byBin) {
      return {
        bankBin: byBin.bankBin,
        bankCode: byBin.bankCode,
        bankName: byBin.bankName,
      };
    }
  }

  if (rawCode || rawBin) {
    return {
      bankBin: rawBin || defaultEntry.bankBin,
      bankCode: rawCode ? rawCode.toUpperCase() : defaultEntry.bankCode,
      bankName: rawCode || defaultEntry.bankName,
    };
  }

  return {
    bankBin: defaultEntry.bankBin,
    bankCode: defaultEntry.bankCode,
    bankName: defaultEntry.bankName,
  };
}
