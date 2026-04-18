import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runCleanup: vi.fn(async () => undefined),
  createResearchTool: vi.fn(() => ({ name: 'research' })),
  checkDockerAvailability: vi.fn(async () => ({ installed: true, running: true })),
}));

vi.mock('../../src/tool.ts', () => ({
  createResearchTool: mocks.createResearchTool,
}));

vi.mock('../../src/logger.ts', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isVerboseFromEnv: vi.fn(() => false),
  getDefaultDebugLogPathTemplate: vi.fn(() => '/tmp/pi-research-debug-{hash}.log'),
}));

vi.mock('../../src/infrastructure/searxng-lifecycle.ts', () => ({
  checkDockerAvailability: mocks.checkDockerAvailability,
}));

vi.mock('../../src/utils/shutdown-manager.ts', () => ({
  shutdownManager: {
    runCleanup: mocks.runCleanup,
  },
}));

import registerExtension from '../../src/index.ts';

type SessionHandler = (...args: any[]) => any;

function createPiMock() {
  const handlers = new Map<string, SessionHandler>();

  return {
    handlers,
    pi: {
      on: vi.fn((event: string, handler: SessionHandler) => {
        handlers.set(event, handler);
      }),
      registerTool: vi.fn(),
    },
  };
}

describe('extension entrypoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers session_shutdown cleanup through pi lifecycle hooks', async () => {
    const { pi, handlers } = createPiMock();

    registerExtension(pi as any);

    expect(mocks.createResearchTool).toHaveBeenCalledTimes(1);
    expect(pi.registerTool).toHaveBeenCalledWith({ name: 'research' });
    expect(handlers.has('session_shutdown')).toBe(true);

    await handlers.get('session_shutdown')?.();

    expect(mocks.runCleanup).toHaveBeenCalledWith('session_shutdown');
  });

  it('does not mutate console methods during extension registration', () => {
    const { pi } = createPiMock();
    const originalConsole = {
      log: console.log,
      info: console.info,
      error: console.error,
      warn: console.warn,
      debug: console.debug,
    };

    registerExtension(pi as any);

    expect(console.log).toBe(originalConsole.log);
    expect(console.info).toBe(originalConsole.info);
    expect(console.error).toBe(originalConsole.error);
    expect(console.warn).toBe(originalConsole.warn);
    expect(console.debug).toBe(originalConsole.debug);
  });

  it('keeps session_start Docker check behavior intact', async () => {
    const { pi, handlers } = createPiMock();
    const notify = vi.fn();

    registerExtension(pi as any);

    await handlers.get('session_start')?.({}, { ui: { notify } });

    expect(mocks.checkDockerAvailability).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });
});
