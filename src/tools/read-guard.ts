/**
 * Confined file-read operations for researcher sessions.
 *
 * Researchers have `read` and `scrape`. Unrestricted, that pair is an exfiltration
 * path needing no bash: a scraped page can talk the model into reading a secret and
 * fetching an attacker URL that carries it. `read` exists for "local codebase context
 * is explicitly required", so it is confined to the project directory (symlinks
 * resolved) and refuses well-known secret files even inside it.
 */

import { constants } from 'node:fs';
import { access, open, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, relative, isAbsolute, parse, sep } from 'node:path';
import type { ReadOperations } from '@earendil-works/pi-coding-agent';

/** Path segments that are never readable, wherever they sit under the project. */
const DENIED_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.git', '.kube', '.docker', '.azure', '.gcloud', '.terraform']);

/** Basenames (lower-cased) and patterns that carry credentials. */
const DENIED_BASENAME = /^(\.env(\..*)?|\.envrc|\.netrc|_netrc|\.npmrc|\.pypirc|\.git-credentials|\.pgpass|\.my\.cnf|\.htpasswd|\.dockercfg|\.dockerconfigjson|\.vault-token|\.bash_history|\.zsh_history|kubeconfig|terraform\.tfstate(\..*)?|(credentials|secrets?)(\.(json|ya?ml|toml|env|ini|txt|xml))?|id_(rsa|dsa|ecdsa|ed25519)([._-].*)?|.*\.(pem|p12|pfx|jks|keystore|kdbx|asc|gpg|tfvars|key)|.*[-_.](secret|secrets|credentials)\.(json|ya?ml|toml|env)|service-account.*\.json)$/;

/** Env templates are meant to be shared and hold no secrets. */
const ALLOWED_ENV_TEMPLATE = /^\.env\.(example|sample|template|dist)$/;

/**
 * Names the OS resolves to the same file: NTFS alternate data streams (`.env::$DATA`)
 * and trailing dots/spaces, which Windows strips when opening.
 */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/:.*$/, '').replace(/[. ]+$/, '');
}

export class ReadDeniedError extends Error {
  constructor(reason: string) {
    super(`read denied: ${reason}`);
    this.name = 'ReadDeniedError';
  }
}

/** Resolve through symlinks; a path that does not exist yet falls back to its parent. */
async function resolveReal(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p;
    return `${await resolveReal(parent)}${sep}${basename(p)}`;
  }
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Throws {@link ReadDeniedError} unless `absolutePath` is a readable-by-policy file
 * inside `cwd`. Exported for tests.
 */
export async function assertReadAllowed(cwd: string, absolutePath: string): Promise<void> {
  const root = await resolveReal(cwd);
  const home = await resolveReal(homedir());
  // A root that is the filesystem root, the home directory or one of its ancestors
  // makes "inside the project" meaningless.
  if (root === parse(root).root || isWithin(root, home)) {
    throw new ReadDeniedError('the working directory is a home or filesystem root, not a project directory');
  }
  const target = await resolveReal(absolutePath);
  if (!isWithin(root, target)) {
    throw new ReadDeniedError('path is outside the project directory');
  }
  const segments = relative(root, target).split(sep);
  if (segments.some((s) => DENIED_SEGMENTS.has(s.toLowerCase()))) {
    throw new ReadDeniedError('path is inside a credential or VCS-internals directory');
  }
  const name = normalizeName(basename(target));
  if (!ALLOWED_ENV_TEMPLATE.test(name) && DENIED_BASENAME.test(name)) {
    throw new ReadDeniedError('file looks like a credential or secret');
  }
}

export function createGuardedReadOperations(cwd: string): ReadOperations {
  return {
    access: async (p) => {
      await assertReadAllowed(cwd, p);
      await access(p, constants.R_OK);
    },
    readFile: async (p) => {
      // Re-checked at read time: the access() check and the read are separate calls.
      await assertReadAllowed(cwd, p);
      // The policy check above resolves symlinks, then this open() runs a moment
      // later: a local attacker with write access to the project can swap `p`
      // for a symlink in between (TOCTOU). O_NOFOLLOW makes the open itself
      // refuse a final-component symlink (ELOOP), and the stat on the fd
      // rejects anything that is not a regular file. Reading through the fd
      // (not the path) means the bytes come from the file the fd points at,
      // not whatever the path resolves to at read time. The residual gap is an
      // intermediate path component swapped for a directory symlink, which
      // Node's public API cannot close (no openat-walk); it is documented in
      // SECURITY.md.
      const handle = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
          throw new ReadDeniedError('path is not a regular file');
        }
        return await readFile(handle);
      } finally {
        await handle.close();
      }
    },
  };
}
