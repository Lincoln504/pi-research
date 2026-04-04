# Remaining Testability Work - Prioritized Roadmap

**Current Status:** 643 unit tests passing in 17 test files

## Phase 1: Complete Unit Tests for Pure Functions (High Priority)

### 1.1 TUI Components (20-30 tests)
**Files to test:**
- `src/tui/panel-factory.ts` - Factory functions
- `src/tui/simple-widget.ts` - Widget creation
- `src/tui/full-widget.ts` - Full widget assembly
- `src/tui/research-panel.ts` - Research panel logic
- `src/tui/searxng-status.ts` - Status display

**Why:** Pure functions, no external dependencies, fast to test

### 1.2 Security Database Type Guards (5-10 tests)
**Files to complete:**
- `src/security/types.ts` - More comprehensive type guard tests
- Test all severity levels, valid/invalid inputs

### 1.3 Stack Exchange Cache & Types (10-15 tests)
**Files to test:**
- `src/stackexchange/cache.ts` - Cache operations
- `src/stackexchange/types.ts` - Type validation
- `src/stackexchange/rest-client.ts` - Response parsing

### 1.4 Web Research Utils (10-15 tests)
**Files to complete:**
- `src/web-research/retry-utils.ts` - Retry logic
- `src/web-research/dependencies.ts` - Dependency checking

**Target:** 60-80 more unit tests (total: ~700-720 tests)

---

## Phase 2: Infrastructure Refactoring & Testing (Medium Priority)

### 2.1 Refactor for Dependency Injection
**Modules needing refactoring:**
- `src/infrastructure/state-manager.ts` - File system operations
- `src/security/nvd.ts`, `osv.ts`, `github-advisories.ts`, `cisa-kev.ts` - API clients
- `src/web-research/search.ts` - SearXNG integration
- `src/web-research/scrapers.ts` - Browser-based scraping

**Pattern:** Create interfaces, inject dependencies, enable mocking

### 2.2 Create Test Helpers for Integration
**Create:**
- `test/helpers/mock-http-client.ts` - Mock fetch wrapper
- `test/helpers/mock-docker-client.ts` - Mock Docker operations
- `test/helpers/test-fixtures.ts` - Test data generators

---

## Phase 3: Integration Tests (Medium-High Priority)

### 3.1 Set up Test Infrastructure
```typescript
// test/integration/setup.ts
- Docker testcontainers setup
- SearXNG container configuration
- Real API client initialization
```

### 3.2 Security Database Integration Tests
**Create:**
- `test/integration/security/nvd.test.ts` - Real NVD API (10 tests)
- `test/integration/security/osv.test.ts` - Real OSV API (10 tests)
- `test/integration/security/github-advisories.test.ts` - GitHub API (10 tests)
- `test/integration/security/cisa-kev.test.ts` - CISA KEV API (10 tests)

**Total:** ~40 integration tests

### 3.3 Stack Exchange Integration Tests
**Create:**
- `test/integration/stackexchange/rest-client.test.ts` - Real SE API (15 tests)

### 3.4 Web Research Integration Tests
**Create:**
- `test/integration/web-research/search.test.ts` - SearXNG in container (10 tests)
- `test/integration/web-research/scrapers.test.ts` - Browser scraping (15 tests)

**Total:** ~40 more integration tests

### 3.5 Infrastructure Integration Tests
**Create:**
- `test/integration/infrastructure/state-manager.test.ts` - File operations (10 tests)
- `test/integration/infrastructure/searxng-manager.test.ts` - Container lifecycle (15 tests)

**Total:** ~25 integration tests

**Phase 3 Target:** ~125 integration tests

---

## Phase 4: Orchestration & E2E Tests (High Priority)

### 4.1 Orchestration Unit Tests
**Create:**
- `test/unit/orchestration/researcher.test.ts` - Researcher logic (15 tests)
- `test/unit/orchestration/coordinator.test.ts` - Coordination logic (20 tests)
- `test/unit/orchestration/context-tool.test.ts` - Context management (10 tests)
- `test/unit/orchestration/delegate-tool.test.ts` - Tool delegation (15 tests)

**Total:** 60 more unit tests

### 4.2 End-to-End Tests
**Create:**
- `test/e2e/orchestration/research-flow.test.ts` - Full research workflow (10 tests)
- `test/e2e/orchestration/parallel-researchers.test.ts` - Concurrent execution (10 tests)
- `test/e2e/agent-tools.test.ts` - Tool integration (10 tests)

**Total:** 30 E2E tests

---

## Phase 5: CI/CD & Quality Gates

### 5.1 GitHub Actions Workflows
**Create:**
- `.github/workflows/unit-tests.yml` - Run unit tests on PR
- `.github/workflows/integration-tests.yml` - Run integration tests (nightly)
- `.github/workflows/coverage.yml` - Generate coverage reports

### 5.2 Coverage Configuration
- Set coverage thresholds (80%+ for core modules)
- Codecov integration
- Pre-commit hooks (husky)

---

## Implementation Priority Order

### Week 1: Pure Functions & Quick Wins
1. TUI component tests (20-30 tests) - 4 hours
2. Security type guards (5-10 tests) - 1 hour
3. Stack Exchange cache (10-15 tests) - 2 hours
4. Web research utils (10-15 tests) - 2 hours
5. Orchestration unit tests (60 tests) - 8 hours

**Target:** +105 tests (total: ~750 tests)

### Week 2: Integration Infrastructure
1. Create test helpers (4 hours)
2. Set up testcontainers (4 hours)
3. Security DB integration tests (6 hours)
4. Stack Exchange integration tests (3 hours)

**Target:** +70 integration tests

### Week 3: Web Research & Infrastructure
1. Web research integration tests (6 hours)
2. Infrastructure integration tests (4 hours)
3. E2E test creation (6 hours)

**Target:** +50 more tests, 30 E2E tests

### Week 4: CI/CD & Polish
1. GitHub Actions setup (4 hours)
2. Coverage configuration (2 hours)
3. Test optimization & cleanup (4 hours)

---

## Success Metrics

| Metric | Current | Target | Timeline |
|--------|---------|--------|----------|
| Unit Tests | 643 | 800+ | Week 1 |
| Integration Tests | 0 | 120+ | Week 2-3 |
| E2E Tests | 0 | 30+ | Week 3 |
| Total Tests | 643 | 950+ | Week 4 |
| Coverage | ~5% | 85%+ | Week 4 |
| Test Speed (unit) | 6.97s | <5s | Week 1 |
| Test Speed (integration) | N/A | <30s | Week 3 |

---

## Critical Path

The fastest way to achieve 85%+ coverage:

1. **Must Have:**
   - TUI tests (pure functions)
   - Orchestration unit tests (core logic)
   - Integration tests for APIs (most impactful)

2. **Nice to Have:**
   - E2E tests (validation)
   - CI/CD (automation)

3. **Can Defer:**
   - 100% coverage of rarely-used code paths
   - Performance optimization

---

## Next Immediate Action

Start with **TUI component tests** since they:
- Are pure functions (no setup needed)
- Have no external dependencies
- Can be completed quickly (1-2 hours)
- Increase coverage immediately

Then move to **Security DB integration tests** which:
- Test real API interactions
- Enable real-world validation
- Have high business value
- Establish integration test pattern

---

**Total Estimated Time:** 40-50 hours over 4 weeks
**Current Status:** 16% complete (643/950 tests)
**Est. Completion:** 4 weeks
