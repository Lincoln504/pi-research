/**
 * Process liveness — the two portability rules the PID-reuse guard rests on.
 *
 * Every lock, run slot, GPU lease and leader election in this project claims to
 * be PID-reuse-safe by pairing a PID with its start time. That claim is only as
 * good as (a) being able to READ a start time on the host platform, and (b) not
 * mistaking "not permitted to signal" for "dead".
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { parseEtime, ProcessLifecycleService } from '../../../src/infrastructure/process-lifecycle-service.ts';

describe('parseEtime — POSIX ps elapsed-time format', () => {
  // `etimes` (whole seconds) is a procps-ng/FreeBSD extension that Apple's ps does
  // NOT implement; POSIX mandates only `etime`. Asking for an unsupported keyword
  // fails quietly — procps-ng writes to stderr and still exits 0 with EMPTY
  // stdout, BSD ps exits non-zero — so without an `etime` fallback the start-time
  // lookup returned null for every PID on macOS and the guard silently degraded to
  // a bare signal-0 check.
  it.each([
    ['00:00', 0],
    ['00:42', 42],
    ['01:30', 90],
    ['1:02:03', 3723],
    ['02:00:00', 7200],
    ['1-00:00:00', 86400],
    ['12-06:30:15', 12 * 86400 + 6 * 3600 + 30 * 60 + 15],
  ])('parses %s → %i seconds', (input, expected) => {
    expect(parseEtime(input)).toBe(expected);
  });

  it('tolerates the leading whitespace ps pads its columns with', () => {
    expect(parseEtime('     03:21')).toBe(201);
  });

  it.each([['', null], ['not-a-time', null], ['12', null], ['a:b', null]])(
    'returns null rather than a bogus number for %s',
    (input, expected) => {
      expect(parseEtime(input as string)).toBe(expected);
    },
  );

  it('agrees with this platform\'s real ps output', () => {
    // Guards the regex against the actual column format on the host, whichever
    // ps implementation that is.
    const raw = execFileSync('ps', ['-o', 'etime=', '-p', String(process.pid)], { encoding: 'utf8' });
    const parsed = parseEtime(raw.trim());
    expect(parsed).not.toBeNull();
    expect(parsed).toBeGreaterThanOrEqual(0);
  });
});

describe('isProcessAlive — permission errors are not death', () => {
  const svc = new ProcessLifecycleService();

  it('reports a live process as alive', async () => {
    await expect(svc.isProcessAlive(process.pid)).resolves.toBe(true);
  });

  it('reports a PID that cannot exist as dead', async () => {
    // 2^22 + 1 is above the default pid_max on Linux and not a valid live pid here.
    await expect(svc.isProcessAlive(4194305)).resolves.toBe(false);
  });

  // PID 1 is init/launchd: it always exists, and signalling it as an unprivileged
  // user raises EPERM. Treating that as "dead" would let a caller reclaim a lock,
  // run slot or leader from a live owner on any shared host — the same class of
  // mistake the orphan guard explicitly avoids.
  it('treats an EPERM process (PID 1, unprivileged) as ALIVE, not dead', async () => {
    let permissionDenied = false;
    try {
      process.kill(1, 0);
    } catch (err) {
      permissionDenied = (err as NodeJS.ErrnoException).code === 'EPERM';
    }
    // Only meaningful when we genuinely lack permission (i.e. not running as root).
    if (!permissionDenied) return;

    await expect(svc.isProcessAlive(1)).resolves.toBe(true);
    expect(svc.isProcessAliveSync(1)).toBe(true);
  });

  it('start-time verification actually engages on this platform', async () => {
    // If getProcessStartTime returned null everywhere (the macOS failure this
    // fixes), a WRONG expected start time would still report alive via the
    // re-confirm path — so the guard would be inert without anyone noticing.
    const real = await svc.getProcessStartTime(process.pid);
    expect(real).not.toBeNull();
    await expect(svc.isProcessAlive(process.pid, real)).resolves.toBe(true);
    await expect(svc.isProcessAlive(process.pid, real! + 100_000)).resolves.toBe(false);
  });
});
