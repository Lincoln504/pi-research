/**
 * Thread Worker Messaging Logic
 *
 * Handles message processing and task execution for the thread worker.
 */

let workerId: string = '';

import { appendFileSync } from 'node:fs';

/**
 * Mutex lock to serialize page creation. Playwright/Firefox can deadlock if newPage()
 * is called concurrently on the exact same context instance.
 */
let pageCreationLock = Promise.resolve();

async function createPageSafe(context: any): Promise<any> {
  let release!: () => void;
  const nextLock = new Promise<void>(resolve => { release = resolve; });
  const currentLock = pageCreationLock;
  pageCreationLock = currentLock.then(() => nextLock);

  await currentLock;
  try {
    return await context.newPage();
  } finally {
    release();
  }
}

/**
 * Set the worker ID for logging purposes
 */
export function setWorkerId(id: string): void {
  workerId = id;
}

/**
 * Log to debug file
 */
function logToDebugFile(level: string, ...args: any[]): void {
  const logFile = process.env['PI_RESEARCH_LOG_FILE'];
  if (!logFile) return;

  try {
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      level,
      workerId,
      message: args.map(arg => {
        if (arg instanceof Error) return arg.stack || arg.message;
        if (typeof arg === 'object' && arg !== null) return JSON.stringify(arg);
        return String(arg);
      }).join(' ')
    };
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  } catch {
    // ignore
  }
}

/**
 * Setup mocking for the browser context if configured via environment variables.
 * This is used in CI to make integration tests fast and reliable without hitting real networks.
 */
export async function setupMocking(context: any): Promise<void> {
  const mockSearch = process.env['PI_RESEARCH_MOCK_SEARCH'] === 'true';
  const mockScrape = process.env['PI_RESEARCH_MOCK_SCRAPE'] === 'true';

  if (!mockSearch && !mockScrape) return;

  logToDebugFile('INFO', `[Worker-${workerId}] Setting up browser mocking (Search: ${mockSearch}, Scrape: ${mockScrape})`);

  await context.route('**', (route: any, request: any) => {
    const url = request.url();

    if (mockSearch && url.includes('duckduckgo.com')) {
      logToDebugFile('DEBUG', `[Worker-${workerId}] Mocking search response for: ${url}`);
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `
          <html><body>
            <form action="/lite/" method="post">
              <input name="q" type="text">
              <input type="submit" value="Search">
            </form>
            <table class="result-link">
              <tr>
                <td><a class="result-link" href="https://example.com/mock-result-1?uddg=https%3A%2F%2Fexample.com%2Ftarget-1">Mock Result 1</a></td>
              </tr>
              <tr>
                <td class="result-snippet">This is a mocked search result snippet for testing purposes.</td>
              </tr>
              <tr>
                <td><a class="result-link" href="https://example.com/mock-result-2?uddg=https%3A%2F%2Fexample.com%2Ftarget-2">Mock Result 2</a></td>
              </tr>
              <tr>
                <td class="result-snippet">Another mocked snippet to verify multiple result extraction.</td>
              </tr>
            </table>
          </body></html>
        `
      });
      return;
    }

    if (mockScrape && !url.includes('duckduckgo.com')) {
      logToDebugFile('DEBUG', `[Worker-${workerId}] Mocking scrape response for: ${url}`);
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<html><body><h1>Mocked Page Content</h1><p>This content was mocked for ${url} during integration testing.</p></body></html>`
      });
      return;
    }

    route.continue();
  });
}

/**
 * Extract search results from DuckDuckGo Lite page
 */
async function extractSearchResults(page: any): Promise<any[]> {
  return await page.evaluate(() => {
    const found: any[] = [];
    // @ts-ignore - document is available in browser context
    // eslint-disable-next-line no-undef
    const links = Array.from(document.querySelectorAll('a.result-link'));
    links.forEach((link: any) => {
      const row = link.closest('tr');
      const snippet = row?.nextElementSibling?.querySelector('td.result-snippet')?.textContent?.trim() || '';
      const title = link.textContent?.trim() || '';
      let url = link.href;
      try {
        const u = new URL(url);
        const uddg = u.searchParams.get('uddg');
        if (uddg) url = decodeURIComponent(uddg || '');
      } catch {
        // ignore
      }
      let urlHostname = '';
        try { urlHostname = new URL(url).hostname; } catch { /* ignore malformed */ }
        if (title && url && urlHostname !== 'duckduckgo.com' && !urlHostname.endsWith('.duckduckgo.com') && url.startsWith('http')) {
        found.push({ title, url, content: snippet });
      }
    });
    return found;
  });
}

/**
 * Execute a search task
 */
export async function executeSearchTask(
  _context: any,
  query: string
): Promise<{ results: any[]; jitter: number }> {
  const page = await createPageSafe(_context);
  const SEARCH_TIMEOUT = 25000;
  page.setDefaultTimeout(SEARCH_TIMEOUT);
  page.setDefaultNavigationTimeout(SEARCH_TIMEOUT);

  try {
    logToDebugFile('DEBUG', `[Worker-${workerId}] Starting search for: ${query}`);
    
    // In mock mode, we jump directly to the results URL to avoid slow form-fill and 
    // interactability checks which can be brittle in CI environments.
    if (process.env['PI_RESEARCH_MOCK_SEARCH'] === 'true') {
      await page.goto(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded' });
    } else {
      // Relaxed timeout to accommodate network latency and concurrent worker load
      await page.goto('https://lite.duckduckgo.com/lite/', { waitUntil: 'domcontentloaded' });
      await page.fill('input[name="q"]', query);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        page.keyboard.press('Enter')
      ]);
    }

    const results = await extractSearchResults(page);

    await page.close();
    
    // Reduce jitter in CI/mock mode to speed up tests
    const jitterBase = process.env['PI_RESEARCH_MOCK_SEARCH'] === 'true' ? 10 : 500;
    const jitterRange = process.env['PI_RESEARCH_MOCK_SEARCH'] === 'true' ? 10 : 1000;
    const jitter = Math.floor(Math.random() * jitterRange) + jitterBase;
    await new Promise(r => setTimeout(r, jitter));

    return { results, jitter };
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
}

/**
 * Execute a scrape task
 */
export async function executeScrapeTask(
  _context: any,
  url: string
): Promise<{ contentType: string; html?: string; buffer?: Buffer; jitter: number }> {
  const page = await createPageSafe(_context);
  const SCRAPE_TIMEOUT = parseInt(process.env['PI_RESEARCH_SCRAPE_TIMEOUT_MS'] || '15000', 10);
  page.setDefaultTimeout(SCRAPE_TIMEOUT);
  page.setDefaultNavigationTimeout(SCRAPE_TIMEOUT);

  try {
    logToDebugFile('DEBUG', `[Worker-${workerId}] Starting scrape for: ${url}`);
    // High-fidelity wait: try domcontentloaded first for speed
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    const contentType = (await response?.headerValue('content-type')) || '';

    if (contentType.includes('application/pdf')) {
      if (!response) throw new Error(`[Worker] No response received for PDF URL: ${url}`);
      const buffer = await response.body();
      await page.close();
      return { contentType, buffer, jitter: 0 };
    }

    // If it's HTML, check if we need to wait longer (JS-heavy sites)
    let html = await page.content();

    // DETECT CLOUDFLARE CHALLENGE
    const cfPatterns = ['_cf_chl_', 'cdn-cgi/challenge-platform', 'cf_chl_opt', 'Just a moment...', 'Checking your browser before accessing'];
    const hasCloudflare = cfPatterns.some((pattern: string) => html.includes(pattern));

    if (hasCloudflare) {
      logToDebugFile('WARN', `[Worker-${workerId}] Cloudflare challenge detected for: ${url}`);

      // Wait up to 5 seconds for challenge to resolve
      try {
        await page.waitForFunction(
          () => {
            // @ts-ignore - document is available in browser context
            // eslint-disable-next-line no-undef
            const body = document.body.innerHTML;
            return !body.includes('_cf_chl_') &&
                   !body.includes('cdn-cgi/challenge-platform') &&
                   !body.includes('cf_chl_opt') &&
                   !body.includes('Just a moment...') &&
                   !body.includes('Checking your browser before accessing') &&
                   body.length > 200; // Ensure content loaded
          },
          { timeout: 5000 }
        );

        // Challenge resolved, get updated content
        html = await page.content();
        logToDebugFile('INFO', `[Worker-${workerId}] Cloudflare challenge resolved for: ${url}`);
      } catch (_waitError: any) {
        logToDebugFile('ERROR', `[Worker-${workerId}] Cloudflare challenge failed for: ${url}`);
        const error = new Error('Fetch blocked: Cloudflare challenge');
        error.cause = _waitError;
        throw error;
      }
    }

    // Check if we need to wait longer for JS-heavy sites
    const needsWait = html.length < 5000 ||
                      html.includes('id="root"') ||
                      html.includes('id="app"') ||
                      html.includes('<noscript>');

    if (needsWait) {
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      html = await page.content();
    }

    // Add request delay jitter to mimic human behavior
    const jitter = Math.floor(Math.random() * 1000) + 500;  // 500-1500ms
    await new Promise(r => setTimeout(r, jitter));

    await page.close();
    return { contentType, html, jitter };
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
}

/**
 * Execute a health check attempt
 */
async function executeHealthCheckAttempt(
  _context: any,
  navTimeoutMs: number
): Promise<{ success: boolean; navMs: number }> {
  const page = await createPageSafe(_context);
  page.setDefaultTimeout(navTimeoutMs);
  page.setDefaultNavigationTimeout(navTimeoutMs);

  try {
    const navStart = Date.now();
    await page.goto('https://lite.duckduckgo.com/lite/', { waitUntil: 'domcontentloaded' });
    const navMs = Date.now() - navStart;

    if (navMs > 3000) {
      logToDebugFile('WARN', `[Worker-${workerId}] DDG Lite navigation was slow: ${navMs}ms (expected <1s). Possible rate-limit or network congestion.`);
    }

    const title = await page.title();
    await page.close();
    return { success: !!title, navMs };
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
}

/**
 * Execute a health check task
 */
export async function executeHealthCheck(
  _context: any,
  initMs: number
): Promise<{ success: boolean; navMs: number }> {
  // Nav timeout: read from env (passed through getBrowserEnv), floor at 10s.
  // The outer BrowserTaskScheduler.runHealthCheck() has its own 45s hard deadline.
  const configuredMs = parseInt(process.env['PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS'] || '0', 10);
  const HEALTH_TIMEOUT = configuredMs > 0 ? Math.max(10000, configuredMs) : 10000;

  if (initMs > 3000) {
    logToDebugFile('WARN', `[Worker-${workerId}] Browser init was slow: ${initMs}ms — leaving less headroom for DDG navigation.`);
  }

  try {
    return await executeHealthCheckAttempt(_context, HEALTH_TIMEOUT);
  } catch (firstError: any) {
    // One retry: if the first attempt fails, the page may have been in a bad state
    // (challenge redirect, partial load, transient network blip). A second attempt
    // on a fresh page helps distinguish a real outage from a one-off failure.
    logToDebugFile('WARN', `[Worker-${workerId}] Health check attempt 1 failed: ${firstError.message}. Retrying once...`);
    try {
      return await executeHealthCheckAttempt(_context, HEALTH_TIMEOUT);
    } catch (retryError: any) {
      logToDebugFile('ERROR', `[Worker-${workerId}] Health check failed after retry: ${retryError.message}`);
      throw retryError;
    }
  }
}

/**
 * Check if browser error requires reset
 */
export function shouldResetBrowser(errorMsg: string): boolean {
  return errorMsg.includes('Target closed') ||
         errorMsg.includes('browser has disconnected') ||
         errorMsg.includes('Protocol error') ||
         errorMsg.includes('Session closed');
}