# Priority Fix Plan - Pi-Research Audit Findings

**Generated**: 2026-04-04
**Based on**: AUDIT_REPORT.md

---

## Phase 1: CRITICAL (Do This First - Estimated 2-4 hours)

### 1.1 Fix Missing vitest Dependency ⚡ 5 minutes

**Why**: Tests cannot run at all without this

**Steps**:
```bash
# Add vitest packages
npm install --save-dev vitest @vitest/coverage-v8

# Verify tests now work
npm run test:unit
```

**Expected Result**: Tests can run and pass

---

### 1.2 Create Tests for Coordinator ⚡ 2-3 hours

**Why**: Core orchestration logic is completely untested

**File**: `src/orchestration/coordinator.ts`

**Test Strategy**:
1. Mock the subagent spawn/call mechanism
2. Test slice delegation logic
3. Test complexity level assessment
4. Test follow-up iteration decisions
5. Test synthesis logic
6. Test error handling and recovery

**Example Test Structure**:
```typescript
describe('Coordinator', () => {
  describe('delegation', () => {
    it('should delegate Level 1 query as 1-2 slices', async () => {
      // Test complexity assessment and slice allocation
    });

    it('should delegate Level 2 query as 3-5 slices', async () => {
      // Test medium complexity delegation
    });

    it('should handle follow-up iteration on existing slice', async () => {
      // Test iterateOn parameter
    });
  });

  describe('error handling', () => {
    it('should continue if some researchers fail', async () => {
      // Test partial failure resilience
    });

    it('should stop if 2+ researchers return ERROR:', async () => {
      // Test systemic failure detection
    });
  });
});
```

**Create**: `test/unit/orchestration/coordinator.test.ts`

---

### 1.3 Create Tests for Delegate Tool ⚡ 1-2 hours

**Why**: Critical for spawning and managing researchers

**File**: `src/orchestration/delegate-tool.ts`

**Test Strategy**:
1. Test parallel researcher spawning
2. Test sequential execution mode
3. Test timeout handling
4. Test token tracking
5. Test result aggregation

**Create**: `test/unit/orchestration/delegate-tool.test.ts`

---

### 1.4 Create Tests for Researcher ⚡ 1-2 hours

**Why**: Manages researcher agent sessions

**File**: `src/orchestration/researcher.ts`

**Test Strategy**:
1. Test researcher session initialization
2. Test tool availability verification
3. Test session cleanup
4. Test timeout enforcement

**Create**: `test/unit/orchestration/researcher.test.ts`

---

### 1.5 Create Tests for Main Tool ⚡ 1 hour

**Why**: Entry point for all research functionality

**File**: `src/tool.ts`

**Test Strategy**:
1. Test research workflow initiation
2. Test TUI panel integration
3. Test session context setup
4. Test cleanup on completion/error

**Create**: `test/unit/tool.test.ts`

---

## Phase 2: HIGH (Do This Next - Estimated 4-6 hours)

### 2.1 Write Real Integration Tests ⚡ 2-3 hours

**Why**: Current "integration" tests are fake

**Decision Point**: Choose one approach:

**Option A: Real Integration Tests** (Recommended)
- Use testcontainers to spin up real services
- Test actual API interactions
- Test SearXNG container management
- Test actual HTTP requests to mock services

**Example Structure**:
```typescript
// test/integration/searxng/manager-integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestContainerManager } from '../helpers/testcontainers.js';
import { DockerSearxngManager } from '../../../src/infrastructure/searxng-manager.js';

describe('SearXNG Manager Integration', () => {
  let containerManager: TestContainerManager;
  let manager: DockerSearxngManager;

  beforeAll(async () => {
    containerManager = new TestContainerManager();
    // Start real SearXNG container
    await containerManager.startContainer('searxng', 'searxng/searxng:latest', {
      port: 8080
    });

    const url = containerManager.getContainerUrl('searxng', 8080);
    manager = new DockerSearxngManager('/tmp/test', { settingsPath: '/dev/null' });
  }, 60000);

  afterAll(async () => {
    await containerManager.stopAllContainers();
  });

  it('should perform actual search query', async () => {
    const results = await manager.search('test query');
    expect(results).toBeDefined();
    expect(results.length).toBeGreaterThan(0);
  });
});
```

**Option B: Reclassify as Unit Tests**
- Move all test/integration/* to test/unit/*
- Update test/README.md to reflect no integration tests
- Remove testcontainers dependency

**Recommendation**: Option A - provides real value

---

### 2.2 Create Tests for Tool Implementations ⚡ 2-3 hours

**Files to Test**:
- `src/tools/search.ts`
- `src/tools/scrape.ts`
- `src/tools/security.ts`
- `src/tools/stackexchange.ts`
- `src/tools/grep.ts`

**Test Strategy**:
1. Mock HTTP client for search.ts and security.ts
2. Mock browser/scrapers for scrape.ts
3. Mock Stack Exchange API for stackexchange.ts
4. Use real process.spawn for grep.ts (integration-style)

**Create**:
- `test/unit/tools/search.test.ts`
- `test/unit/tools/scrape.test.ts`
- `test/unit/tools/security.test.ts`
- `test/unit/tools/stackexchange.test.ts`
- `test/unit/tools/grep.test.ts`

---

### 2.3 Fix Documentation ⚡ 30 minutes

**Files to Update**:
1. `test/README.md`:
   - Remove e2e/ directory reference (doesn't exist)
   - Update integration test description to be honest
   - Remove "Immediate Wins" outdated section
   - Remove references to non-existent assertions.ts and matchers.ts

2. `CONTRIBUTING.md`:
   - Add note about installing vitest first
   - Update test running instructions

---

## Phase 3: MEDIUM (Nice to Have - Estimated 2-3 hours)

### 3.1 Code Quality Improvements ⚡ 30 minutes

1. Remove duplicate comments in `src/logger.ts` (lines 38-40)
2. Extract interfaces for:
   - `src/web-research/scrapers.ts` - IBrowserManager
   - `src/web-research/search.ts` - IHttpClient
   - Tool implementations for consistency

---

### 3.2 Remove Trivial Tests ⚡ 1 hour

**Tests to Remove or Consolidate**:

```typescript
// These just test JavaScript built-ins - remove or consolidate
// test/integration/orchestration/research-workflow.test.ts

it('should accumulate tokens from researchers', async () => {
  // Just tests array.reduce - remove
});

it('should track pagination state', async () => {
  // Just tests math - remove
});

it('should handle rate limit delays', async () => {
  // Just tests multiplication - remove
});
```

**Replace With**: Tests that actually test business logic

---

### 3.3 Create E2E Tests or Update Docs ⚡ 1-2 hours

**Option A**: Create `test/e2e/` directory with real end-to-end tests
- Test complete research workflow
- Test coordinator → researchers → synthesis pipeline
- Use testcontainers for full environment

**Option B**: Remove e2e section from test/README.md
- Be honest about test coverage
- Plan to add later

---

## Phase 4: LONG-TERM (Future Improvements)

### 4.1 Coverage Goals

**Target**: 80%+ statement coverage for core modules

**Priority Order**:
1. orchestration/coordinator.ts - 80%+
2. orchestration/delegate-tool.ts - 80%+
3. orchestration/researcher.ts - 80%+
4. tool.ts - 80%+
5. tools/*.ts - 70%+
6. web-research/*.ts - 70%+

### 4.2 CI/CD Improvements

1. Add coverage reporting to GitHub Actions
2. Add coverage badges to README
3. Set coverage thresholds (fail if below 70%)
4. Add test execution time monitoring

### 4.3 Pre-commit Hooks

```bash
# .husky/pre-commit
npm run type-check
npm run lint
npm run test:unit
```

### 4.4 Missing Test Helpers

Either create or remove from docs:
- `test/helpers/assertions.ts` - Custom test assertions
- `test/helpers/matchers.ts` - Custom Vitest matchers

---

## Quick Reference Commands

### After Installing vitest

```bash
# Run all unit tests
npm run test:unit

# Run all tests (currently just unit)
npm test

# Run with coverage
npm run test:coverage

# Watch mode for development
npm run test:watch

# Interactive UI
npm run test:ui
```

### Creating New Tests

```bash
# Unit test template
# test/unit/[module-name].test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { functionToTest } from '../../src/[module].js';

describe('[Module Name]', () => {
  beforeEach(() => {
    // Setup
  });

  afterEach(() => {
    // Cleanup
  });

  describe('functionName', () => {
    it('should do something', () => {
      // Arrange
      const input = 'test';

      // Act
      const result = functionToTest(input);

      // Assert
      expect(result).toBe('expected');
    });
  });
});
```

---

## Summary

| Phase | Tasks | Time Estimate | Priority |
|-------|-------|---------------|----------|
| 1: CRITICAL | 5 tasks | 2-4 hours | 🔴 Blocking |
| 2: HIGH | 3 tasks | 4-6 hours | 🟡 Important |
| 3: MEDIUM | 3 tasks | 2-3 hours | 🟢 Nice to have |
| 4: LONG-TERM | 4 tasks | Ongoing | 🔵 Future |
| **Total** | **15 tasks** | **8-13 hours** | |

**First Action**: Install vitest - 5 minutes
**End Goal**: Tests run, core modules covered, documentation accurate
