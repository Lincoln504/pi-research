/**
 * Out-of-process WebGPU viability probe (child process entry point).
 *
 * WHY THIS EXISTS: onnxruntime-node bundles Dawn as its WebGPU execution
 * provider. On a host whose only Vulkan adapter is software/paravirtual
 * (llvmpipe/lavapipe, virtio/venus, SwiftShader, "Microsoft Basic Render
 * Driver", ...), Dawn happily *loads* the pipeline but then SIGSEGVs the moment
 * it dispatches the first compute shader. A SIGSEGV is a process-level signal,
 * not a JavaScript exception — no try/catch, no Promise rejection handler, and
 * none of the embedder's WebGPU->CPU fallback logic can ever observe it. The
 * V8 isolate simply dies.
 *
 * The only reliable way to learn "will WebGPU compute crash on this machine?"
 * is to actually run one tiny embedding in a DISPOSABLE child process and read
 * its exit code. A native crash here kills only this child; the parent reads a
 * non-zero exit / fatal signal and chooses CPU. This converts an uncatchable
 * native crash into an ordinary, catchable signal.
 *
 * Contract — the parent judges viability by the STDOUT SENTINEL, not the exit
 * code. This is deliberate: onnxruntime-node's native teardown can itself abort
 * (SIGABRT, "Attempt to use DefaultLogger but none has been registered") when the
 * process exits with a live ORT session — even after a perfectly successful
 * compute. So:
 *   argv[2] = model id (e.g. onnx-community/granite-embedding-small-english-r2-ONNX)
 *   argv[3] = HuggingFace cache directory (shared with the parent)
 *   prints "PROBE_OK <dims>" to STDOUT (written synchronously) => compute worked
 *   no "PROBE_OK" on stdout (crash during compute, load failure, ...) => not viable
 * A SIGSEGV during the compute dispatch (the software/paravirtual-GPU case) kills
 * the child BEFORE the sentinel is written, so its absence is the signal.
 *
 * This file is plain .mjs (no TypeScript, no bundling). It is shipped verbatim
 * next to the bundled entry points (dist/) and resolves @huggingface/transformers
 * from the installed package's node_modules, exactly like the other entry points.
 */

import process from 'node:process';
import { writeSync } from 'node:fs';

async function main() {
  const model = process.argv[2];
  const cacheDir = process.argv[3];
  if (!model || !cacheDir) {
    process.stderr.write('webgpu-probe: missing model/cacheDir args\n');
    process.exit(2);
  }

  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = cacheDir;
  // Keep the probe quiet — we only care about the exit code, not Dawn chatter.
  try {
    if (env.backends && env.backends.onnx) env.backends.onnx.logLevel = 'error';
  } catch {
    /* best-effort */
  }

  // Load on the WebGPU EP exactly as the real embedder would, then run ONE embed.
  // The crash (if any) happens on this first compute dispatch, after load.
  const pipe = await pipeline('feature-extraction', model, {
    device: 'webgpu',
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
  });

  const out = await pipe('webgpu viability probe', { pooling: 'mean', normalize: true });

  // Touch the result so the compute cannot be optimized away.
  if (out && out.data && out.data.length > 0) {
    // Write the sentinel SYNCHRONOUSLY to fd 1 so it is guaranteed on the pipe
    // before process teardown — which may itself abort the ORT native runtime.
    // The parent keys off this sentinel, so a teardown abort here is harmless.
    writeSync(1, 'PROBE_OK ' + out.data.length + '\n');
    process.exit(0);
  }
  process.stderr.write('webgpu-probe: empty embedding output\n');
  process.exit(3);
}

main().catch((err) => {
  process.stderr.write('webgpu-probe error: ' + (err && err.message ? err.message : String(err)) + '\n');
  process.exit(1);
});
