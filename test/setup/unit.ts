/**
 * Unit Test Setup
 */

// FIRST import, before anything that transitively imports src/logger.ts: the
// logger singleton binds its log path at construction, and static imports are
// hoisted above this module's own statements — see unit-env.ts for the full
// story of how the redirect used to lose that race and pollute the real log.
import './unit-env.ts';
import { afterEach } from 'vitest';
import { metrics } from '../../src/utils/metrics.ts';
import { getLogger } from '../../src/logger.ts';

// Construct the global logger NOW, while unit-env.ts's PI_RESEARCH_LOG_PATH redirect is
// still in the environment. Setting the env var before logger.ts is *evaluated* is not
// enough on its own: the singleton is built lazily on first use and resolves its path at
// CONSTRUCTION, so a test whose beforeEach deletes every PI_RESEARCH_* var (config.test.ts
// does exactly that) would make the first log call of the run bind to the user's real
// /tmp/pi-research.log instead — measured at ~7KB of real WARN/ERROR lines per run, in the
// shared file that production forensics reads. Building it here fixes the path for the
// whole file before any test body can touch the environment.
getLogger();

// Increase EventEmitter max listeners to avoid warnings during tests.
// The pi-research extension registers signal handlers (SIGINT, SIGTERM, SIGHUP)
// which can cause warnings when tests load the extension multiple times.
process.setMaxListeners(20);

// Defensive metric isolation: the exported `metrics` singleton's SESSION registry is a
// process-global that code-under-test emits into. Cross-file determinism currently holds
// only because vitest uses forks + isolate (a fresh module registry per file). Reset the
// session registry after every test so a future isolate:false / shared-pool change can't
// make session-metric assertions non-deterministic. Run registries are per-call (scoped by
// runWithRunRegistry) and are unaffected by this.
afterEach(() => { metrics.clearSession(); });
