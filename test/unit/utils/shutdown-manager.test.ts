import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/logger.ts', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { logger } from '../../../src/logger.ts';
import { ShutdownManager } from '../../../src/utils/shutdown-manager.ts';

describe('ShutdownManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs cleanup tasks in reverse registration order', async () => {
    const manager = new ShutdownManager();
    const calls: string[] = [];

    manager.register(() => {
      calls.push('first');
    });
    manager.register(() => {
      calls.push('second');
    });

    await manager.runCleanup('test');

    expect(calls).toEqual(['second', 'first']);
  });

  it('deduplicates task registrations and can run a fresh cleanup cycle later', async () => {
    const manager = new ShutdownManager();
    const firstTask = vi.fn();
    const secondTask = vi.fn();

    manager.register(firstTask);
    manager.register(firstTask);

    await manager.runCleanup('initial');
    await manager.runCleanup('repeat-without-new-tasks');

    manager.register(secondTask);
    await manager.runCleanup('second-cycle');

    expect(firstTask).toHaveBeenCalledTimes(1);
    expect(secondTask).toHaveBeenCalledTimes(1);
  });

  it('continues cleanup when a task throws', async () => {
    const manager = new ShutdownManager();
    const afterError = vi.fn();

    manager.register(() => {
      afterError();
    });
    manager.register(() => {
      throw new Error('cleanup failed');
    });

    await manager.runCleanup('error-path');

    expect(afterError).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it('does not invoke process exit or install process event handlers during cleanup', async () => {
    const manager = new ShutdownManager();
    const processOnSpy = vi.spyOn(process, 'on');
    const processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    manager.register(() => {});

    await manager.runCleanup('process-safety');

    expect(processOnSpy).not.toHaveBeenCalled();
    expect(processExitSpy).not.toHaveBeenCalled();
  });
});
