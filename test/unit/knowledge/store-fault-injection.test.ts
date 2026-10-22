/**
 * Fault injection against a REAL LanceDB store (no table mocks): what state does the
 * store end in when the embedder dies mid-write, the manifest cannot be persisted,
 * the dbDir is unusable, or the table directory vanishes under an open handle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';
import type { IEmbedder } from '../../../src/core/interfaces/knowledge-interfaces.ts';

const DIM = 8;
function makeEmbedder(embedMany?: (texts: string[]) => Promise<Float32Array[]>): IEmbedder {
  return {
    getDimension: vi.fn().mockReturnValue(DIM),
    setDimension: vi.fn(),
    embed: vi.fn().mockResolvedValue(new Float32Array(DIM)),
    embedMany: vi.fn().mockImplementation(embedMany ?? (async (t: string[]) => t.map(() => new Float32Array(DIM).fill(0.1)))),
    isInitialized: vi.fn().mockReturnValue(true),
  } as unknown as IEmbedder;
}
const doc = (n: string) => ({
  url: `https://example.com/${n}`,
  text: `text ${n}`,
  metadata: { title: n, ingestionType: 'synthesis-description' },
  timestamp: Date.now(),
});

describe('KnowledgeStore fault injection (real LanceDB)', () => {
  let dir: string;
  const stores: KnowledgeStore[] = [];
  const mk = (embedder: IEmbedder, extra: Record<string, unknown> = {}) => {
    const s = new KnowledgeStore({ dbDir: dir, embedder, modelName: 'test-model', knowledgeMode: 'project', ...extra });
    stores.push(s);
    return s;
  };

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-research-fault-')); });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const s of stores.splice(0)) await s.close().catch(() => {});
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('an embedder that dies mid-write leaves NO partial rows and the next write succeeds', async () => {
    let calls = 0;
    const store = mk(makeEmbedder(async (t) => {
      calls++;
      // dies on every embed after the open() warm-up/first call until "restarted"
      if (calls === 1) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      if (calls === 2) throw new Error('boom: inference crashed');
      return t.map(() => new Float32Array(DIM).fill(0.2));
    }));
    await store.open();
    // First failure is a reconnect-classified one with no reconnectFactory: it must surface, not half-write.
    await expect(store.addDocuments([doc('a'), doc('b')])).rejects.toThrow(/ECONNRESET/);
    expect(await store.count()).toBe(0);
    await expect(store.addDocuments([doc('a'), doc('b')])).rejects.toThrow(/inference crashed/);
    expect(await store.count()).toBe(0);
    await store.addDocuments([doc('a'), doc('b')]);
    expect(await store.count()).toBe(2);
  });

  it('a reconnect-classified failure is retried once through reconnectFactory and then lands the rows', async () => {
    let first = true;
    const broken = makeEmbedder(async () => {
      if (first) { first = false; throw new Error('connect ECONNREFUSED 127.0.0.1:1'); }
      return [new Float32Array(DIM)];
    });
    const fresh = makeEmbedder();
    const reconnectFactory = vi.fn().mockResolvedValue(fresh);
    const store = mk(broken, { reconnectFactory });
    await store.open();
    await store.addDocuments([doc('r')]);
    expect(reconnectFactory).toHaveBeenCalledTimes(1);
    expect(await store.count()).toBe(1);
  });

  it('a manifest that cannot be written (ENOSPC/EROFS class: the tmp path is unusable) does not fail open() or later writes', async () => {
    // ESM fs namespaces cannot be spied, so inject a REAL write failure instead: the
    // manifest's temp path is occupied by a directory, so writeFile rejects (EISDIR)
    // exactly where a full or read-only disk would, and saveManifest() must report
    // failure (logged) without taking the store down.
    fs.mkdirSync(path.join(dir, 'store-manifest.json.tmp'));
    const store = mk(makeEmbedder());
    await store.open();
    expect(await store.count()).toBe(0);
    await store.addDocuments([doc('x')]);
    expect(await store.count()).toBe(1);
    expect(fs.existsSync(path.join(dir, 'store-manifest.json'))).toBe(false);
  });

  it('a corrupt manifest falls back to the default table and the store still opens and serves', async () => {
    const first = mk(makeEmbedder());
    await first.open();
    await first.addDocuments([doc('keep')]);
    await first.close();
    fs.writeFileSync(path.join(dir, 'store-manifest.json'), '{"activeTableName": "knowl');
    const second = mk(makeEmbedder());
    await second.open();
    // default table name is the canonical one the first store used, so the data is still there
    expect(await second.count()).toBe(1);
  });

  it('an unusable (read-only) dbDir makes open() fail loudly and a later open() genuinely retries', async () => {
    if (process.getuid?.() === 0) return; // root ignores mode bits
    const sub = path.join(dir, 'ro-parent');
    fs.mkdirSync(sub, { mode: 0o500 });
    const store = new KnowledgeStore({ dbDir: path.join(sub, 'db'), embedder: makeEmbedder(), modelName: 'test-model', knowledgeMode: 'project' });
    stores.push(store);
    await expect(store.open()).rejects.toThrow();
    fs.chmodSync(sub, 0o700);
    await store.open(); // would short-circuit on a leaked half-open this.db if rollback were missing
    await store.addDocuments([doc('after-chmod')]);
    expect(await store.count()).toBe(1);
  });

  it('a table directory deleted under an open handle surfaces an error instead of serving a stale handle forever', async () => {
    const store = mk(makeEmbedder());
    await store.open();
    await store.addDocuments([doc('gone')]);
    fs.rmSync(path.join(dir, 'knowledge.lance'), { recursive: true, force: true });
    await expect(store.search('gone')).rejects.toThrow();
  });
});
