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
  console.log(`Container logs:`, await startedContainer.logs());

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
 * Wait for Searxng to be ready
 *
 * @param url The Searxng URL
 * @param maxAttempts Maximum number of attempts (default: 60)
 * @param intervalMs Interval between attempts in milliseconds (default: 2000)
 * @returns Promise that resolves when Searxng is ready
 */
export async function waitForSearxngReady(
  url: string,
  maxAttempts: number = 60,
  intervalMs: number = 2000
): Promise<void> {
  const searchUrl = `${url}/search`;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Try GET request first to check if server is up
      const getResponse = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (getResponse.ok) {
        console.log(`Searxng server is responding (GET) after ${attempt + 1} attempt(s)`);
      }

      // Try POST request to search endpoint
      const response = await fetch(searchUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          q: 'test',
          format: 'json',
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        console.log(`Searxng search endpoint is ready after ${attempt + 1} attempt(s)`);
        return;
      } else {
        console.log(`Searxng returned status ${response.status} on attempt ${attempt + 1}/${maxAttempts}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (attempt === maxAttempts - 1) {
        throw new Error(`Searxng not ready after ${maxAttempts} attempts: ${errorMessage}`);
      }
      console.log(`Waiting for Searxng... (${attempt + 1}/${maxAttempts}): ${errorMessage}`);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Searxng not ready after ${maxAttempts} attempts`);
}

/**
 * Perform a test search to verify Searxng is working
 *
 * @param url The Searxng URL
 * @returns Promise resolving to search results
 */
export async function testSearch(url: string): Promise<any> {
  const searchUrl = `${url}/search`;

  console.log(`Performing test search at ${searchUrl}`);

  const response = await fetch(searchUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      q: 'test search',
      format: 'json',
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Searxng search failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  console.log('Searxng test search successful:', JSON.stringify(data, null, 2));

  return data;
}
