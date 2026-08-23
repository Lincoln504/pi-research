/**
 * A unit-test process must never write to the user's real shared log.
 *
 * unit-env.ts redirects PI_RESEARCH_LOG_PATH before src/logger.ts is evaluated, but the
 * global logger is built LAZILY and resolves its path at construction, not at module
 * evaluation. A suite whose beforeEach deletes every PI_RESEARCH_* variable therefore
 * left the first logger of the run resolving the production default — measured at ~7KB
 * of deliberate WARN/ERROR fixtures per run appended to /tmp/pi-research.log, among them
 * a corrupt-registry fixture that reads exactly like a live failure and cost real time
 * during a forensic pass. test/setup/unit.ts now constructs the logger while the redirect
 * is still set; this pins that.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { getLogger, buildDefaultDebugLogPath } from '../../src/logger.ts';

const PRODUCTION_LOG = path.join(os.tmpdir(), 'pi-research.log');

describe('unit-test log isolation', () => {
  const saved = process.env['PI_RESEARCH_LOG_PATH'];
  afterEach(() => {
    if (saved === undefined) delete process.env['PI_RESEARCH_LOG_PATH'];
    else process.env['PI_RESEARCH_LOG_PATH'] = saved;
  });

  it('resolves the redirected path, not the shared production log', () => {
    expect(buildDefaultDebugLogPath()).not.toBe(PRODUCTION_LOG);
    expect(getLogger().getLogFilePath()).not.toBe(PRODUCTION_LOG);
  });

  it('keeps pointing away from the production log after a suite scrubs PI_RESEARCH_*', () => {
    // Exactly what config.test.ts's beforeEach used to do to every PI_RESEARCH_ key.
    delete process.env['PI_RESEARCH_LOG_PATH'];
    expect(getLogger().getLogFilePath()).not.toBe(PRODUCTION_LOG);
  });
});
