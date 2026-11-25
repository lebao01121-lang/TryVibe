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
        'src/layer1-models/circuit-breaker.ts',
        'src/layer3-rag/hybrid-rag.ts',
        'src/layer5-authz/authz.ts',
        'src/layer6-guardrails/guardrails.ts',
        'src/harness.ts',
      ],
      exclude: ['src/**/*.spec.ts', 'src/**/*.d.ts'],
    },
  },
});
