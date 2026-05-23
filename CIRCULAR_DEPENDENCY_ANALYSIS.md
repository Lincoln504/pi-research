# Circular Dependency Analysis & Resolution

## Date: 2026-05-23
## Phase: 1c - Fix Circularity

---

## Executive Summary

This document provides a comprehensive analysis of circular dependencies found in the pi-research codebase and the architectural solutions implemented to resolve them.

---

## Detected Circular Dependencies

Using `madge` analysis tool, **2 circular dependencies** were detected:

### 1. logger.ts ↔ utils/error-tracker.ts
- **Location:** `src/logger.ts` ↔ `src/utils/error-tracker.ts`
- **Severity:** Medium
- **Impact:** Logger and error tracking are core utilities; this affects the entire application

**Dependency Chain:**
```
logger.ts
  ↓ (lazy import in error() method)
utils/error-tracker.ts
  ↓ (top-level import)
logger.ts  ← CIRCULAR
```

**Current Workaround:**
- Logger uses lazy dynamic import in `error()` method to defer loading error-tracker
- Error-tracker imports logger at the top level
- This breaks the circular dependency at runtime but creates a fragile architecture

### 2. healthcheck/index.ts ↔ knowledge/index.ts
- **Location:** `src/healthcheck/index.ts` ↔ `src/knowledge/index.ts`
- **Severity:** High
- **Impact:** Affects health check system and knowledge store initialization

**Dependency Chain:**
```
healthcheck/index.ts
  ↓ (imports getEmbedder())
knowledge/index.ts
  ↓ (imports clearHealthCheckCache())
healthcheck/index.ts  ← CIRCULAR
```

**Current Workaround:**
- None detected by madge, but the dependency is circular at the module level

---

## Architectural Solutions

### Solution 1: Extract Event Emitter Interface (for logger ↔ error-tracker)

**Approach:** Event-based architecture to break the circular dependency

**Changes:**
1. Create `src/core/interfaces/event-emitter.ts` - Simple event emitter interface
2. Modify `error-tracker.ts` to accept an optional logger via constructor
3. Modify `logger.ts` to use lazy initialization of error-tracker with DI

**Benefits:**
- Clean separation of concerns
- Testability (can mock logger in tests)
- No circular dependency at module level

### Solution 2: Extract Health Cache Management (for healthcheck ↔ knowledge)

**Approach:** Extract shared functionality into a separate module

**Changes:**
1. Create `src/core/health-cache-manager.ts` - Manages health check cache state
2. Modify `healthcheck/index.ts` to delegate cache operations to new module
3. Modify `knowledge/index.ts` to use new module for cache clearing
4. Keep `internal-state.ts` for other internal state that doesn't cause circular dependencies

**Benefits:**
- Single responsibility principle
- Both modules import the same direction (both import cache manager)
- Clear separation of concerns

---

## Detailed Implementation

### Fix 1: logger.ts ↔ utils/error-tracker.ts

#### Step 1.1: Create Error Tracking Interface
```typescript
// src/core/interfaces/error-tracking.ts
export interface IErrorTracking {
  trackError(error: Error | string, context?: ErrorContext): void;
  getReport(): ErrorReport;
  clear(): void;
}
```

#### Step 1.2: Refactor Error Tracker
- Accept optional logger in constructor
- Default to console if no logger provided
- Remove top-level import of logger

#### Step 1.3: Refactor Logger
- Create error tracker lazily
- Pass self as logger to error tracker
- Maintain backward compatibility

### Fix 2: healthcheck/index.ts ↔ knowledge/index.ts

#### Step 2.1: Create Health Cache Manager
```typescript
// src/core/health-cache-manager.ts
export class HealthCacheManager {
  clear(): void;
  // ... other cache management methods
}
```

#### Step 2.2: Update healthcheck/index.ts
- Import and use HealthCacheManager
- Delegate cache operations to manager
- Remove direct knowledge import for cache clearing

#### Step 2.3: Update knowledge/index.ts
- Import HealthCacheManager instead of healthcheck/index.ts
- Use manager for cache clearing

---

## Testing Strategy

### Unit Tests
1. Test error tracker with and without logger
2. Test health cache manager in isolation
3. Test logger with mocked error tracker

### Integration Tests
1. Verify health check system still works
2. Verify knowledge store initialization works
3. Verify error tracking works end-to-end

### Regression Tests
1. Run all existing tests
2. Verify no functionality is broken
3. Test error handling paths

---

## Verification

After fixes are applied:
1. Run `npx madge --circular --extensions ts src/` - should report 0 circular dependencies
2. Run all unit tests - should all pass
3. Run integration tests - should all pass
4. Manual testing of health checks and knowledge store

---

## Remaining Workarounds

### internal-state.ts
The `internal-state.ts` module was created to handle internal state management without circular dependencies. After these fixes:
- **Keep:** Scheduler state management (doesn't cause circular dependencies)
- **Keep:** Health check backoff state (doesn't cause circular dependencies)
- **Remove:** Health check cache management (moved to dedicated module)

---

## Recommendations for Preventing Future Circular Dependencies

1. **Architecture Guidelines:**
   - Use dependency injection for cross-cutting concerns
   - Prefer event-driven communication over direct imports
   - Extract shared interfaces to separate modules

2. **Code Review Checklist:**
   - [ ] Check import graph before merging
   - [ ] Use `madge` in CI pipeline
   - [ ] Document dependency relationships

3. **Tooling:**
   - Add circular dependency check to CI/CD pipeline
   - Use ESLint rule to detect suspicious imports
   - Consider using dependency injection framework

4. **Module Organization:**
   - Organize modules by layer (infrastructure, domain, application)
   - Enforce unidirectional dependencies (domain → infrastructure)
   - Use barrel exports carefully

---

## Files Modified

### Created
- `src/core/interfaces/error-tracking.ts` - Error tracking interface
- `src/core/health-cache-manager.ts` - Health cache management

### Modified
- `src/logger.ts` - Refactor error tracking with DI
- `src/utils/error-tracker.ts` - Accept optional logger in constructor
- `src/healthcheck/index.ts` - Use health cache manager
- `src/knowledge/index.ts` - Use health cache manager

### Updated
- `src/core/internal-state.ts` - Remove health cache state (moved to dedicated module)

---

## Conclusion

By implementing these architectural solutions, we eliminate all circular dependencies in the codebase while maintaining functionality and improving testability. The solutions follow SOLID principles and establish patterns for preventing future circular dependencies.

---

## Next Steps

1. Implement the fixes described above
2. Run circular dependency analysis to verify fixes
3. Run all tests to ensure no regressions
4. Update documentation
5. Add circular dependency check to CI/CD