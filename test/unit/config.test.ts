/**
 * Config Module Unit Tests
 *
 * Tests the refactored configuration factory pattern.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
vi.mock('../../src/utils/text-utils.ts', () => ({
  normalizeWorkspacePath: vi.fn((p: string) => p),
}));

import { createConfig, getConfig, setConfig, resetConfig, validateConfig, saveConfig, getDbDir, parseDotEnv, type Config as _Config, DEFAULTS } from '../../src/config';
import * as fs from 'node:fs';

// Mock fs to avoid reading .env during tests
vi.mock('node:fs', async () => {
  return {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    copyFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    openSync: vi.fn(() => 42), // Mock file descriptor
    closeSync: vi.fn(),
    chmodSync: vi.fn(),
    statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
  };
});

describe('parseDotEnv — the single canonical parser', () => {
  it('strips a matched pair of surrounding double or single quotes', () => {
    const out = parseDotEnv([
      'PI_RESEARCH_MODEL="openai/gpt-4o"',
      "PI_RESEARCH_PROVIDER='openai'",
    ].join('\n'));
    // Regression: the CLI's bridge parser stripped quotes but config's did not, so a quoted
    // project-scoped value (only config's parser ever sees those) retained literal quotes.
    expect(out.PI_RESEARCH_MODEL).toBe('openai/gpt-4o');
    expect(out.PI_RESEARCH_PROVIDER).toBe('openai');
  });

  it('leaves unquoted, inner, and mismatched-quote values untouched', () => {
    const out = parseDotEnv([
      'A=plain',
      'B=say "hi" there',      // inner quotes, not surrounding
      'C="oops',               // only a leading quote
      'D=#notacomment=x',      // # only starts a comment at line start
    ].join('\n'));
    expect(out.A).toBe('plain');
    expect(out.B).toBe('say "hi" there');
    expect(out.C).toBe('"oops');
    expect(out.D).toBe('#notacomment=x');
  });

  it('ignores comments/blank lines and drops prototype-polluting keys', () => {
    const out = parseDotEnv('# comment\n\n__proto__=evil\nK=v\n');
    expect(out.K).toBe('v');
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
  });

  it('trims whitespace around the value so `KEY = value` parses cleanly', () => {
    // Regression: ' true' failed parseEnvBool's strict === 'true' check with no warning,
    // and ' "value"' defeated surrounding-quote detection.
    const out = parseDotEnv([
      'PI_RESEARCH_DEBUG = true',
      'PI_RESEARCH_MODEL =\t openai/gpt-4o',
      'QUOTED = "spaced value"',
    ].join('\n'));
    expect(out.PI_RESEARCH_DEBUG).toBe('true');
    expect(out.PI_RESEARCH_MODEL).toBe('openai/gpt-4o');
    expect(out.QUOTED).toBe('spaced value');
  });

  it('preserves intentional whitespace inside quotes (trim happens before quote-strip)', () => {
    const out = parseDotEnv('PADDED=" value "\n');
    expect(out.PADDED).toBe(' value ');
  });
});

describe('config (refactored)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Completely clear env vars that we care about
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('PI_RESEARCH_')) {
        delete process.env[key];
      }
    }
    resetConfig();
  });

  // Clean up global state between tests
  afterEach(() => {
    resetConfig();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  describe('getDbDir', () => {
    it('returns absolute KNOWLEDGE_STORE_DIR if provided', () => {
      const customDir = '/custom/db/dir';
      setConfig({ KNOWLEDGE_STORE_DIR: customDir });
      expect(getDbDir()).toBe(customDir);
    });

    it('returns default knowledge_db dir if not provided', () => {
      setConfig({ KNOWLEDGE_STORE_DIR: undefined });
      const dir = getDbDir();
      expect(dir).toContain('knowledge_db');
    });
  });

  describe('saveConfig', () => {
    it('should use atomic write via temp file for USER scope', () => {
      const config = { ...DEFAULTS };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('OLD_KEY=old_val');
      
      saveConfig(config, 'user');

      // config.env is the documented home for API keys: tmp is created 0o600 and the
      // final file is chmod'd 0o600 after the rename (tightens a pre-existing 0644 file).
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp.'),
        expect.any(String),
        { encoding: 'utf-8', mode: 0o600 },
      );
      expect(fs.renameSync).toHaveBeenCalled();
      expect(fs.chmodSync).toHaveBeenCalledWith(expect.stringContaining('config.env'), 0o600);
      // Verify locking
      expect(fs.openSync).toHaveBeenCalledWith(expect.stringContaining('.lock'), 'wx');
      expect(fs.closeSync).toHaveBeenCalledWith(42);
      expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('.lock'));
    });

    it('creates ~/.pi/research with mode 0o700 when missing (user scope)', () => {
      const config = { ...DEFAULTS };
      vi.mocked(fs.existsSync).mockReturnValue(false);

      saveConfig(config, 'user');

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('research'),
        { recursive: true, mode: 0o700 },
      );
    });

    it('should use centralized registry for LOCAL scope', () => {
      const config = { ...DEFAULTS };
      const cwd = '/test/project';
      vi.mocked(fs.existsSync).mockReturnValue(false);
      
      saveConfig(config, 'local', cwd);

      // Should write to project-settings.json
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('project-settings.json'),
        expect.stringContaining(cwd),
        'utf-8'
      );
    });

    it('should protect against prototype pollution', () => {
      const config = { ...DEFAULTS };
      const writeSpy = vi.spyOn(fs, 'writeFileSync');
      
      saveConfig(config, 'user');

      const writtenContent = writeSpy.mock.calls[0]![1] as string;
      expect(writtenContent).not.toContain('__proto__');
      expect(writtenContent).not.toContain('constructor');
      expect(writtenContent).not.toContain('prototype');
    });

    it('should preserve comments in USER env file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('# This is a comment\nPI_RESEARCH_MODEL=old-model');

      const config = { ...DEFAULTS, RESEARCH_MODEL: 'new-model' };
      saveConfig(config, 'user');

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string;
      expect(writtenContent).toContain('# This is a comment');
      expect(writtenContent).toContain('PI_RESEARCH_MODEL=new-model');
    });

    it('persists the YouTube knobs so they round-trip (regression: saveConfig allowlist)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const config = {
        ...DEFAULTS,
        YOUTUBE_TRANSCRIPT_MAX_VIDEOS: 4,
        YOUTUBE_TRANSCRIPT_TIMEOUT_MS: 33000,
        YOUTUBE_TRANSCRIPT_LANG: 'de',
        YOUTUBE_QUERY_EVERY_N: 7,
      };
      saveConfig(config, 'user');

      const written = vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string;
      expect(written).toContain('PI_RESEARCH_YOUTUBE_TRANSCRIPT_MAX_VIDEOS=4');
      expect(written).toContain('PI_RESEARCH_YOUTUBE_TRANSCRIPT_TIMEOUT_MS=33000');
      expect(written).toContain('PI_RESEARCH_YOUTUBE_TRANSCRIPT_LANG=de');
      expect(written).toContain('PI_RESEARCH_YOUTUBE_QUERY_EVERY_N=7');
    });

    it('user scope with changedKeys writes ONLY those keys and preserves other existing lines', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        '# keep me\nPI_RESEARCH_EMBEDDING_MODEL=old-model\nPI_RESEARCH_MODEL=my/model',
      );
      const config = { ...DEFAULTS, EMBEDDING_MODEL: 'org/new-model' };
      saveConfig(config, 'user', '/x', ['PI_RESEARCH_EMBEDDING_MODEL']);

      const written = vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string;
      expect(written).toContain('# keep me');
      expect(written).toContain('PI_RESEARCH_EMBEDDING_MODEL=org/new-model');
      // An existing line for an UNCHANGED key survives byte-for-byte…
      expect(written).toContain('PI_RESEARCH_MODEL=my/model');
      // …and no unchanged key is snapshotted in (that would freeze the whole
      // resolved config — env overrides and current defaults included).
      expect(written).not.toContain('PI_RESEARCH_TIMEOUT_MS');
      expect(written).not.toContain('PI_RESEARCH_MAX_RESEARCHERS');
    });

    it('first-ever user save with changedKeys still creates a valid file with just those keys', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const config = { ...DEFAULTS, DEBUG: true };
      saveConfig(config, 'user', '/x', ['PI_RESEARCH_DEBUG']);

      const written = vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string;
      expect(written).toContain('# pi-research global configuration');
      expect(written).toContain('PI_RESEARCH_DEBUG=true');
      expect(written).not.toContain('PI_RESEARCH_TIMEOUT_MS');
    });

    it('aborts a local save when the registry exists but is unreadable/corrupt (never wipes it)', () => {
      // Regression: a transient read error (EPERM/EMFILE) or corrupt JSON used to be
      // absorbed as "start fresh with {}" and then PERSISTED — destroying every
      // workspace's saved settings. The update must abort instead.
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('{corrupt json');

      expect(() => saveConfig({ ...DEFAULTS }, 'local', '/test/project'))
        .toThrow(/Failed to read project settings registry/);
      // Nothing was written — the on-disk registry (however corrupt) was not replaced.
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      // The lock is still released on the failure path.
      expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('.lock'));

      // Restore the factory defaults for subsequent tests (clearAllMocks keeps impls).
      vi.mocked(fs.existsSync).mockImplementation(() => false);
      vi.mocked(fs.readFileSync).mockImplementation(() => '');
    });

    it('reads the YouTube knobs back from env (defaults + overrides)', () => {
      const defaults = createConfig({}, {});
      expect(defaults.YOUTUBE_TRANSCRIPT_MAX_VIDEOS).toBe(3);
      expect(defaults.YOUTUBE_QUERY_EVERY_N).toBe(5);
      expect(defaults.YOUTUBE_TRANSCRIPT_LANG).toBe('en');

      const overridden = createConfig({
        PI_RESEARCH_YOUTUBE_TRANSCRIPT_MAX_VIDEOS: '5',
        PI_RESEARCH_YOUTUBE_QUERY_EVERY_N: '10',
        PI_RESEARCH_YOUTUBE_TRANSCRIPT_LANG: 'es',
      }, {});
      expect(overridden.YOUTUBE_TRANSCRIPT_MAX_VIDEOS).toBe(5);
      expect(overridden.YOUTUBE_QUERY_EVERY_N).toBe(10);
      expect(overridden.YOUTUBE_TRANSCRIPT_LANG).toBe('es');

      // out-of-range values clamp
      const clamped = createConfig({ PI_RESEARCH_YOUTUBE_TRANSCRIPT_MAX_VIDEOS: '99' }, {});
      expect(clamped.YOUTUBE_TRANSCRIPT_MAX_VIDEOS).toBe(5);
    });
  });

  describe('createConfig', () => {
    describe('environment precedence and side-effects', () => {
      it('lets processEnv override the .env-file layer (the two-arg contract)', () => {
        // 200000 and 400000 are both within the [180000, 1800000] clamp range,
        // so this isolates precedence, not clamping.
        const config = createConfig(
          { PI_RESEARCH_TIMEOUT_MS: '200000' },
          { PI_RESEARCH_TIMEOUT_MS: '400000' },
        );
        expect(config.RESEARCHER_TIMEOUT_MS).toBe(400000);
      });

      it('uses the .env-file value when processEnv does not set the key', () => {
        const config = createConfig({ PI_RESEARCH_TIMEOUT_MS: '200000' }, {});
        expect(config.RESEARCHER_TIMEOUT_MS).toBe(200000);
      });

      it('syncs processEnv.PI_RESEARCH_DEBUG from config.DEBUG when it is unset', () => {
        const processEnv: Record<string, string | undefined> = {};
        const config = createConfig({ PI_RESEARCH_DEBUG: 'true' }, processEnv);
        expect(config.DEBUG).toBe(true);
        // The side-effect lets isVerboseFromEnv() (which reads the env var) see
        // a TUI-configured debug flag without a circular import.
        expect(processEnv['PI_RESEARCH_DEBUG']).toBe('true');
      });

      it('does NOT pin processEnv.PI_RESEARCH_DEBUG when DEBUG is false (prevents cross-interface bleed)', () => {
        // Regression: createConfig runs with the shared process.env and getConfig merges it LAST,
        // so pinning 'false' from the first-resolved interface would override a later interface
        // whose own config enables DEBUG (silently disabling its debug logging). Only opt in.
        const processEnv: Record<string, string | undefined> = {};
        const config = createConfig({ PI_RESEARCH_DEBUG: 'false' }, processEnv);
        expect(config.DEBUG).toBe(false);
        expect(processEnv['PI_RESEARCH_DEBUG']).toBeUndefined();
      });

      it('does not overwrite an already-set processEnv.PI_RESEARCH_DEBUG', () => {
        const processEnv: Record<string, string | undefined> = { PI_RESEARCH_DEBUG: 'TRUE' };
        const config = createConfig({}, processEnv);
        expect(config.DEBUG).toBe(true);
        // Already present → left byte-for-byte untouched (not normalized to 'true').
        expect(processEnv['PI_RESEARCH_DEBUG']).toBe('TRUE');
      });

      it('coerces booleans: only "true" (any case) is true', () => {
        expect(createConfig({}, { PI_RESEARCH_DEBUG: 'TRUE' }).DEBUG).toBe(true);
        expect(createConfig({}, { PI_RESEARCH_DEBUG: 'True' }).DEBUG).toBe(true);
        expect(createConfig({}, { PI_RESEARCH_DEBUG: '1' }).DEBUG).toBe(false);
        expect(createConfig({}, { PI_RESEARCH_DEBUG: 'yes' }).DEBUG).toBe(false);
        expect(createConfig({}, { PI_RESEARCH_DEBUG: '' }).DEBUG).toBe(DEFAULTS.DEBUG);
      });

      it('honors the legacy CACHE_TTL_DAYS env name when the canonical one is absent', () => {
        const config = createConfig({ PI_RESEARCH_KNOWLEDGE_STORE_CACHE_TTL_DAYS: '30' }, {});
        expect(config.KNOWLEDGE_STORE_CACHE_TTL_DAYS).toBe(30);
      });

      it('prefers the canonical CACHE_TTL_DAYS name when both are present', () => {
        const config = createConfig(
          {
            PI_RESEARCH_CACHE_TTL_DAYS: '10',
            PI_RESEARCH_KNOWLEDGE_STORE_CACHE_TTL_DAYS: '30',
          },
          {},
        );
        expect(config.KNOWLEDGE_STORE_CACHE_TTL_DAYS).toBe(10);
      });
    });

    describe('positive cases', () => {
      it('should use defaults when no environment vars', () => {
        const env = {} as Record<string, string | undefined>;
        const config = createConfig(env, {});

        expect(config.RESEARCHER_TIMEOUT_MS).toBe(DEFAULTS.RESEARCHER_TIMEOUT_MS);
        expect(config.MAX_CONCURRENT_RESEARCHERS).toBe(DEFAULTS.MAX_CONCURRENT_RESEARCHERS);
        expect(config.RESEARCHER_MAX_RETRIES).toBe(DEFAULTS.RESEARCHER_MAX_RETRIES);
        expect(config.RESEARCHER_MAX_RETRY_DELAY_MS).toBe(DEFAULTS.RESEARCHER_MAX_RETRY_DELAY_MS);
        expect(config.TUI_REFRESH_DEBOUNCE_MS).toBe(DEFAULTS.TUI_REFRESH_DEBOUNCE_MS);
        expect(config.DEFAULT_RESEARCH_DEPTH).toBe(DEFAULTS.DEFAULT_RESEARCH_DEPTH);
        expect(config.WORKER_THREADS).toBe(DEFAULTS.WORKER_THREADS);
      });

      it('should use custom RESEARCHER_TIMEOUT_MS from env', () => {
        const env = { PI_RESEARCH_TIMEOUT_MS: '400000' };
        const config = createConfig(env, {});

        expect(config.RESEARCHER_TIMEOUT_MS).toBe(400000);
      });

      it('should parse custom RESEARCHER_TIMEOUT_MS from env', () => {
        const env = {
          PI_RESEARCH_TIMEOUT_MS: '180000',
        };
        const config = createConfig(env, {});

        expect(config.RESEARCHER_TIMEOUT_MS).toBe(180000);
      });

      it('should parse knowledge store configuration from env', () => {
        const env = {
          PI_RESEARCH_KNOWLEDGE_STORE_MODE: 'project',
          PI_RESEARCH_EMBEDDING_MODEL: 'custom-model',
          PI_RESEARCH_CACHE_TTL_DAYS: '15',
        };
        const config = createConfig(env, {});

        expect(config.KNOWLEDGE_STORE_MODE).toBe('project');
        expect(config.EMBEDDING_MODEL).toBe('custom-model');
        expect(config.KNOWLEDGE_STORE_CACHE_TTL_DAYS).toBe(15);
      });

      // Migration logic removed
    });
  });

  describe('getConfig', () => {
    it('should return default config if no env', () => {
      const config = getConfig();
      expect(config.RESEARCHER_TIMEOUT_MS).toBe(DEFAULTS.RESEARCHER_TIMEOUT_MS);
    });
  });

  describe('one-time registry→config.env migration', () => {
    it('writes only the keys actually present in the home registry, not a full default snapshot', async () => {
      // Regression: the migration used to save the ENTIRE user key set (createConfig
      // fills defaults), freezing the current defaults into config.env forever.
      const os = await import('node:os');
      const registryContent = JSON.stringify({
        [os.homedir()]: {
          PI_RESEARCH_MAX_RESEARCHERS: '2',
          PI_RESEARCH_MODEL: 'prov/model',
        },
      });
      vi.mocked(fs.existsSync).mockImplementation((p: any) => String(p).includes('project-settings.json'));
      vi.mocked(fs.readFileSync).mockImplementation((p: any) =>
        String(p).includes('project-settings.json') ? registryContent : '');

      getConfig('/tmp/migration-scope-test');

      const tmpWrite = vi.mocked(fs.writeFileSync).mock.calls
        .find(c => String(c[0]).includes('config.env.tmp'));
      expect(tmpWrite).toBeDefined();
      const written = tmpWrite![1] as string;
      expect(written).toContain('PI_RESEARCH_MAX_RESEARCHERS=2');
      expect(written).toContain('PI_RESEARCH_MODEL=prov/model');
      // No defaulted keys frozen in:
      expect(written).not.toContain('PI_RESEARCH_TIMEOUT_MS');
      expect(written).not.toContain('PI_RESEARCH_EMBEDDING_MODEL');

      // Restore the factory defaults for subsequent tests (clearAllMocks keeps impls).
      vi.mocked(fs.existsSync).mockImplementation(() => false);
      vi.mocked(fs.readFileSync).mockImplementation(() => '');
    });
  });

  describe('legacy 0.1.x env-var warning', () => {
    it('warns once when a dead 0.1.x variable is set (upgrade aid)', async () => {
      const { logger } = await import('../../src/logger.ts');
      const warnSpy = vi.spyOn(logger, 'warn');
      process.env['PROXY_URL'] = 'http://127.0.0.1:8080';
      process.env['PI_RESEARCH_VERBOSE'] = '1';
      getConfig('/tmp/legacy-env-test');
      const legacyWarnings = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('has no effect in v1.0.0'),
      );
      expect(legacyWarnings.some((c) => (c[0] as string).includes('PROXY_URL'))).toBe(true);
      expect(legacyWarnings.some((c) => (c[0] as string).includes('PI_RESEARCH_VERBOSE'))).toBe(true);

      // Once per process: a second load must not repeat the warnings.
      warnSpy.mockClear();
      getConfig('/tmp/legacy-env-test-2');
      expect(
        warnSpy.mock.calls.some(
          (c) => typeof c[0] === 'string' && c[0].includes('has no effect in v1.0.0'),
        ),
      ).toBe(false);
      delete process.env['PROXY_URL'];
      delete process.env['PI_RESEARCH_VERBOSE'];
    });

    it('stays silent when no legacy variable is present', async () => {
      const { logger } = await import('../../src/logger.ts');
      delete process.env['PROXY_URL'];
      const warnSpy = vi.spyOn(logger, 'warn');
      getConfig('/tmp/legacy-env-clean');
      expect(
        warnSpy.mock.calls.some(
          (c) => typeof c[0] === 'string' && c[0].includes('has no effect in v1.0.0'),
        ),
      ).toBe(false);
    });
  });

  describe('validateConfig', () => {
    it('should validate default config without throwing', () => {
      expect(() => validateConfig(DEFAULTS)).not.toThrow();
    });

    it('should clamp RESEARCHER_TIMEOUT_MS to minimum (180000) when below range', () => {
      const config = createConfig({ PI_RESEARCH_TIMEOUT_MS: '60000' }, {});
      expect(config.RESEARCHER_TIMEOUT_MS).toBe(180000);
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should clamp RESEARCHER_TIMEOUT_MS to maximum (1800000) when above range', () => {
      const config = createConfig({ PI_RESEARCH_TIMEOUT_MS: '9999999' }, {});
      expect(config.RESEARCHER_TIMEOUT_MS).toBe(1800000);
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should clamp MAX_CONCURRENT_RESEARCHERS to minimum (1) when below range', () => {
      const config = createConfig({ PI_RESEARCH_MAX_RESEARCHERS: '0' }, {});
      expect(config.MAX_CONCURRENT_RESEARCHERS).toBe(1);
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should clamp MAX_CONCURRENT_RESEARCHERS to maximum (5) when above range', () => {
      const config = createConfig({ PI_RESEARCH_MAX_RESEARCHERS: '6' }, {});
      expect(config.MAX_CONCURRENT_RESEARCHERS).toBe(5);
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should clamp DEFAULT_RESEARCH_DEPTH to range 1–3', () => {
      const low = createConfig({ PI_RESEARCH_DEFAULT_RESEARCH_DEPTH: '0' }, {});
      expect(low.DEFAULT_RESEARCH_DEPTH).toBe(1);
      expect(() => validateConfig(low)).not.toThrow();
      const high = createConfig({ PI_RESEARCH_DEFAULT_RESEARCH_DEPTH: '4' }, {});
      expect(high.DEFAULT_RESEARCH_DEPTH).toBe(3);
      expect(() => validateConfig(high)).not.toThrow();
    });

    it('should clamp WORKER_CONCURRENCY to range 1–10', () => {
      const low = createConfig({ PI_RESEARCH_WORKER_CONCURRENCY: '0' }, {});
      expect(low.WORKER_CONCURRENCY).toBe(1);
      expect(() => validateConfig(low)).not.toThrow();
    });

    it('coerces an unsupported EMBEDDING_DEVICE env value to the default', () => {
      // Env parsing is lenient-with-a-warning: a typo'd device falls back to the
      // default instead of producing a value no downstream code handles.
      const config = createConfig({ PI_RESEARCH_EMBEDDING_DEVICE: 'invalid' }, {});
      expect(config.EMBEDDING_DEVICE).toBe('auto');
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('coerces EMBEDDING_DEVICE of "cuda" to the default', () => {
      const config = createConfig({ PI_RESEARCH_EMBEDDING_DEVICE: 'cuda' }, {});
      expect(config.EMBEDDING_DEVICE).toBe('auto');
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('validateConfig still rejects an EMBEDDING_DEVICE set invalidly in-object (bypassing env parsing)', () => {
      const config = createConfig({}, {});
      (config as any).EMBEDDING_DEVICE = 'cuda';
      expect(() => validateConfig(config)).toThrow('must match a schema in anyOf');
    });

    it('should accept EMBEDDING_DEVICE of "webgpu"', () => {
      const config = createConfig({ PI_RESEARCH_EMBEDDING_DEVICE: 'webgpu' }, {});
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should accept EMBEDDING_DEVICE of "cpu"', () => {
      const config = createConfig({ PI_RESEARCH_EMBEDDING_DEVICE: 'cpu' }, {});
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should clamp SCRAPE_TIMEOUT_MS to minimum (5000) when below range', () => {
      const config = createConfig({ PI_RESEARCH_SCRAPE_TIMEOUT_MS: '1000' }, {});
      expect(config.SCRAPE_TIMEOUT_MS).toBe(5000);
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should clamp SCRAPE_TIMEOUT_MS to maximum (120000) when above range', () => {
      const config = createConfig({ PI_RESEARCH_SCRAPE_TIMEOUT_MS: '999999' }, {});
      expect(config.SCRAPE_TIMEOUT_MS).toBe(120000);
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should clamp WORKER_CONCURRENCY to maximum (10) when above range', () => {
      const config = createConfig({ PI_RESEARCH_WORKER_CONCURRENCY: '999' }, {});
      expect(config.WORKER_CONCURRENCY).toBe(10);
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('coerces an invalid KNOWLEDGE_STORE_MODE env value to the default ("global")', () => {
      const config = createConfig({ PI_RESEARCH_KNOWLEDGE_STORE_MODE: 'invalid-mode' }, {});
      expect(config.KNOWLEDGE_STORE_MODE).toBe('global');
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('defaults KNOWLEDGE_STORE_MODE to "global" when unset', () => {
      const config = createConfig({}, {});
      expect(config.KNOWLEDGE_STORE_MODE).toBe('global');
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('validateConfig still rejects a KNOWLEDGE_STORE_MODE set invalidly in-object', () => {
      const config = createConfig({}, {});
      (config as any).KNOWLEDGE_STORE_MODE = 'invalid-mode';
      expect(() => validateConfig(config)).toThrow('must match a schema in anyOf');
    });

    it('should accept valid MIGRATION_STRATEGY values', () => {
      for (const strategy of ['drop', 're-embed', 'backup'] as const) {
        const config = createConfig({ PI_RESEARCH_MIGRATION_STRATEGY: strategy }, {});
        expect(() => validateConfig(config)).not.toThrow();
        expect(config.MIGRATION_STRATEGY).toBe(strategy);
      }
    });

    it('should clamp HEALTH_CHECK_TIMEOUT_MS to minimum (2000) when below range', () => {
      const config = createConfig({ PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS: '1000' }, {});
      expect(config.HEALTH_CHECK_TIMEOUT_MS).toBe(2000);
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should clamp HEALTH_CHECK_TIMEOUT_MS to maximum (120000) when above range', () => {
      const config = createConfig({ PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS: '200000' }, {});
      expect(config.HEALTH_CHECK_TIMEOUT_MS).toBe(120000);
      expect(() => validateConfig(config)).not.toThrow();
    });
  });

  describe('setConfig / resetConfig', () => {
    it('setConfig persists and getConfig returns the new value', () => {
      const config = createConfig({ PI_RESEARCH_TIMEOUT_MS: '300000' }, {});
      setConfig(config);
      expect(getConfig().RESEARCHER_TIMEOUT_MS).toBe(300000);
    });

    it('resetConfig causes getConfig to re-read defaults from env', () => {
      const config = createConfig({ PI_RESEARCH_TIMEOUT_MS: '300000' }, {});
      setConfig(config);
      resetConfig();
      // After reset, getConfig() rebuilds from env (cleared in beforeEach), giving defaults
      expect(getConfig().RESEARCHER_TIMEOUT_MS).toBe(DEFAULTS.RESEARCHER_TIMEOUT_MS);
    });
  });

  describe('env parsing edge cases', () => {
    it('ignores non-numeric values for numeric fields and uses defaults', () => {
      // createConfig uses parseInt which returns NaN for non-numeric strings;
      // parseEnvNumber falls back to the default value
      const config = createConfig({ PI_RESEARCH_TIMEOUT_MS: 'not-a-number' }, {});
      expect(config.RESEARCHER_TIMEOUT_MS).toBe(DEFAULTS.RESEARCHER_TIMEOUT_MS);
    });

    it('parses the minimum-valid RESEARCHER_TIMEOUT_MS (180000) without error', () => {
      const config = createConfig({ PI_RESEARCH_TIMEOUT_MS: '180000' }, {});
      expect(() => validateConfig(config)).not.toThrow();
      expect(config.RESEARCHER_TIMEOUT_MS).toBe(180000);
    });

    it('parses the maximum-valid RESEARCHER_TIMEOUT_MS (1800000) without error', () => {
      const config = createConfig({ PI_RESEARCH_TIMEOUT_MS: '1800000' }, {});
      expect(() => validateConfig(config)).not.toThrow();
      expect(config.RESEARCHER_TIMEOUT_MS).toBe(1800000);
    });
  });
});
