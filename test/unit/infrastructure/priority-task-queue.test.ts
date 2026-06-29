import { describe, it, expect } from 'vitest';
import { PriorityTaskQueue } from '../../../src/infrastructure/browser/priority-task-queue.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('PriorityTaskQueue', () => {
  it('rejects and frees the slot when a RUNNING task is aborted', async () => {
    const queue = new PriorityTaskQueue(1); // single slot
    const controller = new AbortController();

    // A task that never settles on its own — only an abort can end the wait.
    let resolveStuck: (() => void) | undefined;
    const stuckFn = () => new Promise<string>((resolve) => { resolveStuck = () => resolve('late'); });

    const aborted = queue.enqueue('scrape', stuckFn, controller.signal);
    await tick(); // let it start running (occupies the only slot)
    expect(queue.getStats().activeCount).toBe(1);

    // A second task queued behind it must not run while the slot is held.
    let secondRan = false;
    const second = queue.enqueue('search', async () => { secondRan = true; return 'ok'; });
    await tick();
    expect(secondRan).toBe(false);

    // Abort the running task: its promise rejects and the slot frees immediately.
    controller.abort();
    await expect(aborted).rejects.toThrow(/aborted while running/);

    await tick();
    await expect(second).resolves.toBe('ok');
    expect(secondRan).toBe(true);

    // The orphaned fn settling late must not corrupt the active count.
    resolveStuck?.();
    await tick();
    expect(queue.getStats().activeCount).toBe(0);
  });

  it('runs a normal task to completion when not aborted', async () => {
    const queue = new PriorityTaskQueue(2);
    const result = await queue.enqueue('search', async () => 42);
    expect(result).toBe(42);
    expect(queue.getStats().activeCount).toBe(0);
  });

  it('still rejects a task aborted while queued', async () => {
    const queue = new PriorityTaskQueue(1);
    const blocker = new AbortController();
    // Occupy the slot with a stuck task.
    queue.enqueue('scrape', () => new Promise<void>(() => {}), blocker.signal);
    await tick();

    const qController = new AbortController();
    const queued = queue.enqueue('scrape', async () => 'never', qController.signal);
    await tick();
    qController.abort();
    await expect(queued).rejects.toThrow(/aborted while in queue/);
  });
});
