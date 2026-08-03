/**
 * Child entry point that acquires a run slot through the **real DI wiring**.
 *
 * The sibling harness (`run-semaphore-child.ts`) constructs a ResearchRunSemaphore
 * directly, which proves the semaphore's own cross-process semantics but says
 * nothing about how production obtains one. Production resolves it from the
 * service registry, and that path decides the slot directory via
 * `StatePathConfiguration.getStateDir()` → `getGlobalConfigDir()` → `$HOME`.
 *
 * That resolution is the quiet single point of failure for the whole run-cap: if
 * two processes ever computed different state directories, they would contend on
 * *different* slot files, every acquire would succeed, and the cap would be
 * silently inert while still logging "acquired slot 0" in both. So this child
 * reports the resolved directory alongside the acquisition, letting the test
 * assert that independent processes agree on it.
 *
 * Configuration matches the sibling harness (`SEM_*` env vars); the slot
 * directory is *not* passed in — deriving it is the point.
 */

import { getServiceContainer } from '../../../src/core/service-registry.ts';
import { getService } from '../../../src/core/service-registry.ts';
import { ServiceNames } from '../../../src/core/interfaces/service-names.ts';
import { registerInfrastructureServices } from '../../../src/infrastructure/service-initialization.ts';
import { StatePathConfiguration } from '../../../src/infrastructure/state/state-path-configuration.ts';
import {
  ResearchRunSemaphore,
  ResearchRunCapacityError,
} from '../../../src/infrastructure/research-run-semaphore.ts';

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
  const label = process.env['SEM_LABEL'] ?? 'wired';
  const holdMs = envInt('SEM_HOLD_MS', 100);

  const container = getServiceContainer();
  registerInfrastructureServices(container);

  const pathConfig = await getService<StatePathConfiguration>(
    ServiceNames.STATE_PATH_CONFIGURATION,
    undefined,
    container,
  );
  const semaphore = await getService<ResearchRunSemaphore>(
    ServiceNames.RESEARCH_RUN_SEMAPHORE,
    undefined,
    container,
  );

  emit({
    event: 'wired',
    label,
    pid: process.pid,
    stateDir: pathConfig.getStateDir(),
    maxSlots: semaphore.getMaxSlots(),
  });

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
    setInterval(() => {}, 1 << 30);
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
