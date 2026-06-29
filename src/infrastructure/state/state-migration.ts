/**
 * State Migration
 *
 * Forward migration of persisted state across schema versions, plus detection
 * of state written by a NEWER build than the current process understands.
 *
 * The state file is shared by every co-installed front end (pi extension, SDK,
 * CLI / agent skill). When those builds differ in schema version, an older
 * reader must NOT treat a newer file as corruption and overwrite it — that would
 * destroy the newer build's live sessions, browser-server lease, and authSecret.
 * Instead:
 *   - version < CURRENT  → migrate forward, stepwise, to CURRENT.
 *   - version === CURRENT → pass through unchanged.
 *   - version > CURRENT  → throw StateVersionTooNewError (caller quarantines and
 *     runs degraded rather than clobbering the file).
 */

import { CURRENT_STATE_VERSION } from '../types/state-types.ts';

/**
 * Thrown when the on-disk state was written by a build with a higher schema
 * version than this process supports. Carries the versions for logging.
 */
export class StateVersionTooNewError extends Error {
  readonly fileVersion: number;
  readonly currentVersion: number;
  constructor(fileVersion: number, currentVersion: number) {
    super(
      `State file version ${fileVersion} is newer than the supported version ${currentVersion}. ` +
      `It was written by a newer build; this process will not modify it.`,
    );
    this.name = 'StateVersionTooNewError';
    this.fileVersion = fileVersion;
    this.currentVersion = currentVersion;
  }
}

/**
 * A single forward migration step. Receives a plain parsed object at version
 * `from` and must return an object at version `from + 1`. Steps run in order
 * until the object reaches CURRENT_STATE_VERSION.
 *
 * Keyed by the source version. When CURRENT_STATE_VERSION is bumped to N, add a
 * MIGRATIONS[N - 1] entry that upgrades an (N-1)-shaped object to N.
 */
type MigrationStep = (raw: Record<string, unknown>) => Record<string, unknown>;

const MIGRATIONS: Record<number, MigrationStep> = {
  // No migrations yet — CURRENT_STATE_VERSION is 1, the initial schema.
  // Example for a future bump to 2:
  // 1: (raw) => ({ ...raw, version: 2, /* fill new required fields */ }),
};

/**
 * Read a numeric `version` from a parsed object, or null if it is absent or not
 * a finite number (in which case the object is malformed and the validator will
 * reject it as corruption).
 */
function readVersion(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = (raw as Record<string, unknown>)['version'];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Bring a parsed state object up to CURRENT_STATE_VERSION.
 *
 * - Objects without a usable numeric version are returned unchanged so the
 *   schema validator can reject them as corruption (the existing recovery path).
 * - Future versions throw StateVersionTooNewError.
 * - Older versions are migrated forward step by step; a missing step for some
 *   intermediate version is an unrecoverable gap and throws.
 */
export function migrateRawState(raw: unknown): unknown {
  const version = readVersion(raw);
  if (version === null) return raw;

  if (version > CURRENT_STATE_VERSION) {
    throw new StateVersionTooNewError(version, CURRENT_STATE_VERSION);
  }

  if (version === CURRENT_STATE_VERSION) return raw;

  let current = raw as Record<string, unknown>;
  let v = version;
  while (v < CURRENT_STATE_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) {
      throw new Error(
        `No migration registered from state version ${v} to ${v + 1}; cannot upgrade.`,
      );
    }
    current = step(current);
    const next = readVersion(current);
    if (next !== v + 1) {
      throw new Error(
        `Migration from state version ${v} produced version ${String(next)}, expected ${v + 1}.`,
      );
    }
    v = next;
  }
  return current;
}
