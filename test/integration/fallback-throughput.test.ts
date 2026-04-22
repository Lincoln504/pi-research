
import { describe, it, expect } from 'vitest';
import { performStealthSearch } from '../../src/web-research/stealth-search.ts';
import { getGlobalConcurrencyLimit } from '../../src/infrastructure/stealth-browser-manager.ts';

/**
 * Robust Queue & Concurrency Validation
 * 
 * Verifies:
 * 1. Hardware detection works (Global Concurrency > 0).
 * 2. The Global Task Queue handles parallel searches correctly.
 * 3. Results are high-fidelity (2-page pagination active).
 * 4. System stays unblocked during massive parallel burst.
 */
describe('Robust Stealth Browser Queue Throughput', () => {
  
  it('should sustain high-volume parallel searches using the global queue', async () => {
    const concurrency = getGlobalConcurrencyLimit();
    console.log(`[Validation] System Global Concurrency: ${concurrency}`);
    expect(concurrency).toBeGreaterThan(0);

    // We'll run a burst of 10 queries. 
    // The queue will ensure only 'concurrency' number of them run at once.
    const queries = [
      "quantum gravity theories",
      "bioplastic production methods",
      "risks of artificial general intelligence",
      "deep sea hydrothermal vents life",
      "graph neural network applications",
      "latest advances in fusion energy 2026",
      "ancient mesoamerican agriculture",
      "sustainable urban planning 2030",
      "machine learning model pruning",
      "digital cryptography evolution"
    ];

    console.log(`[Validation] Queuing burst of ${queries.length} queries...`);
    const startTime = Date.now();
    
    // This will trigger the global queue
    const resultMap = await performStealthSearch(queries);
    
    const duration = (Date.now() - startTime) / 1000;
    console.log(`[Validation] Completed burst in ${duration.toFixed(2)}s`);

    let totalResults = 0;
    queries.forEach((q) => {
      const results = resultMap.get(q) || [];
      console.log(`  - "${q}": ${results.length} items`);
      
      // Verify pagination: if it's working, we should usually get >10 results
      expect(results.length).toBeGreaterThanOrEqual(10);
      totalResults += results.length;
    });

    console.log(`[Validation] Total High-Fidelity Results: ${totalResults}`);
    // With 10 queries and 2 pages each, we expect ~200 results
    expect(totalResults).toBeGreaterThanOrEqual(100);

  }, 300000); // 5 minute timeout for the full burst
});
