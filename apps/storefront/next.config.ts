import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_BUILD_CHECK === '1' ? '.next-check' : '.next',
  allowedDevOrigins: [
    '127.0.0.1',
    'localhost',
    '127.0.0.1:3000',
    'localhost:3000',
  ],
  images: {
    unoptimized: true,
    remotePatterns: [
      { protocol: 'http', hostname: 'localhost', port: '3000', pathname: '/**' },
      { protocol: 'http', hostname: '127.0.0.1', port: '3000', pathname: '/**' },
      { protocol: 'http', hostname: 'localhost', port: '4000', pathname: '/**' },
      { protocol: 'http', hostname: '127.0.0.1', port: '4000', pathname: '/**' },
      { protocol: 'http', hostname: 'localhost', port: '9000', pathname: '/**' },
      { protocol: 'http', hostname: '127.0.0.1', port: '9000', pathname: '/**' },
      { protocol: 'https', hostname: 'images.unsplash.com', pathname: '/**' },
      { protocol: 'https', hostname: 'images.pexels.com', pathname: '/**' },
      { protocol: 'https', hostname: 'upload.wikimedia.org', pathname: '/**' },
    ],
  },
  async rewrites() {
    const bffOrigin = (
      process.env.BFF_INTERNAL_URL ||
      'http://127.0.0.1:4000'
    ).replace(/\/+$/, '');
    return [
      {
        source: '/bff/:path*',
        destination: `${bffOrigin}/bff/:path*`,
      },
      {
        source: '/socket.io/:path*',
        destination: `${bffOrigin}/socket.io/:path*`,
      },
    ];
  },
  transpilePackages: [
    '@atelier/contracts',
    '@atelier/ui-tokens',
    '@atelier/motion-kit',
  ],
  webpack: (config) => {
    const existing = config.watchOptions?.ignored;
    const ignoredList = Array.isArray(existing)
      ? existing.filter((item: unknown): item is string => typeof item === 'string' && item.length > 0)
      : typeof existing === 'string' && existing.length > 0
        ? [existing]
        : ['**/node_modules/**', '**/.git/**', '**/.next/**'];
    config.watchOptions = {
      ...config.watchOptions,
      ignored: Array.from(
        new Set([...ignoredList, '**/.next-check/**', '**/.project-data/**']),
      ),
    };
    return config;
  },
};

export default nextConfig;
