import { createHash } from 'node:crypto';
import type { AtelierDbClient } from '@atelier/db-client';
import {
  FitType,
  Gender,
  ProductStatus,
  SizeCode,
  StockStatusSummary,
  StretchLevel,
  SubmissionStatus,
  TryOnGarmentCategory,
  type AtelierStep,
  type CampaignFinale,
  type CampaignHero,
  type CampaignIntro,
  type SizeMeasurementRow,
} from '@atelier/contracts';
import type { CatalogLookbookConfig } from '../config/env';
import {
  SeedAssetGenerator,
  type CampaignEditorialAssetUrls,
  type GarmentAssetSpec,
  type GarmentSilhouetteKind,
} from './asset-generator';

export const SUPPLIER_A_ID = '11111111-1111-4111-8111-111111111101';
export const SUPPLIER_B_ID = '22222222-2222-4222-8222-222222222202';
export const SUPPLIER_C_ID = '33333333-3333-4333-8333-333333333303';

export const SEED_SUBMISSION_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01';
export const SEED_SUBMISSION_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02';

function deterministicUuid(seedKey: string): string {
  const hex = createHash('sha256').update(`atelier-catalog-v3:${seedKey}`).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

const SIZES_STANDARD: readonly SizeCode[] = [
  SizeCode.XS,
  SizeCode.S,
  SizeCode.M,
  SizeCode.L,
  SizeCode.XL,
];

interface SeedProductDef {
  slug: string;
  skuPrefix?: string;
  categorySlug: string;
  sizeChartCode: 'CHART_TOPS_BLAZER' | 'CHART_BOTTOMS_SKIRTS' | 'CHART_DRESSES';
  name: string;
  subtitle: string;
  description: string;
  fabricComposition: string;
  fitType: FitType;
  stretchLevel: StretchLevel;
  fabricWeight: number;
  gender: Gender;
  isTryonEnabled: boolean;
  tryonGarmentCategory: TryOnGarmentCategory;
  fitCalibrationNote: string;
  occasionSlugs: string[];
  seasonSlugs: string[];
  silhouette: GarmentSilhouetteKind;
  supplierId: string;
  basePriceVnd: number;
  salePriceVnd: number | null;
  costPriceVnd: number;
  weightGrams: number;
  slotCategory: 'TOP' | 'BOTTOM' | 'ONE_PIECE' | 'OUTERWEAR' | 'ACCESSORY';
  variants: Array<{
    colorName: string;
    colorHex: string;
    accentHex: string;
    shadeHex: string;
  }>;
}

const CATEGORIES_SEED = [
  {
    slug: 'ao-blazer',
    name: 'Áo Blazer',
    description: 'Blazer may đo dựng vai thủ công phom dáng chuẩn mực.',
    sortOrder: 1,
  },
  {
    slug: 'ao-so-mi',
    name: 'Áo Sơ Mi & Áo Kiểu',
    description: 'Áo lụa tơ tằm Bảo Lộc, organza và dệt kim tinh giản.',
    sortOrder: 2,
  },
  {
    slug: 'quan-chan-vay',
    name: 'Quần & Chân Váy',
    description: 'Quần tây xếp ly đôi, culottes linen và chân váy midi cạp cao.',
    sortOrder: 3,
  },
  {
    slug: 'dam-du-tiec',
    name: 'Đầm Dự Tiệc & Đầm Midi',
    description: 'Thiết kế đầm lụa satin cổ đổ và đầm chiết eo dạ tiệc.',
    sortOrder: 4,
  },
  {
    slug: 'ao-khoac',
    name: 'Áo Khoác Atelier',
    description: 'Trench coat gabardine, tweed dệt thủ công và cardigan merino.',
    sortOrder: 5,
  },
  {
    slug: 'phu-kien',
    name: 'Phụ Kiện Thủ Công',
    description: 'Khăn lụa cổ, ghim cài đồng thau và túi đóng gói Atelier.',
    sortOrder: 6,
  },
] as const;

const SIZE_CHARTS_SEED: ReadonlyArray<{
  code: 'CHART_TOPS_BLAZER' | 'CHART_BOTTOMS_SKIRTS' | 'CHART_DRESSES';
  name: string;
  gender: Gender;
  garmentGroup: string;
  fitNote: string;
  rows: SizeMeasurementRow[];
}> = [
  {
    code: 'CHART_TOPS_BLAZER',
    name: 'Bảng Size Áo & Blazer Chuẩn Atelier',
    gender: Gender.WOMEN,
    garmentGroup: 'TOPS_BLAZER',
    fitNote:
      'Ưu tiên đo rộng vai và vòng ngực. Với vải lụa/linen không co giãn, chọn tăng 1 cỡ nếu nằm gần ngưỡng trên.',
    rows: [
      { sizeCode: SizeCode.XS, heightMinCm: 150, heightMaxCm: 158, weightMinKg: 40, weightMaxKg: 46, bustCm: 80, waistCm: 62, hipCm: 86, shoulderCm: 36, lengthCm: 62 },
      { sizeCode: SizeCode.S, heightMinCm: 155, heightMaxCm: 163, weightMinKg: 46, weightMaxKg: 52, bustCm: 84, waistCm: 66, hipCm: 90, shoulderCm: 37.5, lengthCm: 64 },
      { sizeCode: SizeCode.M, heightMinCm: 160, heightMaxCm: 168, weightMinKg: 52, weightMaxKg: 58, bustCm: 88, waistCm: 70, hipCm: 94, shoulderCm: 39, lengthCm: 66 },
      { sizeCode: SizeCode.L, heightMinCm: 163, heightMaxCm: 172, weightMinKg: 58, weightMaxKg: 65, bustCm: 93, waistCm: 75, hipCm: 99, shoulderCm: 40.5, lengthCm: 68 },
      { sizeCode: SizeCode.XL, heightMinCm: 166, heightMaxCm: 176, weightMinKg: 65, weightMaxKg: 74, bustCm: 98, waistCm: 80, hipCm: 104, shoulderCm: 42, lengthCm: 70 },
    ],
  },
  {
    code: 'CHART_BOTTOMS_SKIRTS',
    name: 'Bảng Size Quần Tây & Chân Váy Cạp Cao',
    gender: Gender.WOMEN,
    garmentGroup: 'BOTTOMS_SKIRTS',
    fitNote:
      'Đo vòng eo trên rốn 2cm và vòng hông đầy nhất. Quần ống suông ưu tiên vừa vòng hông.',
    rows: [
      { sizeCode: SizeCode.XS, heightMinCm: 150, heightMaxCm: 158, weightMinKg: 40, weightMaxKg: 46, bustCm: null, waistCm: 61, hipCm: 85, shoulderCm: null, lengthCm: 96 },
      { sizeCode: SizeCode.S, heightMinCm: 155, heightMaxCm: 163, weightMinKg: 46, weightMaxKg: 52, bustCm: null, waistCm: 65, hipCm: 89, shoulderCm: null, lengthCm: 98 },
      { sizeCode: SizeCode.M, heightMinCm: 160, heightMaxCm: 168, weightMinKg: 52, weightMaxKg: 58, bustCm: null, waistCm: 69, hipCm: 93, shoulderCm: null, lengthCm: 100 },
      { sizeCode: SizeCode.L, heightMinCm: 163, heightMaxCm: 172, weightMinKg: 58, weightMaxKg: 65, bustCm: null, waistCm: 74, hipCm: 98, shoulderCm: null, lengthCm: 102 },
      { sizeCode: SizeCode.XL, heightMinCm: 166, heightMaxCm: 176, weightMinKg: 65, weightMaxKg: 74, bustCm: null, waistCm: 79, hipCm: 103, shoulderCm: null, lengthCm: 104 },
    ],
  },
  {
    code: 'CHART_DRESSES',
    name: 'Bảng Size Đầm Dự Tiệc & Đầm Midi',
    gender: Gender.WOMEN,
    garmentGroup: 'DRESSES',
    fitNote:
      'Thiết kế chiết eo chuẩn rập 3D. Đầm lụa satin không co giãn cần khoảng thở tối thiểu 1.5cm tại vòng eo.',
    rows: [
      { sizeCode: SizeCode.XS, heightMinCm: 150, heightMaxCm: 158, weightMinKg: 40, weightMaxKg: 46, bustCm: 80, waistCm: 62, hipCm: 86, shoulderCm: 35.5, lengthCm: 112 },
      { sizeCode: SizeCode.S, heightMinCm: 155, heightMaxCm: 163, weightMinKg: 46, weightMaxKg: 52, bustCm: 84, waistCm: 66, hipCm: 90, shoulderCm: 37, lengthCm: 115 },
      { sizeCode: SizeCode.M, heightMinCm: 160, heightMaxCm: 168, weightMinKg: 52, weightMaxKg: 58, bustCm: 88, waistCm: 70, hipCm: 94, shoulderCm: 38.5, lengthCm: 118 },
      { sizeCode: SizeCode.L, heightMinCm: 163, heightMaxCm: 172, weightMinKg: 58, weightMaxKg: 65, bustCm: 93, waistCm: 75, hipCm: 99, shoulderCm: 40, lengthCm: 120 },
      { sizeCode: SizeCode.XL, heightMinCm: 166, heightMaxCm: 176, weightMinKg: 65, weightMaxKg: 74, bustCm: 98, waistCm: 80, hipCm: 104, shoulderCm: 41.5, lengthCm: 122 },
    ],
  },
];

const PRODUCTS_SEED: readonly SeedProductDef[] = [
  {
    slug: 'ao-blazer-linen-dang-suong',
    categorySlug: 'ao-blazer',
    sizeChartCode: 'CHART_TOPS_BLAZER',
    name: 'Áo Blazer Linen Dáng Suông',
    subtitle: 'Linen Bỉ 240gsm dựng vai mảnh · Lót lụa habotai',
    description:
      'Áo blazer dáng suông cổ điển cắt tay theo tỷ lệ vai chuẩn Việt, sử dụng sợi linen Bỉ thoáng khí kết hợp khuy sừng tự nhiên.',
    fabricComposition: '100% Linen hữu cơ Bỉ 240gsm · Lót lụa Habotai',
    fitType: FitType.RELAXED,
    stretchLevel: StretchLevel.NONE,
    fabricWeight: 240,
    gender: Gender.WOMEN,
    isTryonEnabled: true,
    tryonGarmentCategory: TryOnGarmentCategory.UPPER,
    fitCalibrationNote: 'Phom dáng suông thanh lịch, chuẩn size theo rộng vai.',
    occasionSlugs: ['cong-so-hien-dai', 'trien-lam-nghe-thuat'],
    seasonSlugs: ['xuan-tam-xuan', 'thu-hoang-hon'],
    silhouette: 'blazer',
    supplierId: SUPPLIER_A_ID,
    basePriceVnd: 3_250_000,
    salePriceVnd: 2_890_000,
    costPriceVnd: 1_120_000,
    weightGrams: 540,
    slotCategory: 'OUTERWEAR',
    variants: [
      { colorName: 'Cát Ngà', colorHex: '#D8C9B4', accentHex: '#9E7B43', shadeHex: '#8E7D67' },
      { colorName: 'Cacao Đậm', colorHex: '#3A2A22', accentHex: '#C7A262', shadeHex: '#1C1410' },
    ],
  },
  {
    slug: 'ao-so-mi-lua-to-tam-tam-xuan',
    categorySlug: 'ao-so-mi',
    sizeChartCode: 'CHART_TOPS_BLAZER',
    name: 'Áo Sơ Mi Lụa Tơ Tằm Tầm Xuân',
    subtitle: 'Lụa tơ tằm Bảo Lộc 19 momme · Nẹp giấu khuy ngọc trai',
    description:
      'Thiết kế biểu tượng của nhà mốt với độ rủ mềm mại từ lụa tơ tằm Bảo Lộc dệt mật độ cao, bề mặt óng nhẹ tự nhiên.',
    fabricComposition: '100% Lụa tơ tằm Bảo Lộc 19 momme',
    fitType: FitType.REGULAR,
    stretchLevel: StretchLevel.NONE,
    fabricWeight: 120,
    gender: Gender.WOMEN,
    isTryonEnabled: true,
    tryonGarmentCategory: TryOnGarmentCategory.UPPER,
    fitCalibrationNote: 'Lụa không co giãn; nếu giữa 2 size khuyến nghị chọn cỡ lớn hơn.',
    occasionSlugs: ['cong-so-hien-dai', 'cuoi-tuan-thu-thai', 'le-cuoi-thanh-lich'],
    seasonSlugs: ['xuan-tam-xuan', 'ha-pho-co', 'atelier-di-san'],
    silhouette: 'shirt',
    supplierId: SUPPLIER_A_ID,
    basePriceVnd: 1_950_000,
    salePriceVnd: 1_850_000,
    costPriceVnd: 640_000,
    weightGrams: 220,
    slotCategory: 'TOP',
    variants: [
      { colorName: 'Trắng Ngà', colorHex: '#EFE7DA', accentHex: '#B08A4A', shadeHex: '#B6A995' },
      { colorName: 'Champagne Ấm', colorHex: '#DFCAA6', accentHex: '#8D6933', shadeHex: '#A7906B' },
    ],
  },
  {
    slug: 'dam-du-tiec-lua-satin-co-do',
    categorySlug: 'dam-du-tiec',
    sizeChartCode: 'CHART_DRESSES',
    name: 'Đầm Dự Tiệc Lụa Satin Cổ Đổ',
    subtitle: 'Cắt thiên bias-cut ôm đường cong · Lụa satin 22 momme',
    description:
      'Đầm dạ tiệc cắt thiên thủ công tạo sóng lụa cổ đổ tinh tế, tôn dáng mềm mại dưới ánh đèn tiệc tối.',
    fabricComposition: '100% Lụa Satin tơ tằm 22 momme',
    fitType: FitType.SLIM,
    stretchLevel: StretchLevel.NONE,
    fabricWeight: 165,
    gender: Gender.WOMEN,
    isTryonEnabled: true,
    tryonGarmentCategory: TryOnGarmentCategory.OVERALL,
    fitCalibrationNote: 'Phom slim chiết eo; cân nhắc tăng 1 size nếu vòng eo gần ngưỡng trên.',
    occasionSlugs: ['du-tiec-toi', 'le-cuoi-thanh-lich'],
    seasonSlugs: ['thu-hoang-hon', 'atelier-di-san'],
    silhouette: 'gown',
    supplierId: SUPPLIER_A_ID,
    basePriceVnd: 3_850_000,
    salePriceVnd: 3_490_000,
    costPriceVnd: 1_260_000,
    weightGrams: 360,
    slotCategory: 'ONE_PIECE',
    variants: [
      { colorName: 'Đỏ Rượu Vang', colorHex: '#6E262B', accentHex: '#D8B26E', shadeHex: '#3E1216' },
      { colorName: 'Đen Huyền', colorHex: '#201B19', accentHex: '#C7A262', shadeHex: '#0F0C0B' },
    ],
  },
  {
    slug: 'quan-tay-ong-suong-xep-ly-doi',
    categorySlug: 'quan-chan-vay',
    sizeChartCode: 'CHART_BOTTOMS_SKIRTS',
    name: 'Quần Tây Ống Suông Xếp Ly Đôi',
    subtitle: 'Len pha thoáng nhẹ · Cạp cao kéo dài tỷ lệ chân',
    description:
      'Quần âu xếp ly đôi cạp cao đứng phom, đường ép ly sắc nét phù hợp phối cùng sơ mi lụa hoặc blazer công sở.',
    fabricComposition: '68% Wool pha mịn · 30% Viscose · 2% Elastane',
    fitType: FitType.REGULAR,
    stretchLevel: StretchLevel.LIGHT,
    fabricWeight: 230,
    gender: Gender.WOMEN,
    isTryonEnabled: true,
    tryonGarmentCategory: TryOnGarmentCategory.LOWER,
    fitCalibrationNote: 'Co giãn nhẹ 2%, chọn chuẩn size theo số đo vòng eo.',
    occasionSlugs: ['cong-so-hien-dai', 'trien-lam-nghe-thuat'],
    seasonSlugs: ['thu-hoang-hon', 'dong-cashmere'],
    silhouette: 'trousers',
    supplierId: SUPPLIER_B_ID,
    basePriceVnd: 1_890_000,
    salePriceVnd: null,
    costPriceVnd: 620_000,
    weightGrams: 410,
    slotCategory: 'BOTTOM',
    variants: [
      { colorName: 'Xám Than', colorHex: '#3B3D40', accentHex: '#B08A4A', shadeHex: '#202224' },
      { colorName: 'Be Đá', colorHex: '#C9BEA9', accentHex: '#8E6D3B', shadeHex: '#928772' },
    ],
  },
  {
    slug: 'chan-vay-xep-ly-midi-cap-cao',
    categorySlug: 'quan-chan-vay',
    sizeChartCode: 'CHART_BOTTOMS_SKIRTS',
    name: 'Chân Váy Xếp Ly Midi Cạp Cao',
    subtitle: 'Xếp ly nhiệt cố định · Chuyển động bay nhẹ theo bước chân',
    description:
      'Chân váy midi cạp cao xử lý xếp ly mềm tỉ mỉ, dễ dàng kết hợp đa dạng từ dạo phố cuối tuần tới phòng trưng bày nghệ thuật.',
    fabricComposition: '70% Lụa pha · 30% Tencel cao cấp',
    fitType: FitType.REGULAR,
    stretchLevel: StretchLevel.LIGHT,
    fabricWeight: 175,
    gender: Gender.WOMEN,
    isTryonEnabled: true,
    tryonGarmentCategory: TryOnGarmentCategory.LOWER,
    fitCalibrationNote: 'Cạp cao ôm eo chuẩn; ưu tiên chọn theo vòng eo trên rốn.',
    occasionSlugs: ['cuoi-tuan-thu-thai', 'trien-lam-nghe-thuat', 'cong-so-hien-dai'],
    seasonSlugs: ['xuan-tam-xuan', 'ha-pho-co'],
    silhouette: 'skirt',
    supplierId: SUPPLIER_B_ID,
    basePriceVnd: 1_750_000,
    salePriceVnd: 1_590_000,
    costPriceVnd: 560_000,
    weightGrams: 340,
    slotCategory: 'BOTTOM',
    variants: [
      { colorName: 'Kem Sữa', colorHex: '#EDE3D1', accentHex: '#B08A4A', shadeHex: '#B6A893' },
      { colorName: 'Xanh Khói', colorHex: '#617172', accentHex: '#D5B883', shadeHex: '#3F4B4C' },
    ],
  },
  {
    slug: 'ao-khoac-trench-gabardine-co-dien',
    categorySlug: 'ao-khoac',
    sizeChartCode: 'CHART_TOPS_BLAZER',
    name: 'Áo Khoác Trench Gabardine Cổ Điển',
    subtitle: 'Vải Gabardine trượt nước nhẹ · Đai thắt eo đồng thau',
    description:
      'Áo khoác trench hai hàng khuy cổ điển với đường cắt raglan mềm vai, thích hợp khoác ngoài set đồ công sở hoặc du lịch mùa thu.',
    fabricComposition: '100% Cotton Gabardine dệt khít 285gsm',
    fitType: FitType.RELAXED,
    stretchLevel: StretchLevel.LIGHT,
    fabricWeight: 285,
    gender: Gender.UNISEX,
    isTryonEnabled: true,
    tryonGarmentCategory: TryOnGarmentCategory.UPPER,
    fitCalibrationNote: 'Dáng khoác rộng vừa đủ mặc thêm len mỏng bên trong.',
    occasionSlugs: ['cong-so-hien-dai', 'trien-lam-nghe-thuat'],
    seasonSlugs: ['thu-hoang-hon', 'dong-cashmere'],
    silhouette: 'trench',
    supplierId: SUPPLIER_B_ID,
    basePriceVnd: 4_650_000,
    salePriceVnd: 4_290_000,
    costPriceVnd: 1_650_000,
    weightGrams: 820,
    slotCategory: 'OUTERWEAR',
    variants: [
      { colorName: 'Kaki Cổ Điển', colorHex: '#BDA686', accentHex: '#7A5B2F', shadeHex: '#867054' },
      { colorName: 'Ô Liu Trầm', colorHex: '#59604D', accentHex: '#C7A262', shadeHex: '#373C2F' },
    ],
  },
  {
    slug: 'ao-kieu-lua-organza-phoi-no',
    categorySlug: 'ao-so-mi',
    sizeChartCode: 'CHART_TOPS_BLAZER',
    name: 'Áo Kiểu Lụa Organza Phối Nơ',
    subtitle: 'Organza tơ xuyên thấu tinh tế · Kèm áo hai dây lụa bên trong',
    description:
      'Thiết kế nữ tính với dải nơ cổ thắt thủ công trên nền lụa organza nhẹ tênh, lý tưởng cho buổi tiệc chiều và lễ cưới thanh lịch.',
    fabricComposition: '100% Lụa Organza tơ tằm kèm lớp lót lụa',
    fitType: FitType.REGULAR,
    stretchLevel: StretchLevel.NONE,
    fabricWeight: 95,
    gender: Gender.WOMEN,
    isTryonEnabled: true,
    tryonGarmentCategory: TryOnGarmentCategory.UPPER,
    fitCalibrationNote: 'Vai nhẹ có độ bồng tinh tế, giữ nguyên cỡ tiêu chuẩn.',
    occasionSlugs: ['le-cuoi-thanh-lich', 'du-tiec-toi'],
    seasonSlugs: ['xuan-tam-xuan', 'resort-ban-mai', 'atelier-di-san'],
    silhouette: 'blouse',
    supplierId: SUPPLIER_A_ID,
    basePriceVnd: 2_150_000,
    salePriceVnd: null,
    costPriceVnd: 740_000,
    weightGrams: 190,
    slotCategory: 'TOP',
    variants: [
      { colorName: 'Hồng Phấn Đất', colorHex: '#DFC5BE', accentHex: '#A27848', shadeHex: '#A88A82' },
    ],
  },
  {
    slug: 'dam-midi-co-vuong-chiet-eo',
    categorySlug: 'dam-du-tiec',
    sizeChartCode: 'CHART_DRESSES',
    name: 'Đầm Midi Cổ Vuông Chiết Eo',
    subtitle: 'Phom chữ A cổ điển · Tôn xương quai xanh thanh thoát',
    description:
      'Đầm midi cổ vuông chiết eo sắc sảo với chân váy xòe vừa phải, cân bằng sự trang trọng khi đi tiệc và tinh tế nơi công sở.',
    fabricComposition: '65% Linen cao cấp · 35% Lụa tơ tằm',
    fitType: FitType.SLIM,
    stretchLevel: StretchLevel.NONE,
    fabricWeight: 205,
    gender: Gender.WOMEN,
    isTryonEnabled: true,
    tryonGarmentCategory: TryOnGarmentCategory.OVERALL,
    fitCalibrationNote: 'Chiết eo sát phom, ưu tiên đúng số đo vòng eo.',
    occasionSlugs: ['du-tiec-toi', 'le-cuoi-thanh-lich', 'nghi-duong-bien'],
    seasonSlugs: ['ha-pho-co', 'resort-ban-mai'],
    silhouette: 'dress',
    supplierId: SUPPLIER_A_ID,
    basePriceVnd: 2_950_000,
    salePriceVnd: 2_690_000,
    costPriceVnd: 980_000,
    weightGrams: 420,
    slotCategory: 'ONE_PIECE',
    variants: [
      { colorName: 'Trắng Ngọc', colorHex: '#F3ECE0', accentHex: '#B08A4A', shadeHex: '#BFB4A0' },
      { colorName: 'Nâu Espresso', colorHex: '#46332A', accentHex: '#D5B26E', shadeHex: '#281C16' },
    ],
  },
  {
    slug: 'ao-cardigan-len-merino-khuy-sung',
    categorySlug: 'ao-khoac',
    sizeChartCode: 'CHART_TOPS_BLAZER',
    name: 'Áo Cardigan Len Merino Khuy Sừng',
    subtitle: '100% Len Merino Úc siêu mịn 16 gauge · Không xù lông',
    description:
      'Cardigan dệt kim tinh xảo từ sợi len Merino tự nhiên giữ ấm nhẹ mà vẫn thoáng khí, điểm nhấn hàng khuy sừng mài thủ công.',
    fabricComposition: '100% Len Merino Úc siêu mịn',
    fitType: FitType.REGULAR,
    stretchLevel: StretchLevel.HIGH,
    fabricWeight: 260,
    gender: Gender.WOMEN,
    isTryonEnabled: true,
    tryonGarmentCategory: TryOnGarmentCategory.UPPER,
    fitCalibrationNote: 'Len co giãn tốt; chọn đúng size để ôm nhẹ hoặc tăng 1 size để khoác ngoài.',
    occasionSlugs: ['cuoi-tuan-thu-thai', 'cong-so-hien-dai'],
    seasonSlugs: ['resort-ban-mai', 'thu-hoang-hon', 'dong-cashmere'],
    silhouette: 'cardigan',
    supplierId: SUPPLIER_B_ID,
    basePriceVnd: 2_450_000,
    salePriceVnd: null,
    costPriceVnd: 860_000,
    weightGrams: 350,
    slotCategory: 'OUTERWEAR',
    variants: [
      { colorName: 'Yến Mạch', colorHex: '#DFD4C2', accentHex: '#7D5C32', shadeHex: '#A69882' },
    ],
  },
  {
    slug: 'quan-culottes-linen-huu-co',
    categorySlug: 'quan-chan-vay',
    sizeChartCode: 'CHART_BOTTOMS_SKIRTS',
    name: 'Quần Culottes Linen Hữu Cơ',
    subtitle: 'Ống lửng phóng khoáng · Xử lý mềm sinh học stone-washed',
    description:
      'Quần culottes linen ống rộng mềm mại, thoáng mát tuyệt đối cho những chuyến nghỉ dưỡng biển và dạo phố mùa hạ.',
    fabricComposition: '100% Linen hữu cơ stone-washed 210gsm',
    fitType: FitType.RELAXED,
    stretchLevel: StretchLevel.NONE,
    fabricWeight: 210,
    gender: Gender.WOMEN,
    isTryonEnabled: true,
    tryonGarmentCategory: TryOnGarmentCategory.LOWER,
    fitCalibrationNote: 'Dáng rộng thoải mái, phần lưng sau có chun ẩn co giãn nhẹ 2cm.',
    occasionSlugs: ['nghi-duong-bien', 'cuoi-tuan-thu-thai'],
    seasonSlugs: ['ha-pho-co', 'resort-ban-mai'],
    silhouette: 'culottes',
    supplierId: SUPPLIER_B_ID,
    basePriceVnd: 1_550_000,
    salePriceVnd: null,
    costPriceVnd: 490_000,
    weightGrams: 320,
    slotCategory: 'BOTTOM',
    variants: [
      { colorName: 'Cát Biển', colorHex: '#D7C7B2', accentHex: '#9A7844', shadeHex: '#9C8B76' },
    ],
  },
  {
    slug: 'ao-khoac-tweed-det-thu-cong',
    categorySlug: 'ao-khoac',
    sizeChartCode: 'CHART_TOPS_BLAZER',
    name: 'Áo Khoác Tweed Dệt Thủ Công',
    subtitle: 'Tweed sợi lụa pha len · Viền tết tay ánh vàng đồng',
    description:
      'Tuyệt tác áo khoác tweed cổ tròn lấy cảm hứng từ xưởng couture Paris, dệt nổi ánh tơ nhẹ cùng hàng cúc kim loại khắc nổi.',
    fabricComposition: '55% Wool · 25% Lụa tơ · 20% Cotton dệt Tweed',
    fitType: FitType.REGULAR,
    stretchLevel: StretchLevel.NONE,
    fabricWeight: 340,
    gender: Gender.WOMEN,
    isTryonEnabled: true,
    tryonGarmentCategory: TryOnGarmentCategory.UPPER,
    fitCalibrationNote: 'Chất vải tweed đứng phom không co giãn; kiểm tra số đo rộng vai.',
    occasionSlugs: ['du-tiec-toi', 'trien-lam-nghe-thuat', 'le-cuoi-thanh-lich'],
    seasonSlugs: ['dong-cashmere', 'atelier-di-san'],
    silhouette: 'tweed',
    supplierId: SUPPLIER_A_ID,
    basePriceVnd: 4_850_000,
    salePriceVnd: 4_490_000,
    costPriceVnd: 1_780_000,
    weightGrams: 680,
    slotCategory: 'OUTERWEAR',
    variants: [
      { colorName: 'Ngà Ánh Đồng', colorHex: '#E6DCC8', accentHex: '#B08A4A', shadeHex: '#A79982' },
      { colorName: 'Cacao Đêm', colorHex: '#2C211C', accentHex: '#D8B572', shadeHex: '#150F0D' },
    ],
  },
  {
    slug: 'ao-polo-det-kim-bong-ai-cap',
    categorySlug: 'ao-so-mi',
    sizeChartCode: 'CHART_TOPS_BLAZER',
    name: 'Áo Polo Dệt Kim Bông Ai Cập',
    subtitle: 'Cotton Ai Cập sợi dài Giza · Bề mặt mịn mát ít nhăn',
    description:
      'Áo polo dệt kim dáng gọn gàng tối giản theo tinh thần Quiet Luxury, dễ phối cùng quần âu hoặc chân váy cho ngày làm việc năng động.',
    fabricComposition: '100% Bông Ai Cập sợi dài (Giza Cotton)',
    fitType: FitType.REGULAR,
    stretchLevel: StretchLevel.HIGH,
    fabricWeight: 195,
    gender: Gender.UNISEX,
    isTryonEnabled: false,
    tryonGarmentCategory: TryOnGarmentCategory.NONE,
    fitCalibrationNote: 'Dệt kim co giãn thoải mái, chọn đúng cỡ thường mặc.',
    occasionSlugs: ['cuoi-tuan-thu-thai', 'nghi-duong-bien'],
    seasonSlugs: ['ha-pho-co', 'resort-ban-mai'],
    silhouette: 'polo',
    supplierId: SUPPLIER_B_ID,
    basePriceVnd: 1_450_000,
    salePriceVnd: null,
    costPriceVnd: 460_000,
    weightGrams: 260,
    slotCategory: 'TOP',
    variants: [
      { colorName: 'Xanh Navy Trầm', colorHex: '#24303C', accentHex: '#B08A4A', shadeHex: '#131A22' },
    ],
  },
  // ==========================================================================
  // Phase 6 Expansion: 8 Additional Vietnamese Couture Designs (#13..#20)
  // ==========================================================================
  {
    slug: 'ao-so-mi-lua-to-tam-bao-loc',
    skuPrefix: 'SMLBL',
    categorySlug: 'ao-so-mi',
    sizeChartCode: 'CHART_TOPS_BLAZER',
    name: 'Áo Sơ Mi Lụa Tơ Tằm Bảo Lộc',
    subtitle: 'Lụa Bảo Lộc dệt thủ công 18 momme · Cổ tàu thanh thoát',
    description:
      'Áo sơ mi lụa tơ tằm Bảo Lộc nguyên chất với độ rủ mềm mại tự nhiên, nẹp giấu khuy thủ công phù hợp từ phòng họp tới tiệc chiều.',
    fabricComposition: '100% Lụa tơ tằm Bảo Lộc 18 momme',
    fitType: FitType.REGULAR,
    stretchLevel: StretchLevel.NONE,
    fabricWeight: 115,
    gender: Gender.WOMEN,
    isTryonEnabled: true,
    tryonGarmentCategory: TryOnGarmentCategory.UPPER,
    fitCalibrationNote: 'Lụa không co giãn, ưu tiên chọn thoải mái ở vòng ngực và vai.',
    occasionSlugs: ['cong-so-hien-dai', 'cuoi-tuan-thu-thai'],
    seasonSlugs: ['xuan-tam-xuan', 'ha-pho-co'],
    silhouette: 'shirt',
    supplierId: SUPPLIER_A_ID,
    basePriceVnd: 1_650_000,
    salePriceVnd: null,
    costPriceVnd: 540_000,
    weightGrams: 210,
    slotCategory: 'TOP',
    variants: [
      { colorName: 'Ngà Sữa', colorHex: '#F5EFE4', accentHex: '#B08A4A', shadeHex: '#C2B49F' },
      { colorName: 'Hồng Cánh Sen', colorHex: '#E6D0CC', accentHex: '#9C7535', shadeHex: '#B39892' },
    ],
  },
  {
    slug: 'ao-dai-cach-tan-gam-lua',
    skuPrefix: 'ADCTGL',
    categorySlug: 'dam-du-tiec',
    sizeChartCode: 'CHART_DRESSES',
    name: 'Áo Dài Cách Tân Gấm Lụa',
    subtitle: 'Gấm lụa dệt nổi họa tiết hoa mai · Phom suông nhẹ hiện đại',
    description:
      'Áo dài cách tân chế tác từ gấm lụa tơ tằm dệt nổi ánh vàng champagne, kết hợp đường chiết eo tinh giản tôn nét thanh lịch Việt.',
    fabricComposition: '70% Lụa tơ tằm · 30% Gấm dệt nổi truyền thống',
    fitType: FitType.SLIM,
    stretchLevel: StretchLevel.NONE,
    fabricWeight: 215,
    gender: Gender.WOMEN,
    isTryonEnabled: true,
    tryonGarmentCategory: TryOnGarmentCategory.OVERALL,
    fitCalibrationNote: 'Gấm lụa đứng phom không co giãn; chọn theo vòng ngực và eo chuẩn.',
    occasionSlugs: ['le-cuoi-thanh-lich', 'du-tiec-toi'],
    seasonSlugs: ['xuan-tam-xuan', 'atelier-di-san'],
    silhouette: 'dress',
    supplierId: SUPPLIER_A_ID,
    basePriceVnd: 3_450_000,
    salePriceVnd: null,
    costPriceVnd: 1_180_000,
    weightGrams: 460,
    slotCategory: 'ONE_PIECE',
    variants: [
      { colorName: 'Vàng Champagne', colorHex: '#E5CFA3', accentHex: '#8A672C', shadeHex: '#AE9568' },
      { colorName: 'Đỏ Son Trầm', colorHex: '#822F32', accentHex: '#EBCF8F', shadeHex: '#4E171A' },
    ],
  },
  {
    slug: 'trench-coat-kaki-co-dien',
    skuPrefix: 'TCKKCD',
    categorySlug: 'ao-khoac',
    sizeChartCode: 'CHART_TOPS_BLAZER',
    name: 'Trench Coat Kaki Cổ Điển',
    subtitle: 'Kaki cotton chải kỹ chống thấm nhẹ · Dựng ve vai chuẩn couture',
    description:
      'Chiếc trench coat kaki cổ điển hai hàng khuy với thắt lưng đồng thau và lớp lót lụa mịn, đồng hành bền bỉ qua nhiều mùa thu đông.',
    fabricComposition: '100% Cotton Kaki chải kỹ 295gsm · Lót lụa tổng hợp cao cấp',
    fitType: FitType.RELAXED,
    stretchLevel: StretchLevel.NONE,
    fabricWeight: 295,
    gender: Gender.UNISEX,
    isTryonEnabled: true,
    tryonGarmentCategory: TryOnGarmentCategory.UPPER,
    fitCalibrationNote: 'Phom khoác rộng vừa đủ layer cùng áo len hoặc blazer bên trong.',
    occasionSlugs: ['cong-so-hien-dai', 'trien-lam-nghe-thuat'],
    seasonSlugs: ['thu-hoang-hon', 'dong-cashmere'],
    silhouette: 'trench',
    supplierId: SUPPLIER_C_ID,
    basePriceVnd: 3_890_000,
    salePriceVnd: null,
    costPriceVnd: 1_390_000,
    weightGrams: 840,
    slotCategory: 'OUTERWEAR',
    variants: [
      { colorName: 'Kaki Cát', colorHex: '#C7B293', accentHex: '#8A672C', shadeHex: '#8E795D' },
    ],
  },
  {
    slug: 'chan-vay-lua-vat-cheo',
    skuPrefix: 'CVLVBC',
    categorySlug: 'quan-chan-vay',
    sizeChartCode: 'CHART_BOTTOMS_SKIRTS',
    name: 'Chân Váy Lụa Vát Chéo Bias-Cut',
    subtitle: 'Cắt thiên 45 độ ôm hông uyển chuyển · Lụa satin 20 momme',
    description:
      'Chân váy lụa cắt vát chéo bias-cut cho độ rủ mượt mà theo từng nhịp bước, dễ kết hợp cùng sơ mi lụa hoặc áo len cashmere.',
    fabricComposition: '100% Lụa Satin tơ tằm 20 momme',
    fitType: FitType.SLIM,
    stretchLevel: StretchLevel.LIGHT,
    fabricWeight: 155,
    gender: Gender.WOMEN,
    isTryonEnabled: true,
    tryonGarmentCategory: TryOnGarmentCategory.LOWER,
    fitCalibrationNote: 'Cắt thiên bias-cut có độ giãn tự nhiên nhẹ ở phần hông.',
    occasionSlugs: ['du-tiec-toi', 'cuoi-tuan-thu-thai', 'le-cuoi-thanh-lich'],
    seasonSlugs: ['ha-pho-co', 'resort-ban-mai', 'atelier-di-san'],
    silhouette: 'skirt',
    supplierId: SUPPLIER_A_ID,
    basePriceVnd: 1_590_000,
    salePriceVnd: null,
    costPriceVnd: 520_000,
    weightGrams: 270,
    slotCategory: 'BOTTOM',
    variants: [
      { colorName: 'Sâm Panh Ngà', colorHex: '#E9DBBE', accentHex: '#B08A4A', shadeHex: '#B3A280' },
      { colorName: 'Nâu Cacao', colorHex: '#3D2B22', accentHex: '#EBCF8F', shadeHex: '#1F1510' },
    ],
  },
  {
    slug: 'dam-midi-linen-phoi-dai',
    skuPrefix: 'DMLNPD',
    categorySlug: 'dam-du-tiec',
    sizeChartCode: 'CHART_DRESSES',
    name: 'Đầm Midi Linen Phối Đai Eo',
    subtitle: 'Linen hữu cơ Pháp thoáng nhẹ · Kèm đai eo bản mảnh tôn dáng',
    description:
      'Đầm midi dáng chữ A may từ linen hữu cơ thoáng khí, điểm nhấn đai thắt eo đồng màu cho vẻ ngoài tinh khôi ngày nắng.',
    fabricComposition: '100% Linen hữu cơ Pháp 205gsm',
    fitType: FitType.REGULAR,
    stretchLevel: StretchLevel.NONE,
    fabricWeight: 205,
    gender: Gender.WOMEN,
    isTryonEnabled: true,
    tryonGarmentCategory: TryOnGarmentCategory.OVERALL,
    fitCalibrationNote: 'Đai rời điều chỉnh vòng eo linh hoạt trong biên độ 3cm.',
    occasionSlugs: ['nghi-duong-bien', 'cuoi-tuan-thu-thai'],
    seasonSlugs: ['ha-pho-co', 'resort-ban-mai'],
    silhouette: 'dress',
    supplierId: SUPPLIER_C_ID,
    basePriceVnd: 2_290_000,
    salePriceVnd: null,
    costPriceVnd: 760_000,
    weightGrams: 390,
    slotCategory: 'ONE_PIECE',
    variants: [
      { colorName: 'Lanh Tự Nhiên', colorHex: '#DDD1BD', accentHex: '#8A672C', shadeHex: '#A69881' },
    ],
  },
  {
    slug: 'ao-khoac-tweed-nut-dong',
    skuPrefix: 'AKTWND',
    categorySlug: 'ao-khoac',
    sizeChartCode: 'CHART_TOPS_BLAZER',
    name: 'Áo Khoác Tweed Nút Đồng',
    subtitle: 'Dệt tweed phối sợi ánh kim · Hàng nút đồng chạm khắc thủ công',
    description:
      'Áo khoác tweed dáng cropped cổ tròn sắc nét với hàng nút đồng thau đúc riêng của Tầm Xuân, tôn vẻ sang trọng tĩnh lặng.',
    fabricComposition: '60% Wool · 25% Cotton · 15% Tơ tổng hợp ánh kim',
    fitType: FitType.REGULAR,
    stretchLevel: StretchLevel.NONE,
    fabricWeight: 330,
    gender: Gender.WOMEN,
    isTryonEnabled: true,
    tryonGarmentCategory: TryOnGarmentCategory.UPPER,
    fitCalibrationNote: 'Dáng áo đứng phom cổ điển, nên đối chiếu số đo rộng vai.',
    occasionSlugs: ['cong-so-hien-dai', 'trien-lam-nghe-thuat', 'du-tiec-toi'],
    seasonSlugs: ['dong-cashmere', 'atelier-di-san'],
    silhouette: 'tweed',
    supplierId: SUPPLIER_C_ID,
    basePriceVnd: 3_150_000,
    salePriceVnd: null,
    costPriceVnd: 1_090_000,
    weightGrams: 640,
    slotCategory: 'OUTERWEAR',
    variants: [
      { colorName: 'Kem Dệt Vàng', colorHex: '#ECE3D3', accentHex: '#B08A4A', shadeHex: '#B5A996' },
    ],
  },
  {
    slug: 'quan-ong-suong-wool-blend',
    skuPrefix: 'QOSWBL',
    categorySlug: 'quan-chan-vay',
    sizeChartCode: 'CHART_BOTTOMS_SKIRTS',
    name: 'Quần Ống Suông Wool Blend',
    subtitle: 'Len pha mềm ít nhăn · Ống suông đứng thẳng kéo dài tỷ lệ',
    description:
      'Quần ống suông cạp cao chất liệu wool blend thoáng nhẹ, đường ly ép phẳng tinh tế thích hợp phối cùng blazer và áo len.',
    fabricComposition: '72% Wool mịn · 26% Viscose · 2% Elastane',
    fitType: FitType.REGULAR,
    stretchLevel: StretchLevel.LIGHT,
    fabricWeight: 245,
    gender: Gender.WOMEN,
    isTryonEnabled: true,
    tryonGarmentCategory: TryOnGarmentCategory.LOWER,
    fitCalibrationNote: 'Co giãn nhẹ 2%, vừa chuẩn theo bảng số đo vòng eo.',
    occasionSlugs: ['cong-so-hien-dai', 'trien-lam-nghe-thuat'],
    seasonSlugs: ['thu-hoang-hon', 'dong-cashmere'],
    silhouette: 'trousers',
    supplierId: SUPPLIER_B_ID,
    basePriceVnd: 1_790_000,
    salePriceVnd: null,
    costPriceVnd: 590_000,
    weightGrams: 430,
    slotCategory: 'BOTTOM',
    variants: [
      { colorName: 'Nâu Khói', colorHex: '#52463E', accentHex: '#C7A262', shadeHex: '#2F2620' },
    ],
  },
  {
    slug: 'ao-len-cashmere-co-lo',
    skuPrefix: 'ALCSCL',
    categorySlug: 'ao-so-mi',
    sizeChartCode: 'CHART_TOPS_BLAZER',
    name: 'Áo Len Cashmere Cổ Lọ',
    subtitle: 'Cashmere pha len Merino 14 gauge · Siêu nhẹ ấm áp không dặm',
    description:
      'Áo len cổ lọ dệt phẳng tinh tế từ sợi cashmere mềm mịn, là lớp nền lý tưởng bên trong trench coat và blazer thu đông.',
    fabricComposition: '70% Cashmere Nội Mông · 30% Len Merino siêu mịn',
    fitType: FitType.REGULAR,
    stretchLevel: StretchLevel.HIGH,
    fabricWeight: 235,
    gender: Gender.UNISEX,
    isTryonEnabled: true,
    tryonGarmentCategory: TryOnGarmentCategory.UPPER,
    fitCalibrationNote: 'Sợi len co giãn cao ôm nhẹ cơ thể, chọn đúng size tiêu chuẩn.',
    occasionSlugs: ['cuoi-tuan-thu-thai', 'cong-so-hien-dai', 'trien-lam-nghe-thuat'],
    seasonSlugs: ['dong-cashmere', 'thu-hoang-hon'],
    silhouette: 'sweater',
    supplierId: SUPPLIER_C_ID,
    basePriceVnd: 2_450_000,
    salePriceVnd: null,
    costPriceVnd: 850_000,
    weightGrams: 310,
    slotCategory: 'TOP',
    variants: [
      { colorName: 'Kem Cashmere', colorHex: '#EFE6D8', accentHex: '#B08A4A', shadeHex: '#BCB09C' },
      { colorName: 'Cacao Đậm', colorHex: '#2E221B', accentHex: '#EBCF8F', shadeHex: '#18100C' },
    ],
  },
  // ==========================================================================
  // Outfit Studio Expansion: 3 Real Atelier Accessories (#21..#23)
  // ==========================================================================
  {
    slug: 'vi-cam-tay-clutch-champagne',
    skuPrefix: 'VCTCP',
    categorySlug: 'phu-kien',
    sizeChartCode: 'CHART_TOPS_BLAZER',
    name: 'Ví Cầm Tay Clutch Champagne',
    subtitle: 'Clutch dạ tiệc đính kết ánh champagne · Khóa cài đồng thau chế tác tay',
    description:
      'Ví cầm tay dáng hộp cổ điển phủ hoa văn ánh champagne tinh xảo cùng khóa cài tròn đính đá nhẹ, hoàn thiện trọn vẹn set đầm dạ tiệc tối.',
    fabricComposition: 'Lụa satin ánh kim bọc khung đồng thau · Lót nhung mềm',
    fitType: FitType.REGULAR,
    stretchLevel: StretchLevel.NONE,
    fabricWeight: 320,
    gender: Gender.WOMEN,
    isTryonEnabled: false,
    tryonGarmentCategory: TryOnGarmentCategory.NONE,
    fitCalibrationNote: 'Kích thước tiêu chuẩn dạ tiệc (20 × 11 × 5 cm), vừa điện thoại và son môi.',
    occasionSlugs: ['du-tiec-toi', 'le-cuoi-thanh-lich'],
    seasonSlugs: ['xuan-tam-xuan', 'thu-hoang-hon', 'dong-cashmere', 'atelier-di-san'],
    silhouette: 'clutch',
    supplierId: SUPPLIER_A_ID,
    basePriceVnd: 1_290_000,
    salePriceVnd: null,
    costPriceVnd: 420_000,
    weightGrams: 280,
    slotCategory: 'ACCESSORY',
    variants: [
      { colorName: 'Champagne Ánh Kim', colorHex: '#DFCAA6', accentHex: '#B08A4A', shadeHex: '#9C8560' },
      { colorName: 'Nâu Espresso', colorHex: '#2A1E17', accentHex: '#EBCF8F', shadeHex: '#150F0B' },
    ],
  },
  {
    slug: 'khan-lua-hoa-tiet-tam-xuan',
    skuPrefix: 'KLHTX',
    categorySlug: 'phu-kien',
    sizeChartCode: 'CHART_TOPS_BLAZER',
    name: 'Khăn Lụa Họa Tiết Tầm Xuân',
    subtitle: 'Lụa tơ tằm Bảo Lộc 16 momme · Cuốn biên khâu tay thủ công',
    description:
      'Khăn lụa vuông họa tiết vân mây hoa mai đặc trưng của nhà mốt Tầm Xuân, linh hoạt thắt cổ áo sơ mi, buộc quai túi hoặc điểm xuyết mái tóc.',
    fabricComposition: '100% Lụa tơ tằm Bảo Lộc 16 momme in lụa thủ công',
    fitType: FitType.REGULAR,
    stretchLevel: StretchLevel.NONE,
    fabricWeight: 95,
    gender: Gender.WOMEN,
    isTryonEnabled: false,
    tryonGarmentCategory: TryOnGarmentCategory.NONE,
    fitCalibrationNote: 'Khăn vuông 70 × 70 cm viền cuốn tay mềm nhẹ, phù hợp mọi dáng cổ.',
    occasionSlugs: ['cong-so-hien-dai', 'cuoi-tuan-thu-thai'],
    seasonSlugs: ['xuan-tam-xuan', 'ha-pho-co', 'resort-ban-mai'],
    silhouette: 'scarf',
    supplierId: SUPPLIER_A_ID,
    basePriceVnd: 690_000,
    salePriceVnd: null,
    costPriceVnd: 220_000,
    weightGrams: 95,
    slotCategory: 'ACCESSORY',
    variants: [
      { colorName: 'Kem Hoa Mai', colorHex: '#EFE5D2', accentHex: '#B08A4A', shadeHex: '#B8A88C' },
      { colorName: 'Đỏ Son Trầm', colorHex: '#843133', accentHex: '#EBCF8F', shadeHex: '#4E1719' },
    ],
  },
  {
    slug: 'that-lung-da-khoa-dong',
    skuPrefix: 'TLDKD',
    categorySlug: 'phu-kien',
    sizeChartCode: 'CHART_TOPS_BLAZER',
    name: 'Thắt Lưng Da Khóa Đồng',
    subtitle: 'Da bê thuộc thảo mộc Ý · Đan thủ công kèm khóa đồng mài mờ',
    description:
      'Thắt lưng da bê nguyên tấm mềm dẻo với kỹ thuật đan thủ công tinh tế, tạo điểm nhấn gọn eo cho áo sơ mi lụa, quần tây cạp cao và blazer.',
    fabricComposition: '100% Da bê thuộc thảo mộc · Khóa hợp kim đồng thau',
    fitType: FitType.REGULAR,
    stretchLevel: StretchLevel.NONE,
    fabricWeight: 380,
    gender: Gender.UNISEX,
    isTryonEnabled: false,
    tryonGarmentCategory: TryOnGarmentCategory.NONE,
    fitCalibrationNote: 'Bản rộng 2.8 cm thanh lịch; chọn theo vòng eo tương ứng XS–XL.',
    occasionSlugs: ['cong-so-hien-dai', 'cuoi-tuan-thu-thai'],
    seasonSlugs: ['thu-hoang-hon', 'dong-cashmere'],
    silhouette: 'belt',
    supplierId: SUPPLIER_B_ID,
    basePriceVnd: 890_000,
    salePriceVnd: null,
    costPriceVnd: 290_000,
    weightGrams: 185,
    slotCategory: 'ACCESSORY',
    variants: [
      { colorName: 'Cacao Cổ Điển', colorHex: '#3B281E', accentHex: '#C7A262', shadeHex: '#20140E' },
      { colorName: 'Be Cát', colorHex: '#C9B596', accentHex: '#8A672C', shadeHex: '#937F62' },
    ],
  },
];

const OCCASIONS_SEED = [
  {
    slug: 'du-tiec-toi',
    title: 'Dạ Tiệc Tối & Sự Kiện',
    subtitle: 'Ánh lụa satin cắt thiên và chi tiết kim loại đồng trầm dưới ánh đèn đêm.',
    paletteBg: '#1C1410',
    paletteInk: '#FBF7EF',
    paletteAccent: '#EBCF8F',
    isDark: true,
    badgeTag: 'Evening Couture',
    sortOrder: 1,
  },
  {
    slug: 'cong-so-hien-dai',
    title: 'Công Sở Hiện Đại',
    subtitle: 'Đường cắt may sắc sảo từ blazer linen, sơ mi lụa và quần tây xếp ly đôi.',
    paletteBg: '#F4EBDA',
    paletteInk: '#1C1410',
    paletteAccent: '#B08A4A',
    isDark: false,
    badgeTag: 'Modern Tailoring',
    sortOrder: 2,
  },
  {
    slug: 'cuoi-tuan-thu-thai',
    title: 'Cuối Tuần Thư Thái',
    subtitle: 'Chất liệu tự nhiên thoáng nhẹ cho buổi cà phê sáng và dạo phố chậm rãi.',
    paletteBg: '#EFEAE0',
    paletteInk: '#1F1B16',
    paletteAccent: '#8C6D46',
    isDark: false,
    badgeTag: 'Weekend Ease',
    sortOrder: 3,
  },
  {
    slug: 'nghi-duong-bien',
    title: 'Nghỉ Dưỡng & Resort',
    subtitle: 'Linen hữu cơ bay bổng và bảng màu cát ngà hòa cùng gió biển.',
    paletteBg: '#FBF7EF',
    paletteInk: '#2B221B',
    paletteAccent: '#B59056',
    isDark: false,
    badgeTag: 'Resort Capsule',
    sortOrder: 4,
  },
  {
    slug: 'trien-lam-nghe-thuat',
    title: 'Triển Lãm Nghệ Thuật',
    subtitle: 'Cấu trúc tối giản, tương phản chất liệu tweed và gabardine đầy chiều sâu.',
    paletteBg: '#26211D',
    paletteInk: '#F7F1E5',
    paletteAccent: '#C9A563',
    isDark: true,
    badgeTag: 'Gallery Edit',
    sortOrder: 5,
  },
  {
    slug: 'le-cuoi-thanh-lich',
    title: 'Lễ Cưới Thanh Lịch',
    subtitle: 'Sắc trắng ngọc, hồng phấn đất và lụa organza tinh khôi cho ngày trọng đại.',
    paletteBg: '#F9F3EC',
    paletteInk: '#281E19',
    paletteAccent: '#A98249',
    isDark: false,
    badgeTag: 'Bridal Guest',
    sortOrder: 6,
  },
] as const;

const SEASONS_SEED = [
  {
    slug: 'xuan-tam-xuan',
    months: 'T1–T2',
    title: 'Xuân Lụa Bảo Lộc',
    seasonTag: 'SPRING',
    subtitle: 'Lụa Tơ Tằm Bảo Lộc 22 Momme — ánh ngà ấm và phom dáng mềm rủ cho tiết xuân Hà Nội.',
    paletteHex: '#EFE6D5',
    isCurrent: true,
    sortOrder: 1,
  },
  {
    slug: 'ha-pho-co',
    months: 'T3–T4',
    title: 'Hạ Linen Hữu Cơ',
    seasonTag: 'SUMMER',
    subtitle: '100% Organic French Linen Thoáng Khí — đường cắt khoáng đạt và thoáng nhẹ dưới nắng hạ.',
    paletteHex: '#DFD2BE',
    isCurrent: false,
    sortOrder: 2,
  },
  {
    slug: 'resort-ban-mai',
    months: 'T5–T6',
    title: 'Resort Biển & Lụa Bay',
    seasonTag: 'RESORT',
    subtitle: 'Lụa Organza & Tơ Sống Dệt Nhẹ — thiết kế nghỉ dưỡng bay bổng đón gió biển ban mai.',
    paletteHex: '#E6D6BC',
    isCurrent: false,
    sortOrder: 3,
  },
  {
    slug: 'thu-hoang-hon',
    months: 'T7–T8',
    title: 'Thu Công Sở Thanh Lịch',
    seasonTag: 'AUTUMN',
    subtitle: 'Wool Silk Blend & Crepe Đứng Phom — blazer dựng vai chuẩn mực và quần âu xếp ly thanh lịch.',
    paletteHex: '#B69B74',
    isCurrent: false,
    sortOrder: 4,
  },
  {
    slug: 'dong-cashmere',
    months: 'T9–T10',
    title: 'Dạ Tweed & Cashmere',
    seasonTag: 'WINTER',
    subtitle: 'Len Cashmere Mông Cổ & Dạ Tweed Dệt Nổi — cấu trúc dệt thủ công ấm áp đầy khí chất.',
    paletteHex: '#4A382E',
    isCurrent: false,
    sortOrder: 5,
  },
  {
    slug: 'atelier-di-san',
    months: 'T11–T12',
    title: 'Dạ Tiệc Cuối Năm',
    seasonTag: 'HERITAGE',
    subtitle: 'Lụa Satin Ánh Ngọc & Nhung Couture — đầm cắt thiên bias-cut tôn vinh kỹ nghệ dạ tiệc cuối năm.',
    paletteHex: '#B08A4A',
    isCurrent: false,
    sortOrder: 6,
  },
] as const;

const PACKAGING_SEED = [
  {
    code: 'tui-vai-linen-moc',
    name: 'Túi Vải Linen Mộc Tiêu Chuẩn',
    description: 'Túi dustbag linen tự nhiên tái sử dụng bảo vệ sợi vải khi lưu tủ.',
    swatchHex: '#E9DFCE',
    priceVnd: 0,
    isDefault: true,
    sortOrder: 1,
  },
  {
    code: 'hop-lua-co-dien',
    name: 'Hộp Lụa Cổ Điển Ivory',
    description: 'Hộp cứng giấy mỹ thuật màu ngà kèm giấy nến ép sáp và thiệp viết tay.',
    swatchHex: '#FBF7EF',
    priceVnd: 80_000,
    isDefault: false,
    sortOrder: 2,
  },
  {
    code: 'hop-qua-khac-ten-gold',
    name: 'Hộp Quà Khắc Tên Ánh Kim Gold',
    description: 'Hộp cacao cao cấp ép nhũ vàng tên người nhận kèm nơ lụa và xịt hương trà trắng.',
    swatchHex: '#1C1410',
    priceVnd: 150_000,
    isDefault: false,
    sortOrder: 3,
  },
] as const;

export interface DefaultCampaignSections {
  slug: string;
  eyebrow: string;
  heroTitle: string;
  heroSubtitle: string;
  atelierManifesto: string;
  ctaLabel: string;
  serviceNote: string;
  privacyGuaranteeMinutes: number;
  heroImageUrl: string;
  intro: CampaignIntro;
  hero: CampaignHero;
  atelierSteps: AtelierStep[];
  finale: CampaignFinale;
}

export const HERO_EYEBROW_CANONICAL =
  'FASHION ATELIER · EST. 2019 · MAY ĐO THỦ CÔNG TẠI HÀ NỘI';
export const STANDARD_HANGER_ANCHOR_X = 0.5;
export const STANDARD_HANGER_ANCHOR_Y = 0.14;

export function buildDefaultCampaignSections(
  urls: CampaignEditorialAssetUrls,
): DefaultCampaignSections {
  const intro: CampaignIntro = {
    monogramLeft: 'T',
    monogramAmp: '&',
    monogramRight: 'X',
    tagline: 'May đo thủ công · Hà Nội',
    brandName: 'Tầm Xuân',
    brandSub: 'Fashion Atelier',
  };

  const hero: CampaignHero = {
    eyebrow: HERO_EYEBROW_CANONICAL,
    title: 'Tầm Xuân',
    lead: 'Thiết kế may đo thủ công trên lụa tơ tằm và linen hữu cơ — ướm thử dáng thật bằng AI trước khi đặt may.',
    primaryCtaLabel: 'Khám phá bộ sưu tập',
    serviceNote: 'May đo theo số đo · Đổi size 7–14 ngày · Xóa ảnh AI sau 15 phút',
    posterUrl: urls.heroPosterUrl,
    videoWebmUrl: null,
    videoMp4Url: null,
  };

  const atelierSteps: AtelierStep[] = [
    {
      stepOrder: 1,
      timeTarget: '08:00',
      title: 'Tuyển chọn lụa & linen',
      description:
        'Kiểm tra mật độ sợi lụa tơ tằm Bảo Lộc 19–22 momme và linen hữu cơ Bỉ dưới ánh sáng tự nhiên trước khi trải bàn cắt.',
      imageUrl: urls.step1Url,
      imageAlt: 'Tuyển chọn lụa tơ tằm và linen hữu cơ tại xưởng may Tầm Xuân',
    },
    {
      stepOrder: 2,
      timeTarget: '11:00',
      title: 'Dựng rập & cắt thủ công',
      description:
        'Dựng rập 3D chuẩn tỷ lệ vóc dáng Việt, căn chính xác canh sợi dọc và cắt từng mảnh vải bằng kéo thủ công.',
      imageUrl: urls.step2Url,
      imageAlt: 'Dựng rập 3D và cắt vải thủ công theo số đo tại xưởng',
    },
    {
      stepOrder: 3,
      timeTarget: '14:30',
      title: 'Khâu tay chi tiết',
      description:
        'Đính khuy ngọc trai, khâu lược ve áo blazer và xử lý nẹp giấu chỉ để mặt trong trang phục tinh xảo như mặt ngoài.',
      imageUrl: urls.step3Url,
      imageAlt: 'Khâu tay chi tiết ve áo blazer và nẹp lụa giấu chỉ',
    },
    {
      stepOrder: 4,
      timeTarget: '17:00',
      title: 'Là hơi, kiểm chuẩn & đóng hộp',
      description:
        'Là hơi hoàn thiện phom dáng, kiểm chuẩn thông số và gửi ảnh thiết kế thực tế cho khách duyệt trước khi đóng hộp giao tận tay.',
      imageUrl: urls.step4Url,
      imageAlt: 'Là hơi hoàn thiện, kiểm chuẩn chất lượng và đóng hộp quà Atelier',
    },
  ];

  const finale: CampaignFinale = {
    eyebrow: 'Đặt may & Phòng thử AI',
    leadMain: 'Ghé xưởng hoặc ướm thử trực tuyến —',
    leadEmphasis: 'mỗi đường kim đều chuẩn theo dáng bạn.',
    ctaLabel: 'Khám phá bộ sưu tập',
    showroomInfo: 'Phố Phan Đình Phùng, Ba Đình · Mở cửa 9:00 – 21:00 mỗi ngày',
    wordmark: 'Tầm Xuân',
    featuredVoices: [
      {
        quote:
          'Áo sơ mi lụa rủ rất êm, mặc lên đúng phom vai như lúc mình xem qua phòng ướm thử AI — không cần đổi size lần nào.',
        author: 'Chị Minh Anh · Ba Đình',
        fitMeta: '163cm · 52kg · Mặc Size S (Vừa vai)',
      },
      {
        quote:
          'Áo khoác trench gabardine dựng vai chuẩn nhưng rất nhẹ, giao trong hộp quà kèm ảnh chụp hoàn thiện trước khi gửi đi.',
        author: 'Anh Quang Đức · Tây Hồ',
        fitMeta: '176cm · 70kg · Mặc Size L (Thoải mái)',
      },
      {
        quote:
          'Đầm lụa satin cắt thiên ôm eo vừa vặn, đường khâu nẹp giấu chỉ tinh tế đúng chuẩn nhà may thủ công tại Hà Nội.',
        author: 'Chị Thu Hà · Hoàn Kiếm',
        fitMeta: '167cm · 56kg · Mặc Size M (Chuẩn eo)',
      },
    ],
  };

  return {
    slug: 'atelier-manifesto-2026',
    eyebrow: hero.eyebrow,
    heroTitle: hero.title,
    heroSubtitle: hero.lead,
    atelierManifesto:
      'Mỗi đường rập tại Tầm Xuân được cân chỉnh cho vóc dáng Việt — tôn vinh chất liệu tự nhiên, đổi size miễn phí 7–14 ngày và cam kết xóa cứng ảnh thử đồ riêng tư sau đúng 15 phút.',
    ctaLabel: hero.primaryCtaLabel,
    serviceNote: hero.serviceNote,
    privacyGuaranteeMinutes: 15,
    heroImageUrl: urls.heroPosterUrl,
    intro,
    hero,
    atelierSteps,
    finale,
  };
}

export async function ensureCampaignSeeded(
  db: AtelierDbClient,
  config: CatalogLookbookConfig,
  force = false,
): Promise<CampaignEditorialAssetUrls> {
  const assetGenerator = new SeedAssetGenerator(config);
  const editorialUrls = await assetGenerator.ensureCampaignEditorialAssets(force);
  const defaults = buildDefaultCampaignSections(editorialUrls);
  const campaignId = deterministicUuid(`campaign:${defaults.slug}`);

  const existingRes = await db.query<{
    id: string;
    eyebrow: string | null;
    hero_image_url: string | null;
    intro_jsonb: unknown;
    hero_jsonb: unknown;
    atelier_steps_jsonb: unknown;
    finale_jsonb: unknown;
  }>(
    'SELECT id, eyebrow, hero_image_url, intro_jsonb, hero_jsonb, atelier_steps_jsonb, finale_jsonb FROM homepage_campaigns WHERE is_active = TRUE ORDER BY updated_at DESC LIMIT 1',
  );

  const active = existingRes.rows[0];
  if (!active) {
    await db.query(
      `INSERT INTO homepage_campaigns (
         id, slug, eyebrow, hero_title, hero_subtitle, atelier_manifesto,
         cta_label, service_note, privacy_guarantee_minutes, hero_image_url,
         intro_jsonb, hero_jsonb, atelier_steps_jsonb, finale_jsonb, is_active
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10,
         $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, TRUE
       )
       ON CONFLICT (slug) DO UPDATE SET
         eyebrow = EXCLUDED.eyebrow,
         hero_title = EXCLUDED.hero_title,
         hero_subtitle = EXCLUDED.hero_subtitle,
         atelier_manifesto = EXCLUDED.atelier_manifesto,
         cta_label = EXCLUDED.cta_label,
         service_note = EXCLUDED.service_note,
         hero_image_url = EXCLUDED.hero_image_url,
         intro_jsonb = EXCLUDED.intro_jsonb,
         hero_jsonb = EXCLUDED.hero_jsonb,
         atelier_steps_jsonb = EXCLUDED.atelier_steps_jsonb,
         finale_jsonb = EXCLUDED.finale_jsonb,
         is_active = TRUE,
         updated_at = NOW()`,
      [
        campaignId,
        defaults.slug,
        defaults.eyebrow,
        defaults.heroTitle,
        defaults.heroSubtitle,
        defaults.atelierManifesto,
        defaults.ctaLabel,
        defaults.serviceNote,
        defaults.privacyGuaranteeMinutes,
        defaults.heroImageUrl,
        JSON.stringify(defaults.intro),
        JSON.stringify(defaults.hero),
        JSON.stringify(defaults.atelierSteps),
        JSON.stringify(defaults.finale),
      ],
    );
    return editorialUrls;
  }

  const heroJsonStr =
    typeof active.hero_jsonb === 'string'
      ? active.hero_jsonb
      : JSON.stringify(active.hero_jsonb ?? {});
  const stepsJsonStr =
    typeof active.atelier_steps_jsonb === 'string'
      ? active.atelier_steps_jsonb
      : JSON.stringify(active.atelier_steps_jsonb ?? []);

  const hasStaleVisuals =
    /\/media\/(?!atelier-)/i.test(heroJsonStr) ||
    /hero-atelier-poster/i.test(heroJsonStr) ||
    /hero-atelier-poster/i.test(active.hero_image_url ?? '') ||
    active.eyebrow !== HERO_EYEBROW_CANONICAL ||
    !heroJsonStr.includes(HERO_EYEBROW_CANONICAL) ||
    !heroJsonStr.includes('atelier-hero-poster.webp') ||
    !stepsJsonStr.includes('atelier-step-1.webp');

  const missingJsonb =
    !active.intro_jsonb ||
    !active.hero_jsonb ||
    !active.atelier_steps_jsonb ||
    !active.finale_jsonb;

  if (missingJsonb || hasStaleVisuals || force) {
    await db.query(
      `UPDATE homepage_campaigns SET
         eyebrow = $2,
         hero_title = $3,
         hero_subtitle = $4,
         atelier_manifesto = $5,
         cta_label = $6,
         service_note = $7,
         hero_image_url = $8,
         intro_jsonb = COALESCE($9::jsonb, intro_jsonb),
         hero_jsonb = COALESCE($10::jsonb, hero_jsonb),
         atelier_steps_jsonb = COALESCE($11::jsonb, atelier_steps_jsonb),
         finale_jsonb = COALESCE($12::jsonb, finale_jsonb),
         updated_at = NOW()
       WHERE id = $1`,
      [
        active.id,
        defaults.eyebrow,
        defaults.heroTitle,
        defaults.heroSubtitle,
        defaults.atelierManifesto,
        defaults.ctaLabel,
        defaults.serviceNote,
        defaults.heroImageUrl,
        force || !active.intro_jsonb ? JSON.stringify(defaults.intro) : null,
        force || !active.hero_jsonb || hasStaleVisuals
          ? JSON.stringify(defaults.hero)
          : null,
        force || !active.atelier_steps_jsonb || hasStaleVisuals
          ? JSON.stringify(defaults.atelierSteps)
          : null,
        force || !active.finale_jsonb ? JSON.stringify(defaults.finale) : null,
      ],
    );
  }

  return editorialUrls;
}

export interface SeedSummary {
  skipped: boolean;
  categories: number;
  sizeCharts: number;
  products: number;
  variants: number;
  skus: number;
  tryonEnabledProducts: number;
  occasions: number;
  seasons: number;
  packagingOptions: number;
  submissions: number;
  assetsUploadedToMinio: number;
  campaignAssetsUploaded: number;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SeedMediaRegistrationAsset {
  id: string;
  assetType: 'RACK_CUTOUT_2_3';
  bucketName: string;
  originalKey: string;
  variants: Record<string, unknown>;
  width: number;
  height: number;
  hasAlpha: boolean;
  dominantHex: string;
  hangerAnchorX: number;
  hangerAnchorY: number;
}

export function buildSeedMediaRegistrationAssets(
  config: CatalogLookbookConfig,
): SeedMediaRegistrationAsset[] {
  const assetGen = new SeedAssetGenerator(config);
  const pubBucket = config.infra.minioBucketPublic;
  const assets: SeedMediaRegistrationAsset[] = [];

  for (const prod of PRODUCTS_SEED) {
    const urls = assetGen.getPublicAssetUrls(prod.slug, prod.variants.length);
    for (let vIdx = 0; vIdx < prod.variants.length; vIdx += 1) {
      const variant = prod.variants[vIdx];
      const vUrls = urls.variants[vIdx] ?? urls;
      const keyMatch = vUrls.rackCutout2x3Url.match(/\/(seed\/[^?]+)$/);
      const originalKey = keyMatch ? keyMatch[1] : `seed/${prod.slug}-rack-2x3.webp`;
      assets.push({
        id: deterministicUuid(`media-rack-front:${prod.slug}:${vIdx}`),
        assetType: 'RACK_CUTOUT_2_3',
        bucketName: pubBucket,
        originalKey,
        variants: {
          preview_url: vUrls.rackCutout2x3Url,
          '720w': {
            key: originalKey,
            url: vUrls.rackCutout2x3Url,
            width: 720,
            height: 1080,
            mimeType: 'image/webp',
          },
          '480w': {
            key: originalKey,
            url: vUrls.rackCutout2x3Url,
            width: 480,
            height: 720,
            mimeType: 'image/webp',
          },
        },
        width: 720,
        height: 1080,
        hasAlpha: true,
        dominantHex: variant.colorHex,
        hangerAnchorX: STANDARD_HANGER_ANCHOR_X,
        hangerAnchorY: STANDARD_HANGER_ANCHOR_Y,
      });
    }
  }

  return assets;
}

function getCuratedOccasionProducts(occSlug: string): SeedProductDef[] {
  const primary = PRODUCTS_SEED.filter((p) => p.occasionSlugs.includes(occSlug));
  const selected = [...primary];
  if (selected.length < 4) {
    for (const candidate of PRODUCTS_SEED) {
      if (selected.length >= 4) break;
      if (!selected.some((p) => p.slug === candidate.slug)) {
        selected.push(candidate);
      }
    }
  }
  return selected.slice(0, 4);
}

function buildVariantLayerSpec(
  slotCategory: SeedProductDef['slotCategory'],
  garmentBucketKey: string,
): Record<string, unknown> {
  return {
    slotCategory,
    zIndex:
      slotCategory === 'TOP'
        ? 10
        : slotCategory === 'BOTTOM' || slotCategory === 'ONE_PIECE'
          ? 20
          : slotCategory === 'OUTERWEAR'
            ? 30
            : 40,
    hangerAnchorX: STANDARD_HANGER_ANCHOR_X,
    hangerAnchorY: STANDARD_HANGER_ANCHOR_Y,
    garmentBucketKey,
  };
}

async function ensureVisualOverhaulCatalogSync(
  db: AtelierDbClient,
  assetUrlsBySlug: Map<
    string,
    {
      rackCutout2x3Url: string;
      rackBackCutout2x3Url: string;
      tryonFlat3x4GarmentKey: string;
      tryonFlatPreviewUrl: string;
      lookbookMainUrl: string;
      variants?: Array<{
        rackCutout2x3Url: string;
        rackBackCutout2x3Url: string;
        tryonFlat3x4GarmentKey: string;
        tryonFlatPreviewUrl: string;
        lookbookMainUrl: string;
      }>;
    }
  >,
  campaignEditorialUrls: CampaignEditorialAssetUrls,
): Promise<void> {
  // 1. Sync ALL seeded product_variants with real photography URLs, deterministic asset UUIDs & hangerAnchorY=0.14
  for (const prod of PRODUCTS_SEED) {
    const urls = assetUrlsBySlug.get(prod.slug);
    if (!urls) continue;
    const productId = deterministicUuid(`product:${prod.slug}`);
    await db.query(
      `UPDATE products
       SET tryon_flat_asset_url = $2,
           season_slugs = $3::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [
        productId,
        prod.isTryonEnabled ? urls.tryonFlatPreviewUrl : null,
        JSON.stringify(prod.seasonSlugs),
      ],
    );

    for (let vIdx = 0; vIdx < prod.variants.length; vIdx += 1) {
      const variantId = deterministicUuid(`variant:${prod.slug}:${vIdx}`);
      const frontAssetUuid = deterministicUuid(`media-rack-front:${prod.slug}:${vIdx}`);
      const backAssetUuid = deterministicUuid(`media-rack-back:${prod.slug}:${vIdx}`);
      const vUrls = urls.variants?.[vIdx] ?? urls;
      const layerSpec = buildVariantLayerSpec(
        prod.slotCategory,
        vUrls.tryonFlat3x4GarmentKey,
      );

      await db.query(
        `UPDATE product_variants SET
           rack_front_asset_id = CASE WHEN rack_front_asset_id IS NULL OR rack_front_asset_id NOT LIKE '________-____-____-____-____________' THEN $2 ELSE rack_front_asset_id END,
           rack_back_asset_id = CASE WHEN rack_back_asset_id IS NULL OR rack_back_asset_id NOT LIKE '________-____-____-____-____________' THEN $3 ELSE rack_back_asset_id END,
           lookbook_main_url = $4,
           tryon_flat_preview_url = $5,
           rack_front_url = $6,
           rack_back_url = $7,
           studio_layer_url = $8,
           layer_spec_jsonb = $9::jsonb
         WHERE id = $1`,
        [
          variantId,
          frontAssetUuid,
          backAssetUuid,
          vUrls.lookbookMainUrl,
          prod.isTryonEnabled ? vUrls.tryonFlatPreviewUrl : null,
          vUrls.rackCutout2x3Url,
          vUrls.rackBackCutout2x3Url,
          vUrls.rackCutout2x3Url,
          JSON.stringify(layerSpec),
        ],
      );
    }
  }

  // 2. Ensure all 6 occasion_lookbooks have real hero_image_url and 4 curated occasion_lookbook_items
  for (const occ of OCCASIONS_SEED) {
    const occId = deterministicUuid(`occasion:${occ.slug}`);
    const curated = getCuratedOccasionProducts(occ.slug);
    const heroSlug = curated[0]?.slug ?? PRODUCTS_SEED[0].slug;
    const heroUrl = assetUrlsBySlug.get(heroSlug)?.lookbookMainUrl ?? null;

    await db.query(
      `INSERT INTO occasion_lookbooks (
         id, slug, title, subtitle, palette_bg, palette_ink, palette_accent,
         is_dark, badge_tag, hero_image_url, sort_order
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (slug) DO UPDATE SET
         title = EXCLUDED.title,
         subtitle = EXCLUDED.subtitle,
         badge_tag = EXCLUDED.badge_tag,
         hero_image_url = EXCLUDED.hero_image_url`,
      [
        occId,
        occ.slug,
        occ.title,
        occ.subtitle,
        occ.paletteBg,
        occ.paletteInk,
        occ.paletteAccent,
        occ.isDark,
        occ.badgeTag,
        heroUrl,
        occ.sortOrder,
      ],
    );

    for (let idx = 0; idx < curated.length; idx += 1) {
      const prod = curated[idx];
      const prodId = deterministicUuid(`product:${prod.slug}`);
      const itemId = deterministicUuid(`occ-item:${occ.slug}:${prod.slug}`);
      await db.query(
        `INSERT INTO occasion_lookbook_items (id, occasion_id, product_id, slot_label, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (occasion_id, product_id) DO NOTHING`,
        [itemId, occId, prodId, prod.slotCategory, idx + 1],
      );
    }
  }

  // 3. Upsert seasonal_collections with real season editorial covers
  for (const season of SEASONS_SEED) {
    const seasonId = deterministicUuid(`season:${season.slug}`);
    const matching = PRODUCTS_SEED.find((p) => p.seasonSlugs.includes(season.slug));
    const fallbackUrl = matching
      ? (assetUrlsBySlug.get(matching.slug)?.lookbookMainUrl ?? null)
      : null;
    const heroUrl = campaignEditorialUrls.seasonUrls[season.slug] ?? fallbackUrl;

    await db.query(
      `INSERT INTO seasonal_collections (
         id, slug, months, title, season_tag, subtitle, palette_hex, hero_image_url, is_current, sort_order
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (slug) DO UPDATE SET
         months = EXCLUDED.months,
         title = EXCLUDED.title,
         season_tag = EXCLUDED.season_tag,
         subtitle = EXCLUDED.subtitle,
         palette_hex = EXCLUDED.palette_hex,
         hero_image_url = EXCLUDED.hero_image_url,
         is_current = EXCLUDED.is_current,
         sort_order = EXCLUDED.sort_order`,
      [
        seasonId,
        season.slug,
        season.months,
        season.title,
        season.seasonTag,
        season.subtitle,
        season.paletteHex,
        heroUrl,
        season.isCurrent,
        season.sortOrder,
      ],
    );
  }

  // 4. Upsert packaging_options with real packaging front & back photography
  for (const pkg of PACKAGING_SEED) {
    const pkgId = deterministicUuid(`packaging:${pkg.code}`);
    const pkgUrls = campaignEditorialUrls.packagingUrls[pkg.code];
    await db.query(
      `INSERT INTO packaging_options (id, code, name, description, swatch_hex, price_vnd, image_url, back_image_url, is_default, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         price_vnd = EXCLUDED.price_vnd,
         image_url = EXCLUDED.image_url,
         back_image_url = EXCLUDED.back_image_url`,
      [
        pkgId,
        pkg.code,
        pkg.name,
        pkg.description,
        pkg.swatchHex,
        pkg.priceVnd,
        pkgUrls?.frontUrl ?? null,
        pkgUrls?.backUrl ?? null,
        pkg.isDefault,
        pkg.sortOrder,
      ],
    );
  }
}

export async function runCatalogSeed(
  db: AtelierDbClient,
  config: CatalogLookbookConfig,
  options: { force?: boolean } = {},
): Promise<SeedSummary> {
  const existing = await db.query<{ count: string | number }>(
    'SELECT COUNT(*)::int AS count FROM products',
  );
  const existingCount = Number(existing.rows[0]?.count ?? 0);

  const assetSpecs: GarmentAssetSpec[] = PRODUCTS_SEED.map((p) => ({
    slug: p.slug,
    title: p.name,
    kind: p.silhouette,
    primaryHex: p.variants[0].colorHex,
    accentHex: p.variants[0].accentHex,
    shadeHex: p.variants[0].shadeHex,
    variantCount: p.variants.length,
  }));

  const assetGenerator = new SeedAssetGenerator(config);
  const [assetUrlsBySlug, campaignEditorialUrls] = await Promise.all([
    assetGenerator.ensureProductAssets(assetSpecs, Boolean(options.force)),
    ensureCampaignSeeded(db, config, Boolean(options.force)),
  ]);
  const uploadedCount = Array.from(assetUrlsBySlug.values()).filter(
    (u) => u.uploadedToMinio,
  ).length;

  if (existingCount >= PRODUCTS_SEED.length && !options.force) {
    await ensureVisualOverhaulCatalogSync(
      db,
      assetUrlsBySlug,
      campaignEditorialUrls,
    );
    const totalSeedVariants = PRODUCTS_SEED.reduce(
      (sum, prod) => sum + prod.variants.length,
      0,
    );
    return {
      skipped: true,
      categories: CATEGORIES_SEED.length,
      sizeCharts: SIZE_CHARTS_SEED.length,
      products: existingCount,
      variants: totalSeedVariants,
      skus: totalSeedVariants * SIZES_STANDARD.length,
      tryonEnabledProducts: PRODUCTS_SEED.filter((p) => p.isTryonEnabled).length,
      occasions: OCCASIONS_SEED.length,
      seasons: SEASONS_SEED.length,
      packagingOptions: PACKAGING_SEED.length,
      submissions: 2,
      assetsUploadedToMinio: uploadedCount,
      campaignAssetsUploaded: campaignEditorialUrls.uploadedCount,
    };
  }

  // 1. Categories
  const categoryIds = new Map<string, string>();
  for (const cat of CATEGORIES_SEED) {
    const id = deterministicUuid(`category:${cat.slug}`);
    categoryIds.set(cat.slug, id);
    await db.query(
      `INSERT INTO categories (id, parent_id, slug, name, description, sort_order, is_active)
       VALUES ($1, NULL, $2, $3, $4, $5, TRUE)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         sort_order = EXCLUDED.sort_order`,
      [id, cat.slug, cat.name, cat.description, cat.sortOrder],
    );
  }

  // 2. Size charts
  const sizeChartIds = new Map<string, string>();
  for (const chart of SIZE_CHARTS_SEED) {
    const id = deterministicUuid(`size_chart:${chart.code}`);
    sizeChartIds.set(chart.code, id);
    await db.query(
      `INSERT INTO size_charts (id, code, name, gender, garment_group, fit_note, measurements_jsonb)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name,
         fit_note = EXCLUDED.fit_note,
         measurements_jsonb = EXCLUDED.measurements_jsonb`,
      [
        id,
        chart.code,
        chart.name,
        chart.gender,
        chart.garmentGroup,
        chart.fitNote,
        JSON.stringify(chart.rows),
      ],
    );
  }

  // 3. Products + Variants + SKUs
  const productIds = new Map<string, string>();
  let totalVariants = 0;
  let totalSkus = 0;

  for (const prod of PRODUCTS_SEED) {
    const productId = deterministicUuid(`product:${prod.slug}`);
    productIds.set(prod.slug, productId);
    const categoryId = categoryIds.get(prod.categorySlug)!;
    const sizeChartId = sizeChartIds.get(prod.sizeChartCode)!;
    const urls = assetUrlsBySlug.get(prod.slug)!;
    const minPrice = prod.salePriceVnd ?? prod.basePriceVnd;

    await db.query(
      `INSERT INTO products (
         id, category_id, slug, name, subtitle, brand_name, description,
         fabric_composition, fit_type, stretch_level, fabric_weight, gender,
         is_tryon_enabled, tryon_garment_category, tryon_flat_asset_url,
         fit_calibration_note, min_price_vnd, stock_status_summary, status,
         size_chart_id, occasion_slugs, season_slugs
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12,
         $13, $14, $15,
         $16, $17, $18, $19,
         $20, $21::jsonb, $22::jsonb
       )
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         subtitle = EXCLUDED.subtitle,
         description = EXCLUDED.description,
         fabric_composition = EXCLUDED.fabric_composition,
         is_tryon_enabled = EXCLUDED.is_tryon_enabled,
         tryon_flat_asset_url = EXCLUDED.tryon_flat_asset_url,
         fit_calibration_note = EXCLUDED.fit_calibration_note,
         min_price_vnd = EXCLUDED.min_price_vnd,
         occasion_slugs = EXCLUDED.occasion_slugs,
         season_slugs = EXCLUDED.season_slugs,
         updated_at = NOW()`,
      [
        productId,
        categoryId,
        prod.slug,
        prod.name,
        prod.subtitle,
        'Tầm Xuân Atelier',
        prod.description,
        prod.fabricComposition,
        prod.fitType,
        prod.stretchLevel,
        prod.fabricWeight,
        prod.gender,
        prod.isTryonEnabled,
        prod.tryonGarmentCategory,
        prod.isTryonEnabled ? urls.tryonFlatPreviewUrl : null,
        prod.fitCalibrationNote,
        minPrice,
        StockStatusSummary.IN_STOCK,
        ProductStatus.PUBLISHED,
        sizeChartId,
        JSON.stringify(prod.occasionSlugs),
        JSON.stringify(prod.seasonSlugs),
      ],
    );

    for (let vIdx = 0; vIdx < prod.variants.length; vIdx += 1) {
      const variant = prod.variants[vIdx];
      const variantId = deterministicUuid(`variant:${prod.slug}:${vIdx}`);
      const vUrls = urls.variants[vIdx] ?? urls;
      totalVariants += 1;

      const layerSpec = buildVariantLayerSpec(
        prod.slotCategory,
        vUrls.tryonFlat3x4GarmentKey,
      );

      const rackFrontAssetId = deterministicUuid(
        `media-rack-front:${prod.slug}:${vIdx}`,
      );
      const rackBackAssetId = deterministicUuid(
        `media-rack-back:${prod.slug}:${vIdx}`,
      );
      const studioLayerAssetId = deterministicUuid(
        `media-studio:${prod.slug}:${vIdx}`,
      );

      await db.query(
        `INSERT INTO product_variants (
           id, product_id, color_name, color_hex, lookbook_main_url,
           rack_front_asset_id, rack_back_asset_id, studio_layer_asset_id,
           tryon_flat_preview_url, rack_front_url, rack_back_url, studio_layer_url,
           layer_spec_jsonb
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8,
           $9, $10, $11, $12,
           $13::jsonb
         )
         ON CONFLICT (id) DO UPDATE SET
           lookbook_main_url = EXCLUDED.lookbook_main_url,
           rack_front_asset_id = EXCLUDED.rack_front_asset_id,
           rack_back_asset_id = EXCLUDED.rack_back_asset_id,
           tryon_flat_preview_url = EXCLUDED.tryon_flat_preview_url,
           rack_front_url = EXCLUDED.rack_front_url,
           rack_back_url = EXCLUDED.rack_back_url,
           studio_layer_url = EXCLUDED.studio_layer_url,
           layer_spec_jsonb = EXCLUDED.layer_spec_jsonb`,
        [
          variantId,
          productId,
          variant.colorName,
          variant.colorHex,
          vUrls.lookbookMainUrl,
          rackFrontAssetId,
          rackBackAssetId,
          studioLayerAssetId,
          prod.isTryonEnabled ? vUrls.tryonFlatPreviewUrl : null,
          vUrls.rackCutout2x3Url,
          vUrls.rackBackCutout2x3Url,
          vUrls.rackCutout2x3Url,
          JSON.stringify(layerSpec),
        ],
      );

      const slugCode =
        prod.skuPrefix ??
        prod.slug
          .split('-')
          .slice(0, 3)
          .map((seg) => seg.slice(0, 2).toUpperCase())
          .join('');

      for (const sizeCode of SIZES_STANDARD) {
        const skuId = deterministicUuid(`sku:${prod.slug}:${vIdx}:${sizeCode}`);
        const skuCode = `AT-${slugCode}-C${vIdx + 1}-${sizeCode}`;
        totalSkus += 1;

        await db.query(
          `INSERT INTO skus (
             id, variant_id, sku_code, size_code, base_price_vnd, sale_price_vnd,
             cost_price_vnd, supplier_id, weight_grams, in_stock, is_returnable
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
           ON CONFLICT (sku_code) DO NOTHING`,
          [
            skuId,
            variantId,
            skuCode,
            sizeCode,
            prod.basePriceVnd,
            prod.salePriceVnd,
            prod.costPriceVnd,
            prod.supplierId,
            prod.weightGrams,
            true,
          ],
        );
      }
    }
  }

  // 4. Occasion lookbooks + items (4 curated products per occasion)
  for (const occ of OCCASIONS_SEED) {
    const occId = deterministicUuid(`occasion:${occ.slug}`);
    const matchingProducts = getCuratedOccasionProducts(occ.slug);
    const heroSlug = matchingProducts[0]?.slug ?? PRODUCTS_SEED[0].slug;
    const heroUrl = assetUrlsBySlug.get(heroSlug)?.lookbookMainUrl ?? null;

    await db.query(
      `INSERT INTO occasion_lookbooks (
         id, slug, title, subtitle, palette_bg, palette_ink, palette_accent,
         is_dark, badge_tag, hero_image_url, sort_order
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (slug) DO UPDATE SET
         title = EXCLUDED.title,
         subtitle = EXCLUDED.subtitle,
         badge_tag = EXCLUDED.badge_tag,
         hero_image_url = EXCLUDED.hero_image_url`,
      [
        occId,
        occ.slug,
        occ.title,
        occ.subtitle,
        occ.paletteBg,
        occ.paletteInk,
        occ.paletteAccent,
        occ.isDark,
        occ.badgeTag,
        heroUrl,
        occ.sortOrder,
      ],
    );

    for (let idx = 0; idx < matchingProducts.length; idx += 1) {
      const prod = matchingProducts[idx];
      const itemId = deterministicUuid(`occ-item:${occ.slug}:${prod.slug}`);
      await db.query(
        `INSERT INTO occasion_lookbook_items (id, occasion_id, product_id, slot_label, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (occasion_id, product_id) DO NOTHING`,
        [itemId, occId, productIds.get(prod.slug)!, prod.slotCategory, idx + 1],
      );
    }
  }

  // 5. Seasonal collections
  for (const season of SEASONS_SEED) {
    const seasonId = deterministicUuid(`season:${season.slug}`);
    const matching = PRODUCTS_SEED.find((p) => p.seasonSlugs.includes(season.slug));
    const fallbackUrl = matching
      ? (assetUrlsBySlug.get(matching.slug)?.lookbookMainUrl ?? null)
      : null;
    const heroUrl = campaignEditorialUrls.seasonUrls[season.slug] ?? fallbackUrl;

    await db.query(
      `INSERT INTO seasonal_collections (
         id, slug, months, title, season_tag, subtitle, palette_hex, hero_image_url, is_current, sort_order
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (slug) DO UPDATE SET
         months = EXCLUDED.months,
         title = EXCLUDED.title,
         season_tag = EXCLUDED.season_tag,
         subtitle = EXCLUDED.subtitle,
         palette_hex = EXCLUDED.palette_hex,
         hero_image_url = EXCLUDED.hero_image_url,
         is_current = EXCLUDED.is_current,
         sort_order = EXCLUDED.sort_order`,
      [
        seasonId,
        season.slug,
        season.months,
        season.title,
        season.seasonTag,
        season.subtitle,
        season.paletteHex,
        heroUrl,
        season.isCurrent,
        season.sortOrder,
      ],
    );
  }

  // 6. Packaging options
  for (const pkg of PACKAGING_SEED) {
    const pkgId = deterministicUuid(`packaging:${pkg.code}`);
    const pkgUrls = campaignEditorialUrls.packagingUrls[pkg.code];
    await db.query(
      `INSERT INTO packaging_options (id, code, name, description, swatch_hex, price_vnd, image_url, back_image_url, is_default, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         price_vnd = EXCLUDED.price_vnd,
         image_url = EXCLUDED.image_url,
         back_image_url = EXCLUDED.back_image_url`,
      [
        pkgId,
        pkg.code,
        pkg.name,
        pkg.description,
        pkg.swatchHex,
        pkg.priceVnd,
        pkgUrls?.frontUrl ?? null,
        pkgUrls?.backUrl ?? null,
        pkg.isDefault,
        pkg.sortOrder,
      ],
    );
  }

  // 7. Active homepage campaign already guaranteed by ensureCampaignSeeded above

  // 8. Pre-seed 2 Supplier Product Submissions (1 Supplier A, 1 Supplier B)
  const subAUrl = assetUrlsBySlug.get('ao-so-mi-lua-to-tam-tam-xuan');
  const subBUrl = assetUrlsBySlug.get('ao-khoac-trench-gabardine-co-dien');

  await db.query(
    `INSERT INTO supplier_product_submissions (
       id, supplier_id, proposed_name, category_slug, wholesale_price_vnd,
       suggested_retail_vnd, fabric_composition, available_sizes_jsonb,
       color_name, color_hex, asset_ids_jsonb, raw_size_spec_jsonb,
       flat_asset_url, rack_asset_url, notes, status
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8::jsonb,
       $9, $10, $11::jsonb, $12::jsonb,
       $13, $14, $15, $16
     )
     ON CONFLICT (id) DO NOTHING`,
    [
      SEED_SUBMISSION_A_ID,
      SUPPLIER_A_ID,
      'Áo Lụa Cổ Thuyền Dệt Tơ Tằm Phiên Bản Giới Hạn',
      'ao-so-mi',
      710_000,
      2_190_000,
      '100% Lụa tơ tằm Bảo Lộc 22 momme',
      JSON.stringify(['XS', 'S', 'M', 'L']),
      'Trắng Sứ',
      '#F4EFE6',
      JSON.stringify(['seed-flat-supplier-a-01']),
      JSON.stringify({ S: { bustCm: 84, waistCm: 66 }, M: { bustCm: 88, waistCm: 70 } }),
      subAUrl?.tryonFlatPreviewUrl ?? null,
      subAUrl?.rackCutout2x3Url ?? null,
      'Đề xuất lô đầu 60 sản phẩm, giao xưởng Hà Nội trong 7 ngày.',
      SubmissionStatus.PENDING_REVIEW,
    ],
  );

  await db.query(
    `INSERT INTO supplier_product_submissions (
       id, supplier_id, proposed_name, category_slug, wholesale_price_vnd,
       suggested_retail_vnd, fabric_composition, available_sizes_jsonb,
       color_name, color_hex, asset_ids_jsonb, raw_size_spec_jsonb,
       flat_asset_url, rack_asset_url, notes, status
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8::jsonb,
       $9, $10, $11::jsonb, $12::jsonb,
       $13, $14, $15, $16
     )
     ON CONFLICT (id) DO NOTHING`,
    [
      SEED_SUBMISSION_B_ID,
      SUPPLIER_B_ID,
      'Áo Khoác Wool Dáng Dài Hai Hàng Khuy',
      'ao-khoac',
      1_480_000,
      4_350_000,
      '80% Wool Úc · 20% Cashmere',
      JSON.stringify(['S', 'M', 'L', 'XL']),
      'Nâu Hạt Dẻ',
      '#5C4332',
      JSON.stringify(['seed-flat-supplier-b-02']),
      JSON.stringify({ M: { bustCm: 92, shoulderCm: 40 }, L: { bustCm: 97, shoulderCm: 41.5 } }),
      subBUrl?.tryonFlatPreviewUrl ?? null,
      subBUrl?.rackCutout2x3Url ?? null,
      'Đề xuất BST Đông Cashmere từ xưởng may đối tác B.',
      SubmissionStatus.PENDING_REVIEW,
    ],
  );

  return {
    skipped: false,
    categories: CATEGORIES_SEED.length,
    sizeCharts: SIZE_CHARTS_SEED.length,
    products: PRODUCTS_SEED.length,
    variants: totalVariants,
    skus: totalSkus,
    tryonEnabledProducts: PRODUCTS_SEED.filter((p) => p.isTryonEnabled).length,
    occasions: OCCASIONS_SEED.length,
    seasons: SEASONS_SEED.length,
    packagingOptions: PACKAGING_SEED.length,
    submissions: 2,
    assetsUploadedToMinio: uploadedCount,
    campaignAssetsUploaded: campaignEditorialUrls.uploadedCount,
  };
}
