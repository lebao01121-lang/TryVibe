import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const NEXT_APP_FILES = [
  'apps/storefront/src/**/*.{ts,tsx}',
  'apps/admin-portal/src/**/*.{ts,tsx}',
  'apps/partner-portal/src/**/*.{ts,tsx}',
  'packages/motion-kit/src/**/*.{ts,tsx}',
];

const NODE_FILES = [
  'apps/bff/**/*.{ts,tsx,js,mjs,cjs}',
  'apps/mcp-copilot/**/*.{ts,tsx,js,mjs,cjs}',
  'apps/storefront/*.{ts,js,mjs,cjs}',
  'apps/admin-portal/*.{ts,js,mjs,cjs}',
  'apps/partner-portal/*.{ts,js,mjs,cjs}',
  'services/**/*.{ts,tsx,js,mjs,cjs}',
  'packages/**/*.{ts,tsx,js,mjs,cjs}',
  'scripts/**/*.{ts,js,mjs,cjs}',
  'infra/**/*.{ts,js,mjs,cjs}',
  '*.{ts,js,mjs,cjs}',
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/public/models/**',
      '.project-data/**',
      '.local-pgdata/**',
      '.local-minio/**',
      '.secrets/**',
      'artifacts/**',
      'services/ai-tryon/**',
      'tests/load-k6/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,

  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-constant-condition': 'error',
      'no-empty': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.{ts,tsx}'],
  })),

  {
    files: NODE_FILES,
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      'no-constant-condition': 'error',
      'no-empty': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  {
    files: NEXT_APP_FILES,
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/no-unknown-property': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  eslintConfigPrettier,
);
