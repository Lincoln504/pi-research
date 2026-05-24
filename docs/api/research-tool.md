# Research Tool API

## Overview

The Research Tool provides web search, scraping, and multi-agent research capabilities for the pi CLI. It supports both quick mode (single agent) and deep mode (multi-agent orchestration).

## Installation

The research tool is included in the `@lincoln504/pi-research` package:

```bash
pi install npm:@lincoln504/pi-research
```

## Quick Start

### Using from pi CLI

The research tool is automatically available after installation:

```bash
# Interactive research with AI
research the latest developments in WebAssembly

# Deep research with explicit depth
deep research AI inference hardware landscape

# Direct command (quick mode, depth 0)
/research Python 3.13 new features
```

### Using Programmatically

```typescript
import { runResearch, type ResearchOptions } from '@lincoln504/pi-research';

const options: ResearchOptions = {
  query: 'latest developments in WebAssembly',
  depth: 0,
  signal: AbortSignal.timeout(300000)
};

const result = await runResearch(options);
console.log(result.output);
```

## API Reference

### Main Functions

#### `runResearch`

```typescript
function runResearch(options: ResearchOptions): Promise<ResearchResult>
```

Executes a research session using the appropriate orchestrator based on depth.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| options | `ResearchOptions` | Yes | Research configuration options |

**Returns:** `Promise<ResearchResult>`

**Throws:**
- `ResearchError` - When research fails to complete
- `BrowserError` - When browser infrastructure fails
- `TimeoutError` - When research exceeds timeout

**Example:**

```typescript
import { runResearch } from '@lincoln504/pi-research';

const result = await runResearch({
  query: 'solid-state battery technology',
  depth: 1,
  signal: AbortSignal.timeout(300000)
});

console.log(result.output);
console.log(`Tokens used: ${result.totalTokens}`);
```

---

### Classes

#### `DeepResearchOrchestrator`

```typescript
class DeepResearchOrchestrator
```

Manages multi-agent deep research sessions with coordinator, parallel researchers, and evaluator.

**Constructor:**

```typescript
constructor(options: DeepResearchOrchestratorOptions)
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| query | `string` | - | Research query |
| depth | `number` | `1` | Research depth (1-3) |
| maxConcurrent | `number` | `3` | Max concurrent researchers |
| observer | `ResearchObserver` | - | Optional observer for events |
| signal | `AbortSignal` | - | Optional abort signal |

**Methods:**

##### `execute`

```typescript
async execute(): Promise<ResearchResult>
```

Executes the deep research orchestration.

**Returns:** `Promise<ResearchResult>`

**Example:**

```typescript
import { DeepResearchOrchestrator } from '@lincoln504/pi-research';

const orchestrator = new DeepResearchOrchestrator({
  query: 'AI inference hardware',
  depth: 2,
  maxConcurrent: 3
});

const result = await orchestrator.execute();
```

---

#### `QuickResearchOrchestrator`

```typescript
class QuickResearchOrchestrator
```

Manages single-agent quick research sessions (depth 0).

**Constructor:**

```typescript
constructor(options: QuickResearchOrchestratorOptions)
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| query | `string` | - | Research query |
| observer | `ResearchObserver` | - | Optional observer for events |
| signal | `AbortSignal` | - | Optional abort signal |

**Methods:**

##### `execute`

```typescript
async execute(): Promise<ResearchResult>
```

Executes the quick research session.

**Returns:** `Promise<ResearchResult>`

**Example:**

```typescript
import { QuickResearchOrchestrator } from '@lincoln504/pi-research';

const orchestrator = new QuickResearchOrchestrator({
  query: 'population of Tokyo'
});

const result = await orchestrator.execute();
```

---

### Types

#### `ResearchOptions`

```typescript
interface ResearchOptions {
  query: string;
  depth?: number;
  signal?: AbortSignal;
}
```

#### `DeepResearchOrchestratorOptions`

```typescript
interface DeepResearchOrchestratorOptions {
  query: string;
  depth?: number;
  maxConcurrent?: number;
  observer?: ResearchObserver;
  signal?: AbortSignal;
}
```

#### `QuickResearchOrchestratorOptions`

```typescript
interface QuickResearchOrchestratorOptions {
  query: string;
  observer?: ResearchObserver;
  signal?: AbortSignal;
}
```

#### `ResearchResult`

```typescript
interface ResearchResult {
  output: string;
  totalTokens: number;
  totalCost: number;
  duration: number;
}
```

#### `ResearchObserver`

```typescript
interface ResearchObserver {
  onStart?: () => void;
  onProgress?: (progress: ResearchProgress) => void;
  onComplete?: (result: ResearchResult) => void;
  onError?: (error: Error) => void;
}
```

#### `ResearchProgress`

```typescript
interface ResearchProgress {
  stage: 'planning' | 'gathering' | 'scraping' | 'evaluating' | 'complete';
  message: string;
  percent: number;
  tokens: number;
  cost: number;
}
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS` | `3` | Max concurrent researchers (1-5) |
| `PI_RESEARCH_RESEARCHER_TIMEOUT_MS` | `360000` | Per-researcher timeout in ms (default 6m) |
| `PI_RESEARCH_WORKER_CONCURRENCY` | `3` | Browser worker processes (1-10) |
| `PI_RESEARCH_SCRAPE_TIMEOUT_MS` | `15000` | Per-page scrape timeout in ms |
| `PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS` | `30000` | Health check timeout in ms |
| `PI_RESEARCH_VERBOSE` | - | Set to `1` for diagnostic logs |
| `PROXY_URL` | - | Proxy for outgoing requests |
| `BRAVE_SEARCH_API_KEY` | - | Brave Search API key |
| `STACKEXCHANGE_API_KEY` | - | Stack Exchange API key |

### Configuration API

```typescript
import { getConfig, setConfig, resetConfig } from '@lincoln504/pi-research';

// Get current configuration
const config = getConfig();

// Set configuration values
setConfig({
  DEFAULT_RESEARCH_DEPTH: 1,
  MAX_SCRAPE_BATCHES: 3
});

// Reset to defaults
resetConfig();
```

---

## Depth Levels

The research tool supports 4 depth levels:

| Depth | Mode | Researchers | Rounds | Use Case |
|-------|------|-------------|--------|----------|
| 0 | Quick | 1 | 1 | Simple lookups, facts |
| 1 | Normal | 2 | 2 | Standard research |
| 2 | Deep | 3 | 3 | Comprehensive analysis |
| 3 | Ultra | 5 | 5 | Exhaustive research |

### Automatic Depth Selection

When depth is not specified, the system automatically selects based on query complexity:

- Keywords like "quick", "brief", "simple" → depth 0
- No cues or "research" → depth 1
- "deep", "thorough", "comprehensive" → depth 2
- "ultra", "exhaustive" → depth 3

---

## Research Tools

Each researcher has access to the following tools:

### `search`

Web search using stealth browser (DuckDuckGo Lite).

**Budget:** 4 calls (shared with other gathering tools)

### `scrape`

URL scraping with batch protocol.

**Budget:** Configurable batches (default: 3, range: 1-16, or unlimited)

### `security_search`

Query security databases (NVD, CISA KEV, GitHub Advisories, OSV).

**Budget:** 4 calls (shared with other gathering tools)

### `stackexchange`

Search Stack Exchange network.

**Budget:** 4 calls (shared with other gathering tools)

### `grep`

Local codebase search using ripgrep.

**Budget:** 4 calls (shared with other gathering tools)

---

## Examples

### Basic Usage

```typescript
import { runResearch } from '@lincoln504/pi-research';

const result = await runResearch({
  query: 'latest stable Node.js LTS release',
  depth: 0
});

console.log(result.output);
```

### With Observer

```typescript
import { runResearch, type ResearchObserver } from '@lincoln504/pi-research';

const observer: ResearchObserver = {
  onProgress: (progress) => {
    console.log(`[${progress.stage}] ${progress.percent}% - ${progress.message}`);
  },
  onComplete: (result) => {
    console.log(`Research complete: ${result.totalTokens} tokens`);
  }
};

await runResearch({
  query: 'WebAssembly performance optimization',
  depth: 1,
  observer
});
```

### With Abort Signal

```typescript
import { runResearch } from '@lincoln504/pi-research';

const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 60000);

try {
  const result = await runResearch({
    query: 'AI inference hardware',
    depth: 2,
    signal: controller.signal
  });
  clearTimeout(timeoutId);
} catch (error) {
  if (error.name === 'AbortError') {
    console.log('Research timed out');
  }
}
```

### Using Deep Research Orchestration Directly

```typescript
import { DeepResearchOrchestrator } from '@lincoln504/pi-research';

const orchestrator = new DeepResearchOrchestrator({
  query: 'solid-state battery technology',
  depth: 2,
  maxConcurrent: 3
});

const result = await orchestrator.execute();
```

---

## Best Practices

1. **Choose the right depth:**
   - Use depth 0 for simple fact lookups
   - Use depth 1 for most research tasks
   - Use depth 2-3 for comprehensive analysis

2. **Handle errors gracefully:**
   ```typescript
   try {
     const result = await runResearch(options);
   } catch (error) {
     if (error instanceof BrowserError) {
       // Handle browser failures
     } else if (error instanceof TimeoutError) {
       // Handle timeouts
     }
   }
   ```

3. **Use observers for progress:**
   ```typescript
   const observer = {
     onProgress: (progress) => updateUI(progress),
     onComplete: (result) => saveResult(result)
   };
   ```

4. **Set appropriate timeouts:**
   ```typescript
   const signal = AbortSignal.timeout(
     depth * 180000 // 3 minutes per depth level
   );
   ```

5. **Monitor costs:**
   ```typescript
   const result = await runResearch(options);
   console.log(`Cost: $${result.totalCost.toFixed(4)}`);
   ```

---

## Related

- [Architecture Overview](../architecture/overview.md)
- [Deployment Guide](../guides/deployment.md)
- [Performance Tuning](../guides/performance-tuning.md)
- [Troubleshooting](../guides/troubleshooting.md)

---

**Last Updated:** 2026-05-23