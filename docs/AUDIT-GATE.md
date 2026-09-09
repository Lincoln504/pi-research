# Audit gate: runbook and reinvestigation directions

This document is the runbook for the production dependency security gate (`scripts/audit-gate.cjs`)
and the allowlist it enforces (`config/tooling/audit-exceptions.json`). When CI fails on the
"Audit Dependencies" step, start here.

## What the gate is

The gate runs `npm audit --omit=dev --json` and fails (exit 1) if any advisory at `moderate`
severity or above affects the production (shipped) dependency tree, unless the advisory is
explicitly allowlisted with a reviewed justification. It runs on every push
(`.github/workflows/ci.yml`, the "Audit Dependencies" step) and in the release workflow
(`.github/workflows/release.yml`). It fails closed: unparseable audit output is a failure, not a
pass. Two exception shapes exist, per-GHSA (`{id, ...}`) and location-scoped
(`{package, locationContains, ...}`, for transitive copies frozen inside an upstream
npm-shrinkwrap.json that no downstream override can reach); see the header of
`scripts/audit-gate.cjs` for the full contract and the unit tests in
`test/unit/scripts/audit-gate.test.ts`.

## When the gate fails: triage, in order

1. Reproduce locally:

   ```bash
   npm audit --omit=dev --json
   node scripts/audit-gate.cjs
   ```

   The gate prints every advisory it found, which ones are allowlisted, and which one is blocking.

2. Try remediation before allowlisting, in this order:
   - **Direct dependency with a fix in range**: bump it in `package.json`, regenerate the
     lockfile with npm 12 (CI's npm is stricter than older local npms), re-run the gate.
   - **Transitive with a patched release available**: add an `overrides` entry in `package.json`
     pinning the vulnerable package to the fixed version, regenerate the lockfile, re-run the
     gate. Overrides work here because this repo is the root of the install.
   - **No fix exists upstream** (`first_patched_version` is null, or the affected range includes
     the newest release ever published): no bump or override can work. Allowlist it.
   - **Fix exists but the copy is frozen inside an upstream shrinkwrap**: use the location-scoped
     exception shape, which fires only when every affected path is unfreeable.

3. Before allowlisting, rule out the downgrade trap (this has actually happened; see the adm-zip
   worked example below): an override to a version BELOW the newly affected range can reintroduce
   an older, sometimes more severe advisory. Check the package's full advisory history on the
   GitHub advisory API before concluding that no version works in either direction:

   ```bash
   curl -s https://api.github.com/advisories?cve_id=CVE-XXXX-YYYYY
   curl -s https://api.github.com/advisories/GHSA-XXXX
   npm view <package> time --json
   ```

4. Write the exception entry. Required fields: `id` (or `package` + `locationContains`), `reason`,
   `clearsWhen`, `reviewed` (date). The reason must state why it is unfixable HERE, with evidence,
   and assess actual exposure in this package. The clearsWhen must name the concrete upstream
   condition that removes the need for the entry. Then verify:

   ```bash
   node scripts/audit-gate.cjs
   npx vitest run test/unit/scripts/audit-gate.test.ts
   ```

## Reinvestigation triggers

Re-examine every exception entry when any of these happens:

- The gate prints a **stale-entry warning** (the entry no longer matches any current advisory):
  the upstream fix landed; remove the entry.
- **Every release**: re-verify each entry against the registry and the advisory API (the gate
  header requires this; entries carry a `reviewed` date for exactly this purpose).
- A **new advisory** is published for a package with an existing exception: re-do the triage for
  the new GHSA; the existing entry does not cover it (per-GHSA shape) or must be re-checked
  against the every-path rule (location shape).
- The **upstream fix PR merges or a release ships**: that is the clearsWhen condition arriving;
  remove the entry (adding a temporary override if a pinning parent lags the fixed version).

## Current exceptions and their reinvestigation checklists

### adm-zip: GHSA-vwc7-r8mq-g2x9 (CVE-2026-76845, moderate, allowlisted 2026-09-09)

Symlink following at the extraction destination (CWE-59) in adm-zip 0.5.9 through 0.6.0. Reaches
the shipped tree as one deduped copy required by `onnxruntime-node` (via
`@huggingface/transformers`) and `camoufox-js`. Re-check on every release:

1. Has a patched adm-zip shipped? `npm view adm-zip time --json` (0.6.0, published 2026-07-10, is
   the newest release; the advisory's `first_patched_version` was null as of 2026-09-09). Watch
   the in-progress upstream fix: cthackers/adm-zip PR #575 ("Update fix issue snyk symlink", open
   since 2026-09-01, rewrites `util/utils.js` with symlink regression tests).
2. Have the parents moved? `npm view onnxruntime-node version dependencies.adm-zip` and
   `npm view camoufox-js version dependencies.adm-zip`. Even the latest onnxruntime-node (1.29.0
   as of 2026-09-09) still requires `^0.6.0`.
3. Do NOT "fix" it by downgrading below 0.5.9: 0.5.8 and everything below 0.6.0 is covered by
   GHSA-xcpc-8h2w-3j85 (CVE-2026-39244, HIGH, patched exactly in 0.6.0). Both parents' declared
   ranges forbid it anyway. The two advisories leave no version of adm-zip that is clean.
4. When a fixed adm-zip ships and the parents resolve to it (directly or via a temporary
   override), delete this entry, re-run the gate and its unit tests, and re-run
   `npm audit --omit=dev` to confirm zero blocking advisories.

## What consumers of the published package see (verified empirically, npm 11.19.0, 2026-09-09)

- `npm install` (project or global) with this package in the tree **succeeds, exit 0**. npm prints
  "1 moderate severity vulnerability" as a warning; nothing blocks or fails.
- `pi install npm:@lincoln504/pi-research` also succeeds: pi spawns `npm install --prefix ...
  --legacy-peer-deps` without `--no-audit`, so the same warning is printed and the exit code stays
  0. bun and pnpm behave the same way (warn, do not fail).
- **`npm audit` in a consumer project exits 1** while the vulnerable tree is present, so a
  consumer CI pipeline that runs `npm audit` (with or without `--audit-level=moderate`) will fail.
  This clears only when upstream ships a fixed adm-zip and it reaches consumers; npm overrides in
  a published dependency are ignored, so there is nothing this repo can pin to fix it downstream.
- **`npm audit fix --force` makes things worse**: npm's own suggestion is to install
  `adm-zip@0.5.8`, which reintroduces the HIGH advisory above (verified: after forcing 0.5.8, the
  same report flips to "1 high severity vulnerability" and suggests returning to 0.6.0). Consumers
  should not force a "fix" for this advisory; the allowlist entry documents why.
- Dependabot will raise alerts on consumer repositories that depend on this package. That is
  expected and matches the advisory's real status; point reporters at this document and at the
  exception entry's `reason` and `clearsWhen`.
- The tarball, registry download, and install scripts are unaffected by the advisory: it is
  metadata-level and enforced by nothing at install time. (onnxruntime-node ships its native
  binaries inside its tarball, so npm 12's install-script policy does not turn this into a
  missing-binary failure either.)
