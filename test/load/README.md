# Load Testing for pi-research

This directory contains comprehensive load tests for the pi-research extension, focusing on system performance under concurrent and high-volume conditions.

## Test Files

### 1. concurrent-research.test.ts
Tests for verifying no session interference when running multiple research sessions simultaneously with different depths.

**Key Test Scenarios:**
- 5 concurrent research sessions at depth 0 without interference
- 5 concurrent research sessions at varying depths (0-3)
- 10 concurrent research sessions without session interference
- Rapid consecutive session starts without interference
- Session success rates under concurrent load
- Detection and reporting of interference between sessions
- Enhanced behavior validation and state consistency checks

**Metrics Measured:**
- Total/successful/failed sessions
- Success rate per depth level
- Average/P50/P95/P99 duration per session
- Interference detection
- Query isolation verification
- State consistency across parallel sessions
- Memory and file handle delta per session

### 2. high-volume-embedding.test.ts
Tests for validating embedding throughput, memory usage, and memory leak detection when processing large numbers of documents.

**Key Test Scenarios:**
- Embed 1000 documents and measure throughput
- Process 2000 documents without memory leaks
- Handle 5000 documents in batches with consistent throughput
- Track memory usage during high-volume operations
- Detect memory leaks through repeated operations
- Handle concurrent embedding requests without memory corruption
- Measure throughput with different batch sizes

**Metrics Measured:**
- Documents per second throughput
- Memory usage before/after operations
- Memory delta per batch
- Memory leak detection
- Throughput consistency across batches
- Maximum memory usage

### 3. api-concurrency.test.ts
Tests for validating concurrent API request handling across all security APIs and Stack Exchange.

**Key Test Scenarios:**
- 50+ concurrent NVD API requests
- 50+ concurrent GitHub Advisory API requests
- 50+ concurrent OSV API requests
- 50+ concurrent CISA KEV API requests
- 50+ concurrent Stack Exchange API requests
- Mixed concurrent requests across all APIs
- Latency measurement under load for all APIs
- Burst load patterns across all APIs

**Metrics Measured:**
- Total/successful/failed requests per API
- Success rate per API
- Average/P50/P95/P99 latency
- Rate limit count per API
- Request handling under burst patterns

## Running the Tests

### Run all load tests:
```bash
npm run test -- test/load/
```

### Run specific test file:
```bash
npm run test -- test/load/concurrent-research.test.ts
npm run test -- test/load/high-volume-embedding.test.ts
npm run test -- test/load/api-concurrency.test.ts
npm run test -- test/load/throughput.test.ts
npm run test -- test/load/rate-limit-handling.test.ts
```

### Run with coverage:
```bash
npm run test:coverage -- test/load/
```

## Test Dependencies

All load tests use the chaos helpers from `../utils/chaos-helpers.ts`:

- `executeBurst<T>()` - Execute operations in burst batches
- `measureTime<T>()` - Measure execution time
- `withJitterDelay<T>()` - Add jittered delays
- `withNetworkChaos<T>()` - Simulate network chaos
- `simulateRateLimitError()` - Simulate HTTP 429 errors
- `withRandomError<T>()` - Random error injection

## Expected Performance Baselines

Based on testing with mock implementations:

### Concurrent Research
- 5-10 concurrent sessions: >90% success rate
- No session interference detected
- Session completion <10 seconds (depth 0)

### High-Volume Embedding
- 1000 documents: >100 docs/sec
- 5000 documents: >50 docs/sec (with batching)
- Memory growth: <500MB for 2000 docs
- No memory leaks detected

### API Concurrency
- 50 concurrent requests per API: >60-90% success rate
- P95 latency: <500-600ms
- Proper rate limit handling

### Throughput
- Document throughput: >10 docs/sec
- Query throughput: >20 queries/sec
- Scrape throughput: >5 scrapes/sec
- P95 latency: <500-1000ms

### Rate Limit Handling
- Graceful exit on 429
- Exponential backoff with jitter
- Queue overflow detection
- Recovery after cooldown

## Test Characteristics

- **Deterministic**: Uses seeded randomness where applicable
- **Isolated**: Each test creates its own temporary database
- **Clean**: Proper cleanup of resources after each test
- **Comprehensive**: Covers success paths, failure paths, and edge cases
- **Realistic**: Simulates real-world load patterns

## Extending the Tests

To add new load tests:

1. Create a new `.test.ts` file in this directory
2. Import necessary utilities from `../utils/chaos-helpers.ts`
3. Follow the existing test structure
4. Measure relevant metrics for your use case
5. Include proper setup and teardown
6. Add documentation for new test scenarios

## Notes

- Tests use mock implementations for external dependencies
- Real-world performance may vary based on:
  - Network conditions
  - Hardware specifications
  - Actual API rate limits
  - Database performance
  - Available memory

- For production load testing:
  - Use actual APIs (with appropriate rate limit handling)
  - Test on production-like hardware
  - Monitor system resources during tests
  - Consider using dedicated load testing tools for larger scales