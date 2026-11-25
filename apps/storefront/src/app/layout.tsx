import type { Metadata } from 'next';
import {
  Be_Vietnam_Pro,
  Cormorant_Garamond,
  Dancing_Script,
} from 'next/font/google';
import type { ReactNode } from 'react';
import { AtelierToastProvider } from '@/components/AtelierToastProvider';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { StorefrontShellOverlays } from '@/components/layout/StorefrontShellOverlays';
import { CustomCursor } from '@/components/motion/CustomCursor';
import { FabricParticleCanvas } from '@/components/motion/FabricParticleCanvas';
import { GlintsCanvas } from '@/components/motion/GlintsCanvas';
import { LookbookAutoTour } from '@/components/motion/LookbookAutoTour';
import { SmoothScrollProvider } from '@/components/motion/SmoothScrollProvider';
import { AdaptivePerformanceProvider } from '@/lib/performance/AdaptivePerformanceProvider';
import './globals.css';

const cormorant = Cormorant_Garamond({
  subsets: ['latin', 'vietnamese'],
  weight: ['300', '400', '500', '600'],
  style: ['normal', 'italic'],
  variable: '--font-cormorant',
  display: 'swap',
  fallback: ['Georgia', 'Times New Roman', 'serif'],
});

const beVietnamPro = Be_Vietnam_Pro({
  subsets: ['latin', 'vietnamese'],
  weight: ['300', '400', '500'],
  variable: '--font-be-vietnam-pro',
  display: 'swap',
  fallback: ['system-ui', '-apple-system', 'sans-serif'],
});

const dancingScript = Dancing_Script({
  subsets: ['latin', 'vietnamese'],
  weight: ['500', '600'],
  variable: '--font-dancing-script',
  display: 'swap',
  fallback: ['cursive', 'serif'],
});

export const metadata: Metadata = {
  title: 'TryVibe · Fashion Atelier — Thời Trang May Đo Thủ Công',
  description:
    'Nhà mốt thời trang Editorial Quiet Luxury: giá treo 3D, phối đồ Mix & Match Studio, sợi chỉ vàng xưởng may và phòng thử đồ AI riêng tư.',
  openGraph: {
    siteName: 'TryVibe Fashion Atelier',
  },
};

interface RootLayoutProps {
  children: ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html
      lang="vi"
      className={`${cormorant.variable} ${beVietnamPro.variable} ${dancingScript.variable}`}
    >
      <body className="min-h-[100svh] bg-[#FBF7EF] text-[#2B2019]">
        <AdaptivePerformanceProvider>
          <SmoothScrollProvider>
            <CustomCursor />
            <GlintsCanvas />
            <FabricParticleCanvas />
            <SiteHeader />
            <LookbookAutoTour />
            <main>{children}</main>
            <StorefrontShellOverlays />
            <AtelierToastProvider />
          </SmoothScrollProvider>
        </AdaptivePerformanceProvider>
      </body>
    </html>
  );
}
