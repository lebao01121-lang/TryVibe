import { createHash } from 'node:crypto';
import type { AtelierDbClient } from '@atelier/db-client';
import {
  FitFeedback,
  NotificationChannel,
  ReviewModerationStatus,
  type FitFeedback as FitFeedbackType,
  type NotificationChannel as NotificationChannelType,
} from '@atelier/contracts';
import { computeVietnameseSentimentScore } from '../reviews/sentiment';
import { deriveSentimentLabelFromScore } from '../reviews/sentiment.service';

/**
 * Matches the exact deterministic UUID generator in
 * `services/catalog-lookbook/src/seed/catalog-seed.ts` so every seeded review
 * binds to the exact fixed product UUIDs & SKU IDs in `catalog_db`.
 */
export function catalogDeterministicUuid(seedKey: string): string {
  const hex = createHash('sha256').update(`atelier-catalog-v3:${seedKey}`).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function notifyDeterministicUuid(seedKey: string): string {
  const hex = createHash('sha256').update(`atelier-notify-v3:${seedKey}`).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

export const CATALOG_PRODUCT_SLUGS = [
  'ao-blazer-linen-dang-suong',
  'ao-so-mi-lua-to-tam-tam-xuan',
  'dam-du-tiec-lua-satin-co-do',
  'quan-tay-ong-suong-xep-ly-doi',
  'chan-vay-xep-ly-midi-cap-cao',
  'ao-khoac-trench-gabardine-co-dien',
  'ao-kieu-lua-organza-phoi-no',
  'dam-midi-co-vuong-chiet-eo',
  'ao-cardigan-len-merino-khuy-sung',
  'quan-culottes-linen-huu-co',
  'ao-khoac-tweed-det-thu-cong',
  'ao-polo-det-kim-bong-ai-cap',
  // Stage 3 extended catalog apparel slugs
  'ao-len-cashmere-co-lo',
  'ao-so-mi-lua-to-tam-bao-loc',
  'ao-dai-cach-tan-gam-lua',
  'dam-midi-linen-phoi-dai',
  'quan-ong-suong-wool-blend',
  'ao-khoac-tweed-nut-dong',
  'chan-vay-lua-vat-cheo',
  'trench-coat-kaki-co-dien',
] as const;

type CatalogProductSlug = (typeof CATALOG_PRODUCT_SLUGS)[number];
type SeedSizeCode = 'XS' | 'S' | 'M' | 'L' | 'XL';

interface SeedReviewBlueprint {
  slug: CatalogProductSlug;
  variantIdx: 0 | 1;
  sizePurchased: SeedSizeCode;
  reviewerName: string;
  heightCm: number;
  weightKg: number;
  rating: 1 | 2 | 3 | 4 | 5;
  fitFeedback: FitFeedbackType;
  comment: string;
  daysAgo: number;
}

const SEED_REVIEWS: readonly SeedReviewBlueprint[] = [
  // 1. Áo Blazer Linen Dáng Suông — 6 reviews: 4 RUNS_SMALL (67%), 2 TRUE_TO_SIZE (33%)
  {
    slug: 'ao-blazer-linen-dang-suong',
    variantIdx: 0,
    sizePurchased: 'S',
    reviewerName: 'Nguyễn Minh Anh',
    heightCm: 157,
    weightKg: 46,
    rating: 5,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m57 · 46kg · Mặc size S — Vải linen Bỉ đứng phom, lót lụa habotai mịn mát nhưng phần dựng vai và bắp tay hơi ôm, bạn nào thích khoác ngoài sơ mi nên nhích lên 1 size.',
    daysAgo: 2,
  },
  {
    slug: 'ao-blazer-linen-dang-suong',
    variantIdx: 1,
    sizePurchased: 'S',
    reviewerName: 'Trần Thu Hà',
    heightCm: 160,
    weightKg: 49,
    rating: 4,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m60 · 49kg · Mặc size S — Màu cacao đậm rất sang và đường khâu ve áo sắc nét, tuy nhiên phom vai cắt khá gọn, cử động tay hơi kích nhẹ nếu mặc kèm áo dày bên trong.',
    daysAgo: 5,
  },
  {
    slug: 'ao-blazer-linen-dang-suong',
    variantIdx: 0,
    sizePurchased: 'M',
    reviewerName: 'Lê Khánh Linh',
    heightCm: 162,
    weightKg: 51,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m62 · 51kg · Mặc size M — Mình chủ động chọn size M theo gợi ý và mặc rất thoải mái, vai rơi gọn gàng, chất linen ít nhăn hơn hẳn các dòng linen mỏng thông thường.',
    daysAgo: 8,
  },
  {
    slug: 'ao-blazer-linen-dang-suong',
    variantIdx: 0,
    sizePurchased: 'M',
    reviewerName: 'Phạm Ngọc Hân',
    heightCm: 165,
    weightKg: 55,
    rating: 4,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m65 · 55kg · Mặc size M — Form áo tinh tế, khuy sừng tự nhiên đẹp lắm nhưng cài khuy trước ngực hơi ôm so với bảng size chuẩn, nên tăng lên L nếu hay cài kín.',
    daysAgo: 12,
  },
  {
    slug: 'ao-blazer-linen-dang-suong',
    variantIdx: 1,
    sizePurchased: 'L',
    reviewerName: 'Vũ Thảo Vy',
    heightCm: 169,
    weightKg: 61,
    rating: 5,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m69 · 61kg · Mặc size L — Chất vải thoáng khí và dựng vai rất chỉnh chu, nhưng form nách cắt hơi sát chuẩn couture nên vai rộng cần cân nhắc lên 1 cỡ.',
    daysAgo: 17,
  },
  {
    slug: 'ao-blazer-linen-dang-suong',
    variantIdx: 0,
    sizePurchased: 'XL',
    reviewerName: 'Đỗ Hoàng Yến',
    heightCm: 174,
    weightKg: 70,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m74 · 70kg · Mặc size XL — Áo màu cát ngà lên dáng thanh lịch, mặc đi họp khách hàng cả ngày vẫn mát và nhẹ vai, rất hài lòng với hoàn thiện thủ công.',
    daysAgo: 23,
  },

  // 2. Áo Sơ Mi Lụa Tơ Tằm Tầm Xuân — 4 reviews: 3 TRUE_TO_SIZE (75%), 1 RUNS_SMALL (25%)
  {
    slug: 'ao-so-mi-lua-to-tam-tam-xuan',
    variantIdx: 0,
    sizePurchased: 'S',
    reviewerName: 'Bùi Lan Phương',
    heightCm: 162,
    weightKg: 51,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m62 · 51kg · Mặc size S — Vải lụa Bảo Lộc rủ mát, chuẩn vai, đường may nẹp giấu khuy ngọc trai thủ công cực kỳ sắc nét.',
    daysAgo: 3,
  },
  {
    slug: 'ao-so-mi-lua-to-tam-tam-xuan',
    variantIdx: 1,
    sizePurchased: 'M',
    reviewerName: 'Hoàng Mai Chi',
    heightCm: 165,
    weightKg: 54,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m65 · 54kg · Mặc size M — Sắc champagne ấm lên da rất sáng, bề mặt lụa 19 momme óng nhẹ tự nhiên, mặc đi làm và dự tiệc nhẹ đều hợp.',
    daysAgo: 9,
  },
  {
    slug: 'ao-so-mi-lua-to-tam-tam-xuan',
    variantIdx: 0,
    sizePurchased: 'S',
    reviewerName: 'Đặng Quỳnh Như',
    heightCm: 159,
    weightKg: 50,
    rating: 4,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m59 · 50kg · Mặc size S — Lụa mềm và mát nhưng vì không co giãn nên phần ngực hơi ôm nhẹ, bạn nào vòng 1 đầy đặn nên cân nhắc chọn M.',
    daysAgo: 15,
  },
  {
    slug: 'ao-so-mi-lua-to-tam-tam-xuan',
    variantIdx: 1,
    sizePurchased: 'L',
    reviewerName: 'Ngô Thanh Trúc',
    heightCm: 168,
    weightKg: 60,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m68 · 60kg · Mặc size L — Chuẩn phom, tay áo dài vừa cổ tay, đóng hộp thơm mùi trà trắng mở ra cực kỳ ưng ý.',
    daysAgo: 21,
  },

  // 3. Đầm Dự Tiệc Lụa Satin Cổ Đổ — 6 reviews: 4 RUNS_SMALL (67%), 2 TRUE_TO_SIZE (33%)
  {
    slug: 'dam-du-tiec-lua-satin-co-do',
    variantIdx: 0,
    sizePurchased: 'XS',
    reviewerName: 'Trịnh Gia Hân',
    heightCm: 156,
    weightKg: 45,
    rating: 5,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m56 · 45kg · Mặc size XS — Màu đỏ rượu vang bắt sáng tuyệt đẹp dưới đèn tiệc tối, nhưng phom cắt thiên bias ôm vòng eo khá sát nên chị em nên nhích lên 1 size cho thoải mái.',
    daysAgo: 2,
  },
  {
    slug: 'dam-du-tiec-lua-satin-co-do',
    variantIdx: 1,
    sizePurchased: 'S',
    reviewerName: 'Phan Bảo Châu',
    heightCm: 161,
    weightKg: 50,
    rating: 4,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m61 · 50kg · Mặc size S — Lụa satin 22 momme dày dặn không lộ khuyết điểm, cổ đổ rủ tinh tế, nhưng phần hông và eo hơi chật nếu ăn tiệc tối, khuyên lên size M.',
    daysAgo: 6,
  },
  {
    slug: 'dam-du-tiec-lua-satin-co-do',
    variantIdx: 0,
    sizePurchased: 'M',
    reviewerName: 'Lý Hải Yến',
    heightCm: 163,
    weightKg: 52,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m63 · 52kg · Mặc size M — Mình chọn nhích lên M theo tư vấn và lên dáng tôn đường cong vừa vặn, di chuyển cả buổi tiệc rất nhẹ nhàng.',
    daysAgo: 11,
  },
  {
    slug: 'dam-du-tiec-lua-satin-co-do',
    variantIdx: 1,
    sizePurchased: 'M',
    reviewerName: 'Dương Phương Thảo',
    heightCm: 166,
    weightKg: 56,
    rating: 4,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m66 · 56kg · Mặc size M — Đầm đen huyền siêu sang, đường may mặt trong chỉnh chu, duy có vòng eo cắt ôm chuẩn rập nên ai giữa hai cỡ chắc chắn nên chọn L.',
    daysAgo: 16,
  },
  {
    slug: 'dam-du-tiec-lua-satin-co-do',
    variantIdx: 0,
    sizePurchased: 'L',
    reviewerName: 'Võ Minh Thư',
    heightCm: 168,
    weightKg: 59,
    rating: 5,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m68 · 59kg · Mặc size L — Sóng lụa cổ đổ quá xuất sắc, chất vải nặng tay rất sang nhưng form hơi nhỏ ở phần eo trên so với các mẫu đầm suông.',
    daysAgo: 20,
  },
  {
    slug: 'dam-du-tiec-lua-satin-co-do',
    variantIdx: 1,
    sizePurchased: 'XL',
    reviewerName: 'Tạ Mỹ Linh',
    heightCm: 171,
    weightKg: 64,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m71 · 64kg · Mặc size XL — Rất tôn dáng, chiều dài đầm qua bắp chân vừa đẹp khi đi giày cao gót 7cm, hoàn toàn hài lòng.',
    daysAgo: 27,
  },

  // 4. Quần Tây Ống Suông Xếp Ly Đôi — 4 reviews: 3 TRUE_TO_SIZE (75%), 1 RUNS_LARGE (25%)
  {
    slug: 'quan-tay-ong-suong-xep-ly-doi',
    variantIdx: 0,
    sizePurchased: 'S',
    reviewerName: 'Nguyễn Thảo Linh',
    heightCm: 160,
    weightKg: 49,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m60 · 49kg · Mặc size S — Quần cạp cao kéo dài tỷ lệ chân rõ rệt, đường ép ly đôi đứng phom và có 2% elastane nên ngồi làm việc cả ngày vẫn dễ chịu.',
    daysAgo: 4,
  },
  {
    slug: 'quan-tay-ong-suong-xep-ly-doi',
    variantIdx: 1,
    sizePurchased: 'M',
    reviewerName: 'Trần Khánh Vân',
    heightCm: 165,
    weightKg: 55,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m65 · 55kg · Mặc size M — Màu be đá phối cùng áo sơ mi lụa trắng ngà cực hợp gu công sở tối giản, vừa vặn vòng eo chuẩn bảng size.',
    daysAgo: 10,
  },
  {
    slug: 'quan-tay-ong-suong-xep-ly-doi',
    variantIdx: 0,
    sizePurchased: 'L',
    reviewerName: 'Lê Thanh Nhàn',
    heightCm: 168,
    weightKg: 60,
    rating: 4,
    fitFeedback: FitFeedback.RUNS_LARGE,
    comment:
      '1m68 · 60kg · Mặc size L — Chất len pha mịn mát không hề ngứa, nhưng phần cạp sau hơi rộng khoảng 1.5cm với người eo nhỏ.',
    daysAgo: 18,
  },
  {
    slug: 'quan-tay-ong-suong-xep-ly-doi',
    variantIdx: 1,
    sizePurchased: 'M',
    reviewerName: 'Phạm Diệu Anh',
    heightCm: 163,
    weightKg: 53,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m63 · 53kg · Mặc size M — Chuẩn size, ống quần rủ thẳng che khuyết điểm chân rất khéo, giặt hấp xong giữ ly sắc nét.',
    daysAgo: 25,
  },

  // 5. Chân Váy Xếp Ly Midi Cạp Cao — 4 reviews: 3 TRUE_TO_SIZE (75%), 1 RUNS_SMALL (25%)
  {
    slug: 'chan-vay-xep-ly-midi-cap-cao',
    variantIdx: 0,
    sizePurchased: 'S',
    reviewerName: 'Đào Ngọc Diệp',
    heightCm: 158,
    weightKg: 48,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m58 · 48kg · Mặc size S — Màu kem sữa thanh nhã, ly váy xếp nhiệt đều tăm tắp, bước đi bay rất mềm mại.',
    daysAgo: 3,
  },
  {
    slug: 'chan-vay-xep-ly-midi-cap-cao',
    variantIdx: 1,
    sizePurchased: 'M',
    reviewerName: 'Vũ Hà My',
    heightCm: 164,
    weightKg: 54,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m64 · 54kg · Mặc size M — Tông xanh khói lạ mắt, chất lụa pha Tencel thoáng nhẹ và cạp cao ôm gọn vòng eo trên rốn.',
    daysAgo: 13,
  },
  {
    slug: 'chan-vay-xep-ly-midi-cap-cao',
    variantIdx: 0,
    sizePurchased: 'S',
    reviewerName: 'Hoàng Uyên Nhi',
    heightCm: 161,
    weightKg: 51,
    rating: 4,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m61 · 51kg · Mặc size S — Váy rất đẹp và không bị mỏng, tuy nhiên cạp khóa giọt lệ hơi ôm sát vòng eo sau khi ăn no.',
    daysAgo: 19,
  },
  {
    slug: 'chan-vay-xep-ly-midi-cap-cao',
    variantIdx: 1,
    sizePurchased: 'L',
    reviewerName: 'Nguyễn Kim Ngân',
    heightCm: 169,
    weightKg: 61,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m69 · 61kg · Mặc size L — Chiều dài midi qua gối thanh lịch, phối cùng cardigan len merino đi triển lãm rất hợp.',
    daysAgo: 28,
  },

  // 6. Áo Khoác Trench Gabardine Cổ Điển — 4 reviews: 3 RUNS_LARGE (75%), 1 TRUE_TO_SIZE (25%)
  {
    slug: 'ao-khoac-trench-gabardine-co-dien',
    variantIdx: 0,
    sizePurchased: 'L',
    reviewerName: 'Nguyễn Quang Đức',
    heightCm: 175,
    weightKg: 70,
    rating: 5,
    fitFeedback: FitFeedback.RUNS_LARGE,
    comment:
      '1m75 · 70kg · Mặc size L — Vải cotton gabardine dệt khít trượt nước nhẹ cực kỳ chất lượng, dáng raglan phóng khoáng hơi rộng rãi để khoác ngoài blazer.',
    daysAgo: 4,
  },
  {
    slug: 'ao-khoac-trench-gabardine-co-dien',
    variantIdx: 1,
    sizePurchased: 'M',
    reviewerName: 'Trần Minh Khôi',
    heightCm: 172,
    weightKg: 66,
    rating: 5,
    fitFeedback: FitFeedback.RUNS_LARGE,
    comment:
      '1m72 · 66kg · Mặc size M — Màu ô liu trầm cùng đai thắt đồng thau rất khí chất, form áo hơi rộng so với áo sơ mi thường nên mặc M đã rất thoải mái.',
    daysAgo: 11,
  },
  {
    slug: 'ao-khoac-trench-gabardine-co-dien',
    variantIdx: 0,
    sizePurchased: 'S',
    reviewerName: 'Lê Hồng Nhung',
    heightCm: 163,
    weightKg: 52,
    rating: 5,
    fitFeedback: FitFeedback.RUNS_LARGE,
    comment:
      '1m63 · 52kg · Mặc size S — Áo unisex nên dáng hơi rộng nhẹ ở vai và tay áo, thắt đai eo vào nhìn rất chuẩn phong cách Paris mùa thu.',
    daysAgo: 20,
  },
  {
    slug: 'ao-khoac-trench-gabardine-co-dien',
    variantIdx: 1,
    sizePurchased: 'S',
    reviewerName: 'Phạm Hoài An',
    heightCm: 166,
    weightKg: 56,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m66 · 56kg · Mặc size S — Đường may hai hàng khuy chắc chắn, lót trong mượt mà, rất đáng tiền cho một chiếc trench cổ điển.',
    daysAgo: 31,
  },

  // 7. Áo Kiểu Lụa Organza Phối Nơ — 3 reviews: 2 TRUE_TO_SIZE (67%), 1 RUNS_SMALL (33%)
  {
    slug: 'ao-kieu-lua-organza-phoi-no',
    variantIdx: 0,
    sizePurchased: 'S',
    reviewerName: 'Đỗ Bích Ngọc',
    heightCm: 160,
    weightKg: 49,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m60 · 49kg · Mặc size S — Màu hồng phấn đất dịu dàng, có sẵn áo hai dây lụa đồng màu bên trong cực tiện, nơ cổ thắt mềm rủ rất duyên.',
    daysAgo: 6,
  },
  {
    slug: 'ao-kieu-lua-organza-phoi-no',
    variantIdx: 0,
    sizePurchased: 'M',
    reviewerName: 'Trần Nhật Lệ',
    heightCm: 164,
    weightKg: 54,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m64 · 54kg · Mặc size M — Organza tơ tằm mềm chứ không hề cứng hay ngứa cổ, mặc đi đám cưới bạn thân ai cũng khen.',
    daysAgo: 16,
  },
  {
    slug: 'ao-kieu-lua-organza-phoi-no',
    variantIdx: 0,
    sizePurchased: 'S',
    reviewerName: 'Ngô Minh Châu',
    heightCm: 158,
    weightKg: 50,
    rating: 4,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m58 · 50kg · Mặc size S — Thiết kế tinh tế, duy phần ống tay hơi ôm nhẹ ở cổ tay vì vải organza không co giãn.',
    daysAgo: 26,
  },

  // 8. Đầm Midi Cổ Vuông Chiết Eo — 4 reviews: 2 RUNS_SMALL (50%), 2 TRUE_TO_SIZE (50%)
  {
    slug: 'dam-midi-co-vuong-chiet-eo',
    variantIdx: 0,
    sizePurchased: 'S',
    reviewerName: 'Nguyễn Cẩm Tú',
    heightCm: 159,
    weightKg: 48,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m59 · 48kg · Mặc size S — Cổ vuông tôn xương quai xanh thanh thoát, vải linen pha lụa màu trắng ngọc dày dặn có lớp lót kín đáo.',
    daysAgo: 5,
  },
  {
    slug: 'dam-midi-co-vuong-chiet-eo',
    variantIdx: 1,
    sizePurchased: 'M',
    reviewerName: 'Lê Phương Linh',
    heightCm: 164,
    weightKg: 55,
    rating: 4,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m64 · 55kg · Mặc size M — Đầm màu nâu espresso sang trọng nhưng chiết eo khá sát phom, ai vòng eo trên 70cm nên chọn lên L.',
    daysAgo: 14,
  },
  {
    slug: 'dam-midi-co-vuong-chiet-eo',
    variantIdx: 0,
    sizePurchased: 'M',
    reviewerName: 'Phạm Bảo Trâm',
    heightCm: 166,
    weightKg: 56,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m66 · 56kg · Mặc size M — Dáng chữ A cân đối, mặc đi du lịch biển hay tiệc trà chiều đều lên ảnh cực kỳ tinh tế.',
    daysAgo: 22,
  },
  {
    slug: 'dam-midi-co-vuong-chiet-eo',
    variantIdx: 1,
    sizePurchased: 'S',
    reviewerName: 'Bùi Thanh Hằng',
    heightCm: 161,
    weightKg: 51,
    rating: 4,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m61 · 51kg · Mặc size S — Vải mát và đường chiết ly eo sắc sảo nhưng phần chân ngực hơi ôm nhẹ so với dáng regular.',
    daysAgo: 30,
  },

  // 9. Áo Cardigan Len Merino Khuy Sừng — 3 reviews: 2 TRUE_TO_SIZE (67%), 1 RUNS_LARGE (33%)
  {
    slug: 'ao-cardigan-len-merino-khuy-sung',
    variantIdx: 0,
    sizePurchased: 'S',
    reviewerName: 'Vũ Khánh Chi',
    heightCm: 161,
    weightKg: 50,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m61 · 50kg · Mặc size S — Len Merino Úc siêu mịn mặc chạm da rất êm, không xù lông sau 3 lần giặt tay, khuy sừng mài thủ công đẹp.',
    daysAgo: 7,
  },
  {
    slug: 'ao-cardigan-len-merino-khuy-sung',
    variantIdx: 0,
    sizePurchased: 'M',
    reviewerName: 'Hoàng Diệp Anh',
    heightCm: 165,
    weightKg: 54,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m65 · 54kg · Mặc size M — Màu yến mạch dễ phối với mọi chân váy và quần tây, giữ ấm nhẹ vừa đủ cho phòng điều hòa.',
    daysAgo: 17,
  },
  {
    slug: 'ao-cardigan-len-merino-khuy-sung',
    variantIdx: 0,
    sizePurchased: 'L',
    reviewerName: 'Đặng Mỹ Duyên',
    heightCm: 167,
    weightKg: 58,
    rating: 5,
    fitFeedback: FitFeedback.RUNS_LARGE,
    comment:
      '1m67 · 58kg · Mặc size L — Sợi len co giãn tốt nên size L khoác ngoài khá rộng rãi thoải mái, ai thích ôm gọn nên giữ nguyên size M.',
    daysAgo: 29,
  },

  // 10. Quần Culottes Linen Hữu Cơ — 3 reviews: 2 RUNS_LARGE (67%), 1 TRUE_TO_SIZE (33%)
  {
    slug: 'quan-culottes-linen-huu-co',
    variantIdx: 0,
    sizePurchased: 'S',
    reviewerName: 'Phan Thu Trang',
    heightCm: 160,
    weightKg: 49,
    rating: 5,
    fitFeedback: FitFeedback.RUNS_LARGE,
    comment:
      '1m60 · 49kg · Mặc size S — Linen stone-washed cực kỳ mềm và mát, phần chun ẩn sau lưng giãn thoải mái nên dáng ống hơi rộng phóng khoáng.',
    daysAgo: 8,
  },
  {
    slug: 'quan-culottes-linen-huu-co',
    variantIdx: 0,
    sizePurchased: 'M',
    reviewerName: 'Lý Thảo Nhi',
    heightCm: 165,
    weightKg: 55,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m65 · 55kg · Mặc size M — Màu cát biển đúng tinh thần nghỉ dưỡng, mặc đi dạo phố mùa hạ thoáng nhẹ tuyệt đối.',
    daysAgo: 19,
  },
  {
    slug: 'quan-culottes-linen-huu-co',
    variantIdx: 0,
    sizePurchased: 'M',
    reviewerName: 'Trịnh Hoài Thương',
    heightCm: 163,
    weightKg: 52,
    rating: 4,
    fitFeedback: FitFeedback.RUNS_LARGE,
    comment:
      '1m63 · 52kg · Mặc size M — Vải tốt và lên dáng rất bay nhưng vòng lưng có chun nên ai eo nhỏ hoàn toàn có thể lùi xuống S.',
    daysAgo: 33,
  },

  // 11. Áo Khoác Tweed Dệt Thủ Công — 4 reviews: 3 TRUE_TO_SIZE (75%), 1 RUNS_SMALL (25%)
  {
    slug: 'ao-khoac-tweed-det-thu-cong',
    variantIdx: 0,
    sizePurchased: 'S',
    reviewerName: 'Nguyễn Hải Anh',
    heightCm: 162,
    weightKg: 51,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m62 · 51kg · Mặc size S — Tweed ngà ánh đồng dệt sợi lụa pha len cực kỳ tinh xảo, viền tết tay sắc nét chuẩn couture.',
    daysAgo: 4,
  },
  {
    slug: 'ao-khoac-tweed-det-thu-cong',
    variantIdx: 1,
    sizePurchased: 'M',
    reviewerName: 'Trần Ngọc Lan',
    heightCm: 165,
    weightKg: 55,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m65 · 55kg · Mặc size M — Màu cacao đêm cùng cúc kim loại khắc nổi sang trọng, vai áo đứng phom chuẩn size.',
    daysAgo: 13,
  },
  {
    slug: 'ao-khoac-tweed-det-thu-cong',
    variantIdx: 0,
    sizePurchased: 'M',
    reviewerName: 'Lê Tường Vy',
    heightCm: 164,
    weightKg: 56,
    rating: 4,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m64 · 56kg · Mặc size M — Vải tweed dày dặn 340gsm không co giãn nên nếu mặc áo len cổ lọ dày bên trong sẽ hơi ôm vai.',
    daysAgo: 21,
  },
  {
    slug: 'ao-khoac-tweed-det-thu-cong',
    variantIdx: 1,
    sizePurchased: 'L',
    reviewerName: 'Phạm Quỳnh Anh',
    heightCm: 170,
    weightKg: 62,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m70 · 62kg · Mặc size L — Hoàn thiện lớp lót mặt trong rất mượt, giữ ấm tốt cho tiết trời đông Hà Nội.',
    daysAgo: 32,
  },

  // 12. Áo Polo Dệt Kim Bông Ai Cập — 3 reviews: 3 TRUE_TO_SIZE (100%)
  {
    slug: 'ao-polo-det-kim-bong-ai-cap',
    variantIdx: 0,
    sizePurchased: 'M',
    reviewerName: 'Trần Bảo Nam',
    heightCm: 173,
    weightKg: 67,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m73 · 67kg · Mặc size M — Bông Ai Cập sợi dài Giza mịn mát, mặc cả ngày ít nhăn và giữ cổ áo đứng gọn gàng đúng tinh thần Quiet Luxury.',
    daysAgo: 5,
  },
  {
    slug: 'ao-polo-det-kim-bong-ai-cap',
    variantIdx: 0,
    sizePurchased: 'S',
    reviewerName: 'Nguyễn Hà Linh',
    heightCm: 162,
    weightKg: 51,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m62 · 51kg · Mặc size S — Tông xanh navy trầm sang, dệt kim co giãn thoải mái, phối với quần tây hay culottes đều đẹp.',
    daysAgo: 15,
  },
  {
    slug: 'ao-polo-det-kim-bong-ai-cap',
    variantIdx: 0,
    sizePurchased: 'L',
    reviewerName: 'Đỗ Minh Quân',
    heightCm: 178,
    weightKg: 74,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m78 · 74kg · Mặc size L — Chuẩn size, chất vải thấm hút mồ hôi rất tốt, bề mặt vải lì mịn đúng chuẩn cao cấp.',
    daysAgo: 26,
  },

  // Phase 6 rich catalog additions (indices 48..53 -> 54 total verified reviews, 154–182cm, 44–78kg, XS–XL)
  {
    slug: 'ao-kieu-lua-organza-phoi-no',
    variantIdx: 0,
    sizePurchased: 'XS',
    reviewerName: 'Nguyễn Ánh Dương',
    heightCm: 154,
    weightKg: 44,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m54 · 44kg · Mặc size XS — Dáng người nhỏ rất khó chọn áo nhưng XS của Tầm Xuân vừa vặn bờ vai, chất organza mềm nhẹ bay bổng.',
    daysAgo: 3,
  },
  {
    slug: 'ao-so-mi-lua-to-tam-tam-xuan',
    variantIdx: 1,
    sizePurchased: 'M',
    reviewerName: 'Trần Phương Mai',
    heightCm: 164,
    weightKg: 53,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m64 · 53kg · Mặc size M — Lụa Bảo Lộc mặc cả ngày không bí, màu champagne phối cùng quần tây xám than cực kỳ tinh tế.',
    daysAgo: 6,
  },
  {
    slug: 'quan-tay-ong-suong-xep-ly-doi',
    variantIdx: 0,
    sizePurchased: 'XL',
    reviewerName: 'Lê Thanh Tâm',
    heightCm: 172,
    weightKg: 67,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m72 · 67kg · Mặc size XL — Cạp cao đứng phom che khuyết điểm vòng eo tốt, chất len pha mịn rủ thẳng gấu rất tôn chiều cao.',
    daysAgo: 9,
  },
  {
    slug: 'ao-cardigan-len-merino-khuy-sung',
    variantIdx: 0,
    sizePurchased: 'M',
    reviewerName: 'Phạm Minh Nguyệt',
    heightCm: 163,
    weightKg: 52,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m63 · 52kg · Mặc size M — Len merino mịn nhẹ không xù, cài hết khuy hay khoác hờ vai đều thanh lịch đúng chất atelier Hà Nội.',
    daysAgo: 12,
  },
  {
    slug: 'ao-khoac-trench-gabardine-co-dien',
    variantIdx: 0,
    sizePurchased: 'XL',
    reviewerName: 'Hoàng Việt Anh',
    heightCm: 180,
    weightKg: 76,
    rating: 5,
    fitFeedback: FitFeedback.RUNS_LARGE,
    comment:
      '1m80 · 76kg · Mặc size XL — Dáng trench raglan rộng rãi chuẩn khoác ngoài vest, vải gabardine dệt khít cản gió mùa thu rất tốt.',
    daysAgo: 14,
  },
  {
    slug: 'ao-polo-det-kim-bong-ai-cap',
    variantIdx: 0,
    sizePurchased: 'XL',
    reviewerName: 'Vũ Gia Bảo',
    heightCm: 182,
    weightKg: 78,
    rating: 4,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m82 · 78kg · Mặc size XL — Dáng cao mặc XL chiều dài thân áo vừa vặn, sợi cotton Ai Cập mịn mát và giữ phom cổ tốt sau nhiều lần giặt.',
    daysAgo: 18,
  },

  // Stage 3 additive verified fit reviews (indices 54..87) — non-destructive INSERT WHERE NOT EXISTS
  // 13. Áo Len Cashmere Cổ Lọ — 5 reviews: 4 TRUE_TO_SIZE (80%), 1 RUNS_LARGE (20%)
  {
    slug: 'ao-len-cashmere-co-lo',
    variantIdx: 0,
    sizePurchased: 'S',
    reviewerName: 'Nguyễn Minh Thư',
    heightCm: 157,
    weightKg: 46,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m57 · 46kg · Mặc size S — Len cashmere Mông Cổ mềm mịn chạm cổ không hề dặm ngứa, độ co giãn tốt nên mặc S chuẩn vai và ấm nhẹ.',
    daysAgo: 2,
  },
  {
    slug: 'ao-len-cashmere-co-lo',
    variantIdx: 1,
    sizePurchased: 'S',
    reviewerName: 'Trần Ngọc Mai',
    heightCm: 160,
    weightKg: 50,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m60 · 50kg · Mặc size S — Tông cacao đậm mặc phối trong blazer linen cực kỳ sang, phần cổ lọ đứng mềm vừa phải không bị bó.',
    daysAgo: 4,
  },
  {
    slug: 'ao-len-cashmere-co-lo',
    variantIdx: 0,
    sizePurchased: 'M',
    reviewerName: 'Lê Bảo Ngọc',
    heightCm: 164,
    weightKg: 54,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m64 · 54kg · Mặc size M — Màu kem cashmere ngoài đời còn đẹp hơn ảnh, sợi dệt mịn và chuẩn bảng size của xưởng.',
    daysAgo: 7,
  },
  {
    slug: 'ao-len-cashmere-co-lo',
    variantIdx: 1,
    sizePurchased: 'L',
    reviewerName: 'Phạm Thu Giang',
    heightCm: 168,
    weightKg: 60,
    rating: 5,
    fitFeedback: FitFeedback.RUNS_LARGE,
    comment:
      '1m68 · 60kg · Mặc size L — Len có độ giãn đàn hồi tốt nên mặc size L hơi rộng nhẹ phần eo, ai thích mặc gọn bên trong áo khoác giữ nguyên M là đẹp.',
    daysAgo: 11,
  },
  {
    slug: 'ao-len-cashmere-co-lo',
    variantIdx: 0,
    sizePurchased: 'XL',
    reviewerName: 'Hoàng Gia Khánh',
    heightCm: 173,
    weightKg: 68,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m73 · 68kg · Mặc size XL — Chiều dài tay áo và thân áo rất cân đối, chất len nhẹ mà giữ nhiệt cực tốt cho thời tiết Hà Nội.',
    daysAgo: 15,
  },

  // 14. Áo Sơ Mi Lụa Tơ Tằm Bảo Lộc — 5 reviews: 4 RUNS_SMALL (80%), 1 TRUE_TO_SIZE (20%)
  {
    slug: 'ao-so-mi-lua-to-tam-bao-loc',
    variantIdx: 0,
    sizePurchased: 'S',
    reviewerName: 'Đỗ Phương Anh',
    heightCm: 156,
    weightKg: 46,
    rating: 5,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m56 · 46kg · Mặc size S — Lụa Bảo Lộc ánh ngọc tự nhiên rất đẳng cấp nhưng vải không co giãn và phần vai hơi ôm nhẹ, ai thích thoải mái nên nhích lên 1 size.',
    daysAgo: 2,
  },
  {
    slug: 'ao-so-mi-lua-to-tam-bao-loc',
    variantIdx: 0,
    sizePurchased: 'S',
    reviewerName: 'Vũ Khánh Huyền',
    heightCm: 160,
    weightKg: 50,
    rating: 4,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m60 · 50kg · Mặc size S — Đường may lộn giấu chỉ rất tinh xảo, nhưng vòng ngực và nách hơi sát khi cử động tay, mình đổi lên M mặc đẹp hơn hẳn.',
    daysAgo: 5,
  },
  {
    slug: 'ao-so-mi-lua-to-tam-bao-loc',
    variantIdx: 1,
    sizePurchased: 'M',
    reviewerName: 'Bùi Hải Anh',
    heightCm: 164,
    weightKg: 55,
    rating: 5,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m64 · 55kg · Mặc size M — Vải lụa dày dặn mát da, phom cắt chiết nhẹ nên hơi ôm phần ngực so với sơ mi dáng suông thông thường.',
    daysAgo: 9,
  },
  {
    slug: 'ao-so-mi-lua-to-tam-bao-loc',
    variantIdx: 1,
    sizePurchased: 'L',
    reviewerName: 'Ngô Minh Hằng',
    heightCm: 169,
    weightKg: 62,
    rating: 4,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m69 · 62kg · Mặc size L — Màu champagne cực sang nhưng cầu vai dựng gọn chuẩn rập couture, khuyên chị em vai ngang tăng thêm 1 cỡ.',
    daysAgo: 14,
  },
  {
    slug: 'ao-so-mi-lua-to-tam-bao-loc',
    variantIdx: 0,
    sizePurchased: 'XL',
    reviewerName: 'Trịnh Thanh Thảo',
    heightCm: 173,
    weightKg: 68,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m73 · 68kg · Mặc size XL — Mình chủ động chọn XL theo tư vấn cố vấn size AI và mặc rất vừa vai, cổ tay khuy ngọc trai rất tinh tế.',
    daysAgo: 19,
  },

  // 15. Áo Dài Cách Tân Gấm Lụa — 4 reviews: 3 RUNS_SMALL (75%), 1 TRUE_TO_SIZE (25%)
  {
    slug: 'ao-dai-cach-tan-gam-lua',
    variantIdx: 0,
    sizePurchased: 'S',
    reviewerName: 'Nguyễn Linh Chi',
    heightCm: 158,
    weightKg: 48,
    rating: 5,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m58 · 48kg · Mặc size S — Gấm lụa dệt nổi sang trọng nhưng vòng eo chiết sát tôn dáng, ai muốn ngồi tiệc thoải mái nên chọn lên M.',
    daysAgo: 3,
  },
  {
    slug: 'ao-dai-cach-tan-gam-lua',
    variantIdx: 0,
    sizePurchased: 'M',
    reviewerName: 'Lê Kiều Oanh',
    heightCm: 163,
    weightKg: 53,
    rating: 4,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m63 · 53kg · Mặc size M — Đường ráp tay raglan mềm mại, duy vải gấm không co giãn nên phần chân ngực hơi ôm nhẹ.',
    daysAgo: 8,
  },
  {
    slug: 'ao-dai-cach-tan-gam-lua',
    variantIdx: 1,
    sizePurchased: 'L',
    reviewerName: 'Phạm Lan Anh',
    heightCm: 167,
    weightKg: 59,
    rating: 5,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m67 · 59kg · Mặc size L — Lên ảnh cực kỳ quý phái, phom hơi nhỏ ở eo trên nên đặt nhích 1 size sẽ vừa vặn nhất.',
    daysAgo: 13,
  },
  {
    slug: 'ao-dai-cach-tan-gam-lua',
    variantIdx: 1,
    sizePurchased: 'M',
    reviewerName: 'Trần Thúy Quỳnh',
    heightCm: 161,
    weightKg: 50,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m61 · 50kg · Mặc size M — Chọn lên M theo gợi ý AI mặc vừa in từng đường chiết eo, rất hài lòng.',
    daysAgo: 21,
  },

  // 16. Đầm Midi Linen Phối Đai — 4 reviews: 3 TRUE_TO_SIZE (75%), 1 RUNS_SMALL (25%)
  {
    slug: 'dam-midi-linen-phoi-dai',
    variantIdx: 0,
    sizePurchased: 'S',
    reviewerName: 'Hoàng Ngọc Diệp',
    heightCm: 159,
    weightKg: 49,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m59 · 49kg · Mặc size S — Linen thoáng nhẹ, có đai rút eo linh hoạt nên mặc rất tôn dáng và thoải mái.',
    daysAgo: 4,
  },
  {
    slug: 'dam-midi-linen-phoi-dai',
    variantIdx: 0,
    sizePurchased: 'M',
    reviewerName: 'Vũ Thu Phương',
    heightCm: 164,
    weightKg: 54,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m64 · 54kg · Mặc size M — Chuẩn size, chiều dài midi thanh lịch đi làm hay du lịch resort đều đẹp.',
    daysAgo: 10,
  },
  {
    slug: 'dam-midi-linen-phoi-dai',
    variantIdx: 1,
    sizePurchased: 'M',
    reviewerName: 'Đặng Quỳnh Chi',
    heightCm: 165,
    weightKg: 56,
    rating: 4,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m65 · 56kg · Mặc size M — Vải linen nguyên chất không co giãn nên phần vai hơi khít nhẹ nếu cử động mạnh.',
    daysAgo: 16,
  },
  {
    slug: 'dam-midi-linen-phoi-dai',
    variantIdx: 1,
    sizePurchased: 'L',
    reviewerName: 'Nguyễn Thùy Trang',
    heightCm: 170,
    weightKg: 63,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m70 · 63kg · Mặc size L — Dáng chuẩn xưởng, lót trong mềm mát không bị mỏng.',
    daysAgo: 22,
  },

  // 17. Quần Ống Suông Wool Blend — 4 reviews: 3 TRUE_TO_SIZE (75%), 1 RUNS_LARGE (25%)
  {
    slug: 'quan-ong-suong-wool-blend',
    variantIdx: 0,
    sizePurchased: 'S',
    reviewerName: 'Lý Minh Châu',
    heightCm: 160,
    weightKg: 49,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m60 · 49kg · Mặc size S — Wool pha mịn rủ đứng ly, mặc chuẩn vòng eo và kéo dài chân rõ rệt.',
    daysAgo: 5,
  },
  {
    slug: 'quan-ong-suong-wool-blend',
    variantIdx: 0,
    sizePurchased: 'M',
    reviewerName: 'Phan Thanh Mai',
    heightCm: 165,
    weightKg: 55,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m65 · 55kg · Mặc size M — Chuẩn phom công sở cao cấp, ngồi cả ngày không bị nhăn gối.',
    daysAgo: 12,
  },
  {
    slug: 'quan-ong-suong-wool-blend',
    variantIdx: 1,
    sizePurchased: 'L',
    reviewerName: 'Đỗ Hải Yến',
    heightCm: 171,
    weightKg: 64,
    rating: 4,
    fitFeedback: FitFeedback.RUNS_LARGE,
    comment:
      '1m71 · 64kg · Mặc size L — Ống quần suông rộng rãi, phần eo hơi dư nhẹ khoảng 1cm.',
    daysAgo: 18,
  },
  {
    slug: 'quan-ong-suong-wool-blend',
    variantIdx: 1,
    sizePurchased: 'XL',
    reviewerName: 'Trần Hoàng Anh',
    heightCm: 174,
    weightKg: 69,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m74 · 69kg · Mặc size XL — Rất vừa hông và chiều dài chạm mu bàn chân đẹp.',
    daysAgo: 24,
  },

  // 18. Áo Khoác Tweed Nút Đồng — 4 reviews: 3 RUNS_SMALL (75%), 1 TRUE_TO_SIZE (25%)
  {
    slug: 'ao-khoac-tweed-nut-dong',
    variantIdx: 0,
    sizePurchased: 'S',
    reviewerName: 'Nguyễn Bảo Trân',
    heightCm: 158,
    weightKg: 48,
    rating: 5,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m58 · 48kg · Mặc size S — Vải tweed dệt nổi và nút đồng khắc thủ công cực sang, nhưng phom vai hơi ôm nếu mặc thêm áo len bên trong.',
    daysAgo: 3,
  },
  {
    slug: 'ao-khoac-tweed-nut-dong',
    variantIdx: 0,
    sizePurchased: 'M',
    reviewerName: 'Lê Diễm Quỳnh',
    heightCm: 163,
    weightKg: 53,
    rating: 4,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m63 · 53kg · Mặc size M — Áo dày dặn không co giãn nên hơi kích nhẹ ở bắp tay, khuyên tăng 1 size khi phối layer mùa đông.',
    daysAgo: 9,
  },
  {
    slug: 'ao-khoac-tweed-nut-dong',
    variantIdx: 1,
    sizePurchased: 'L',
    reviewerName: 'Vũ Thu Hà',
    heightCm: 168,
    weightKg: 60,
    rating: 5,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m68 · 60kg · Mặc size L — Dựng phom rất chuẩn couture, phần ngực cài khuy hơi gọn nên chọn nhích cỡ sẽ thoải mái hơn.',
    daysAgo: 15,
  },
  {
    slug: 'ao-khoac-tweed-nut-dong',
    variantIdx: 1,
    sizePurchased: 'XL',
    reviewerName: 'Phạm Quỳnh Nga',
    heightCm: 173,
    weightKg: 68,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m73 · 68kg · Mặc size XL — Mình mặc khoác ngoài áo cổ lọ cashmere rất vừa vai, cực kỳ ưng ý.',
    daysAgo: 21,
  },

  // 19. Chân Váy Lụa Vạt Chéo — 4 reviews: 2 RUNS_SMALL (50%), 2 TRUE_TO_SIZE (50%)
  {
    slug: 'chan-vay-lua-vat-cheo',
    variantIdx: 0,
    sizePurchased: 'S',
    reviewerName: 'Trần Khánh Ngọc',
    heightCm: 160,
    weightKg: 49,
    rating: 5,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m60 · 49kg · Mặc size S — Vạt chéo bay đẹp, nhưng cạp khóa lụa ôm sát vòng eo trên.',
    daysAgo: 4,
  },
  {
    slug: 'chan-vay-lua-vat-cheo',
    variantIdx: 0,
    sizePurchased: 'M',
    reviewerName: 'Nguyễn Minh Khuê',
    heightCm: 164,
    weightKg: 54,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m64 · 54kg · Mặc size M — Chuẩn size, độ rủ của lụa rất dịu mắt.',
    daysAgo: 11,
  },
  {
    slug: 'chan-vay-lua-vat-cheo',
    variantIdx: 1,
    sizePurchased: 'M',
    reviewerName: 'Lê Thảo Nguyên',
    heightCm: 166,
    weightKg: 56,
    rating: 4,
    fitFeedback: FitFeedback.RUNS_SMALL,
    comment:
      '1m66 · 56kg · Mặc size M — Phần hông hơi ôm nhẹ khi ngồi, ai hông đầy nên tăng lên L.',
    daysAgo: 17,
  },
  {
    slug: 'chan-vay-lua-vat-cheo',
    variantIdx: 1,
    sizePurchased: 'L',
    reviewerName: 'Hoàng Lan Chi',
    heightCm: 170,
    weightKg: 62,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m70 · 62kg · Mặc size L — Mặc tôn đường cong nhẹ nhàng, lót lụa bên trong êm da.',
    daysAgo: 25,
  },

  // 20. Trench Coat Kaki Cổ Điển — 4 reviews: 3 RUNS_LARGE (75%), 1 TRUE_TO_SIZE (25%)
  {
    slug: 'trench-coat-kaki-co-dien',
    variantIdx: 0,
    sizePurchased: 'S',
    reviewerName: 'Đặng Phương Linh',
    heightCm: 161,
    weightKg: 50,
    rating: 5,
    fitFeedback: FitFeedback.RUNS_LARGE,
    comment:
      '1m61 · 50kg · Mặc size S — Dáng trench phóng khoáng kiểu Paris nên hơi rộng vai nhẹ để khoác ngoài áo len dày.',
    daysAgo: 3,
  },
  {
    slug: 'trench-coat-kaki-co-dien',
    variantIdx: 0,
    sizePurchased: 'M',
    reviewerName: 'Nguyễn Hữu Minh',
    heightCm: 172,
    weightKg: 66,
    rating: 5,
    fitFeedback: FitFeedback.RUNS_LARGE,
    comment:
      '1m72 · 66kg · Mặc size M — Vải kaki dày trượt nước tốt, phom hơi rộng nên mặc M rất vừa mắt.',
    daysAgo: 9,
  },
  {
    slug: 'trench-coat-kaki-co-dien',
    variantIdx: 1,
    sizePurchased: 'L',
    reviewerName: 'Trần Anh Tuấn',
    heightCm: 176,
    weightKg: 72,
    rating: 5,
    fitFeedback: FitFeedback.RUNS_LARGE,
    comment:
      '1m76 · 72kg · Mặc size L — Form rộng rãi đúng tinh thần trench cổ điển, thắt đai eo vào cực lịch lãm.',
    daysAgo: 16,
  },
  {
    slug: 'trench-coat-kaki-co-dien',
    variantIdx: 1,
    sizePurchased: 'S',
    reviewerName: 'Bùi Ngọc Ánh',
    heightCm: 165,
    weightKg: 55,
    rating: 5,
    fitFeedback: FitFeedback.TRUE_TO_SIZE,
    comment:
      '1m65 · 55kg · Mặc size S — Lùi xuống S theo gợi ý cố vấn AI và mặc vừa vai chuẩn không cần chỉnh.',
    daysAgo: 23,
  },
];

interface SeedNotificationLogBlueprint {
  eventId: string;
  channel: NotificationChannelType;
  recipient: string;
  templateCode: string;
  status: string;
  retryCount: number;
  daysAgo: number;
}

const SEED_NOTIFICATION_LOGS: readonly SeedNotificationLogBlueprint[] = [
  {
    eventId: 'evt-order-confirmed-2026-0001',
    channel: NotificationChannel.EMAIL,
    recipient: 'minhanh.nguyen@atelier-demo.vn',
    templateCode: 'ORDER_CONFIRMED_VI',
    status: 'SENT',
    retryCount: 0,
    daysAgo: 4,
  },
  {
    eventId: 'evt-review-invite-2026-0002',
    channel: NotificationChannel.ZALO_ZNS,
    recipient: '+84901234567',
    templateCode: 'VERIFIED_FIT_REVIEW_INVITE_VI',
    status: 'DELIVERED',
    retryCount: 0,
    daysAgo: 3,
  },
  {
    eventId: 'evt-size-exchange-2026-0003',
    channel: NotificationChannel.SMS,
    recipient: '+84912345678',
    templateCode: 'RMA_SIZE_EXCHANGE_READY_VI',
    status: 'SENT',
    retryCount: 1,
    daysAgo: 1,
  },
];

export interface NotifySeedSummary {
  skipped: boolean;
  totalReviews: number;
  totalProductsCovered: number;
  notificationLogs: number;
}

export async function runNotifyReviewSeed(db: AtelierDbClient): Promise<NotifySeedSummary> {
  const existingReviewsRes = await db.query<{ count: string | number }>(
    'SELECT COUNT(*)::int AS count FROM product_reviews',
  );
  const existingReviews = Number(existingReviewsRes.rows[0]?.count ?? 0);

  // Non-destructive additive seed: ALWAYS check each deterministic seed ID via
  // INSERT ... WHERE NOT EXISTS + ON CONFLICT DO NOTHING so new Vietnamese reviews
  // are safely appended without ever modifying or deleting existing user reviews.
  let reviewsInserted = 0;
  const nowMs = Date.now();
  for (let idx = 0; idx < SEED_REVIEWS.length; idx += 1) {
    const item = SEED_REVIEWS[idx];
    const reviewId = notifyDeterministicUuid(`review:${item.slug}:${idx}`);
    const orderId = notifyDeterministicUuid(`order:${item.slug}:${idx}`);
    const orderItemId = notifyDeterministicUuid(`order-item:${item.slug}:${idx}`);
    const userId = notifyDeterministicUuid(`reviewer:${item.reviewerName}`);
    const productId = catalogDeterministicUuid(`product:${item.slug}`);
    const skuId = catalogDeterministicUuid(
      `sku:${item.slug}:${item.variantIdx}:${item.sizePurchased}`,
    );
    const sentimentScore = computeVietnameseSentimentScore(item.rating, item.comment);
    const sentimentLabel = deriveSentimentLabelFromScore(sentimentScore);
    const createdAt = new Date(nowMs - item.daysAgo * 24 * 60 * 60 * 1000).toISOString();

    const ins = await db.query<{ id: string }>(
      `INSERT INTO product_reviews (
         id, order_id, order_item_id, product_id, sku_id, user_id,
         reviewer_name, rating, fit_feedback, reviewer_height_cm,
         reviewer_weight_kg, size_purchased, comment, photo_urls_jsonb,
         sentiment_score, sentiment_label, moderation_status, created_at
       )
       SELECT
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         $7, $8, $9, $10,
         $11, $12, $13, $14::jsonb,
         $15, $16, $17, $18
       WHERE NOT EXISTS (
         SELECT 1 FROM product_reviews WHERE id = $1::uuid OR order_item_id = $3::uuid
       )
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        reviewId,
        orderId,
        orderItemId,
        productId,
        skuId,
        userId,
        item.reviewerName,
        item.rating,
        item.fitFeedback,
        item.heightCm,
        item.weightKg,
        item.sizePurchased,
        item.comment,
        JSON.stringify([]),
        sentimentScore,
        sentimentLabel,
        ReviewModerationStatus.APPROVED,
        createdAt,
      ],
    );
    if (ins.rows.length > 0) {
      reviewsInserted += 1;
    }
  }

  const existingLogsRes = await db.query<{ count: string | number }>(
    'SELECT COUNT(*)::int AS count FROM notification_logs',
  );
  const existingLogs = Number(existingLogsRes.rows[0]?.count ?? 0);

  if (existingLogs === 0) {
    const nowMs = Date.now();
    for (let idx = 0; idx < SEED_NOTIFICATION_LOGS.length; idx += 1) {
      const log = SEED_NOTIFICATION_LOGS[idx];
      const logId = notifyDeterministicUuid(`notif-log:${log.eventId}:${log.channel}`);
      const sentAt = new Date(nowMs - log.daysAgo * 24 * 60 * 60 * 1000).toISOString();

      await db.query(
        `INSERT INTO notification_logs (
           id, event_id, channel, recipient, template_code, status, retry_count, sent_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8
         )
         ON CONFLICT (event_id, channel) DO NOTHING`,
        [
          logId,
          log.eventId,
          log.channel,
          log.recipient,
          log.templateCode,
          log.status,
          log.retryCount,
          sentAt,
        ],
      );
    }
  }

  const finalCountsRes = await db.query<{
    reviews: string | number;
    products: string | number;
  }>(
    `SELECT
       COUNT(*)::int AS reviews,
       COUNT(DISTINCT product_id)::int AS products
     FROM product_reviews`,
  );
  const finalLogsRes = await db.query<{ count: string | number }>(
    'SELECT COUNT(*)::int AS count FROM notification_logs',
  );

  return {
    skipped: existingReviews > 0 && reviewsInserted === 0,
    totalReviews: Number(finalCountsRes.rows[0]?.reviews ?? 0),
    totalProductsCovered: Number(finalCountsRes.rows[0]?.products ?? 0),
    notificationLogs: Number(finalLogsRes.rows[0]?.count ?? 0),
  };
}
