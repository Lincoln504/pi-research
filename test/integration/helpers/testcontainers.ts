/**
 * Testcontainers Helper for Integration Tests
 *
 * Provides utilities for running SearXNG container during integration tests.
 */

import { GenericContainer, type StartedTestContainer } from 'testcontainers';

export interface SearxngContainerConfig {
  image?: string;
  tag?: string;
  port?: number;
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

/**
 * Get default Searxng container configuration
 */
export function getDefaultConfig(): SearxngContainerConfig {
  return {
    image: 'searxng/searxng',
    tag: 'latest',
    port: 8080,
  };
}

/**
 * Start a Searxng container using Testcontainers
 *
 * @param config Optional container configuration
 * @returns Promise resolving to container info and cleanup function
 */
export async function startSearxngContainer(
  config: SearxngContainerConfig = {}
): Promise<SearxngContainer> {
  const finalConfig = { ...getDefaultConfig(), ...config };

  const imageWithTag = `${finalConfig.image}:${finalConfig.tag ?? 'latest'}`;

  console.log(`Starting Searxng container: ${imageWithTag}`);

  const container = new GenericContainer(imageWithTag)
    .withExposedPorts(finalConfig.port ?? 8080)
    .withStartupTimeout(120000); // 2 minute startup timeout

  const startedContainer = await container.start();
  const port = startedContainer.getMappedPort(finalConfig.port ?? 8080);
  const host = startedContainer.getHost();

  const url = `http://${host}:${port}`;

  console.log(`Searxng container started at ${url}`);

  return {
    container: startedContainer,
    url,
    host,
    port,
    stop: async () => {
      console.log(`Stopping Searxng container at ${url}`);
      await startedContainer.stop();
    },
  };
}

/**
 * Perform a search query against Searxng using GET request
 *
 * @param url The Searxng URL
 * @param query Search query string
 * @param options Optional search parameters
 * @returns Promise resolving to search results
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
  } = {}
): Promise<SearchResults> {
  // Build URL with query parameters (using GET as per SearXNG API)
  const searchUrl = new URL(`${url}/search`);
  searchUrl.searchParams.append('q', query);
  searchUrl.searchParams.append('format', options.format ?? 'json');

  if (options.language) {
    searchUrl.searchParams.append('language', options.language);
  }
  if (options.time_range) {
    searchUrl.searchParams.append('time_range', options.time_range);
  }
  if (options.safesearch !== undefined) {
    searchUrl.searchParams.append('safesearch', options.safesearch.toString());
  }
  if (options.categories) {
    searchUrl.searchParams.append('categories', options.categories.join(','));
  }
  if (options.pageno !== undefined) {
    searchUrl.searchParams.append('pageno', options.pageno.toString());
  }

  const response = await fetch(searchUrl.toString(), {
    method: 'GET',
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Searxng search failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data as SearchResults;
}

/**
 * Check if Searxng is ready by attempting a simple search
 *
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
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Try a simple GET request to the root
      const getResponse = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (getResponse.ok) {
        console.log(`Searxng is responding (GET) after ${attempt + 1} attempt(s)`);
        return;
      }
    } catch (error) {
      if (attempt === maxAttempts - 1) {
        throw new Error(`Searxng not ready after ${maxAttempts} attempts: ${error}`);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Searxng not ready after ${maxAttempts} attempts`);
}

/**
 * Get search engines available in Searxng
 *
 * @param url The Searxng URL
 * @returns Promise resolving to list of available engines
 */
export async function getEngines(url: string): Promise<any[]> {
  const response = await fetch(`${url}/config`, {
    method: 'GET',
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Failed to get Searxng config: ${response.status} ${response.statusText}`);
  }

  const config = await response.json();
  return config.engines || [];
}
