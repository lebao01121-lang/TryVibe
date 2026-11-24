import {
  FitType,
  Gender,
  ProductStatus,
  SizeCode,
  StockStatusSummary,
  StretchLevel,
  TryOnGarmentCategory,
  type ProductSpuDto,
  type SizeChartDto,
} from '@atelier/contracts';

export interface OccasionCard {
  key: string;
  slug: string;
  title: string;
  tagline: string;
  paletteBg: string;
  paletteInk: string;
  accentHex: string;
  featuredCount: number;
}

export interface SeasonDrop {
  slug: string;
  months: string;
  title: string;
  note: string;
  isCurrent: boolean;
}

export interface PackagingTier {
  id: string;
  name: string;
  description: string;
  priceVnd: number;
  swatchHex: string;
}

export interface CategoryNavItem {
  slug: string;
  name: string;
}

export const FORMAT_VND = (amount: number): string =>
  `${new Intl.NumberFormat('vi-VN').format(amount)}₫`;

export const CATEGORY_TABS: CategoryNavItem[] = [
  { slug: 'ao-blazer', name: 'Áo & Blazer' },
  { slug: 'ao-so-mi', name: 'Áo Sơ Mi' },
  { slug: 'quan-chan-vay', name: 'Quần & Chân Váy' },
  { slug: 'dam-du-tiec', name: 'Đầm Dự Tiệc' },
  { slug: 'ao-khoac', name: 'Áo Khoác' },
  { slug: 'phu-kien', name: 'Phụ Kiện' },
];

export const OCCASION_CATALOG: OccasionCard[] = [
  {
    key: 'cong-so-hien-dai',
    slug: 'cong-so-hien-dai',
    title: 'Công sở hiện đại',
    tagline: 'Đường cắt tinh gọn, chất liệu lụa và linen thoáng nhẹ suốt 8 giờ.',
    paletteBg: '#F4EBDA',
    paletteInk: '#2B2019',
    accentHex: '#B08A4A',
    featuredCount: 4,
  },
  {
    key: 'du-tiec-toi',
    slug: 'du-tiec-toi',
    title: 'Dự tiệc tối',
    tagline: 'Phom dáng đầm lụa satin ánh champagne, khâu tay tinh xảo dưới ánh nến.',
    paletteBg: '#1C1410',
    paletteInk: '#FBF7EF',
    accentHex: '#EBCF8F',
    featuredCount: 3,
  },
  {
    key: 'cuoi-tuan-thu-thai',
    slug: 'cuoi-tuan-thu-thai',
    title: 'Cuối tuần thư thái',
    tagline: 'Phom suông tự do, dễ phối nhiều lớp cùng áo khoác nhẹ.',
    paletteBg: '#EFE7DA',
    paletteInk: '#2B2019',
    accentHex: '#8A672C',
    featuredCount: 4,
  },
  {
    key: 'nghi-duong-bien',
    slug: 'nghi-duong-bien',
    title: 'Nghỉ dưỡng biển',
    tagline: 'Vải tơ tằm Bảo Lộc và linen hữu cơ mềm rủ theo gió biển.',
    paletteBg: '#F7F0E3',
    paletteInk: '#2B2019',
    accentHex: '#B08A4A',
    featuredCount: 3,
  },
  {
    key: 'trien-lam-nghe-thuat',
    slug: 'trien-lam-nghe-thuat',
    title: 'Triển lãm nghệ thuật',
    tagline: 'Bản sắc Quiet Luxury tối giản cùng chất liệu dệt thủ công.',
    paletteBg: '#FBF7EF',
    paletteInk: '#2B2019',
    accentHex: '#9C7535',
    featuredCount: 3,
  },
  {
    key: 'le-cuoi-thanh-lich',
    slug: 'le-cuoi-thanh-lich',
    title: 'Lễ cưới thanh lịch',
    tagline: 'Bảng màu trung tính trang nhã, đi kèm hộp quà và thiệp viết tay.',
    paletteBg: '#EFE4D3',
    paletteInk: '#2B2019',
    accentHex: '#8A672C',
    featuredCount: 3,
  },
];

export const SEASON_DROPS: SeasonDrop[] = [
  {
    slug: 'xuan-tam-xuan',
    months: 'Tháng 1 – 2',
    title: 'Xuân Tầm Xuân',
    note: 'Tơ tằm dệt nổi và phom cổ trụ thanh thoát.',
    isCurrent: false,
  },
  {
    slug: 'ha-pho-co',
    months: 'Tháng 3 – 4',
    title: 'Hạ Phố Cổ',
    note: 'Sợi linen hữu cơ màu cát ngà, thoáng mát và ít nhăn.',
    isCurrent: false,
  },
  {
    slug: 'resort-ban-mai',
    months: 'Tháng 5 – 6',
    title: 'Resort Ban Mai',
    note: 'Đầm bias-cut rủ nhẹ ôm chuyển động cơ thể.',
    isCurrent: false,
  },
  {
    slug: 'thu-hoang-hon',
    months: 'Tháng 7 – 8',
    title: 'Thu Hoàng Hôn',
    note: 'Blazer không dựng vai cứng kết hợp quần tây xếp ly chuẩn mực.',
    isCurrent: false,
  },
  {
    slug: 'dong-cashmere',
    months: 'Tháng 9 – 10',
    title: 'Đông Cashmere',
    note: 'Len Merino và Tweed dệt thủ công giữ ấm thanh mảnh.',
    isCurrent: false,
  },
  {
    slug: 'atelier-di-san',
    months: 'Tháng 11 – 12',
    title: 'Atelier Di Sản',
    note: 'Sắc cacao trầm, vàng champagne và đính kết thủ công.',
    isCurrent: true,
  },
];

export const PACKAGING_TIERS: PackagingTier[] = [
  {
    id: 'tui-vai-linen-moc',
    name: 'Túi vải Dustbag Linen tiêu chuẩn',
    description: 'Chống bụi thoáng khí cho trang phục lụa & wool, tặng kèm đơn hàng.',
    priceVnd: 0,
    swatchHex: '#E8DEC8',
  },
  {
    id: 'hop-lua-co-dien',
    name: 'Hộp cứng Signature Ivory + Giấy nến',
    description: 'Hộp ép kim logo Atelier kèm giấy lót không axit bảo quản sợi vải.',
    priceVnd: 80000,
    swatchHex: '#FBF7EF',
  },
  {
    id: 'hop-qua-khac-ten-gold',
    name: 'Hộp quà Cocoa + Nơ lụa & Thiệp viết tay',
    description: 'Kèm xịt hương vải trà trắng và thiệp viết tay cá nhân hóa.',
    priceVnd: 150000,
    swatchHex: '#1C1410',
  },
];

const DEFAULT_MINIO_PUBLIC = (
  process.env.NEXT_PUBLIC_MINIO_URL ||
  process.env.MINIO_PUBLIC_URL ||
  'http://127.0.0.1:9000'
).replace(/\/$/, '');

function getSeedRealAssetUrl(
  slug: string,
  kind: 'lookbook' | 'flat-preview' | 'rack-2x3' | 'rack-back-2x3',
): string {
  return `${DEFAULT_MINIO_PUBLIC}/atelier-public/seed/${slug}-${kind}.webp`;
}

const FALLBACK_SIZE_CHART_TOPS: SizeChartDto = {
  id: 'chart-fallback-tops',
  code: 'TOPS_WOMEN_VN',
  name: 'Bảng số đo Áo & Blazer chuẩn Atelier',
  gender: Gender.WOMEN,
  garmentCategory: 'UPPER',
  fitNote: 'Form dáng tiêu chuẩn Atelier; nếu thích mặc rộng chọn tăng 1 cỡ.',
  rows: [
    { sizeCode: SizeCode.XS, heightMinCm: 148, heightMaxCm: 158, weightMinKg: 40, weightMaxKg: 47, bustCm: 80, waistCm: 62, hipCm: 86, shoulderCm: 36, lengthCm: 60 },
    { sizeCode: SizeCode.S, heightMinCm: 155, heightMaxCm: 164, weightMinKg: 46, weightMaxKg: 53, bustCm: 84, waistCm: 66, hipCm: 90, shoulderCm: 37.5, lengthCm: 62 },
    { sizeCode: SizeCode.M, heightMinCm: 160, heightMaxCm: 169, weightMinKg: 52, weightMaxKg: 60, bustCm: 88, waistCm: 70, hipCm: 94, shoulderCm: 39, lengthCm: 64 },
    { sizeCode: SizeCode.L, heightMinCm: 165, heightMaxCm: 175, weightMinKg: 59, weightMaxKg: 68, bustCm: 93, waistCm: 75, hipCm: 99, shoulderCm: 40.5, lengthCm: 66 },
    { sizeCode: SizeCode.XL, heightMinCm: 170, heightMaxCm: 182, weightMinKg: 67, weightMaxKg: 78, bustCm: 98, waistCm: 80, hipCm: 104, shoulderCm: 42, lengthCm: 68 },
  ],
};

function buildFallbackSkus(variantId: string, prefix: string, price: number) {
  return [SizeCode.XS, SizeCode.S, SizeCode.M, SizeCode.L, SizeCode.XL].map(
    (sizeCode, idx) => ({
      id: `${variantId}-${sizeCode}`,
      variantId,
      skuCode: `${prefix}-${sizeCode}`,
      sizeCode,
      basePriceVnd: price,
      salePriceVnd: price,
      weightGrams: 320 + idx * 15,
      inStock: sizeCode !== SizeCode.XL || prefix.includes('BLZ'),
      isReturnable: true,
    }),
  );
}

export const FALLBACK_PRODUCTS: ProductSpuDto[] = [
  {
    id: 'fallback-blazer-linen',
    categoryId: 'cat-ao-blazer',
    categorySlug: 'ao-blazer',
    categoryName: 'Áo & Blazer',
    slug: 'ao-blazer-linen-dang-suong',
    name: 'Áo Blazer Linen Dáng Suông',
    subtitle: 'Linen hữu cơ dệt thưa · Dựng vai mềm không gò bó',
    brandName: 'Tầm Xuân Atelier',
    description:
      'Thiết kế blazer một hàng khuy cúc sừng tự nhiên, lót nửa thân bằng lụa Habotai thoáng khí cho ngày công sở và dạo phố.',
    fabricComposition: '100% Linen Hữu Cơ 240gsm · Lót lụa Habotai',
    fitType: FitType.RELAXED,
    stretchLevel: StretchLevel.NONE,
    fabricWeight: '240gsm',
    gender: Gender.WOMEN,
    isTryonEnabled: true,
    tryonGarmentCategory: TryOnGarmentCategory.UPPER,
    tryonFlatAssetUrl: getSeedRealAssetUrl('ao-blazer-linen-dang-suong', 'flat-preview'),
    fitCalibrationNote: 'Phom suông nhẹ — giữ đúng size quen thuộc.',
    minPriceVnd: 3250000,
    stockStatusSummary: StockStatusSummary.IN_STOCK,
    status: ProductStatus.PUBLISHED,
    sizeChartId: FALLBACK_SIZE_CHART_TOPS.id,
    sizeChart: FALLBACK_SIZE_CHART_TOPS,
    occasionSlugs: ['cong-so-hien-dai', 'cuoi-tuan-thu-thai'],
    seasonSlugs: ['thu-hoang-hon', 'ha-pho-co'],
    variants: [
      {
        id: 'var-blz-ivory',
        productId: 'fallback-blazer-linen',
        colorName: 'Kem Ngà',
        colorHex: '#EFE7DA',
        lookbookMainUrl: getSeedRealAssetUrl('ao-blazer-linen-dang-suong', 'lookbook'),
        rackFrontAssetId: null,
        rackBackAssetId: null,
        rackFrontUrl: getSeedRealAssetUrl('ao-blazer-linen-dang-suong', 'rack-2x3'),
        rackBackUrl: getSeedRealAssetUrl('ao-blazer-linen-dang-suong', 'rack-back-2x3'),
        studioLayerAssetId: null,
        tryonFlatPreviewUrl: getSeedRealAssetUrl('ao-blazer-linen-dang-suong', 'flat-preview'),
        layerSpecJsonb: null,
        skus: buildFallbackSkus('var-blz-ivory', 'AT-BLZ-IVR', 3250000),
      },
      {
        id: 'var-blz-cocoa',
        productId: 'fallback-blazer-linen',
        colorName: 'Nâu Cacao',
        colorHex: '#2A1E17',
        lookbookMainUrl: getSeedRealAssetUrl('ao-blazer-linen-dang-suong', 'lookbook'),
        rackFrontAssetId: null,
        rackBackAssetId: null,
        rackFrontUrl: getSeedRealAssetUrl('ao-blazer-linen-dang-suong', 'rack-2x3'),
        rackBackUrl: getSeedRealAssetUrl('ao-blazer-linen-dang-suong', 'rack-back-2x3'),
        studioLayerAssetId: null,
        tryonFlatPreviewUrl: getSeedRealAssetUrl('ao-blazer-linen-dang-suong', 'flat-preview'),
        layerSpecJsonb: null,
        skus: buildFallbackSkus('var-blz-cocoa', 'AT-BLZ-COC', 3250000),
      },
    ],
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
  },
  {
    id: 'fallback-silk-shirt',
    categoryId: 'cat-ao-so-mi',
    categorySlug: 'ao-so-mi',
    categoryName: 'Áo Sơ Mi',
    slug: 'ao-so-mi-lua-to-tam-tam-xuan',
    name: 'Áo Sơ Mi Lụa Tơ Tằm Tầm Xuân',
    subtitle: 'Lụa Bảo Lộc 19 momme · Nẹp giấu khuy tối giản',
    brandName: 'Tầm Xuân Atelier',
    description:
      'Chất lụa tơ tằm bóng mờ tự nhiên, đường may lộn giấu chỉ bên trong tinh xảo.',
    fabricComposition: '100% Lụa Tơ Tằm Bảo Lộc 19 momme',
    fitType: FitType.REGULAR,
    stretchLevel: StretchLevel.NONE,
    fabricWeight: '19 momme',
    gender: Gender.WOMEN,
    isTryonEnabled: true,
    tryonGarmentCategory: TryOnGarmentCategory.UPPER,
    tryonFlatAssetUrl: getSeedRealAssetUrl('ao-so-mi-lua-to-tam-tam-xuan', 'flat-preview'),
    fitCalibrationNote: 'Vải lụa không co giãn — ưu tiên thoải mái vùng vai.',
    minPriceVnd: 1850000,
    stockStatusSummary: StockStatusSummary.IN_STOCK,
    status: ProductStatus.PUBLISHED,
    sizeChartId: FALLBACK_SIZE_CHART_TOPS.id,
    sizeChart: FALLBACK_SIZE_CHART_TOPS,
    occasionSlugs: ['cong-so-hien-dai', 'trien-lam-nghe-thuat'],
    seasonSlugs: ['xuan-tam-xuan', 'thu-hoang-hon'],
    variants: [
      {
        id: 'var-sml-champagne',
        productId: 'fallback-silk-shirt',
        colorName: 'Vàng Champagne',
        colorHex: '#EBD9B4',
        lookbookMainUrl: getSeedRealAssetUrl('ao-so-mi-lua-to-tam-tam-xuan', 'lookbook'),
        rackFrontAssetId: null,
        rackBackAssetId: null,
        rackFrontUrl: getSeedRealAssetUrl('ao-so-mi-lua-to-tam-tam-xuan', 'rack-2x3'),
        rackBackUrl: getSeedRealAssetUrl('ao-so-mi-lua-to-tam-tam-xuan', 'rack-back-2x3'),
        studioLayerAssetId: null,
        tryonFlatPreviewUrl: getSeedRealAssetUrl('ao-so-mi-lua-to-tam-tam-xuan', 'flat-preview'),
        layerSpecJsonb: null,
        skus: buildFallbackSkus('var-sml-champagne', 'AT-SML-CHP', 1850000),
      },
    ],
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
  },
  {
    id: 'fallback-evening-gown',
    categoryId: 'cat-dam-du-tiec',
    categorySlug: 'dam-du-tiec',
    categoryName: 'Đầm Dự Tiệc',
    slug: 'dam-du-tiec-lua-satin-co-do',
    name: 'Đầm Dự Tiệc Lụa Satin Cổ Đổ',
    subtitle: 'Cắt chéo sợi 45° tôn đường cong mềm mại',
    brandName: 'Tầm Xuân Atelier',
    description:
      'Phom đầm bias-cut rủ dọc tự nhiên theo chuyển động, phù hợp tiệc tối và sự kiện trang trọng.',
    fabricComposition: '100% Silk Satin 22 momme',
    fitType: FitType.REGULAR,
    stretchLevel: StretchLevel.LIGHT,
    fabricWeight: '22 momme',
    gender: Gender.WOMEN,
    isTryonEnabled: true,
    tryonGarmentCategory: TryOnGarmentCategory.OVERALL,
    tryonFlatAssetUrl: getSeedRealAssetUrl('dam-du-tiec-lua-satin-co-do', 'flat-preview'),
    fitCalibrationNote: 'Cắt bias ôm nhẹ phần eo, nên chọn đúng cỡ thực tế.',
    minPriceVnd: 3450000,
    stockStatusSummary: StockStatusSummary.IN_STOCK,
    status: ProductStatus.PUBLISHED,
    sizeChartId: FALLBACK_SIZE_CHART_TOPS.id,
    sizeChart: FALLBACK_SIZE_CHART_TOPS,
    occasionSlugs: ['du-tiec-toi', 'le-cuoi-thanh-lich'],
    seasonSlugs: ['atelier-di-san'],
    variants: [
      {
        id: 'var-ddt-cocoa',
        productId: 'fallback-evening-gown',
        colorName: 'Cacao Trầm',
        colorHex: '#1C1410',
        lookbookMainUrl: getSeedRealAssetUrl('dam-du-tiec-lua-satin-co-do', 'lookbook'),
        rackFrontAssetId: null,
        rackBackAssetId: null,
        rackFrontUrl: getSeedRealAssetUrl('dam-du-tiec-lua-satin-co-do', 'rack-2x3'),
        rackBackUrl: getSeedRealAssetUrl('dam-du-tiec-lua-satin-co-do', 'rack-back-2x3'),
        studioLayerAssetId: null,
        tryonFlatPreviewUrl: getSeedRealAssetUrl('dam-du-tiec-lua-satin-co-do', 'flat-preview'),
        layerSpecJsonb: null,
        skus: buildFallbackSkus('var-ddt-cocoa', 'AT-DDT-COC', 3450000),
      },
    ],
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
  },
  {
    id: 'fallback-tailored-trousers',
    categoryId: 'cat-quan-chan-vay',
    categorySlug: 'quan-chan-vay',
    categoryName: 'Quần & Chân Váy',
    slug: 'quan-tay-ong-suong-xep-ly-doi',
    name: 'Quần Tây Ống Suông Xếp Ly Đôi',
    subtitle: 'Cạp cao hai ly sâu · Wool lạnh thoáng nhẹ',
    brandName: 'Tầm Xuân Atelier',
    description:
      'Quần tây ống suông tạo tỷ lệ thanh thoát, ít nhăn khi di chuyển và ngồi làm việc.',
    fabricComposition: '65% Wool Lạnh · 35% Tencel',
    fitType: FitType.RELAXED,
    stretchLevel: StretchLevel.LIGHT,
    fabricWeight: '210gsm',
    gender: Gender.WOMEN,
    isTryonEnabled: true,
    tryonGarmentCategory: TryOnGarmentCategory.LOWER,
    tryonFlatAssetUrl: getSeedRealAssetUrl('quan-tay-ong-suong-xep-ly-doi', 'flat-preview'),
    fitCalibrationNote: 'Cạp cao ngang rốn — đo chuẩn vòng eo nhỏ nhất.',
    minPriceVnd: 2150000,
    stockStatusSummary: StockStatusSummary.IN_STOCK,
    status: ProductStatus.PUBLISHED,
    sizeChartId: FALLBACK_SIZE_CHART_TOPS.id,
    sizeChart: FALLBACK_SIZE_CHART_TOPS,
    occasionSlugs: ['cong-so-hien-dai', 'cuoi-tuan-thu-thai'],
    seasonSlugs: ['thu-hoang-hon', 'dong-cashmere'],
    variants: [
      {
        id: 'var-qt-sand',
        productId: 'fallback-tailored-trousers',
        colorName: 'Cát Ngà',
        colorHex: '#E6D6BC',
        lookbookMainUrl: getSeedRealAssetUrl('quan-tay-ong-suong-xep-ly-doi', 'lookbook'),
        rackFrontAssetId: null,
        rackBackAssetId: null,
        rackFrontUrl: getSeedRealAssetUrl('quan-tay-ong-suong-xep-ly-doi', 'rack-2x3'),
        rackBackUrl: getSeedRealAssetUrl('quan-tay-ong-suong-xep-ly-doi', 'rack-back-2x3'),
        studioLayerAssetId: null,
        tryonFlatPreviewUrl: getSeedRealAssetUrl('quan-tay-ong-suong-xep-ly-doi', 'flat-preview'),
        layerSpecJsonb: null,
        skus: buildFallbackSkus('var-qt-sand', 'AT-QT-SND', 2150000),
      },
    ],
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
  },
];

export function extractProductArray(raw: unknown): ProductSpuDto[] {
  if (Array.isArray(raw)) {
    return raw as ProductSpuDto[];
  }
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    if (Array.isArray(record.items)) {
      return record.items as ProductSpuDto[];
    }
    if (Array.isArray(record.products)) {
      return record.products as ProductSpuDto[];
    }
    if (Array.isArray(record.hits)) {
      return record.hits as ProductSpuDto[];
    }
  }
  return [];
}

export function getPrimaryVariantImage(
  product: ProductSpuDto,
  variantIndex = 0,
): { lookbookUrl: string; flatUrl: string } {
  const variant = product.variants[variantIndex] ?? product.variants[0];
  const fallbackLookbook = getSeedRealAssetUrl(product.slug, 'lookbook');
  const fallbackFlat = getSeedRealAssetUrl(product.slug, 'flat-preview');

  const lookbookUrl =
    variant?.lookbookMainUrl ||
    variant?.rackFrontUrl ||
    product.tryonFlatAssetUrl ||
    fallbackLookbook;

  const flatUrl =
    variant?.tryonFlatPreviewUrl ||
    product.tryonFlatAssetUrl ||
    variant?.lookbookMainUrl ||
    fallbackFlat;

  return { lookbookUrl, flatUrl };
}
