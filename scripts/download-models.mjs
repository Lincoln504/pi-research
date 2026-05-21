#!/usr/bin/env node
/**
 * Developer utility: pre-download all pi-research embedding models to the
 * persistent cache directory (~/.cache/pi-research/models/ or $XDG_CACHE_HOME/pi-research/models/).
 *
 * Usage:
 *   node scripts/download-models.mjs           # skip already-cached models
 *   node scripts/download-models.mjs --force   # re-download all
 *
 * This script does NOT affect end-user behavior. Users still choose and download
 * a model via the config TUI on first use. This script is for developers who want
 * all models pre-cached for integration testing or offline development.
 */
import { pipeline, env } from '@huggingface/transformers';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Must match getModelCacheDir() in src/knowledge/embedder.ts
const xdgCache = process.env['XDG_CACHE_HOME'];
const base = xdgCache ?? path.join(os.homedir(), '.cache');
const MODEL_CACHE_DIR = path.join(base, 'pi-research', 'models');

env.cacheDir = MODEL_CACHE_DIR;

const FORCE = process.argv.includes('--force');

const MODELS = [
  // English-only — small/fast
  { id: 'Xenova/all-MiniLM-L6-v2',                              approxMb: 23  },
  { id: 'Xenova/bge-small-en-v1.5',                             approxMb: 130 },
  { id: 'Xenova/all-mpnet-base-v2',                             approxMb: 420 },
  // Multilingual
  { id: 'Xenova/multilingual-e5-small',                         approxMb: 120 },
  { id: 'Xenova/multilingual-e5-base',                          approxMb: 280 },
  { id: 'Xenova/bge-m3',                                        approxMb: 570 },
  { id: 'onnx-community/embeddinggemma-300m-ONNX',              approxMb: 300 },
  { id: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',            approxMb: 620 },
  { id: 'onnx-community/granite-embedding-small-english-r2-ONNX', approxMb: 190 },
];

function isModelCached(modelId) {
  const onnxDir = path.join(MODEL_CACHE_DIR, ...modelId.split('/'), 'onnx');
  try {
    return fs.readdirSync(onnxDir).some(f => f.endsWith('.onnx'));
  } catch {
    return false;
  }
}

console.log(`Model cache directory: ${MODEL_CACHE_DIR}`);
console.log(`Mode: ${FORCE ? 'force re-download all' : 'skip already-cached'}\n`);

let downloaded = 0;
let skipped = 0;
let failed = 0;

for (const { id, approxMb } of MODELS) {
  const cached = isModelCached(id);
  if (cached && !FORCE) {
    console.log(`  [skip] ${id}  (already cached)`);
    skipped++;
    continue;
  }

  process.stdout.write(`  [dl]   ${id}  (~${approxMb} MB) ... `);
  const start = Date.now();
  try {
    const pipe = await pipeline('feature-extraction', id, { device: 'cpu' });
    await pipe.dispose();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`done in ${elapsed}s`);
    downloaded++;
  } catch (err) {
    console.log(`FAILED`);
    console.error(`         ${err.message}`);
    failed++;
  }
}

console.log(`\nDone. Downloaded: ${downloaded}, Skipped: ${skipped}, Failed: ${failed}`);
if (failed > 0) {
  console.error(`\n${failed} model(s) failed to download. Check network and try again.`);
  process.exit(1);
}
