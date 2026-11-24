import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  images: {
    unoptimized: true,
  },
  transpilePackages: ['@atelier/contracts', '@atelier/ui-tokens'],
  webpack: (config) => {
    const existing = config.watchOptions?.ignored;
    const ignoredList = Array.isArray(existing)
      ? existing.filter((item: unknown): item is string => typeof item === 'string' && item.length > 0)
      : typeof existing === 'string' && existing.length > 0
        ? [existing]
        : ['**/node_modules/**', '**/.git/**', '**/.next/**'];
    config.watchOptions = {
      ...config.watchOptions,
      ignored: Array.from(new Set([...ignoredList, '**/.project-data/**'])),
    };
    return config;
  },
};

export default nextConfig;
