/**
 * Multi-process integration tests for ResearchRunSemaphore.
 *
 * The semaphore exists to cap concurrent research runs *across processes*, and
 * every interesting property of it — the cap actually holding under a thundering
 * herd, slots being handed off on release, a SIGKILLed holder's slot being
 * reclaimed, a PID-reuse impostor not being mistaken for a live owner — is
 * invisible to an in-process test. Those tests share one heap, one PID and one
 * FileLockService module instance, so they can only ever verify the bookkeeping,
 * never the contract.
 *
 * These tests spawn genuine OS processes against a shared slot directory. The
 * child entry (`helpers/run-semaphore-child.ts`) is bundled once with esbuild
 * (the project's own bundler) because Node's native type-stripping cannot load
 * the source graph directly — `src/logger.ts` declares a non-erasable `enum`.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD_SRC = path.join(HERE, 'helpers', 'run-semaphore-child.ts');
const WIRED_CHILD_SRC = path.join(HERE, 'helpers', 'run-semaphore-wired-child.ts');

/** One protocol line emitted by a child (`@@SEM@@ {json}`). */
interface SemEvent {
  event: 'ready' | 'wired' | 'acquired' | 'released' | 'capacity' | 'error';
  label?: string;
  pid?: number;
  slot?: number;
  at?: number;
  slots?: number;
  message?: string;
  /** `wired` only: the state directory the DI graph resolved to. */
  stateDir?: string;
  /** `wired` only: the slot count the DI-constructed semaphore chose. */
  maxSlots?: number;
}

interface ChildOptions {
  label: string;
  slotDir: string;
  maxSlots: number;
  /** Acquire wait before ResearchRunCapacityError. 0 = fail fast. */
  maxWaitMs?: number;
  /** Hold duration before releasing; negative = hold until killed. */
  holdMs?: number;
  startDelayMs?: number;
  /** Which bundled entry to run. Defaults to the direct-construction harness. */
  bundle?: string;
  /** Extra environment, e.g. a sandboxed HOME for the DI-wired harness. */
  extraEnv?: Record<string, string>;
}

/** A spawned child plus the events it has emitted so far. */
interface ChildHandle {
  proc: ChildProcess;
  label: string;
  events: SemEvent[];
  /** Resolves with the exit code once the process exits. */
  exited: Promise<number | null>;
  /** Resolves once an event of the given type is seen (or rejects on timeout). */
  waitFor(event: SemEvent['event'], timeoutMs?: number): Promise<SemEvent>;
  /**
   * Resolves on the first event matching ANY of the given types. Needed to wait
   * for a child to *settle* when the outcome is the thing under test: a herd
   * contender ends on either `acquired` or `capacity`, and racing two `waitFor`
   * calls would leave the losing one to reject unhandled.
   */
  waitForAny(events: Array<SemEvent['event']>, timeoutMs?: number): Promise<SemEvent>;
}

let childBundle: string;
let wiredChildBundle: string;
let buildDir: string;
const live = new Set<ChildProcess>();

beforeAll(async () => {
  // The bundles must live *inside* the repo: `packages: 'external'` leaves bare
  // imports (typebox, …) for Node to resolve at runtime, and Node resolves them
  // relative to the bundle's own location. A bundle in the OS tmpdir has no
  // node_modules above it and dies with ERR_MODULE_NOT_FOUND. `.tmp/` is the
  // project's gitignored scratch convention and is excluded from test discovery.
  const scratchRoot = path.resolve(HERE, '..', '..', '.tmp');
  await mkdir(scratchRoot, { recursive: true });
  buildDir = await mkdtemp(path.join(scratchRoot, 'sem-mp-build-'));
  childBundle = path.join(buildDir, 'run-semaphore-child.mjs');
  wiredChildBundle = path.join(buildDir, 'run-semaphore-wired-child.mjs');
  // `packages: 'external'` mirrors scripts/build.cjs: bundle project source only,
  // leaving bare and node: imports to the runtime resolver.
  await build({
    entryPoints: [CHILD_SRC, WIRED_CHILD_SRC],
    outdir: buildDir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outExtension: { '.js': '.mjs' },
    logLevel: 'silent',
  });
}, 180000);

afterEach(async () => {
  for (const proc of live) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
  live.clear();
});

afterAll(async () => {
  if (buildDir) await rm(buildDir, { recursive: true, force: true });
});

function spawnChild(opts: ChildOptions): ChildHandle {
  const proc = spawn(process.execPath, [opts.bundle ?? childBundle], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SEM_SLOT_DIR: opts.slotDir,
      SEM_LABEL: opts.label,
      SEM_MAX_SLOTS: String(opts.maxSlots),
      SEM_MAX_WAIT_MS: String(opts.maxWaitMs ?? 0),
      SEM_HOLD_MS: String(opts.holdMs ?? 100),
      SEM_START_DELAY_MS: String(opts.startDelayMs ?? 0),
      // Keep each child's logger inside the test sandbox rather than ~/.pi.
      PI_RESEARCH_LOG_PATH: path.join(opts.slotDir, `child-${opts.label}.log`),
      PI_RESEARCH_CONSOLE_LOG: 'false',
      ...opts.extraEnv,
    },
  });
  live.add(proc);

  const events: SemEvent[] = [];
  const waiters: Array<{ events: Array<SemEvent['event']>; resolve: (e: SemEvent) => void }> = [];
  let buffered = '';
  // Retained purely for diagnostics: a child that dies before emitting anything
  // (bad bundle, unresolvable import) otherwise fails as a bare timeout with no
  // indication of why.
  let stderr = '';
  proc.stderr!.setEncoding('utf8');
  proc.stderr!.on('data', (chunk: string) => {
    stderr += chunk;
  });

  proc.stdout!.setEncoding('utf8');
  proc.stdout!.on('data', (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      const marker = line.indexOf('@@SEM@@ ');
      if (marker === -1) continue;
      let parsed: SemEvent;
      try {
        parsed = JSON.parse(line.slice(marker + '@@SEM@@ '.length)) as SemEvent;
      } catch {
        continue;
      }
      events.push(parsed);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.events.includes(parsed.event)) waiters.splice(i, 1)[0]!.resolve(parsed);
      }
    }
  });

  const exited = new Promise<number | null>((resolve) => {
    proc.on('exit', (code) => {
      live.delete(proc);
      resolve(code);
    });
  });

  function waitForAny(wanted: Array<SemEvent['event']>, timeoutMs = 20000): Promise<SemEvent> {
    const already = events.find((e) => wanted.includes(e.event));
    if (already) return Promise.resolve(already);
    return new Promise<SemEvent>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `[${opts.label}] timed out waiting for "${wanted.join('" or "')}" ` +
                `(saw: ${events.map((e) => e.event).join(', ') || 'nothing'})` +
                (stderr ? `\n--- child stderr ---\n${stderr.slice(0, 2000)}` : ''),
            ),
          ),
        timeoutMs,
      );
      waiters.push({
        events: wanted,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e);
        },
      });
    });
  }

  return {
    proc,
    label: opts.label,
    events,
    exited,
    waitForAny,
    waitFor: (event, timeoutMs) => waitForAny([event], timeoutMs),
  };
}

async function makeSlotDir(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `sem-mp-${name}-`));
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('ResearchRunSemaphore — real multi-process behaviour', () => {
  it('holds the cap under a thundering herd of separate processes', async () => {
    const slotDir = await makeSlotDir('herd');
    const MAX = 2;
    const HERD = 6;

    // Winners hold UNTIL KILLED so that "at most MAX hold at once" is a
    // deterministic invariant rather than a timing hope — the same fix already
    // applied to the "distinct slot assignments" test below.
    //
    // With a finite hold this test asserted the wrong thing: it counted
    // *cumulative* `acquired` events but is named for, and exists to prove, the
    // *concurrent* cap. The six children start staggered (Windows CI especially),
    // so a late contender can boot after an early winner's hold has already
    // elapsed, legitimately win the freed slot, and push the cumulative count to
    // MAX+1 while the cap was never actually exceeded. That is exactly how this
    // failed on Windows CI ("expected length 2 but got 3"). Holding until killed
    // removes the free slot entirely, so `acquired.length` now counts genuinely
    // simultaneous holders — a strictly stronger assertion, and a real cap
    // violation still fails it.
    const children = Array.from({ length: HERD }, (_, i) =>
      spawnChild({ label: `herd-${i}`, slotDir, maxSlots: MAX, maxWaitMs: 0, holdMs: -1 }),
    );

    // Each contender settles as either a winner (`acquired`, then holds forever)
    // or a loser (`capacity`, then exits 3). Wait for that decision from all six
    // before asserting, so no child is still mid-attempt.
    await Promise.all(children.map((c) => c.waitForAny(['acquired', 'capacity', 'error'], 60000)));

    const acquired = children.flatMap((c) => c.events.filter((e) => e.event === 'acquired'));
    const capacity = children.flatMap((c) => c.events.filter((e) => e.event === 'capacity'));
    const errors = children.flatMap((c) => c.events.filter((e) => e.event === 'error'));

    // Rendered into every assertion below so a future failure self-diagnoses
    // instead of reporting a bare length mismatch.
    const timeline = children
      .map(
        (c) =>
          `  ${c.label}: ` +
          (c.events.map((e) => (e.slot === undefined ? e.event : `${e.event}#${e.slot}`)).join(' → ') ||
            '(silent)'),
      )
      .join('\n');

    expect(errors, `children reported errors:\n${timeline}`).toEqual([]);
    expect(acquired, `concurrent holders exceeded the cap:\n${timeline}`).toHaveLength(MAX);
    expect(capacity, `wrong number of refusals:\n${timeline}`).toHaveLength(HERD - MAX);

    // The winners must be on *distinct* slots — the same slot handed to two
    // processes would mean the cap is nominal only.
    expect(new Set(acquired.map((a) => a.slot)).size, `winners shared a slot:\n${timeline}`).toBe(MAX);

    // Losers exit 3 on capacity refusal; the winners are still holding, so kill
    // them and let the slot dir tear down cleanly.
    const losers = children.filter((c) => c.events.some((e) => e.event === 'capacity'));
    expect(await Promise.all(losers.map((c) => c.exited))).toEqual(Array(HERD - MAX).fill(3));
    for (const c of children) c.proc.kill('SIGKILL');
    await Promise.all(children.map((c) => c.exited));

    await rm(slotDir, { recursive: true, force: true }).catch(() => {});
  }, 120000);

  it('hands a released slot to a waiting process', async () => {
    const slotDir = await makeSlotDir('handoff');

    // One slot total. The holder keeps it briefly; the waiter blocks rather than
    // failing fast, and must get the slot only after the holder releases it.
    const holder = spawnChild({ label: 'holder', slotDir, maxSlots: 1, maxWaitMs: 0, holdMs: 1500 });
    await holder.waitFor('acquired');

    const waiter = spawnChild({ label: 'waiter', slotDir, maxSlots: 1, maxWaitMs: 15000, holdMs: 50 });
    await waiter.waitFor('ready');

    const [holderCode, waiterCode] = await Promise.all([holder.exited, waiter.exited]);
    expect(holderCode).toBe(0);
    expect(waiterCode).toBe(0);

    const released = holder.events.find((e) => e.event === 'released')!;
    const acquired = waiter.events.find((e) => e.event === 'acquired')!;
    expect(released).toBeDefined();
    expect(acquired).toBeDefined();
    // Same single slot, and the handoff strictly followed the release.
    expect(acquired.slot).toBe(released.slot);
    expect(acquired.at!).toBeGreaterThanOrEqual(released.at!);

    await rm(slotDir, { recursive: true, force: true });
  }, 120000);

  it('reclaims the slot of a SIGKILLed holder (crash recovery)', async () => {
    const slotDir = await makeSlotDir('crash');

    // Holder takes the only slot and never releases it.
    const holder = spawnChild({ label: 'crash-holder', slotDir, maxSlots: 1, maxWaitMs: 0, holdMs: -1 });
    const held = await holder.waitFor('acquired');

    // Sanity: while the holder is alive, the slot is genuinely unavailable to
    // another process. Without this, a passing reclaim test could just mean the
    // lock was never effective in the first place.
    const blocked = spawnChild({ label: 'blocked', slotDir, maxSlots: 1, maxWaitMs: 0, holdMs: 50 });
    expect(await blocked.exited).toBe(3);
    expect(blocked.events.some((e) => e.event === 'capacity')).toBe(true);

    // Kill -9: no cleanup, no release — the slot file is left behind by a dead PID.
    holder.proc.kill('SIGKILL');
    await holder.exited;

    // The slot file must still be on disk; reclamation is what makes it usable.
    const remaining = await readdir(slotDir);
    expect(remaining.some((f) => f.startsWith('research-run-slot-'))).toBe(true);

    // A fresh process reclaims it immediately via PID+startTime liveness, with
    // zero wait budget — no stale-timeout grace period required.
    const recovered = spawnChild({ label: 'recovered', slotDir, maxSlots: 1, maxWaitMs: 0, holdMs: 50 });
    expect(await recovered.exited).toBe(0);
    const reacquired = recovered.events.find((e) => e.event === 'acquired');
    expect(reacquired).toBeDefined();
    expect(reacquired!.slot).toBe(held.slot);

    await rm(slotDir, { recursive: true, force: true });
  }, 120000);

  it('does not mistake a PID-reuse impostor for a live owner', async () => {
    const slotDir = await makeSlotDir('pidreuse');

    // Forge a slot file owned by PID 1 (always alive) but with a start time that
    // cannot match it. A bare `kill(pid, 0)` check would read this as a live
    // holder and deadlock the cap forever; the PID+startTime check must see
    // through it and reclaim.
    await writeFile(
      path.join(slotDir, 'research-run-slot-0.lock'),
      JSON.stringify({ uuid: 'forged-impostor', pid: 1, startTime: 1 }),
      { mode: 0o600 },
    );

    const child = spawnChild({ label: 'impostor-victim', slotDir, maxSlots: 1, maxWaitMs: 0, holdMs: 50 });
    expect(await child.exited).toBe(0);
    expect(child.events.some((e) => e.event === 'acquired')).toBe(true);

    await rm(slotDir, { recursive: true, force: true });
  }, 120000);

  it('keeps slot assignments distinct while several processes run concurrently', async () => {
    const slotDir = await makeSlotDir('distinct');
    const MAX = 4;

    // Holders hold UNTIL KILLED, so "all four hold simultaneously" is a
    // deterministic invariant, not a timing hope. A finite holdMs races a
    // release on a slow runner: the four children start up staggered (Windows CI
    // is especially slow), so by the time the last one acquires and the overflow
    // process is spawned and checks the slot table, the FIRST holder's hold may
    // have already elapsed — leaving a genuinely-free slot the overflow then
    // wins (the exact flake that failed this test on Windows CI, alternately as
    // `expected +0 to be 3` and `expected 3 to be 4`). Holding until killed is
    // the deterministic limit of the thundering-herd test's stated principle
    // ("winners hold well past the point where every contender has attempted ...
    // rather than racing a release").
    const children = Array.from({ length: MAX }, (_, i) =>
      spawnChild({ label: `slot-${i}`, slotDir, maxSlots: MAX, maxWaitMs: 15000, holdMs: -1 }),
    );
    const acquired = await Promise.all(children.map((c) => c.waitFor('acquired')));

    const slots = acquired.map((a) => a.slot);
    expect(new Set(slots).size).toBe(MAX);
    expect([...slots].sort()).toEqual([0, 1, 2, 3]);

    // A fifth process must be refused while all four are still held.
    const extra = spawnChild({ label: 'overflow', slotDir, maxSlots: MAX, maxWaitMs: 0, holdMs: 50 });
    expect(await extra.exited).toBe(3);

    // The holders were told to hold forever (holdMs:-1); SIGKILL them now and
    // await their exit so the slot dir is torn down cleanly. (Clean hold-then-
    // release is exercised by the "hands a released slot" test; this test's
    // invariant is the distinct assignments + overflow refusal above.)
    for (const c of children) c.proc.kill('SIGKILL');
    expect(await Promise.all(children.map((c) => c.exited))).toEqual([null, null, null, null]);

    await rm(slotDir, { recursive: true, force: true }).catch(() => {});
  }, 120000);
});

describe('ResearchRunSemaphore — production DI wiring across processes', () => {
  /** A sandboxed HOME so the DI graph resolves a state dir inside the test tmpdir. */
  async function makeHome(): Promise<string> {
    return mkdtemp(path.join(tmpdir(), 'sem-mp-home-'));
  }

  function wired(label: string, home: string, opts: { maxSlots: number; holdMs: number }): ChildHandle {
    return spawnChild({
      label,
      // Unused by this harness (it derives its own dir) but required by the
      // spawn helper for log placement; point it at the sandboxed HOME.
      slotDir: home,
      maxSlots: opts.maxSlots,
      holdMs: opts.holdMs,
      bundle: wiredChildBundle,
      extraEnv: {
        HOME: home,
        USERPROFILE: home,
        PI_RESEARCH_MAX_CONCURRENT_RUNS: String(opts.maxSlots),
        // Pinned, not defaulted. This harness deliberately lets the DI factory
        // choose the acquire timeout, which reads this variable from the
        // environment — so an ambient value in a developer shell or CI would
        // silently turn "refused at capacity" into "waited, then succeeded".
        PI_RESEARCH_RUN_ACQUIRE_TIMEOUT_MS: '0',
      },
    });
  }

  it('resolves the same state directory in independent processes', async () => {
    const home = await makeHome();

    // Two processes that share only $HOME must land on the same slot directory.
    // If they did not, each would own a private slot table, every acquire would
    // succeed, and the cap would be inert while still reporting success.
    const a = wired('wired-a', home, { maxSlots: 2, holdMs: 1200 });
    const b = wired('wired-b', home, { maxSlots: 2, holdMs: 1200 });

    const [wa, wb] = await Promise.all([a.waitFor('wired'), b.waitFor('wired')]);
    expect(wa.stateDir).toBeTruthy();
    expect(wa.stateDir).toBe(wb.stateDir);
    // And the directory must be the sandboxed HOME's, proving the test isolated
    // the real wiring rather than silently exercising the developer's ~/.pi.
    expect(wa.stateDir!.startsWith(home)).toBe(true);

    // Both honour the env-configured cap.
    expect(wa.maxSlots).toBe(2);
    expect(wb.maxSlots).toBe(2);

    expect(await Promise.all([a.exited, b.exited])).toEqual([0, 0]);
    await rm(home, { recursive: true, force: true });
  }, 120000);

  it('enforces the cap end-to-end through the service registry', async () => {
    const home = await makeHome();

    // Cap of 1 via PI_RESEARCH_MAX_CONCURRENT_RUNS, resolved by the DI factory —
    // not by a hand-constructed semaphore. The holder keeps the only slot while
    // a second process attempts the same registry path and must be refused.
    const holder = wired('wired-holder', home, { maxSlots: 1, holdMs: 2500 });
    const acquired = await holder.waitFor('acquired');
    expect(acquired.slot).toBe(0);

    const refused = wired('wired-refused', home, { maxSlots: 1, holdMs: 50 });
    expect(await refused.exited).toBe(3);
    const capacity = refused.events.find((e) => e.event === 'capacity');
    expect(capacity).toBeDefined();
    expect(capacity!.slots).toBe(1);
    // The error must name the override knob so the message is actionable.
    expect(capacity!.message).toContain('PI_RESEARCH_MAX_CONCURRENT_RUNS');

    expect(await holder.exited).toBe(0);

    // Once the holder is gone the slot is free again through the same path.
    const after = wired('wired-after', home, { maxSlots: 1, holdMs: 50 });
    expect(await after.exited).toBe(0);
    expect(after.events.some((e) => e.event === 'acquired')).toBe(true);

    await rm(home, { recursive: true, force: true });
  }, 120000);
});
