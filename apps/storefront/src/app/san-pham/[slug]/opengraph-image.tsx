import { ImageResponse } from 'next/og';
import { fetchPdpCompositeBySlug } from '@/lib/bootstrap';
import { FORMAT_VND } from '@/lib/catalog-data';

export const runtime = 'nodejs';
export const alt = 'Tầm Xuân · Fashion Atelier';
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = 'image/png';

interface OpenGraphImageProps {
  params: Promise<{ slug: string }>;
}

export default async function OpenGraphImage({ params }: OpenGraphImageProps) {
  const { slug } = await params;

  let productName = 'Thiết Kế May Đo Thủ Công';
  let fabricLine = 'Lụa tơ tằm Bảo Lộc · Linen hữu cơ cao cấp';
  let priceText = 'Tầm Xuân Atelier';
  let categoryText = 'BỘ SƯU TẬP ATELIER';

  try {
    const composite = await fetchPdpCompositeBySlug(slug);
    if (composite?.product) {
      productName = composite.product.name;
      fabricLine =
        composite.product.subtitle || composite.product.fabricComposition;
      priceText = FORMAT_VND(composite.product.minPriceVnd);
      categoryText = composite.product.categoryName.toUpperCase();
    }
  } catch {
    // Keep clean editorial fallback text if BFF is unreachable
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          backgroundColor: '#FBF7EF',
          color: '#1C1410',
          padding: '48px 56px',
          border: '14px solid #B08A4A',
          fontFamily: 'serif',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderBottom: '2px solid rgba(176, 138, 74, 0.35)',
            paddingBottom: '20px',
          }}
        >
          <span
            style={{
              fontSize: '20px',
              letterSpacing: '6px',
              color: '#8A672C',
              fontFamily: 'sans-serif',
            }}
          >
            {categoryText}
          </span>
          <span
            style={{
              fontSize: '22px',
              color: '#1C1410',
              letterSpacing: '2px',
            }}
          >
            Tầm Xuân · Fashion Atelier
          </span>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '18px',
            marginTop: '16px',
            marginBottom: '16px',
          }}
        >
          <div
            style={{
              fontSize: '64px',
              lineHeight: 1.08,
              color: '#1C1410',
              fontWeight: 500,
              display: 'flex',
            }}
          >
            {productName}
          </div>
          <div
            style={{
              fontSize: '26px',
              color: '#5C4B41',
              fontFamily: 'sans-serif',
              display: 'flex',
            }}
          >
            {fabricLine}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            borderTop: '2px solid rgba(176, 138, 74, 0.35)',
            paddingTop: '22px',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
            }}
          >
            <span
              style={{
                fontSize: '16px',
                letterSpacing: '4px',
                color: '#8A672C',
                fontFamily: 'sans-serif',
              }}
            >
              GIÁ NIÊM YẾT
            </span>
            <span
              style={{
                fontSize: '46px',
                color: '#8A672C',
                fontWeight: 600,
              }}
            >
              {priceText}
            </span>
          </div>

          <div
            style={{
              display: 'flex',
              backgroundColor: '#1C1410',
              color: '#EBCF8F',
              padding: '14px 28px',
              borderRadius: '999px',
              fontSize: '18px',
              letterSpacing: '3px',
              fontFamily: 'sans-serif',
            }}
          >
            MAY ĐO THỦ CÔNG · THỬ ĐỒ AI
          </div>
        </div>
      </div>
    ),
    {
      ...size,
    },
  );
}
