# Chaos Engineering Tests - Implementation Summary

## Overview
This document summarizes the chaos engineering tests implemented for GAP 6 in the pi-research project. The tests focus on simulating real-world failure scenarios and ensuring the system can recover gracefully.

## Files Created

### 1. Test Infrastructure: `test/utils/chaos-helpers.ts` (535 lines)
A comprehensive utility library for chaos testing that provides:

**Delay Injection:**
- `withRandomDelay<T>()` - Injects random delays before/after function execution
- `withJitterDelay<T>()` - Adds jittered delays with configurable percentage
- `SeededRandom` class - Deterministic random number generator for reproducible tests

**Error Injection:**
- `withRandomError<T>()` - Randomly throws errors based on probability
- `withInitialFailures<T>()` - Fails first N attempts, then succeeds
- `withAlternatingFailures<T>()` - Fails on alternating attempts
- `simulateProcessCrash()` - Simulates process termination
- `simulateOomError()` - Simulates out-of-memory condition
- `simulateFsError()` - Simulates file system errors
- `simulateNetworkTimeout()` - Simulates network timeout (ETIMEDOUT)
- `simulateConnectionReset()` - Simulates connection reset (ECONNRESET)
- `simulateConnectionRefused()` - Simulates connection refused (ECONNREFUSED)
- `simulateRateLimitError()` - Simulates HTTP 429 rate limit

**Network Failure Simulation:**
- `withNetworkChaos<T>()` - Comprehensive network chaos with configurable failure types, probability, and latency

**Concurrency Utilities:**
- `raceConcurrent<T>()` - Executes operations concurrently with jittered start times
- `executeBurst<T>()` - Executes operations in burst batches

**Timing & Monitoring:**
- `measureTime<T>()` - Measures execution time of async operations
- `ResettableTimeout` - Timeout that can be reset

**Mock Utilities:**
- `createFailingMock<T>()` - Mock that fails after N successful calls
- `createDelayedMock<T>()` - Mock with configurable delay
- `createIntermittentMock<T>()` - Mock that fails intermittently

**Test Data Generators:**
- `generateRandomData()` - Generates random byte buffers
- `generateRandomString()` - Generates random test strings

---

### 2. Browser Manager Chaos Tests: `test/unit/infrastructure/browser-manager-chaos.test.ts` (523 lines, 20 tests)

**Worker Process Death During Queries:**
- ✅ Recovery from worker crash mid-query with retry
- ✅ Multiple consecutive worker deaths
- ✅ Eventual failure after too many worker deaths
- ✅ Worker death during concurrent operations

**Leadership Election Disruption:**
- ✅ Leadership loss during operation
- ✅ Leadership takeover when previous leader dies
- ✅ Retry on transient election failure
- ✅ Concurrent leadership attempts
- ✅ Operation across leadership transition

**Network Failure Injection:**
- ✅ Retry on transient network errors (ECONNRESET, ECONNREFUSED)
- ✅ Transient socket error identification
- ✅ No retry on non-transient errors

**Circuit Breaker Integration:**
- ✅ Circuit opens after consecutive failures
- ✅ Circuit recovery after timeout and success

**Concurrent Chaos Scenarios:**
- ✅ Burst requests with mixed failures
- ✅ Concurrent operations with random delays
- ✅ Consistency under high contention (20 operations)

**Resource Exhaustion:**
- ✅ Scheduler restart under load
- ✅ Timeout handling under heavy load

---

### 3. GPU Lock Contention Chaos Tests: `test/unit/knowledge/gpu-lock-contention-chaos.test.ts` (516 lines, 23 tests)

**High Contention Scenarios:**
- ✅ 20 concurrent lock acquisition attempts
- ✅ Burst lock acquisition attempts
- ✅ Rapid acquire/release cycles (15 cycles)
- ✅ Lock acquisition with delays and jitter

**Lock Owner Death Detection:**
- ✅ Lock reclamation when owner dies
- ✅ Multiple dead owners in sequence
- ✅ Live process lock protection

**Stale Lock Reclamation:**
- ✅ Reclamation of locks older than threshold
- ✅ Fresh lock protection
- ✅ Lock near threshold boundary

**Concurrent Lock Operations:**
- ✅ Mixed acquire and release operations
- ✅ Rapid state updates with lock held
- ✅ Serialized lock acquisition

**Lock Timeout Scenarios:**
- ✅ Timeout when lock held by another process
- ✅ Success with sufficient timeout (reclaims dead owner)
- ✅ Zero timeout handling

**Error Handling & Edge Cases:**
- ✅ Release without acquisition
- ✅ Release with different PID
- ✅ getGpuOwner when no lock held
- ✅ Rapid acquire-release-acquire cycles
- ✅ Session ID persistence

**Performance:**
- ✅ 50 sequential cycles efficiently
- ✅ Concurrent reads while lock held

---

### 4. Embedder Chaos Tests: `test/unit/knowledge/embedder-chaos.test.ts` (656 lines, 19 tests)

**Initialization Chaos:**
- ✅ 12 concurrent initialization attempts
- ✅ Initialization with random delays (8 instances)
- ✅ Dispose during concurrent initialization

**Embedding Failures Mid-Operation:**
- ✅ OOM errors during embedding
- ✅ Process crash during embedding
- ✅ Partial failures in batch embedding

**GPU Lock Chaos:**
- ✅ GPU lock acquisition timeout
- ✅ GPU lock release failures
- ✅ GPU lock loss during operation

**Memory Pressure:**
- ✅ Large batch sizes under memory pressure
- ✅ 50 consecutive operations without memory leaks

**Concurrent Operations:**
- ✅ 15 concurrent embedding requests
- ✅ Mixed single and batch operations (8 total)
- ✅ Initialize and embed concurrently (5 instances)

**Lifecycle Chaos:**
- ✅ 10 rapid init/dispose cycles
- ✅ Multiple concurrent dispose calls
- ✅ Embed after dispose handling

**Performance:**
- ✅ 20 operations under load
- ✅ 30 burst operations efficiently

---

### 5. Knowledge Store Chaos Tests: `test/unit/knowledge/store-chaos.test.ts` (620 lines, 17 tests)

**Connection Failure Scenarios:**
- ✅ Initial connection failure with retry
- ✅ Connection reset during operation
- ✅ Network timeout during query
- ✅ Recovery from transient errors

**Concurrent Operations During Failures:**
- ✅ 10 concurrent writes during instability
- ✅ 8 concurrent reads during connection loss
- ✅ Mixed read/write (15 operations) under chaos

**Partial Write Failures:**
- ✅ Batch write with partial failures (3 batches)
- ✅ Single item failures in batch

**Reconnection Logic:**
- ✅ Automatic reconnection on connection loss
- ✅ Reconnection with exponential backoff
- ✅ Give up after max attempts

**Network Chaos Integration:**
- ✅ Network chaos with helper (10 operations)
- ✅ Random error injection (10 operations)

**Resource Cleanup:**
- ✅ Cleanup after failed operations
- ✅ Multiple cleanup attempts

**Performance:**
- ✅ Reasonable performance despite failures (20 ops, fail every 4th)

---

### 6. API Rate Limit Chaos Tests: `test/unit/security/api-rate-limit-chaos.test.ts` (636 lines, 17 tests)

**HTTP 429 Error Simulation:**
- ✅ 429 error detection
- ✅ Retry with exponential backoff
- ✅ Retry-After header respect
- ✅ Fallback to exponential backoff
- ✅ Exhaust retries on persistent rate limiting

**Rate Limit Detection:**
- ✅ Various 429 error format identification
- ✅ Differentiation from other 4xx errors

**Concurrent Requests Under Rate Limit:**
- ✅ Burst of 10 requests hitting rate limit
- ✅ Distributed retries to avoid rate limit (8 ops)

**Backoff Strategy:**
- ✅ Jitter with backoff
- ✅ Maximum backoff delay cap (5s)

**Rate Limit Headers:**
- ✅ X-RateLimit-Reset header handling
- ✅ Missing headers graceful fallback

**Performance:**
- ✅ 15 requests with rate limiting (every 3rd fails)
- ✅ High concurrency (10 ops) with rate limiting

**Edge Cases:**
- ✅ Retry-After of 0
- ✅ Very large Retry-After value (1 hour, capped to 5s)

---

### 7. Retry Utils Chaos Tests: `test/unit/web-research/retry-utils-chaos.test.ts` (668 lines, 27 tests)

**Network Failure Injection:**
- ✅ Various network timeouts
- ✅ Connection reset errors
- ✅ Connection refused errors
- ✅ Rate limit errors with proper backoff
- ✅ Non-transient error handling
- ✅ Persistent network error exhaustion

**Mixed Error Patterns:**
- ✅ Alternating transient and non-transient
- ✅ Success after mixed transient errors
- ✅ Custom transient error detection

**Randomized Failure Patterns:**
- ✅ Random transient errors (60% success rate)
- ✅ Chaos helper random error injection
- ✅ onAttempts filter in error injection

**Network Chaos Scenarios:**
- ✅ Various failure types with probability
- ✅ Only timeout failures
- ✅ Added latency with chaos

**Timeout Chaos:**
- ✅ Timeout under fake timers
- ✅ Timeout with external abort signal
- ✅ Complete before timeout
- ✅ 4 concurrent timeouts

**High Contention:**
- ✅ 10 concurrent operations with mixed outcomes
- ✅ 15 burst operations efficiently
- ✅ 20 operations load test

**Edge Cases:**
- ✅ Zero maxRetries
- ✅ Very small delays
- ✅ Very large delays
- ✅ Function returning non-promise
- ✅ Null/undefined errors

---

### 8. Search Chaos Tests: `test/unit/web-research/search-chaos.test.ts` (541 lines, 21 tests)

**Search Timeout Simulation:**
- ✅ Slow query timeout (30s delayed, 5s timeout)
- ✅ Fast query completion before timeout
- ✅ Concurrent searches with different timeouts (3 ops)

**Network Failure During Search:**
- ✅ Retry on connection reset
- ✅ Retry on connection refused
- ✅ Retry on network timeout
- ✅ Exhaust retries on persistent failures

**Concurrent Search with Mixed Outcomes:**
- ✅ 12 searches with some failures (every 3rd)
- ✅ 15 searches with network chaos
- ✅ 10 searches in burst pattern

**Search Result Corruption Handling:**
- ✅ Malformed results (null, undefined in array)
- ✅ Completely invalid response
- ✅ Empty results graceful handling

**Exponential Backoff Behavior:**
- ✅ Correct exponential backoff (100, 200, 400ms)
- ✅ Maximum backoff delay cap (500ms)

**Performance:**
- ✅ 20 ops despite failures (20% fail rate)
- ✅ High concurrency (50 ops) efficiently

**Edge Cases:**
- ✅ Empty query string
- ✅ Very long query (10,000 chars)
- ✅ Special characters
- ✅ Unicode characters

---

## Test Coverage Summary

| Test File | Test Count | Lines | Key Areas Covered |
|-----------|-----------|-------|-------------------|
| `chaos-helpers.ts` | - | 535 | Infrastructure utilities |
| `browser-manager-chaos.test.ts` | 20 | 523 | Worker death, leadership, network, circuit breaker |
| `gpu-lock-contention-chaos.test.ts` | 23 | 516 | Lock contention, staleness, timeouts |
| `embedder-chaos.test.ts` | 19 | 656 | Init chaos, OOM, crashes, memory pressure |
| `store-chaos.test.ts` | 17 | 620 | Connection failures, reconnection, partial writes |
| `api-rate-limit-chaos.test.ts` | 17 | 636 | 429 errors, backoff, headers, concurrency |
| `retry-utils-chaos.test.ts` | 27 | 668 | Network failures, timeouts, jitter, edge cases |
| `search-chaos.test.ts` | 21 | 541 | Search timeouts, failures, corruption, backoff |
| **Total** | **144** | **4,695** | - |

---

## Critical Chaos Scenarios Implemented

### 1. GPU Lock Contention ✅
- 20+ concurrent acquisition attempts
- Burst lock acquisition patterns
- Stale lock reclamation
- Owner death detection

### 2. Worker Process Death ✅
- Process crash during query execution
- Multiple consecutive deaths
- Recovery with retry logic
- Concurrent operation handling

### 3. Network Failure Injection ✅
- Connection reset (ECONNRESET)
- Connection refused (ECONNREFUSED)
- Network timeout (ETIMEDOUT)
- DNS resolution failure (ENOTFOUND)
- Mixed failure types with probability

### 4. Leadership Election Disruption ✅
- Leadership loss during operation
- Concurrent leadership attempts
- Transient election failures
- State corruption handling

### 5. Additional Scenarios ✅
- API rate limiting (HTTP 429)
- Embedding failures mid-operation
- LanceDB connection failures
- Search timeout simulation
- Circuit breaker state transitions

---

## Design Principles

### 1. Determinism Where Possible
- Seeded random number generator for reproducible tests
- Configurable error probabilities
- Predictable retry patterns

### 2. Realistic Failure Simulation
- Actual error codes (ECONNRESET, ETIMEDOUT, etc.)
- Proper error message formats
- Correct HTTP status codes

### 3. Comprehensive Coverage
- High contention scenarios (20+ concurrent operations)
- Mixed success/failure patterns
- Edge cases (empty data, null values, etc.)

### 4. Performance Awareness
- Timing assertions for critical paths
- Load testing under chaos
- Efficiency verification

---

## Running the Tests

```bash
# Run all chaos tests
npm test -- chaos

# Run specific test file
npm test -- test/unit/knowledge/gpu-lock-contention-chaos.test.ts
npm test -- test/unit/infrastructure/browser-manager-chaos.test.ts

# Run specific test suite
npm test -- test/unit/web-research/retry-utils-chaos.test.ts
```

---

## Notes

- Some tests may fail in CI environments due to timing and concurrency characteristics
- Tests use `vi.useFakeTimers()` where appropriate for deterministic timing
- Mock implementations isolate the system under test from external dependencies
- The `chaos-helpers.ts` utilities are reusable across all test suites

---

## Future Enhancements

Potential additions for more comprehensive chaos testing:

1. **Disk I/O Chaos** - Simulate slow disk, disk full scenarios
2. **Memory Pressure Simulation** - More sophisticated OOM patterns
3. **Network Partition** - Simulate partial network failures
4. **Clock Skew** - Test behavior with system time changes
5. **Resource Starvation** - Simulate CPU throttling scenarios
6. **Database Chaos** - More LanceDB-specific failure patterns
7. **Browser Worker Chaos** - More sophisticated worker pool failure simulation