# Knowledge Store API

## Overview

The Knowledge Store provides local vector embeddings for context retention across research sessions. It uses LanceDB for vector storage and supports configurable embedding models (WebGPU/CPU).

## Installation

The knowledge store is included in `@lincoln504/pi-research`:

```bash
pi install npm:@lincoln504/pi-research
```

## Quick Start

### Using from pi CLI

```bash
# View knowledge store status
/research-config knowledge status

# Migrate knowledge store
/research-config knowledge migrate drop

# Clear knowledge store
/research-config knowledge clear
```

### Using Programmatically

```typescript
import { KnowledgeStore, type KnowledgeStoreConfig } from '@lincoln504/pi-research';

const config: KnowledgeStoreConfig = {
  dbPath: './knowledge_db',
  embeddingModel: 'Xenova/all-MiniLM-L6-v2',
  embeddingDevice: 'webgpu'
};

const store = new KnowledgeStore(config);
await store.initialize();

// Add content
await store.add('pi-research is a web research tool', { source: 'docs' });

// Search
const results = await store.search('web research capabilities');
```

## API Reference

### Main Class

#### `KnowledgeStore`

```typescript
class KnowledgeStore
```

Manages vector embeddings and similarity search.

**Constructor:**

```typescript
constructor(config: KnowledgeStoreConfig)
```

**Configuration:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| dbPath | `string` | `'./knowledge_db'` | Path to LanceDB database |
| embeddingModel | `string` | `'Xenova/all-MiniLM-L6-v2'` | Embedding model name |
| embeddingDevice | `string` | `'webgpu'` | Inference backend: `webgpu` or `cpu` |
| migrate | `MigrationStrategy` | `'drop'` | Migration strategy on init |

**Methods:**

##### `initialize`

```typescript
async initialize(): Promise<void>
```

Initializes the knowledge store, including migrations if needed.

**Throws:**
- `KnowledgeStoreError` - When initialization fails
- `MigrationError` - When migration fails

**Example:**

```typescript
const store = new KnowledgeStore(config);
await store.initialize();
```

##### `embed`

```typescript
async embed(text: string): Promise<number[]>
```

Converts text to vector embedding.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| text | `string` | Yes | Text to embed |

**Returns:** `Promise<number[]>` - Vector embedding

**Throws:**
- `EmbeddingError` - When embedding generation fails

**Example:**

```typescript
const vector = await store.embed('pi-research web search tool');
console.log(`Vector dimension: ${vector.length}`); // 384 for all-MiniLM-L6-v2
```

##### `add`

```typescript
async add(text: string, metadata?: Record<string, unknown>): Promise<void>
```

Adds content to the knowledge store.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| text | `string` | Yes | Content text |
| metadata | `Record<string, unknown>` | No | Optional metadata |

**Throws:**
- `KnowledgeStoreError` - When add operation fails

**Example:**

```typescript
await store.add('pi-research uses stealth browsers', {
  source: 'README',
  timestamp: new Date().toISOString()
});
```

##### `search`

```typescript
async search(
  query: string,
  options?: SearchOptions
): Promise<SearchResult[]>
```

Searches for similar content.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| query | `string` | Yes | Search query |
| options | `SearchOptions` | No | Search options |

**SearchOptions:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| limit | `number` | `10` | Maximum results |
| threshold | `number` | `0.5` | Minimum similarity score (0-1) |
| filter | `Record<string, unknown>` | - | Metadata filter |

**Returns:** `Promise<SearchResult[]>`

**SearchResult:**

```typescript
interface SearchResult {
  text: string;
  metadata: Record<string, unknown>;
  score: number;
}
```

**Example:**

```typescript
const results = await store.search('stealth browser', {
  limit: 5,
  threshold: 0.7
});

results.forEach(result => {
  console.log(`Score: ${result.score.toFixed(2)}`);
  console.log(result.text);
});
```

##### `clear`

```typescript
async clear(): Promise<void>
```

Clears all content from the knowledge store.

**Throws:**
- `KnowledgeStoreError` - When clear operation fails

**Example:**

```typescript
await store.clear();
console.log('Knowledge store cleared');
```

##### `close`

```typescript
async close(): Promise<void>
```

Closes the knowledge store and releases resources.

**Example:**

```typescript
await store.close();
```

##### `getStatus`

```typescript
getStatus(): KnowledgeStoreStatus
```

Returns current knowledge store status.

**Returns:** `KnowledgeStoreStatus`

**KnowledgeStoreStatus:**

```typescript
interface KnowledgeStoreStatus {
  initialized: boolean;
  dbPath: string;
  embeddingModel: string;
  embeddingDevice: string;
  vectorCount: number;
  vectorDimension: number;
}
```

**Example:**

```typescript
const status = store.getStatus();
console.log(`Vectors stored: ${status.vectorCount}`);
console.log(`Model: ${status.embeddingModel}`);
```

---

### Types

#### `KnowledgeStoreConfig`

```typescript
interface KnowledgeStoreConfig {
  dbPath?: string;
  embeddingModel?: string;
  embeddingDevice?: 'webgpu' | 'cpu';
  migrate?: MigrationStrategy;
}
```

#### `MigrationStrategy`

```typescript
type MigrationStrategy = 'drop' | 're-embed';
```

#### `SearchOptions`

```typescript
interface SearchOptions {
  limit?: number;
  threshold?: number;
  filter?: Record<string, unknown>;
}
```

#### `SearchResult`

```typescript
interface SearchResult {
  text: string;
  metadata: Record<string, unknown>;
  score: number;
}
```

---

## Migration

When the knowledge store is initialized, it checks if the embedding model has changed. If so, it performs a migration based on the configured strategy.

### Migration Strategies

#### `drop`

**Description:** Drops all vectors and starts fresh.

**Use case:** Fast cache invalidation.

**Performance:** Very fast.

**Data loss:** All vectors deleted.

**Example:**

```typescript
const store = new KnowledgeStore({
  ...config,
  migrate: 'drop'
});
```

#### `re-embed`

**Description:** Re-embeds all stored content with the new model.

**Use case:** Preserve data when changing models.

**Performance:** Slower (depends on vector count).

**Data loss:** None.

**Example:**

```typescript
const store = new KnowledgeStore({
  ...config,
  migrate: 're-embed'
});
```

### Manual Migration

```typescript
import { migrateKnowledgeStore } from '@lincoln504/pi-research';

await migrateKnowledgeStore({
  dbPath: './knowledge_db',
  newModel: 'Xenova/all-MiniLM-L6-v2',
  newDevice: 'webgpu',
  strategy: 're-embed'
});
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_RESEARCH_EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | Embedding model name |
| `PI_RESEARCH_EMBEDDING_DEVICE` | `webgpu` | Inference backend |

### Configuration API

```typescript
import { getConfig, setConfig } from '@lincoln504/pi-research';

// Get current configuration
const config = getConfig();

// Set configuration
setConfig({
  KNOWLEDGE_DB_PATH: './knowledge_db',
  EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
  EMBEDDING_DEVICE: 'webgpu'
});
```

---

## Examples

### Basic Usage

```typescript
import { KnowledgeStore } from '@lincoln504/pi-research';

const store = new KnowledgeStore({
  dbPath: './knowledge_db'
});

await store.initialize();

// Add content
await store.add('pi-research provides web search capabilities');
await store.add('Multi-agent orchestration for deep research');

// Search
const results = await store.search('search capabilities');
results.forEach(result => {
  console.log(`${result.score.toFixed(2)}: ${result.text}`);
});
```

### With Metadata

```typescript
// Add content with metadata
await store.add('WebAssembly performance optimization techniques', {
  source: 'research-report',
  url: 'https://example.com/wasm-perf',
  timestamp: new Date().toISOString(),
  tags: ['wasm', 'performance', 'optimization']
});

// Search with metadata filter
const results = await store.search('optimization', {
  filter: { tags: 'wasm' }
});
```

### Custom Embedding Model

```typescript
const store = new KnowledgeStore({
  embeddingModel: 'Xenova/all-mpnet-base-v2',
  embeddingDevice: 'webgpu'
});

await store.initialize();

// Model-specific vector dimension
const vector = await store.embed('test');
console.log(`Vector dimension: ${vector.length}`); // 768 for all-mpnet-base-v2
```

### CPU Fallback

```typescript
let device = 'webgpu';

try {
  // Try WebGPU first
  await navigator.gpu.requestAdapter();
} catch {
  // Fall back to CPU
  device = 'cpu';
  console.warn('WebGPU not available, using CPU');
}

const store = new KnowledgeStore({
  embeddingDevice: device
});
```

### Batch Operations

```typescript
const documents = [
  'Document 1 content...',
  'Document 2 content...',
  'Document 3 content...'
];

// Add multiple documents
for (const doc of documents) {
  await store.add(doc, { batch: 'import-1' });
}

// Search across all
const results = await store.search('relevant content', {
  limit: 10
});
```

---

## Best Practices

1. **Choose the right embedding model:**
   - Use smaller models (all-MiniLM-L6-v2) for faster inference
   - Use larger models (all-mpnet-base-v2) for better quality
   - Consider vector dimension vs. speed trade-offs

2. **Use WebGPU when available:**
   ```typescript
   const device = await checkWebGPUSupport() ? 'webgpu' : 'cpu';
   ```

3. **Add metadata for filtering:**
   ```typescript
   await store.add(text, {
     source: url,
     timestamp: new Date().toISOString(),
     topic: category
   });
   ```

4. **Set appropriate thresholds:**
   ```typescript
   // Higher threshold for more precise results
   const results = await store.search(query, { threshold: 0.8 });
   ```

5. **Handle migration carefully:**
   ```typescript
   const store = new KnowledgeStore({
     migrate: 're-embed' // Preserve data
   });
   ```

6. **Close the store when done:**
   ```typescript
   process.on('beforeExit', async () => {
     await store.close();
   });
   ```

---

## Performance Considerations

### Embedding Performance

- **WebGPU:** 3-9× faster than CPU
- **CPU:** Slower but more compatible
- **Model size:** Smaller models embed faster

### Search Performance

- **Vector count:** Linear increase in search time
- **Limit:** Lower limit = faster search
- **Threshold:** Higher threshold = fewer results = faster

### Optimization Tips

1. Use WebGPU when available
2. Choose appropriate embedding model size
3. Set reasonable search limits
4. Batch add operations
5. Use metadata filters to reduce search space

---

## Related

- [Architecture Overview](../architecture/overview.md)
- [Research Tool API](./research-tool.md)
- [Performance Tuning Guide](../guides/performance-tuning.md)

---

**Last Updated:** 2026-05-23