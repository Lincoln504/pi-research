/**
 * Master-side cluster IPC guard tests.
 *
 * Reproduces the crash mechanism behind the 2026-06-30 host exits: poolifier
 * dispatches to a worker whose channel just closed → `write EPIPE` is re-emitted
 * as an 'error' on the cluster.Worker. During terminate() poolifier strips the
 * worker's listeners, so without a persistent master-side guard the next EPIPE
 * lands on a listenerless EventEmitter and throws → uncaughtException → host exit.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// A controllable fake of node:cluster's primary side. The guard registers a
// 'fork' listener and iterates `workers`; we drive forks by emitting 'fork'.
// Built inside vi.hoisted so the mock factory (hoisted to top) can reference it.
const { fakeCluster } = vi.hoisted(() => {
  const { EventEmitter: EE } = require('node:events');
  class FakeCluster extends EE {
    isWorker = false;
    worker = undefined;
    workers: Record<string, unknown> = {};
  }
  return { fakeCluster: new FakeCluster() };
});

vi.mock('node:cluster', () => ({ default: fakeCluster }));

import {
  setupMasterIpcErrorHandler,
  __resetMasterIpcGuardForTests,
  isBenignClusterIpcError,
} from '../../../src/infrastructure/browser/thread-worker-lifecycle.ts';

/** A minimal stand-in for a cluster.Worker + its underlying ChildProcess. */
function makeFakeWorker() {
  const worker: any = new EventEmitter();
  worker.process = new EventEmitter();
  return worker;
}

/** Emit on an EventEmitter, returning the thrown error (if any) instead of propagating. */
function emitCapture(emitter: EventEmitter, event: string, payload: unknown): unknown {
  try {
    emitter.emit(event, payload);
    return undefined;
  } catch (e) {
    return e;
  }
}

describe('master cluster IPC guard', () => {
  beforeEach(() => {
    __resetMasterIpcGuardForTests();
    fakeCluster.removeAllListeners();
    fakeCluster.workers = {};
  });

  it('classifies benign IPC errors and rejects real ones', () => {
    expect(isBenignClusterIpcError({ code: 'EPIPE' })).toBe(true);
    expect(isBenignClusterIpcError({ code: 'ERR_IPC_CHANNEL_CLOSED' })).toBe(true);
    expect(isBenignClusterIpcError({ code: 'ECONNRESET' })).toBe(true);
    expect(isBenignClusterIpcError(new Error('write EPIPE'))).toBe(true);
    expect(isBenignClusterIpcError(new Error('channel closed'))).toBe(true);
    expect(isBenignClusterIpcError(new Error('boom'))).toBe(false);
    expect(isBenignClusterIpcError(null)).toBe(false);
  });

  it('swallows a write EPIPE emitted on a forked worker (no throw)', () => {
    setupMasterIpcErrorHandler();
    const worker = makeFakeWorker();
    fakeCluster.emit('fork', worker);

    expect(worker.listenerCount('error')).toBeGreaterThan(0);
    const err: any = new Error('write EPIPE');
    err.code = 'EPIPE';
    expect(emitCapture(worker, 'error', err)).toBeUndefined();
  });

  it('re-arms the guard after poolifier calls worker.removeAllListeners()', () => {
    setupMasterIpcErrorHandler();
    const worker = makeFakeWorker();
    fakeCluster.emit('fork', worker);

    // Simulate poolifier terminate(): strip every listener, then a late channel
    // write completes with EPIPE. Without re-arm this throws (the original bug).
    worker.removeAllListeners();
    expect(worker.listenerCount('error')).toBeGreaterThan(0);

    const err: any = new Error('write EPIPE');
    err.code = 'EPIPE';
    expect(emitCapture(worker, 'error', err)).toBeUndefined();
  });

  it('does not throw on a non-benign worker error either (poolifier handles recovery)', () => {
    setupMasterIpcErrorHandler();
    const worker = makeFakeWorker();
    fakeCluster.emit('fork', worker);
    expect(emitCapture(worker, 'error', new Error('genuinely broken'))).toBeUndefined();
  });

  it('guards workers already forked before installation', () => {
    const preexisting = makeFakeWorker();
    fakeCluster.workers = { '1': preexisting };
    setupMasterIpcErrorHandler();
    expect(preexisting.listenerCount('error')).toBeGreaterThan(0);
  });

  it('is idempotent — a second install does not double-guard a worker', () => {
    setupMasterIpcErrorHandler();
    setupMasterIpcErrorHandler();
    const worker = makeFakeWorker();
    fakeCluster.emit('fork', worker);
    // exactly one fork listener installed, so exactly one error guard per worker
    expect(worker.listenerCount('error')).toBe(1);
  });
});
