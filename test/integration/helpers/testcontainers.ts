/**
 * Testcontainers Helper for Integration Tests
 *
 * Provides utilities for running SearXNG container during integration tests.
 * Includes retry logic, proper timeout handling, and robust error management.
 */

import { GenericContainer, type StartedTestContainer, type GenericContainer as GenericContainerType } from 'testcontainers';
import { setTimeout as sleep } from 'node:timers/promises';

export interface SearxngContainerConfig {
  image?: string;
  tag?: string;
  port?: number;
  startupTimeout?: number;
  healthCheckTimeout?: number;
  maxHealthCheckAttempts?: number;
  healthCheckInterval?: number;
}

export interface SearxngContainer {
  container: StartedTestContainer;
  url: string;
  host: string;
  port: number;
  stop: () => Promise<void>;
}

export interface SearchResults {
  query: string;
  results: SearchResult[];
  answers?: {
    answer: string;
    url: string;
  }[];
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  engine?: string;
  score?: number;
}

export interface HealthCheckOptions {
  maxAttempts?: number;
  interval?: number;
  timeout?: number;
}

const DEFAULT_CONFIG: Required<SearxngContainerConfig> = {
  image: 'searxng/searxng',
  tag: process.env['SEARXNG_IMAGE_TAG']?.trim() || 'latest',
  port: 8080,
  startupTimeout: 60000, // 1 minute (reduced from 2)
  healthCheckTimeout: 5000, // 5 seconds per check (reduced from 10)
  maxHealthCheckAttempts: 30, // Up to 30 seconds total (reduced from 60)
  healthCheckInterval: 1000, // 1 second
};

/**
 * Get default Searxng container configuration
 */
export function getDefaultConfig(): SearxngContainerConfig {
  return { ...DEFAULT_CONFIG };
}

/**
 * Validate container configuration
 */
function validateConfig(config: SearxngContainerConfig): Required<SearxngContainerConfig> {
  const merged = { ...DEFAULT_CONFIG, ...config };
  
  if (merged.port < 1 || merged.port > 65535) {
    throw new Error(`Invalid port: ${merged.port}. Must be between 1 and 65535.`);
  }
  
  if (merged.startupTimeout < 1000) {
    throw new Error(`Startup timeout too low: ${merged.startupTimeout}ms. Minimum: 1000ms.`);
  }
  
  if (merged.maxHealthCheckAttempts < 1) {
    throw new Error(`Max health check attempts must be at least 1.`);
  }
  
  if (merged.healthCheckInterval < 100) {
    throw new Error(`Health check interval too low: ${merged.healthCheckInterval}ms. Minimum: 100ms.`);
  }
  
  return merged;
}

/**
 * Perform a health check on the Searxng container
 *
 * @param url The Searxng URL
 * @param options Health check options
 * @returns Promise that resolves if healthy, rejects otherwise
 */
async function healthCheck(
  url: string,
  options: HealthCheckOptions = {}
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_CONFIG.maxHealthCheckAttempts;
  const interval = options.interval ?? DEFAULT_CONFIG.healthCheckInterval;
  const timeout = options.timeout ?? DEFAULT_CONFIG.healthCheckTimeout;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      // Try a simple GET request to the root
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'follow',
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        console.log(`[testcontainers] Searxng health check passed after ${attempt + 1} attempt(s)`);
        return;
      }

      lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (attempt === maxAttempts - 1) {
        break;
      }
    }

    // Wait before retrying
    await sleep(interval);
  }

  throw new Error(
    `Searxng health check failed after ${maxAttempts} attempts. Last error: ${lastError?.message}`
  );
}

/**
 * Start a Searxng container using Testcontainers
 *
 * @param config Optional container configuration
 * @returns Promise resolving to container info and cleanup function
 * @throws Error if container fails to start or health check fails
 */
export async function startSearxngContainer(
  config: SearxngContainerConfig = {}
): Promise<SearxngContainer> {
  const finalConfig = validateConfig(config);
  const imageWithTag = `${finalConfig.image}:${finalConfig.tag}`;

  console.log(`[testcontainers] Starting Searxng container: ${imageWithTag}`);

  const startTime = Date.now();

  try {
    const container: GenericContainerType = new GenericContainer(imageWithTag)
      .withExposedPorts(finalConfig.port)
      .withEnvironment({
        SEARXNG_SETTINGS: JSON.stringify({
          server: {
            secret_key: 'test-secret-key-for-integration-tests-only',
            limiter: false,
            methods: ['GET', 'POST'],
          },
          search: {
            safe_search: 0,
            autocomplete: '',
          },
          ui: {
            theme_args: {
              simple_style: 'auto',
            },
          },
        }),
      })
      .withStartupTimeout(finalConfig.startupTimeout)
      .withWaitStrategy(
        // Use custom wait strategy - just wait for the port to be exposed
        async (container) => {
          const port = container.getMappedPort(finalConfig.port);
          const host = container.getHost();
          const url = `http://${host}:${port}`;
          
          console.log(`[testcontainers] Waiting for Searxng at ${url}...`);
          await healthCheck(url, {
            maxAttempts: finalConfig.maxHealthCheckAttempts,
            interval: finalConfig.healthCheckInterval,
            timeout: finalConfig.healthCheckTimeout,
          });
        }
      );

    const startedContainer = await container.start();
    const port = startedContainer.getMappedPort(finalConfig.port);
    const host = startedContainer.getHost();
    const url = `http://${host}:${port}`;

    const elapsed = Date.now() - startTime;
    console.log(`[testcontainers] Searxng container started in ${elapsed}ms at ${url}`);

    return {
      container: startedContainer,
      url,
      host,
      port,
      stop: async () => {
        console.log(`[testcontainers] Stopping Searxng container at ${url}`);
        const stopStartTime = Date.now();
        await startedContainer.stop();
        const stopElapsed = Date.now() - stopStartTime;
        console.log(`[testcontainers] Searxng container stopped in ${stopElapsed}ms`);
      },
    };
  } catch (error) {
    const elapsed = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to start Searxng container after ${elapsed}ms: ${errorMsg}`
    );
  }
}

/**
 * Perform a search query against Searxng using GET request
 *
 * @param url The Searxng URL
 * @param query Search query string
 * @param options Optional search parameters
 * @returns Promise resolving to search results
 * @throws Error if search fails
 */
export async function search(
  url: string,
  query: string,
  options: {
    format?: 'json' | 'csv' | 'rss';
    language?: string;
    time_range?: 'day' | 'week' | 'month' | 'year';
    safesearch?: number;
    categories?: string[];
    pageno?: number;
    timeout?: number;
  } = {}
): Promise<SearchResults> {
  const {
    format = 'json',
    language,
    time_range,
    safesearch,
    categories,
    pageno,
    timeout = 10000,
  } = options;

  // Build URL with query parameters (using GET as per SearXNG API)
  const searchUrl = new URL(`${url}/search`);
  searchUrl.searchParams.append('q', query);
  searchUrl.searchParams.append('format', format);

  if (language) {
    searchUrl.searchParams.append('language', language);
  }
  if (time_range) {
    searchUrl.searchParams.append('time_range', time_range);
  }
  if (safesearch !== undefined) {
    searchUrl.searchParams.append('safesearch', safesearch.toString());
  }
  if (categories) {
    searchUrl.searchParams.append('categories', categories.join(','));
  }
  if (pageno !== undefined) {
    searchUrl.searchParams.append('pageno', pageno.toString());
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(searchUrl.toString(), {
      method: 'GET',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Searxng search failed: HTTP ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as SearchResults;
    return data;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Check if Searxng is ready by attempting a simple search
 * 
 * @deprecated Use waitForSearxngReady instead for more robust health checking
 * @param url The Searxng URL
 * @param maxAttempts Maximum number of attempts (default: 30)
 * @param intervalMs Interval between attempts in milliseconds (default: 1000)
 * @returns Promise that resolves when Searxng is ready
 */
export async function waitForSearxngReady(
  url: string,
  maxAttempts: number = 30,
  intervalMs: number = 1000
): Promise<void> {
  await healthCheck(url, {
    maxAttempts,
    interval: intervalMs,
    timeout: 5000,
  });
}

/**
 * Get search engines available in Searxng
 *
 * @param url The Searxng URL
 * @param timeout Request timeout in milliseconds (default: 10000)
 * @returns Promise resolving to list of available engines
 * @throws Error if config fetch fails
 */
export async function getEngines(url: string, timeout: number = 10000): Promise<any[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${url}/config`, {
      method: 'GET',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to get Searxng config: HTTP ${response.status} ${response.statusText}`);
    }

    const config = await response.json() as Record<string, unknown>;
    return (config['engines'] as unknown[]) || [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Perform a basic connectivity check to Searxng
 *
 * @param url The Searxng URL
 * @param timeout Request timeout in milliseconds (default: 5000)
 * @returns Promise resolving to true if connected, false otherwise
 */
export async function checkConnectivity(url: string, timeout: number = 5000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}
