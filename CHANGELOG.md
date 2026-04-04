# Changelog

All notable changes to pi-research will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- MIT License
- CONTRIBUTING.md guidelines
- CHANGELOG.md for tracking changes

### Fixed
- Removed node_modules and package-lock.json from version control
- Updated README.md references to correct file paths
- Removed duplicate limiter.toml file
- Removed blockchain_research_report.md test file

### Changed
- Updated README.md with correct GitHub repository URL
- Added config/proxy-settings-generated.yml to .gitignore
- Removed "private" flag from package.json for npm publishing

## [2.0.0] - 2026-04-04

### Added
- Multi-agent research orchestration with coordinator + researchers
- Parallel and sequential execution modes
- SearXNG integration for web search
- URL scraping with 2-layer architecture
- Security database queries (NVD, CISA KEV, GitHub, OSV)
- Stack Exchange API integration
- Code search with ripgrep/grep fallback
- TUI panel for visual progress tracking
- Simple and full TUI modes
- Tor and HTTP proxy support
- Shared link pool for coordination across researchers
- Dynamic slice naming for flexible research
- Token usage tracking and display

### Changed
- Improved coordinator research depth assessment (Level 1-3)
- Enhanced error handling and recovery
- Better context management for researcher agents
- Updated agent prompts for more comprehensive research

### Fixed
- SearXNG container lifecycle management
- Flash effects in TUI panel
- Session cleanup on abort
- Connection count tracking

## [1.0.0] - Initial Release

### Added
- Basic research tool with coordinator agent
- SearXNG web search integration
- Simple TUI panel
- URL scraping capability
- Security database search
- Code search with ripgrep

[Unreleased]: https://github.com/Lincoln504/pi-research-dev/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/Lincoln504/pi-research-dev/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/Lincoln504/pi-research-dev/releases/tag/v1.0.0
