/**
 * Integration Test Setup
 *
 * Runs before and after integration tests.
 * Manages test container lifecycle.
 */

import { beforeAll, afterAll } from 'vitest';

// Global test container references
const containers = new Map<string, any>();

export function registerContainer(name: string, container: any): void {
  containers.set(name, container);
}

export function getContainer(name: string): any {
  return containers.get(name);
}

// Cleanup test containers after all tests
afterAll(async () => {
  const stopPromises = Array.from(containers.values()).map((c: any) => {
    if (c && typeof c.stop === 'function') {
      return c.stop();
    }
    return Promise.resolve();
  });

  await Promise.all(stopPromises);
  containers.clear();
}, 30000);
