# Changelog

All notable changes to pi-research will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- TBD

## [0.1.0] - 2026-04-04

### Added
- Multi-agent research orchestration with coordinator + researchers
- Parallel and sequential execution modes
- SearXNG integration for web search with Docker container management
- URL scraping with 2-layer architecture (fetch + Playwright fallback)
- Security database queries (NVD, CISA KEV, GitHub, OSV)
- Stack Exchange API integration and caching
- Code search with ripgrep (rg) or grep fallback
- TUI panel for visual progress tracking (simple and full modes)
- Tor and HTTP proxy support for anonymous research
- Shared link pool for coordination across researchers
- Dynamic slice naming for flexible research strategies
- Token usage tracking and display across all agents
- Comprehensive integration testing with testcontainers
- GitHub Actions CI/CD pipelines (lint, type-check, tests)
- Release automation for npm and pi ecosystem
- Semantic versioning and automated changelog generation

### Documentation
- Complete README with installation and usage guide
- CONTRIBUTING.md for developer guidelines
- SECURITY.md for vulnerability reporting
- RELEASE_GUIDE.md for release procedures
- Integration testing documentation
- TUI mode documentation
- Proxy and Tor configuration guide

### Testing
- 810+ unit tests covering all major functionality
- Integration tests with real SearXNG container
- 100% type checking coverage with TypeScript
- ESLint configuration for code quality

[Unreleased]: https://github.com/Lincoln504/pi-research/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Lincoln504/pi-research/releases/tag/v0.1.0
