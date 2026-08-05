/**
 * WebGPU viability resolution for the embedder.
 *
 * Resolves the configured embedding device ('auto' | 'webgpu' | 'cpu') to a
 * concrete backend the embedder can hand to onnxruntime-node WITHOUT risking a
 * native SIGSEGV in the main process:
 *
 *   - 'cpu'    -> 'cpu'    (no probe; always safe)
 *   - 'webgpu' -> 'webgpu' (explicit force/override; advanced — no probe)
 *   - 'auto'   -> run an out-of-process probe (see webgpu-probe.mjs) ONCE, cache
 *                 the verdict per host signature, then return 'webgpu' if WebGPU
 *                 compute actually works here, else 'cpu'.
 *
 * The probe runs in a disposable child process precisely because the failure
 * mode on software/paravirtual GPUs is an uncatchable native crash, not a JS
 * error. See webgpu-probe.mjs for the full rationale.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { logger } from '../logger.ts';
import { getModelCacheDir } from './embedder-utils.ts';
import { isModelCached } from './embedder-init.ts';
import { WEBGPU_PROBE_TIMEOUT_MS } from '../constants.ts';

export type ResolvedDevice = 'webgpu' | 'cpu';

// Bump when the probe semantics change in a way that should invalidate cached
// verdicts (e.g. a different onnxruntime/Dawn version that fixes or breaks a path).
const VERDICT_SCHEMA = 1;

interface Verdict {
  schema: number;
  signature: string;
  viable: boolean;
  ts: number;
}

/**
 * Host signature used as the verdict cache key. A change in platform, arch, Node
 * major, or model invalidates the cached verdict. Driver-only changes are NOT
 * captured (no portable way to read driver version without launching a GPU
 * process); set PI_RESEARCH_WEBGPU_REPROBE=1 to force a fresh probe after a
 * driver/GPU change.
 */
function hostSignature(model: string): string {
  const nodeMajor = process.versions.node.split('.')[0];
  return `${process.platform}-${process.arch}-node${nodeMajor}-${model}`;
}

function verdictFilePath(): string {
  // One level above the model cache dir: ~/.cache/pi-research/webgpu-viability.json
  return path.join(path.dirname(getModelCacheDir()), 'webgpu-viability.json');
}

async function readVerdict(signature: string): Promise<boolean | null> {
  if (process.env['PI_RESEARCH_WEBGPU_REPROBE'] === '1') return null;
  try {
    const raw = await fsp.readFile(verdictFilePath(), 'utf8');
    const v = JSON.parse(raw) as Verdict;
    if (v && v.schema === VERDICT_SCHEMA && v.signature === signature && typeof v.viable === 'boolean') {
      return v.viable;
    }
  } catch {
    /* missing/corrupt -> treat as no verdict */
  }
  return null;
}

async function writeVerdict(signature: string, viable: boolean): Promise<void> {
  try {
    const file = verdictFilePath();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const v: Verdict = { schema: VERDICT_SCHEMA, signature, viable, ts: Date.now() };
    await fsp.writeFile(file, JSON.stringify(v), 'utf8');
  } catch (err) {
    logger.debug('[embedder] Could not persist WebGPU viability verdict:', err);
  }
}

/**
 * Locate the probe child script. In dev it sits next to this module
 * (src/knowledge/webgpu-probe.mjs); in a built install it is copied next to the
 * bundled entry point (dist/webgpu-probe.mjs) — in both cases it is a sibling of
 * the running module file (import.meta.url), because esbuild flattens this module
 * into the dist entry bundle. Returns null if it cannot be found (fail-safe: the
 * caller then chooses CPU rather than risking a crash).
 */
function probeScriptPath(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.join(here, 'webgpu-probe.mjs');
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Run the out-of-process probe. Viability is judged by the STDOUT SENTINEL
 * ("PROBE_OK"), NOT the exit code: onnxruntime-node's native teardown can abort
 * the child (SIGABRT) on exit even after a fully successful compute, so a
 * non-zero exit does not imply failure. The sentinel is written synchronously
 * before exit; a real compute crash (SIGSEGV on a software GPU) kills the child
 * before the sentinel is ever produced. Timeout, spawn failure, or missing
 * script => false (the safe CPU direction). A timeout is treated as a negative
 * (cached CPU) on purpose: GPU behaviour is deterministic per host, so a hang
 * would otherwise recur — and re-stall — on every start; the 30s cap is ~10x a
 * real cached-model WebGPU init, so a false timeout on a capable host is unlikely
 * (and PI_RESEARCH_WEBGPU_REPROBE=1 recovers it). NEVER throws.
 */
function runProbe(model: string, cacheDir: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const script = probeScriptPath();
    if (!script) {
      logger.warn('[embedder] WebGPU probe script not found — defaulting to CPU (safe).');
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (viable: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(viable);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [script, model, cacheDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Inherit env so XDG_CACHE_HOME etc. stay consistent with the parent.
        env: process.env,
      });
    } catch (err) {
      logger.warn('[embedder] WebGPU probe failed to spawn — defaulting to CPU:', err);
      finish(false);
      return;
    }

    const timer = setTimeout(() => {
      logger.warn(`[embedder] WebGPU probe timed out after ${timeoutMs}ms — defaulting to CPU.`);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(false);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    // Buffered and decoded once at 'close': per-chunk String(d) mangles a
    // multi-byte character straddling a pipe-chunk boundary (the PROBE_OK
    // sentinel is ASCII, but the logged stderr detail line is not guaranteed to be).
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on('data', (d) => { stdoutChunks.push(Buffer.from(d)); });
    child.stderr?.on('data', (d) => { stderrChunks.push(Buffer.from(d)); });

    child.on('error', (err) => {
      logger.warn('[embedder] WebGPU probe process error — defaulting to CPU:', err);
      finish(false);
    });

    child.on('close', (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      // Viability is the sentinel, not the exit code (teardown may abort post-success).
      if (stdout.includes('PROBE_OK')) {
        finish(true);
        return;
      }
      const detail = stderr.trim().split('\n').pop() ?? '';
      const how = signal ? `signal ${signal}` : `exit ${code}`;
      logger.info(`[embedder] WebGPU probe produced no success sentinel (${how}) — not viable here, using CPU.${detail ? ' (' + detail + ')' : ''}`);
      finish(false);
    });
  });
}

/**
 * In-process memoization of the running probe, keyed by host signature. Mirrors
 * the embedding-factory `_embeddingInitPromise` singleton idiom: the probe AND its
 * `writeVerdict` persist run inside ONE promise held at module scope. If the caller
 * that started the probe is torn down before it settles (e.g. a health check losing
 * a `Promise.race` timeout, or a store dispose), the module-level reference keeps
 * the promise alive so `writeVerdict` still runs on the continuation — so the
 * expensive probe is paid at most once per process instead of repeating every init.
 * Bypassed under PI_RESEARCH_WEBGPU_REPROBE=1 (same escape hatch as readVerdict).
 */
let _probeInFlight: { signature: string; promise: Promise<boolean> } | null = null;

/**
 * Resolve the configured device to a concrete backend. See module header.
 *
 * @param requested  config EMBEDDING_DEVICE value ('auto' | 'webgpu' | 'cpu')
 * @param model      embedding model id (passed to the probe)
 * @param timeoutMs  caller's upper bound; the probe is additionally capped at
 *                   WEBGPU_PROBE_TIMEOUT_MS (it runs only against an already-cached
 *                   model, so it needs no model-download budget).
 */
export async function resolveEmbeddingDevice(
  requested: string,
  model: string,
  timeoutMs: number,
): Promise<ResolvedDevice> {
  if (requested === 'cpu') return 'cpu';
  if (requested === 'webgpu') return 'webgpu';

  // 'auto' (and any unexpected value) -> probe-gated.
  const signature = hostSignature(model);

  const cached = await readVerdict(signature);
  if (cached !== null) {
    logger.info(`[embedder] WebGPU viability (cached verdict): ${cached ? 'viable -> webgpu' : 'not viable -> cpu'}`);
    return cached ? 'webgpu' : 'cpu';
  }

  // The probe loads the model on the WebGPU EP to test a real compute. If the model
  // is not cached yet, downloading it INSIDE the probe would block init on a
  // first-ever run and can hang for minutes on a GPU-less host. Defer instead: use
  // CPU now WITHOUT caching a verdict, so the model downloads on the ordinary CPU
  // path and the NEXT init (model present) runs a fast, download-free probe for the
  // real verdict. Keeps the probe bounded and never on a model-download critical path.
  if (!(await isModelCached(model))) {
    logger.info('[embedder] Embedding model not cached yet — using CPU for now; WebGPU will be probed once the model is present.');
    return 'cpu';
  }

  const reprobe = process.env['PI_RESEARCH_WEBGPU_REPROBE'] === '1';
  if (reprobe || _probeInFlight?.signature !== signature) {
    // Model is cached here, so the probe only does a WebGPU init + tiny compute:
    // bound it tightly (WEBGPU_PROBE_TIMEOUT_MS) so it fails fast to CPU on a
    // GPU-less/hanging host instead of running out the caller's full budget.
    const probeTimeoutMs = Math.min(WEBGPU_PROBE_TIMEOUT_MS, timeoutMs);
    logger.info('[embedder] Probing WebGPU viability in a disposable child process...');
    const cacheDir = getModelCacheDir();
    // runProbe never throws and writeVerdict swallows its own errors, so this
    // promise never rejects — no poisoned-memo concern. The verdict is written
    // INSIDE the memoized promise so it persists even if the awaiting caller is torn
    // down before the probe settles — the expensive probe is paid at most once.
    _probeInFlight = {
      signature,
      promise: (async () => {
        const v = await runProbe(model, cacheDir, probeTimeoutMs);
        await writeVerdict(signature, v);
        return v;
      })(),
    };
  }

  const viable = await _probeInFlight.promise;
  logger.info(
    viable
      ? '[embedder] WebGPU probe succeeded — using WebGPU.'
      : '[embedder] WebGPU probe failed/crashed — using CPU (safe). This is expected on VMs, containers, CI, and software-Vulkan hosts.',
  );
  return viable ? 'webgpu' : 'cpu';
}
