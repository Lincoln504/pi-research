# Structured Logging Implementation - Phase 2c

## Overview

This document describes the structured logging implementation for pi-research, which addresses the inconsistent logging patterns identified in the investigation phase.

## Implementation Summary

### 1. Created Structured Logger Interface

**File:** `src/utils/structured-logger.ts`

The structured logger provides:
- **ILogger Interface**: Standard logging abstraction for dependency injection
- **Context-Aware Logging**: Automatic component tagging and context propagation
- **Correlation IDs**: Support for request/operation tracking across components
- **Testable**: NoOpLogger and InMemoryLogger implementations for testing
- **Minimal Overhead**: Lazy evaluation and efficient context handling

**Key Features:**
```typescript
// Create a logger with component name
const logger = createStructuredLogger('BrowserManager');

// With correlation ID for request tracking
const logger = createStructuredLogger('Orchestrator', {
  correlationId: generateCorrelationId()
});

// With base context
const logger = createStructuredLogger('SearchTool', {
  sessionId: 'session-123',
  toolName: 'research'
});
```

### 2. Created Migration Guide

**File:** `docs/LOGGING_MIGRATION_GUIDE.md`

A comprehensive guide covering:
- Before/after comparisons
- Step-by-step migration process
- Advanced usage patterns
- Common patterns and conventions
- Testing strategies
- Module-by-module migration plan

### 3. Created Test Suite

**File:** `test/unit/utils/structured-logger.test.ts`

Comprehensive test coverage including:
- Correlation ID generation
- Logger creation with various options
- Context propagation with child loggers
- Operation-scoped logging with `withCorrelationLogger`
- NoOpLogger and InMemoryLogger functionality
- Dependency injection patterns

**All 44 tests passing.**

## Key Improvements

### Before (Old Pattern)

```ts
import { logger } from '../logger.ts';

// Manual prefix, inconsistent formatting
logger.log('[BrowserManager] Browser pool initialized');
logger.error('[BrowserManager] Failed to initialize', err);
logger.warn(`[BrowserManager] Retrying (${attempts}/${maxAttempts})...`);
logger.debug('[BrowserManager] Task completed in', duration, 'ms');
```

### After (New Pattern)

```ts
import { createStructuredLogger } from '../utils/structured-logger.ts';

// Create once at module level
const logger = createStructuredLogger('BrowserManager');

// Consistent formatting, automatic context
logger.info('Browser pool initialized');
logger.error('Failed to initialize', err);
logger.warn('Retrying', { attempts, maxAttempts });
logger.info('Task completed', { durationMs: duration });
```

## Benefits

### 1. **Consistency**
- No more manual `[Component]` prefixes
- Standardized formatting across all modules
- Consistent log level usage (INFO, WARN, ERROR, DEBUG)

### 2. **Testability**
- Injectable ILogger interface
- NoOpLogger for suppressing logs in tests
- InMemoryLogger for asserting log output

### 3. **Structure**
- Machine-readable context data
- Easier log parsing and analysis
- Consistent field naming conventions

### 4. **Traceability**
- Correlation IDs for request tracking
- Context propagation across operations
- Operation-scoped logging with `withCorrelationLogger`

### 5. **Performance**
- Minimal overhead (negligible context object creation)
- Verbose filtering still handled by underlying logger
- Lazy evaluation where appropriate

## Module-by-Module Migration Plan

### Phase 1: Critical Infrastructure (Do First)
1. `src/infrastructure/browser-manager.ts` - HIGH PRIORITY
2. `src/infrastructure/state-manager.ts`
3. `src/core/service-registry.ts`
4. `src/core/health-cache-manager.ts`

### Phase 2: Orchestration
1. `src/orchestration/deep-research-orchestrator.ts`
2. `src/orchestration/quick-research-orchestrator.ts`
3. `src/orchestration/coordinator.ts`

### Phase 3: Tools & Utilities
1. `src/tools/research-tool.ts`
2. `src/utils/metrics.ts`
3. `src/utils/error-tracker.ts`

### Phase 4: Knowledge Store
1. `src/knowledge/index.ts`
2. `src/knowledge/store.ts`
3. `src/knowledge/embedder.ts`

### Phase 5: Commands
1. `src/commands/research-command.ts`
2. `src/commands/health-command.ts`
3. `src/commands/settings-command.ts`

## Field Naming Conventions

| Purpose | Field Name | Example |
|---------|------------|---------|
| Duration | `durationMs` | `{ durationMs: 1234 }` |
| Counts | `resultCount`, `attemptCount` | `{ resultCount: 5 }` |
| IDs | `userId`, `sessionId`, `correlationId` | `{ userId: 'user-123' }` |
| URLs | `url`, `endpoint` | `{ url: 'https://example.com' }` |
| Status | `status`, `statusCode` | `{ status: 'success' }` |
| Boolean | `isEnabled`, `wasSuccessful` | `{ isEnabled: true }` |

## Log Level Guidelines

| Level | When to Use |
|-------|-------------|
| **ERROR** | Errors that prevent normal operation, require attention |
| **WARN** | Unexpected but recoverable situations, potential issues |
| **INFO** | Important operational events, state changes |
| **DEBUG** | Detailed diagnostic information, timing details |

## Example Migration

Before:
```ts
export async function runBrowserSearch(query: string): Promise<SearchResult[]> {
  try {
    logger.debug(`[BrowserManager] Starting search for: ${query}`);
    const results = await browser.search(query);
    logger.log(`[BrowserManager] Found ${results.length} results`);
    return results;
  } catch (err) {
    logger.error(`[BrowserManager] Search failed for ${query}:`, err);
    throw err;
  }
}
```

After:
```ts
const logger = createStructuredLogger('BrowserManager');

export async function runBrowserSearch(query: string): Promise<SearchResult[]> {
  try {
    logger.debug('Starting search', { query });
    const results = await browser.search(query);
    logger.info('Search complete', { resultCount: results.length });
    return results;
  } catch (err) {
    logger.error('Search failed', err, { query });
    throw err;
  }
}
```

## Current Status

### ✅ Completed
- [x] ILogger interface defined
- [x] Context-aware logger factory implemented
- [x] Correlation ID support added
- [x] NoOpLogger for testing
- [x] InMemoryLogger for testing
- [x] Comprehensive test suite (44 tests passing)
- [x] Migration guide documentation

### 🔄 Next Steps
- [ ] Update browser-manager.ts to use structured logging
- [ ] Update state-manager.ts to use structured logging
- [ ] Update other critical infrastructure modules
- [ ] Update orchestration modules
- [ ] Update tools and utilities
- [ ] Update remaining modules incrementally

## Testing

Run the structured logger tests:
```bash
npm test -- test/unit/utils/structured-logger.test.ts
```

All 44 tests passing.

## Backward Compatibility

The structured logger is fully backward compatible:
- The global logger remains unchanged
- Existing code using direct logger imports continues to work
- Migration is incremental - can update modules one at a time
- No breaking changes to the logging infrastructure

## Performance Impact

Negligible performance impact:
- Context object creation is fast
- Verbose filtering still handled by underlying logger
- Lazy evaluation for error tracking
- No additional file I/O overhead

## Questions?

Refer to the migration guide: `docs/LOGGING_MIGRATION_GUIDE.md`

Or consult:
- Type definitions: `src/utils/structured-logger.ts`
- Test examples: `test/unit/utils/structured-logger.test.ts`
- Existing logger: `src/logger.ts`