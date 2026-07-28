import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildModelRegistry, getRuntimeForRegistry } from '../../src/core/llm/model-registry-factory.ts';

/**
 * Hermetic via PI_CODING_AGENT_DIR (pi's getAgentDir() env override) pointed at
 * a temp dir — never reads or writes the developer's real ~/.pi/agent.
 *
 * Guards two regressions from the pi 0.80.8 ModelRuntime migration:
 *  1. buildModelRegistry must NOT create the agent dir / auth.json as a side
 *     effect when they don't exist (ModelRuntime's default file-backed
 *     credential store does mkdir+write at construction; we pass an in-memory
 *     store instead). A silent write here would create a pi config dir on every
 *     `status` call on machines without pi, and hard-fail in read-only-$HOME
 *     environments.
 *  2. getRuntimeForRegistry must return the ModelRuntime backing a registry we
 *     built — researcher.ts passes it to createAgentSession as `modelRuntime`,
 *     which is the ONLY way an explicit API key (setRuntimeApiKey) reaches
 *     researcher LLM calls. A registry we did not build maps to undefined.
 */
describe('buildModelRegistry — pi 0.80.8+ ModelRuntime migration', () => {
  let agentDir: string;
  let prevEnv: string | undefined;

  beforeAll(() => {
    agentDir = path.join(mkdtempSync(path.join(os.tmpdir(), 'pir-agentdir-')), 'agent');
    prevEnv = process.env['PI_CODING_AGENT_DIR'];
    process.env['PI_CODING_AGENT_DIR'] = agentDir;
  });
  afterAll(() => {
    if (prevEnv === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = prevEnv;
    rmSync(path.dirname(agentDir), { recursive: true, force: true });
  });

  it('creates NO agent dir or auth.json when none exist (read-only-safe)', async () => {
    expect(existsSync(agentDir)).toBe(false);
    const registry = await buildModelRegistry(undefined, undefined);
    expect(registry).toBeTruthy();
    expect(existsSync(agentDir)).toBe(false);
    expect(existsSync(path.join(agentDir, 'auth.json'))).toBe(false);
  });

  it('creates no files on the explicit apiKey+provider path either', async () => {
    const registry = await buildModelRegistry('sk-test-not-a-real-key', 'openai');
    expect(registry).toBeTruthy();
    expect(existsSync(agentDir)).toBe(false);
  });

  it('maps a built registry to its backing runtime; foreign objects to undefined', async () => {
    const registry = await buildModelRegistry('sk-test-not-a-real-key', 'openai');
    const runtime = getRuntimeForRegistry(registry);
    expect(runtime).toBeTruthy();
    expect(typeof runtime!.setRuntimeApiKey).toBe('function');
    // A registry-shaped object we did not build (e.g. the pi host's own
    // ExtensionContext.modelRegistry) must resolve to undefined so
    // createAgentSession falls back to the host's default runtime.
    expect(getRuntimeForRegistry({ getAvailable: () => [] })).toBeUndefined();
    expect(getRuntimeForRegistry(undefined)).toBeUndefined();
  });

  it('still reads an EXISTING auth.json without creating anything new', async () => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      path.join(agentDir, 'auth.json'),
      JSON.stringify({ openai: { type: 'api_key', key: 'sk-from-auth-json' } }) + '\n',
      'utf-8',
    );
    const before = readdirSync(agentDir).sort();
    const registry = await buildModelRegistry(undefined, undefined);
    expect(registry).toBeTruthy();
    // Reading the existing config must not spawn sibling files (models store etc.).
    expect(readdirSync(agentDir).sort()).toEqual(before);
    rmSync(agentDir, { recursive: true, force: true });
  });
});
