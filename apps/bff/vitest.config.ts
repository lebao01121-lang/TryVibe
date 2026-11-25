import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'src/security/guards.ts',
        'src/security/auth-types.ts',
        'src/security/jwt-verifier.service.ts',
        'src/common/http-proxy.service.ts',
        'src/common/sanitize.ts',
      ],
      exclude: ['src/**/*.spec.ts', 'src/**/*.d.ts'],
    },
  },
});
