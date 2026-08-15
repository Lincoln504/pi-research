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

import { bridgeConfigEnv, ConfigFileError } from '../../src/cli.ts';

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

  it('an explicit --config file outranks the ambient cli.env overlay, for user- and project-scoped keys', () => {
    const researchDir = path.join(os.homedir(), FIXTURE_DIR_NAME, 'research');
    const savedModel = process.env['PI_RESEARCH_MODEL'];
    const savedMode = process.env['PI_RESEARCH_KNOWLEDGE_STORE_MODE'];
    try {
      mkdirSync(researchDir, { recursive: true });
      // Ambient overlay defines the SAME keys as the explicit file: the file the
      // user named on this invocation must win, and its project-scoped key must
      // still be bridged (getConfig never reads the explicit path, so dropping it
      // means the value applies nowhere).
      writeFileSync(
        path.join(researchDir, 'cli.env'),
        'PI_RESEARCH_MODEL=overlay/model\nPI_RESEARCH_KNOWLEDGE_STORE_MODE=none\n',
        'utf-8',
      );
      const explicitPath = path.join(researchDir, 'ci.env');
      writeFileSync(
        explicitPath,
        'PI_RESEARCH_MODEL=explicit/model\nPI_RESEARCH_KNOWLEDGE_STORE_MODE=global\n',
        'utf-8',
      );
      delete process.env['PI_RESEARCH_MODEL'];
      delete process.env['PI_RESEARCH_KNOWLEDGE_STORE_MODE'];

      bridgeConfigEnv(explicitPath);
      expect(process.env['PI_RESEARCH_MODEL']).toBe('explicit/model');
      expect(process.env['PI_RESEARCH_KNOWLEDGE_STORE_MODE']).toBe('global');
    } finally {
      rmSync(path.join(os.homedir(), FIXTURE_DIR_NAME), { recursive: true, force: true });
      if (savedModel === undefined) delete process.env['PI_RESEARCH_MODEL'];
      else process.env['PI_RESEARCH_MODEL'] = savedModel;
      if (savedMode === undefined) delete process.env['PI_RESEARCH_KNOWLEDGE_STORE_MODE'];
      else process.env['PI_RESEARCH_KNOWLEDGE_STORE_MODE'] = savedMode;
    }
  });

  it('a missing EXPLICIT --config file throws ConfigFileError; missing ambient files stay tolerated', () => {
    // Regression: the explicit file got the same existsSync-continue tolerance as
    // the optional ambient layers, so a typo'd --config path silently ran the
    // command on ambient config and reported success.
    const researchDir = path.join(os.homedir(), FIXTURE_DIR_NAME, 'research');
    try {
      mkdirSync(researchDir, { recursive: true });
      const missing = path.join(researchDir, 'ci.evn');
      expect(() => bridgeConfigEnv(missing)).toThrow(ConfigFileError);
      expect(() => bridgeConfigEnv(missing)).toThrow(missing);
      // Ambient layers absent is not an error — the bridge just reports nothing loaded.
      expect(() => bridgeConfigEnv()).not.toThrow();
      expect(bridgeConfigEnv().loaded).toBe(false);
    } finally {
      rmSync(path.join(os.homedir(), FIXTURE_DIR_NAME), { recursive: true, force: true });
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

  it('an explicit --config keeps credentials stored only in the base config.env (regression)', () => {
    // Regression: with --config, the layer list was [cli.env, namedFile] — the
    // global base was never read, so PI_RESEARCH_API_KEY/_PROVIDER stored only in
    // config.env vanished and `research --config extra.env` exit-78'd on a
    // correctly configured machine, contradicting the help text ("base config.env
    // keys it does not set still apply").
    const researchDir = path.join(os.homedir(), FIXTURE_DIR_NAME, 'research');
    const saved: Record<string, string | undefined> = {
      PI_RESEARCH_API_KEY: process.env['PI_RESEARCH_API_KEY'],
      PI_RESEARCH_PROVIDER: process.env['PI_RESEARCH_PROVIDER'],
      PI_RESEARCH_MODEL: process.env['PI_RESEARCH_MODEL'],
    };
    const extraPath = path.join(os.homedir(), FIXTURE_DIR_NAME, 'extra.env');
    try {
      mkdirSync(researchDir, { recursive: true });
      writeFileSync(
        path.join(researchDir, 'config.env'),
        'PI_RESEARCH_API_KEY=base-key\nPI_RESEARCH_PROVIDER=base-provider\nPI_RESEARCH_MODEL=base/model\n',
        'utf-8',
      );
      writeFileSync(extraPath, 'PI_RESEARCH_MODEL=named/model\n', 'utf-8');
      for (const k of Object.keys(saved)) delete process.env[k];

      bridgeConfigEnv(extraPath);

      // The named file wins where it speaks; the base fills everything else.
      expect(process.env['PI_RESEARCH_MODEL']).toBe('named/model');
      expect(process.env['PI_RESEARCH_API_KEY']).toBe('base-key');
      expect(process.env['PI_RESEARCH_PROVIDER']).toBe('base-provider');
    } finally {
      rmSync(path.join(os.homedir(), FIXTURE_DIR_NAME), { recursive: true, force: true });
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
