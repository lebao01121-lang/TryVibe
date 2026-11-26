import type { NextConfig } from 'next';

// Enable Next.js standalone runtime bundle for Docker/Linux/CI builds (and Windows with Developer Mode via NEXT_OUTPUT_STANDALONE=1).
// Prevents Next.js 15 copyTracedFiles EPERM on Windows hosts without SeCreateSymbolicLinkPrivilege for pnpm symlinks.
const useStandaloneOutput =
  process.env.NEXT_OUTPUT_STANDALONE === '1' ||
  process.env.NEXT_OUTPUT_STANDALONE === 'true' ||
  process.env.DOCKER_BUILD === '1' ||
  process.platform !== 'win32';

const nextConfig: NextConfig = {
  ...(useStandaloneOutput ? { output: 'standalone' as const } : {}),
  reactStrictMode: true,
  images: {
    unoptimized: true,
  },
  transpilePackages: ['@atelier/contracts', '@atelier/ui-tokens', '@atelier/motion-kit'],
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
