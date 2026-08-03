/**
 * Child entry point for the multi-process ResearchRunSemaphore tests.
 *
 * The semaphore's whole contract is *cross-process* (N slot files coordinated
 * through FileLockService, with PID+startTime liveness reclaiming dead owners).
 * In-process unit tests cannot observe that contract: they share one heap, one
 * FileLockService module instance, and one PID, so "another process holds the
 * slot" and "a holder was SIGKILLed" are unrepresentable. This entry is bundled
 * by the test and spawned as genuinely separate OS processes so the real
 * behaviour is exercised end to end.
 *
 * Protocol: every observable event is written to stdout as a single line
 * `@@SEM@@ {json}`. The parent parses only those lines, so incidental logger
 * output on either stream is harmless.
 *
 * Configuration is by environment variable (see `SEM_*` below) rather than argv
 * so the bundled file stays a plain entry point with no argument parsing.
 */

import { ProcessLifecycleService } from '../../../src/infrastructure/process-lifecycle-service.ts';
import {
  ResearchRunSemaphore,
  ResearchRunCapacityError,
} from '../../../src/infrastructure/research-run-semaphore.ts';

// Surface the cause of ANY process crash as a protocol `error` event + stderr.
// Without this a holder that dies mid-hold does so SILENTLY: console logging is
// off (PI_RESEARCH_CONSOLE_LOG=false) and the file-logger buffer may not flush
// before the abrupt exit, so the parent sees only an unexpected exit code with
// no indication of why. These handlers write synchronously to both channels.
process.on('unhandledRejection', (reason) => {
  emitCrash('unhandledRejection', reason);
});
process.on('uncaughtException', (err) => {
  emitCrash('uncaughtException', err);
});

/** Synchronous crash report (protocol line + stderr) then exit(1). */
function emitCrash(kind: string, reason: unknown): void {
  const detail = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason);
  process.stdout.write(`@@SEM@@ ${JSON.stringify({ event: 'error', message: `${kind}: ${detail}` })}\n`);
  process.stderr.write(`CRASH(${kind}): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`);
  process.exit(1);
}

/** Emit one protocol line. Kept synchronous so it survives an immediate exit. */
function emit(event: Record<string, unknown>): void {
  process.stdout.write(`@@SEM@@ ${JSON.stringify(event)}\n`);
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

async function main(): Promise<void> {
  const slotDir = process.env['SEM_SLOT_DIR'];
  if (!slotDir) {
    emit({ event: 'error', message: 'SEM_SLOT_DIR is required' });
    process.exit(2);
  }
  const label = process.env['SEM_LABEL'] ?? 'child';
  const maxSlots = envInt('SEM_MAX_SLOTS', 2);
  const maxWaitMs = envInt('SEM_MAX_WAIT_MS', 0);
  /** Milliseconds to hold the slot before releasing. Negative = hold until killed. */
  const holdMs = envInt('SEM_HOLD_MS', 100);
  /** Optional delay before even attempting, to order contenders deterministically. */
  const startDelayMs = envInt('SEM_START_DELAY_MS', 0);

  const lifecycle = new ProcessLifecycleService();
  await lifecycle.initialize();

  const semaphore = new ResearchRunSemaphore(slotDir, lifecycle, maxSlots, maxWaitMs);
  await semaphore.initialize();

  if (startDelayMs > 0) await new Promise((r) => setTimeout(r, startDelayMs));

  emit({ event: 'ready', label, pid: process.pid });

  let acquisition;
  try {
    acquisition = await semaphore.acquire();
  } catch (err) {
    if (err instanceof ResearchRunCapacityError) {
      emit({ event: 'capacity', label, pid: process.pid, slots: err.slots, message: err.message });
      process.exit(3);
    }
    emit({ event: 'error', label, pid: process.pid, message: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }

  emit({ event: 'acquired', label, pid: process.pid, slot: acquisition.slotIndex, at: Date.now() });

  if (holdMs < 0) {
    // Hold forever: the parent will SIGKILL us to exercise dead-owner reclaim.
    // The interval's closure pins `acquisition` so V8 cannot garbage-collect it
    // (and the open slot FileHandle it transitively holds) while we wait. An open
    // FileHandle closed by the GC is a *fatal* error in modern Node ("A FileHandle
    // object was closed during garbage collection") — it would crash this holder
    // and leave its slot to be reclaimed as if the process had died, breaking the
    // cap under 4 concurrent holders. (Production never hits this: runResearch
    // keeps the acquisition referenced in its try/finally for the whole run.)
    const hold = acquisition;
    setInterval(() => { void hold; }, 1 << 30);
    return;
  }

  await new Promise((r) => setTimeout(r, holdMs));
  await acquisition.release();
  emit({ event: 'released', label, pid: process.pid, slot: acquisition.slotIndex, at: Date.now() });
  process.exit(0);
}

void main().catch((err) => {
  emit({ event: 'error', message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
