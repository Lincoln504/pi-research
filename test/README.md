# Test Directory Structure

This directory contains all tests for the pi-research extension.

## Directory Layout

```
test/
├── setup/
│   ├── unit.ts              # Unit test setup (no containers)
│   └── integration.ts      # Integration test setup (containers)
├── unit/                   # Unit tests (fast, no external deps)
│   ├── config/
│   ├── utils/
│   ├── stackexchange/
│   ├── security/
│   └── tui/
├── integration/            # Integration tests (slower, uses test containers)
│   ├── web-research/
│   ├── security/
│   ├── stackexchange/
│   └── infrastructure/
├── e2e/                    # End-to-end tests (slowest, full workflows)
│   └── orchestration/
├── helpers/                # Test helpers and utilities
│   ├── test-containers.ts  # Test container helpers
│   ├── assertions.ts       # Custom assertions
│   └── matchers.ts         # Custom matchers
└── types/
    └── vitest.d.ts         # Global test types
```

## Test Categories

### Unit Tests
- **Location**: `test/unit/`
- **Speed**: Fast (milliseconds to seconds)
- **Dependencies**: No external dependencies
- **Purpose**: Test pure functions and isolated logic
- **Run**: `npm run test:unit`

### Integration Tests
- **Location**: `test/integration/`
- **Speed**: Medium (seconds to minutes)
- **Dependencies**: Real Docker containers (testcontainers)
- **Purpose**: Test integration with external services
- **Run**: `npm run test:integration`

### End-to-End Tests
- **Location**: `test/e2e/`
- **Speed**: Slow (minutes)
- **Dependencies**: Full environment setup
- **Purpose**: Test complete workflows
- **Run**: `npm test -- test/e2e`

## Running Tests

```bash
# Run all tests
npm test

# Run only unit tests
npm run test:unit

# Run only integration tests
npm run test:integration

# Watch mode for development
npm run test:watch

# Generate coverage report
npm run test:coverage

# Interactive UI
npm run test:ui
```

## Test Naming Conventions

- Files: `*.test.ts` for unit tests, `*.spec.ts` for specifications
- Describe blocks: Use the module/function name
- It blocks: Use "should" phrasing (e.g., "should return empty string")

Example:
```typescript
describe('moduleName', () => {
  describe('functionName', () => {
    it('should return expected result', () => {
      // Arrange
      const input = 'test';

      // Act
      const result = functionName(input);

      // Assert
      expect(result).toBe('expected');
    });
  });
});
```

## Immediate Wins (No Refactoring Needed)

These modules are 100% testable with current code:

1. ✅ `config.ts` - Configuration validation
2. ✅ `utils/text-utils.ts` - Text utilities
3. ✅ `utils/session-state.ts` - Session state management
4. ✅ `stackexchange/queries.ts` - Query builders
5. ✅ `stackexchange/output/*` - Output formatters
6. ✅ `security/types.ts` - Type guards

## Modules Requiring Refactoring

These modules need interface extraction before testing:

1. ⏳ `logger.ts` - Needs ILogger interface
2. ⏳ `searxng-lifecycle.ts` - Needs ISearxngManager interface
3. ⏳ `web-research/scrapers.ts` - Needs IBrowserManager interface
4. ⏳ `web-research/search.ts` - Needs IHttpClient interface
5. ⏳ `tool.ts` - Needs dependency injection
6. ⏳ `orchestration/delegate-tool.ts` - Needs researcher pool extraction

## Coverage Goals

- Overall: 85%+ statements, 80%+ branches
- Pure functions: 100%
- Integration points: 80%+
- Complex orchestration: 75%+

## Tips for Writing Tests

1. **Start small**: Write one test at a time
2. **Keep it simple**: Focus on happy path first, then edge cases
3. **Use descriptive names**: Tests should read like documentation
4. **Follow AAA**: Arrange, Act, Assert pattern
5. **Avoid logic in tests**: Tests should be declarative
6. **Mock only when necessary**: Prefer test containers for integration

## Troubleshooting

### Tests are timing out
- Increase `testTimeout` in vitest config
- Check for async issues (missing await)
- Verify test container startup

### Module state is leaking between tests
- Add beforeEach cleanup
- Check for singleton patterns
- Reset module state explicitly

### Import errors
- Check path mappings in tsconfig
- Verify Vitest resolve.alias
- Use `@/` alias for src imports
