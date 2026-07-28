#!/usr/bin/env node
'use strict';
/**
 * Production-dependency security gate with documented exceptions.
 *
 * Runs `npm audit --omit=dev --json` and FAILS (exit 1) if any advisory at
 * `moderate` severity or above affects the shipped dependency tree, UNLESS the
 * advisory's GHSA id is explicitly allowlisted in
 * config/tooling/audit-exceptions.json with a reviewed justification.
 *
 * Why not plain `npm audit --omit=dev --audit-level=moderate`: the pi host
 * framework (@earendil-works/pi-coding-agent) ships an npm-shrinkwrap.json that
 * freezes its nested transitive tree, and other prod deps pin transitive
 * versions this repo cannot override. Advisories inside those frozen subtrees
 * are upstream-only — they cannot be remediated here and must not permanently
 * block releases — but every OTHER advisory still must. A raw threshold cannot
 * express that; an explicit, reviewed allowlist can. (This was always the
 * gate's documented intent — see the "Audit Dependencies" step in ci.yml.)
 *
 * Guarantees:
 *  - New advisories (not allowlisted) at moderate+ fail the gate. Fails closed:
 *    unparseable audit output is a gate failure, not a pass.
 *  - Stale exceptions (no longer matching any current advisory) WARN so they
 *    get removed promptly, but do not fail the gate (an upstream fix landing
 *    must never block a release).
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const THRESHOLD = SEVERITY_RANK.moderate;

const exceptionsPath = path.join(__dirname, '..', 'config', 'tooling', 'audit-exceptions.json');

function fail(msg) {
  console.error(`AUDIT GATE: ${msg}`);
  process.exit(1);
}

let exceptions;
try {
  const parsed = JSON.parse(fs.readFileSync(exceptionsPath, 'utf8'));
  if (!Array.isArray(parsed.exceptions)) throw new Error('missing "exceptions" array');
  for (const e of parsed.exceptions) {
    if (!e.id || !e.reason || !e.clearsWhen || !e.reviewed) {
      throw new Error(`exception "${e.id ?? '?'}" must have id, reason, clearsWhen, reviewed`);
    }
  }
  exceptions = parsed.exceptions;
} catch (err) {
  fail(`cannot load ${exceptionsPath}: ${err.message}`);
}

// npm audit exits non-zero when vulnerabilities exist — that is expected; the
// JSON on stdout is still the report. Only unparseable output is fatal.
const res = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
  maxBuffer: 64 * 1024 * 1024,
});
let audit;
try {
  audit = JSON.parse(res.stdout);
} catch {
  fail(`npm audit produced unparseable output (status ${res.status}). stderr: ${String(res.stderr).slice(0, 2000)}`);
}
if (audit.error) fail(`npm audit errored: ${JSON.stringify(audit.error).slice(0, 2000)}`);

// Collect root advisories (objects in `via`). String entries in `via` are
// chain propagation (package X is "vulnerable" only because it depends on a
// vulnerable package) — they carry no advisory of their own, so exempting the
// root GHSA covers its whole chain.
const advisories = new Map(); // ghsaId -> {severity, title, packages:Set}
for (const [pkgName, vuln] of Object.entries(audit.vulnerabilities ?? {})) {
  for (const via of vuln.via ?? []) {
    if (typeof via !== 'object' || via === null) continue;
    const id = String(via.url ?? '').split('/').pop() || `unknown:${via.title}`;
    const sev = String(via.severity ?? 'unknown');
    if ((SEVERITY_RANK[sev] ?? SEVERITY_RANK.critical) < THRESHOLD) continue;
    const entry = advisories.get(id) ?? { severity: sev, title: via.title ?? '', packages: new Set() };
    entry.packages.add(via.name ?? pkgName);
    advisories.set(id, entry);
  }
}

const allowed = new Map(exceptions.map((e) => [e.id, e]));
const blocking = [];
const excepted = [];
for (const [id, adv] of advisories) {
  (allowed.has(id) ? excepted : blocking).push({ id, ...adv });
}
const stale = exceptions.filter((e) => !advisories.has(e.id));

console.log('Production dependency audit gate (threshold: moderate, prod tree only)');
console.log(`  advisories found: ${advisories.size}, allowlisted: ${excepted.length}, blocking: ${blocking.length}`);
for (const a of excepted) {
  console.log(`  ALLOWED  ${a.id} [${a.severity}] ${[...a.packages].join(', ')} — ${a.title}`);
  const reason = allowed.get(a.id).reason;
  console.log(`           reason: ${reason.length > 160 ? reason.slice(0, 157) + '...' : reason}`);
}
for (const e of stale) {
  console.log(`  WARNING  stale exception ${e.id} (${e.package}) no longer matches any advisory — remove it from audit-exceptions.json`);
}
if (blocking.length > 0) {
  for (const a of blocking) {
    console.error(`  BLOCKED  ${a.id} [${a.severity}] ${[...a.packages].join(', ')} — ${a.title}`);
  }
  fail(`${blocking.length} non-allowlisted advisori(es) at moderate+ in the production tree. Remediate (bump/override) or, ONLY if confirmed upstream-blocked, add a reviewed exception with justification.`);
}
console.log('OK: no non-allowlisted production advisories at moderate or above.');
