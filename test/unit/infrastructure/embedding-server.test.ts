import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { EmbeddingServer, _SerialQueue, getEmbeddingServerAuthSecret } from '../../../src/infrastructure/embedding/embedding-server';
import { hasWebGpuFallback, resetWebGpuFallbackFlag } from '../../../src/knowledge/embedder-utils';
import type { IStateManager } from '../../../src/core/interfaces/state-manager-interfaces';
import type { Embedder } from '../../../src/knowledge/embedder';

describe('EmbeddingServer', () => {
  let mockStateManager: IStateManager;
  let mockEmbedder: Embedder;
  let server: EmbeddingServer;
  const serverId = 'test-server-id';

  beforeEach(() => {
    mockStateManager = {
      getEmbeddingServer: vi.fn(),
      clearEmbeddingServer: vi.fn(),
      // Add other required IStateManager methods as necessary, 
      // or cast to any for this test if they aren't called.
    } as any;

    mockEmbedder = {} as any;
    server = new EmbeddingServer(mockEmbedder, mockStateManager, serverId);
  });

  describe('getEmbeddingServerWithRetry', () => {
    it('should return server info immediately if available', async () => {
      const serverInfo = { port: 8080, pid: 123, serverId };
      vi.mocked(mockStateManager.getEmbeddingServer).mockResolvedValue(serverInfo);

      const result = await (server as any).getEmbeddingServerWithRetry(2, 10);
      expect(result).toEqual(serverInfo);
      expect(mockStateManager.getEmbeddingServer).toHaveBeenCalledTimes(1);
    });

    it('should retry if the first call returns null', async () => {
      const serverInfo = { port: 8080, pid: 123, serverId };
      vi.mocked(mockStateManager.getEmbeddingServer)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(serverInfo);

      const result = await (server as any).getEmbeddingServerWithRetry(2, 10);
      expect(result).toEqual(serverInfo);
      expect(mockStateManager.getEmbeddingServer).toHaveBeenCalledTimes(2);
    });

    it('should return null if retries are exhausted', async () => {
      vi.mocked(mockStateManager.getEmbeddingServer).mockResolvedValue(null);

      const result = await (server as any).getEmbeddingServerWithRetry(2, 10);
      expect(result).toBeNull();
      expect(mockStateManager.getEmbeddingServer).toHaveBeenCalledTimes(3);
    });
  });

  describe('SerialQueue — GPU serialization invariant', () => {
    it('never runs two enqueued tasks concurrently', async () => {
      const q = new _SerialQueue(200, 1000);
      let active = 0;
      let maxActive = 0;
      const task = (ms: number) => () => new Promise<void>((r) => {
        active++;
        maxActive = Math.max(maxActive, active);
        setTimeout(() => { active--; r(); }, ms);
      });
      await Promise.all([q.enqueue(task(30)), q.enqueue(task(10)), q.enqueue(task(20))]);
      expect(maxActive).toBe(1);
    });

    it('holds the queue slot past a caller timeout until the timed-out work settles', async () => {
      // 30ms timeout, but the first task's real work runs ~120ms. The caller gets a
      // timeout rejection promptly, yet the next task must NOT start (which would be
      // concurrent GPU inference) until the first task's work actually completes.
      const q = new _SerialQueue(200, 30);
      let active = 0;
      let maxActive = 0;
      let secondStarted = false;
      const slow = () => new Promise<void>((r) => {
        active++;
        maxActive = Math.max(maxActive, active);
        setTimeout(() => { active--; r(); }, 120);
      });
      const quick = () => new Promise<void>((r) => {
        secondStarted = true;
        active++;
        maxActive = Math.max(maxActive, active);
        active--;
        r();
      });

      const pA = q.enqueue(slow).catch((e: unknown) => e);
      const pB = q.enqueue(quick);

      const a = await pA;
      expect(a).toBeInstanceOf(Error);
      expect((a as Error).message).toContain('timed out');
      // At the moment the caller's promise rejected (~30ms), the second task must
      // not have started — the first task's inference is still holding the slot.
      expect(secondStarted).toBe(false);

      await pB;
      expect(maxActive).toBe(1);
    });

    it('poisons the queue on a permanently-hung task and fast-fails all callers without running the next', async () => {
      vi.useFakeTimers();
      try {
        let secondStarted = false;
        const onPoison = vi.fn();
        // soft caller timeout 1000ms; hard deadline 2000ms (armed after the soft timeout).
        const q = new _SerialQueue(200, 1000, 2000, onPoison);

        const hung = () => new Promise<void>(() => { /* never settles — simulates a device-lost native stall */ });
        const second = () => { secondStarted = true; return Promise.resolve(); };

        const pA = q.enqueue(hung).catch((e: unknown) => e as Error);
        const pB = q.enqueue(second).catch((e: unknown) => e as Error);

        // Soft timeout fires → caller A is rejected promptly, but the slot is held
        // (the hung work is still "running") and the queue is NOT yet poisoned.
        await vi.advanceTimersByTimeAsync(1000);
        const a = await pA as Error;
        expect(a).toBeInstanceOf(Error);
        expect(a.message).toContain('timed out');
        expect(q.isPoisoned()).toBe(false);
        expect(secondStarted).toBe(false);

        // Hard deadline elapses while the work is still unsettled → poison.
        await vi.advanceTimersByTimeAsync(2000);
        expect(q.isPoisoned()).toBe(true);
        expect(onPoison).toHaveBeenCalledOnce();

        // The queued task B is fast-failed with the poison error and NEVER ran
        // (running it would be concurrent GPU inference on the stuck context).
        const b = await pB as Error;
        expect(b).toBeInstanceOf(Error);
        expect(b.message).toContain('permanently hung');
        expect(secondStarted).toBe(false);

        // Any future enqueue fast-rejects immediately rather than hanging.
        await expect(q.enqueue(second)).rejects.toThrow('permanently hung');
        expect(secondStarted).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('handleRequest — headers-sent guard in the catch path', () => {
    it('destroys the response instead of writeHead(500) when headers were already sent', async () => {
      // res.end() throws AFTER res.writeHead(200) has already been called (a
      // socket torn down mid-response): the exact partially-sent-response case.
      // Pre-fix, the catch block's writeHead(500) threw ERR_HTTP_HEADERS_SENT
      // inside the async 'end' listener (an unhandledRejection in the leader
      // process).
      const embedder = { embed: vi.fn().mockResolvedValue(new Float32Array([1])) } as any;
      const s = new EmbeddingServer(embedder, mockStateManager, 'headers-sent-test');

      const req = new EventEmitter() as any;
      req.method = 'POST';
      req.url = '/embed';
      // Requests are authorized before the body is read, so these post-auth
      // paths must present the secret to reach the logic under test.
      req.headers = { 'x-embedding-auth': getEmbeddingServerAuthSecret() };
      req.resume = () => {};

      const res: any = {
        headersSent: false,
        writeHead: vi.fn(() => { res.headersSent = true; }),
        end: vi.fn(() => { throw new Error('socket torn down mid-response'); }),
        destroy: vi.fn(),
      };

      const done = (s as any).handleRequest(req, res);
      req.emit('data', Buffer.from(JSON.stringify({ text: 'hello' })));
      req.emit('end');
      await done; // must settle (finish() runs) without throwing

      expect(res.writeHead).toHaveBeenCalledTimes(1);
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
      expect(res.destroy).toHaveBeenCalledTimes(1);
      // res.end was the call that failed — the catch must not attempt a second
      // (headers-sent) writeHead/end pair on top of it.
      expect(res.end).toHaveBeenCalledTimes(1);
    });

    it('still writes a clean 500 when the failure happens before any header is sent', async () => {
      const embedder = { embed: vi.fn().mockRejectedValue(new Error('boom\nsecret stack line')) } as any;
      const s = new EmbeddingServer(embedder, mockStateManager, 'clean-500-test');

      const req = new EventEmitter() as any;
      req.method = 'POST';
      req.url = '/embed';
      // Requests are authorized before the body is read, so these post-auth
      // paths must present the secret to reach the logic under test.
      req.headers = { 'x-embedding-auth': getEmbeddingServerAuthSecret() };
      req.resume = () => {};

      const res: any = {
        headersSent: false,
        writeHead: vi.fn(() => { res.headersSent = true; }),
        end: vi.fn(),
        destroy: vi.fn(),
      };

      const done = (s as any).handleRequest(req, res);
      req.emit('data', Buffer.from(JSON.stringify({ text: 'hello' })));
      req.emit('end');
      await done;

      expect(res.writeHead).toHaveBeenCalledTimes(1);
      expect(res.writeHead).toHaveBeenCalledWith(500, expect.anything());
      expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: 'boom' }));
      expect(res.destroy).not.toHaveBeenCalled();
    });
  });

  describe('non-finite embedding guard on the HTTP path', () => {
    // Shared harness for handler-level requests (mirrors the headers-sent tests).
    const makeReqRes = (url: string, payload: unknown) => {
      const req = new EventEmitter() as any;
      req.method = 'POST';
      req.url = url;
      // Requests are authorized before the body is read, so these post-auth
      // paths must present the secret to reach the logic under test.
      req.headers = { 'x-embedding-auth': getEmbeddingServerAuthSecret() };
      req.resume = () => {};
      const res: any = {
        headersSent: false,
        writeHead: vi.fn(() => { res.headersSent = true; }),
        end: vi.fn(),
        destroy: vi.fn(),
      };
      const drive = (s: EmbeddingServer) => {
        const done = (s as any).handleRequest(req, res);
        req.emit('data', Buffer.from(JSON.stringify(payload)));
        req.emit('end');
        return done;
      };
      return { req, res, drive };
    };

    it('fails /embed with an error response instead of serializing NaN (JSON null → client 0)', async () => {
      // A device-lost mid-inference yields NaN entries. Pre-fix the server
      // serialized them (JSON.stringify(NaN) → null) and the client's
      // new Float32Array coerced null → 0 — a silently part-zeroed vector that
      // passed the store's finite gate into the ANN index.
      const embedder = { embed: vi.fn().mockResolvedValue(new Float32Array([0.1, NaN, 0.3])) } as any;
      const s = new EmbeddingServer(embedder, mockStateManager, 'nan-embed-test');

      const { res, drive } = makeReqRes('/embed', { text: 'hello' });
      await drive(s);

      expect(res.writeHead).toHaveBeenCalledTimes(1);
      expect(res.writeHead).toHaveBeenCalledWith(500, expect.anything());
      const body = JSON.parse(res.end.mock.calls[0][0]);
      expect(body.error).toMatch(/non-finite/i);
    });

    it('fails /embedMany when ANY vector in the batch carries a non-finite entry', async () => {
      const embedder = {
        embedMany: vi.fn().mockResolvedValue([
          new Float32Array([0.1, 0.2]),
          new Float32Array([Infinity, 0.2]),
        ]),
      } as any;
      const s = new EmbeddingServer(embedder, mockStateManager, 'nan-embedmany-test');

      const { res, drive } = makeReqRes('/embedMany', { texts: ['a', 'b'] });
      await drive(s);

      expect(res.writeHead).toHaveBeenCalledWith(500, expect.anything());
      const body = JSON.parse(res.end.mock.calls[0][0]);
      expect(body.error).toMatch(/non-finite/i);
    });

    it('still serves fully finite vectors untouched', async () => {
      const embedder = { embed: vi.fn().mockResolvedValue(new Float32Array([0.5, -0.5])) } as any;
      const s = new EmbeddingServer(embedder, mockStateManager, 'finite-embed-test');

      const { res, drive } = makeReqRes('/embed', { text: 'hello' });
      await drive(s);

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
      const body = JSON.parse(res.end.mock.calls[0][0]);
      expect(body.data).toEqual([0.5, -0.5]);
    });
  });

  describe('queue poisoning', () => {
    it('latches the process-wide WebGPU fallback so a same-process re-election cannot re-init WebGPU beside the wedged GPU call', async () => {
      resetWebGpuFallbackFlag();
      try {
        const onPoison = vi.fn();
        const sm = {
          getEmbeddingServer: vi.fn().mockResolvedValue(null),
          clearEmbeddingServer: vi.fn().mockResolvedValue(undefined),
        } as any;
        const s = new EmbeddingServer({} as any, sm, 'poison-latch-test', onPoison);

        expect(hasWebGpuFallback()).toBe(false);
        (s as any).handleQueuePoisoned(new Error('SerialQueue: embed permanently hung — embedder poisoned; leader stepping down'));

        // The hung native inference still holds the same-PID re-entrant GPU lock;
        // the next getEmbedder() in THIS process must build on CPU, never WebGPU.
        expect(hasWebGpuFallback()).toBe(true);
        expect(onPoison).toHaveBeenCalledOnce();
        // Existing step-down semantics kept: registration cleared, serving refused.
        await vi.waitFor(() => expect(sm.clearEmbeddingServer).toHaveBeenCalled());
        await expect(s.embed('x')).rejects.toThrow(/ECONNREFUSED/);
      } finally {
        resetWebGpuFallbackFlag();
      }
    });
  });

  describe('leadership step-down', () => {
    it('refuses embeds after shutdown instead of re-initializing a disposed embedder', async () => {
      const embedSpy = vi.fn();
      const embedManySpy = vi.fn();
      const disposeSpy = vi.fn().mockResolvedValue(undefined);
      const stepDownEmbedder = { embed: embedSpy, embedMany: embedManySpy, dispose: disposeSpy } as any;
      const sm = {
        getEmbeddingServer: vi.fn().mockResolvedValue(null),
        clearEmbeddingServer: vi.fn().mockResolvedValue(undefined),
      } as any;
      const s = new EmbeddingServer(stepDownEmbedder, sm, 'stepped-down-id');

      // Simulate leadership loss / step-down.
      await s.shutdown();

      // The store still holds this instance; its next embed must be REFUSED with an
      // ECONNREFUSED-bearing error (so withEmbedderReconnect re-resolves to the new
      // leader) — never silently re-init the disposed embedder and re-acquire the GPU.
      await expect(s.embed('x')).rejects.toThrow(/ECONNREFUSED/);
      await expect(s.embedMany(['x'])).rejects.toThrow(/ECONNREFUSED/);
      expect(embedSpy).not.toHaveBeenCalled();
      expect(embedManySpy).not.toHaveBeenCalled();
    });
  });
});
