# Documentation Cleanup Plan

This plan documents the cleanup of temporary documentation at the project root to prevent documentation churn.

## Problem

The project experienced significant documentation churn:
- 17 files added (6,673 lines) in a single day
- 13 files deleted (5,767 lines) in the same day
- Multiple overlapping reports on the same topics
- No clear documentation strategy

## Solution

1. **Archive phase and investigation reports** → `docs/archive/`
2. **Keep durable planning docs at root** → Permanent location
3. **Organize reference docs in docs/** → By type (api, guides, architecture, development)

## Root-Level Documentation Strategy

### Keep at Root (Durable Planning Documents)

- `README.md` - Project overview and quick start
- `DEVELOPMENT_ROADMAP.md` - Development priorities and timeline
- `LICENSE` - License information

### Move to docs/ (Reference Documentation)

All other documentation should be organized in `docs/` subdirectories:

- `docs/api/` - API documentation
- `docs/guides/` - User and developer guides
- `docs/architecture/` - Architecture documentation
- `docs/development/` - Development documentation
- `docs/archive/` - Archived temporary reports

## Cleanup Actions

### Phase 1: Archive Temporary Reports (✅ Done)

Moved to `docs/archive/`:
- `PHASE_2C_SUMMARY.md`
- `LOGGING_MIGRATION_GUIDE.md`
- `MIGRATION_EXAMPLE_BROWSER_MANAGER.md`
- `STRUCTURED_LOGGING_IMPLEMENTATION.md`

### Phase 2: Consolidate Phase Reports (Pending)

The following root-level phase reports should be consolidated or archived:

**Option A: Summarize and Archive**
Create a single `docs/archive/PHASE_SUMMARY.md` with brief summaries of all phases, then archive originals.

**Option B: Keep Current**
Keep these at root as they document recent completed work:
- `PHASE1C_CIRCULAR_DEPENDENCY_FIX.md`
- `PHASE2B_MIGRATION_SIMPLIFICATION_REPORT.md`
- `TEST_QUALITY_IMPROVEMENT_REPORT.md`
- `TEST_QUALITY_AUDIT_REPORT.md`
- `TEST_QUALITY_FINAL_SUMMARY.md`
- `EXECUTIVE_SUMMARY.md`
- `QUICK_SUMMARY.md`
- `COMPLETION_CHECKLIST.md`
- `MODULARIZATION_REPORT.md`
- `DE-GLOBALIZATION-REPORT.md`
- `CIRCULAR_DEPENDENCY_ANALYSIS.md`
- `CIRCULAR_DEPENDENCY_VISUAL.md`
- `MIGRATION_SIMPLIFICATION_PLAN.md`
- `MIGRATION_SIMPLIFICATION_RESULTS.md`
- `MIGRATION_SIMPLIFICATION_SUMMARY.md`

**Recommendation:** Keep current - these documents are recent and may be referenced in the near future. Review in 3 months.

### Phase 3: Remove Research Output (Pending)

Research output files in `docs/` should be moved or removed:

**Files:**
- `pi-research-*.md` (multiple research result files)

**Options:**
1. Delete (these are just research outputs)
2. Move to user's research directory
3. Keep in `docs/archive/` as examples

**Recommendation:** Delete - these are example research outputs that users will generate themselves.

### Phase 4: Update Package.json (Pending)

Update `package.json` to include new documentation structure:

```json
"files": [
  "src/",
  "!src/.env",
  "!src/.env.local",
  "!src/.env.*.local",
  "!src/knowledge_db/",
  "docs/api/",
  "docs/guides/",
  "docs/architecture/",
  "docs/development/",
  "docs/assets/",
  "docs/archive/",
  "scripts/",
  "!scripts/download-models.mjs",
  "LICENSE",
  "README.md",
  "DEVELOPMENT_ROADMAP.md"
]
```

---

## Documentation Standards Going Forward

### Creation Process

1. **Before creating new documentation:**
   - Check if similar documentation exists
   - Determine if it should be permanent or temporary
   - Use appropriate template from `docs/development/documentation-standards.md`

2. **For temporary documentation:**
   - Add `TEMPORARY:` prefix to title
   - Include "Archival Date" in document
   - Plan archival location and date

3. **For permanent documentation:**
   - Follow documentation standards
   - Use correct directory structure
   - Get peer review before merging

### Maintenance Process

1. **Monthly review:**
   - Check for outdated documentation
   - Archive or remove temporary docs
   - Update references

2. **Per release:**
   - Update version numbers
   - Review all docs for accuracy
   - Update migration guides if needed

### Archival Process

When archiving documentation:

1. Move to `docs/archive/`
2. Update `docs/archive/README.md` with description
3. Update cross-references in other docs
4. Document reason for archival

---

## Documentation Structure Summary

### Permanent Documents

```
pi-research/
├── README.md                      # Project overview
├── DEVELOPMENT_ROADMAP.md         # Development priorities
├── LICENSE                        # License
└── docs/
    ├── api/                       # API documentation
    │   ├── research-tool.md
    │   ├── health-check.md
    │   └── knowledge-store.md
    ├── guides/                    # User and developer guides
    │   ├── deployment.md
    │   ├── troubleshooting.md
    │   ├── performance-tuning.md
    │   └── testing.md
    ├── architecture/              # Architecture documentation
    │   ├── overview.md
    │   ├── decisions.md
    │   └── scope-boundaries.md
    ├── development/               # Development documentation
    │   ├── roadmap.md
    │   ├── contributing.md
    │   └── documentation-standards.md
    └── archive/                   # Archived temporary docs
        ├── README.md
        └── [archived phase reports]
```

### Root-Level Planning Documents

The following planning documents should remain at the root:

- `README.md` - Project overview and quick start
- `DEVELOPMENT_ROADMAP.md` - Development priorities and timeline
- `LICENSE` - License information

All other documentation should be organized in `docs/` subdirectories.

---

## Next Steps

1. ✅ Create archive directory structure
2. ✅ Move phase reports to archive
3. ✅ Create durable documentation (this phase)
4. ⏸️ Review root-level temporary reports (in 3 months)
5. 📋 Remove research output files from docs/
6. 📋 Update package.json files list
7. 📋 Create documentation index
8. 📋 Update README with links to new structure

---

**Created:** 2026-05-23
**Status:** Phase 3b in progress
**Next Review:** 2026-08-23