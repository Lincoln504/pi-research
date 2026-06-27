import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { StatePathConfiguration } from '../../../src/infrastructure/state/state-path-configuration.ts';
import { getGlobalConfigDir, getProjectSettingsRegistryPath } from '../../../src/config.ts';
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
