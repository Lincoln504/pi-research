# Quick Start: Testing Infrastructure Setup

This guide walks you through setting up the testing infrastructure for pi-research.

## Step 1: Install Test Dependencies

```bash
npm install --save-dev vitest @vitest/ui @vitest/coverage-v8 testcontainers
```

## Step 2: Update package.json

Add these scripts to your `package.json`:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:unit": "vitest run --config vitest.config.unit.ts",
    "test:integration": "vitest run --config vitest.config.integration.ts",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:ui": "vitest --ui"
  }
}
```

## Step 3: Create Vitest Config Files

I'll create the main config files now.

---

## Immediate Quick Wins (No Refactoring Needed)

You can start writing tests TODAY for these modules:

### 1. Config Module (100% Testable Right Now)
```bash
# Create this test file immediately
test/unit/config.test.ts
```

### 2. Text Utils (100% Testable Right Now)
```bash
# Create this test file immediately
test/unit/utils/text-utils.test.ts
```

### 3. Session State (100% Testable Right Now)
```bash
# Create this test file immediately
test/unit/utils/session-state.test.ts
```

### 4. Stack Exchange Queries (100% Testable Right Now)
```bash
# Create this test files immediately
test/unit/stackexchange/queries.test.ts
test/unit/stackexchange/output/compact.test.ts
test/unit/stackexchange/output/table.test.ts
test/unit/stackexchange/output/json.test.ts
```

### 5. Stack Exchange Types (100% Testable Right Now)
```bash
# Create this test file immediately
test/unit/security/types.test.ts
```

### 6. TUI Render Functions (90% Testable Right Now)
```bash
# Create this test file immediately
test/unit/tui/research-panel.test.ts
```

---

## Running Your First Test

After setup, run:

```bash
# Run all tests
npm test

# Run only unit tests
npm run test:unit

# Run with coverage
npm run test:coverage

# Watch mode for development
npm run test:watch
```

---

## Test File Template

Here's a template for new test files:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';

describe('module-name', () => {
  beforeEach(() => {
    // Reset state before each test
  });

  describe('function-name', () => {
    it('should do something', () => {
      // Arrange
      const input = 'test';

      // Act
      const result = yourFunction(input);

      // Assert
      expect(result).toBe('expected');
    });
  });
});
```

---

## Next Steps

1. ✅ Install dependencies (Step 1)
2. ✅ Update package.json (Step 2)
3. ✅ Create vitest configs (Step 3)
4. ✅ Write tests for pure functions (immediate wins)
5. ⏳ Refactor modules with dependencies
6. ⏳ Write integration tests with test containers
7. ⏳ Set up CI/CD coverage reporting

---

## What to Do First?

**Today (Day 1):**
1. Install test dependencies
2. Create vitest config files
3. Write 5-10 unit tests for pure functions

**This Week (Days 2-5):**
1. Cover all pure function modules with tests
2. Achieve 80%+ coverage on utils, config, stackexchange
3. Start interface extraction for dependent modules

**Next Week (Days 6-10):**
1. Refactor core modules (logger, lifecycle)
2. Write integration tests with test containers
3. Set up CI/CD pipeline

---

## Getting Help

- Refer to `TESTABILITY_PLAN.md` for complete details
- Check `test/examples/` for sample tests
- Run `npm run test:ui` for interactive test runner
