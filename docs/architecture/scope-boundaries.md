# Scope Boundaries

This document defines clear boundaries for the pi-research project to prevent scope creep and ensure focused development.

---

## Project Mission

**pi-research** provides a high-fidelity multi-agent web research system for the pi CLI. It enables autonomous web search, scraping, and research capabilities with a focus on safety, efficiency, and user experience.

## In Scope

### Core Features

✅ **Web Research:**
- Web search via DuckDuckGo Lite (stealth browser)
- URL scraping with batch protocol
- Security database queries (NVD, CISA KEV, GitHub Advisories, OSV)
- Stack Exchange network search
- Local codebase search (ripgrep)

✅ **Multi-Agent Orchestration:**
- Quick mode (single agent)
- Deep mode (coordinator + researchers + evaluator)
- Depth levels 0-3 with configurable parallelization
- Real-time coordination and result sharing

✅ **Knowledge Store:**
- Local vector embeddings for context retention
- LanceDB for vector storage
- Configurable embedding models (WebGPU/CPU)
- Migration strategies (drop, re-embed)

✅ **User Interface:**
- Real-time TUI with progress tracking
- Token and cost monitoring
- Configurable settings via TUI
- Collision-guarded output files

✅ **Infrastructure:**
- Stealth browser (camoufox-js)
- Worker pool management
- Health checking
- Structured logging
- Error handling

✅ **Testing:**
- Unit tests (Vitest)
- Integration tests
- Load tests
- 100% backward compatibility verification

✅ **Documentation:**
- API documentation
- User guides
- Architecture documentation
- Development documentation
- ADRs

### Platform Support

✅ **Operating Systems:**
- Linux (x64, arm64)
- macOS (x64, arm64)
- Windows (x64)

✅ **Node.js:**
- Version >= 22.13.0
- ES modules only

✅ **Dependencies:**
- pi CLI (peer dependency)
- pi-ai (peer dependency)
- pi-coding-agent (peer dependency)

---

## Out of Scope

### Research Capabilities

❌ **NOT Research:**
- Academic research assistance beyond web search
- Original research or data analysis
- Statistical analysis
- Visualization or charting
- Data export to specialized formats (beyond Markdown)

❌ **NOT Data Sources:**
- Social media APIs (Twitter, Facebook, LinkedIn, etc.)
- Proprietary databases (not publicly available)
- Paid APIs without user-provided keys
- Real-time data feeds
- Streaming content

❌ **NOT Search Types:**
- Image/video search
- Audio search
- Local file search (beyond codebase grep)
- Database queries

### Technical Features

❌ **NOT Infrastructure:**
- Distributed computing across machines
- Cloud deployment or hosting
- Database server management
- CDN or caching layer management
- Load balancing

❌ **NOT User Interface:**
- Graphical user interface (GUI)
- Web application
- Mobile applications
- Desktop applications (outside pi CLI)

❌ **NOT Integration:**
- Integration with external research tools
- Plugin system for custom tools (not yet prioritized)
- Webhooks or callbacks
- Real-time collaboration

### Development Tools

❌ **NOT Tooling:**
- IDE plugins
- Language-specific research assistants
- Code generation beyond research context
- Automated testing beyond unit/integration tests

### Data Management

❌ **NOT Data Operations:**
- Long-term data retention strategies
- Data backup/restore systems
- Data privacy/compliance tools
- Data governance

❌ **NOT Knowledge Management:**
- Knowledge graph construction
- Ontology management
- Semantic search beyond vector embeddings
- Knowledge sharing between users/sessions

---

## Boundary Clarifications

### What We DO (With Limits):

✅ **Web Scraping:**
- HTML-to-Markdown conversion
- PDF scraping
- Batch protocol with configurable limits
- Deduplication across researchers
- **Limit:** General web content, not specialized formats

✅ **Research Coordination:**
- Multi-agent orchestration
- Query decomposition
- Result synthesis
- **Limit:** Within pi CLI context, not external orchestration

✅ **Knowledge Store:**
- Local vector embeddings
- Session-level context retention
- **Limit:** Per-session, not cross-session or multi-user

### What We DON'T Do:

❌ **General-Purpose Web Scraping Tool:**
- Not designed as a standalone scraping service
- Not optimized for massive scale
- Not a web archiving solution

❌ **Search Engine:**
- Not building a search engine
- Not indexing the web
- Not providing search APIs

❌ **AI Research Assistant:**
- Not an autonomous research partner
- Not capable of independent goal-setting
- Requires user queries to initiate research

---

## Future Scope Considerations

### May Be In Scope (Future Priorities):

🔜 **Potential Enhancements:**
- Wikipedia API integration
- Academic database access (arXiv, Google Scholar)
- Custom tool plugin system
- Research history and session resumption
- Improved result ranking and deduplication
- Research templates

### Unlikely to Be In Scope:

🚫 **Unlikely:**
- Distributed research across machines
- Real-time collaborative research
- Advanced data visualization
- Specialized export formats (beyond Markdown/JSON)
- Multi-user knowledge sharing
- Enterprise features (SSO, RBAC, audit logs)

---

## Decision Framework for New Features

When considering new features, ask:

1. **Does it align with the core mission?**
   - Multi-agent web research for pi CLI
   - If no, it's likely out of scope

2. **Does it require new infrastructure?**
   - If yes, is it justified by value?
   - Can it use existing infrastructure?

3. **Does it increase complexity significantly?**
   - If yes, is the benefit clear?
   - Can it be simplified?

4. **Does it introduce new dependencies?**
   - If yes, are they necessary?
   - Can we use existing alternatives?

5. **Does it require breaking changes?**
   - If yes, is it unavoidable?
   - Can we maintain backward compatibility?

6. **Is it maintainable long-term?**
   - If no, defer or reject

7. **Is there a clear user need?**
   - If no, defer until requested

---

## Anti-Patterns to Avoid

### Scope Creep Examples

❌ **Adding "just one more feature":**
- Each feature adds maintenance burden
- Accumulates technical debt
- Distracts from core mission

❌ **Solving problems not yet encountered:**
- Premature optimization
- Over-engineering
- YAGNI (You Aren't Gonna Need It)

❌ **Building tools for everyone:**
- pi-research is for pi CLI users
- Not a general-purpose research tool
- Not for every use case

### Good Patterns

✅ **Focus on core value:**
- Multi-agent web research
- Safe and efficient
- Great user experience

✅ **Iterative improvement:**
- Fix issues as they arise
- Add features when requested
- Simplify where possible

✅ **Maintain boundaries:**
- Say no to out-of-scope requests
- Document what we don't do
- Suggest alternatives when appropriate

---

## Handling Out-of-Scope Requests

When someone requests an out-of-scope feature:

1. **Acknowledge the need:** "That's a valid use case, but..."
2. **Explain the boundary:** "...it's outside our current scope because..."
3. **Suggest alternatives:** "You might consider..."
4. **Document the request:** Create a GitHub issue for tracking
5. **Revisit periodically:** Review during roadmap planning

---

## Related Documents

- [Development Roadmap](../../DEVELOPMENT_ROADMAP.md)
- [Architecture Decisions](./decisions.md)
- [Contributing Guide](../development/contributing.md)

---

**Last Updated:** 2026-05-23