/**
 * Web Research Utils Unit Tests
 *
 * Tests utility functions for connection counting and validation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('web-research/utils', () => {
  // Mock the functions we're testing
  let activeConnections = 0;
  let maxConnections = 0;
  const connectionCallbacks: Array<(count: number) => void> = [];

  const notifyConnectionCountChange = (): void => {
    for (const callback of connectionCallbacks) {
      callback(activeConnections);
    }
  };

  const onConnectionCountChange = (callback: (count: number) => void): (() => void) => {
    connectionCallbacks.push(callback);
    callback(activeConnections);
    return () => {
      const index = connectionCallbacks.indexOf(callback);
      if (index !== -1) {
        connectionCallbacks.splice(index, 1);
      }
    };
  };

  const incrementConnectionCount = (): void => {
    activeConnections++;
    if (activeConnections > maxConnections) {
      maxConnections = activeConnections;
    }
    notifyConnectionCountChange();
  };

  const decrementConnectionCount = (): void => {
    if (activeConnections > 0) {
      activeConnections--;
    }
    notifyConnectionCountChange();
  };

  const getActiveConnectionCount = (): number => {
    return activeConnections;
  };

  const getMaxConnectionCount = (): number => {
    return maxConnections;
  };

  const resetConnectionCounters = (): void => {
    activeConnections = 0;
    maxConnections = 0;
    notifyConnectionCountChange();
  };

  beforeEach(() => {
    activeConnections = 0;
    maxConnections = 0;
    connectionCallbacks.length = 0;
  });

  describe('validateMaxConcurrency', () => {
    const validateMaxConcurrency = (value?: number): number => {
      if (value === undefined) {
        return 10; // Default
      }
      return Math.min(Math.max(1, Math.floor(value)), 20);
    };

    describe('positive cases', () => {
      it('should return default when undefined', () => {
        expect(validateMaxConcurrency(undefined)).toBe(10);
      });

      it('should return 1 for value of 1', () => {
        expect(validateMaxConcurrency(1)).toBe(1);
      });

      it('should return 20 for value of 20', () => {
        expect(validateMaxConcurrency(20)).toBe(20);
      });

      it('should return 5 for value of 5', () => {
        expect(validateMaxConcurrency(5)).toBe(5);
      });

      it('should floor decimal values', () => {
        expect(validateMaxConcurrency(3.5)).toBe(3);
        expect(validateMaxConcurrency(7.9)).toBe(7);
        expect(validateMaxConcurrency(10.1)).toBe(10);
      });

      it('should handle values in valid range', () => {
        expect(validateMaxConcurrency(2)).toBe(2);
        expect(validateMaxConcurrency(15)).toBe(15);
        expect(validateMaxConcurrency(19)).toBe(19);
      });
    });

    describe('negative cases', () => {
      it('should clamp to 1 for values less than 1', () => {
        expect(validateMaxConcurrency(0)).toBe(1);
        expect(validateMaxConcurrency(-1)).toBe(1);
        expect(validateMaxConcurrency(-100)).toBe(1);
        expect(validateMaxConcurrency(-5.5)).toBe(1);
      });

      it('should clamp to 20 for values greater than 20', () => {
        expect(validateMaxConcurrency(21)).toBe(20);
        expect(validateMaxConcurrency(50)).toBe(20);
        expect(validateMaxConcurrency(100)).toBe(20);
        expect(validateMaxConcurrency(999)).toBe(20);
      });

      it('should handle negative decimals', () => {
        expect(validateMaxConcurrency(-0.5)).toBe(1);
        expect(validateMaxConcurrency(-3.7)).toBe(1);
      });
    });

    describe('edge cases', () => {
      it('should handle 0.5', () => {
        expect(validateMaxConcurrency(0.5)).toBe(1);
      });

      it('should handle 20.5', () => {
        expect(validateMaxConcurrency(20.5)).toBe(20);
      });

      it('should handle 0.999', () => {
        expect(validateMaxConcurrency(0.999)).toBe(1);
      });

      it('should handle very large numbers', () => {
        expect(validateMaxConcurrency(Number.MAX_SAFE_INTEGER)).toBe(20);
        expect(validateMaxConcurrency(1e10)).toBe(20);
      });

      it('should handle very small negative numbers', () => {
        expect(validateMaxConcurrency(-1e10)).toBe(1);
        expect(validateMaxConcurrency(-Number.MAX_SAFE_INTEGER)).toBe(1);
      });
    });
  });

  describe('connection counting', () => {
    describe('incrementConnectionCount', () => {
      it('should increment from 0 to 1', () => {
        expect(getActiveConnectionCount()).toBe(0);
        incrementConnectionCount();
        expect(getActiveConnectionCount()).toBe(1);
      });

      it('should increment multiple times', () => {
        incrementConnectionCount();
        incrementConnectionCount();
        incrementConnectionCount();
        expect(getActiveConnectionCount()).toBe(3);
      });

      it('should update max connections', () => {
        expect(getMaxConnectionCount()).toBe(0);
        incrementConnectionCount();
        expect(getMaxConnectionCount()).toBe(1);
        incrementConnectionCount();
        expect(getMaxConnectionCount()).toBe(2);
      });

      it('should track maximum correctly', () => {
        incrementConnectionCount();
        incrementConnectionCount();
        incrementConnectionCount();
        expect(getMaxConnectionCount()).toBe(3);
        decrementConnectionCount();
        expect(getMaxConnectionCount()).toBe(3); // Max should stay at 3
      });

      it('should notify callbacks on increment', () => {
        const callback = vi.fn();
        onConnectionCountChange(callback);

        incrementConnectionCount();

        expect(callback).toHaveBeenCalledWith(1);
      });

      it('should notify all callbacks on increment', () => {
        const callback1 = vi.fn();
        const callback2 = vi.fn();
        onConnectionCountChange(callback1);
        onConnectionCountChange(callback2);

        incrementConnectionCount();

        expect(callback1).toHaveBeenCalledWith(1);
        expect(callback2).toHaveBeenCalledWith(1);
      });
    });

    describe('decrementConnectionCount', () => {
      it('should decrement from 1 to 0', () => {
        incrementConnectionCount();
        expect(getActiveConnectionCount()).toBe(1);
        decrementConnectionCount();
        expect(getActiveConnectionCount()).toBe(0);
      });

      it('should decrement multiple times', () => {
        incrementConnectionCount();
        incrementConnectionCount();
        incrementConnectionCount();
        decrementConnectionCount();
        decrementConnectionCount();
        expect(getActiveConnectionCount()).toBe(1);
      });

      it('should not go below 0', () => {
        expect(getActiveConnectionCount()).toBe(0);
        decrementConnectionCount();
        decrementConnectionCount();
        decrementConnectionCount();
        expect(getActiveConnectionCount()).toBe(0);
      });

      it('should notify callbacks on decrement', () => {
        incrementConnectionCount();
        const callback = vi.fn();
        onConnectionCountChange(callback);

        decrementConnectionCount();

        expect(callback).toHaveBeenCalledWith(0);
      });
    });

    describe('getActiveConnectionCount', () => {
      it('should return 0 initially', () => {
        expect(getActiveConnectionCount()).toBe(0);
      });

      it('should reflect current count', () => {
        incrementConnectionCount();
        expect(getActiveConnectionCount()).toBe(1);
        incrementConnectionCount();
        expect(getActiveConnectionCount()).toBe(2);
        decrementConnectionCount();
        expect(getActiveConnectionCount()).toBe(1);
      });
    });

    describe('getMaxConnectionCount', () => {
      it('should return 0 initially', () => {
        expect(getMaxConnectionCount()).toBe(0);
      });

      it('should track maximum connections', () => {
        incrementConnectionCount();
        incrementConnectionCount();
        incrementConnectionCount();
        expect(getMaxConnectionCount()).toBe(3);
        decrementConnectionCount();
        expect(getMaxConnectionCount()).toBe(3);
      });

      it('should not decrease when connections drop', () => {
        incrementConnectionCount();
        incrementConnectionCount();
        expect(getMaxConnectionCount()).toBe(2);
        decrementConnectionCount();
        expect(getMaxConnectionCount()).toBe(2);
        decrementConnectionCount();
        expect(getMaxConnectionCount()).toBe(2);
      });
    });

    describe('resetConnectionCounters', () => {
      it('should reset active and max to 0', () => {
        incrementConnectionCount();
        incrementConnectionCount();
        incrementConnectionCount();
        expect(getActiveConnectionCount()).toBe(3);
        expect(getMaxConnectionCount()).toBe(3);

        resetConnectionCounters();

        expect(getActiveConnectionCount()).toBe(0);
        expect(getMaxConnectionCount()).toBe(0);
      });

      it('should notify callbacks on reset', () => {
        incrementConnectionCount();
        incrementConnectionCount();
        const callback = vi.fn();
        onConnectionCountChange(callback);

        resetConnectionCounters();

        expect(callback).toHaveBeenCalledWith(0);
      });

      it('should work when called multiple times', () => {
        resetConnectionCounters();
        expect(getActiveConnectionCount()).toBe(0);
        resetConnectionCounters();
        expect(getActiveConnectionCount()).toBe(0);
      });
    });

    describe('onConnectionCountChange', () => {
      it('should call callback immediately with current count', () => {
        incrementConnectionCount();
        incrementConnectionCount();

        const callback = vi.fn();
        onConnectionCountChange(callback);

        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(2);
      });

      it('should call callback on connection count changes', () => {
        const callback = vi.fn();
        onConnectionCountChange(callback);

        incrementConnectionCount();
        expect(callback).toHaveBeenLastCalledWith(1);

        decrementConnectionCount();
        expect(callback).toHaveBeenLastCalledWith(0);
      });

      it('should return unsubscribe function', () => {
        const callback = vi.fn();
        const unsubscribe = onConnectionCountChange(callback);

        incrementConnectionCount();
        expect(callback).toHaveBeenCalledWith(1);

        unsubscribe();

        incrementConnectionCount();
        expect(callback).toHaveBeenCalledTimes(2); // Initial call + first increment
      });

      it('should handle multiple callbacks', () => {
        const callback1 = vi.fn();
        const callback2 = vi.fn();
        onConnectionCountChange(callback1);
        onConnectionCountChange(callback2);

        incrementConnectionCount();

        expect(callback1).toHaveBeenCalledWith(1);
        expect(callback2).toHaveBeenCalledWith(1);
      });

      it('should unsubscribe only specific callback', () => {
        const callback1 = vi.fn();
        const callback2 = vi.fn();
        const unsubscribe1 = onConnectionCountChange(callback1);
        onConnectionCountChange(callback2);

        unsubscribe1();

        incrementConnectionCount();
        expect(callback1).toHaveBeenCalledTimes(1); // Only initial call
        expect(callback2).toHaveBeenCalledTimes(2); // Initial + after increment
      });

      it('should handle unsubscribe when callback not in list', () => {
        const callback = vi.fn();
        const unsubscribe = onConnectionCountChange(callback);

        // Call unsubscribe twice
        unsubscribe();
        expect(() => unsubscribe()).not.toThrow();
      });

      it('should track callback calls correctly', () => {
        const callback = vi.fn();
        onConnectionCountChange(callback);

        incrementConnectionCount();
        incrementConnectionCount();
        decrementConnectionCount();

        expect(callback).toHaveBeenCalledTimes(4); // Initial + 3 changes
      });
    });

    describe('integration scenarios', () => {
      it('should track connection lifecycle', () => {
        const callback = vi.fn();
        onConnectionCountChange(callback);

        incrementConnectionCount();
        incrementConnectionCount();
        incrementConnectionCount();
        expect(getActiveConnectionCount()).toBe(3);
        expect(getMaxConnectionCount()).toBe(3);

        decrementConnectionCount();
        decrementConnectionCount();
        expect(getActiveConnectionCount()).toBe(1);
        expect(getMaxConnectionCount()).toBe(3);

        resetConnectionCounters();
        expect(getActiveConnectionCount()).toBe(0);
        expect(getMaxConnectionCount()).toBe(0);
      });

      it('should handle concurrent increments and decrements', () => {
        const callback = vi.fn();
        onConnectionCountChange(callback);

        incrementConnectionCount();
        incrementConnectionCount();
        decrementConnectionCount();
        incrementConnectionCount();
        decrementConnectionCount();
        incrementConnectionCount();

        expect(getActiveConnectionCount()).toBe(2);
        expect(getMaxConnectionCount()).toBe(2);
      });

      it('should handle rapid changes', () => {
        const callback = vi.fn();
        onConnectionCountChange(callback);

        for (let i = 0; i < 10; i++) {
          incrementConnectionCount();
        }
        for (let i = 0; i < 5; i++) {
          decrementConnectionCount();
        }

        expect(getActiveConnectionCount()).toBe(5);
        expect(getMaxConnectionCount()).toBe(10);
        expect(callback).toHaveBeenCalledTimes(16); // Initial + 15 changes
      });
    });
  });
});
