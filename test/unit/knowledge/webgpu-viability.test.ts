import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';

// Mock child_process.spawn so no real subprocess is ever launched. Each test
// configures `nextScenario` to drive the fake child's stdout/stderr/close.
const { spawnMock, setScenario } = vi.hoisted(() => {
  let nextScenario: {
    stdout?: string;
    stderr?: string;
    code?: number | null;
    signal?: string | null;
    emitError?: Error;
    hang?: boolean;
  } = {};

  const spawnMock = vi.fn(() => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const s = nextScenario;
    // Drive the fake child asynchronously, like a real spawn.
    setImmediate(() => {
      if (s.emitError) { child.emit('error', s.emitError); return; }
      if (s.hang) return; // never closes -> exercises the timeout path
      if (s.stdout) child.stdout.emit('data', Buffer.from(s.stdout));
      if (s.stderr) child.stderr.emit('data', Buffer.from(s.stderr));
      child.emit('close', s.code ?? 0, s.signal ?? null);
    });
    return child;
  });

  const setScenario = (s: typeof nextScenario) => { nextScenario = s; };
  return { spawnMock, setScenario };
});

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

let tmpCache: string;

// Point getModelCacheDir() (XDG_CACHE_HOME/pi-research/models) at a tmp dir so the
// verdict file lands in an isolated location and we exercise the real fs path.
beforeEach(async () => {
  tmpCache = await fsp.mkdtemp(path.join(os.tmpdir(), 'wgpu-viability-'));
  process.env['XDG_CACHE_HOME'] = tmpCache;
  delete process.env['PI_RESEARCH_WEBGPU_REPROBE'];
  spawnMock.mockClear();
  setScenario({});
});

afterEach(async () => {
  delete process.env['XDG_CACHE_HOME'];
  delete process.env['PI_RESEARCH_WEBGPU_REPROBE'];
  await fsp.rm(tmpCache, { recursive: true, force: true }).catch(() => {});
  vi.resetModules();
});

const MODEL = 'test-org/test-model';
const verdictFile = () => path.join(tmpCache, 'pi-research', 'webgpu-viability.json');

async function load() {
  // Fresh import each test so module-level state can't leak between cases.
  return await import('../../../src/knowledge/webgpu-viability.ts');
}

describe('resolveEmbeddingDevice', () => {
  it('returns cpu for explicit cpu without spawning a probe', async () => {
    const { resolveEmbeddingDevice } = await load();
    expect(await resolveEmbeddingDevice('cpu', MODEL, 1000)).toBe('cpu');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns webgpu for explicit webgpu without spawning a probe', async () => {
    const { resolveEmbeddingDevice } = await load();
    expect(await resolveEmbeddingDevice('webgpu', MODEL, 1000)).toBe('webgpu');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('auto -> webgpu when the probe prints the success sentinel (even if it then aborts on teardown)', async () => {
    // The real onnxruntime teardown abort: sentinel on stdout, non-zero exit/signal.
    setScenario({ stdout: 'PROBE_OK 384\n', code: 134, signal: 'SIGABRT', stderr: 'terminate called\n' });
    const { resolveEmbeddingDevice } = await load();
    expect(await resolveEmbeddingDevice('auto', MODEL, 5000)).toBe('webgpu');
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const v = JSON.parse(fs.readFileSync(verdictFile(), 'utf8'));
    expect(v.viable).toBe(true);
  });

  it('auto -> cpu when the probe is killed by SIGSEGV before the sentinel (software GPU case)', async () => {
    setScenario({ code: null, signal: 'SIGSEGV' });
    const { resolveEmbeddingDevice } = await load();
    expect(await resolveEmbeddingDevice('auto', MODEL, 5000)).toBe('cpu');

    const v = JSON.parse(fs.readFileSync(verdictFile(), 'utf8'));
    expect(v.viable).toBe(false);
  });

  it('auto reuses the cached verdict on the second call (no second spawn)', async () => {
    setScenario({ stdout: 'PROBE_OK 384\n', code: 0 });
    const { resolveEmbeddingDevice } = await load();
    expect(await resolveEmbeddingDevice('auto', MODEL, 5000)).toBe('webgpu');
    expect(await resolveEmbeddingDevice('auto', MODEL, 5000)).toBe('webgpu');
    expect(spawnMock).toHaveBeenCalledTimes(1); // second call hit the cache
  });

  it('PI_RESEARCH_WEBGPU_REPROBE=1 bypasses the cached verdict', async () => {
    setScenario({ stdout: 'PROBE_OK 384\n', code: 0 });
    const { resolveEmbeddingDevice } = await load();
    expect(await resolveEmbeddingDevice('auto', MODEL, 5000)).toBe('webgpu');

    process.env['PI_RESEARCH_WEBGPU_REPROBE'] = '1';
    setScenario({ code: null, signal: 'SIGSEGV' });
    expect(await resolveEmbeddingDevice('auto', MODEL, 5000)).toBe('cpu');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('auto -> cpu when the probe hangs past the timeout', async () => {
    setScenario({ hang: true });
    const { resolveEmbeddingDevice } = await load();
    expect(await resolveEmbeddingDevice('auto', MODEL, 50)).toBe('cpu');
  });

  it('auto -> cpu when the probe process errors (spawn failure)', async () => {
    setScenario({ emitError: new Error('ENOENT') });
    const { resolveEmbeddingDevice } = await load();
    expect(await resolveEmbeddingDevice('auto', MODEL, 5000)).toBe('cpu');
  });
});
