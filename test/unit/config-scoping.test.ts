/**
 * Configuration Scoping Integration Tests
 * 
 * Verifies that settings are correctly resolved by scope (project vs user).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getConfig, DEFAULTS, resetConfig } from '../../src/config';
import { normalizeWorkspacePath } from '../../src/utils/text-utils';
import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock fs and os
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  openSync: vi.fn(),
  closeSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  homedir: () => '/home/user',
}));

describe('Configuration Scoping', () => {
  const mockCwd = '/home/user/project';
  // State lives under pi-research's own namespace (~/.pi/research/state), beside
  // config.env and knowledge_db — not the host pi config root (~/.pi/state).
  const projectSettingsPath = path.join(os.homedir(), CONFIG_DIR_NAME, 'research', 'state', 'project-settings.json');

  beforeEach(() => {
    vi.clearAllMocks();
    resetConfig();
  });

  it('should prioritize project settings over user defaults', () => {
    // 1. Mock project settings file existence and content
    vi.mocked(fs.existsSync).mockImplementation((p: any) => p === projectSettingsPath);
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (p === projectSettingsPath) {
        // The source keys the registry by normalizeWorkspacePath(cwd) (i.e.
        // path.resolve), so the fixture must use the same resolved key —
        // otherwise on Windows path.resolve('/home/user/project') becomes
        // 'C:\\home\\user\\project' and never matches a raw forward-slash key.
        return JSON.stringify({
          [normalizeWorkspacePath(mockCwd)]: { PI_RESEARCH_DEFAULT_RESEARCH_DEPTH: '3' }
        });
      }
      return '';
    });

    // 2. Use getConfig (which calls loadEnvFiles internally) to load project context
    const config = getConfig(mockCwd);

    // 3. Verify project-scoped setting overrides user default
    expect(config.DEFAULT_RESEARCH_DEPTH).toBe(3);
  });

  it('should fall back to user defaults when project settings are missing', () => {
    // Mock no project settings
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const config = getConfig(mockCwd);

    expect(config.DEFAULT_RESEARCH_DEPTH).toBe(DEFAULTS.DEFAULT_RESEARCH_DEPTH);
  });
});

describe('Per-interface config overlay', () => {
  const mockCwd = '/home/user/project';
  const researchDir = path.join('/home/user', CONFIG_DIR_NAME, 'research');
  const globalEnvPath = path.join(researchDir, 'config.env');
  const piEnvPath = path.join(researchDir, 'pi.env');
  const cliEnvPath = path.join(researchDir, 'cli.env');

  beforeEach(() => {
    vi.clearAllMocks();
    resetConfig();
    delete process.env['PI_RESEARCH_MODEL'];
    // Only the base config.env and the pi.env overlay exist on disk.
    vi.mocked(fs.existsSync).mockImplementation((p: any) => p === globalEnvPath || p === piEnvPath);
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (p === globalEnvPath) return 'PI_RESEARCH_MODEL=base/model\n';
      if (p === piEnvPath) return 'PI_RESEARCH_MODEL=overlay/model\n';
      return '';
    });
  });

  it('overlay file wins over base config.env for its interface', () => {
    expect(getConfig(mockCwd, 'pi').RESEARCH_MODEL).toBe('overlay/model');
  });

  it('base config.env is used when no overlay exists for the interface', () => {
    // cli.env does not exist → falls back to base.
    expect(getConfig(mockCwd, 'cli').RESEARCH_MODEL).toBe('base/model');
    expect(fs.existsSync(cliEnvPath)).toBe(false);
  });

  it('no-interface lookup never reads an overlay (distinct cache namespace)', () => {
    expect(getConfig(mockCwd).RESEARCH_MODEL).toBe('base/model');
    // …and the interface lookup is a separate cached entry, not the same object.
    expect(getConfig(mockCwd)).not.toBe(getConfig(mockCwd, 'pi'));
  });

  it('process.env still wins over the overlay', () => {
    process.env['PI_RESEARCH_MODEL'] = 'env/model';
    try {
      expect(getConfig(mockCwd, 'pi').RESEARCH_MODEL).toBe('env/model');
    } finally {
      delete process.env['PI_RESEARCH_MODEL'];
    }
  });
});
