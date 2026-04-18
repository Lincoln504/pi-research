# Changelog

All notable changes to this project will be documented in this file.

## [0.2.1] - 2026-04-18

### Fixed
- Evaluator correctness: Researchers that fail now have their topics returned to the agenda instead of being silently dropped.
- Cross-platform support: Improved Docker socket detection and path handling for Windows/macOS.
- Pipeline robustness: Better handling of network timeouts and tool exceptions.
- Code cleanup: Removed dead code and normalized string processing utilities.

## [0.2.0] - 2026-04-17

### Added
- Multi-session TUI: Research panels now stack correctly in long-running pi sessions.
- Enhanced Evaluator: Promotion logic now prioritizes coverage over round limits.
- Parallel Research: Increased default concurrency for deeper research runs.

## [0.1.0] - 2026-04-16

### Added
- Initial release of pi-research.
- Multi-agent research orchestration with "Quick" and "Deep" modes.
- Context-aware 4-call scraping protocol.
- Singleton SearXNG Docker container management.
- Integration with security databases and Stack Exchange.
- TUI research panel for real-time progress.
