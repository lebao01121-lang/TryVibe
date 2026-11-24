import type { ReactNode } from 'react';
import { CustomerFooter } from '@/components/CustomerFooter';

export interface InnerPageFrameProps {
  children: ReactNode;
}

export function InnerPageFrame({ children }: InnerPageFrameProps) {
  return (
    <div
      data-nav-theme="light"
      className="flex min-h-screen flex-col bg-[#FBF7EF] pt-24 text-[#2B2019]"
    >
      <div className="flex-1">{children}</div>
      <CustomerFooter />
    </div>
  );
}
