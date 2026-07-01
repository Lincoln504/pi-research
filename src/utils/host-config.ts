/**
 * Host pi configuration access — resolved LAZILY.
 *
 * `@earendil-works/pi-coding-agent` is provided by the host pi process and is
 * NOT reliably present in this extension's own module-resolution scope when pi
 * runs the extension (though declared as a regular dependency, it resolves
 * against the host, not the extension's own `node_modules`). A
 * top-level `import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent'`
 * is hoisted and executed on module load, so any *standalone* bundle that
 * transitively imports such a module — most importantly the poolifier-spawned
 * `thread-worker.mjs`, which resolves modules relative to its own file and
 * cannot see pi's global install — crashes with ERR_MODULE_NOT_FOUND before a
 * single line of its own code runs.
 *
 * Resolving the value through this helper instead keeps the host package out of
 * every module's load-time graph: the `require()` happens on first call, inside
 * a try/catch, and degrades to pi's own stable default where the host package
 * is not resolvable (i.e. inside the worker thread).
 */
import { createRequire } from 'node:module';

let _configDirName: string | undefined;

/**
 * The host pi config directory name (e.g. `.pi`).
 *
 * Resolution order: explicit env override (`PI_RESEARCH_CONFIG_DIR_NAME`) →
 * the host `@earendil-works/pi-coding-agent` package (only where it is actually
 * resolvable, i.e. the main pi process) → the stable default `.pi`.
 */
export function getConfigDirName(): string {
  if (_configDirName !== undefined) return _configDirName;
  const override = process.env['PI_RESEARCH_CONFIG_DIR_NAME'];
  if (override) return (_configDirName = override);
  try {
    const require = createRequire(import.meta.url);
    const host = require('@earendil-works/pi-coding-agent') as { CONFIG_DIR_NAME?: string };
    _configDirName = host.CONFIG_DIR_NAME || '.pi';
  } catch {
    // Host package not resolvable in this context (e.g. the browser worker
    // thread) — fall back to pi's own stable default.
    _configDirName = '.pi';
  }
  return _configDirName;
}
