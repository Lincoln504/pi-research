import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { StatePathConfiguration } from '../../../src/infrastructure/state/state-path-configuration.ts';
import { getGlobalConfigDir, getProjectSettingsRegistryPath, getStateDir } from '../../../src/config.ts';
import { getConfigDirName } from '../../../src/utils/host-config.ts';

describe('state dir namespace', () => {
  it('defaults under pi-research own namespace (~/.pi/research/state), NOT the host pi config root (~/.pi/state)', () => {
    const cfg = new StatePathConfiguration();
    // Lives beside config.env / knowledge_db, under the research dir.
    expect(cfg.getStateDir()).toBe(path.join(getGlobalConfigDir(), 'state'));
    expect(cfg.getStateDir().endsWith(path.join('research', 'state'))).toBe(true);
    // Must NOT be the host pi config root state dir (the bug we fixed).
    expect(cfg.getStateDir()).not.toBe(path.join(os.homedir(), getConfigDirName(), 'state'));
    expect(cfg.getProjectSettingsPath()).toBe(path.join(getGlobalConfigDir(), 'state', 'project-settings.json'));
  });

  it('getProjectSettingsRegistryPath() resolves to the same research-namespaced state dir', () => {
    expect(getProjectSettingsRegistryPath()).toBe(
      path.join(getGlobalConfigDir(), 'state', 'project-settings.json')
    );
  });

  it('honors an explicit state-dir override', () => {
    const cfg = new StatePathConfiguration('/custom/state/dir');
    expect(cfg.getStateDir()).toBe('/custom/state/dir');
  });
});

// getStateDir()/StatePathConfiguration used to join a RELATIVE
// PI_RESEARCH_STATE_DIR straight onto research-state.json/.locks/backups with
// no path.isAbsolute() guard — every fs call then resolved it against
// whatever process.cwd() happened to be at call time, silently fragmenting
// cross-process coordination (leader election, locks) across processes
// launched from different working directories. scripts/cleanup.cjs already
// falls back to the default rather than trusting a relative override; the
// runtime path resolution must agree with it.
describe('getStateDir() — relative PI_RESEARCH_STATE_DIR override', () => {
  const saved = process.env['PI_RESEARCH_STATE_DIR'];

  afterEach(() => {
    if (saved === undefined) delete process.env['PI_RESEARCH_STATE_DIR'];
    else process.env['PI_RESEARCH_STATE_DIR'] = saved;
  });

  it('ignores a relative override and falls back to the default, rather than resolving it against process.cwd()', () => {
    process.env['PI_RESEARCH_STATE_DIR'] = 'relative/state/dir';
    expect(getStateDir()).toBe(path.join(getGlobalConfigDir(), 'state'));
  });

  it('honors an absolute override', () => {
    process.env['PI_RESEARCH_STATE_DIR'] = '/abs/override/state';
    expect(getStateDir()).toBe('/abs/override/state');
  });

  it('StatePathConfiguration() with no explicit arg also ignores a relative env override', () => {
    process.env['PI_RESEARCH_STATE_DIR'] = 'relative/state/dir';
    const cfg = new StatePathConfiguration();
    expect(cfg.getStateDir()).toBe(path.join(getGlobalConfigDir(), 'state'));
  });
});
