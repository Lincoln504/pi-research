# Architecture Overview

This document provides a high-level overview of the pi-research architecture.

## System Architecture

pi-research is a multi-agent web research system for the pi CLI. It provides autonomous web search, scraping, and research capabilities with a focus on safety, efficiency, and user experience.

```
┌─────────────────────────────────────────────────────────────────┐
│                            pi CLI                                │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                  pi-research Extension                       │ │
│  │                                                             │ │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐  │ │
│  │  │   Tools     │  │  Commands    │  │  Event Handlers  │  │ │
│  │  │  research   │  │ /research    │  │  before_agent_   │  │ │
│  │  │  health     │  │ /research-   │  │     start        │  │ │
│  │  │             │  │     config   │  │  after_provider_ │  │ │
│  │  └──────┬──────┘  └──────┬───────┘  │     response     │  │ │
│  │         │                │           └────────┬─────────┘  │ │
│  │         │                │                    │             │ │
│  │  ┌──────▼────────────────▼────────────────────▼──────┐    │ │
│  │  │              Orchestration Layer                    │    │ │
│  │  │  ┌────────────┐  ┌─────────────┐  ┌────────────┐  │    │ │
│  │  │  │   Quick    │  │    Deep     │  │  Research  │  │    │ │
│  │  │  │Orchestrator│  │Orchestrator │  │  Manager   │  │    │ │
│  │  │  └─────┬──────┘  └──────┬──────┘  └─────┬──────┘  │    │ │
│  │  │        │                 │                │        │    │ │
│  │  └────────┼─────────────────┼────────────────┼────────┘    │ │
│  │           │                 │                │             │ │
│  │  ┌────────▼─────────────────▼────────────────▼────────┐    │ │
│  │  │                Research Tools                       │    │ │
│  │  │  search  │  scrape  │  security  │  stackexchange  │    │ │
│  │  └────────────────┬────────────────────────────────────┘    │ │
│  │                   │                                         │ │
│  │  ┌────────────────▼────────────────────────────────────┐    │ │
│  │  │              Infrastructure Layer                    │    │ │
│  │  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │    │ │
│  │  │  │  Browser │  │  Logger  │  │  Knowledge Store │  │    │ │
│  │  │  │   Pool   │  │          │  │                  │  │    │ │
│  │  │  └──────────┘  └──────────┘  └──────────────────┘  │    │ │
│  │  └────────────────────────────────────────────────────┘    │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Component Layers

### 1. Extension Interface Layer

**Purpose:** Integrate with pi CLI

**Components:**
- **Tools:** `research` and `health` tools for agent use
- **Commands:** `/research`, `/research-config`, and aliases
- **Event Handlers:** Prompt injection, provider monitoring

**Key Files:**
- `src/index.ts` - Extension entry point
- `src/tool.ts` - Tool definitions

---

### 2. Orchestration Layer

**Purpose:** Coordinate research sessions

**Components:**
- **QuickOrchestrator:** Single-agent research (depth 0)
- **DeepOrchestrator:** Multi-agent research (depth 1-3)
- **ResearchManager:** Route to appropriate orchestrator

**Key Files:**
- `src/orchestration/quick-research-orchestrator.ts`
- `src/orchestration/deep-research-orchestrator.ts`
- `src/orchestration/research-manager.ts`

---

### 3. Research Tools Layer

**Purpose:** Provide research capabilities to agents

**Components:**
- **search:** Web search via stealth browser
- **scrape:** URL scraping with batch protocol
- **security_search:** Security database queries
- **stackexchange:** Stack Exchange network search
- **grep:** Local codebase search

**Key Files:**
- `src/tools/research-tool.ts`
- `src/tools/health-tool.ts`
- `src/web-research/`

---

### 4. Infrastructure Layer

**Purpose:** Provide foundational services

**Components:**
- **Browser Pool:** Unified worker pool (3 processes max)
- **Logger:** Structured logging with levels
- **Knowledge Store:** Vector embeddings for context retention
- **Health Check:** Component health monitoring

**Key Files:**
- `src/infrastructure/browser-manager.ts`
- `src/logger.ts`
- `src/knowledge/`
- `src/healthcheck/`

---

## Research Modes

### Quick Mode (Depth 0)

**Characteristics:**
- Single researcher agent
- Direct search and scraping
- No coordination overhead
- Fast execution (~30 seconds)

**Flow:**
```
Query → Agent Researcher → Report → Output
```

**Use Cases:**
- Simple fact lookups
- Single-topic research
- Quick answers

### Deep Mode (Depth 1-3)

**Characteristics:**
- Multi-agent orchestration
- Coordinator, researchers, evaluator
- Parallel execution
- Progressive refinement

**Flow:**
```
Query → Coordinator → Planning → Search Burst
                                    ↓
                          ┌─────────┴─────────┐
                          ↓         ↓         ↓
                    Researcher  Researcher  Researcher
                          ↓         ↓         ↓
                          └─────────┬─────────┘
                                    ↓
                            Evaluator → Synthesis
                                    ↓
                            Output Report
```

**Use Cases:**
- Multi-faceted analysis
- Comprehensive research
- Exhaustive investigation

---

## Researcher Lifecycle

Each researcher follows a three-phase lifecycle:

### Phase 1: Gathering (4 calls total)

**Purpose:** Discover information and identify URLs

**Tools:**
- `search` - Web search
- `security_search` - Security databases
- `stackexchange` - Stack Exchange
- `grep` - Local codebase

**Budget:** 4 calls shared across all gathering tools

**Output:** Set of URLs for scraping

### Phase 2: Scraping (Configurable batches)

**Purpose:** Deep-dive into URLs for detailed content

**Tools:**
- `scrape` - URL scraping

**Budget:** 1-16 batches (4 URLs per batch), or unlimited

**Output:** Detailed content from URLs

### Phase 3: Reporting

**Purpose:** Synthesize findings into structured report

**Output:** Markdown report submitted to orchestrator

---

## Browser Infrastructure

### Unified Worker Pool

**Design:**
- Fixed pool of 3 worker processes
- Handles search, scraping, and health checks
- Warm browser instances in workers
- Strict resource caps

**Benefits:**
- Prevents process explosion
- Efficient worker reuse
- Supports concurrent sessions

**Architecture:**
```
┌─────────────────────────────────────┐
│      Task Scheduler                 │
│  ┌────────┐  ┌────────┐  ┌────────┐ │
│  │ Search │  │ Scrape │  │ Health │ │
│  └───┬────┘  └───┬────┘  └───┬────┘ │
└──────┼───────────┼───────────┼──────┘
       │           │           │
┌──────▼───────────▼───────────▼──────┐
│   Fixed ThreadPool (Poolifier)      │
│  ┌─────┐  ┌─────┐  ┌─────┐        │
│  │Worker│  │Worker│  │Worker│        │
│  │  1  │  │  2  │  │  3  │        │
│  └──┬──┘  └──┬──┘  └──┬──┘        │
└─────┼────────┼────────┼───────────┘
      │        │        │
┌─────▼────────▼────────▼───────────┐
│     Camoufox (Stealth Firefox)     │
│  ┌─────┐  ┌─────┐  ┌─────┐        │
│  │     │  │     │  │     │        │
│  │Browser│  │Browser│  │Browser│    │
│  └─────┘  └─────┘  └─────┘        │
└─────────────────────────────────────┘
```

### Stealth Engine

**Implementation:** `camoufox-js` (stealth Firefox)

**Capabilities:**
- Fingerprinting protection
- Bot detection bypass
- No API keys required

**Trade-offs:**
- Higher resource usage
- Slower than API-based approaches
- Requires browser dependencies

---

## Knowledge Store

### Architecture

```
┌─────────────────────────────────────┐
│      Knowledge Store                │
│  ┌─────────────────────────────┐    │
│  │  Embedding Model (WebGPU)   │    │
│  │  Xenova/all-MiniLM-L6-v2    │    │
│  └────────────┬────────────────┘    │
└───────────────┼─────────────────────┘
                │
┌───────────────▼─────────────────────┐
│       LanceDB                      │
│  ┌─────────────────────────────┐    │
│  │  Vector Table               │    │
│  │  - text: string             │    │
│  │  - vector: float[384]       │    │
│  │  - metadata: object         │    │
│  └─────────────────────────────┘    │
└─────────────────────────────────────┘
```

### Components

- **Embedding Model:** Local inference (WebGPU/CPU)
- **Vector Storage:** LanceDB for efficient similarity search
- **Migration System:** Strategy-based model changes

### Migration Strategies

| Strategy | Speed | Data Loss | Use Case |
|----------|-------|-----------|----------|
| `drop` | Very fast | All vectors | Fast cache invalidation |
| `re-embed` | Slower | None | Preserve data |

---

## Logging Infrastructure

### Architecture

```
┌─────────────────────────────────────┐
│       Application Code              │
│  logger.debug(), logger.info(), ... │
└──────────────┼──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│       Central Logger                 │
│  - Log levels (debug, info, warn, err)│
│  - JSON-structured output            │
│  - TUI-safe handling                 │
└──────────────┬──────────────────────┘
               │
      ┌────────┴────────┐
      │                 │
┌─────▼─────┐    ┌──────▼──────┐
│  stdout   │    │  log file   │
│  (TUI)    │    │  (debug)    │
└───────────┘    └─────────────┘
```

### Features

- Structured logging (JSON format)
- Log levels (debug, info, warn, error)
- TUI-safe output handling
- File-based capture for debugging
- Configurable verbosity

---

## Health Check System

### Architecture

```
┌─────────────────────────────────────┐
│     Health Registry                 │
│  - Register checks                  │
│  - Run checks                       │
│  - Cache results                    │
│  - Track history                    │
└──────┬──────────────────────────────┘
       │
       │
┌──────▼──────────────────────────────┐
│     Health Checks                   │
│  ┌────────┐  ┌──────────┐  ┌──────┐│
│  │Browser │  │Knowledge │  │Network││
│  │ Check  │  │  Store   │  │ Check││
│  └────────┘  └──────────┘  └──────┘│
└─────────────────────────────────────┘
```

### Components

- **Browser Check:** Worker pool and browser health
- **Knowledge Store Check:** Database and model health
- **Network Check:** Connectivity and DNS
- **Environment Check:** Configuration and variables

---

## Terminal Stability

### Problem

TUI uses advanced terminal features that can cause issues on crash/reload:
- Kitty keyboard protocol
- Mouse tracking
- Bracketed paste mode

**Risk:** Escape sequences leak to shell → ghost characters

### Solution

```
┌─────────────────────────────────────┐
│  Terminal State Manager              │
│  - Track terminal modes             │
│  - Reset on shutdown                │
│  - Drain input buffer               │
│  - Filter escape sequences          │
└─────────────────────────────────────┘
```

**Measures:**
1. Terminal mode tracking and reset
2. Input buffer draining (100ms) on shutdown
3. Escape sequence filtering in input handlers
4. Reset on all exit paths

---

## Configuration

### Environment Variables

```bash
# Research Settings
PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS=3
PI_RESEARCH_RESEARCHER_TIMEOUT_MS=360000
PI_RESEARCH_WORKER_CONCURRENCY=3
PI_RESEARCH_SCRAPE_TIMEOUT_MS=15000
PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS=30000

# Knowledge Store
PI_RESEARCH_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
PI_RESEARCH_EMBEDDING_DEVICE=webgpu

# Optional
PROXY_URL=socks5://127.0.0.1:9050
BRAVE_SEARCH_API_KEY=your_api_key
STACKEXCHANGE_API_KEY=your_api_key
SEARXNG_URL=https://your-searxng-instance.com
PI_RESEARCH_VERBOSE=1
```

### TUI Configuration

Interactive configuration via `/research-config` command:
- Settings: Research parameters
- Health: System health checks
- Errors: Error reports
- Knowledge: Knowledge store management
- Metrics: Performance metrics

---

## Project Structure

```
src/
├── infrastructure/    # Browser pool, logger
├── core/             # Core business logic
├── orchestration/    # Multi-agent coordination
├── web-research/     # Search and scraping
├── tools/            # Research tool implementations
├── tui/              # Terminal UI
├── knowledge/        # Knowledge store
├── types/            # TypeScript definitions
└── utils/            # Utility functions
```

---

## Design Principles

1. **Safety First:** Researchers cannot write files or run commands
2. **Resource Limits:** Strict caps on browser processes and researchers
3. **Modularity:** Clear layering and separation of concerns
4. **Observability:** Structured logging and health checks
5. **User Experience:** Real-time TUI with progress tracking

---

## Dependency Visualization

The project maintains automated dependency visualizations to ensure architectural integrity and assist in onboarding.

### Detailed Module Graph (Madge)

**File:** `docs/deps.svg`

A comprehensive, file-level dependency graph generated using **Madge**. This graph focuses on the structural dependencies between files, helping to identify circular dependencies and understand the module resolution tree.

### UML Class Diagram (tsuml2)

**File:** `docs/uml.svg`

A detailed UML class diagram generated using **tsuml2**. It visualizes the relationships between classes, interfaces, and types, including heritage (inheritance/implementation) and associations. This is particularly useful for understanding the Service Registry pattern and the core service interfaces.

**Generation:**
```bash
# Generate the detailed module graph
npm run deps:generate

# Generate the UML class diagram
npm run deps:generate:uml
```

---

## Related Documents

- [Architecture Decision Records](./decisions.md)
- [Scope Boundaries](./scope-boundaries.md)
- [Research Tool API](../api/research-tool.md)
- [Knowledge Store API](../api/knowledge-store.md)

---

**Last Updated:** 2026-05-26