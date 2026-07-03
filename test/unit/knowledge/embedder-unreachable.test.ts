import { describe, it, expect } from 'vitest';
import { isEmbedderUnreachable } from '../../../src/knowledge/embedder-utils.ts';

describe('isEmbedderUnreachable — retry-vs-drop classification', () => {
  it('recognizes a dead/stepped-down leader (ECONNREFUSED) and a poisoned queue', () => {
    expect(isEmbedderUnreachable(new Error('connect ECONNREFUSED 127.0.0.1:8760'))).toBe(true);
    expect(isEmbedderUnreachable(new Error('embedder poisoned: inference hung'))).toBe(true);
    const codeErr = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
    expect(isEmbedderUnreachable(codeErr)).toBe(true);
  });

  it('recognizes connection resets from an ORDINARY leader handoff so the doc is retried, not dropped', () => {
    // Regression: EmbeddingServer.shutdown() calls closeAllConnections() on normal leadership
    // loss / process teardown, not just the poison path. The in-flight client then sees
    // ECONNRESET / "socket hang up" / "aborted" — signatures the old classifier missed, so a
    // document in flight during the handoff was permanently dropped instead of retried.
    expect(isEmbedderUnreachable(new Error('socket hang up'))).toBe(true);
    expect(isEmbedderUnreachable(new Error('read ECONNRESET'))).toBe(true);
    expect(isEmbedderUnreachable(new Error('The operation was aborted'))).toBe(true);
    expect(isEmbedderUnreachable(new Error('other side closed'))).toBe(true);
    expect(isEmbedderUnreachable(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true);
  });

  it('does NOT misclassify genuine, non-transient failures as reconnectable', () => {
    // These must fall through to the caller's real error handling, not an infinite reconnect.
    expect(isEmbedderUnreachable(new Error('Version mismatch on commit'))).toBe(false);
    expect(isEmbedderUnreachable(new Error('ENOSPC: no space left on device'))).toBe(false);
    expect(isEmbedderUnreachable(new Error('malformed embedding vector'))).toBe(false);
    expect(isEmbedderUnreachable(undefined)).toBe(false);
  });
});
