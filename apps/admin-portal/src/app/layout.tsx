import type { Metadata } from 'next';
import {
  Be_Vietnam_Pro,
  Cormorant_Garamond,
  Dancing_Script,
} from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const cormorant = Cormorant_Garamond({
  subsets: ['latin', 'vietnamese'],
  weight: ['300', '400', '500', '600', '700'],
  style: ['normal', 'italic'],
  variable: '--font-cormorant',
  display: 'swap',
  fallback: ['Georgia', 'Times New Roman', 'serif'],
});

const beVietnamPro = Be_Vietnam_Pro({
  subsets: ['latin', 'vietnamese'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-be-vietnam-pro',
  display: 'swap',
  fallback: ['system-ui', '-apple-system', 'sans-serif'],
});

const dancingScript = Dancing_Script({
  subsets: ['latin', 'vietnamese'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-dancing-script',
  display: 'swap',
  fallback: ['cursive', 'serif'],
});

export const metadata: Metadata = {
  title: 'Sổ Cái Điều Hành · Tầm Xuân Admin Portal',
  description:
    'Cổng quản trị nội bộ tách biệt vật lý (ADMIN_PORTAL :3001) với bảo vệ RBAC, xác thực 2FA TOTP và Trợ lý MCP Copilot Human-in-the-Loop.',
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
      <body className="min-h-screen bg-[#FBF7EF] text-[#2B2019]">
        {children}
      </body>
    </html>
  );
}
