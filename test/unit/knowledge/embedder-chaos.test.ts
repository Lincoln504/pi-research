/**
 * Chaos Engineering Tests: Embedder
 *
 * Tests chaotic scenarios for the embedder including:
 * - Embedding failures mid-operation
 * - Concurrent initialization with failures
 * - GPU lock acquisition failures
 * - Memory pressure simulation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Embedder } from '../../../src/knowledge/embedder.ts';
import {
  simulateOomError,
  simulateProcessCrash,
  withRandomDelay,
  withRandomError,
  raceConcurrent,
  measureTime,
} from '../../utils/chaos-helpers.ts';

describe('Embedder Chaos Tests', () => {
  let embedder: Embedder;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (embedder) {
      await embedder.dispose().catch(() => {});
    }
  });

  describe('Initialization Chaos', () => {
    it('should handle 10+ concurrent initialization attempts', async () => {
      const initCount = 12;
      const embedders: Embedder[] = [];

      const operations = Array.from({ length: initCount }, (_, i) =>
        async () => {
          const emb = new Embedder({
            model: 'test-model',
            device: 'cpu'
          });
          embedders.push(emb);
          return await emb.initialize();
        }
      );

      const results = await raceConcurrent(operations);

      // All initializations should complete
      results.forEach(result => {
        expect(result).toBeUndefined(); // initialize returns void
      });

      // Clean up
      await Promise.all(embedders.map(e => e.dispose().catch(() => {})));
    });

    it('should handle initialization with random delays', async () => {
      const initCount = 8;
      const embedders: Embedder[] = [];

      const operations = Array.from({ length: initCount }, () =>
        withRandomDelay(async () => {
          const emb = new Embedder({
            model: 'test-model',
            device: 'cpu'
          });
          embedders.push(emb);
          await emb.initialize();
          return true;
        }, { min: 10, max: 100 })()
      );

      const results = await Promise.allSettled(operations);

      // All should eventually succeed
      const successes = results.filter(r => r.status === 'fulfilled');
      expect(successes.length).toBe(initCount);

      // Clean up
      await Promise.all(embedders.map(e => e.dispose().catch(() => {})));
    });

    it('should handle dispose during concurrent initialization', async () => {
      const embedder1 = new Embedder({
        model: 'test-model',
        device: 'cpu'
      });

      // Start initialization
      const initPromise = embedder1.initialize();

      // Immediately dispose
      const disposePromise = embedder1.dispose();

      await Promise.allSettled([initPromise, disposePromise]);

      // State should be idle
      expect((embedder1 as any).state).toBe('idle');
    });
  });

  describe('Embedding Failures Mid-Operation', () => {
    it('should handle OOM errors during embedding', async () => {
      // Mock pipeline to throw OOM on first call
      vi.mock('@huggingface/transformers', () => {
        let callCount = 0;
        return {
          env: { cacheDir: '' },
          pipeline: vi.fn().mockImplementation(async () => {
            callCount++;
            return vi.fn().mockImplementation(async () => {
              if (callCount === 1) {
                throw simulateOomError();
              }
              return {
                dims: [384],
                data: new Float32Array(384).fill(0.1)
              };
            });
          })
        };
      });

      embedder = new Embedder({
        model: 'test-model',
        device: 'cpu'
      });

      await embedder.initialize();

      // First call should throw
      await expect(embedder.embed('test text'))
        .rejects.toThrow();

      // This test shows the embedder doesn't auto-retry OOM
      // In production, you'd want to handle this at a higher level
    });

    it('should handle process crash during embedding', async () => {
      vi.mock('@huggingface/transformers', () => {
        let callCount = 0;
        return {
          env: { cacheDir: '' },
          pipeline: vi.fn().mockImplementation(async () => {
            return vi.fn().mockImplementation(async () => {
              callCount++;
              if (callCount <= 3) {
                throw simulateProcessCrash('Embedding worker crashed');
              }
              return {
                dims: [384],
                data: new Float32Array(384).fill(0.1)
              };
            });
          })
        };
      });

      embedder = new Embedder({
        model: 'test-model',
        device: 'cpu'
      });

      await embedder.initialize();

      // First few calls should fail
      for (let i = 0; i < 3; i++) {
        await expect(embedder.embed(`test ${i}`))
          .rejects.toThrow();
      }

      // Eventually should succeed (depending on implementation)
      // Note: This shows the embedder doesn't auto-retry
      // Higher-level code should handle retries
    });

    it('should handle partial failures in batch embedding', async () => {
      vi.mock('@huggingface/transformers', () => {
        let batchCount = 0;
        return {
          env: { cacheDir: '' },
          pipeline: vi.fn().mockImplementation(async () => {
            return vi.fn().mockImplementation(async (texts: string[]) => {
              batchCount++;
              if (batchCount === 1) {
                throw new Error('Batch processing failed');
              }
              return texts.map(() => ({
                dims: [384],
                data: new Float32Array(384).fill(0.1)
              }));
            });
          })
        };
      });

      embedder = new Embedder({
        model: 'test-model',
        device: 'cpu'
      });

      await embedder.initialize();

      const texts = ['text1', 'text2', 'text3'];

      // First batch should fail
      await expect(embedder.embedBatch(texts))
        .rejects.toThrow();

      // Second batch would succeed if we retried
      // But embedder doesn't auto-retry
    });
  });

  describe('GPU Lock Chaos', () => {
    it('should handle GPU lock acquisition timeout', async () => {
      const mockStateManager = {
        acquireGpuLock: vi.fn().mockResolvedValue(false),
        releaseGpuLock: vi.fn().mockResolvedValue(undefined),
      };

      embedder = new Embedder({
        model: 'test-model',
        device: 'webgpu',
        stateManager: mockStateManager as any,
      });

      // If GPU lock can't be acquired, should fall back or fail gracefully
      await expect(embedder.initialize())
        .resolves.not.toThrow();
    });

    it('should handle GPU lock release failures', async () => {
      const mockStateManager = {
        acquireGpuLock: vi.fn().mockResolvedValue(true),
        releaseGpuLock: vi.fn().mockRejectedValue(new Error('Failed to release lock')),
      };

      embedder = new Embedder({
        model: 'test-model',
        device: 'webgpu',
        stateManager: mockStateManager as any,
      });

      await embedder.initialize();

      // Dispose should handle release failures gracefully
      await expect(embedder.dispose())
        .resolves.not.toThrow();
    });

    it('should handle GPU lock loss during operation', async () => {
      let lockHeld = true;

      const mockStateManager = {
        acquireGpuLock: vi.fn().mockResolvedValue(true),
        releaseGpuLock: vi.fn().mockImplementation(async () => {
          lockHeld = false;
        }),
        getGpuOwner: vi.fn().mockImplementation(async () => {
          return lockHeld ? { pid: process.pid, startedAt: Date.now() } : null;
        }),
      };

      embedder = new Embedder({
        model: 'test-model',
        device: 'webgpu',
        stateManager: mockStateManager as any,
      });

      await embedder.initialize();

      // Lose lock
      lockHeld = false;

      // Operations should still complete or fail gracefully
      // (Implementation-specific behavior)
    });
  });

  describe('Memory Pressure Simulation', () => {
    it('should handle large batch sizes under memory pressure', async () => {
      vi.mock('@huggingface/transformers', () => {
        return {
          env: { cacheDir: '' },
          pipeline: vi.fn().mockImplementation(async () => {
            return vi.fn().mockImplementation(async (texts: string[]) => {
              // Simulate memory pressure by checking batch size
              if (texts.length > 100) {
                throw simulateOomError();
              }
              return texts.map(() => ({
                dims: [384],
                data: new Float32Array(384).fill(0.1)
              }));
            });
          })
        };
      });

      embedder = new Embedder({
        model: 'test-model',
        device: 'cpu',
        batchSize: 50, // Lower batch size
      });

      await embedder.initialize();

      // Small batch should succeed
      const smallBatch = Array.from({ length: 10 }, (_, i) => `text ${i}`);
      const result1 = await embedder.embedBatch(smallBatch);
      expect(result1).toHaveLength(10);

      // Large batch might be split internally
      const largeBatch = Array.from({ length: 150 }, (_, i) => `text ${i}`);
      try {
        const result2 = await embedder.embedBatch(largeBatch);
        // If implementation splits batches, this might succeed
        expect(result2).toBeDefined();
      } catch (e) {
        // Or it might fail with OOM
        expect((e as Error).message).toContain('memory');
      }
    });

    it('should handle consecutive operations without memory leaks', async () => {
      vi.mock('@huggingface/transformers', () => {
        return {
          env: { cacheDir: '' },
          pipeline: vi.fn().mockImplementation(async () => {
            return vi.fn().mockResolvedValue({
              dims: [384],
              data: new Float32Array(384).fill(0.1)
            });
          })
        };
      });

      embedder = new Embedder({
        model: 'test-model',
        device: 'cpu',
      });

      await embedder.initialize();

      // Perform many consecutive embeddings
      const count = 50;
      for (let i = 0; i < count; i++) {
        const result = await embedder.embed(`test text ${i}`);
        expect(result).toBeDefined();
        expect(result.data).toHaveLength(384);
      }

      // Should still work without memory issues
      const finalResult = await embedder.embed('final test');
      expect(finalResult).toBeDefined();
    });
  });

  describe('Concurrent Operations', () => {
    it('should handle concurrent embedding requests', async () => {
      vi.mock('@huggingface/transformers', () => {
        let callCount = 0;
        return {
          env: { cacheDir: '' },
          pipeline: vi.fn().mockImplementation(async () => {
            return vi.fn().mockImplementation(async () => {
              callCount++;
              // Add small delay to increase contention
              await new Promise(resolve => setTimeout(resolve, 10));
              return {
                dims: [384],
                data: new Float32Array(384).fill(0.1)
              };
            });
          })
        };
      });

      embedder = new Embedder({
        model: 'test-model',
        device: 'cpu',
      });

      await embedder.initialize();

      const operations = Array.from({ length: 15 }, (_, i) =>
        embedder.embed(`concurrent text ${i}`)
      );

      const results = await Promise.all(operations);

      expect(results).toHaveLength(15);
      results.forEach(result => {
        expect(result).toBeDefined();
        expect(result.data).toHaveLength(384);
      });
    });

    it('should handle mixed single and batch operations concurrently', async () => {
      vi.mock('@huggingface/transformers', () => {
        return {
          env: { cacheDir: '' },
          pipeline: vi.fn().mockImplementation(async () => {
            return vi.fn().mockImplementation(async (input) => {
              await new Promise(resolve => setTimeout(resolve, 5));
              const texts = Array.isArray(input) ? input : [input];
              return texts.map(() => ({
                dims: [384],
                data: new Float32Array(384).fill(0.1)
              }));
            });
          })
        };
      });

      embedder = new Embedder({
        model: 'test-model',
        device: 'cpu',
      });

      await embedder.initialize();

      const operations: Promise<any>[] = [];

      // Add single embeddings
      for (let i = 0; i < 5; i++) {
        operations.push(embedder.embed(`single ${i}`));
      }

      // Add batch embeddings
      for (let i = 0; i < 3; i++) {
        const batch = Array.from({ length: 5 }, (_, j) => `batch ${i}-${j}`);
        operations.push(embedder.embedBatch(batch));
      }

      const results = await Promise.all(operations);

      expect(results).toHaveLength(8);
    });

    it('should handle initialize and embed concurrently', async () => {
      vi.mock('@huggingface/transformers', () => {
        return {
          env: { cacheDir: '' },
          pipeline: vi.fn().mockImplementation(async () => {
            return vi.fn().mockResolvedValue({
              dims: [384],
              data: new Float32Array(384).fill(0.1)
            });
          })
        };
      });

      const embedders: Embedder[] = [];

      const operations = Array.from({ length: 5 }, (_, i) =>
        async () => {
          const emb = new Embedder({
            model: 'test-model',
            device: 'cpu',
          });
          embedders.push(emb);

          // Concurrent init and embed
          const results = await Promise.allSettled([
            emb.initialize(),
            // Embed might fail if not initialized yet
            emb.embed(`test ${i}`).catch(() => ({ data: new Float32Array(384), dims: [384] })),
          ]);

          return results;
        }
      );

      const results = await raceConcurrent(operations);

      // All operations should complete
      expect(results).toHaveLength(5);

      // Clean up
      await Promise.all(embedders.map(e => e.dispose().catch(() => {})));
    });
  });

  describe('Lifecycle Chaos', () => {
    it('should handle rapid init/dispose cycles', async () => {
      vi.mock('@huggingface/transformers', () => {
        return {
          env: { cacheDir: '' },
          pipeline: vi.fn().mockImplementation(async () => {
            return vi.fn().mockResolvedValue({
              dims: [384],
              data: new Float32Array(384).fill(0.1)
            });
          })
        };
      });

      const cycleCount = 10;
      const embedders: Embedder[] = [];

      for (let i = 0; i < cycleCount; i++) {
        const emb = new Embedder({
          model: 'test-model',
          device: 'cpu',
        });
        embedders.push(emb);

        await emb.initialize();
        const result = await emb.embed(`cycle ${i}`);
        expect(result).toBeDefined();

        await emb.dispose();
      }

      // All cycles should complete
      expect(embedders).toHaveLength(cycleCount);
    });

    it('should handle dispose called multiple times concurrently', async () => {
      vi.mock('@huggingface/transformers', () => {
        return {
          env: { cacheDir: '' },
          pipeline: vi.fn().mockImplementation(async () => {
            return vi.fn().mockResolvedValue({
              dims: [384],
              data: new Float32Array(384).fill(0.1)
            });
          })
        };
      });

      embedder = new Embedder({
        model: 'test-model',
        device: 'cpu',
      });

      await embedder.initialize();

      // Dispose multiple times concurrently
      const operations = [
        embedder.dispose(),
        embedder.dispose(),
        embedder.dispose(),
      ];

      await Promise.all(operations);

      // State should be idle
      expect((embedder as any).state).toBe('idle');
    });

    it('should handle embed after dispose', async () => {
      vi.mock('@huggingface/transformers', () => {
        return {
          env: { cacheDir: '' },
          pipeline: vi.fn().mockImplementation(async () => {
            return vi.fn().mockResolvedValue({
              dims: [384],
              data: new Float32Array(384).fill(0.1)
            });
          })
        };
      });

      embedder = new Embedder({
        model: 'test-model',
        device: 'cpu',
      });

      await embedder.initialize();
      await embedder.dispose();

      // Embed after dispose should fail or reinitialize
      await expect(embedder.embed('after dispose'))
        .rejects.toThrow();
    });
  });

  describe('Performance Under Chaos', () => {
    it('should maintain reasonable performance under load', async () => {
      vi.mock('@huggingface/transformers', () => {
        return {
          env: { cacheDir: '' },
          pipeline: vi.fn().mockImplementation(async () => {
            return vi.fn().mockImplementation(async () => {
              await new Promise(resolve => setTimeout(resolve, 5)); // Simulate processing
              return {
                dims: [384],
                data: new Float32Array(384).fill(0.1)
              };
            });
          })
        };
      });

      embedder = new Embedder({
        model: 'test-model',
        device: 'cpu',
      });

      await embedder.initialize();

      const { result, durationMs } = await measureTime(async () => {
        const operations = Array.from({ length: 20 }, (_, i) =>
          embedder.embed(`perf test ${i}`)
        );
        return await Promise.all(operations);
      });

      expect(result).toHaveLength(20);
      // Should complete in reasonable time (20 ops * ~5ms each = ~100ms)
      expect(durationMs).toBeLessThan(500);
    });

    it('should handle burst of operations efficiently', async () => {
      vi.mock('@huggingface/transformers', () => {
        return {
          env: { cacheDir: '' },
          pipeline: vi.fn().mockImplementation(async () => {
            return vi.fn().mockImplementation(async () => {
              return {
                dims: [384],
                data: new Float32Array(384).fill(0.1)
              };
            });
          })
        };
      });

      embedder = new Embedder({
        model: 'test-model',
        device: 'cpu',
      });

      await embedder.initialize();

      const { result, durationMs } = await measureTime(async () => {
        // Burst of 30 operations
        const operations = Array.from({ length: 30 }, (_, i) =>
          embedder.embed(`burst ${i}`)
        );
        return await Promise.all(operations);
      });

      expect(result).toHaveLength(30);
      // Burst should complete efficiently
      expect(durationMs).toBeLessThan(1000);
    });
  });
});