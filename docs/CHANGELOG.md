# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-08-04

### Changed
- **Concurrent runs over the cap now QUEUE instead of failing — the run-cap default is a queue, not a fail-fast.** v1.0.11 added the machine-wide run cap that stopped parallel runs saturating the shared browser/embedding pool, but it shipped with `PI_RESEARCH_RUN_ACQUIRE_TIMEOUT_MS` defaulting to `0`. That made contention *fatal*: the cap was enforced by rejecting the run outright, in about two seconds, rather than by serializing it. Verified end-to-end before the change — four simultaneous skill runs against the default cap produced two clean reports and two hard failures, with the two rejected queries simply lost. That is the wrong trade for a semaphore guarding a shared resource: an extra run is a legitimate request to do work, not an error. The default acquire wait is now **600000 ms (10 minutes)**, so over-cap runs wait for a slot and then execute normally; a depth-1 run measured at ~2–3 minutes, so this absorbs a backlog of roughly three further runs per slot. `PI_RESEARCH_RUN_ACQUIRE_TIMEOUT_MS=0` restores the old strict fail-fast. The cap itself is raised from **2 to 3** concurrent runs. The agent skill's recommended command timeouts are raised to match (depth 1 `1500000` ms, depth 2 `1800000`, depth 3 `2400000`), since a queued run legitimately takes longer than an unqueued one and the old budgets no longer bounded the worst case.
- **A queued run now says so** (`• queued: N concurrent run(s) already active — waiting up to Ns for a slot…`) instead of sitting silent for the whole acquire wait. Silence for up to ten minutes is indistinguishable from a hang, which would have made the queueing change above *look* like a regression. The notice is emitted exactly once per run, via a new optional `ResearchObserver.onRunQueued(slots, maxWaitMs)`; because the queue happens before any orchestrator exists, the notification is dispatched to whichever observer shape the caller supplied — a `ResearchObserver` instance (SDK / pi extension) or the `HeadlessObserverOptions` bag carrying only `onProgress` (CLI / agent skill). A throwing front-end callback can never fail the run it is reporting on.

### Added
- **Distinct exit code `75` (`EX_TEMPFAIL`) for run-cap exhaustion.** Capacity exhaustion previously exited `70` — the same code as a genuine crash — so a calling agent could not tell "this machine is busy with other healthy runs, try again shortly" from "this run is broken", and the agent skill's own exit-code table told it to treat `70` as a transient error worth one immediate retry (which, under a 0 ms acquire, failed again instantly). It now exits `75`, documented in `SKILL.md` with explicit guidance not to reconfigure anything and not to retry in a tight loop, and `--json` output carries `retryable: true`. The classification is matched on the error name so it survives bundling into `dist/cli.mjs`, and is checked ahead of the credentials heuristic — the capacity message names `PI_RESEARCH_MAX_CONCURRENT_RUNS`, and the substring heuristic would otherwise have been at risk of reading a busy machine as a misconfigured one. Capacity exhaustion is also reported without a stack trace, since a routine "busy" state printed as a stack reads as a crash.

### Fixed
- **A browser-pool leader exiting could destroy a concurrent run outright — the retry reconnected to the dead leader instead of re-electing.** The browser pool is hosted by one elected leader process shared by every pi-research run on the machine, so when that leader finishes its own run and tears down its workers, every other run with work in flight takes `Worker pool is shutting down` on *all* outstanding tasks at once. The recovery path handled this incorrectly: on a pool-shutdown error it only waited for the pool to go idle and **never dropped the cached scheduler handle**, so the single retry called `getScheduler()`, got the same cached client still pointing at the dead leader's port (visible in logs as a retry "Connecting to existing scheduler" with an *identical* version id), and failed the same way. The generic transient-socket branch did the right thing and forced a re-resolve; the pool-shutdown branch — the case where the leader is provably going away — did not. Reproduced in a real six-way concurrent run: a run acquired its slot in the same second the leader shut down, all 20 queries of its search burst failed, and the run aborted with `Search completely failed: all 20 queries encountered worker errors` and the tell-tale `60 tracked error(s) … "Worker pool is shutting down" ×60` — roughly two seconds *before* a fresh leader finished being elected and served everyone else normally. A handover now drops the stale handle and forces re-resolution (joining the new leader, or winning the election itself), and gets its own retry budget of 3 attempts with a ~1.2 s backoff, sized to a real election rather than to the 100–500 ms jitter meant for a socket blip. The budget is tracked separately from the generic retry so a handover cannot be starved by, or consume, the single transient-socket attempt; genuinely unrecoverable pool loss still gives up rather than retrying forever. This failure mode became far more likely with over-cap queueing, since a queued run is admitted at exactly the moment another run finishes — which is exactly when the leader may be tearing down.
- **The run-cap's two environment variables were entirely undocumented.** `PI_RESEARCH_MAX_CONCURRENT_RUNS` and `PI_RESEARCH_RUN_ACQUIRE_TIMEOUT_MS` shipped in v1.0.11 and appeared in neither `docs/CONFIGURATION.md` nor `.env.example` — the latter described in the docs as "the canonical, exhaustive list" — even though the capacity error message explicitly instructed the user to override the first of them. Both are now documented in both places, and the run cap has an `ARCHITECTURE.md` section covering slot ownership, crash reclamation, queueing and fail-open behaviour.
- **`docs/SDK.md` recommended a workaround that the run cap had since made unreliable** — it told callers to "use a separate process per concurrent run" with no mention that separate processes are themselves bounded machine-wide, so following the documented advice past the cap hit a hard failure. It now documents the cap, the queue window, `ResearchRunCapacityError`, exit code `75`, and `onRunQueued`.

## [1.0.12] - 2026-08-03

### Fixed
- **Run-cap / file-lock / leader-election could misreport a live process as dead (Windows/macOS) — the root cause of the flaky `run-semaphore-multiprocess` integration failures on Windows CI.** `ProcessLifecycleService.isProcessAlive(pid, expectedStartTime)` returned `false` ("dead") whenever `process.kill(pid, 0)` confirmed the process was alive but the follow-up **start-time lookup failed**. On Linux that null reliably means the process exited in the microsecond gap between the `signal(0)` and the `/proc/{pid}/stat` read, so `false` was correct — but on Windows/macOS the start time comes from a subprocess (`powershell Get-Process` / `ps`) that can fail or time out under load while the process is still very much alive. Reporting a confirmed-alive PID as dead is catastrophic for *every* caller: a live lock / leader / run-cap owner is reclaimed from under it, so two writers collide (lost update) or the run-cap admits extra concurrent runs. The v1.0.11 Windows CI failure manifested both ways depending on timing — `expected 3 to be 4` (two holders collided on one slot) and `expected +0 to be 3` (a 5th process stole a live holder's slot and was admitted past the cap). The fix re-confirms liveness instead of guessing: when the start-time lookup returns null it issues a second `signal(0)`; if the process is still alive it reports `true`, and only if that probe throws (the process genuinely died in the interim) does the outer handler return `false`. A real death is therefore still detected within one poll tick (~100 ms); the only behavioural change is that a confirmed-alive process is never again reclaimed on a transient start-time lookup failure. PID-reuse protection is unchanged when the start time is resolvable (the `±1s` slack comparison still applies). This is a strict safety improvement across all consumers — file locks, the run-cap semaphore, GPU locks, the embedding leader, browser scheduler and state sessions — none of which ever wanted a live owner treated as dead.
- **Stack Exchange integration tests no longer fail when the upstream API returns empty results** — the Stack Exchange `search` endpoints intermittently answer `200 OK` (quota consumed, no error) with a zero-item `items:[]` for queries that normally return thousands of results (verified 2026-08-03: `q=javascript` on Stack Overflow returned `[]` from a residential IP). This is an upstream API degradation / contract drift, not a pi-research code fault and not a datacenter-IP block, yet it hard-failed the serial integration suite on all three CI OSes and thereby blocked every release whose code was otherwise identical to a previously-green build. The integration-test environment-skip helper (`isNetworkUnavailable`) now also recognizes a successful-but-empty Stack Exchange response (anchored on the tool-specific `**API Quota:**` footer plus the zero-item body) and skips the affected tests visibly via `ctx.skip()` — the same treatment already given to transport errors and `429`/`5xx` throttling. The anchor is emitted only by the Stack Exchange tool, so it cannot mask a regression in any other tool, and a populated result still exercises the assertions in full.

## [1.0.11] - 2026-08-02

### Added
- **Cross-process research run-cap** — a machine-wide counting semaphore (`ResearchRunSemaphore`) now gates every `runResearch()` entry on one of N file-lock slots. This is the root-cause fix for the parallel-run instability (60+ error storms and, on constrained hosts, process aborts) that occurred when several research runs saturated the single shared leader-elected browser/embedding pool at once. Holders are reclaimed immediately when their PID exits (PID + startTime guards against PID reuse); *live* holders are never stolen, because a run legitimately holds a slot for minutes. The cap **fails open** on any internal/IO error (a semaphore bug can never break research) and **fails fast** with a distinct `ResearchRunCapacityError` only on genuine capacity exhaustion. (Phase 1 of the multi-run hardening plan.)
- **Browser leader `drain` / 503 handover** — when the elected leader loses leadership (election loss, idle timeout, or shutdown), it now enters a draining state that answers new requests with an explicit `503 { error: "draining" }` *before* closing the listener, instead of letting connected clients stall on a connect timeout or bare reset. The client classifies this as a transient "re-elect and retry" signal (logged at DEBUG, recorded under its own `draining` errorType for forensics) and it is deliberately excluded from the circuit breaker so a routine leadership handover never reads as an incident.

### Fixed
- **Citation rewriting regression — `[removed]` tokens, list/code corruption, `[0]` deletion** — the prior placeholder-citation defense rewrote synthesis bodies with a global space collapse that flattened nested lists and 4-space code blocks, deleted bracketed integers *inside* quoted code (`items[12]`), treated `[0]` as a citation, and emitted broken `[removed]` tokens for dropped citations. All replaced by a structure-preserving rewrite: fenced blocks and inline-code spans are skipped entirely, line-leading indentation is preserved, dangling markers are removed cleanly (never as a visible token), and `[N]` outside a plausible citation range (`1..200`) and `[0]` are left untouched.
- **Provenance gate mass-dropping legitimate citations** — the gate that previously DROPPED citations tagged Scrape/Transcript when their URL was absent from the successful-scrape pool conflated a *blocked* scrape (real URL, content unretrieved) with fabrication: under the common high-scrape-failure rate (bot blocks on GitHub / Microsoft / etc.) it mass-deleted real citations. The gate is removed; every parsed citation is now kept (deduped by URL). Fabrication defense rests on URL dedup plus a new prose-URL sweep instead of punishing failed scrapes.
- **Fabricated inline URLs in synthesis prose** — inline `https?://` tokens in the report body whose URL was not retrieved this session are now redacted to `[link removed: not found in retrieved sources]` (verified inline references are kept). A matching caveat block is appended when a model-written `CITED LINKS` section survives a run that retrieved nothing, so no report ships fully-sourced-looking with no warning on a zero-retrieval run.
- **Fetch-layer scrape had no retry** — the fetch layer was the only scrape layer with no transient retry, so a single socket/DNS blip (ECONNRESET, ENOTFOUND, `UND_ERR_*`, a bare `fetch failed`) cost a full 10–30× slower browser render. It now retries once (250 ms, gated on `isTransientError`) before falling back to the stealth browser; SSRF rejections, size caps and 4xx rethrow immediately. Error tracking is recorded exactly once per URL (moved out of the retried layer) rather than once per attempt.
- **Uninformative `fetch failed` scrape logs** — Node/undici wraps the real transport reason under `error.cause`; logging only `String(err)` recorded the uninformative top-level message and discarded it. A new `formatErrorWithCause` walks the cause chain (bounded, `.code`-folding, defensive) so every fetch-failure line is self-diagnosing; it is now used consistently across the scrape path.
- **Final synthesis body never logged** — every other layer (researcher prompts/responses, searches, scrapes) was logged at DEBUG, but the synthesis itself — the actual bytes returned to the caller — was the one conspicuous exception, making post-hoc diagnosis of citation/output reports impossible. The full final and fallback synthesis bodies are now logged at DEBUG.
- **`abortableDelay` could exit the process mid-operation** — the timer was unconditionally `unref`'d, so a foreground backoff that was the sole pending handle let Node drain the loop and silently truncate work. A `keepAlive` option (used by the new foreground fetch retry) holds the loop until the operation completes; background callers are unaffected.

## [1.0.10] - 2026-07-30

### Fixed
- **pi 0.83.0 compatibility — `ResourceLoader` contract** — pi 0.83.0 extended the `ResourceLoader` contract with `getSystemPromptSource()` and `getAppendSystemPromptSources()` (consumed by interactive mode's startup context listing for file-backed `SYSTEM.md`/`APPEND_SYSTEM.md`). The in-memory sub-session loader now implements both, returning "no backing file" — accurate for prompts passed as text. The extra methods are harmless on pre-0.83 hosts, so the supported range stays `>=0.80.8 <1`. Audited the 0.82.1→0.83.0 dist diffs: the only other contract change (`ExtensionContext.scopedModels`) is provided by pi's own session code, and the mock runtime path has been immune since v1.0.9 via `createExtensionRuntime()`.

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
