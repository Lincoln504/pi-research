# Development Roadmap

## Project Vision

pi-research is a high-fidelity multi-agent web research system for the pi CLI. It provides autonomous web search, scraping, and research capabilities with a focus on safety, efficiency, and user experience.

## Current Status (Version 0.1.14)

✅ **Stable Core Features:**
- Multi-agent orchestration (quick and deep modes)
- Stealth browser infrastructure (camoufox)
- Web search, scraping, security databases, Stack Exchange
- Knowledge store with local embeddings
- Real-time TUI with progress tracking
- Comprehensive test coverage (943 tests)

✅ **Completed Improvements:**
- Circular dependency fixes (Phase 1C)
- Migration system simplification (Phase 2B)
- Logging infrastructure migration (Phase 2C)
- Test quality improvements (Phase 3A)

## Development Priorities

### Priority 1: Stability & Reliability

**Status:** Ongoing

**Goals:**
- Ensure robust error handling across all components
- Improve browser health check reliability
- Enhance logging for production debugging
- Reduce resource leaks

**Tasks:**
- [ ] Comprehensive error handling review
- [ ] Memory leak detection and fixes
- [ ] Browser process crash recovery
- [ ] Improved timeout handling
- [ ] Graceful degradation for failures

**Target:** Q2 2026

### Priority 2: Performance Optimization

**Status:** Planned

**Goals:**
- Reduce latency for research sessions
- Optimize resource usage (CPU, memory)
- Improve knowledge store query performance
- Enhance browser worker pool efficiency

**Tasks:**
- [ ] Profile and optimize hot paths
- [ ] Implement result caching strategies
- [ ] Optimize embedding model inference
- [ ] Improve parallel scraping efficiency
- [ ] Add performance benchmarks

**Target:** Q3 2026

### Priority 3: Feature Enhancements

**Status:** Planned

**Goals:**
- Add more data sources
- Improve research coordination
- Enhance result synthesis
- Add custom tool support

**Tasks:**
- [ ] Wikipedia API integration
- [ ] Academic database access (arXiv, Google Scholar)
- [ ] Custom tool plugin system
- [ ] Improved result ranking and deduplication
- [ ] Research history and session resumption

**Target:** Q4 2026

### Priority 4: Developer Experience

**Status:** Planned

**Goals:**
- Improve extension development workflow
- Add comprehensive API documentation
- Provide development tooling
- Simplify testing

**Tasks:**
- [ ] Complete API documentation
- [ ] Development setup guide
- [ ] Plugin development guide
- [ ] Test utilities and helpers
- [ ] Debugging tools

**Target:** Q1 2027

## Future Considerations

### Potential Features (Not Prioritized)

- Distributed research across multiple machines
- Research result sharing between sessions
- Custom browser profiles
- Research template library
- Integration with external knowledge bases
- Advanced filtering and search operators
- Research result export (PDF, JSON, CSV)
- Collaborative research sessions

### Deprecation Candidates

None currently identified. All features are actively maintained.

## Technical Debt Tracking

| Area | Debt | Priority | Plan |
|------|-------|----------|------|
| Knowledge Store | Simplified migration system (completed) | ✅ Done | Phase 2B |
| Dependencies | Circular imports | ✅ Done | Phase 1C |
| Logging | Legacy console.log removal | ✅ Done | Phase 2C |
| Tests | Trivial test cleanup | ✅ Done | Phase 3A |
| Documentation | Churn reduction | 🔄 In Progress | Phase 3B |
| Browser Manager | Migration to async context | 📋 Planned | Q2 2026 |

## Release Planning

### Version 0.2.0 - Stability Release
**Target:** Q2 2026
**Focus:** Priority 1 - Stability & Reliability

### Version 0.3.0 - Performance Release
**Target:** Q3 2026
**Focus:** Priority 2 - Performance Optimization

### Version 0.4.0 - Feature Release
**Target:** Q4 2026
**Focus:** Priority 3 - Feature Enhancements

### Version 0.5.0 - DX Release
**Target:** Q1 2027
**Focus:** Priority 4 - Developer Experience

## Contribution Guidelines

See `CONTRIBUTING.md` for contribution guidelines and `docs/development/documentation-standards.md` for documentation standards.

## Decision Process

Major architectural decisions are documented in `docs/architecture/decisions.md` using the ADR (Architecture Decision Record) format.

## Communication

- **Issues:** GitHub Issues for bugs and feature requests
- **Discussions:** GitHub Discussions for questions and proposals
- **PRs:** Pull Requests for code contributions

---

**Last Updated:** 2026-05-23
**Maintainer:** @Lincoln504