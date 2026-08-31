/**
 * pi-ai module-graph skew policy (src/core/pi-ai-skew.ts).
 *
 * Pure classification is tested with literal version inputs; the live
 * checkPiAiSkew() walk is only smoke-tested for shape — its inputs depend on
 * the executing process's layout (under vitest there is no pi host above us,
 * so it must classify as 'standalone' and never throw).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { classifyPiAiSkew, checkPiAiSkew, resolveExtensionCopies } from '../../../src/core/pi-ai-skew.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('classifyPiAiSkew', () => {
  it('no host → standalone, silent', () => {
    const r = classifyPiAiSkew({ hostVersion: null, extPiAi: '0.84.2', extPiCodingAgent: '0.84.2' });
    expect(r).toEqual({ level: 'standalone', fatal: false, message: null });
  });

  it('extension copies match host → ok', () => {
    const r = classifyPiAiSkew({ hostVersion: '0.84.4', extPiAi: '0.84.4', extPiCodingAgent: '0.84.4' });
    expect(r).toEqual({ level: 'ok', fatal: false, message: null });
  });

  it('stale extension pi-ai → FATAL, message names both versions and the remedy', () => {
    // The exact 2026-08-30 incident state.
    const r = classifyPiAiSkew(
      { hostVersion: '0.84.4', extPiAi: '0.84.2', extPiCodingAgent: '0.84.2' },
      '/ext/root',
    );
    expect(r.level).toBe('stale');
    expect(r.fatal).toBe(true);
    expect(r.message).toContain('host pi 0.84.4');
    expect(r.message).toContain('pi-ai 0.84.2');
    expect(r.message).toContain('clampThinkingBudgetToAnswerRoom');
    expect(r.message).toContain('cd /ext/root && npm install');
  });

  it('a copy lagging the host is fatal however it is labeled (stale or internal)', () => {
    // Half-updated tree: copies disagree AND one lags the host.
    const r = classifyPiAiSkew({ hostVersion: '0.84.4', extPiAi: '0.84.4', extPiCodingAgent: '0.84.3' });
    expect(r.level).toBe('internal');
    expect(r.fatal).toBe(true);
    // Consistent-but-stale tree.
    const r2 = classifyPiAiSkew({ hostVersion: '0.84.4', extPiAi: '0.84.3', extPiCodingAgent: '0.84.3' });
    expect(r2.level).toBe('stale');
    expect(r2.fatal).toBe(true);
  });

  it('patch-level staleness within the same minor is still skew (the export appeared in 0.84.3)', () => {
    const r = classifyPiAiSkew({ hostVersion: '0.84.4', extPiAi: '0.84.3', extPiCodingAgent: '0.84.3' });
    expect(r.level).toBe('stale');
    expect(r.fatal).toBe(true);
  });

  it('extension newer than host → warn, not fatal (untested direction, no known failure)', () => {
    const r = classifyPiAiSkew({ hostVersion: '0.84.2', extPiAi: '0.84.4', extPiCodingAgent: '0.84.4' });
    expect(r.level).toBe('newer');
    expect(r.fatal).toBe(false);
    expect(r.message).toContain('newer than host pi 0.84.2');
  });

  it('internal disagreement between extension copies → fatal when a copy lags the host, warn otherwise', () => {
    // One copy stale vs host, copies disagree: root cause named, still fatal.
    const r = classifyPiAiSkew({ hostVersion: '0.84.4', extPiAi: '0.84.4', extPiCodingAgent: '0.84.3' });
    expect(r.level).toBe('internal');
    expect(r.fatal).toBe(true);
    expect(r.message).toContain('internally inconsistent');
    // Copies disagree but neither lags the host: warn only.
    const r2 = classifyPiAiSkew({ hostVersion: '0.84.2', extPiAi: '0.84.2', extPiCodingAgent: '0.84.4' });
    expect(r2.level).toBe('internal');
    expect(r2.fatal).toBe(false);
    expect(r2.message).toContain('internally inconsistent');
  });

  it('missing extension copy → incomplete warn, never fatal', () => {
    const r = classifyPiAiSkew({ hostVersion: '0.84.4', extPiAi: null, extPiCodingAgent: '0.84.4' });
    expect(r).toMatchObject({ level: 'incomplete', fatal: false });
    expect(r.message).toContain('pi-ai');
  });

  it('half-hoisted layout: a PRESENT copy that lags the host is fatal stale, not an incomplete warn', () => {
    // The 2026-08-30 crash shape: a stale nested pi-ai beside a hoisted
    // (absent) pi-coding-agent — there is no second copy to compare against,
    // but the present copy lags the host, which is the proven crash direction.
    const r = classifyPiAiSkew({ hostVersion: '0.84.4', extPiAi: '0.84.2', extPiCodingAgent: null });
    expect(r.level).toBe('stale');
    expect(r.fatal).toBe(true);
    expect(r.message).toContain('pi-ai');
    expect(r.message).toContain('LAGS host pi 0.84.4');
    // Mirror: a stale nested pi-coding-agent with no nested pi-ai.
    const r2 = classifyPiAiSkew({ hostVersion: '0.84.4', extPiAi: null, extPiCodingAgent: '0.84.3' });
    expect(r2.level).toBe('stale');
    expect(r2.fatal).toBe(true);
  });

  it('unparseable versions → incomplete warn (the guard must not invent startup failures)', () => {
    const r = classifyPiAiSkew({ hostVersion: 'banana', extPiAi: '0.84.4', extPiCodingAgent: '0.84.4' });
    expect(r).toMatchObject({ level: 'incomplete', fatal: false });
  });
});

describe('resolveExtensionCopies (node_modules walk)', () => {
  // Fixture trees reproducing every real install layout. The anchor is a module
  // file inside the extension package, exactly what jiti hands checkPiAiSkew.
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  });

  function makeLayout(build: (root: string) => string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ai-skew-layout-'));
    roots.push(root);
    return build(root);
  }

  function writePkg(file: string, name: string, version: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ name, version }));
  }

  const ANCHOR_PARTS = path.join('@lincoln504', 'pi-research', 'src', 'core', 'pi-ai-skew.ts');

  it('flat managed tree (pi install npm:): copies hoist ABOVE the package — resolved, not "missing"', () => {
    // Measured shape of ~/.pi/agent/npm/ after `pi install npm:@lincoln504/pi-research`:
    // one flat npm tree, the package at node_modules/@lincoln504/pi-research with NO
    // nested node_modules, its @earendil-works deps hoisted to the managed root.
    let root = '';
    const anchor = makeLayout((r) => {
      root = r;
      writePkg(path.join(root, 'node_modules', '@earendil-works', 'pi-ai', 'package.json'), '@earendil-works/pi-ai', '0.84.4');
      writePkg(path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), '@earendil-works/pi-coding-agent', '0.84.4');
      writePkg(path.join(root, 'node_modules', '@lincoln504', 'pi-research', 'package.json'), '@lincoln504/pi-research', '1.6.6');
      return path.join(root, 'node_modules', ANCHOR_PARTS);
    });
    fs.mkdirSync(path.dirname(anchor), { recursive: true });
    fs.writeFileSync(anchor, 'export {};\n');
    const pkgRoot = path.join(root, 'node_modules', '@lincoln504', 'pi-research');

    const r = resolveExtensionCopies(anchor);
    expect(r.piAi).toBe('0.84.4');
    expect(r.piCodingAgent).toBe('0.84.4');
    // extRoot is still the package dir (the remedy target of last resort)...
    expect(r.extRoot).toBe(pkgRoot);
    // ...but each copy's install root is the MANAGED TREE ROOT, which is what
    // the remedy must `cd` into — `npm install` inside the package dir would
    // create a rogue divergent nested install.
    expect(r.piAiRoot).toBe(root);
    expect(r.piCodingAgentRoot).toBe(root);

    // The regression this pins: a healthy flat install classifies ok, NOT the
    // "missing @earendil-works/pi-ai" incomplete warn the nested-only lookup
    // produced here on every startup.
    const c = classifyPiAiSkew(
      { hostVersion: '0.84.4', extPiAi: r.piAi, extPiCodingAgent: r.piCodingAgent, piAiRoot: r.piAiRoot!, piCodingAgentRoot: r.piCodingAgentRoot! },
      r.extRoot ?? undefined,
    );
    expect(c).toEqual({ level: 'ok', fatal: false, message: null });
  });

  it('nested copies (git install / dev repo): package-local node_modules wins', () => {
    let root = '';
    const anchor = makeLayout((r) => {
      root = r;
      writePkg(path.join(root, 'pkg', 'node_modules', '@earendil-works', 'pi-ai', 'package.json'), '@earendil-works/pi-ai', '0.84.2');
      writePkg(path.join(root, 'pkg', 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), '@earendil-works/pi-coding-agent', '0.84.2');
      writePkg(path.join(root, 'pkg', 'package.json'), '@lincoln504/pi-research', '1.6.6');
      writePkg(path.join(root, 'node_modules', '@earendil-works', 'pi-ai', 'package.json'), '@earendil-works/pi-ai', '0.84.4');
      writePkg(path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), '@earendil-works/pi-coding-agent', '0.84.4');
      return path.join(root, 'pkg', 'src', 'index.ts');
    });
    const r = resolveExtensionCopies(anchor);
    // Node binds the NEAREST node_modules — the stale nested copy, which is
    // exactly the skew the guard must catch.
    expect(r.piAi).toBe('0.84.2');
    expect(r.piCodingAgent).toBe('0.84.2');
    // The install root is the directory OWNING that nearest node_modules
    // (<root>/pkg), i.e. what `cd … && npm install` must target.
    expect(r.piAiRoot).toBe(path.join(root, 'pkg'));
    expect(r.extRoot).toBe(path.join(root, 'pkg'));
  });

  it('half-hoisted incident shape: stale nested pi-ai beside a fresh hoisted pi-coding-agent', () => {
    let root = '';
    const anchor = makeLayout((r) => {
      root = r;
      writePkg(path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), '@earendil-works/pi-coding-agent', '0.84.4');
      writePkg(path.join(root, 'node_modules', '@lincoln504', 'pi-research', 'package.json'), '@lincoln504/pi-research', '1.6.6');
      writePkg(path.join(root, 'node_modules', '@lincoln504', 'pi-research', 'node_modules', '@earendil-works', 'pi-ai', 'package.json'), '@earendil-works/pi-ai', '0.84.2');
      return path.join(root, 'node_modules', ANCHOR_PARTS);
    });
    fs.mkdirSync(path.dirname(anchor), { recursive: true });
    fs.writeFileSync(anchor, 'export {};\n');
    const pkgRoot = path.join(root, 'node_modules', '@lincoln504', 'pi-research');

    const r = resolveExtensionCopies(anchor);
    expect(r.piAi).toBe('0.84.2');
    expect(r.piCodingAgent).toBe('0.84.4');
    const c = classifyPiAiSkew(
      { hostVersion: '0.84.4', extPiAi: r.piAi, extPiCodingAgent: r.piCodingAgent, piAiRoot: r.piAiRoot!, piCodingAgentRoot: r.piCodingAgentRoot! },
      r.extRoot ?? undefined,
    );
    expect(c.level).toBe('internal');
    expect(c.fatal).toBe(true);
    // The remedy aims at the tree owning the STALE copy (the package's own
    // nested node_modules here), not the managed root.
    expect(c.message).toContain(`cd ${pkgRoot} && npm install`);
  });

  it('truly absent copies: both null, extRoot still found', () => {
    let root = '';
    const anchor = makeLayout((r) => {
      root = r;
      writePkg(path.join(root, 'node_modules', '@lincoln504', 'pi-research', 'package.json'), '@lincoln504/pi-research', '1.6.6');
      return path.join(root, 'node_modules', ANCHOR_PARTS);
    });
    fs.mkdirSync(path.dirname(anchor), { recursive: true });
    fs.writeFileSync(anchor, 'export {};\n');

    const r = resolveExtensionCopies(anchor);
    expect(r.piAi).toBeNull();
    expect(r.piCodingAgent).toBeNull();
    expect(r.extRoot).toBe(path.join(root, 'node_modules', '@lincoln504', 'pi-research'));
  });

  it('stale flat-managed copies lag the host → fatal stale with a managed-root remedy', () => {
    // The actual 2026-08-30 protection case on the PRIMARY install path: the
    // host updates, the managed tree's hoisted copies do not.
    const r = { piAi: '0.84.2', piCodingAgent: '0.84.2', piAiRoot: '/home/x/.pi/agent/npm', extRoot: '/home/x/.pi/agent/npm/node_modules/@lincoln504/pi-research' };
    const c = classifyPiAiSkew(
      { hostVersion: '0.84.4', extPiAi: r.piAi, extPiCodingAgent: r.piCodingAgent, piAiRoot: r.piAiRoot, piCodingAgentRoot: r.piAiRoot },
      r.extRoot,
    );
    expect(c.level).toBe('stale');
    expect(c.fatal).toBe(true);
    expect(c.message).toContain('cd /home/x/.pi/agent/npm && npm install');
    expect(c.message).not.toContain(`${r.extRoot} && npm install`);
  });
});

describe('checkPiAiSkew (live walk)', () => {
  it('never throws and returns a well-formed result', () => {
    const r = checkPiAiSkew();
    expect(typeof r.fatal).toBe('boolean');
    expect(r.level).toMatch(/^(ok|standalone|incomplete|stale|newer|internal)$/);
    expect(r.message === null || typeof r.message === 'string').toBe(true);
  });

  it('classifies as standalone under vitest (no pi host package above the test runner)', () => {
    // argv[1] is the vitest binary; the named walk for pi-coding-agent must
    // fail, degrading to standalone rather than guessing. If this ever flips
    // to 'ok' because CI grows a pi install, that is fine too — the assertion
    // is that it does NOT produce a false fatal.
    const r = checkPiAiSkew();
    expect(r.fatal).toBe(false);
  });

  it('accepts a real-path anchor as well as a file:// URL', () => {
    // Same module, two spellings of the same location: the URL form is what
    // jiti produces, the plain path is what a bundler may inline.
    const viaUrl = checkPiAiSkew(import.meta.url);
    const viaPath = checkPiAiSkew(
      new URL('.', import.meta.url).pathname + 'pi-ai-skew.ts',
    );
    expect(viaUrl.level).toBe(viaPath.level);
  });
});
