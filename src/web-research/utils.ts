/**
 * Web Research Extension - Utilities
 *
 * Helper functions, type guards, and utilities
 */

/**
 * Common module checking utility
 */
export function checkModule(name: string): boolean {
  try {
    import.meta.resolve(name);
    return true;
  } catch {
    return false;
  }
}
