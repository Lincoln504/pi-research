/**
 * Unit Test Setup
 *
 * Runs before each unit test suite.
 * Resets module-level state and suppresses console output.
 */

import { beforeEach, afterEach, vi } from 'vitest';

// Reset all module-level state before each test
beforeEach(() => {
  // Reset any module-level state here
  // This will be populated as we refactor modules to support reset
});

afterEach(() => {
  vi.clearAllMocks();
});

// Suppress console output in tests unless explicitly enabled
if (!process.env['VITEST_VERBOSE']) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}
