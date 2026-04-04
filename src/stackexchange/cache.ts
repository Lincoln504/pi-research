/**
 * Simple file-based cache for Stack Exchange API responses
 */

import * as fs from 'node:fs';
import { logger } from '../logger.js';
import * as path from 'node:path';
import * as os from 'node:os';

const CACHE_DIR = path.join(os.homedir(), '.pi', 'cache', 'stackexchange');

// Lazy-initialize cache directory on first use (prevents race conditions)
let cacheInitialized = false;

function ensureCacheDir(): void {
  if (cacheInitialized) {
    return;
  }
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    cacheInitialized = true;
  } catch {
    // Directory might already exist
    cacheInitialized = true;
  }
}

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

export function cacheGet<T>(key: string): T | null {
  ensureCacheDir();
  try {
    const cachePath = path.join(CACHE_DIR, `${key}.json`);
    const content = fs.readFileSync(cachePath, 'utf-8');
    const entry: CacheEntry<T> = JSON.parse(content) as CacheEntry<T>;

    // Check if cache entry is still valid
    const now = Date.now();
    const age = (now - entry.timestamp) / 1000; // Age in seconds

    if (age > entry.ttl) {
      // Cache expired
      try {
        fs.unlinkSync(cachePath);
      } catch {
        // Ignore errors when deleting expired cache
      }
      return null;
    }

    return entry.data;
  } catch {
    // Cache file doesn't exist or is invalid
    return null;
  }
}

export function cacheSet<T>(key: string, data: T, ttl: number): void {
  ensureCacheDir();
  try {
    const cachePath = path.join(CACHE_DIR, `${key}.json`);
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      ttl,
    };
    fs.writeFileSync(cachePath, JSON.stringify(entry));
  } catch (error) {
    logger.warn('[StackExchange] Failed to write cache:', error);
  }
}

export function cacheClear(): void {
  try {
    const files = fs.readdirSync(CACHE_DIR);
    for (const file of files) {
      fs.unlinkSync(path.join(CACHE_DIR, file));
    }
  } catch (error) {
    logger.warn('[StackExchange] Failed to clear cache:', error);
  }
}

export function cacheGetStats(): { count: number; size: number } {
  try {
    const files = fs.readdirSync(CACHE_DIR);
    let totalSize = 0;
    for (const file of files) {
      const filePath = path.join(CACHE_DIR, file);
      const stats = fs.statSync(filePath);
      totalSize += stats.size;
    }
    return {
      count: files.length,
      size: totalSize,
    };
  } catch {
    return { count: 0, size: 0 };
  }
}

// Sanitize cache keys (replace special characters)
export function sanitizeCacheKey(key: string): string {
  return key
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .substring(0, 100); // Limit length
}
