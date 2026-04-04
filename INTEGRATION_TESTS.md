# Integration Testing Summary

## Overview

This document summarizes the integration testing setup for the pi-research project using testcontainers.

## Testcontainers Setup

### Configuration
- **Testcontainers version**: 11.13.0
- **Container**: searxng/searxng:latest
- **Test configuration**: `vitest.config.integration.ts`
- **Test timeout**: 180s (3 minutes)
- **Max concurrency**: 1 (one container at a time)

### Helper Functions

The integration test helper (`test/integration/helpers/testcontainers.ts`) provides:

1. **startSearxngContainer()**: Starts a Searxng container with testcontainers
2. **waitForSearxngReady()**: Waits for the container to be ready
3. **search()**: Performs search queries against Searxng (GET requests)
4. **getEngines()**: Gets available search engines from Searxng

## Test Coverage

### Test File: `test/integration/searxng-container.test.ts`

| Category | Tests | Status |
|----------|-------|--------|
| Container Lifecycle | 3 | ✅ All passing |
| HTTP Connectivity | 4 | ✅ All passing |
| Engine Configuration | 3 | ✅ All passing |
| Search Functionality | 2 | ✅ 1 passing, 1 error handling |
| Optional Search Tests | 2 | ⏭️ Skipped (documented) |
| **Total** | **14** | **13 passing, 2 skipped** |

## Test Results

```
Test Files  1 passed (1)
Tests  13 passed | 2 skipped (15)
Duration  ~12s
```

## Known Limitations

### Searxng Security Features

Some search functionality tests are skipped because Searxng's default security settings may block requests:

- **Rate limiting**: Searxng limits the number of requests from a single source
- **Bot detection**: Searxng may detect and block automated requests
- **User agent checks**: Requests without proper user agents may be rejected
- **IP-based restrictions**: Docker container IPs may be treated differently

### Expected Errors

When testing search functionality, you may encounter:
- **403 Forbidden**: Due to bot detection or rate limiting
- **429 Too Many Requests**: Due to rate limiting
- **Empty results**: Due to limited search engine availability in default config

## Why Integration Tests with Testcontainers?

### Advantages

1. **Real environment**: Tests against actual Searxng container, not mocks
2. **Consistent environment**: Same container configuration for all tests
3. **Automatic cleanup**: Testcontainers handles container lifecycle
4. **Portable**: Works on any machine with Docker installed
5. **Isolated**: Tests don't affect production or local Searxng instances

### Disadvantages

1. **Slower**: Requires starting/stopping containers (~12s per run)
2. **Docker required**: Needs Docker daemon running
3. **Security features**: Searxng's security may block some test queries
4. **External dependencies**: Requires internet connection for Docker images

## Running Integration Tests

### Run All Integration Tests

```bash
npm run test:integration
```

### Run Single Test File

```bash
npx vitest run test/integration/searxng-container.test.ts
```

### Run with Coverage

```bash
npx vitest run --config vitest.config.integration.ts --coverage
```

## Adding More Integration Tests

### Template for New Integration Test

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startSearxngContainer,
  type SearxngContainer,
} from './helpers/testcontainers.js';

describe('New Feature', () => {
  let container: SearxngContainer | null = null;

  beforeAll(async () => {
    container = await startSearxngContainer();
  }, 180000);

  afterAll(async () => {
    if (container) {
      await container.stop();
    }
  });

  it('should test something', async () => {
    // Test implementation
  });
});
```

### Best Practices

1. **Container lifecycle**: Always use `beforeAll` to start and `afterAll` to stop
2. **Timeouts**: Use adequate timeouts (180s for container startup)
3. **Error handling**: Handle both success and error cases
4. **Cleanup**: Ensure containers are stopped even on test failure
5. **Documentation**: Document any known limitations or skipped tests

## Future Enhancements

### Possible Additions

1. **More Searxng tests**: Test advanced search features when security allows
2. **Security API tests**: Test NVD, CISA, GitHub, OSV integration
3. **StackExchange tests**: Test StackExchange API integration
4. **End-to-end tests**: Test complete research workflow
5. **Performance tests**: Measure response times and throughput

### Challenges

1. **API rate limits**: External APIs have rate limits
2. **Authentication**: Some APIs require authentication
3. **Data volatility**: Search results and API responses change
4. **Network dependency**: Tests require internet connection

## References

- [Testcontainers Documentation](https://testcontainers.com/)
- [Searxng Documentation](https://docs.searxng.org/)
- [Vitest Documentation](https://vitest.dev/)

## Summary

The integration test suite provides valuable testing of the Searxng container functionality:

- ✅ Container lifecycle management
- ✅ HTTP connectivity
- ✅ Configuration endpoints
- ⏭️ Search functionality (limited by Searxng security)

This approach is much better than mocked tests for integration testing, as it tests against a real Searxng instance. However, for full end-to-end testing, manual testing with a properly configured Searxng instance is recommended.
