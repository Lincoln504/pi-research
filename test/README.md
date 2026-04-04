# Test Directory Structure

This directory contains all tests for the pi-research extension.

## Directory Layout

```
test/
├── setup/
│   └── unit.ts              # Unit test setup (resets module state, suppresses console)
├── unit/                   # Unit tests (fast, no external dependencies)
│   ├── config/
│   ├── utils/
│   ├── stackexchange/
│   ├── security/
│   ├── tui/
│   ├── infrastructure/
│   ├── orchestration/
│   └── web-research/
└── helpers/                # Test helpers and utilities
    └── testcontainers.ts  # Test container helpers (for future integration tests)
```

## Test Categories

### Unit Tests
- **Location**: `test/unit/`
- **Speed**: Fast (milliseconds to seconds)
- **Dependencies**: No external dependencies
- **Purpose**: Test pure functions, interfaces, and isolated logic
- **Run**: `npm run test:unit`

### Integration Tests (Planned)
- **Location**: `test/integration/` (not yet created)
- **Speed**: Medium (seconds to minutes)
- **Dependencies**: Real Docker containers (testcontainers)
- **Purpose**: Test integration with external services (SearXNG, NVD, OSV, etc.)
- **Status**: Not yet implemented

### End-to-End Tests (Planned)
- **Location**: `test/e2e/` (not yet created)
- **Speed**: Slow (minutes)
- **Dependencies**: Full environment setup
- **Purpose**: Test complete research workflows
- **Status**: Not yet implemented

## Running Tests

```bash
# Run all unit tests
npm run test:unit

# Run all tests (currently just unit tests)
npm test

# Watch mode for development
npm run test:watch

# Generate coverage report
npm run test:coverage

# Interactive UI
npm run test:ui
```

**Note**: Integration tests (`npm run test:integration`) are configured but not yet implemented.

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

## Well-Tested Modules (100% or near-complete coverage)

The following modules have excellent test coverage:

1. ✅ `config.ts` - Configuration validation and factory pattern
2. ✅ `logger.ts` - Logger implementation and dependency injection
3. ✅ `utils/text-utils.ts` - Text utilities
4. ✅ `utils/session-state.ts` - Session state management
5. ✅ `stackexchange/queries.ts` - Query builders
6. ✅ `stackexchange/output/*` - Output formatters (compact, json, table)
7. ✅ `security/types.ts` - Type guards and validation
8. ✅ `searxng-lifecycle.ts` - Lifecycle manager with DI
9. ✅ `infrastructure/state-manager.ts` - State management
10. ✅ `infrastructure/network-manager.ts` - Network management
11. ✅ `web-research/types.ts` - Type definitions
12. ✅ `web-research/retry-utils.ts` - Retry logic
13. ✅ `web-research/utils.ts` - Web research utilities
14. ✅ `orchestration/session-context.ts` - Session context management
15. ✅ `utils/shared-links.ts` - Shared link pool management
16. ✅ `utils/tool-usage-tracker.ts` - Token usage tracking
17. ✅ `tui/*` - TUI components

## Modules Requiring Tests (Priority Order)

The following modules need test coverage:

**CRITICAL (Core Orchestration)**:
1. ❌ `orchestration/coordinator.ts` - Main coordination logic, complexity assessment
2. ❌ `orchestration/delegate-tool.ts` - Research delegation, token tracking
3. ❌ `orchestration/researcher.ts` - Research agent session management
4. ❌ `orchestration/context-tool.ts` - Context inspection tool

**CRITICAL (Main Entry Point)**:
5. ❌ `tool.ts` - Main research orchestration entry point

**HIGH (Tool Implementations)**:
6. ❌ `tools/search.ts` - Web search implementation
7. ❌ `tools/scrape.ts` - URL scraping implementation
8. ❌ `tools/security.ts` - Security database queries
9. ❌ `tools/stackexchange.ts` - Stack Exchange API
10. ❌ `tools/grep.ts` - Code search

**MEDIUM (Integration Points)**:
11. ❌ `web-research/scrapers.ts` - Browser automation (738 lines, needs interface extraction)
12. ❌ `web-research/search.ts` - Search implementation (needs IHttpClient interface)

## Coverage Goals

- Overall: 85%+ statements, 80%+ branches
- Pure functions: 100%
- Core orchestration: 80%+ (currently 0%)
- Tool implementations: 75%+ (currently 0%)
- Integration points: 80%+
- Complex orchestration: 75%+

## Tips for Writing Tests

1. **Start small**: Write one test at a time
2. **Keep it simple**: Focus on happy path first, then edge cases
3. **Use descriptive names**: Tests should read like documentation
4. **Follow AAA**: Arrange, Act, Assert pattern
5. **Avoid logic in tests**: Tests should be declarative
6. **Mock only when necessary**: Prefer real implementations over mocks
7. **Test error conditions**: Don't just test happy paths
8. **Clean up state**: Use beforeEach/afterEach to reset state

## Testing Strategy

### Unit Testing

- Test pure functions with real implementations (no mocks needed)
- Test class methods with dependency injection (mock interfaces, not implementations)
- Test error handling and edge cases
- Reset module state between tests

### Integration Testing (Planned)

- Use testcontainers for real Docker containers
- Test actual HTTP requests to external services
- Test container lifecycle (start/stop/restart)
- Test error recovery and retry logic

### End-to-End Testing (Planned)

- Test complete research workflows
- Test coordinator → researchers → synthesis pipeline
- Test TUI integration
- Test session lifecycle

## Troubleshooting

### Tests are timing out
- Increase `testTimeout` in vitest config
- Check for async issues (missing await)
- Verify proper cleanup in afterEach

### Module state is leaking between tests
- Add beforeEach cleanup
- Check for singleton patterns
- Reset module state explicitly using reset functions

### Import errors
- Check path mappings in tsconfig
- Verify Vitest resolve.alias
- Use `@/` alias for src imports, `@test/` for test imports

### Coverage is low
- Add tests for critical modules (see "Modules Requiring Tests" above)
- Focus on code paths, not just function count
- Test error conditions and edge cases

## Future Improvements

1. **Add real integration tests** for external service integration
2. **Add end-to-end tests** for complete research workflows
3. **Increase coverage** of core orchestration modules from 0% to 80%+
4. **Add performance tests** for token usage and timeout handling
5. **Add contract tests** for tool interfaces
