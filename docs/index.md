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
- [Service Architecture](SERVICE_ARCHITECTURE.md) - Dependency injection and service registry details

### Visualizations

- [File Dependency Graph](deps.svg) - Detailed module-level dependencies (Madge)
- [Architectural Layers](deps-archi.svg) - High-level architectural layering (Dependency Cruiser)
- [UML Class Diagram](uml.svg) - Detailed class and interface relationships (tsuml2)
- [Code Statistics](CLOC.md) - Lines of code breakdown (cloc)

---

## Development

Developer-focused documentation.

- [Contributing Guide](development/contributing.md) - How to contribute
- [Documentation Standards](development/documentation-standards.md) - Documentation guidelines

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

**Last Updated:** 2026-05-26