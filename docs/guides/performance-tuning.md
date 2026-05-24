# Performance Tuning Guide

This guide covers performance optimization for pi-research, including configuration tuning, resource management, and best practices.

## Table of Contents

- [Quick Wins](#quick-wins)
- [Browser Performance](#browser-performance)
- [Knowledge Store Performance](#knowledge-store-performance)
- [Research Performance](#research-performance)
- [Resource Management](#resource-management)
- [Profiling and Monitoring](#profiling-and-monitoring)

---

## Quick Wins

### Enable WebGPU

WebGPU provides 3-9× faster embedding inference:

```bash
# In .env
PI_RESEARCH_EMBEDDING_DEVICE=webgpu
```

**Expected improvement:** 3-9× faster embeddings

### Use Appropriate Depth

Choose the right depth for your query:

```bash
# Simple facts → depth 0
/research population of Tokyo

# Standard research → depth 1
research latest developments in WebAssembly

# Deep analysis → depth 2
deep research AI inference hardware landscape

# Exhaustive → depth 3
deep research solid-state battery technology at depth 3
```

**Expected improvement:**
- Depth 0: ~30 seconds
- Depth 1: ~2-3 minutes
- Depth 2: ~5-8 minutes
- Depth 3: ~10-15 minutes

### Reduce Scrape Batches

For quick lookups, reduce scrape batches:

```bash
# In TUI or .env
MAX_SCRAPE_BATCHES=1
```

**Expected improvement:** 50-70% faster for depth 0

---

## Browser Performance

### Worker Pool Concurrency

Adjust browser worker pool size based on system resources:

```bash
# Low-resource systems (4GB RAM, 2 CPU)
PI_RESEARCH_WORKER_CONCURRENCY=1

# Standard systems (8GB RAM, 4 CPU)
PI_RESEARCH_WORKER_CONCURRENCY=3  # Default

# High-performance systems (16GB+ RAM, 8+ CPU)
PI_RESEARCH_WORKER_CONCURRENCY=5
```

**Trade-offs:**
- Higher concurrency = faster parallel operations
- Higher concurrency = more memory usage
- Too high = resource contention, slower overall

### Scrape Timeout

Adjust scrape timeout based on network conditions:

```bash
# Fast network (100+ Mbps)
PI_RESEARCH_SCRAPE_TIMEOUT_MS=10000

# Standard network (10-100 Mbps)
PI_RESEARCH_SCRAPE_TIMEOUT_MS=15000  # Default

# Slow network (< 10 Mbps)
PI_RESEARCH_SCRAPE_TIMEOUT_MS=30000
```

**Trade-offs:**
- Lower timeout = faster failure on slow pages
- Higher timeout = more pages succeed
- Too high = wasted time on hung pages

### Health Check Timeout

Adjust health check timeout:

```bash
# Fast systems
PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS=20000

# Standard systems
PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS=30000  # Default

# Slow systems
PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS=60000
```

**Note:** Valid range is 20000-120000 ms

---

## Knowledge Store Performance

### Embedding Device

Choose appropriate embedding device:

```bash
# GPU available (3-9× faster)
PI_RESEARCH_EMBEDDING_DEVICE=webgpu

# No GPU or compatibility issues
PI_RESEARCH_EMBEDDING_DEVICE=cpu
```

**Performance comparison:**
- WebGPU: ~10-20ms per embedding (all-MiniLM-L6-v2)
- CPU: ~50-100ms per embedding (all-MiniLM-L6-v2)

### Embedding Model

Choose model based on quality vs. speed:

```bash
# Fastest (384 dimensions)
PI_RESEARCH_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2

# Balanced (384 dimensions, better quality)
PI_RESEARCH_EMBEDDING_MODEL=Xenova/all-MiniLM-L12-v2

# Best quality (768 dimensions)
PI_RESEARCH_EMBEDDING_MODEL=Xenova/all-mpnet-base-v2
```

**Trade-offs:**
- Smaller models = faster embeddings, less memory
- Larger models = better quality, slower embeddings
- Larger vectors = more storage, slower search

### Search Threshold

Adjust similarity threshold for search:

```typescript
// In code
const results = await store.search(query, {
  threshold: 0.7  // Higher = fewer, more relevant results
});
```

**Trade-offs:**
- Higher threshold = fewer, more relevant results
- Lower threshold = more results, less relevant
- Too high = no results
- Too low = noise

### Search Limit

Limit number of search results:

```typescript
const results = await store.search(query, {
  limit: 5  // Fewer results = faster search
});
```

**Performance impact:**
- Linear relationship with result count
- Limit of 5 is usually sufficient for context

---

## Research Performance

### Max Concurrent Researchers

Adjust based on system resources and query complexity:

```bash
# Low-resource systems
PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS=1

# Standard systems
PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS=3  # Default

# High-performance systems
PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS=5
```

**Trade-offs:**
- More researchers = faster parallel research
- More researchers = more resource usage
- Too many = contention, diminishing returns

### Researcher Timeout

Adjust timeout based on depth and complexity:

```bash
# Depth 0 (quick)
PI_RESEARCH_RESEARCHER_TIMEOUT_MS=120000

# Depth 1 (normal)
PI_RESEARCH_RESEARCHER_TIMEOUT_MS=360000  # Default

# Depth 2 (deep)
PI_RESEARCH_RESEARCHER_TIMEOUT_MS=600000

# Depth 3 (ultra)
PI_RESEARCH_RESEARCHER_TIMEOUT_MS=900000
```

**Formula:** 2-3 minutes per depth level

### Depth Selection

Choose appropriate depth for query complexity:

| Query Type | Recommended Depth | Expected Time |
|------------|-------------------|---------------|
| Simple fact lookup | 0 | ~30 seconds |
| Single topic overview | 1 | ~2-3 minutes |
| Multi-faceted analysis | 2 | ~5-8 minutes |
| Exhaustive research | 3 | ~10-15 minutes |

### Query Optimization

Write effective queries:

```bash
# Good: Specific and focused
research WebAssembly performance optimization techniques

# Bad: Too broad
research technology

# Good: Multiple aspects specified
deep research AI inference hardware: TPUs, GPUs, NPUs, at depth 2

# Bad: Vague
deep research hardware stuff
```

---

## Resource Management

### Memory Management

Monitor and limit memory usage:

```bash
# Reduce concurrent operations
PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS=1
PI_RESEARCH_WORKER_CONCURRENCY=2

# Use CPU embeddings (less memory)
PI_RESEARCH_EMBEDDING_DEVICE=cpu

# Clear knowledge store periodically
/research-config knowledge clear
```

**Memory usage estimates:**
- Base process: ~100-200 MB
- Per researcher: ~50-100 MB
- Per browser worker: ~100-200 MB
- Knowledge store: ~10 MB per 1000 vectors

### CPU Management

Optimize CPU usage:

```bash
# Reduce concurrency
PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS=1
PI_RESEARCH_WORKER_CONCURRENCY=2

# Use CPU embeddings (more predictable)
PI_RESEARCH_EMBEDDING_DEVICE=cpu

# Reduce scrape batches
MAX_SCRAPE_BATCHES=1
```

**CPU usage patterns:**
- Idle: ~0-5%
- Research (depth 0): ~20-30%
- Research (depth 1): ~40-60%
- Research (depth 2): ~60-80%
- Research (depth 3): ~80-100%

### Network Management

Optimize network usage:

```bash
# Reduce concurrent requests
PI_RESEARCH_WORKER_CONCURRENCY=2

# Use longer timeouts for slow networks
PI_RESEARCH_SCRAPE_TIMEOUT_MS=30000

# Use Brave Search API (reduces scraping)
BRAVE_SEARCH_API_KEY=your_key
```

**Network usage estimates:**
- Search (10 queries): ~1-2 MB
- Scrape (10 pages): ~5-10 MB
- Embedding (100 texts): Negligible (local)
- Total (depth 1): ~10-20 MB

---

## Profiling and Monitoring

### Enable Profiling

Enable verbose logging for profiling:

```bash
PI_RESEARCH_VERBOSE=1 pi
```

### Check Metrics

View performance metrics:

```bash
# View metrics dashboard
/research-config metrics

# View specific metric
/research-config metrics view
```

### Health Checks

Run health checks to identify bottlenecks:

```bash
# Run all checks
/health

# View history
/health-history

# Check specific component
/research-config health run browser
/research-config health run knowledge-store
```

### Custom Profiling

Add custom profiling in code:

```typescript
import { logger } from '@lincoln504/pi-research';

const start = Date.now();
await someOperation();
const duration = Date.now() - start;
logger.debug(`Operation took ${duration}ms`);
```

### Performance Benchmarks

Run performance benchmarks:

```typescript
import { KnowledgeStore } from '@lincoln504/pi-research';

const store = new KnowledgeStore();

// Benchmark embedding
const texts = Array(100).fill('Sample text for benchmarking');
const start = Date.now();
for (const text of texts) {
  await store.embed(text);
}
const duration = Date.now() - start;
console.log(`Embedding: ${texts.length} texts in ${duration}ms`);
console.log(`Average: ${(duration / texts.length).toFixed(2)}ms per text`);

// Benchmark search
const startSearch = Date.now();
const results = await store.search('query');
const durationSearch = Date.now() - startSearch;
console.log(`Search: ${results.length} results in ${durationSearch}ms`);
```

---

## Best Practices

### 1. Start with Defaults

Use default configuration initially, then tune based on observed performance:

```bash
# Use defaults first
# Then adjust based on bottlenecks
```

### 2. Measure Before Optimizing

Profile before making changes:

```bash
# Run health check
/health

# View metrics
/research-config metrics

# Check error logs
/research-config errors view
```

### 3. Optimize Bottlenecks

Focus on the slowest component:

```bash
# Browser slow? Reduce concurrency or increase timeouts
# Embeddings slow? Use WebGPU or smaller model
# Network slow? Use Brave Search API or reduce requests
```

### 4. Trade-offs Are Inevitable

Performance always involves trade-offs:

```bash
# Speed vs. quality
# CPU vs. GPU
# Memory vs. speed
# Accuracy vs. latency
```

### 5. Use Appropriate Depth

Don't overuse depth 3:

```bash
# Use depth 0 for 85%+ of queries
# Use depth 1-2 for complex topics
# Reserve depth 3 for exhaustive research
```

---

## Configuration Reference

### Performance-Related Variables

| Variable | Default | Range | Effect |
|----------|---------|-------|--------|
| `PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS` | `3` | 1-5 | Parallel researchers |
| `PI_RESEARCH_WORKER_CONCURRENCY` | `3` | 1-10 | Browser workers |
| `PI_RESEARCH_SCRAPE_TIMEOUT_MS` | `15000` | 5000-60000 | Scrape timeout |
| `PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS` | `30000` | 20000-120000 | Health check timeout |
| `PI_RESEARCH_RESEARCHER_TIMEOUT_MS` | `360000` | 60000-900000 | Researcher timeout |
| `PI_RESEARCH_EMBEDDING_DEVICE` | `webgpu` | webgpu/cpu | Embedding backend |
| `PI_RESEARCH_EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | - | Embedding model |
| `MAX_SCRAPE_BATCHES` | `3` | 0-16 | Scrape batches (0=unlimited) |

### Recommended Configurations

**Low-Resource System (4GB RAM, 2 CPU):**
```bash
PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS=1
PI_RESEARCH_WORKER_CONCURRENCY=2
PI_RESEARCH_EMBEDDING_DEVICE=cpu
MAX_SCRAPE_BATCHES=1
```

**Standard System (8GB RAM, 4 CPU):**
```bash
PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS=3
PI_RESEARCH_WORKER_CONCURRENCY=3
PI_RESEARCH_EMBEDDING_DEVICE=webgpu
MAX_SCRAPE_BATCHES=3
```

**High-Performance System (16GB+ RAM, 8+ CPU):**
```bash
PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS=5
PI_RESEARCH_WORKER_CONCURRENCY=5
PI_RESEARCH_EMBEDDING_DEVICE=webgpu
MAX_SCRAPE_BATCHES=5
```

---

## Related

- [Architecture Overview](../architecture/overview.md)
- [Deployment Guide](./deployment.md)
- [Troubleshooting Guide](./troubleshooting.md)
- [Knowledge Store API](../api/knowledge-store.md)

---

**Last Updated:** 2026-05-23