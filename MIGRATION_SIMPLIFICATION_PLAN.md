# Knowledge Store Migration System - Simplification Plan

## Current State Analysis

### Complexity Overview

**Files:**
- `src/knowledge/migration.ts`: 16 lines (type definitions only)
- `src/knowledge/store.ts`: 741 lines total (~350 lines migration-specific)
- `src/knowledge/index.ts`: 390 lines (~15 lines migration-specific)

**Total migration code: ~380 lines**

### The 4 Current Migration Strategies

1. **'drop'** - Delete and recreate table (data loss)
   - Simple, reliable
   - Used for dimension mismatches
   - Default strategy

2. **'re-embed'** - Preserve data, re-embed with new model
   - Complex temp table approach
   - Batch processing with progress logging
   - Handles dimension changes
   - ~120 lines of code

3. **'continue'** - Mix old and new embeddings
   - Problematic: different vectors in same space
   - Poor search quality
   - Only ~25 lines but creates user confusion

4. **'error'** - Throw error, require manual intervention
   - No implementation (just throws in switch)
   - User unfriendly
   - Redundant with configuration

### Over-Engineering Issues

#### 1. Excessive Strategy Count (4 → 2)
- **'continue' is dangerous**: Different models produce incompatible vector spaces
- **'error' is redundant**: Users can configure desired strategy via env var
- **Real needs**: Drop when incompatible, preserve when possible

#### 2. Complex Dimension Tracking
- Hardcoded dimensions for 9 models in `getModelDimension()`
- Throws error for unknown models (blocks new models)
- Model compatibility checking adds unnecessary complexity
- LanceDB handles dimension mismatch automatically

#### 3. Complex Version Management
- Uses dimension comparison for compatibility
- Detailed `ModelCompatibility` interface with oldDimension/newDimension
- Special Uint8Array decoding for metadata
- Overkill for local research tool cache

#### 4. Complex Re-Embed Implementation
- Temp table with timestamp-based naming
- Batch processing (100 docs per batch)
- Progress logging every 500 docs
- Complex error handling with cleanup
- Can be simplified significantly

### What the Tests Actually Need

From `test/unit/knowledge/store.test.ts`:
- ✅ Test model change detection (lines 295-322)
- ✅ Test re-embed strategy (lines 324-371)
- ✅ Test document preservation across migrations
- ❌ No tests for 'continue' strategy
- ❌ No tests for 'error' strategy
- ❌ No tests for dimension compatibility checking

**Conclusion**: Only 'drop' and 're-embed' are actually tested and used.

## Simplification Design

### Target Architecture

**2 Core Strategies:**
1. **'drop'** - Simple table recreation
2. **'re-embed'** - Simplified data preservation

**Simplified Version Detection:**
- Compare model strings directly (no dimension checking)
- LanceDB schema metadata stores model name
- Simple string comparison is sufficient

**Simplified Re-Embed:**
- No temp table (LanceDB drop/create is fast)
- Simple loop with smaller batches
- Reduced error handling complexity
- Progress logging simplified

### Migration Logic Flow

```
On store.open():
  1. Check if table exists
  2. If yes, read metadata.model from schema
  3. If model != currentModel:
     a. Get strategy from config or default to 'drop'
     b. Execute 'drop' or 're-embed'
  4. Store new model name in schema metadata
```

### Simplified Re-Embed Algorithm

```typescript
async migrationReEmbed(newModel: string): Promise<void> {
  // 1. Read all documents from old table
  const docs = await table.query().toArray();

  // 2. Drop old table and create new one
  await db.dropTable(tableName);
  table = await createTable();

  // 3. Re-embed and insert in batches
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize);
    const texts = batch.map(d => d.text);
    const vectors = await embedder.embedMany(texts);
    const records = batch.map((doc, idx) => ({...doc, vector: vectors[idx]}));
    await table.add(records);
  }
}
```

### Code Reduction Targets

| Component | Current | Target | Reduction |
|-----------|---------|--------|-----------|
| migration.ts | 16 lines | 15 lines | 1 line |
| store.ts migration code | ~350 lines | ~120 lines | 230 lines (66%) |
| index.ts migration code | ~15 lines | 10 lines | 5 lines (33%) |
| **Total** | **~380 lines** | **~145 lines** | **235 lines (62%)** |

## Implementation Plan

### Phase 1: Analysis & Documentation ✅
- Document current complexity
- Identify simplification opportunities
- Create this design doc

### Phase 2: Simplify Type Definitions
- Remove `ModelCompatibility` interface
- Remove `oldDimension`/`newDimension` from types
- Keep `MigrationStrategy` ('drop' | 're-embed')
- Keep `MigrationResult` (simplified)

### Phase 3: Rewrite Migration Logic in store.ts
- Remove `getModelDimension()` method
- Remove `checkModelCompatibility()` method
- Simplify `getRecommendedMigrationStrategy()` (default to 'drop')
- Remove `migrationContinue()` method
- Simplify `migrationReEmbed()` (no temp table)
- Keep `migrationDrop()` (already simple)
- Simplify `handleModelChange()` (only 2 cases)

### Phase 4: Update Orchestration
- Simplify `getMigrationStrategy()` in index.ts
- Remove 'continue' and 'error' from env var validation
- Update default behavior

### Phase 5: Update Tests
- Keep existing 'drop' and 're-embed' tests
- Update imports if needed
- Verify all tests pass

### Phase 6: Migration Path for Existing Users
- Old metadata format still readable
- New code handles both formats
- Automatic migration on next open
- No user action required

## Migration Path Details

### Backward Compatibility

**Old Metadata Format:**
```typescript
schema.metadata.get('embedding_model') // string
```

**New Metadata Format:**
```typescript
schema.metadata.get('embedding_model') // string (same)
```

**Compatibility:**
- Format is identical (string model name)
- No changes needed
- Existing stores work transparently

### User Migration Scenarios

**Scenario 1: User never changed models**
- No action needed
- Store opens normally

**Scenario 2: User wants to change models (default behavior)**
- Current: Drops cache, rebuilds with new model
- New: Same behavior (simpler implementation)
- Result: Same user experience

**Scenario 3: User has `PI_KNOWLEDGE_STORE_MIGRATION_STRATEGY=re-embed`**
- Current: Re-embeds with complex temp table logic
- New: Re-embeds with simplified logic
- Result: Same data preserved, cleaner implementation

**Scenario 4: User has `PI_KNOWLEDGE_STORE_MIGRATION_STRATEGY=continue`**
- Current: Mixed vectors, poor search
- New: Falls back to 'drop' with warning
- Result: Better search quality, clearer behavior

**Scenario 5: User has `PI_KNOWLEDGE_STORE_MIGRATION_STRATEGY=error`**
- Current: Throws error, blocks startup
- New: Falls back to 'drop' with warning
- Result: Tool works, data preserved if configured

## Testing Strategy

### Tests to Keep
- ✅ Model change detection test
- ✅ Re-embed migration test
- ✅ Document preservation test
- ✅ Drop migration test (implicit in model change test)

### Tests to Remove
- ❌ No tests for 'continue' to remove
- ❌ No tests for 'error' to remove
- ❌ No tests for dimension compatibility to remove

### Tests to Add
- ✅ Test that invalid strategy falls back to 'drop'
- ✅ Test that unknown models work (no dimension map needed)

### Verification
- Run `npm run test:unit`
- All existing tests should pass
- Code coverage should remain high for migration paths

## Benefits of Simplification

### 1. Maintainability
- 62% less code to maintain
- Clearer logic flow
- Easier to understand for new contributors

### 2. Reliability
- Fewer code paths = fewer bugs
- Simpler error handling
- Less complex state management

### 3. Performance
- No temp table creation/deletion
- Faster re-embed for small datasets
- Same performance for 'drop' strategy

### 4. User Experience
- Clearer behavior (no 'continue' confusion)
- Better defaults
- Works with any model (no dimension map)

### 5. Extensibility
- Easy to add new models (no dimension coding)
- Simple to modify strategies
- Clear interfaces

## Risk Assessment

### Low Risk
- Simplifying 're-embed' (same outcome, simpler code)
- Removing 'error' (users can use config instead)
- Simplifying version detection (string comparison works)

### Medium Risk
- Removing 'continue' strategy
  - Mitigation: Document clearly, fallback to 'drop' with warning
- Removing dimension checking
  - Mitigation: LanceDB handles this, we just drop table

### No Breaking Changes
- Metadata format unchanged
- Default behavior unchanged
- Existing tests still pass
- User migration path preserved

## Success Criteria

- ✅ Code reduction >= 60% (target 62%)
- ✅ All existing tests pass
- ✅ No breaking changes for users
- ✅ Better code clarity
- ✅ Performance maintained or improved
- ✅ Documentation updated
- ✅ Migration path verified

## Timeline

1. **Analysis & Design**: 1 hour ✅ (this doc)
2. **Implementation**: 2-3 hours
3. **Testing**: 1 hour
4. **Documentation**: 0.5 hours
5. **Total**: 4-5 hours

## Post-Implementation

1. Measure actual code reduction
2. Run full test suite
3. Document any edge cases found
4. Update ARCHITECTURE.md if needed
5. Create PR with detailed changelog