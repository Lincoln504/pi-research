# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-16

### Added
- Initial release of pi-research.
- Multi-agent research orchestration with "Quick" and "Deep" modes.
- Context-aware 4-call scraping protocol (Handshake, Batch 1, Batch 2, Batch 3).
- Singleton SearXNG Docker container management with heartbeat.
- Integration with security databases: NVD, CISA KEV, GitHub Advisories, and OSV.
- Stack Exchange integration for technical Q&A.
- Structured JSON-line logging with AsyncLocalStorage context.
- TUI research panel for real-time progress and token tracking.
- State-driven architecture with automatic resumption after interruption.
- Automated HTML-to-Markdown conversion with native and JS fallbacks.
- Automated export of research reports to the project root.
