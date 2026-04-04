# pi-research Full Testability Plan

## Executive Summary

This document outlines every step required to transform pi-research into a fully testable codebase. The plan focuses on:
1. Setting up modern test infrastructure with Vitest
2. Using test containers for integration tests (minimal mocking)
3. Extracting interfaces and applying dependency injection
4. Refactoring complex orchestration logic
5. Organizing tests for maintainability

---

## Phase 0: Test Infrastructure Setup (Day 1)

### 0.1 Install and Configure Vitest

**Dependencies to Add:**
```json
{
  "devDependencies": {
    "vitest": "^3.0.0",
    "@vitest/ui": "^3.0.0",
    "@vitest/coverage-v8": "^3.0.0",
    "testcontainers": "^10.0.0"
  }
}
```

**Create `vitest.config.ts`:**
```typescript
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.spec.ts'],
    exclude: ['node_modules', 'dist', '.tmp'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/types.ts',
        '**/index.ts',
      ],
    },
    testTimeout: 60000, // 60s for integration tests
    hookTimeout: 30000,
    teardownTimeout: 10000,
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false,
        minThreads: 1,
        maxThreads: 4,
      },
    },
    // Split unit and integration tests
    includeSource: ['src/**/*.ts'],
    // Separate suites for unit vs integration
    setupFiles: ['./test/setup/unit.ts', './test/setup/integration.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@test': path.resolve(__dirname, './test'),
    },
  },
});
```

### 0.2 Update package.json Scripts

```json
{
  "scripts": {
    "test": "vitest run",
    "test:unit": "vitest run --config vitest.config.unit.ts",
    "test:integration": "vitest run --config vitest.config.integration.ts",
    "test:watch": "vitest",
    "test:watch:unit": "vitest --config vitest.config.unit.ts",
    "test:coverage": "vitest run --coverage",
    "test:ui": "vitest --ui",
    "test:debug": "vitest --inspect-brk"
  }
}
```

### 0.3 Create Test Directory Structure

```
test/
├── setup/
│   ├── unit.ts              # Unit test setup (no containers)
│   ├── integration.ts      # Integration test setup (containers)
│   ├── mocks.ts            # Mock factories (minimal use)
│   └── fixtures.ts         # Test fixtures
├── unit/
│   ├── config/
│   ├── utils/
│   ├── stackexchange/
│   ├── security/
│   └── tui/
├── integration/
│   ├── web-research/
│   ├── security/
│   ├── stackexchange/
│   └── infrastructure/
├── e2e/
│   └── orchestration/
├── helpers/
│   ├── test-containers.ts  # Test container helpers
│   ├── assertions.ts       # Custom assertions
│   └── matchers.ts         # Custom matchers
└── types/
    └── vitest.d.ts         # Global test types
```

### 0.4 Create Vitest Config Variants

**`vitest.config.unit.ts`:**
```typescript
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['test/unit/**/*.test.ts'],
    setupFiles: ['./test/setup/unit.ts'],
    pool: 'threads',
    testTimeout: 10000, // 10s for unit tests
  },
});
```

**`vitest.config.integration.ts`:**
```typescript
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['test/integration/**/*.test.ts'],
    setupFiles: ['./test/setup/integration.ts'],
    pool: 'threads',
    testTimeout: 120000, // 2min for integration tests
    maxConcurrency: 2, // Limit concurrent integration tests
  },
});
```

### 0.5 Create Test Setup Files

**`test/setup/unit.ts`:**
```typescript
import { beforeAll, afterEach, vi } from 'vitest';
import { resetModuleRegistry } from '../helpers/module-registry';

// Reset all module-level state before each test
afterEach(() => {
  resetModuleRegistry();
  vi.clearAllMocks();
});

// Suppress console output in tests unless explicitly enabled
beforeAll(() => {
  if (!process.env['VITEST_VERBOSE']) {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  }
});
```

**`test/setup/integration.ts`:**
```typescript
import { beforeAll, afterAll } from 'vitest';
import { cleanupTestContainers } from '../helpers/test-containers';

// Cleanup test containers after all tests
afterAll(async () => {
  await cleanupTestContainers();
}, 30000);
```

### 0.6 Create Module Registry Helper

**`test/helpers/module-registry.ts`:**
```typescript
/**
 * Module Registry for Resetting Module-Level State
 *
 * This tracks all modules with singleton state that need resetting.
 * Each test suite registers its modules, and afterEach resets them.
 */

type ModuleResetter = () => void | Promise<void>;

const resetters: Map<string, ModuleResetter> = new Map();

export function registerModuleResetter(
  name: string,
  resetter: ModuleResetter
): void {
  resetters.set(name, resetter);
}

export async function resetModuleRegistry(): Promise<void> {
  for (const [name, resetter] of resetters.entries()) {
    try {
      await resetter();
    } catch (error) {
      console.error(`Failed to reset module ${name}:`, error);
    }
  }
}

export function unregisterModule(name: string): void {
  resetters.delete(name);
}
```

### 0.7 Create Test Container Helpers

**`test/helpers/test-containers.ts`:**
```typescript
import { GenericContainer, StartedTestContainer } from 'testcontainers';

const containers = new Map<string, StartedTestContainer>();

export async function startSearxngContainer(): Promise<StartedTestContainer> {
  const container = await new GenericContainer('searxng/searxng')
    .withExposedPorts(8080)
    .withWaitStrategy(/Waiting for SearxNG/i)
    .start();

  containers.set('searxng', container);
  return container;
}

export async function startRedisContainer(): Promise<StartedTestContainer> {
  const container = await new GenericContainer('redis')
    .withExposedPorts(6379)
    .withCommand(['redis-server', '--save', ''])
    .start();

  containers.set('redis', container);
  return container;
}

export async function cleanupTestContainers(): Promise<void> {
  const stopPromises = Array.from(containers.values()).map(c => c.stop());
  await Promise.all(stopPromises);
  containers.clear();
}

export function getContainer(name: string): StartedTestContainer | undefined {
  return containers.get(name);
}
```

---

## Phase 1: Interface Extraction (Day 2-3)

### 1.1 Create Interface Definitions Directory

**`src/interfaces/`** - All interface definitions

### 1.2 Create Logger Interface

**`src/interfaces/logger.ts`:**
```typescript
export interface ILogger {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export interface IConsoleSuppressor {
  suppress(): () => void;
}

export class NullLogger implements ILogger {
  log() {}
  info() {}
  error() {}
  warn() {}
  debug() {}
}

export class TestLogger implements ILogger {
  readonly logs: Array<{ level: string; args: unknown[] }> = [];

  log(...args: unknown[]) {
    this.logs.push({ level: 'INFO', args });
  }
  info(...args: unknown[]) {
    this.logs.push({ level: 'INFO', args });
  }
  error(...args: unknown[]) {
    this.logs.push({ level: 'ERROR', args });
  }
  warn(...args: unknown[]) {
    this.logs.push({ level: 'WARN', args });
  }
  debug(...args: unknown[]) {
    this.logs.push({ level: 'DEBUG', args });
  }

  clear() {
    this.logs.length = 0;
  }
}
```

### 1.3 Create HTTP Client Interface

**`src/interfaces/http-client.ts`:**
```typescript
export interface IHttpClient {
  get(url: string, options?: RequestInit): Promise<Response>;
  post(url: string, body?: unknown, options?: RequestInit): Promise<Response>;
  put(url: string, body?: unknown, options?: RequestInit): Promise<Response>;
  delete(url: string, options?: RequestInit): Promise<Response>;
}

export class FetchHttpClient implements IHttpClient {
  async get(url: string, options?: RequestInit): Promise<Response> {
    return fetch(url, { ...options, method: 'GET' });
  }

  async post(url: string, body?: unknown, options?: RequestInit): Promise<Response> {
    return fetch(url, {
      ...options,
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        'Content-Type': 'application/json',
        ...(options?.headers ?? {}),
      },
    });
  }

  async put(url: string, body?: unknown, options?: RequestInit): Promise<Response> {
    return fetch(url, {
      ...options,
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        'Content-Type': 'application/json',
        ...(options?.headers ?? {}),
      },
    });
  }

  async delete(url: string, options?: RequestInit): Promise<Response> {
    return fetch(url, { ...options, method: 'DELETE' });
  }
}

export class MockHttpClient implements IHttpClient {
  private responses = new Map<string, { status: number; body: unknown }>();
  private requests: Array<{ method: string; url: string; body?: unknown }> = [];

  mockResponse(url: string, response: { status: number; body: unknown }): void {
    this.responses.set(url, response);
  }

  getRequests(): Array<{ method: string; url: string; body?: unknown }> {
    return [...this.requests];
  }

  clear() {
    this.responses.clear();
    this.requests.length = 0;
  }

  async get(url: string): Promise<Response> {
    this.requests.push({ method: 'GET', url });
    const response = this.responses.get(url) ?? { status: 404, body: null };
    return new Response(JSON.stringify(response.body), { status: response.status });
  }

  async post(url: string, body?: unknown): Promise<Response> {
    this.requests.push({ method: 'POST', url, body });
    const response = this.responses.get(url) ?? { status: 404, body: null };
    return new Response(JSON.stringify(response.body), { status: response.status });
  }

  async put(url: string, body?: unknown): Promise<Response> {
    this.requests.push({ method: 'PUT', url, body });
    const response = this.responses.get(url) ?? { status: 404, body: null };
    return new Response(JSON.stringify(response.body), { status: response.status });
  }

  async delete(url: string): Promise<Response> {
    this.requests.push({ method: 'DELETE', url });
    const response = this.responses.get(url) ?? { status: 404, body: null };
    return new Response(JSON.stringify(response.body), { status: response.status });
  }
}
```

### 1.4 Create Docker Manager Interface

**`src/interfaces/docker-manager.ts`:**
```typescript
export interface IDockerContainer {
  id: string;
  name: string;
  state: 'running' | 'stopped' | 'exited';
  ports: Map<number, number>;
  ipAddress: string | null;
}

export interface IDockerNetwork {
  name: string;
  id: string;
  driver: string;
}

export interface ISearxngManager {
  init(): Promise<void>;
  start(): Promise<string>; // Returns URL
  stop(): Promise<void>;
  getStatus(): IDockerContainer | null;
  getUrl(): string | null;
  isRunning(): boolean;
}

export interface INetworkManager {
  createNetwork(name: string): Promise<IDockerNetwork>;
  removeNetwork(name: string): Promise<void>;
  connectContainer(network: string, container: string): Promise<void>;
  disconnectContainer(network: string, container: string): Promise<void>;
  getNetwork(name: string): Promise<IDockerNetwork | null>;
}
```

### 1.5 Create Browser Manager Interface

**`src/interfaces/browser-manager.ts`:**
```typescript
export interface IBrowserContext {
  newPage(): Promise<IBrowserPage>;
  close(): Promise<void>;
}

export interface IBrowserPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<void>;
  content(): Promise<string>;
  evaluate<R>(fn: () => R): Promise<R>;
  close(): Promise<void>;
}

export interface IBrowser {
  isConnected(): boolean;
  newContext(options?: { viewport?: { width: number; height: number } }): Promise<IBrowserContext>;
  close(): Promise<void>;
}

export interface IBrowserManager {
  init(): Promise<void>;
  getBrowser(): Promise<IBrowser>;
  stop(): Promise<void>;
  isRunning(): boolean;
}

export class MockBrowser implements IBrowser {
  private connected = true;

  isConnected(): boolean {
    return this.connected;
  }

  async newContext(): Promise<IBrowserContext> {
    return new MockBrowserContext();
  }

  async close(): Promise<void> {
    this.connected = false;
  }
}

export class MockBrowserContext implements IBrowserContext {
  async newPage(): Promise<IBrowserPage> {
    return new MockBrowserPage();
  }

  async close(): Promise<void> {}
}

export class MockBrowserPage implements IBrowserPage {
  private url: string = '';
  private content: string = '<html><body>Test content</body></html>';

  async goto(url: string): Promise<void> {
    this.url = url;
  }

  async getContent(): Promise<string> {
    return this.content;
  }

  setContent(content: string): void {
    this.content = content;
  }

  async evaluate<R>(fn: () => R): Promise<R> {
    return fn();
  }

  async close(): Promise<void> {}
}
```

### 1.6 Create File System Interface

**`src/interfaces/file-system.ts`:**
```typescript
export interface IFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  readFileSync(path: string): string;
  writeFileSync(path: string, content: string): void;
  exists(path: string): Promise<boolean>;
  existsSync(path: string): boolean;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  unlink(path: string): Promise<void>;
}

export class NodeFileSystem implements IFileSystem {
  async readFile(path: string): Promise<string> {
    const fs = await import('node:fs/promises');
    return fs.readFile(path, 'utf-8');
  }

  async writeFile(path: string, content: string): Promise<void> {
    const fs = await import('node:fs/promises');
    return fs.writeFile(path, content, 'utf-8');
  }

  readFileSync(path: string): string {
    const fs = require('node:fs');
    return fs.readFileSync(path, 'utf-8');
  }

  writeFileSync(path: string, content: string): void {
    const fs = require('node:fs');
    fs.writeFileSync(path, content, 'utf-8');
  }

  async exists(path: string): Promise<boolean> {
    const fs = await import('node:fs/promises');
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  existsSync(path: string): boolean {
    const fs = require('node:fs');
    return fs.existsSync(path);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const fs = await import('node:fs/promises');
    return fs.mkdir(path, options);
  }

  async unlink(path: string): Promise<void> {
    const fs = await import('node:fs/promises');
    return fs.unlink(path);
  }
}

export class InMemoryFileSystem implements IFileSystem {
  private files = new Map<string, string>();

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`File not found: ${path}`);
    }
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  readFileSync(path: string): string {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`File not found: ${path}`);
    }
    return content;
  }

  writeFileSync(path: string, content: string): void {
    this.files.set(path, content);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  existsSync(path: string): boolean {
    return this.files.has(path);
  }

  async mkdir(): Promise<void> {
    // No-op for in-memory
  }

  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }

  clear(): void {
    this.files.clear();
  }
}
```

### 1.7 Create State Manager Interface

**`src/interfaces/state-manager.ts`:**
```typescript
export interface ISessionInfo {
  pid: number;
  processStartTime?: number;
  lastSeen: number;
  connectedAt: number;
}

export interface IStateMetrics {
  totalSessions: number;
  activeSessions: number;
  oldestSession: number | null;
  newestSession: number | null;
  containerUptime: number | null;
  lastHeartbeatAge: number | null;
}

export interface IStateManager {
  loadState(): Promise<void>;
  saveState(): Promise<void>;
  registerSession(sessionId: string, pid: number): Promise<void>;
  updateSessionHeartbeat(sessionId: string): Promise<void>;
  removeSession(sessionId: string): Promise<void>;
  getSession(sessionId: string): ISessionInfo | null;
  getSessions(): Map<string, ISessionInfo>;
  getMetrics(): IStateMetrics;
  acquireLock(): Promise<void>;
  releaseLock(): Promise<void>;
}
```

---

## Phase 2: Refactor Core Modules (Day 4-7)

### 2.1 Refactor Logger Module

**Changes to `src/logger.ts`:**

1. Extract the logger implementation into a class
2. Make it accept an `ILogger` interface
3. Remove global console override (move to separate module)

**New structure:**
```
src/logger/
├── index.ts              # Main export
├── logger.ts             # Logger class implementing ILogger
├── console-suppressor.ts # Console suppression logic
└── factory.ts            # Factory function
```

**`src/logger/logger.ts`:**
```typescript
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ILogger } from '../interfaces/logger.js';

export class FileLogger implements ILogger {
  private logFile: string | null = null;

  constructor(verbose: boolean = false) {
    if (verbose) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
      this.logFile = join('/tmp', `pi-research-${ts}.log`);
      try {
        writeFileSync(this.logFile, `# pi-research verbose log — ${new Date().toISOString()}\n`);
      } catch { /* ignore */ }
    }
  }

  private write(level: string, ...args: unknown[]): void {
    if (!this.logFile) return;
    const msg = args
      .map((a) => (a instanceof Error ? a.message : typeof a === 'object' ? JSON.stringify(a, null, 0) : String(a)))
      .join(' ');
    const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
    try {
      appendFileSync(this.logFile, line);
    } catch { /* ignore */ }
  }

  log(...args: unknown[]): void {
    this.write('INFO', ...args);
  }

  info(...args: unknown[]): void {
    this.write('INFO', ...args);
  }

  error(...args: unknown[]): void {
    this.write('ERROR', ...args);
  }

  warn(...args: unknown[]): void {
    this.write('WARN', ...args);
  }

  debug(...args: unknown[]): void {
    this.write('DEBUG', ...args);
  }

  getLogFile(): string | null {
    return this.logFile;
  }
}
```

**`src/logger/console-suppressor.ts`:**
```typescript
import type { IConsoleSuppressor } from '../interfaces/logger.js';

export class ConsoleSuppressor implements IConsoleSuppressor {
  private originalConsole: typeof console;
  private isSuppressed = false;

  constructor() {
    this.originalConsole = {
      log: console.log,
      info: console.info,
      error: console.error,
      warn: console.warn,
      debug: console.debug,
    } as typeof console;
  }

  suppress(verbose: boolean = false): () => void {
    if (this.isSuppressed) {
      return () => {};
    }

    this.isSuppressed = true;

    const noop = () => {};
    const toFile = (level: string) => (...args: unknown[]) => {
      // Write to log file if verbose
      if (verbose) {
        this.originalConsole.log(`[${level}]`, ...args);
      }
    };

    if (verbose) {
      console.log = toFile('INFO') as typeof console.log;
      console.info = toFile('INFO') as typeof console.info;
      console.error = toFile('ERROR') as typeof console.error;
      console.warn = toFile('WARN') as typeof console.warn;
      console.debug = toFile('DEBUG') as typeof console.debug;
    } else {
      console.log = noop as typeof console.log;
      console.info = noop as typeof console.info;
      console.error = noop as typeof console.error;
      console.warn = noop as typeof console.warn;
      console.debug = noop as typeof console.debug;
    }

    return () => this.restore();
  }

  restore(): void {
    console.log = this.originalConsole.log;
    console.info = this.originalConsole.info;
    console.error = this.originalConsole.error;
    console.warn = this.originalConsole.warn;
    console.debug = this.originalConsole.debug;
    this.isSuppressed = false;
  }
}
```

**`src/logger/factory.ts`:**
```typescript
import { FileLogger } from './logger.js';
import { ConsoleSuppressor } from './console-suppressor.js';
import type { ILogger, IConsoleSuppressor } from '../interfaces/logger.js';

export interface LoggerOptions {
  verbose?: boolean;
}

export function createLogger(options: LoggerOptions = {}): ILogger {
  return new FileLogger(options.verbose ?? false);
}

export function createConsoleSuppressor(): IConsoleSuppressor {
  return new ConsoleSuppressor();
}
```

**`src/logger/index.ts`:**
```typescript
export { FileLogger } from './logger.js';
export { ConsoleSuppressor } from './console-suppressor.js';
export { createLogger, createConsoleSuppressor, type LoggerOptions } from './factory.js';
export type { ILogger, IConsoleSuppressor } from '../interfaces/logger.js';

// Convenience exports for backward compatibility
export const isVerbose =
  process.argv.includes('--verbose') ||
  process.env['PI_RESEARCH_VERBOSE'] === '1';

// Singleton instances (for non-test code)
const _logger = createLogger({ verbose: isVerbose });
const _suppressor = createConsoleSuppressor();

export const logger = _logger;
export const suppressConsole = () => _suppressor.suppress(isVerbose);
```

### 2.2 Refactor SearXNG Lifecycle Module

**Changes to `src/searxng-lifecycle.ts`:**

1. Extract the manager into a class
2. Make it accept `ISearxngManager` and `ILogger`
3. Remove module-level state

**New structure:**
```
src/lifecycle/
├── searxng-lifecycle.ts  # SearxngLifecycle class
└── factory.ts            # Factory function
```

**`src/lifecycle/searxng-lifecycle.ts`:**
```typescript
import type { ISearxngManager } from '../interfaces/docker-manager.js';
import type { ILogger } from '../interfaces/logger.js';
import type { IFileSystem } from '../interfaces/file-system.js';

export interface SearxngStatus {
  state: 'starting_up' | 'active' | 'inactive' | 'error';
  connectionCount: number;
  url: string;
}

export type StatusCallback = (status: SearxngStatus) => void;

export interface SearxngLifecycleOptions {
  manager: ISearxngManager;
  logger: ILogger;
  fs: IFileSystem;
  proxyUrl?: string;
  extensionDir: string;
}

export class SearxngLifecycle {
  private status: SearxngStatus = {
    state: 'inactive',
    connectionCount: 0,
    url: '',
  };
  private statusCallbacks: StatusCallback[] = [];
  private initialized = false;
  private manager: ISearxngManager;
  private logger: ILogger;
  private fs: IFileSystem;
  private proxyUrl?: string;
  private extensionDir: string;

  constructor(options: SearxngLifecycleOptions) {
    this.manager = options.manager;
    this.logger = options.logger;
    this.fs = options.fs;
    this.proxyUrl = options.proxyUrl;
    this.extensionDir = options.extensionDir;
  }

  async init(ctx: { sessionId?: string }): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.logger.log('[SearxngLifecycle] Initializing...');
    this.updateStatus({ state: 'starting_up', connectionCount: 0, url: '' });

    try {
      // Generate proxy settings if needed
      if (this.proxyUrl) {
        await this.generateProxySettings(this.proxyUrl);
      }

      await this.manager.init();
      this.initialized = true;
      this.updateStatus({ state: 'inactive', connectionCount: 0, url: '' });
      this.logger.log('[SearxngLifecycle] Initialized');
    } catch (error) {
      this.logger.error('[SearxngLifecycle] Init failed:', error);
      this.updateStatus({ state: 'error', connectionCount: 0, url: '' });
      throw error;
    }
  }

  async ensureRunning(): Promise<string> {
    if (this.manager.isRunning()) {
      return this.manager.getUrl()!;
    }

    this.updateStatus({ ...this.status, state: 'starting_up' });

    try {
      const url = await this.manager.start();
      this.updateStatus({
        state: 'active',
        connectionCount: 0,
        url,
      });
      this.logger.log('[SearxngLifecycle] Running at:', url);
      return url;
    } catch (error) {
      this.logger.error('[SearxngLifecycle] Failed to start:', error);
      this.updateStatus({ state: 'error', connectionCount: 0, url: '' });
      throw error;
    }
  }

  getStatus(): SearxngStatus {
    return { ...this.status };
  }

  onStatusChange(callback: StatusCallback): () => void {
    this.statusCallbacks.push(callback);
    callback(this.getStatus());

    return () => {
      const index = this.statusCallbacks.indexOf(callback);
      if (index !== -1) {
        this.statusCallbacks.splice(index, 1);
      }
    };
  }

  private updateStatus(newStatus: Partial<SearxngStatus>): void {
    this.status = { ...this.status, ...newStatus };
    for (const callback of this.statusCallbacks) {
      callback(this.getStatus());
    }
  }

  private async generateProxySettings(proxyUrl: string): Promise<void> {
    const defaultSettingsPath = `${this.extensionDir}/config/default-settings.yml`;
    const proxySettingsPath = `${this.extensionDir}/config/proxy-settings-generated.yml`;

    try {
      const defaultSettings = await this.fs.readFile(defaultSettingsPath);
      const gatewayIp = '172.19.0.1'; // Docker gateway

      // Convert localhost to gateway IP
      const proxySettings = defaultSettings.replace(
        /127\.0\.0\.1/g,
        gatewayIp
      );

      await this.fs.writeFile(proxySettingsPath, proxySettings);
    } catch (error) {
      this.logger.warn('[SearxngLifecycle] Could not generate proxy settings:', error);
    }
  }

  getManager(): ISearxngManager {
    return this.manager;
  }

  async shutdown(): Promise<void> {
    this.logger.log('[SearxngLifecycle] Shutting down...');
    await this.manager.stop();
    this.updateStatus({ state: 'inactive', connectionCount: 0, url: '' });
  }
}
```

### 2.3 Refactor Web Research Scrapers Module

**Changes to `src/web-research/scrapers.ts`:**

1. Extract browser management into `IBrowserManager`
2. Make scrape functions accept browser manager as parameter
3. Extract HTML conversion and validation into pure functions

**New structure:**
```
src/web-research/
├── scrapers.ts           # Main scraper class
├── browser-manager.ts    # IBrowserManager implementation
├── html-processor.ts     # Pure HTML processing functions
└── content-validator.ts  # Content validation logic
```

**`src/web-research/browser-manager.ts`:**
```typescript
import type { IBrowser, IBrowserContext, IBrowserPage, IBrowserManager } from '../interfaces/browser-manager.js';
import type { ILogger } from '../interfaces/logger.js';
import { trackContext, untrackContextById, clearTrackedContexts } from './utils.js';

export class PlaywrightBrowserManager implements IBrowserManager {
  private browser: IBrowser | null = null;
  private launchPromise: Promise<IBrowser> | null = null;
  private initialized = false;
  private logger: ILogger;

  constructor(logger: ILogger) {
    this.logger = logger;
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Check if playwright is available
    try {
      require('playwright');
      this.initialized = true;
    } catch {
      this.logger.warn('[BrowserManager] Playwright not available');
    }
  }

  async getBrowser(): Promise<IBrowser> {
    if (!this.initialized) {
      throw new Error('BrowserManager not initialized');
    }

    if (this.browser?.isConnected()) {
      return this.browser;
    }

    if (this.launchPromise !== null) {
      return this.launchPromise;
    }

    if (this.browser !== null) {
      this.logger.log('[BrowserManager] Browser disconnected, relaunching...');
      this.browser = null;
    }

    this.launchPromise = this.launch();

    try {
      this.browser = await this.launchPromise;
      return this.browser;
    } finally {
      this.launchPromise = null;
    }
  }

  private async launch(): Promise<IBrowser> {
    try {
      const playwright = require('playwright');
      const chromium = playwright.chromium;
      const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });

      this.logger.log('[BrowserManager] Chromium launched');
      return {
        isConnected: () => true,
        newContext: async (options) => {
          const context = await browser.newContext(options);
          const page = await context.newPage();

          return {
            newPage: async () => {
              const newPage = await context.newPage();
              return {
                goto: async (url, opts) => {
                  await newPage.goto(url, { waitUntil: opts?.waitUntil ?? 'networkidle', timeout: opts?.timeout });
                },
                content: async () => newPage.content(),
                evaluate: async (fn) => newPage.evaluate(fn),
                close: async () => newPage.close(),
              };
            },
            close: async () => context.close(),
          };
        },
        close: async () => browser.close(),
      };
    } catch (error) {
      this.logger.error('[BrowserManager] Failed to launch:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.browser === null && this.launchPromise === null) {
      return;
    }

    this.logger.log('[BrowserManager] Stopping...');

    const browser = this.browser;
    const launchPromise = this.launchPromise;
    this.browser = null;
    this.launchPromise = null;

    clearTrackedContexts();

    if (browser !== null) {
      await browser.close().catch(() => {});
    } else if (launchPromise !== null) {
      const launched = await launchPromise.catch(() => null);
      if (launched !== null) {
        await launched.close().catch(() => {});
      }
    }

    this.logger.log('[BrowserManager] Stopped');
  }

  isRunning(): boolean {
    return this.browser?.isConnected() ?? false;
  }
}
```

**`src/web-research/html-processor.ts`:**
```typescript
import {
  convertWithVisitor,
  JsHeadingStyle,
  JsCodeBlockStyle,
  type JsNodeContext,
} from '@kreuzberg/html-to-markdown-node';

export interface HtmlProcessorOptions {
  skipImages?: boolean;
  skipIframes?: boolean;
  skipNav?: boolean;
  minContentLength?: number;
}

/**
 * Convert HTML to Markdown with content filtering
 *
 * Pure function - testable with HTML strings
 */
export async function convertHtmlToMarkdown(
  html: string,
  options: HtmlProcessorOptions = {}
): Promise<string> {
  const {
    skipImages = true,
    skipIframes = true,
    skipNav = true,
    minContentLength = 50,
  } = options;

  const visitor = {
    async visitImage(): Promise<string> {
      return skipImages ? JSON.stringify({ type: 'skip' }) : JSON.stringify({ type: 'keep' });
    },

    async visitIframe(): Promise<string> {
      return skipIframes ? JSON.stringify({ type: 'skip' }) : JSON.stringify({ type: 'keep' });
    },

    async visitNav(): Promise<string> {
      return skipNav ? JSON.stringify({ type: 'skip' }) : JSON.stringify({ type: 'keep' });
    },

    async visitHeader(): Promise<string> {
      return skipNav ? JSON.stringify({ type: 'skip' }) : JSON.stringify({ type: 'keep' });
    },

    async visitFooter(): Promise<string> {
      return skipNav ? JSON.stringify({ type: 'skip' }) : JSON.stringify({ type: 'keep' });
    },

    async visitAside(): Promise<string> {
      return skipNav ? JSON.stringify({ type: 'skip' }) : JSON.stringify({ type: 'keep' });
    },

    async visitForm(): Promise<string> {
      return JSON.stringify({ type: 'skip' });
    },

    async visitScript(): Promise<string> {
      return JSON.stringify({ type: 'skip' });
    },

    async visitStyle(): Promise<string> {
      return JSON.stringify({ type: 'skip' });
    },

    async visitObject(): Promise<string> {
      return JSON.stringify({ type: 'skip' });
    },

    async visitEmbed(): Promise<string> {
      return JSON.stringify({ type: 'skip' });
    },
  };

  const markdown = await convertWithVisitor(
    html,
    visitor as any,
    {
      headingStyle: JsHeadingStyle.Atx,
      codeBlockStyle: JsCodeBlockStyle.Fenced,
    }
  );

  return markdown.trim();
}

/**
 * Validate content quality
 *
 * Pure function - testable with markdown strings
 */
export interface ValidationResult {
  isValid: boolean;
  reason?: string;
  confidence: number; // 0-1
}

export function validateContent(content: string, options: { minLength?: number } = {}): ValidationResult {
  const { minLength = 50 } = options;

  // Check minimum length
  if (content.length < minLength) {
    return {
      isValid: false,
      reason: `Content too short (${content.length} < ${minLength})`,
      confidence: 0.9,
    };
  }

  // Check for meaningful content (not just whitespace/punctuation)
  const meaningfulChars = content.replace(/\s+|[^\w]/g, '');
  if (meaningfulChars.length < minLength / 2) {
    return {
      isValid: false,
      reason: 'Content lacks meaningful text',
      confidence: 0.8,
    };
  }

  // Check for common error patterns
  const errorPatterns = [
    /404\s*not\s*found/i,
    /access\s*denied/i,
    /page\s*not\s*found/i,
    /error\s*\d{3}/i,
  ];

  for (const pattern of errorPatterns) {
    if (pattern.test(content)) {
      return {
        isValid: false,
        reason: 'Content contains error pattern',
        confidence: 0.7,
      };
    }
  }

  return {
    isValid: true,
    confidence: 1.0,
  };
}

/**
 * Extract main content from HTML
 *
 * Pure function - testable with HTML strings
 */
export function extractMainContent(html: string): string {
  // Try to find <main> tag
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch) {
    return mainMatch[1];
  }

  // Try to find <article> tag
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    return articleMatch[1];
  }

  // Try to find content divs
  const contentDivPatterns = [
    /<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*id="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  ];

  for (const pattern of contentDivPatterns) {
    const match = html.match(pattern);
    if (match) {
      return match[1];
    }
  }

  // Fallback: return body
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch ? bodyMatch[1] : html;
}
```

### 2.4 Refactor Delegate Tool Module

**Changes to `src/orchestration/delegate-tool.ts`:**

1. Extract concurrency logic into separate `ResearcherPool` class
2. Extract session management into separate class
3. Make timeout/retry logic testable

**New structure:**
```
src/orchestration/
├── delegate-tool.ts           # Main tool definition
├── researcher-pool.ts         # Worker pool for researchers
├── session-factory.ts         # Session creation factory
└── timeout-manager.ts         # Timeout/retry logic
```

**`src/orchestration/researcher-pool.ts`:**
```typescript
import type { ILogger } from '../interfaces/logger.js';
import type { CreateResearcherSessionOptions } from './researcher.js';
import type { ResearchPanelState } from '../tui/research-panel.js';

export interface ResearcherTask {
  label: string;
  slice: string;
  options: CreateResearcherSessionOptions;
}

export interface PoolConfig {
  maxConcurrency: number;
  timeoutMs: number;
  flashTimeoutMs: number;
}

export class ResearcherPool {
  private activeTasks = new Map<string, Promise<unknown>>();
  private completedTasks = new Set<string>();
  private logger: ILogger;
  private config: PoolConfig;

  constructor(logger: ILogger, config: PoolConfig) {
    this.logger = logger;
    this.config = config;
  }

  async executeTasks(
    tasks: ResearcherTask[],
    options: {
      onProgress?: (completed: number, total: number, label: string) => void;
      onComplete?: (label: string, result: unknown) => void;
      onError?: (label: string, error: Error) => void;
      onTimeout?: (label: string) => void;
    } = {}
  ): Promise<Map<string, unknown>> {
    const results = new Map<string, unknown>();
    const queue = [...tasks];
    let completed = 0;

    const processTask = async (task: ResearcherTask): Promise<void> => {
      try {
        const result = await this.executeSingleTask(task);
        results.set(task.label, result);
        this.completedTasks.add(task.label);
        completed++;
        options.onComplete?.(task.label, result);
        options.onProgress?.(completed, tasks.length, task.label);
      } catch (error) {
        completed++;
        if (error instanceof Error) {
          if (error.message.includes('timeout')) {
            options.onTimeout?.(task.label);
          } else {
            options.onError?.(task.label, error);
          }
        }
        throw error;
      }
    };

    // Execute tasks respecting max concurrency
    const workers: Promise<void>[] = [];
    while (queue.length > 0 || workers.length > 0) {
      // Fill workers up to max concurrency
      while (workers.length < this.config.maxConcurrency && queue.length > 0) {
        const task = queue.shift()!;
        const worker = processTask(task).finally(() => {
          const index = workers.indexOf(worker);
          if (index !== -1) {
            workers.splice(index, 1);
          }
        });
        workers.push(worker);
      }

      // Wait for at least one worker to complete
      await Promise.race(workers);
    }

    return results;
  }

  private async executeSingleTask(task: ResearcherTask): Promise<unknown> {
    // Implementation would call researcher session
    this.logger.log(`[ResearcherPool] Executing task: ${task.label}`);
    // ... actual execution logic
    return { result: 'mock' };
  }

  getActiveCount(): number {
    return this.activeTasks.size;
  }

  getCompletedCount(): number {
    return this.completedTasks.size;
  }

  clear(): void {
    this.activeTasks.clear();
    this.completedTasks.clear();
  }
}
```

**`src/orchestration/timeout-manager.ts`:**
```typescript
import type { ILogger } from '../interfaces/logger.js';

export interface TimeoutOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  label?: string;
}

export interface RetryOptions {
  maxRetries: number;
  initialDelayMs: number;
  backoffMultiplier?: number;
}

export class TimeoutManager {
  private logger: ILogger;

  constructor(logger: ILogger) {
    this.logger = logger;
  }

  /**
   * Wrap a promise with timeout and abort signal
   *
   * Pure function - testable with mock promises
   */
  withTimeout<T>(promise: Promise<T>, options: TimeoutOptions): Promise<T> {
    const { timeoutMs, signal, label = 'operation' } = options;

    const timeoutController = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([timeoutController.signal, signal])
      : timeoutController.signal;

    this.logger.debug(`[TimeoutManager] Starting ${label} with timeout ${timeoutMs}ms`);

    return Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        const timeoutId = setTimeout(() => {
          this.logger.error(`[TimeoutManager] ${label} TIMEOUT after ${timeoutMs}ms`);
          timeoutController.abort();
          reject(new Error(`${label} timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        if (combinedSignal.aborted) {
          this.logger.error(`[TimeoutManager] ${label} ALREADY ABORTED at start`);
          clearTimeout(timeoutId);
          reject(new Error(`${label} cancelled`));
        } else {
          combinedSignal.addEventListener('abort', () => {
            this.logger.error(`[TimeoutManager] ${label} ABORT SIGNAL FIRED`);
            clearTimeout(timeoutId);
            reject(new Error(`${label} cancelled`));
          });
        }
      }),
    ]).finally(() => {
      timeoutController.abort();
    });
  }

  /**
   * Retry a promise with exponential backoff
   *
   * Pure function - testable with mock promises
   */
  async withRetry<T>(
    fn: () => Promise<T>,
    options: RetryOptions & { label?: string; isTransient?: (error: unknown) => boolean }
  ): Promise<T> {
    const { maxRetries, initialDelayMs, backoffMultiplier = 2, label = 'operation', isTransient } = options;

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if error is transient
        if (isTransient && !isTransient(error)) {
          throw lastError;
        }

        if (attempt > maxRetries) {
          throw lastError;
        }

        const delayMs = initialDelayMs * Math.pow(backoffMultiplier, attempt - 1);
        this.logger.debug(
          `[TimeoutManager] ${label} failed (attempt ${attempt}/${maxRetries}), retrying in ${delayMs}ms:`,
          lastError.message
        );

        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw lastError || new Error('Retry exhausted');
  }
}
```

---

## Phase 3: Write Unit Tests (Day 8-12)

### 3.1 Test Pure Functions (Immediate Wins)

**`test/unit/config.test.ts`:**
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { validateConfig, RESEARCHER_TIMEOUT_MS, FLASH_TIMEOUT_MS, PROXY_URL } from '@/config';

describe('config', () => {
  describe('validateConfig', () => {
    it('should not throw with default values', () => {
      expect(() => validateConfig()).not.toThrow();
    });

    it('should throw when RESEARCHER_TIMEOUT_MS is too low', () => {
      const original = process.env['PI_RESEARCH_RESEARCHER_TIMEOUT_MS'];
      process.env['PI_RESEARCH_RESEARCHER_TIMEOUT_MS'] = '10000'; // 10s < 30s minimum

      expect(() => validateConfig()).toThrow(
        /PI_RESEARCH_RESEARCHER_TIMEOUT_MS must be between 30000ms and 600000ms/
      );

      process.env['PI_RESEARCH_RESEARCHER_TIMEOUT_MS'] = original;
    });

    it('should throw when RESEARCHER_TIMEOUT_MS is too high', () => {
      const original = process.env['PI_RESEARCH_RESEARCHER_TIMEOUT_MS'];
      process.env['PI_RESEARCH_RESEARCHER_TIMEOUT_MS'] = '700000'; // 700s > 600s maximum

      expect(() => validateConfig()).toThrow(
        /PI_RESEARCH_RESEARCHER_TIMEOUT_MS must be between 30000ms and 600000ms/
      );

      process.env['PI_RESEARCH_RESEARCHER_TIMEOUT_MS'] = original;
    });

    it('should throw when FLASH_TIMEOUT_MS is too low', () => {
      const original = process.env['PI_RESEARCH_FLASH_TIMEOUT_MS'];
      process.env['PI_RESEARCH_FLASH_TIMEOUT_MS'] = '50'; // 50ms < 100ms minimum

      expect(() => validateConfig()).toThrow(
        /PI_RESEARCH_FLASH_TIMEOUT_MS must be between 100 and 5000 ms/
      );

      process.env['PI_RESEARCH_FLASH_TIMEOUT_MS'] = original;
    });

    it('should throw when FLASH_TIMEOUT_MS is too high', () => {
      const original = process.env['PI_RESEARCH_FLASH_TIMEOUT_MS'];
      process.env['PI_RESEARCH_FLASH_TIMEOUT_MS'] = '10000'; // 10000ms > 5000ms maximum

      expect(() => validateConfig()).toThrow(
        /PI_RESEARCH_FLASH_TIMEOUT_MS must be between 100 and 5000 ms/
      );

      process.env['PI_RESEARCH_FLASH_TIMEOUT_MS'] = original;
    });
  });
});
```

**`test/unit/utils/text-utils.test.ts`:**
```typescript
import { describe, it, expect } from 'vitest';
import { extractText } from '@/utils/text-utils';

describe('text-utils', () => {
  describe('extractText', () => {
    it('should extract text from string content', () => {
      const message = { content: 'Hello, world!' };
      expect(extractText(message)).toBe('Hello, world!');
    });

    it('should extract text from array content with text blocks', () => {
      const message = {
        content: [
          { type: 'text', text: 'Line 1' },
          { type: 'text', text: 'Line 2' },
          { type: 'thinking', content: 'This is thinking' },
        ],
      };
      expect(extractText(message)).toBe('Line 1\nLine 2');
    });

    it('should return empty string for null message', () => {
      expect(extractText(null)).toBe('');
    });

    it('should return empty string for undefined message', () => {
      expect(extractText(undefined)).toBe('');
    });

    it('should return empty string for message without content', () => {
      expect(extractText({})).toBe('');
    });

    it('should handle empty array', () => {
      expect(extractText({ content: [] })).toBe('');
    });

    it('should handle array with only non-text blocks', () => {
      const message = {
        content: [
          { type: 'thinking', content: 'This is thinking' },
          { type: 'tool_call', tool: 'search' },
        ],
      };
      expect(extractText(message)).toBe('');
    });
  });
});
```

**`test/unit/utils/session-state.test.ts`:**
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import {
  startResearchSession,
  endResearchSession,
  recordResearcherFailure,
  getFailedResearchers,
  shouldStopResearch,
  getResearchStopMessage,
  getCurrentSessionId,
  getAllSessions,
} from '@/utils/session-state';

describe('session-state', () => {
  beforeEach(() => {
    endResearchSession();
  });

  describe('startResearchSession', () => {
    it('should start a new session and return session ID', () => {
      const sessionId = startResearchSession();
      expect(sessionId).toMatch(/^research-\d+-[a-z0-9]+$/);
      expect(getCurrentSessionId()).toBe(sessionId);
    });

    it('should create empty failure list for new session', () => {
      startResearchSession();
      expect(getFailedResearchers()).toEqual([]);
    });
  });

  describe('endResearchSession', () => {
    it('should clear current session', () => {
      const sessionId = startResearchSession();
      endResearchSession();
      expect(getCurrentSessionId()).toBeNull();
      expect(getFailedResearchers()).toEqual([]);
    });

    it('should not throw when no session is active', () => {
      expect(() => endResearchSession()).not.toThrow();
    });
  });

  describe('recordResearcherFailure', () => {
    it('should record failure for current session', () => {
      startResearchSession();
      recordResearcherFailure('1:1');
      expect(getFailedResearchers()).toEqual(['1:1']);
    });

    it('should record multiple failures', () => {
      startResearchSession();
      recordResearcherFailure('1:1');
      recordResearcherFailure('2:1');
      recordResearcherFailure('3:1');
      expect(getFailedResearchers()).toEqual(['1:1', '2:1', '3:1']);
    });

    it('should record duplicate failures', () => {
      startResearchSession();
      recordResearcherFailure('1:1');
      recordResearcherFailure('1:1');
      recordResearcherFailure('1:1');
      expect(getFailedResearchers()).toEqual(['1:1']); // Deduplicated
    });

    it('should not record when no session is active', () => {
      expect(() => recordResearcherFailure('1:1')).not.toThrow();
      expect(getFailedResearchers()).toEqual([]);
    });
  });

  describe('shouldStopResearch', () => {
    it('should return false with no failures', () => {
      startResearchSession();
      expect(shouldStopResearch()).toBe(false);
    });

    it('should return false with one failure', () => {
      startResearchSession();
      recordResearcherFailure('1:1');
      expect(shouldStopResearch()).toBe(false);
    });

    it('should return true with two unique failures', () => {
      startResearchSession();
      recordResearcherFailure('1:1');
      recordResearcherFailure('2:1');
      expect(shouldStopResearch()).toBe(true);
    });

    it('should return true with three unique failures', () => {
      startResearchSession();
      recordResearcherFailure('1:1');
      recordResearcherFailure('2:1');
      recordResearcherFailure('3:1');
      expect(shouldStopResearch()).toBe(true);
    });
  });

  describe('getResearchStopMessage', () => {
    it('should return formatted error message with failures', () => {
      startResearchSession();
      recordResearcherFailure('1:1');
      recordResearcherFailure('2:1');

      const message = getResearchStopMessage();
      expect(message).toContain('Research stopped: 2 researcher(s) failed: 1:1, 2:1');
      expect(message).toContain('Troubleshooting:');
      expect(message).toContain('Check network connection');
    });
  });
});
```

### 3.2 Test Stack Exchange Module

**`test/unit/stackexchange/queries.test.ts`:**
```typescript
import { describe, it, expect } from 'vitest';
import {
  buildSearchParams,
  buildSearchQuery,
  buildQuestionsQuery,
} from '@/stackexchange/queries';

describe('stackexchange queries', () => {
  describe('buildSearchParams', () => {
    it('should build empty params', () => {
      const params = buildSearchParams({});
      expect(params.toString()).toBe('');
    });

    it('should build string params', () => {
      const params = buildSearchParams({ query: 'test', site: 'stackoverflow.com' });
      expect(params.get('query')).toBe('test');
      expect(params.get('site')).toBe('stackoverflow.com');
    });

    it('should build boolean params', () => {
      const params = buildSearchParams({ accepted: true, wiki: false });
      expect(params.get('accepted')).toBe('true');
      expect(params.get('wiki')).toBe('false');
    });

    it('should build number params', () => {
      const params = buildSearchParams({ page: 2, pagesize: 50 });
      expect(params.get('page')).toBe('2');
      expect(params.get('pagesize')).toBe('50');
    });

    it('should build array params', () => {
      const params = buildSearchParams({ tagged: ['typescript', 'javascript'] });
      expect(params.get('tagged')).toBe('typescript;javascript');
    });

    it('should ignore undefined params', () => {
      const params = buildSearchParams({ query: 'test', page: undefined });
      expect(params.get('query')).toBe('test');
      expect(params.get('page')).toBeNull();
    });

    it('should ignore null params', () => {
      const params = buildSearchParams({ query: 'test', page: null });
      expect(params.get('query')).toBe('test');
      expect(params.get('page')).toBeNull();
    });
  });

  describe('buildSearchQuery', () => {
    it('should alias buildSearchParams', () => {
      const result = buildSearchQuery({ query: 'test' });
      expect(result.get('query')).toBe('test');
    });
  });

  describe('buildQuestionsQuery', () => {
    it('should build default params', () => {
      const result = buildQuestionsQuery({ ids: ['1', '2'] });
      expect(result.get('order')).toBe('desc');
      expect(result.get('sort')).toBe('activity');
      expect(result.get('site')).toBe('stackoverflow.com');
    });

    it('should build custom params', () => {
      const result = buildQuestionsQuery({
        ids: ['1', '2'],
        order: 'asc',
        sort: 'creation',
        site: 'serverfault.com',
        page: 3,
      });
      expect(result.get('order')).toBe('asc');
      expect(result.get('sort')).toBe('creation');
      expect(result.get('site')).toBe('serverfault.com');
      expect(result.get('page')).toBe('3');
    });
  });
});
```

**`test/unit/stackexchange/output/compact.test.ts`:**
```typescript
import { describe, it, expect } from 'vitest';
import { formatCompact } from '@/stackexchange/output/compact';

describe('stackexchange compact output', () => {
  it('should format empty questions array', () => {
    expect(formatCompact([])).toBe('');
  });

  it('should format single question', () => {
    const questions = [
      {
        id: '1',
        title: 'Test question',
        score: 5,
        answer_count: 2,
        tags: ['typescript', 'testing'],
      },
    ];
    const result = formatCompact(questions);
    expect(result).toContain('[1] Test question');
    expect(result).toContain('Score: 5');
    expect(result).toContain('Answers: 2');
    expect(result).toContain('Tags: typescript, testing');
  });

  it('should format multiple questions', () => {
    const questions = [
      {
        id: '1',
        title: 'First question',
        score: 5,
        answer_count: 2,
        tags: ['a'],
      },
      {
        id: '2',
        title: 'Second question',
        score: 3,
        answer_count: 1,
        tags: ['b'],
      },
    ];
    const result = formatCompact(questions);
    expect(result).toContain('[1] First question');
    expect(result).toContain('[2] Second question');
  });
});
```

### 3.3 Test Security Module

**`test/unit/security/types.test.ts`:**
```typescript
import { describe, it, expect } from 'vitest';
import { isValidSeverity } from '@/security/types';

describe('security types', () => {
  describe('isValidSeverity', () => {
    it('should return true for valid severities', () => {
      expect(isValidSeverity('LOW')).toBe(true);
      expect(isValidSeverity('MEDIUM')).toBe(true);
      expect(isValidSeverity('HIGH')).toBe(true);
      expect(isValidSeverity('CRITICAL')).toBe(true);
    });

    it('should return false for invalid severities', () => {
      expect(isValidSeverity('low')).toBe(false);
      expect(isValidSeverity('Medium')).toBe(false);
      expect(isValidSeverity('INFO')).toBe(false);
      expect(isValidSeverity('')).toBe(false);
      expect(isValidSeverity(null)).toBe(false);
      expect(isValidSeverity(undefined)).toBe(false);
    });
  });
});
```

### 3.4 Test TUI Components

**`test/unit/tui/research-panel.test.ts`:**
```typescript
import { describe, it, expect } from 'vitest';
import { createResearchPanel } from '@/tui/research-panel';

describe('research panel', () => {
  it('should create panel with initial state', () => {
    const state = {
      searxngStatus: {
        state: 'active',
        connectionCount: 3,
        url: 'http://localhost:8080',
      },
      totalTokens: 1000,
      activeConnections: 3,
      slices: new Map(),
      modelName: 'gpt-4',
    };

    const panel = createResearchPanel(state);
    expect(panel).toBeDefined();
    expect(typeof panel).toBe('function');
  });

  it('should render with slices', () => {
    const slices = new Map([
      ['1:1', { label: '1:1', status: 'active', tokens: 100 }],
      ['1:2', { label: '1:2', status: 'completed', tokens: 200 }],
    ]);

    const state = {
      searxngStatus: {
        state: 'active',
        connectionCount: 2,
        url: 'http://localhost:8080',
      },
      totalTokens: 300,
      activeConnections: 2,
      slices,
      modelName: 'gpt-4',
    };

    const panel = createResearchPanel(state);
    const render = panel as any;
    expect(render).toBeInstanceOf(Function);
  });
});
```

---

## Phase 4: Write Integration Tests (Day 13-17)

### 4.1 Web Research Integration Tests

**`test/integration/web-research/search.test.ts`:**
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startSearxngContainer, getContainer } from '@test/helpers/test-containers';
import { searchSearxng } from '@/web-research/search';

describe('web-research search integration', () => {
  let containerUrl: string;

  beforeAll(async () => {
    const container = await startSearxngContainer();
    containerUrl = `http://${container.getHost()}:${container.getMappedPort(8080)}`;
  }, 60000);

  afterAll(async () => {
    // Cleanup handled by test setup
  });

  it('should search SearXNG successfully', async () => {
    const results = await searchSearxng('test query');
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('title');
    expect(results[0]).toHaveProperty('url');
    expect(results[0]).toHaveProperty('snippet');
  }, 30000);

  it('should handle empty results', async () => {
    const results = await searchSearxng('xyz123nonexistentquery');
    expect(Array.isArray(results)).toBe(true);
    // Might be empty or have minimal results
  }, 30000);

  it('should respect timeout', async () => {
    // This test verifies timeout handling
    await expect(searchSearxng('test')).resolves.toBeDefined();
  }, 30000);
});
```

### 4.2 Scraping Integration Tests

**`test/integration/web-research/scrapers.test.ts`:**
```typescript
import { describe, it, expect } from 'vitest';
import { convertHtmlToMarkdown, validateContent, extractMainContent } from '@/web-research/html-processor';

describe('web-research scrapers integration', () => {
  describe('convertHtmlToMarkdown', () => {
    it('should convert simple HTML to markdown', async () => {
      const html = '<h1>Title</h1><p>Content here</p>';
      const markdown = await convertHtmlToMarkdown(html);
      expect(markdown).toContain('# Title');
      expect(markdown).toContain('Content here');
    });

    it('should skip images by default', async () => {
      const html = '<img src="test.jpg" alt="test"><p>Content</p>';
      const markdown = await convertHtmlToMarkdown(html);
      expect(markdown).not.toContain('test.jpg');
      expect(markdown).toContain('Content');
    });

    it('should preserve images when option is set', async () => {
      const html = '<img src="test.jpg" alt="test"><p>Content</p>';
      const markdown = await convertHtmlToMarkdown(html, { skipImages: false });
      expect(markdown).toContain('test.jpg');
    });

    it('should skip nav elements by default', async () => {
      const html = '<nav>Navigation</nav><main>Main content</main>';
      const markdown = await convertHtmlToMarkdown(html);
      expect(markdown).not.toContain('Navigation');
      expect(markdown).toContain('Main content');
    });

    it('should handle complex HTML', async () => {
      const html = `
        <article>
          <h1>Main Title</h1>
          <p>First paragraph</p>
          <p>Second paragraph</p>
          <pre><code>code block</code></pre>
        </article>
      `;
      const markdown = await convertHtmlToMarkdown(html);
      expect(markdown).toContain('# Main Title');
      expect(markdown).toContain('First paragraph');
      expect(markdown).toContain('Second paragraph');
      expect(markdown).toContain('`code block`');
    });
  });

  describe('validateContent', () => {
    it('should validate valid content', () => {
      const result = validateContent('This is a valid content with enough text to pass validation');
      expect(result.isValid).toBe(true);
      expect(result.confidence).toBe(1.0);
    });

    it('should reject too short content', () => {
      const result = validateContent('Short');
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('too short');
    });

    it('should reject content with error patterns', () => {
      const result = validateContent('This page says 404 not found error 404');
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('error pattern');
    });
  });

  describe('extractMainContent', () => {
    it('should extract from main tag', () => {
      const html = '<div>Navigation</div><main>Content</main><footer>Footer</footer>';
      const content = extractMainContent(html);
      expect(content).toContain('Content');
      expect(content).not.toContain('Navigation');
      expect(content).not.toContain('Footer');
    });

    it('should extract from article tag', () => {
      const html = '<article>Article content</article>';
      const content = extractMainContent(html);
      expect(content).toContain('Article content');
    });

    it('should extract from content div', () => {
      const html = '<div class="content">Content</div>';
      const content = extractMainContent(html);
      expect(content).toContain('Content');
    });

    it('should fallback to body', () => {
      const html = '<body>Body content</body>';
      const content = extractMainContent(html);
      expect(content).toContain('Body content');
    });
  });
});
```

### 4.3 Security Integration Tests

**`test/integration/security/nvd.test.ts`:**
```typescript
import { describe, it, expect } from 'vitest';
import { searchNVD } from '@/security/nvd';

describe('security NVD integration', () => {
  it('should search NVD successfully', async () => {
    const result = await searchNVD('log4j', { maxResults: 5 });

    expect(result).toHaveProperty('vulnerabilities');
    expect(result).toHaveProperty('count');
    expect(Array.isArray(result.vulnerabilities)).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(0);

    if (result.vulnerabilities.length > 0) {
      const vuln = result.vulnerabilities[0];
      expect(vuln).toHaveProperty('id');
      expect(vuln).toHaveProperty('description');
    }
  }, 60000);

  it('should handle empty results', async () => {
    const result = await searchNVD('xyz123nonexistentvulnxyz789', { maxResults: 5 });

    expect(result).toHaveProperty('vulnerabilities');
    expect(result).toHaveProperty('count');
    expect(result.vulnerabilities).toEqual([]);
    expect(result.count).toBe(0);
  }, 60000);

  it('should filter by severity', async () => {
    const result = await searchNVD('linux', { severity: 'HIGH', maxResults: 10 });

    expect(result).toHaveProperty('vulnerabilities');
    if (result.vulnerabilities.length > 0) {
      result.vulnerabilities.forEach((vuln) => {
        expect(['HIGH', 'CRITICAL']).toContain(vuln.severity);
      });
    }
  }, 60000);

  it('should handle network errors gracefully', async () => {
    // This test verifies error handling
    // In real scenario, we'd mock network failure
    const result = await searchNVD('test', { maxResults: 1 });
    expect(result).toBeDefined();
  }, 60000);
});
```

### 4.4 Infrastructure Integration Tests

**`test/integration/infrastructure/docker.test.ts`:**
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { DockerSearxngManager } from '@/infrastructure/searxng-manager';
import { createLogger } from '@/logger';

describe('docker infrastructure integration', () => {
  let container: StartedTestContainer;
  let manager: DockerSearxngManager;

  beforeAll(async () => {
    // Start a test container (not SearXNG, just a simple web server)
    container = await new GenericContainer('nginx')
      .withExposedPorts(80)
      .start();

    manager = new DockerSearxngManager(
      createLogger(),
      {
        containerName: 'test-searxng',
        port: 8080,
        networkName: 'test-network',
      }
    );
  }, 60000);

  afterAll(async () => {
    await container.stop();
  }, 30000);

  it('should create network', async () => {
    // This test verifies Docker network operations
    const network = await manager.createNetwork('test-network-integration');
    expect(network).toBeDefined();
    await manager.removeNetwork('test-network-integration');
  }, 30000);

  it('should check container status', async () => {
    const status = await manager.getStatus();
    expect(status).toBeDefined();
  }, 10000);
});
```

---

## Phase 5: End-to-End Tests (Day 18-20)

### 5.1 Orchestration E2E Tests

**`test/e2e/orchestration/research.test.ts`:**
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startSearxngContainer } from '@test/helpers/test-containers';
import { createResearchTool } from '@/tool';

describe('research orchestration e2e', () => {
  let tool: ReturnType<typeof createResearchTool>;
  let mockContext: any;

  beforeAll(async () => {
    const container = await startSearxngContainer();
    const url = `http://${container.getHost()}:${container.getMappedPort(8080)}`;

    tool = createResearchTool();

    mockContext = {
      model: { id: 'test-model' },
      modelRegistry: {
        getAll: () => [{ id: 'test-model' }],
      },
      ui: {
        setWidget: () => {},
      },
      sessionId: 'test-session',
    };
  }, 60000);

  afterAll(async () => {
    // Cleanup
  }, 30000);

  it('should execute basic research', async () => {
    const result = await tool.execute(
      'test-call-1',
      { query: 'What is test-driven development?' },
      new AbortController().signal,
      () => {},
      mockContext
    );

    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
  }, 120000);

  it('should handle empty query', async () => {
    const result = await tool.execute(
      'test-call-2',
      { query: '' },
      new AbortController().signal,
      () => {},
      mockContext
    );

    expect(result.content[0].text).toContain('Error: query is required');
  }, 10000);

  it('should handle missing model', async () => {
    const noModelContext = { ...mockContext, model: null };
    const result = await tool.execute(
      'test-call-3',
      { query: 'test' },
      new AbortController().signal,
      () => {},
      noModelContext
    );

    expect(result.content[0].text).toContain('Error: No model selected');
  }, 10000);
});
```

---

## Phase 6: Test Coverage and Quality (Day 21-22)

### 6.1 Coverage Goals

**Target Coverage:**
- Statements: 85%+
- Branches: 80%+
- Functions: 85%+
- Lines: 85%+

**Coverage by Module:**
```
config.ts:                    100% (pure functions)
utils/text-utils.ts:          100% (pure functions)
utils/session-state.ts:       100% (pure functions)
stackexchange/queries.ts:     100% (pure functions)
stackexchange/output/*:      100% (pure functions)
tui/research-panel.ts:        90% (render functions)
security/index.ts:            85% (orchestrator)
security/nvd.ts:               80% (HTTP client)
web-research/html-processor.ts: 90% (pure functions)
web-research/search.ts:       80% (HTTP client)
tool.ts:                      75% (orchestration)
delegate-tool.ts:             70% (complex concurrency)
```

### 6.2 CI/CD Integration

**`.github/workflows/test.yml`:**
```yaml
name: Tests

on: [push, pull_request]

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run test:unit -- --coverage
      - uses: codecov/codecov-action@v4
        with:
          files: ./coverage/lcov.info
          flags: unit

  integration:
    runs-on: ubuntu-latest
    services:
      docker:
        image: docker:dind
        options: --privileged
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run test:integration -- --coverage
      - uses: codecov/codecov-action@v4
        with:
          files: ./coverage/lcov.info
          flags: integration
```

### 6.3 Test Quality Gates

**Pre-commit Hooks:**
```json
{
  "husky": {
    "hooks": {
      "pre-commit": "npm run test:unit && npm run lint",
      "pre-push": "npm run test"
    }
  }
}
```

---

## Summary of All Changes

### Files to Create:

**Test Infrastructure:**
1. `vitest.config.ts`
2. `vitest.config.unit.ts`
3. `vitest.config.integration.ts`
4. `test/setup/unit.ts`
5. `test/setup/integration.ts`
6. `test/helpers/module-registry.ts`
7. `test/helpers/test-containers.ts`
8. `test/types/vitest.d.ts`

**Interfaces:**
9. `src/interfaces/logger.ts`
10. `src/interfaces/http-client.ts`
11. `src/interfaces/docker-manager.ts`
12. `src/interfaces/browser-manager.ts`
13. `src/interfaces/file-system.ts`
14. `src/interfaces/state-manager.ts`

**Refactored Modules:**
15. `src/logger/logger.ts`
16. `src/logger/console-suppressor.ts`
17. `src/logger/factory.ts`
18. `src/logger/index.ts` (update)
19. `src/lifecycle/searxng-lifecycle.ts`
20. `src/lifecycle/factory.ts`
21. `src/web-research/browser-manager.ts`
22. `src/web-research/html-processor.ts`
23. `src/web-research/content-validator.ts` (if separate)
24. `src/orchestration/researcher-pool.ts`
25. `src/orchestration/session-factory.ts`
26. `src/orchestration/timeout-manager.ts`

**Test Files:**
27. `test/unit/config.test.ts`
28. `test/unit/utils/text-utils.test.ts`
29. `test/unit/utils/session-state.test.ts`
30. `test/unit/stackexchange/queries.test.ts`
31. `test/unit/stackexchange/output/compact.test.ts`
32. `test/unit/security/types.test.ts`
33. `test/unit/tui/research-panel.test.ts`
34. `test/integration/web-research/search.test.ts`
35. `test/integration/web-research/scrapers.test.ts`
36. `test/integration/security/nvd.test.ts`
37. `test/integration/infrastructure/docker.test.ts`
38. `test/e2e/orchestration/research.test.ts`

### Files to Modify:

**Core:**
1. `package.json` - Add test dependencies and scripts
2. `tsconfig.json` - Add test path mappings
3. `src/logger.ts` - Refactor to use new structure
4. `src/searxng-lifecycle.ts` - Refactor to use new structure
5. `src/web-research/scrapers.ts` - Refactor to use browser manager
6. `src/web-research/search.ts` - Add HTTP client injection
7. `src/orchestration/delegate-tool.ts` - Use researcher pool
8. `src/tool.ts` - Use dependency injection
9. `src/security/nvd.ts` - Add HTTP client injection
10. `src/security/cisa-kev.ts` - Add HTTP client injection
11. `src/security/github-advisories.ts` - Add HTTP client injection
12. `src/security/osv.ts` - Add HTTP client injection
13. `src/stackexchange/rest-client.ts` - Add HTTP client injection

---

## Execution Timeline

**Week 1 (Days 1-5):**
- Day 1: Test infrastructure setup
- Day 2-3: Interface extraction
- Day 4-5: Core module refactoring (logger, lifecycle)

**Week 2 (Days 6-10):**
- Day 6-7: Web research module refactoring
- Day 8-9: Orchestration module refactoring
- Day 10: Security module refactoring

**Week 3 (Days 11-15):**
- Day 11-12: Unit tests for pure functions
- Day 13-14: Integration tests with test containers
- Day 15: E2E tests

**Week 4 (Days 16-20):**
- Day 16-17: Coverage improvements
- Day 18: CI/CD setup
- Day 19-20: Documentation and cleanup

---

## Key Principles

1. **Minimal Mocking**: Only mock external dependencies that truly cannot run in tests
2. **Test Containers**: Use real Docker containers for integration tests
3. **Pure Functions**: Extract pure logic from side effects for easy testing
4. **Dependency Injection**: Allow injecting dependencies for testing
5. **Clear Separation**: Separate unit, integration, and E2E tests
6. **Fast Feedback**: Unit tests should run in seconds, integration in minutes
7. **Reliable Tests**: Tests should be deterministic and not flaky

---

## Next Steps

1. Review this plan with the team
2. Prioritize modules based on business value
3. Set up test infrastructure first (Day 1)
4. Start with highest ROI tests (pure functions)
5. Incrementally add integration tests
6. Monitor coverage and adjust as needed
