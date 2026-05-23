import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// mockExecuteFn is module-level so each test can configure its own behavior
// while the vi.mock factory (hoisted at load time) references it by closure.
const mockExecuteFn = vi.fn();
const mockDestroy = vi.fn(async () => {});

vi.mock('poolifier', () => {
    class MockPool {
        execute = mockExecuteFn;
        destroy = mockDestroy;
    }
    return {
        FixedClusterPool: MockPool,
        WorkerChoiceStrategies: { ROUND_ROBIN: 'ROUND_ROBIN' },
    };
});

vi.mock('../../../src/infrastructure/state-manager.ts', () => {
    let _instance: any = null;
    class MockStateManager {
        getBrowserServer = vi.fn(async () => null);
        updateState = vi.fn(async (fn: any) => fn({ browserServer: null }));
        isPidAlive = vi.fn(async () => false);
        clearBrowserServer = vi.fn(async () => {});
        readState = vi.fn(async () => ({ sessions: {} }));
    }
    return {
        StateManager: MockStateManager,
        getSharedStateManager: () => {
            if (!_instance) _instance = new MockStateManager();
            return _instance;
        },
    };
});

vi.mock('../../../src/config.ts', () => ({
    getConfig: vi.fn(() => ({
        WORKER_THREADS: 2,
        MAX_CONCURRENT_RESEARCHERS: 1,
        WORKER_CONCURRENCY: 1,
    })),
}));

import { runBrowserTask, stopBrowserManager } from '../../../src/infrastructure/browser-manager.ts';
import { resetAllInternalState } from '../../../src/core/internal-state.ts';

describe('BrowserManager retry behavior', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetAllInternalState();
    });

    afterEach(async () => {
        await stopBrowserManager();
        resetAllInternalState();
    });

    it('retries once on a transient ECONNRESET and succeeds', async () => {
        mockExecuteFn
            .mockRejectedValueOnce(new Error('ECONNRESET: socket hang up'))
            .mockResolvedValueOnce({ html: '<html>ok</html>' });

        const result = await runBrowserTask('https://example.com', 'scrape');

        expect(result).toEqual({ html: '<html>ok</html>' });
        expect(mockExecuteFn).toHaveBeenCalledTimes(2);
    }, 10000);

    it('throws after exhausting all retries', async () => {
        mockExecuteFn.mockRejectedValue(new Error('ECONNREFUSED: connection refused'));

        await expect(runBrowserTask('https://example.com', 'scrape'))
            .rejects.toThrow('ECONNREFUSED');

        expect(mockExecuteFn).toHaveBeenCalledTimes(2);
    }, 10000);

    it('does not retry non-transient errors', async () => {
        mockExecuteFn.mockRejectedValue(new Error('Fatal parse error: invalid JSON'));

        await expect(runBrowserTask('https://example.com', 'scrape'))
            .rejects.toThrow('Fatal parse error: invalid JSON');

        expect(mockExecuteFn).toHaveBeenCalledTimes(1);
    }, 10000);
});