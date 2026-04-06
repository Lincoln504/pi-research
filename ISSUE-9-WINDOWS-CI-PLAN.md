# Issue #9 Plan: Windows CI Coverage and Failure-Path Tests

## Issue

`#9 [P1] Add Windows CI coverage and failure-path integration tests`

This issue is now validated by a real CI failure. After enabling cross-platform CI for `lint`, `type-check`, and `unit`, the Windows matrix job failed while Linux and macOS stayed green.

Latest confirmed failure:

- GitHub Actions run: `24053244258`
- Failing job: `Unit Tests (windows-latest)`
- Root cause: hardcoded `/tmp` assumptions in shared-links code and tests

Observed Windows failure pattern:

- `ENOENT: no such file or directory, scandir 'D:\\tmp'`
- `ENOENT: no such file or directory, open 'D:\\tmp\\research-links-....json'`

## Current Diagnosis

The immediate portability bug is not in the CI workflow itself. The workflow did its job correctly and exposed a real Windows-specific filesystem assumption.

Confirmed problem areas:

- [src/utils/shared-links.ts](/Users/murataitov/VisualStudioCodeProjects/projects/pi-mono/pi-research-dev/src/utils/shared-links.ts)
  - hardcodes `/tmp` for persisted shared-links files
- [test/unit/utils/shared-links.test.ts](/Users/murataitov/VisualStudioCodeProjects/projects/pi-mono/pi-research-dev/test/unit/utils/shared-links.test.ts)
  - hardcodes `/tmp` in cleanup and path assertions

Additional temp-path hardcoding exists and should be audited after the immediate fix:

- [src/logger.ts](/Users/murataitov/VisualStudioCodeProjects/projects/pi-mono/pi-research-dev/src/logger.ts)
- [README.md](/Users/murataitov/VisualStudioCodeProjects/projects/pi-mono/pi-research-dev/README.md)
- [index.ts](/Users/murataitov/VisualStudioCodeProjects/projects/pi-mono/pi-research-dev/index.ts)

## Goals

1. Make the current CI matrix pass on Windows without backing out cross-platform coverage.
2. Remove Unix-only temp directory assumptions from the code path exercised by unit tests.
3. Make the related tests platform-neutral and deterministic.
4. Keep the CI structure pragmatic:
   - `lint`, `type-check`, `unit`: cross-platform
   - `integration`: Linux-only
5. Define the minimum useful "failure-path" test coverage for this issue.

## Coverage Assessment

The current plan should be interpreted in two layers:

### Layer A: Immediate CI Repair

This is the smallest slice required to make the newly added cross-platform CI meaningful and green again.

It covers:

1. Windows CI is active and catching real portability bugs.
2. The currently known Windows temp-path bug is fixed.
3. Unit tests stop depending on Unix-only filesystem assumptions.

This layer does **not** fully close the whole issue by itself.

### Layer B: Full Issue Closure

To honestly say `#9` is fully covered, we need both:

1. Cross-platform CI coverage for safe jobs.
2. At least some intentional failure-path coverage, not just whatever failures CI happened to discover by accident.

That means the first PR should unblock Windows CI, but the full issue should remain open until failure-path coverage is clearly defined and present.

## Non-Goals

- Do not expand Docker-based integration tests to Windows or macOS.
- Do not redesign all logging/storage infrastructure unless required for correctness.
- Do not try to solve every historical `/tmp` usage in a single refactor if a narrower safe fix unblocks CI first.

## Recommended Implementation Order

### Workstream 1: Fix the Shared Links Temp Path Contract

Target:

- [src/utils/shared-links.ts](/Users/murataitov/VisualStudioCodeProjects/projects/pi-mono/pi-research-dev/src/utils/shared-links.ts)

Plan:

1. Replace the hardcoded `/tmp` path with `os.tmpdir()`.
2. Keep filename format stable: `research-links-${sessionId}.json`.
3. If needed, add a tiny internal helper for temp-dir resolution rather than repeating `os.tmpdir()`.
4. Ensure save/load/cleanup behavior remains unchanged except for path portability.

Expected outcome:

- Shared-links persistence works on Linux, macOS, and Windows.

### Workstream 2: Fix the Unit Tests to Be Cross-Platform

Target:

- [test/unit/utils/shared-links.test.ts](/Users/murataitov/VisualStudioCodeProjects/projects/pi-mono/pi-research-dev/test/unit/utils/shared-links.test.ts)

Plan:

1. Replace `/tmp` assumptions with `os.tmpdir()`.
2. Update cleanup logic to read from the platform temp dir.
3. Update path assertions to use `path.join(os.tmpdir(), ...)` instead of literal `/tmp/...`.
4. Keep tests focused on behavior, not Unix-specific path shape.

Expected outcome:

- Windows unit job stops failing for environment-specific reasons.

### Workstream 3: Audit Remaining Temp-Path Usage

Targets:

- [src/logger.ts](/Users/murataitov/VisualStudioCodeProjects/projects/pi-mono/pi-research-dev/src/logger.ts)
- [README.md](/Users/murataitov/VisualStudioCodeProjects/projects/pi-mono/pi-research-dev/README.md)
- [index.ts](/Users/murataitov/VisualStudioCodeProjects/projects/pi-mono/pi-research-dev/index.ts)

Plan:

1. Identify whether each `/tmp` usage is:
   - implementation bug
   - test-only assumption
   - user-facing message drift
2. Fix runtime code first if it can break Windows behavior.
3. Update docs/messages second so the repo stops promising Unix-only paths.

Expected outcome:

- No obvious remaining Windows-hostile temp-path behavior in user-visible core paths.

### Workstream 4: Define Failure-Path Coverage for This Issue

This issue mentions "failure-path integration tests", but the current confirmed bug was caught by unit tests. The practical interpretation should be narrow and useful.

Recommended minimum:

1. Add or keep unit coverage for temp-dir path construction and file lifecycle.
2. Add negative tests around:
   - non-existent file load returns `null`
   - cleanup of missing file does not throw
   - save/load path uses the platform temp dir
3. Keep targeted integration-level failure-path tests only for real runtime boundaries that unit tests cannot meaningfully replace.

Do not add synthetic integration tests just to satisfy wording in the issue.

Recommended full-issue failure-path set:

1. Keep the shared-links path problem covered at the unit level.
2. Ensure at least one Linux integration test intentionally covers an actual runtime degradation path.
   - Current candidate already present in repo:
     [test/integration/searxng-container.test.ts](/Users/murataitov/VisualStudioCodeProjects/projects/pi-mono/pi-research-dev/test/integration/searxng-container.test.ts)
     `should handle connection errors gracefully`
   - If that test remains in CI and is stable, additional failure-path integration tests are optional, not required for issue closure.
3. Do not force Windows-specific integration tests unless there is a runtime path that actually needs them.

Reasoning:

- The Windows bug we found is a filesystem portability problem. Unit tests are the right layer for that.
- Integration tests should focus on real boundary failures: Docker, HTTP, startup readiness, cleanup, and degraded service behavior.
- That gives coverage that matches the issue title without bloating CI.

## Concrete Fix Scope for the First PR

The first PR for `#9` should stay tight:

1. Fix `shared-links.ts` temp-dir handling.
2. Fix `shared-links.test.ts`.
3. Optionally fix adjacent doc/message references if they are trivial and obviously stale.
4. Push and let the Windows matrix confirm the repair.

This is the smallest correct slice.

## Concrete Scope to Fully Close the Issue

If the goal is not just "green CI again" but "close `#9`", the repo needs this complete set:

1. Fix `shared-links.ts` temp-dir handling.
2. Fix `shared-links.test.ts`.
3. Fix adjacent runtime/user-visible temp-path messaging where it would still mislead Windows users.
4. Keep cross-platform CI enabled.
5. Confirm Windows unit job passes.
6. Confirm at least one explicit Linux integration failure-path test remains in CI.

At the time of writing, the existing candidate for step 6 is:

- [test/integration/searxng-container.test.ts](/Users/murataitov/VisualStudioCodeProjects/projects/pi-mono/pi-research-dev/test/integration/searxng-container.test.ts)
  `should handle connection errors gracefully`

That means a separate PR for failure-path coverage may not be necessary if this test remains stable and intentional.

## Test Plan

### Local Validation

Required:

1. `npm run type-check`
2. `npm run test:unit`
3. Targeted check of shared-links tests if needed:
   - `npx vitest run --config configs/vitest.config.unit.ts test/unit/utils/shared-links.test.ts`

Recommended while the issue is still open:

4. Review existing integration failure-path coverage and document gaps before adding more tests.

Optional:

1. `npm run lint`

### CI Validation

Required:

1. Confirm these jobs are green after the fix:
   - `Lint (ubuntu-latest)`
   - `Lint (macos-latest)`
   - `Lint (windows-latest)`
   - `Type Check (ubuntu-latest)`
   - `Type Check (macos-latest)`
   - `Type Check (windows-latest)`
   - `Unit Tests (ubuntu-latest)`
   - `Unit Tests (macos-latest)`
   - `Unit Tests (windows-latest)`
   - `Integration Tests`
2. Specifically inspect the Windows unit job log and confirm the previous `D:\\tmp` failures are gone.

For full issue closure:

3. Confirm at least one explicit failure-path integration test remains green in Linux CI and is testing an intentional degraded path, not just a happy path.

### Regression Checks

After the main fix lands:

1. Search for remaining temp-path literals:
   - `rg -n "/tmp|\\\\tmp|tmpdir\\(" src test README.md index.ts`
2. Review whether any remaining `/tmp` is intentional and documented.

## Done Criteria

Issue `#9` is ready to close when all of the following are true:

1. Cross-platform CI remains enabled for `lint`, `type-check`, and `unit`.
2. Windows unit tests pass.
3. The current `/tmp`-based shared-links portability bug is fixed.
4. There is at least minimal negative-path coverage around shared-links file lifecycle.
5. There is at least one explicit runtime failure-path integration test that is intentionally part of CI on Linux.
6. No immediate user-facing docs/messages still incorrectly imply Unix-only temp paths for the fixed code path.

## Current Recommendation

The correct execution order is:

1. Land the small Windows temp-path fix first.
2. Re-run the matrix and make sure Windows is truly green.
3. Then decide whether the existing integration negative-path coverage is sufficient to close `#9`.
4. If not, add one small focused PR for runtime failure-path integration tests.

So the honest answer is:

- the current first-fix plan is correct for the immediate regression
- it does **not** by itself cover the whole issue
- the whole issue is only covered after both the Windows portability repair and explicit failure-path integration coverage are in place

## Notes for Other Agents

- Do not remove Windows CI coverage to make the build green.
- Treat the failing Windows job as a real product bug, not just a flaky runner issue.
- Prefer `os.tmpdir()` and `path.join(...)` over any hardcoded temporary directory path.
- Keep the first fix narrow. Unblock CI first, then widen the temp-path audit only if needed.
