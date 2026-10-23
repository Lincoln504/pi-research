import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findHostPackages, hostDirs, HOST_PACKAGES } from '../../src/host-roots.mjs';
import { initialize, resolve as hookResolve } from '../../src/host-resolve-hook.mjs';

function pkg(root: string, name: string) {
  const dir = join(root, ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', exports: './index.js' }));
  writeFileSync(join(dir, 'index.js'), 'export default 1;\n');
}

describe('host-roots — finding pi\'s copies of the peer dependencies', () => {
  let base: string;
  let globalRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'pi-host-roots-')));
    globalRoot = join(base, 'global', 'node_modules');
    pkg(globalRoot, '@earendil-works/pi-coding-agent');
    // pi's own nested dependencies: not hoisted next to it
    pkg(join(globalRoot, '@earendil-works', 'pi-coding-agent', 'node_modules'), '@earendil-works/pi-ai');
    pkg(join(globalRoot, '@earendil-works', 'pi-coding-agent', 'node_modules'), 'typebox');
  });
  afterAll(() => {
    process.env = saved;
    rmSync(base, { recursive: true, force: true });
  });

  it('finds top-level and nested host packages from PI_RESEARCH_HOST_DIR (either form)', () => {
    for (const dir of [globalRoot, join(globalRoot, '..')]) {
      process.env['PI_RESEARCH_HOST_DIR'] = dir;
      delete process.env['PI_RESEARCH_NO_HOST_FALLBACK'];
      const { found, missing } = findHostPackages(['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', 'typebox']);
      expect(missing).toEqual([]);
      expect(found.get('@earendil-works/pi-coding-agent')).toBe(globalRoot);
      expect(found.get('typebox')).toBe(join(globalRoot, '@earendil-works', 'pi-coding-agent', 'node_modules'));
      expect(hostDirs(found).length).toBe(2);
    }
  });

  it('reports what it could not find, and the opt-out finds nothing', () => {
    process.env['PI_RESEARCH_HOST_DIR'] = globalRoot;
    const r = findHostPackages(['definitely-not-a-real-package']);
    expect([...r.found.keys()]).toEqual([]);
    expect(r.missing).toEqual(['definitely-not-a-real-package']);

    process.env['PI_RESEARCH_NO_HOST_FALLBACK'] = '1';
    expect(findHostPackages(['@earendil-works/pi-coding-agent']).found.size).toBe(0);
    delete process.env['PI_RESEARCH_NO_HOST_FALLBACK'];
  });

  it('covers exactly the peers the shim requires', () => {
    expect(HOST_PACKAGES).toEqual(['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']);
  });

  it('the resolve hook falls back for host packages only, after normal resolution fails', async () => {
    await initialize({ dirs: [globalRoot] });
    const failing = Object.assign(new Error('nope'), { code: 'ERR_MODULE_NOT_FOUND' });
    const next = vi.fn(async (spec: string, ctx: { parentURL?: string }) => {
      if (ctx.parentURL?.includes(globalRoot.replace(/\\/g, '/'))) return { url: `file://fallback/${spec}`, shortCircuit: true };
      throw failing;
    });
    const rescued = await hookResolve('@earendil-works/pi-coding-agent/dist/x.js', { parentURL: 'file:///elsewhere/a.mjs' }, next);
    expect(rescued.url).toContain('fallback/@earendil-works/pi-coding-agent/dist/x.js');
    // A non-host package keeps its original failure
    await expect(hookResolve('left-pad', { parentURL: 'file:///elsewhere/a.mjs' }, next)).rejects.toBe(failing);
    // Anything but "not found" is never swallowed
    const other = Object.assign(new Error('boom'), { code: 'ERR_INVALID_PACKAGE_CONFIG' });
    await expect(hookResolve('typebox', {}, async () => { throw other; })).rejects.toBe(other);
  });
});
