import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

const config = [
  // Global ignores
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '*.d.ts',
      'examples/**',
      // Compiled worker bundle — build artifact, not source
      'src/infrastructure/browser/thread-worker.mjs',
    ],
  },
  // JavaScript recommended rules
  js.configs.recommended,
  // JavaScript/MJS files (worker scripts, etc.)
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  // TypeScript recommended rules
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser, // No need for unknown as Linter.Parser cast in JS
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        NodeJS: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        crypto: 'readonly',
        AbortSignal: 'readonly',
        AbortController: 'readonly',
        Request: 'readonly',
        RequestInit: 'readonly',
        Response: 'readonly',
        FormData: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        ArrayBuffer: 'readonly',
        ReadableStream: 'readonly',
        Blob: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      // Override specific rules
      'no-console': 'off', // Allow console.log for debugging
      'no-unused-vars': 'off', // Disable in favor of TypeScript version
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
];

export default config;
