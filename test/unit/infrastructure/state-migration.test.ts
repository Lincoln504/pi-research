import { describe, it, expect } from 'vitest';
import { migrateRawState, StateVersionTooNewError } from '../../../src/infrastructure/state/state-migration.ts';
import { CURRENT_STATE_VERSION } from '../../../src/infrastructure/types/state-types.ts';

describe('migrateRawState', () => {
  const base = {
    version: CURRENT_STATE_VERSION,
    containerId: 'c',
    containerName: 'n',
    port: 0,
    sessions: {},
    lastUpdated: 1,
  };

  it('passes a current-version object through unchanged', () => {
    expect(migrateRawState(base)).toBe(base);
  });

  it('throws StateVersionTooNewError for a future version', () => {
    const future = { ...base, version: CURRENT_STATE_VERSION + 1 };
    expect(() => migrateRawState(future)).toThrow(StateVersionTooNewError);
    try {
      migrateRawState(future);
    } catch (e) {
      expect(e).toBeInstanceOf(StateVersionTooNewError);
      expect((e as StateVersionTooNewError).fileVersion).toBe(CURRENT_STATE_VERSION + 1);
      expect((e as StateVersionTooNewError).currentVersion).toBe(CURRENT_STATE_VERSION);
    }
  });

  it('returns non-objects and version-less objects unchanged (validator rejects them)', () => {
    expect(migrateRawState(null)).toBe(null);
    expect(migrateRawState('garbage')).toBe('garbage');
    const noVersion = { containerId: 'x' };
    expect(migrateRawState(noVersion)).toBe(noVersion);
  });

  it('treats a non-numeric version as version-less (no throw, passed through)', () => {
    const weird = { ...base, version: 'two' };
    expect(migrateRawState(weird)).toBe(weird);
  });
});
