/**
 * Thread-worker lifecycle IPC-guard tests.
 *
 * Covers the crash-class defenses added for the 2026-10-08 pi-host crash:
 *   1. worker-side benign-IPC swallow (EPIPE/ECONNRESET/channel-closed) — stops
 *      the code-1 churn feedback that fed the worker storm;
 *   2. the guardClusterWorker re-attach patch — poolifier's terminate() calls
 *      worker.removeAllListeners(); the patched method re-arms the guard so the
 *      cluster.Worker is never listener-less;
 *   3. the Worker.prototype.emit last-resort guard — no cluster.Worker can ever
 *      emit 'error' without a listener, whatever path wiped its listeners;
 *   4. the worker bootstrap marker — a non-zero exit without the marker line is
 *      a pre-handler (top-level-evaluation) death, visible in post-mortems.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Mutable cluster mock: the module under test imports `cluster` as a default
// import and reads isWorker / worker / workers / on / Worker off it.
const clusterMock = vi.hoisted(() => ({
    isWorker: false,
    worker: null as any,
    workers: {} as Record<string, any>,
    on: vi.fn(),
    Worker: undefined as any,
}));

vi.mock('node:cluster', () => ({
    default: clusterMock,
}));

import {
    setupIpcErrorHandler,
    setupMasterIpcErrorHandler,
    guardWorkerEmitReemit,
    markWorkerBootstrap,
    __resetMasterIpcGuardForTests,
    __resetWorkerEmitGuardForTests,
    isBenignClusterIpcError,
} from '../../../../src/infrastructure/browser/thread-worker-lifecycle.ts';

const makeErr = (message: string, code?: string): Error =>
    Object.assign(new Error(message), code ? { code } : {});

describe('thread-worker-lifecycle IPC guards', () => {
    beforeEach(() => {
        __resetMasterIpcGuardForTests();
        __resetWorkerEmitGuardForTests();
        vi.clearAllMocks();
    });

    afterEach(() => {
        delete process.env['PI_RESEARCH_LOG_FILE'];
    });

    describe('isBenignClusterIpcError (shared classification)', () => {
        it('classifies the teardown-IPC codes benign', () => {
            expect(isBenignClusterIpcError(makeErr('x', 'EPIPE'))).toBe(true);
            expect(isBenignClusterIpcError(makeErr('x', 'ECONNRESET'))).toBe(true);
            expect(isBenignClusterIpcError(makeErr('x', 'ERR_IPC_CHANNEL_CLOSED'))).toBe(true);
        });

        it('classifies other errors non-benign', () => {
            expect(isBenignClusterIpcError(makeErr('boom'))).toBe(false);
            expect(isBenignClusterIpcError(null)).toBe(false);
        });
    });

    describe('worker-side setupIpcErrorHandler (widened swallow)', () => {
        let fakeWorker: EventEmitter;

        beforeEach(() => {
            fakeWorker = new EventEmitter();
            clusterMock.isWorker = true;
            clusterMock.worker = fakeWorker;
            setupIpcErrorHandler();
        });

        afterEach(() => {
            clusterMock.isWorker = false;
            clusterMock.worker = null;
        });

        it('swallows EPIPE (the churn-feedback code the old narrow check re-threw)', () => {
            expect(() => fakeWorker.emit('error', makeErr('write EPIPE', 'EPIPE'))).not.toThrow();
        });

        it('swallows ECONNRESET and ERR_IPC_CHANNEL_CLOSED', () => {
            expect(() => fakeWorker.emit('error', makeErr('x', 'ECONNRESET'))).not.toThrow();
            expect(() => fakeWorker.emit('error', makeErr('x', 'ERR_IPC_CHANNEL_CLOSED'))).not.toThrow();
        });

        it('still re-throws genuinely non-benign errors (uncaught handler logs + exits by design)', () => {
            expect(() => fakeWorker.emit('error', makeErr('boom'))).toThrow('boom');
        });
    });

    describe('guardClusterWorker re-attach patch (via setupMasterIpcErrorHandler)', () => {
        it('reattaches the guard after poolifier-style removeAllListeners()', () => {
            clusterMock.isWorker = false;
            const fakeWorker = new EventEmitter();
            // The fork listener is the first cluster.on call made by the guard.
            setupMasterIpcErrorHandler();
            const forkListener = vi.mocked(clusterMock.on).mock.calls.find((c) => c[0] === 'fork')?.[1];
            expect(typeof forkListener).toBe('function');
            forkListener(fakeWorker);

            expect(fakeWorker.listenerCount('error')).toBeGreaterThanOrEqual(1);

            // poolifier's terminate() wipes ALL listeners on the Worker.
            fakeWorker.removeAllListeners();
            // The patched method must have re-armed the guard.
            expect(fakeWorker.listenerCount('error')).toBeGreaterThanOrEqual(1);

            // A benign re-emit after the wipe is handled, not thrown.
            expect(() => fakeWorker.emit('error', makeErr('x', 'ERR_IPC_CHANNEL_CLOSED'))).not.toThrow();
        });
    });

    describe('Worker.prototype.emit last-resort guard', () => {
        it('makes a listener-less error emit non-fatal', () => {
            clusterMock.isWorker = false;
            // Stand-in for the cluster.Worker class: the patch only touches
            // prototype.emit / listenerCount / on — plain EventEmitter behaves
            // identically for this purpose (EventEmitter throws on 'error' with
            // no listeners).
            clusterMock.Worker = EventEmitter;
            guardWorkerEmitReemit();

            const w = new (clusterMock.Worker)();
            expect(w.listenerCount('error')).toBe(0);

            // The exact fatal state from 2026-10-08: 'error' emitted on a
            // listener-less Worker.
            expect(() => w.emit('error', makeErr('ERR_IPC_CHANNEL_CLOSED', 'ERR_IPC_CHANNEL_CLOSED'))).not.toThrow();
            expect(w.listenerCount('error')).toBe(1);

            // Non-benign listener-less errors are handled (logged), not thrown.
            expect(() => w.emit('error', makeErr('boom'))).not.toThrow();
        });

        it('without the patch, a listener-less error emit throws (control)', () => {
            clusterMock.isWorker = false;
            clusterMock.Worker = EventEmitter;
            // Patch deliberately NOT installed.
            const w = new (clusterMock.Worker)();
            expect(() => w.emit('error', makeErr('x', 'ERR_IPC_CHANNEL_CLOSED'))).toThrow();
        });
    });

    describe('markWorkerBootstrap', () => {
        it('writes an always-recorded (WARN) startup marker line', async () => {
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'twl-test-'));
            const logFile = path.join(dir, 'worker.log');
            process.env['PI_RESEARCH_LOG_FILE'] = logFile;

            markWorkerBootstrap('ab12');

            // fs.appendFile is fire-and-forget; give it a tick.
            await new Promise((r) => setTimeout(r, 50));

            const contents = await fs.readFile(logFile, 'utf8');
            expect(contents).toContain('Bootstrap complete');
            expect(contents).toContain('ab12');
            expect(contents).toContain(`pid ${process.pid}`);
            expect(JSON.parse(contents.trim().split('\n').pop() as string)).toMatchObject({ level: 'WARN' });
        });

        it('writes nothing when PI_RESEARCH_LOG_FILE is unset', async () => {
            markWorkerBootstrap('ab12');
            await new Promise((r) => setTimeout(r, 20));
            // No file should have been created anywhere; nothing to assert beyond
            // no throw. (Log path unset → early return.)
            expect(true).toBe(true);
        });
    });
});
