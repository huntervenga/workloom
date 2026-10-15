import { builtinModules } from 'node:module';

import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const sourceGlob = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}';

// Browser-delivered code: the SPA, shared UI and the DTO package bundled into it.
// scripts/check-boundaries.mjs enforces the same rule for dynamic imports and manifests.
const browserSources = ['apps/web/src', 'packages/ui/src', 'packages/contracts/src'].map(
  (dir) => `${dir}/${sourceGlob}`,
);

const serverOnlyPackages = [
  '@workloom/api',
  '@workloom/worker',
  '@workloom/db',
  '@workloom/domain',
  'fastify',
  'drizzle-orm',
  'drizzle-kit',
  'pg',
  'postgres',
  'pg-boss',
  'dotenv',
];

const nodeBuiltins = builtinModules.filter((name) => !name.startsWith('_') && !name.startsWith('node:'));

const boundaryMessage =
  'Browser code must not import Node.js built-ins or api/worker/db/domain code. Share types through @workloom/contracts.';

export default defineConfig(
  globalIgnores([
    '**/node_modules/',
    '**/dist/',
    '**/coverage/',
    'playwright-report/',
    'test-results/',
    'blob-report/',
  ]),
  {
    // Rules are fixed here; eslint-disable comments are reported instead of honoured.
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
  },
  js.configs.recommended,
  tseslint.configs.strict,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Root tooling scripts run on Node.
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: browserSources,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: nodeBuiltins.map((name) => ({ name, message: boundaryMessage })),
          patterns: [
            { group: ['node:*'], message: boundaryMessage },
            { group: serverOnlyPackages.flatMap((name) => [name, `${name}/*`]), message: boundaryMessage },
            {
              group: ['**/apps/api/**', '**/apps/worker/**', '**/packages/db/**', '**/packages/domain/**'],
              message: boundaryMessage,
            },
          ],
        },
      ],
    },
  },
);
