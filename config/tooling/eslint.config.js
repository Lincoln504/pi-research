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
      // Compiled worker bundles — build artifacts, not source. Both listed
      // explicitly: the files only exist after prepare/build, and flat-config
      // globs would otherwise make lint coverage cache-state-dependent.
      'src/infrastructure/browser/thread-worker.mjs',
      'src/web-research/pdf-extract-worker.mjs',
    ],
  },
  // JavaScript recommended rules
  js.configs.recommended,
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
      // @typescript-eslint recommended ruleset (merged in flat-config style),
      // then the project overrides below.
      ...tseslint.configs.recommended.rules,
      // Override specific rules
      //
      // no-explicit-any is WARN, not off: 333 sites across 70 files (measured
      // 2026-10-26). Each is a boundary type (camoufox/Playwright JSON, LLM
      // responses) that needs a deliberate shape decision, so it is a tracked
      // warning — every lint run surfaces it — not a silenced rule. A full
      // any → unknown + narrowing pass is its own project; it must not ride
      // on a security release.
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off', // Allow console.log for debugging
      'no-unused-vars': 'off', // Disable in favor of TypeScript version
      'no-redeclare': 'off', // TypeBox uses const+type with same name (standard pattern)
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
  // Node environment for scripts and mjs files
  {
    files: ['scripts/**/*.cjs', 'scripts/**/*.ts', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        document: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': 'off',
    },
  },
];

export default config;
