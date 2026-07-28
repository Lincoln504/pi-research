# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.9] - 2026-07-28

### Fixed
- **pi ≥ 0.81.0 researcher crash** — every researcher session died with `pendingNativeProviderRegistrations is not iterable` under pi 0.81.0+ ("no source material was collected"). The hand-maintained `ExtensionRuntime` mock in the resource loader was frozen at a pre-0.81 contract; it is replaced with pi's own `createExtensionRuntime()`, which always satisfies the running host's contract and cannot drift again.
- **pi 0.80.8+ ModelRuntime migration** — `buildModelRegistry` migrated off the removed `AuthStorage`/`ModelRegistry.create()` APIs to `ModelRuntime.create()` + the synchronous `ModelRegistry` facade. The `@earendil-works/*` dependency floor and the in-host version self-check are both raised to 0.80.8 to match.
- **Explicit-API-key auth now reaches researcher LLM calls** — researcher sessions are created with the `modelRuntime` backing our own registry (pi 0.80.8 removed the old `modelRegistry` session option). Without this, standalone `PI_RESEARCH_API_KEY` users with no `~/.pi/agent/auth.json` passed pre-flight and then failed auth on every researcher call.
- **Explicit-API-key pre-flight hang** — seeding a runtime API key triggered a model-catalog refresh whose default options open live network connections with no timeout; in network-restricted environments the CLI pre-flight hung indefinitely. The refresh is now pinned offline (`allowNetwork: false`).
- **No filesystem side effects on read-only commands** — the migrated runtime's default file-backed credential store created `~/.pi/agent/auth.json` at construction, so every CLI invocation (including `status`) silently created a pi config dir on machines without pi and hard-failed where `$HOME` is read-only. An in-memory credential store is used when no `auth.json` exists; env-var provider keys are unaffected.
- **Search-timeout cascade under concurrent load** — the per-query hard cap in browser search started at enqueue with only the nav budget, so a query stuck in a saturated worker queue burned its whole budget waiting and aborted with zero work ("Query timed out … likely blocked or slow startup"). The cap now includes the queue-wait margin, matching the scheduler's own ceiling.
- **`PI_RESEARCH_LLM_TIMEOUT_MS` ceiling raised 10 → 30 min** — an explicit higher value was silently clamped to 600000, timing out large-context synthesis calls mid-generation.
- **CHANGELOG dates corrected** — release dates in this file wrongly said 2024; corrected to the actual git release dates (2026).

### Security
- **protobufjs override 7.6.4 → 7.6.5** — clears GHSA-j3f2-48v5-ccww (DoS) and its whole moderate advisory chain through `@google/genai`/pi-ai.
- **adm-zip forced to 0.6.0 via override** — clears GHSA-xcpc-8h2w-3j85 (crafted-ZIP 4 GB allocation) in the camoufox-js subtree; extraction APIs camoufox uses verified compatible.
- **Audit gate hardened with a reviewed exception list** — CI and the release publish gate now run `scripts/audit-gate.cjs`: any moderate+ advisory in the shipped tree fails the build unless explicitly allowlisted in `config/tooling/audit-exceptions.json` with an upstream-blocked justification, a clears-when condition, and a review date. Current exceptions: `brace-expansion` (frozen inside pi-coding-agent's npm-shrinkwrap; fix released upstream) and `sharp` (unused image pipeline of the embeddings-only transformers dependency).

### Changed
- **Dependencies**: pi ecosystem lockfile refreshed to 0.82.1 (matching the current pi host); `pdf-oxide-wasm` 0.3.77; `undici` ^8.9; devDependencies refreshed (eslint 10.8, typescript-eslint 8.65, vitest 4.1.10, dependency-cruiser 17.4.3). Deliberate pins unchanged (typebox 1.1.38, playwright-core 1.60.0, camoufox-js 0.10.x, lancedb 0.29, apache-arrow 21.1.0, transformers 4.2, impit 0.13).
- **Docs**: `PI_RESEARCH_LLM_TIMEOUT_MS` range updated in CONFIGURATION.md.

## [1.0.8] - 2026-07-17

### Added
- **CHANGELOG** — Added comprehensive CHANGELOG.md documenting all versions from 0.1.13 through 1.0.7
- **System prompt constraint** — Added "Maximum 4 simultaneous calls" constraint to research-tool-usage prompt to prevent system overload

### Changed
- **Topic consolidation guidance** — Emphasized that topics can likely be consolidated to fit the 4-call maximum, with strategies for grouping related subtopics
- **Package structure** — CHANGELOG.md now included in published package (docs/CHANGELOG.md)

## [1.0.7] - 2026-07-14

### Fixed
- **Browser-pool leader-election race** - Fixed a critical bug where a single client's transient socket error could force-clear shared leader state, causing a live, healthy leader to self-destruct via the leadership-miss watchdog. The fix reserves the "unreachable, force clear" path for cases where liveness probes actually confirm the registered leader PID or port is gone.
- **Researcher retry-exemption** - Fixed the "no initial search results or historical links" failure path that bypassed the retry loop entirely. This now routes through the same `RESEARCHER_MAX_RETRIES`/`RESEARCHER_MAX_RETRY_DELAY_MS` retry loop as other failures.
- **Exit-code misclassification** - Fixed false-positive classification of "Research stopped" errors as config errors (exit 78) via substring matching on the boilerplate "API key" advice text. Error classification now properly distinguishes infrastructure failures from credential problems.
- **Unsurfaced quality signals** - Added per-run error tracking and per-researcher grounding signals to the log output for better debugging of report quality variance.
- **SIGINT/SIGTERM cancellation wiring** - Improved cancellation handling for graceful shutdown on interrupt signals.
- **Multi-researcher citation-provenance folding** - Fixed citation provenance tracking when multiple researchers contribute to a report.
- **Untitled YouTube video citation line** - Fixed citation formatting for YouTube videos without titles.

### Security
- Several hardening improvements from the adversarial-review audit:
  - Migration abort safety gates
  - Hollow-run detection gates
  - Streaming caps for large responses
  - Socket drain on Content-Length pre-screen throws
  - Observer isolation improvements

## [1.0.6] - 2026-07-04

### Fixed
- **Observer isolation** - Fixed `makeSafeObserver` proxying the observer directly, which could cause state leakage.

### Documentation
- Corrected depth-0 availability documentation
- Fixed migration.ts attribution in architecture docs

## [1.0.5] - 2026-07-04

### Fixed
- **Content-Length pre-screen throws** - Added proper body draining to prevent resource leaks
- **TTL refresh for transcribed links** - Fixed TTL handling for YouTube transcripts

### Fixed
- **YouTube transcript provenance** - Fixed transcript provenance tracking in final report citations

## [1.0.4] - 2026-07-04

### Fixed
- **Credential detection** - Detect pi keys by pi's own semantics, not file presence; registry no longer gated on auth.json
- **Configuration clarity** - Updated docs to reflect that pi has configuration files, not a named 'auth' feature

## [1.0.3] - 2026-07-04

### Fixed
- **Model resolution** - Require a configured model on the standalone CLI/skill; align SDK session model with RESEARCH_MODEL
- **Configuration requirement** - Added proper error messages when model is not configured

### Documentation
- Updated installation and configuration documentation

## [1.0.2] - 2026-07-04

### Fixed
- **Timeout robustness** - Improved timeout handling for long-running operations
- De-emphasized the markdown-conversion fallback in favor of native HTML-to-markdown conversion

## [1.0.1] - 2026-07-04

### Fixed
- Initial stable release after rebuild against current pi APIs
- Stealth-browser stack integration

## [0.1.13] - 2026-04-15

### Added
- Initial research functionality
- Knowledge store integration
- Multi-agent orchestration

---

## Deferred Findings (from v1.0.7 audit)

The following issues were identified during the v1.0.7 audit but intentionally deferred to future releases:

1. **KnowledgeStore.close() timeout behavior** - The close() method proceeds even when the pending-write wait times out. A correct fix requires threading cancellation tokens through write paths or documenting the 10s timeout as intended behavior.

2. **Cross-session teardown via shared singletons** - Session shutdown handlers run process-wide cleanup for reload/new/fork events. The correct behavior depends on pi's session model semantics and needs further investigation.

3. **Lower-severity hardening items** - Various low-confidence or low-impact findings noted for future investigation:
   - SIGINT-adjacent cancellation race
   - Knowledge-store migration vs. concurrent access
   - Global activity gate reused for per-session decisions
   - Zombie queued browser tasks after timeout
   - Non-atomic `clearBrowserServer`
   - Inconsistent `knowledge --json` payload shapes
   - Backward-clock-step tolerance across multiple rate limiters

See `DEFERRED-FINDINGS-2026-07-14.md` for full details.
