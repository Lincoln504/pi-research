# Testing Implementation Checklist

## Phase 0: Test Infrastructure Setup ✅ Day 1

### Installation & Configuration
- [ ] Install Vitest and related packages
  ```bash
  npm install --save-dev vitest @vitest/ui @vitest/coverage-v8 testcontainers
  ```
- [ ] Update `package.json` with test scripts
- [ ] Create `vitest.config.ts`
- [ ] Create `vitest.config.unit.ts`
- [ ] Create `vitest.config.integration.ts`
- [ ] Create `test/setup/unit.ts`
- [ ] Create `test/setup/integration.ts`
- [ ] Create test directory structure
- [ ] Create `test/README.md`
- [ ] Run `npm test` to verify setup works

---

## Phase 1: Interface Extraction ⏳ Days 2-3

### Create Interface Definitions
- [ ] Create `src/interfaces/` directory
- [ ] Create `ILogger` interface (`src/interfaces/logger.ts`)
- [ ] Create `IHttpClient` interface (`src/interfaces/http-client.ts`)
- [ ] Create `ISearxngManager` interface (`src/interfaces/docker-manager.ts`)
- [ ] Create `IBrowserManager` interface (`src/interfaces/browser-manager.ts`)
- [ ] Create `IFileSystem` interface (`src/interfaces/file-system.ts`)
- [ ] Create `IStateManager` interface (`src/interfaces/state-manager.ts`)

### Create Mock Implementations
- [ ] Create `NullLogger` and `TestLogger`
- [ ] Create `MockHttpClient`
- [ ] Create `MockBrowser` and `MockBrowserContext`
- [ ] Create `InMemoryFileSystem`

---

## Phase 2: Core Module Refactoring ⏳ Days 4-7

### Logger Module Refactoring
- [ ] Refactor `src/logger.ts` into class-based structure
- [ ] Create `src/logger/logger.ts` (FileLogger class)
- [ ] Create `src/logger/console-suppressor.ts` (ConsoleSuppressor class)
- [ ] Create `src/logger/factory.ts` (factory functions)
- [ ] Update `src/logger/index.ts` for backward compatibility
- [ ] Add module reset capability for tests
- [ ] Write tests for logger module

### SearXNG Lifecycle Refactoring
- [ ] Create `src/lifecycle/` directory
- [ ] Create `SearxngLifecycle` class
- [ ] Extract Docker operations into manager
- [ ] Remove module-level singleton state
- [ ] Add dependency injection for ISearxngManager
- [ ] Add dependency injection for ILogger
- [ ] Add dependency injection for IFileSystem
- [ ] Write tests for lifecycle module

### Web Research Refactoring
- [ ] Create `PlaywrightBrowserManager` class
- [ ] Extract browser lifecycle management
- [ ] Create `src/web-research/html-processor.ts` (pure functions)
- [ ] Extract `convertHtmlToMarkdown` function
- [ ] Extract `validateContent` function
- [ ] Extract `extractMainContent` function
- [ ] Make scrape functions accept browser manager
- [ ] Write tests for HTML processor (pure functions)
- [ ] Write integration tests for browser manager

### Orchestration Refactoring
- [ ] Create `ResearcherPool` class
- [ ] Extract concurrency logic from delegate-tool
- [ ] Create `SessionFactory` class
- [ ] Create `TimeoutManager` class
- [ ] Extract timeout/retry logic
- [ ] Add dependency injection throughout
- [ ] Write tests for researcher pool
- [ ] Write tests for timeout manager

### Security Module Refactoring
- [ ] Add `IHttpClient` injection to `nvd.ts`
- [ ] Add `IHttpClient` injection to `cisa-kev.ts`
- [ ] Add `IHttpClient` injection to `github-advisories.ts`
- [ ] Add `IHttpClient` injection to `osv.ts`
- [ ] Remove direct `fetch` calls
- [ ] Write integration tests for each database client

### Stack Exchange Module Refactoring
- [ ] Add `IHttpClient` injection to `rest-client.ts`
- [ ] Remove direct `fetch` calls
- [ ] Write integration tests for Stack Exchange client

---

## Phase 3: Unit Tests ✅ Days 8-12

### Pure Function Tests (Immediate Wins)
- [ ] Write `test/unit/config.test.ts`
- [ ] Write `test/unit/utils/text-utils.test.ts`
- [ ] Write `test/unit/utils/session-state.test.ts`
- [ ] Write `test/unit/utils/shared-links.test.ts`
- [ ] Write `test/unit/stackexchange/queries.test.ts`
- [ ] Write `test/unit/stackexchange/output/compact.test.ts`
- [ ] Write `test/unit/stackexchange/output/table.test.ts`
- [ ] Write `test/unit/stackexchange/output/json.test.ts`
- [ ] Write `test/unit/stackexchange/cache.test.ts`
- [ ] Write `test/unit/security/types.test.ts`

### TUI Component Tests
- [ ] Write `test/unit/tui/research-panel.test.ts`
- [ ] Write `test/unit/tui/simple-widget.test.ts`
- [ ] Write `test/unit/tui/full-widget.test.ts`
- [ ] Write `test/unit/tui/panel-factory.test.ts`
- [ ] Write `test/unit/tui/searxng-status.test.ts`

### Refactored Module Tests
- [ ] Write `test/unit/logger.test.ts`
- [ ] Write `test/unit/lifecycle.test.ts`
- [ ] Write `test/unit/web-research/html-processor.test.ts`
- [ ] Write `test/unit/orchestration/researcher-pool.test.ts`
- [ ] Write `test/unit/orchestration/timeout-manager.test.ts`

---

## Phase 4: Integration Tests ⏳ Days 13-17

### Test Container Setup
- [ ] Create `test/helpers/test-containers.ts`
- [ ] Implement `startSearxngContainer()`
- [ ] Implement `startRedisContainer()` (if needed)
- [ ] Implement `cleanupTestContainers()`
- [ ] Create `test/helpers/assertions.ts`
- [ ] Create `test/helpers/matchers.ts`

### Web Research Integration Tests
- [ ] Write `test/integration/web-research/search.test.ts`
- [ ] Write `test/integration/web-research/scrapers.test.ts`
- [ ] Test with real SearXNG container
- [ ] Test with real Playwright (or mock)

### Security Integration Tests
- [ ] Write `test/integration/security/nvd.test.ts`
- [ ] Write `test/integration/security/cisa-kev.test.ts`
- [ ] Write `test/integration/security/github-advisories.test.ts`
- [ ] Write `test/integration/security/osv.test.ts`
- [ ] Test with real APIs (no mocks)

### Stack Exchange Integration Tests
- [ ] Write `test/integration/stackexchange/rest-client.test.ts`
- [ ] Write `test/integration/stackexchange/cache.test.ts`
- [ ] Test with real Stack Exchange API

### Infrastructure Integration Tests
- [ ] Write `test/integration/infrastructure/docker.test.ts`
- [ ] Write `test/integration/infrastructure/network-manager.test.ts`
- [ ] Write `test/integration/infrastructure/state-manager.test.ts`
- [ ] Test with real Docker

---

## Phase 5: End-to-End Tests ⏳ Days 18-20

### Orchestration E2E Tests
- [ ] Write `test/e2e/orchestration/research.test.ts`
- [ ] Test complete research workflow
- [ ] Test error handling
- [ ] Test timeout scenarios
- [ ] Test concurrent researcher execution

### Full System Tests
- [ ] Test research with all tools enabled
- [ ] Test researcher failure handling
- [ ] Test SearXNG failure scenarios
- [ ] Test cleanup on abort
- [ ] Test multiple research sessions

---

## Phase 6: Coverage & Quality ✅ Days 21-22

### Coverage Goals
- [ ] Achieve 85%+ statement coverage
- [ ] Achieve 80%+ branch coverage
- [ ] Achieve 85%+ function coverage
- [ ] Achieve 85%+ line coverage
- [ ] Generate coverage report
- [ ] Review uncovered code
- [ ] Add tests for critical uncovered paths

### CI/CD Setup
- [ ] Create `.github/workflows/test.yml`
- [ ] Add unit test workflow
- [ ] Add integration test workflow
- [ ] Add coverage reporting
- [ ] Set up Codecov
- [ ] Add pre-commit hooks (husky)

### Documentation
- [ ] Update README with test instructions
- [ ] Document test structure
- [ ] Add test contribution guidelines
- [ ] Document testing best practices

---

## Module-by-Module Testing Guide

### 100% Testable Now (No Refactoring)
| Module | File | Test File | Status |
|--------|------|-----------|--------|
| Config | `src/config.ts` | `test/unit/config.test.ts` | ⏳ Pending |
| Text Utils | `src/utils/text-utils.ts` | `test/unit/utils/text-utils.test.ts` | ✅ Created |
| Session State | `src/utils/session-state.ts` | `test/unit/session-state.test.ts` | ✅ Created |
| Shared Links | `src/utils/shared-links.ts` | `test/unit/utils/shared-links.test.ts` | ⏳ Pending |
| Stack Exchange Queries | `src/stackexchange/queries.ts` | `test/unit/stackexchange/queries.test.ts` | ⏳ Pending |
| Stack Exchange Output | `src/stackexchange/output/*` | `test/unit/stackexchange/output/*.test.ts` | ⏳ Pending |
| Security Types | `src/security/types.ts` | `test/unit/security/types.test.ts` | ⏳ Pending |
| Web Research Types | `src/web-research/types.ts` | N/A | N/A (types only) |

### Requires Refactoring Before Testing
| Module | Refactoring Needed | Est. Effort |
|--------|-------------------|-------------|
| Logger | Extract ILogger interface | 4h |
| SearXNG Lifecycle | Extract ISearxngManager | 6h |
| Scrapers | Extract IBrowserManager | 8h |
| Web Search | Extract IHttpClient | 2h |
| Tool Orchestration | DI for all deps | 12h |
| Delegate Tool | Extract worker pool | 10h |
| Security Clients | Extract IHttpClient | 6h |
| Stack Exchange Client | Extract IHttpClient | 2h |

---

## Quick Start (Today)

1. **Install dependencies** (5 min)
   ```bash
   npm install --save-dev vitest @vitest/ui @vitest/coverage-v8 testcontainers
   ```

2. **Run existing tests** (2 min)
   ```bash
   npm test
   ```

3. **Write one test** (10 min)
   - Copy one of the existing test files
   - Modify to test a new function
   - Run to verify

---

## Progress Tracking

- [ ] Phase 0: Infrastructure (0/10 complete)
- [ ] Phase 1: Interfaces (0/7 complete)
- [ ] Phase 2: Refactoring (0/6 complete)
- [ ] Phase 3: Unit Tests (2/19 complete)
- [ ] Phase 4: Integration Tests (0/15 complete)
- [ ] Phase 5: E2E Tests (0/5 complete)
- [ ] Phase 6: Coverage & CI/CD (0/6 complete)

**Overall Progress**: 2/62 tasks complete (3%)

---

## Notes

- Unit tests should run in milliseconds
- Integration tests use testcontainers (real Docker)
- E2E tests are slowest but most comprehensive
- Coverage targets: 85%+ overall
- CI/CD gates on coverage and passing tests
- Use `VITEST_VERBOSE=1` for debug output
