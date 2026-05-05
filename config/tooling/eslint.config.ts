import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import type { ESLint, Linter } from 'eslint';

const config: ESLint.ConfigArray = [
  // Global ignores
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '*.d.ts',
      'examples/**',
    ],
  },
  // JavaScript recommended rules
  js.configs.recommended,
  // TypeScript recommended rules
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser as unknown as Linter.Parser, // Cast to unknown as Linter.Parser for compatibility
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
