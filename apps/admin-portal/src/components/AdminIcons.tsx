'use client';

import type { SVGProps } from 'react';
import type { AdminTabKey } from '@/lib/admin-navigation';

export interface AdminIconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

function baseProps(size: number, className?: string): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    className,
  };
}

export function RefreshIcon({
  size = 16,
  className,
  ...rest
}: AdminIconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

export function BellIcon({ size = 16, className, ...rest }: AdminIconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

export function SparklesIcon({
  size = 16,
  className,
  ...rest
}: AdminIconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="M12 3l1.9 4.9L19 10l-5.1 2.1L12 17l-1.9-4.9L5 10l5.1-2.1L12 3z" />
      <path d="M19 3v3" />
      <path d="M20.5 4.5h-3" />
      <path d="M5 17v3" />
      <path d="M6.5 18.5h-3" />
    </svg>
  );
}

export function ChevronLeftIcon({
  size = 16,
  className,
  ...rest
}: AdminIconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

export function ChevronRightIcon({
  size = 16,
  className,
  ...rest
}: AdminIconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

export function SunIcon({ size = 16, className, ...rest }: AdminIconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}

export function MoonIcon({ size = 16, className, ...rest }: AdminIconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />
    </svg>
  );
}

export function ExternalLinkIcon({
  size = 16,
  className,
  ...rest
}: AdminIconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

export function CheckCircleIcon({
  size = 16,
  className,
  ...rest
}: AdminIconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <circle cx="12" cy="12" r="9.5" />
      <path d="m8.5 12.2 2.4 2.4 4.8-5.1" />
    </svg>
  );
}

export function AlertTriangleIcon({
  size = 16,
  className,
  ...rest
}: AdminIconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="m10.29 3.86-8.4 14.5A2 2 0 0 0 3.6 21h16.8a2 2 0 0 0 1.71-2.64l-8.4-14.5a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

export function BoxIcon({ size = 16, className, ...rest }: AdminIconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </svg>
  );
}

export function DownloadIcon({
  size = 16,
  className,
  ...rest
}: AdminIconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}

export function SearchIcon({ size = 16, className, ...rest }: AdminIconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <circle cx="11" cy="11" r="7.5" />
      <path d="m20 20-3.8-3.8" />
    </svg>
  );
}

export function SlidersIcon({
  size = 16,
  className,
  ...rest
}: AdminIconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <line x1="4" x2="4" y1="21" y2="14" />
      <line x1="4" x2="4" y1="10" y2="3" />
      <line x1="12" x2="12" y1="21" y2="12" />
      <line x1="12" x2="12" y1="8" y2="3" />
      <line x1="20" x2="20" y1="21" y2="16" />
      <line x1="20" x2="20" y1="12" y2="3" />
      <line x1="2" x2="6" y1="14" y2="14" />
      <line x1="10" x2="14" y1="8" y2="8" />
      <line x1="18" x2="22" y1="16" y2="16" />
    </svg>
  );
}

export function MenuIcon({ size = 16, className, ...rest }: AdminIconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <line x1="4" x2="20" y1="6" y2="6" />
      <line x1="4" x2="20" y1="12" y2="12" />
      <line x1="4" x2="20" y1="18" y2="18" />
    </svg>
  );
}

export function ChevronDownIcon({
  size = 16,
  className,
  ...rest
}: AdminIconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function PrinterIcon({
  size = 16,
  className,
  ...rest
}: AdminIconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6" />
      <rect x="6" y="14" width="12" height="8" rx="1" />
    </svg>
  );
}

export function ShieldLockIcon({
  size = 16,
  className,
  ...rest
}: AdminIconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
      <rect width="6" height="5" x="9" y="11" rx="1" />
      <path d="M10.5 11V9.5a1.5 1.5 0 0 1 3 0V11" />
    </svg>
  );
}

export function BotIcon({ size = 16, className, ...rest }: AdminIconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2.5" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M9.5 13.5v1.5" />
      <path d="M14.5 13.5v1.5" />
    </svg>
  );
}

export interface AdminNavIconProps extends AdminIconProps {
  tab: AdminTabKey;
}

export function AdminNavIcon({
  tab,
  size = 17,
  className,
  ...rest
}: AdminNavIconProps) {
  const props = baseProps(size, className);

  switch (tab) {
    case 'dashboard':
      return (
        <svg {...props} {...rest}>
          <rect width="7" height="7" x="3" y="3" rx="1.5" />
          <rect width="7" height="7" x="14" y="3" rx="1.5" />
          <rect width="7" height="7" x="14" y="14" rx="1.5" />
          <rect width="7" height="7" x="3" y="14" rx="1.5" />
        </svg>
      );

    case 'orders':
      return (
        <svg {...props} {...rest}>
          <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" />
          <path d="M3 6h18" />
          <path d="M16 10a4 4 0 0 1-8 0" />
        </svg>
      );

    case 'payments':
      return (
        <svg {...props} {...rest}>
          <rect width="20" height="14" x="2" y="5" rx="2" />
          <line x1="2" x2="22" y1="10" y2="10" />
          <path d="M6 15h4" />
          <path d="M14 15h4" />
        </svg>
      );

    case 'inventory':
      return (
        <svg {...props} {...rest}>
          <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
          <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
          <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
        </svg>
      );

    case 'procurement':
      return (
        <svg {...props} {...rest}>
          <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
          <path d="M15 18H9" />
          <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
          <circle cx="17" cy="18" r="2" />
          <circle cx="7" cy="18" r="2" />
        </svg>
      );

    case 'catalog':
      return (
        <svg {...props} {...rest}>
          <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
          <circle cx="7.5" cy="7.5" r="1.25" fill="currentColor" stroke="none" />
        </svg>
      );

    case 'categories':
      return (
        <svg {...props} {...rest}>
          <path d="M4 5h6v5H4z" />
          <path d="M14 5h6v5h-6z" />
          <path d="M14 14h6v5h-6z" />
          <path d="M7 10v6.5A1.5 1.5 0 0 0 8.5 18H14" />
        </svg>
      );

    case 'promotions':
      return (
        <svg {...props} {...rest}>
          <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
          <path d="m9 15 6-6" />
          <circle cx="9.5" cy="9.5" r="0.8" fill="currentColor" stroke="none" />
          <circle cx="14.5" cy="14.5" r="0.8" fill="currentColor" stroke="none" />
        </svg>
      );

    case 'media':
      return (
        <svg {...props} {...rest}>
          <rect width="18" height="18" x="3" y="3" rx="2.5" />
          <circle cx="9" cy="9" r="2" />
          <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
        </svg>
      );

    case 'campaign':
      return (
        <svg {...props} {...rest}>
          <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" />
          <path d="M8 7h8" />
          <path d="M8 11h6" />
        </svg>
      );

    case 'customers':
      return (
        <svg {...props} {...rest}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );

    case 'iam':
      return (
        <svg {...props} {...rest}>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );

    case 'lookbook':
      return (
        <svg {...props} {...rest}>
          <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
          <circle cx="12" cy="13" r="3.2" />
        </svg>
      );

    case 'tryon-hub':
      return (
        <svg {...props} {...rest}>
          <path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23Z" />
        </svg>
      );

    case 'rag-kb':
      return (
        <svg {...props} {...rest}>
          <path d="M2 6a2 2 0 0 1 2-2h5a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4a2 2 0 0 1-2-2Z" />
          <path d="M22 6a2 2 0 0 0-2-2h-5a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h6a2 2 0 0 0 2-2Z" />
          <path d="M6 8h2" />
          <path d="M16 8h2" />
          <path d="M6 12h2" />
          <path d="M16 12h2" />
        </svg>
      );

    case 'ops':
      return (
        <svg {...props} {...rest}>
          <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
        </svg>
      );

    case 'reports':
      return (
        <svg {...props} {...rest}>
          <path d="M3 3v18h18" />
          <path d="M7 15v-4" />
          <path d="M12 15V8" />
          <path d="M17 15v-7" />
        </svg>
      );

    default:
      return <BoxIcon size={size} className={className} {...rest} />;
  }
}
