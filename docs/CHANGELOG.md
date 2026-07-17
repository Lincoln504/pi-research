# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.7] - 2024-07-14

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

## [1.0.6] - 2024-07-01

### Fixed
- **Observer isolation** - Fixed `makeSafeObserver` proxying the observer directly, which could cause state leakage.

### Documentation
- Corrected depth-0 availability documentation
- Fixed migration.ts attribution in architecture docs

## [1.0.5] - 2024-06-28

### Fixed
- **Content-Length pre-screen throws** - Added proper body draining to prevent resource leaks
- **TTL refresh for transcribed links** - Fixed TTL handling for YouTube transcripts

### Fixed
- **YouTube transcript provenance** - Fixed transcript provenance tracking in final report citations

## [1.0.4] - 2024-06-25

### Fixed
- **Credential detection** - Detect pi keys by pi's own semantics, not file presence; registry no longer gated on auth.json
- **Configuration clarity** - Updated docs to reflect that pi has configuration files, not a named 'auth' feature

## [1.0.3] - 2024-06-20

### Fixed
- **Model resolution** - Require a configured model on the standalone CLI/skill; align SDK session model with RESEARCH_MODEL
- **Configuration requirement** - Added proper error messages when model is not configured

### Documentation
- Updated installation and configuration documentation

## [1.0.2] - 2024-06-15

### Fixed
- **Timeout robustness** - Improved timeout handling for long-running operations
- De-emphasized the markdown-conversion fallback in favor of native HTML-to-markdown conversion

## [1.0.1] - 2024-06-10

### Fixed
- Initial stable release after rebuild against current pi APIs
- Stealth-browser stack integration

## [0.1.13] - 2024-04-15

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
