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
        'src/services/order-rma.service.ts',
        'src/shipping/ghn.adapter.ts',
        'src/shipping/ghtk.adapter.ts',
        'src/shipping/ahamove.adapter.ts',
        'src/shipping/vn-location.helper.ts',
        'src/shipping/shipping-provider.registry.ts',
      ],
      exclude: ['src/**/*.spec.ts', 'src/**/*.d.ts'],
    },
  },
});
