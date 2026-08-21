#!/usr/bin/env node
'use strict';
/**
 * Production-dependency security gate with documented exceptions.
 *
 * Runs `npm audit --omit=dev --json` and FAILS (exit 1) if any advisory at
 * `moderate` severity or above affects the shipped dependency tree, UNLESS it is
 * explicitly allowlisted in config/tooling/audit-exceptions.json with a reviewed
 * justification. Two allowlist shapes:
 *   - per-GHSA { id, ... }   — allowlists ONE advisory by GHSA id.
 *   - location-scoped { package, locationContains, ... } — allowlists ANY
 *     advisory for `package` whose EVERY affected install path (npm audit
 *     `nodes`) contains `locationContains`. For a transitive pinned inside an
 *     upstream npm-shrinkwrap.json (unfixable downstream) so each new disclosure
 *     for that frozen copy need not be re-listed. The "every node in scope" rule
 *     makes this precise: it only fires when NO remediable copy is affected, so
 *     it can never mask a vulnerability this repo could actually fix.
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
 *
 * The pure matching logic is exported as `classifyAdvisories` so it can be unit
 * tested without shelling out to `npm audit`.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const THRESHOLD = SEVERITY_RANK.moderate;

/**
 * Validate an exceptions array (both shapes). Throws on a malformed entry.
 * Exported so the test can exercise validation without shelling out.
 */
function validateExceptions(exceptions) {
  if (!Array.isArray(exceptions)) throw new Error('missing "exceptions" array');
  for (const e of exceptions) {
    const isPerId = typeof e.id === 'string';
    const isLocation = typeof e.package === 'string' && typeof e.locationContains === 'string';
    if (!isPerId && !isLocation) {
      throw new Error(`exception must be per-GHSA ({id}) or location-scoped ({package, locationContains}); got: ${JSON.stringify(e).slice(0, 120)}`);
    }
    if (!e.reason || !e.clearsWhen || !e.reviewed) {
      throw new Error(`exception "${e.id ?? e.package}" must have reason, clearsWhen, reviewed`);
    }
  }
}

/**
 * Collect moderate+ root advisories (objects in `via`) from an `npm audit --json`
 * report, keyed by GHSA id. String `via` entries are chain propagation (a
 * package "vulnerable" only because it depends on a vulnerable package) and
 * carry no advisory of their own, so exempting the root GHSA covers its chain.
 * Per advisory we track the affected `packages` AND the install paths (`nodes`)
 * so a location-scoped exception can decide whether EVERY copy is blocked.
 */
function collectAdvisories(auditJson) {
  const advisories = new Map(); // ghsaId -> {severity, title, packages:Set, nodes:Set}
  for (const [pkgName, vuln] of Object.entries(auditJson.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== 'object' || via === null) continue;
      const id = String(via.url ?? '').split('/').pop() || `unknown:${via.title}`;
      const sev = String(via.severity ?? 'unknown');
      if ((SEVERITY_RANK[sev] ?? SEVERITY_RANK.critical) < THRESHOLD) continue;
      const entry = advisories.get(id) ?? { severity: sev, title: via.title ?? '', packages: new Set(), nodes: new Set() };
      entry.packages.add(via.name ?? pkgName);
      for (const node of vuln.nodes ?? []) entry.nodes.add(node);
      advisories.set(id, entry);
    }
  }
  return advisories;
}

/**
 * A location-scoped exception matches an advisory iff `package` is affected AND
 * EVERY install path (node) contains `locationContains` — i.e. no remediable
 * copy is affected, so the advisory is unfixable here. An advisory with no path
 * info (nodes empty) never matches: we cannot prove it is scope-only, so we fail
 * safe (block) rather than risk masking a remediable vulnerability.
 */
function locationMatch(adv, locationExceptions) {
  if (adv.nodes.size === 0) return undefined;
  return locationExceptions.find(
    (le) => adv.packages.has(le.package) && [...adv.nodes].every((n) => n.includes(le.locationContains)),
  );
}

/**
 * PURE classification: given an `npm audit --json` report and a VALIDATED
 * exceptions array, return { excepted, blocking, stale } where each entry is
 * { id, severity, title, packages:[], nodes:[], reason? }. No I/O, no process
 * exit — fully deterministic and unit-testable.
 */
function classifyAdvisories(auditJson, exceptions) {
  validateExceptions(exceptions);
  const advisories = collectAdvisories(auditJson);
  const idExceptions = new Map(exceptions.filter((e) => typeof e.id === 'string').map((e) => [e.id, e]));
  const locationExceptions = exceptions.filter((e) => typeof e.package === 'string' && typeof e.locationContains === 'string');

  const blocking = [];
  const excepted = [];
  for (const [id, adv] of advisories) {
    const idEx = idExceptions.get(id);
    if (idEx) {
      excepted.push({ id, ...adv, reason: idEx.reason });
    } else {
      const locEx = locationMatch(adv, locationExceptions);
      if (locEx) {
        excepted.push({ id, ...adv, reason: `[location-scoped: ${locEx.package} @ ${locEx.locationContains}] ${locEx.reason}` });
      } else {
        blocking.push({ id, ...adv });
      }
    }
  }

  // Stale detection: warn (non-blocking) on exceptions that no longer match, so
  // an upstream fix landing never silently leaves a stale allowlist entry.
  const stale = [];
  for (const e of exceptions) {
    if (typeof e.id === 'string') {
      if (!advisories.has(e.id)) stale.push(e.package ? `${e.id} (${e.package})` : e.id);
    } else {
      const matched = Array.from(advisories.values()).some(
        (adv) => adv.packages.has(e.package) && adv.nodes.size > 0 && [...adv.nodes].every((n) => n.includes(e.locationContains)),
      );
      if (!matched) stale.push(`location-scoped ${e.package} @ ${e.locationContains}`);
    }
  }

  const freeze = (arr) => arr.map((a) => ({ ...a, packages: [...a.packages], nodes: [...a.nodes] }));
  return { excepted: freeze(excepted), blocking: freeze(blocking), stale };
}

module.exports = { validateExceptions, collectAdvisories, locationMatch, classifyAdvisories, SEVERITY_RANK, THRESHOLD };

// --- CLI entry point (only when run directly, not when imported by a test) ---
if (require.main === module) {
  const exceptionsPath = path.join(__dirname, '..', 'config', 'tooling', 'audit-exceptions.json');

  function fail(msg) {
    console.error(`AUDIT GATE: ${msg}`);
    process.exit(1);
  }

  let exceptions;
  try {
    exceptions = JSON.parse(fs.readFileSync(exceptionsPath, 'utf8')).exceptions;
    validateExceptions(exceptions);
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

  const { excepted, blocking, stale } = classifyAdvisories(audit, exceptions);

  console.log('Production dependency audit gate (threshold: moderate, prod tree only)');
  console.log(`  advisories found: ${excepted.length + blocking.length}, allowlisted: ${excepted.length}, blocking: ${blocking.length}`);
  for (const a of excepted) {
    console.log(`  ALLOWED  ${a.id} [${a.severity}] ${a.packages.join(', ')} — ${a.title}`);
    const reason = a.reason;
    console.log(`           reason: ${reason.length > 160 ? reason.slice(0, 157) + '...' : reason}`);
  }
  for (const s of stale) {
    console.log(`  WARNING  stale exception ${s} no longer matches any advisory — remove it from audit-exceptions.json`);
  }
  if (blocking.length > 0) {
    for (const a of blocking) {
      console.error(`  BLOCKED  ${a.id} [${a.severity}] ${a.packages.join(', ')} — ${a.title}`);
    }
    fail(`${blocking.length} non-allowlisted advisori(es) at moderate+ in the production tree. Remediate (bump/override) or, ONLY if confirmed upstream-blocked, add a reviewed exception with justification.`);
  }
  console.log('OK: no non-allowlisted production advisories at moderate or above.');
}
