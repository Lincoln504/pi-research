# Testing Guide

This guide covers testing practices for pi-research, including unit tests, integration tests, and load tests.

## Table of Contents

- [Test Structure](#test-structure)
- [Running Tests](#running-tests)
- [Writing Tests](#writing-tests)
- [Test Coverage](#test-coverage)
- [Best Practices](#best-practices)

---

## Test Structure

### Directory Layout

```
test/
├── unit/           # Unit tests
├── integration/    # Integration tests
└── load/           # Load tests

config/tooling/
├── vitest.config.unit.ts          # Unit test config
├── vitest.config.integration.ts   # Integration test config
└── vitest.config.load.ts          # Load test config
```

### Test Categories

**Unit Tests (`test/unit/`)**
- Test individual functions and classes
- Mock external dependencies
- Fast execution (seconds)
- Example: `knowledge-store.test.ts`

**Integration Tests (`test/integration/`)**
- Test component interactions
- Use real infrastructure (browser, knowledge store)
- Slower execution (minutes)
- Example: `orchestration.test.ts`

**Load Tests (`test/load/`)**
- Test system under load
- Validate resource limits
- Long-running (hours)
- Example: `concurrent-research.test.ts`

---

## Running Tests

### Unit Tests

Run all unit tests:

```bash
npm run test:unit
```

Run specific test file:

```bash
npm run test:unit knowledge-store.test.ts
```

Run in watch mode:

```bash
npm run test:watch
```

### Integration Tests

Run all integration tests:

```bash
npm run test:integration
```

**Note:** Integration tests require browser infrastructure and network access.

### Load Tests

Run all load tests:

```bash
npm run test:load
```

**Note:** Load tests can take hours to complete.

### All Tests

Run all test suites:

```bash
npm test
```

### Coverage Report

Generate coverage report:

```bash
npm run test:coverage
```

Coverage report is generated in `coverage/` directory.

---

## Writing Tests

### Test Framework

pi-research uses **Vitest** as the test framework.

### Basic Test Structure

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KnowledgeStore } from '@src/knowledge/index';

describe('KnowledgeStore', () => {
  let store: KnowledgeStore;

  beforeEach(async () => {
    // Setup before each test
    store = new KnowledgeStore({ dbPath: ':memory:' });
    await store.initialize();
  });

  afterEach(async () => {
    // Cleanup after each test
    await store.close();
  });

  it('should embed text and return vector', async () => {
    // Arrange
    const text = 'Sample text for embedding';

    // Act
    const vector = await store.embed(text);

    // Assert
    expect(vector).toBeDefined();
    expect(vector).toHaveLength(384);
    expect(vector[0]).toBeTypeOf('number');
  });
});
```

### Testing Async Operations

```typescript
it('should handle async operations', async () => {
  const result = await asyncOperation();
  expect(result).toBe(expected);
});
```

### Mocking External Dependencies

```typescript
import { vi } from 'vitest';

it('should use mocked dependency', async () => {
  // Mock external dependency
  const mockFn = vi.fn().mockResolvedValue('mocked result');

  // Use mock in test
  const result = await functionUsingMock(mockFn);

  // Assert mock was called
  expect(mockFn).toHaveBeenCalled();
  expect(result).toBe('mocked result');
});
```

### Testing Error Conditions

```typescript
it('should throw on invalid input', async () => {
  await expect(
    store.embed('')  // Empty input
  ).rejects.toThrow('Input cannot be empty');
});

it('should handle network errors', async () => {
  // Mock network failure
  vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));

  await expect(
    someNetworkOperation()
  ).rejects.toThrow('Network error');
});
```

### Testing with Fixtures

```typescript
const testTexts = [
  'Short text',
  'Medium length text for testing',
  'Much longer text with more content for testing purposes'
];

test.each(testTexts)('should embed: %s', async (text) => {
  const vector = await store.embed(text);
  expect(vector).toHaveLength(384);
});
```

---

## Test Coverage

### Coverage Goals

- **Overall:** >80%
- **Core modules:** >90%
- **Critical paths:** 100%

### Current Coverage

```bash
npm run test:coverage
```

Current status: **943 tests passing** with >80% coverage.

### Viewing Coverage

```bash
# Generate coverage report
npm run test:coverage

# View HTML report
open coverage/index.html  # macOS
xdg-open coverage/index.html  # Linux
start coverage/index.html  # Windows
```

---

## Best Practices

### 1. Test Behavior, Not Implementation

**Good:**
```typescript
it('should return search results', async () => {
  const results = await store.search('query');
  expect(results).toBeDefined();
  expect(results.length).toBeGreaterThan(0);
});
```

**Bad:**
```typescript
it('should call LanceDB search', async () => {
  // Tests implementation, not behavior
  expect(lanceDB.search).toHaveBeenCalled();
});
```

### 2. Use Descriptive Test Names

**Good:**
```typescript
it('should return empty array when no results match threshold');
it('should throw error when embedding model is not loaded');
```

**Bad:**
```typescript
it('works');
it('test search');
it('should work properly');
```

### 3. Follow AAA Pattern

```typescript
it('should add and retrieve content', async () => {
  // Arrange
  const text = 'Sample content';
  const metadata = { source: 'test' };

  // Act
  await store.add(text, metadata);
  const results = await store.search('content');

  // Assert
  expect(results).toHaveLength(1);
  expect(results[0].text).toBe(text);
});
```

### 4. Test Edge Cases

```typescript
describe('edge cases', () => {
  it('should handle empty input');
  it('should handle very long input');
  it('should handle special characters');
  it('should handle unicode characters');
  it('should handle concurrent operations');
});
```

### 5. Isolate Tests

```typescript
// Each test should be independent
it('should work independently', async () => {
  // Don't rely on previous test state
  // Setup and cleanup in beforeEach/afterEach
});
```

### 6. Use Appropriate Test Type

```typescript
// Unit test: Fast, isolated
it('should calculate score correctly', () => {
  const result = calculateScore(0.8);
  expect(result).toBeGreaterThan(0.7);
});

// Integration test: Slower, real components
it('should perform full research cycle', async () => {
  // Real browser, real network
  const result = await runResearch({ query: 'test', depth: 0 });
  expect(result.output).toBeDefined();
});

// Load test: Slow, stress testing
it('should handle 10 concurrent researchers', async () => {
  // Simulate real load
  const results = await Promise.all([
    runResearch({ query: 'test1' }),
    runResearch({ query: 'test2' }),
    // ... more
  ]);
  expect(results).toHaveLength(10);
});
```

### 7. Mock External Services

```typescript
// Don't make real network calls in unit tests
it('should fetch data from API', async () => {
  const mockData = { results: ['item1', 'item2'] };
  vi.spyOn(global, 'fetch').mockResolvedValue({
    json: async () => mockData
  } as Response);

  const result = await fetchData();
  expect(result).toEqual(mockData);
});
```

### 8. Clean Up Resources

```typescript
describe('with cleanup', () => {
  let store: KnowledgeStore;

  beforeEach(async () => {
    store = new KnowledgeStore();
    await store.initialize();
  });

  afterEach(async () => {
    // Always clean up
    await store.close();
  });

  it('should work correctly', async () => {
    // Test code here
  });
});
```

---

## Common Test Patterns

### Testing Async Iterators

```typescript
it('should consume async iterator', async () => {
  const asyncIterator = createAsyncIterator();
  const results = [];

  for await (const item of asyncIterator) {
    results.push(item);
  }

  expect(results).toHaveLength(expectedCount);
});
```

### Testing Event Emitters

```typescript
it('should emit events', async () => {
  const emitter = new EventEmitter();
  const eventPromise = new Promise((resolve) => {
    emitter.once('test', resolve);
  });

  emitter.emit('test', 'data');
  await expect(eventPromise).resolves.toBe('data');
});
```

### Testing Timeouts

```typescript
it('should timeout after specified time', async () => {
  const start = Date.now();
  await expect(
    longRunningOperation()
  ).rejects.toThrow('Timeout');

  const duration = Date.now() - start;
  expect(duration).toBeLessThan(timeout + 1000); // Some tolerance
});
```

### Testing Retry Logic

```typescript
it('should retry on failure', async () => {
  let attempts = 0;
  const mockFn = vi.fn()
    .mockImplementationOnce(() => { throw new Error('Fail'); })
    .mockImplementationOnce(() => { throw new Error('Fail'); })
    .mockResolvedValue('Success');

  const result = await retryOperation(mockFn, 3);

  expect(mockFn).toHaveBeenCalledTimes(3);
  expect(result).toBe('Success');
});
```

---

## Troubleshooting Tests

### Tests Timeout

**Issue:** Tests timeout or hang

**Solutions:**
```bash
# Increase timeout in test config
# vitest.config.unit.ts
export default defineConfig({
  testTimeout: 10000  // 10 seconds
});

# Or in specific test
it('should complete', async () => {
  // Increase timeout for this test only
}, { timeout: 30000 });
```

### Tests Fail Intermittently

**Issue:** Tests sometimes pass, sometimes fail

**Solutions:**
```bash
# Add delays for async operations
await new Promise(resolve => setTimeout(resolve, 100));

# Use retry
it('should work', { retry: 3 }, async () => {
  // Test that may fail intermittently
});
```

### Tests Use Real Resources

**Issue:** Tests make real network calls or use real browser

**Solutions:**
```bash
# Mock network calls
vi.spyOn(global, 'fetch').mockResolvedValue(/* ... */);

# Mock browser
vi.mock('@src/infrastructure/browser-manager', () => ({
  createBrowser: vi.fn()
}));
```

---

## Related

- [Deployment Guide](./deployment.md)
- [Contributing Guide](../development/contributing.md)
- [Architecture Overview](../architecture/overview.md)

---

**Last Updated:** 2026-05-23