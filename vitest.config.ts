import { defineConfig } from 'vitest/config';
import { workspaceProjects } from './vitest.workspace';

export default defineConfig({
  test: {
    projects: workspaceProjects,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.next/**',
        '**/*.spec.ts',
        '**/*.test.ts',
        '**/*.d.ts',
        '**/vitest.config.ts',
      ],
    },
  },
});
