# Architecture Decision Records (ADRs)

This document records significant architectural decisions made for the pi-research project. Each decision follows the ADR format to provide context, rationale, and consequences.

---

## ADR-001: Multi-Agent Orchestration Model

**Status:** Accepted
**Date:** 2024-04-16
**Context:**
- Need to balance research depth with resource efficiency
- Single-agent approach limits parallel research capability
- Complex queries require specialized research tracks

**Decision:**
Implement a dual-mode orchestration system:
- **Quick Mode:** Single agent for focused queries
- **Deep Mode:** Multi-agent system with coordinator, researchers, and evaluator

**Consequences:**

**Positive:**
- Flexible resource usage based on query complexity
- Enables specialized research tracks
- Maintains performance for simple queries
- Scales to depth 3 (ultra mode) with 5 parallel researchers

**Negative:**
- Increased system complexity
- Requires inter-process communication
- More challenging debugging and testing

**Alternatives Considered:**
- Single mode only (rejected: too rigid)
- Agent self-orchestration (rejected: less efficient coordination)
- Centralized task queue (rejected: over-engineering)

---

## ADR-002: Stealth Browser Infrastructure

**Status:** Accepted
**Date:** 2024-04-16
**Context:**
- Web scraping is frequently blocked by bot detection
- APIs often have rate limits or require keys
- Users need reliable access to web content

**Decision:**
Use `camoufox-js` (stealth Firefox) as the browser engine with:
- Unified worker pool (3 processes max)
- Fingerprinting protection
- Health check system
- Process-level isolation

**Consequences:**

**Positive:**
- Bypasses most bot detection
- No API keys required
- Rate limiting under user control
- Isolated crashes don't affect main process

**Negative:**
- Higher resource usage
- Slower than API-based approaches
- Requires browser dependencies
- Platform-specific builds

**Alternatives Considered:**
- Playwright/Puppeteer (rejected: less stealthy)
- API-only approach (rejected: requires keys, less reliable)
- HTTP client only (rejected: frequently blocked)

---

## ADR-003: Knowledge Store Migration Strategy Simplification

**Status:** Accepted
**Date:** 2024-05-23
**Context:**
- Original migration system had 4 strategies (drop, continue, error, re-embed)
- `continue` strategy produced mixed vector dimensions
- `error` strategy was redundant with config validation
- Code was over-engineered for use cases

**Decision:**
Simplify to 2 strategies:
- `drop`: Fast cache invalidation (default)
- `re-embed`: Preserve data by re-embedding all vectors

Remove `continue` (poor search quality) and `error` (redundant).

**Consequences:**

**Positive:**
- 50% fewer strategies
- 10% less code
- Better user experience (no mixed vectors)
- Works with any model (no dimension mapping needed)

**Negative:**
- `re-embed` is slower (but better quality than `continue`)
- Breaking change for users of removed strategies (mitigated with fallback)

**Alternatives Considered:**
- Keep all 4 strategies (rejected: over-engineering)
- Keep 3 strategies (rejected: no clear benefit)
- Migrate to async context (deferred to separate effort)

**Related:** Phase 2B Migration Simplification

---

## ADR-004: Structured Logging Infrastructure

**Status:** Accepted
**Date:** 2024-05-22
**Context:**
- Legacy code used unstructured console.log statements
- Debugging production issues was difficult
- TUI escape sequences mixed with logs
- No log levels or filtering

**Decision:**
Implement structured logging with:
- Central logger module with log levels (debug, info, warn, error)
- JSON-structured log output
- TUI-safe output handling
- File-based log capture
- Configurable verbosity

**Consequences:**

**Positive:**
- Consistent logging across all modules
- Easy log parsing and filtering
- Production debugging capability
- TUI-safe (escape sequences handled correctly)
- File capture for post-mortem analysis

**Negative:**
- Additional dependency
- Learning curve for contributors
- Slight performance overhead

**Alternatives Considered:**
- Keep console.log (rejected: no structure)
- Simple wrapper around console (rejected: insufficient)
- External logging service (rejected: overkill)

**Related:** Phase 2C Logging Migration

---

## ADR-005: Circular Dependency Resolution

**Status:** Accepted
**Date:** 2024-05-23
**Context:**
- Project had circular dependencies between core modules
- Could not use static import for logger
- Runtime import pattern introduced complexity
- Made code harder to reason about

**Decision:**
Restructure module boundaries:
- Move logger to infrastructure layer
- Eliminate circular imports
- Use static imports where possible
- Define clear layering: infrastructure → core → orchestration

**Consequences:**

**Positive:**
- Eliminated circular dependencies
- Static imports enable better type checking
- Clearer module boundaries
- Easier to reason about code structure
- Better performance (no runtime imports)

**Negative:**
- Required code refactoring
- Some modules reorganized
- Temporary breaking changes during migration

**Alternatives Considered:**
- Keep runtime imports (rejected: maintains circular deps)
- Use require() (rejected: not ESM-compatible)
- Merge modules (rejected: increases complexity)

**Related:** Phase 1C Circular Dependency Fix

---

## ADR-006: Test Quality Improvement

**Status:** Accepted
**Date:** 2024-05-23
**Context:**
- Many tests were checking implementation details
- Some tests had trivial assertions
- Test suite had 943 tests but unclear quality
- Refactoring was risky due to brittle tests

**Decision:**
Establish test quality standards:
- Focus on behavior over implementation
- Remove trivial assertions
- Consolidate redundant tests
- Add integration test coverage
- Document testing best practices

**Consequences:**

**Positive:**
- More robust test suite
- Safer refactoring
- Clearer test intent
- Better documentation of expected behavior
- 100% backward compatibility maintained

**Negative:**
- Time investment to audit and update
- Some tests removed (but were adding no value)

**Alternatives Considered:**
- Keep existing tests (rejected: brittle, low value)
- Start from scratch (rejected: lose valuable coverage)
- Accept lower quality (rejected: increases technical debt)

**Related:** Phase 3A Test Quality Improvement

---

## ADR-007: Browser Worker Pool Design

**Status:** Accepted
**Date:** 2024-04-16
**Context:**
- Need to manage browser processes efficiently
- Multiple operations (search, scrape, health check)
- Resource constraints on user machines
- Need to prevent process explosion

**Decision:**
Use unified fixed thread pool:
- 3 worker processes maximum
- Poolifier library for process management
- Warm browser instances in workers
- Shared pool for all browser operations

**Consequences:**

**Positive:**
- Strict resource caps (3 processes max)
- Efficient worker reuse
- No process explosion risk
- Supports concurrent research sessions

**Negative:**
- Fixed pool size (not dynamic)
- Pool contention under heavy load
- Single point of failure for browser ops

**Alternatives Considered:**
- Per-session browser pools (rejected: resource explosion)
- Dynamic pool sizing (rejected: complexity, risk)
- Single browser process (rejected: no parallelization)

---

## ADR-008: Research Depth Parameter Design

**Status:** Accepted
**Date:** 2024-04-16
**Context:**
- Need to balance research depth with time/cost
- Users want control over thoroughness
- Different queries require different approaches
- System should handle edge cases gracefully

**Decision:**
Define 4 depth levels:
- **Depth 0 (Quick):** 1 researcher, 1 round, direct search
- **Depth 1 (Normal):** 2 researchers, 2 rounds, coordinator
- **Depth 2 (Deep):** 3 researchers, 3 rounds, comprehensive
- **Depth 3 (Ultra):** 5 researchers, 5 rounds, exhaustive

Default to depth 0 for simple queries, depth 1-3 based on complexity cues.

**Consequences:**

**Positive:**
- Clear user expectations
- Predictable cost/time
- Automatic depth selection works well
- Explicit override available

**Negative:**
- Ultra mode (depth 3) is expensive
- Automatic selection isn't perfect
- Limited depth levels (not continuous)

**Alternatives Considered:**
- Continuous depth (0-3) (rejected: unpredictable)
- Just 2 modes (rejected: insufficient granularity)
- Let AI decide everything (rejected: no user control)

---

## ADR-009: Research Output Format

**Status:** Accepted
**Date:** 2024-04-16
**Context:**
- Need to deliver research results to users
- Users want readable, actionable output
- Need to avoid losing data
- Filename collisions are a problem

**Decision:**
Use Markdown format with collision-guarded filenames:
- File: `pi-research-{sanitized-query}-{hash}.md`
- Location: `research/` or `docs/` subdirectory
- Hash prevents collisions
- Structured sections (summary, findings, sources)

**Consequences:**

**Positive:**
- Universal format (readable, convertable)
- No filename collisions
- Logical file organization
- Easy to share and version control

**Negative:**
- Single format only
- Markdown limitations (no interactive elements)
- Large files for complex research

**Alternatives Considered:**
- JSON only (rejected: not human-readable)
- HTML (rejected: complexity, toolchain)
- Multiple formats (rejected: overkill)

---

## ADR-010: Terminal Stability Measures

**Status:** Accepted
**Date:** 2024-05-19
**Context:**
- TUI uses advanced terminal features (kitty protocol, mouse tracking)
- Crash or reload could leave terminal in bad state
- Escape sequences could leak to shell
- User experience degraded if terminal unstable

**Decision:**
Implement terminal stability safeguards:
- Terminal state manager for mode tracking
- Input buffer draining on shutdown (100ms)
- Escape sequence filtering in input handlers
- Safe reset on all exit paths

**Consequences:**

**Positive:**
- Terminal always returned to clean state
- No ghost characters or escape sequence leaks
- Safe crash handling
- Better user experience

**Negative:**
- Additional complexity in shutdown paths
- 100ms drain delay on every shutdown
- More edge cases to handle

**Alternatives Considered:**
- Do nothing (rejected: poor UX)
- Use basic terminal only (rejected: loses TUI features)
- External terminal reset (rejected: unreliable)

**Related:** CRITICAL_FIXES.md

---

## ADR-011: Documentation Structure Reform

**Status:** Accepted
**Date:** 2024-05-23
**Context:**
- Documentation churn: 17 files added (6,673 lines), 13 deleted (5,767 lines) in one day
- Multiple overlapping reports on same topics
- No clear documentation strategy
- Mix of temporary and permanent documentation

**Decision:**
Establish durable documentation structure:
- Planning docs at root: ROADMAP.md, ADRs, SCOPE_BOUNDARIES.md
- Organized docs/ with api/, guides/, architecture/, development/ subdirectories
- Archive temporary reports to archive/
- Define documentation standards and templates
- Establish review process

**Consequences:**

**Positive:**
- Prevents documentation churn
- Clear location for each doc type
- Consistent structure and style
- Easier to maintain and find docs
- Clear review process

**Negative:**
- Time investment to reorganize
- Some temporary docs archived (not deleted)
- Contributors need to learn new structure

**Alternatives Considered:**
- Keep current structure (rejected: continues churn)
- Single docs/ folder (rejected: no organization)
- Wiki-based (rejected: external dependency)

**Related:** Phase 3B Documentation Stability

---

## Template for New ADRs

```markdown
## ADR-XXX: [Title]

**Status:** Proposed/Accepted/Deprecated/Superseded
**Date:** YYYY-MM-DD
**Context:**
- [Problem statement]
- [Constraints]
- [Current state]

**Decision:**
[Decision description]

**Consequences:**

**Positive:**
- [Benefit 1]
- [Benefit 2]

**Negative:**
- [Drawback 1]
- [Drawback 2]

**Alternatives Considered:**
- [Alternative 1] (rejected: reason)
- [Alternative 2] (rejected: reason)

**Related:** [References to other docs or phases]
```

---

**Last Updated:** 2026-05-23