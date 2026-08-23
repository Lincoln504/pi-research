/**
 * Contract test for the pi-host ResourceLoader adapter.
 *
 * This module is the seam where a pi upgrade can break every research run at once.
 * pi 0.81.0 added `pendingNativeProviderRegistrations` to ExtensionRuntime, and the
 * hand-written mock this factory used to return omitted it — the host's
 * `for (... of runtime.pendingNativeProviderRegistrations)` threw "is not iterable"
 * and EVERY researcher session aborted with "Research produced no report". Nothing in
 * the suite noticed, because the only test that touches this module mocks it out.
 *
 * These tests deliberately use the REAL pi package, not a mock: the whole point is to
 * fail when the installed host's runtime contract stops matching what this adapter
 * hands it. tsc already enforces the compile-time half (the returned object must
 * satisfy pi's ResourceLoader type); what it cannot see is the runtime shape of the
 * object `createExtensionRuntime()` builds, which is precisely what broke.
 */

import { describe, it, expect } from 'vitest';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { makeResourceLoader } from '../../../src/utils/make-resource-loader.ts';

/**
 * Prototype members of the host's own loader that are internal helpers, not part of
 * the ResourceLoader contract a consumer must implement. Anything else the host adds
 * that looks like a public accessor should be reviewed — see the drift test below.
 */
const HOST_INTERNAL_HELPERS = new Set([
  'constructor',
  'addExtensionConflictDiagnostics',
  'applyExtensionSourceInfo',
  'dedupePrompts',
  'dedupeThemes',
  'detectExtensionConflicts',
  'discoverAppendSystemPromptFile',
  'discoverSystemPromptFile',
  'findSourceInfoForPath',
  'getDefaultSourceInfoForPath',
  'isUnderPath',
  'loadCurrentExtensionSet',
  'loadExtensionFactories',
  'loadFinalExtensionSet',
  'loadProjectTrustExtensions',
  'loadThemeFromFile',
  'loadThemes',
  'loadThemesFromDir',
  'mapSkillPath',
  'mergePaths',
  'normalizeExtensionPaths',
  'resolveExtensionLoadPath',
  'resolveResourcePath',
  'updatePromptsFromPaths',
  'updateSkillsFromPaths',
  'updateThemesFromPaths',
]);

function prototypeMembers(ctor: any): string[] {
  const names = new Set<string>();
  let proto = ctor?.prototype;
  while (proto && proto !== Object.prototype) {
    for (const n of Object.getOwnPropertyNames(proto)) names.add(n);
    proto = Object.getPrototypeOf(proto);
  }
  return [...names];
}

describe('makeResourceLoader — pi host contract', () => {
  it('hands the host an ExtensionRuntime whose registration lists are iterable', () => {
    const runtime: any = (makeResourceLoader('system prompt').getExtensions() as any).runtime;

    // The exact 0.81.0 break: bindCore() / createAgentSessionServices() iterate these.
    // An undefined field throws and takes down the whole sub-session.
    expect(typeof runtime.pendingNativeProviderRegistrations?.[Symbol.iterator]).toBe('function');
    expect(typeof runtime.pendingProviderRegistrations?.[Symbol.iterator]).toBe('function');
    expect([...runtime.pendingNativeProviderRegistrations]).toEqual([]);
    expect([...runtime.pendingProviderRegistrations]).toEqual([]);
  });

  it('returns the shapes the host destructures from each resource getter', () => {
    const loader = makeResourceLoader('my system prompt');

    const extensions: any = loader.getExtensions();
    expect(Array.isArray(extensions.extensions)).toBe(true);
    expect(Array.isArray(extensions.errors)).toBe(true);
    expect(extensions.runtime).toBeTruthy();

    expect(Array.isArray((loader.getSkills() as any).skills)).toBe(true);
    expect(Array.isArray((loader.getSkills() as any).diagnostics)).toBe(true);
    expect(Array.isArray((loader.getPrompts() as any).prompts)).toBe(true);
    expect(Array.isArray((loader.getThemes() as any).themes)).toBe(true);
    expect(Array.isArray((loader.getAgentsFiles() as any).agentsFiles)).toBe(true);
    expect(Array.isArray(loader.getAppendSystemPrompt())).toBe(true);
    expect(Array.isArray(loader.getAppendSystemPromptSources())).toBe(true);
    expect(loader.getSystemPromptSource()).toBeUndefined();
  });

  it('serves the system prompt text it was constructed with', () => {
    expect(makeResourceLoader('RESEARCHER SYSTEM PROMPT').getSystemPrompt()).toBe('RESEARCHER SYSTEM PROMPT');
  });

  it('reload() and extendResources() are callable no-ops rather than missing methods', async () => {
    const loader = makeResourceLoader('x');
    expect(() => loader.extendResources({} as any)).not.toThrow();
    await expect(loader.reload()).resolves.toBeUndefined();
  });

  it('implements every public accessor the installed host loader exposes', () => {
    const loader = makeResourceLoader('x') as unknown as Record<string, unknown>;
    const hostPublic = prototypeMembers(DefaultResourceLoader).filter(n => !HOST_INTERNAL_HELPERS.has(n));
    // Guard against a vacuous pass: if the host loader ever stops being a class with a
    // prototype, hostPublic goes empty and the assertion below would trivially succeed.
    expect(hostPublic.length).toBeGreaterThanOrEqual(10);
    expect(hostPublic).toContain('getExtensions');

    const missing = hostPublic.filter(n => typeof loader[n] !== 'function');

    // A failure here means the installed pi added something to its ResourceLoader that
    // this adapter does not implement. Either implement it, or — if it is an internal
    // helper rather than part of the contract — add it to HOST_INTERNAL_HELPERS. Do not
    // delete this assertion: a silently missing method aborts every researcher session
    // at runtime with a green test suite, which is exactly how the 0.81.0 break shipped.
    expect(missing).toEqual([]);
  });
});
