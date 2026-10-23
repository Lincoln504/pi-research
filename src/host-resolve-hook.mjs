/**
 * ESM resolve hook (registered by the bin shim via module.register) that falls back to the
 * host's own copies of the peer dependencies — see host-roots.mjs for why the engine needs
 * it. It only ever acts AFTER normal resolution failed, and only for the host packages, so
 * an install that has them beside the engine is never affected.
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOST = new Set(['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']);
let dirs = [];

function packageName(specifier) {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
}

export async function initialize(data) {
  dirs = Array.isArray(data?.dirs) ? data.dirs : [];
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !HOST.has(packageName(specifier))) throw err;
    for (const nm of dirs) {
      try {
        // A parent that lives IN the node_modules directory makes Node's lookup start there.
        return await nextResolve(specifier, { ...context, parentURL: pathToFileURL(join(nm, '__host__.mjs')).href });
      } catch {
        /* try the next location */
      }
    }
    throw err;
  }
}
