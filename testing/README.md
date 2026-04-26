# Pi Research - Performance Testing

This directory contains standalone performance tests and stress tests that are **NOT** part of the regular test suite or CI pipeline.

## Purpose

These tests are designed for:
- ✅ Manual performance testing
- ✅ Production capacity planning
- ✅ Rate limit investigation
- ✅ Throughput optimization
- ✅ Load testing

## ⚠️ Important Notes

**DO NOT run these tests in CI or as part of regular tests:**
- They make external network requests (to DuckDuckGo Lite)
- They can take 30-60+ minutes to complete
- They are resource-intensive (spawn multiple browser instances)
- They are for manual validation only

## Test Scripts

### aggressive-stress-zero-ms.mjs

**Purpose:** Push DuckDuckGo Lite to absolute limit with NO delay between queries

**Configuration:**
- Throttle: 0ms (NO DELAY - as fast as possible)
- Workers: 4 (max parallelism)
- 2-Page Search: ENABLED (results from page 1 and page 2)
- Relevance Checking: ENABLED (word similarity scoring)
- Max Queries: 2000 (or until hard limit detected)

**Detection:**
- Hard Limit: 10 blocks in 50-query rolling window
- Consistent Limit: 5 consecutive blocks
- Pattern Analysis: Identifies rate limit patterns (clustering, tight gaps, etc.)

**Usage:**
```bash
cd /home/ldeen/Documents/pi-research/testing
node aggressive-stress-zero-ms.mjs
```

**Results:**
- Logs to: `aggressive-stress-zero-ms.log`
- JSON to: `aggressive-stress-zero-ms.json`

**Test Duration:** ~30-40 minutes for 2000 queries

---

## Running Tests in Background

To run tests in background (recommended for long-running tests):

```bash
# Create output directory
mkdir -p testing-results

# Run in background with nohup
nohup node testing/aggressive-stress-zero-ms.mjs > testing-results/test.log 2>&1 &

# Monitor progress
tail -f testing-results/test.log

# Check if still running
ps aux | grep aggressive-stress-zero-ms
```

---

## Test Results Location

When tests complete, results are saved in the output directory specified in the test script:

- **Log files:** Detailed query-by-query logs
- **JSON files:** Structured results with statistics and recommendations

---

## Interpreting Results

### Rate Limit Detection

The tests analyze block patterns to detect rate limiting:

| Pattern | Meaning | Action |
|---------|---------|--------|
| `sporadic_blocks` | Isolated blocks, no pattern | Safe to continue |
| `tight_rate_limit` | Blocks close together (avg gap < 20) | Reduce throttle |
| `clustered_rate_limit` | Blocks grouped together | Reduce throttle significantly |
| `consistent_blocks` | Consecutive blocks | Hard limit reached |

### Key Metrics

- **Success Rate:** Percentage of successful queries (target: >95%)
- **Block Rate:** Percentage of blocked queries (target: <5%)
- **Throughput:** Queries per second
- **Relevance:** Average result relevance score (0-100)
- **2-Page Success:** Percentage of queries that got page 2 results

---

## Production Recommendations

Based on exhaustive testing with these scripts:

```typescript
// Recommended configuration for production
const MAX_WORKERS = 4;
const SEARCH_THROTTLE_MS = 0;      // No throttle needed
const MAX_CONCURRENT_TASKS = 4;
const TWO_PAGE_SEARCH = true;       // Double results
```

**Expected Performance:**
- Throughput: ~0.92 queries/sec
- Daily Capacity: ~320k queries/day (4 workers)
- Results/Query: ~20 (with 2-page search)
- Success Rate: ~99%
- Relevance: ~98%

---

## Test History

| Date | Test | Queries | Throttle | Success Rate | Result |
|------|------|---------|----------|--------------|--------|
| 2025-04-25 | aggressive-stress-zero-ms | 2000 | 0ms | 99.10% | ✅ No hard limit |
| 2025-04-25 | aggressive-stress (1000ms) | 2000 | 1000ms | 98.80% | ✅ No hard limit |

---

## Safety Guidelines

When running these tests:

1. **Run in background** - Tests can take 30-60 minutes
2. **Monitor system resources** - Multiple browser instances consume memory
3. **Be respectful** - Don't run these tests too frequently
4. **Check results** - Review logs for patterns before drawing conclusions
5. **Test at off-peak hours** - If possible, run tests during low-traffic periods

---

## Future Tests

Potential additions to this directory:

- Multi-day stress test (24+ hours)
- Geographic latency testing
- Different search term distribution
- Alternative search providers
- Comparison tests with/without 2-page search
- Relevance scoring improvements

---

## Questions?

For questions about these tests or their results, refer to:
- `/docs/ARCHITECTURE.md` - Architecture documentation
- `/README.md` - Project overview
- Test-specific log files and JSON results
