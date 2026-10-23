import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(__dirname, '..', '..', '..');
const read = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

describe('prepack-lancedb — LanceDB ships bundled, without its transformers/sharp chain', () => {
  const root = read('package.json');

  it('runs as the prepack lifecycle step', () => {
    expect(root.scripts.prepack).toBe('node scripts/prepack-lancedb.cjs');
  });

  it('bundles the wrapper and its whole runtime closure', () => {
    expect(root.bundleDependencies).toEqual(expect.arrayContaining(['@lancedb/lancedb', '@opentelemetry/api', 'reflect-metadata']));
    expect(root.dependencies['@lancedb/lancedb']).toMatch(/^\d+\.\d+\.\d+$/); // exact pin
  });

  it('declares every platform binding at the wrapper version, as root optionalDependencies', () => {
    const wrapperPath = 'node_modules/@lancedb/lancedb/package.json';
    if (!existsSync(join(ROOT, wrapperPath))) return;
    const wrapper = read(wrapperPath);
    expect(wrapper.version).toBe(root.dependencies['@lancedb/lancedb']);
    const original = wrapper['x-pi-research-original-optionalDependencies'] ?? wrapper.optionalDependencies ?? {};
    const platform = Object.entries(original).filter(([n]) => n.startsWith('@lancedb/lancedb-'));
    expect(platform.length).toBeGreaterThan(0);
    for (const [name, range] of platform) expect(root.optionalDependencies[name]).toBe(range);
    for (const name of Object.keys(root.optionalDependencies)) {
      if (name.startsWith('@lancedb/lancedb-')) expect(original).toHaveProperty([name]);
    }
  });

  it('the script passes and is idempotent, and leaves no optional edges on the bundled wrapper', () => {
    if (!existsSync(join(ROOT, 'node_modules/@lancedb/lancedb/package.json'))) return;
    for (let i = 0; i < 2; i++) {
      const r = spawnSync(process.execPath, [join(ROOT, 'scripts/prepack-lancedb.cjs')], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    }
    expect(read('node_modules/@lancedb/lancedb/package.json').optionalDependencies).toBeUndefined();
  });
});
