/**
 * bridgeConfigEnv — overlay precedence.
 *
 * Regression: per-file promotion into process.env made config.env win over
 * cli.env — the base file's key landed in process.env on the first iteration
 * and the "don't clobber the real environment" guard then blocked the
 * overlay's value, so cli.env could never override config.env.
 *
 * Isolated in its own file because getConfigDirName() memoizes: in cli.test.ts
 * the real value latches before the test can point it at a fixture dir.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const FIXTURE_DIR_NAME = vi.hoisted(() => `.pi-research-bridgetest-${process.pid}`);

vi.mock('../../src/utils/host-config.ts', () => ({
  getConfigDirName: () => FIXTURE_DIR_NAME,
}));

import { bridgeConfigEnv } from '../../src/cli.ts';

describe('bridgeConfigEnv precedence', () => {
  it('cli.env overlay overrides config.env base; base still fills unshadowed keys', () => {
    const researchDir = path.join(os.homedir(), FIXTURE_DIR_NAME, 'research');
    const savedModel = process.env['PI_RESEARCH_MODEL'];
    const savedRetries = process.env['PI_RESEARCH_MAX_RETRIES'];
    try {
      mkdirSync(researchDir, { recursive: true });
      writeFileSync(
        path.join(researchDir, 'config.env'),
        'PI_RESEARCH_MODEL=base/model\nPI_RESEARCH_MAX_RETRIES=7\n',
        'utf-8',
      );
      writeFileSync(path.join(researchDir, 'cli.env'), 'PI_RESEARCH_MODEL=overlay/model\n', 'utf-8');
      delete process.env['PI_RESEARCH_MODEL'];
      delete process.env['PI_RESEARCH_MAX_RETRIES'];

      const { path: basePath, loaded } = bridgeConfigEnv();
      expect(basePath).toContain(FIXTURE_DIR_NAME);
      expect(loaded).toBe(true);
      expect(process.env['PI_RESEARCH_MODEL']).toBe('overlay/model');
      expect(process.env['PI_RESEARCH_MAX_RETRIES']).toBe('7');
    } finally {
      rmSync(path.join(os.homedir(), FIXTURE_DIR_NAME), { recursive: true, force: true });
      if (savedModel === undefined) delete process.env['PI_RESEARCH_MODEL'];
      else process.env['PI_RESEARCH_MODEL'] = savedModel;
      if (savedRetries === undefined) delete process.env['PI_RESEARCH_MAX_RETRIES'];
      else process.env['PI_RESEARCH_MAX_RETRIES'] = savedRetries;
    }
  });

  it('a real environment value is never clobbered by either file', () => {
    const researchDir = path.join(os.homedir(), FIXTURE_DIR_NAME, 'research');
    const savedModel = process.env['PI_RESEARCH_MODEL'];
    try {
      mkdirSync(researchDir, { recursive: true });
      writeFileSync(path.join(researchDir, 'config.env'), 'PI_RESEARCH_MODEL=base/model\n', 'utf-8');
      writeFileSync(path.join(researchDir, 'cli.env'), 'PI_RESEARCH_MODEL=overlay/model\n', 'utf-8');
      process.env['PI_RESEARCH_MODEL'] = 'shell/export';

      bridgeConfigEnv();
      expect(process.env['PI_RESEARCH_MODEL']).toBe('shell/export');
    } finally {
      rmSync(path.join(os.homedir(), FIXTURE_DIR_NAME), { recursive: true, force: true });
      if (savedModel === undefined) delete process.env['PI_RESEARCH_MODEL'];
      else process.env['PI_RESEARCH_MODEL'] = savedModel;
    }
  });
});
