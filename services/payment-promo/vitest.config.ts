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
        'src/payments/payment-helpers.ts',
        'src/payments/adapters/vnpay.adapter.ts',
        'src/payments/adapters/momo.adapter.ts',
        'src/payments/adapters/payos.adapter.ts',
        'src/payments/adapters/sepay-banks.ts',
        'src/payments/adapters/sepay.adapter.ts',
        'src/payments/payments.service.ts',
        'src/promotions/promotions.service.ts',
      ],
      exclude: ['src/**/*.spec.ts', 'src/**/*.d.ts'],
    },
  },
});
