# pi-research Documentation Index

Complete index of all pi-research documentation.

---

## Quick Start

- [README.md](../README.md) - Project overview, installation, and usage
- [Deployment Guide](guides/deployment.md) - Installation and configuration

---

## API Documentation

Complete API documentation for external consumers.

- [Research Tool API](api/research-tool.md) - Main research orchestration API
- [Health Check API](api/health-check.md) - Health monitoring system
- [Knowledge Store API](api/knowledge-store.md) - Vector embeddings and search

---

## Guides

User and developer guides for common tasks.

- [Deployment Guide](guides/deployment.md) - Installation and configuration
- [Troubleshooting Guide](guides/troubleshooting.md) - Common issues and solutions
- [Performance Tuning](guides/performance-tuning.md) - Optimization and configuration
- [Testing Guide](guides/testing.md) - Testing practices and best practices

---

## Architecture

System design and architectural decisions.

- [Architecture Overview](architecture/overview.md) - High-level system architecture
- [Architecture Decisions](architecture/decisions.md) - ADRs (Architecture Decision Records)
- [Scope Boundaries](architecture/scope-boundaries.md) - Project scope and boundaries

---

## Development

Developer-focused documentation.

- [Development Roadmap](../DEVELOPMENT_ROADMAP.md) - Development priorities and timeline
- [Contributing Guide](development/contributing.md) - How to contribute
- [Documentation Standards](development/documentation-standards.md) - Documentation guidelines

---

## Archived

Temporary phase reports and investigation documents (historical reference only).

- [Archive Index](archive/README.md) - List of archived documents

---

## Legacy Documentation

Root-level planning and phase reports (kept for reference):

- `DEVELOPMENT_ROADMAP.md` - Development priorities
- `PHASE1C_CIRCULAR_DEPENDENCY_FIX.md` - Circular dependency fix
- `PHASE2B_MIGRATION_SIMPLIFICATION_REPORT.md` - Migration simplification
- `TEST_QUALITY_IMPROVEMENT_REPORT.md` - Test quality improvements
- `EXECUTIVE_SUMMARY.md` - Executive summary
- `QUICK_SUMMARY.md` - Quick summary
- `COMPLETION_CHECKLIST.md` - Completion checklist
- `MODULARIZATION_REPORT.md` - Modularization report
- `DE-GLOBALIZATION-REPORT.md` - De-globalization report
- `CIRCULAR_DEPENDENCY_ANALYSIS.md` - Circular dependency analysis
- `CIRCULAR_DEPENDENCY_VISUAL.md` - Circular dependency visualization
- `MIGRATION_SIMPLIFICATION_PLAN.md` - Migration simplification plan
- `MIGRATION_SIMPLIFICATION_RESULTS.md` - Migration simplification results
- `MIGRATION_SIMPLIFICATION_SUMMARY.md` - Migration simplification summary

---

## Documentation Standards

See [Documentation Standards](development/documentation-standards.md) for:
- Markdown style guide
- Documentation types and templates
- Review process
- Maintenance guidelines

---

## Quick Reference

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS` | `3` | Max concurrent researchers |
| `PI_RESEARCH_RESEARCHER_TIMEOUT_MS` | `360000` | Researcher timeout (ms) |
| `PI_RESEARCH_WORKER_CONCURRENCY` | `3` | Browser worker processes |
| `PI_RESEARCH_SCRAPE_TIMEOUT_MS` | `15000` | Scrape timeout (ms) |
| `PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS` | `30000` | Health check timeout (ms) |
| `PI_RESEARCH_EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | Embedding model |
| `PI_RESEARCH_EMBEDDING_DEVICE` | `webgpu` | Embedding backend |
| `PROXY_URL` | - | Proxy for outgoing requests |
| `BRAVE_SEARCH_API_KEY` | - | Brave Search API key |
| `STACKEXCHANGE_API_KEY` | - | Stack Exchange API key |

### CLI Commands

| Command | Description |
|---------|-------------|
| `research <query>` | Interactive research with AI |
| `/research <query>` | Direct quick research (depth 0) |
| `/research-config` | Open configuration TUI |
| `/health` | Run health checks |
| `/health-clear` | Clear health check cache |
| `/health-history` | View health check history |

### Depth Levels

| Depth | Mode | Researchers | Rounds | Use Case |
|-------|------|-------------|--------|----------|
| 0 | Quick | 1 | 1 | Simple lookups |
| 1 | Normal | 2 | 2 | Standard research |
| 2 | Deep | 3 | 3 | Comprehensive analysis |
| 3 | Ultra | 5 | 5 | Exhaustive research |

### Research Tools

Each researcher has access to:
- `search` - Web search
- `scrape` - URL scraping
- `security_search` - Security databases
- `stackexchange` - Stack Exchange
- `grep` - Local codebase search

---

**Last Updated:** 2026-05-23