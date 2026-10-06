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

None. The audit gate runs with an empty allowlist: `npm audit --omit=dev` reports zero
vulnerabilities in this repository's tree as of 2026-10-01. Scope, stated plainly because the
section at the bottom of this file depends on it: the gate audits the tree rooted HERE, where the
`overrides` in `package.json` apply. It says nothing about the tree a consumer resolves. When
triaging a consumer-reported advisory, do not treat a green gate as evidence that consumers are
clean — measure their shape directly: pack, install into a scratch project, `npm audit --omit=dev`.

The shipped tree got smaller on 2026-09-30: the three `@earendil-works/pi-*` host packages moved
from `dependencies` to `peerDependencies` (plus `devDependencies` for this repo's own build), and
the unused `@earendil-works/pi-server` was dropped. `@earendil-works/pi-coding-agent` alone carried
an `npm-shrinkwrap.json` with a frozen transitive tree, which is what produced the only
location-scoped exception this file ever needed (`brace-expansion` ≤ 5.0.11 inside it, removed in
the same change because the copy left the production tree). Anything shipped by that host package
is no longer part of what consumers install, so it can no longer block the gate — upstream-only
advisories now live in the dev tree and the informational full-tree summary only.

### Cleared: adm-zip GHSA-vwc7-r8mq-g2x9 (CVE-2026-76845) — fixed upstream, entry removed 2026-09-16

The worked example below is retained because it documents the triage method, but the exception
itself is GONE: adm-zip **0.6.1** (published 2026-09-11, tag `cb2cf9b`) contains the upstream fix
(cthackers/adm-zip PR #575, commit `eaa35fa` "Blocked extraction from writing through symlinks
inside the target", plus hardening: setuid/setgid/sticky bits stripped from extracted permissions,
addLocalFolder no longer follows symlinks out of the archived folder). The GitHub advisory page
currently still reads "patched versions: None" (last reviewed 2026-09-08, three days before the
release), but the affected range `>=0.5.9 <=0.6.0` excludes 0.6.1, so `npm audit` is clean. Both
pinning parents (`onnxruntime-node` and the browser launcher — `camoufox-js` requiring `^0.6.0`
at the time, `@camoufox/camoufox` requiring `^0.6.1` since the 2026-10-05 launcher replacement)
resolve 0.6.1 without any override; the `adm-zip` override in `package.json` was moved to `^0.6.1` to pin the
floor explicitly. Consumers clear the advisory as soon as their lockfiles re-resolve adm-zip
(a fresh `npm install` suffices — no override needed on their side, and any consumer-side
allowlist or suppression for this GHSA can be removed).

Correction (2026-10-01): "each requiring `^0.6.0`" was true of `camoufox-js` and of the
`onnxruntime-node` this repository resolved, but NOT of the `onnxruntime-node` a consumer got.
`transformers` 4.2.0 pinned `onnxruntime-node` 1.24.3, which requires `adm-zip ^0.5.16`, and the
repository-wide override is what hid that here. It took the `transformers` 4.3.0 bump
(`onnxruntime-node` 1.30.0, `adm-zip ^0.6.0`) to make the parents' ranges true for consumers too.

### adm-zip: GHSA-vwc7-r8mq-g2x9 (CVE-2026-76845, moderate, allowlisted 2026-09-09 — CLEARED, see above)

Symlink following at the extraction destination (CWE-59) in adm-zip 0.5.9 through 0.6.0. Reaches
the shipped tree as one deduped copy required by `onnxruntime-node` (via
`@huggingface/transformers`) and `@camoufox/camoufox` (the browser launcher; `camoufox-js`
before the 2026-10-05 replacement). Re-check on every release:

1. Has a patched adm-zip shipped? `npm view adm-zip time --json` (0.6.0, published 2026-07-10, is
   the newest release; the advisory's `first_patched_version` was null as of 2026-09-09). Watch
   the in-progress upstream fix: cthackers/adm-zip PR #575 ("Update fix issue snyk symlink", open
   since 2026-09-01, rewrites `util/utils.js` with symlink regression tests).
2. Have the parents moved? `npm view onnxruntime-node version dependencies.adm-zip` and
   `npm view @camoufox/camoufox version dependencies.adm-zip`. Even the latest onnxruntime-node (1.29.0
   as of 2026-09-09) still requires `^0.6.0`.
3. Do NOT "fix" it by downgrading below 0.5.9: 0.5.8 and everything below 0.6.0 is covered by
   GHSA-xcpc-8h2w-3j85 (CVE-2026-39244, HIGH, patched exactly in 0.6.0). Both parents' declared
   ranges forbid it anyway. The two advisories leave no version of adm-zip that is clean.
4. When a fixed adm-zip ships and the parents resolve to it (directly or via a temporary
   override), delete this entry, re-run the gate and its unit tests, and re-run
   `npm audit --omit=dev` to confirm zero blocking advisories.

## What consumers of the published package see (re-measured, npm 11.19.0, 2026-10-05)

**Not clean. The gate audits the tree rooted in this repository, and that tree is not the tree a
consumer gets.** `npm overrides` are honored only from the root project of an install, so the
`sharp` and `adm-zip` overrides in `package.json` (and the `brace-expansion` one) reach the
in-repo tree and nothing else. Measured on 2026-10-05 against the published tarball, a consumer
resolving the same declared ranges sees 4 HIGH severity advisories (all one sharp chain) on either install shape:

| Install shape | HIGH | Leaf advisory groups |
| --- | --- | --- |
| `npm install` (peers auto-installed, pi 1.0.3 host packages) | 4 | sharp 0.33.5 (npm counts the chain: `sharp`, `@huggingface/transformers`, `@lancedb/lancedb`, `@lincoln504/pi-research`) |
| `npm install --legacy-peer-deps` (the `pi install` shape) | 4 | the same sharp 0.33.5 chain |
| either shape, plus a consumer `overrides: {"sharp": "^0.35.4"}` | 0 | none (measured 2026-10-05 on the plain shape) |

Measured 2026-10-05 by `npm pack`, then `npm install --ignore-scripts` of the tarball into a scratch
project, then `npm audit --omit=dev --json`. This replaces the 2026-10-01 table (7 / 4 / 1 / 0), whose
extra rows were `adm-zip 0.5.18` (cleared 2026-10-01 by the `@huggingface/transformers` 4.3.0 bump)
and `brace-expansion 5.0.9` inside the host's `npm-shrinkwrap.json` (see below: gone with pi 1.0.1).

The `adm-zip 0.5.18` group left the consumer tree on 2026-10-01 with the
`@huggingface/transformers` 4.2.0 → 4.3.0 bump (`onnxruntime-node` 1.24.3 → 1.30.0, whose
`adm-zip ^0.6.0` dedupes to the patched 0.6.1 everywhere in the graph). One group remains and
is not fixable from here:

- **`sharp` via `@lancedb/lancedb` 0.39.0.** LanceDB's `optionalDependencies` pins
  `@huggingface/transformers` at exactly `3.0.2`, whose `sharp ^0.33.5` resolves to the vulnerable
  `0.33.5`. Every published LanceDB version was checked on 2026-10-05 — 0.39.0 is the newest
  stable and the 0.40.0 betas (through `0.40.0-beta.12`, the `preview` dist-tag) all pin the same
  exact `3.0.2` — so no bump moves it. Upstream is the only fix: `transformers` 4.3.0 is the first
  release whose `sharp ^0.35.4` is clear, and `transformers` 3.0.3 dropped the `sharp` dependency
  entirely (the 3.1.x/3.2.x line kept `^0.33.5`). pi-research uses transformers only
  for text `feature-extraction`, so the vulnerable libvips/libheif decoders are never invoked —
  the exposure is a scanner finding, not a reachable path.
  - Consumer-side remedies, both re-verified against the 1.7.8 tarball on 2026-10-05:
    - a root `overrides: {"sharp": "^0.35.4"}` gives `npm audit` 0 and dedupes a single
      `sharp@0.35.5` into LanceDB's `transformers@3.0.2`, so the store keeps working;
    - `npm install --omit=optional` plus `npm audit --omit=optional` reports 0 as well, but it
      also drops LanceDB's own native binding, so the knowledge store disables (`DISABLED('native')`)
      rather than degrading to BM25. Not a substitute for the override when the store is wanted.
  - Consuming LanceDB's own embedding function is the only reason to keep `sharp` unoverridden.
  - Shipping an `npm-shrinkwrap.json` does NOT propagate it either. Tested 2026-10-05: the file was
    added to `files[]`, `npm pack` included it in the tarball (`package/npm-shrinkwrap.json`
    confirmed in the archive), and a scratch consumer resolving that tarball still nested
    `sharp 0.33.5` under `@lancedb/lancedb`. npm rebuilds the nested placement from the parent's
    declared range, so a packed tree pins nothing below the top level. Only a root `overrides`
    entry in the consumer's own project reaches it. Do not re-open this as an in-repo fix.

**Cleared 2026-10-05: `brace-expansion 5.0.9` inside the pi host's `npm-shrinkwrap.json`.** pi 1.0.1
(changelog: "Fixed installations resolving vulnerable `brace-expansion` 5.0.9 by pinning
`brace-expansion` 5.0.12 as a direct dependency", and "Removed `npm-shrinkwrap.json` from the published
package") fixed it at the source. This repository's own tree had still carried the frozen copy at
`node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion` (a dev-tree HIGH that
`npm audit --omit=dev`, and so this gate, cannot see) until the dev dependency moved from 1.0.0 to
1.0.3 on 2026-10-05. A consumer whose pi host is older than 1.0.1 still has it; nothing here can
change that.

What has NOT changed, and what any future exception entry here must not overstate: `npm install`
and `pi install` both **succeed with exit 0** (npm prints the advisory count as a warning), the
tarball and registry download are unaffected (the findings are metadata-level, enforced by
nothing at install time; onnxruntime-node ships its native binaries in its own tarball, so npm
12's install-script policy does not turn this into a missing-binary failure), and `npm audit` in
a consumer project **exits 1**, which fails a consumer CI that runs it. Dependabot will raise
alerts on consumer repositories — point reporters at this document.

Correction to the earlier version of this section: it claimed consumers saw zero vulnerabilities
since 2026-09-16, on the strength of an empirical run. The claim is withdrawn, and the decisive
reason is scope, not timing: whatever that run installed, it was measured from this repository's
root, where `overrides` apply, not from an external consumer's install. The date argument only
reinforces it — the `sharp` copy a consumer resolved then was already inside its `<0.35.0`
advisory range (GHSA-f88m-g3jw-g9cj, live since 2026-07-21), and the 2026-09-18 and 2026-09-29
adm-zip disclosures landed after the run. Separately, an install that did pull the optional
subtree could not have shown zero either.

It also said both adm-zip pinning parents "each require `^0.6.0`"; `onnxruntime-node 1.24.3`
(the copy `transformers` 4.2.0 actually pinned) required `adm-zip ^0.5.16`, which is why a
vulnerable `0.5.18` was present in consumers at all.

The historical findings below are kept because they document how the adm-zip advisory behaved
while the vulnerable tree was present (before consumer lockfiles re-resolve adm-zip):

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
