/**
 * Thread Worker Messaging Logic
 *
 * Handles message processing and task execution for the thread worker.
 */

let workerId: string = '';

import { appendFileSync } from 'node:fs';
import { redactSecrets } from '../../utils/log-utils.ts';

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
    const pagePromise = context.newPage();
    pagePromise.catch((err: Error) => logToDebugFile('DEBUG', `[ThreadWorker] Background page creation rejection: ${err.message}`));
    let timeoutId: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        pagePromise,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Browser page creation timed out after 60000ms')), 60000);
        })
      ]);
      if (timeoutId) clearTimeout(timeoutId);
      return result;
    } catch (err) {
      if (timeoutId) clearTimeout(timeoutId);
      // The timeout (or another error) won the race. If newPage() later resolves,
      // close that orphaned page so it doesn't accumulate in the long-lived context.
      pagePromise.then((p: any) => { try { p?.close?.(); } catch { /* already gone */ } }).catch(() => {});
      throw err;
    }
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
  // Match the main-process logger: WARN/ERROR are always recorded (crash diagnostics);
  // INFO/DEBUG only when verbose. Without this gate a non-verbose scaling run still
  // streamed thousands of worker DEBUG lines to PI_RESEARCH_LOG_FILE — often a tmpfs
  // (RAM) path — adding memory and I/O pressure for no benefit during sustained loops.
  if ((level === 'INFO' || level === 'DEBUG') && process.env['PI_RESEARCH_DEBUG'] !== 'true') return;

  try {
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      level,
      workerId,
      // Redact secrets + bound size; worker logs include full scrape/search
      // URLs, which can carry credentials in userinfo or query strings.
      message: redactSecrets(args.map(arg => {
        if (arg instanceof Error) return arg.stack || arg.message;
        if (typeof arg === 'object' && arg !== null) return JSON.stringify(arg);
        return String(arg);
      }).join(' '))
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
    const urlStr = request.url();
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      route.continue();
      return;
    }

    const isDuckDuckGo = url.hostname === 'duckduckgo.com' || 
                         url.hostname === 'lite.duckduckgo.com' ||
                         url.hostname.endsWith('.duckduckgo.com');

    if (mockSearch && isDuckDuckGo) {
      logToDebugFile('DEBUG', `[Worker-${workerId}] Mocking search response for: ${urlStr}`);
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `
          <html><head><title>DuckDuckGo Lite</title></head><body>
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

    if (mockScrape && !isDuckDuckGo) {
      logToDebugFile('DEBUG', `[Worker-${workerId}] Mocking scrape response for: ${urlStr}`);
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
  const SEARCH_TIMEOUT = parseInt(process.env['PI_RESEARCH_SEARCH_TIMEOUT_MS'] || '45000', 10);
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
    await page.close().catch((err: any) => logToDebugFile('DEBUG', `[ThreadWorker] Swallowed page close/wait error: ${err.message || String(err)}`));
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

    // Intercept EVERY request and validate it against SSRF rules: navigations
    // (server 3xx AND client-side meta-refresh / window.location / form submit)
    // get the full DNS-aware check; subresources get a cheap synchronous
    // literal/pattern screen. Without this, Playwright follows redirects and
    // client-side navigations natively and could reach internal IPs / cloud
    // metadata, returning the rendered body to the researcher.
    // Must use page.route (a BLOCKING intercept), NOT page.on('request') — the
    // latter does not pause navigation, so the abort raced the redirect and the
    // metadata endpoint could be reached before it fired. route.fallback() defers
    // to the next handler (the CI mock context.route) or the network, so this
    // preserves mocking while actually gating each request.
    const { validateUrlForSSRF: validateForWorker, validateUrlForSSRFSync: validateForWorkerSync } =
      await import('../../web-research/scraper-utils.ts');
    await page.route('**', async (route: any, req: any) => {
      const reqUrl: string = req.url();
      // Only http(s) requests can reach a private host over the network; in-page
      // data:/blob:/about: schemes are not an SSRF vector and must pass through
      // untouched (else pages using data: images/fonts would break).
      if (/^https?:/i.test(reqUrl)) {
        try {
          if (req.isNavigationRequest()) {
            // ANY navigation — a server 3xx redirect OR a client-side hop (meta
            // refresh, window.location, form submit). Full DNS-aware check;
            // navigations are infrequent so the resolution cost is negligible.
            // Closes full-content SSRF exfil where a page redirects itself to
            // 169.254.169.254 / an internal host and the rendered body is returned.
            await validateForWorker(reqUrl);
          } else {
            // Subresource (img/script/style/xhr/fetch). Cheap synchronous
            // literal/pattern screen only (no DNS) to block blind SSRF probing of
            // private/loopback/metadata addresses without adding per-asset latency.
            validateForWorkerSync(reqUrl);
          }
        } catch (_ssrfErr: unknown) {
          await route.abort('blockedbyclient').catch(() => {});
          return;
        }
      }
      await route.fallback().catch(() => {});
    });

    // Track the ACTUAL connected IP of each main-frame document response. The post-goto check below
    // only re-validates the initial navigation; a page that passes it can then client-navigate
    // (window.location / meta-refresh / form submit) to a TTL-0 host that rebinds to a private /
    // metadata IP. Re-validating the FINAL main-frame document's serverAddr before its body is
    // returned closes that second-hop DNS-rebind window.
    let finalMainFrameAddr: Promise<{ ipAddress?: string } | null> = Promise.resolve(null);
    page.on('response', (resp: any) => {
      try {
        if (resp.request().resourceType() === 'document' && resp.frame() === page.mainFrame()) {
          finalMainFrameAddr = resp.serverAddr().catch(() => null);
        }
      } catch {
        /* frame detached / teardown — ignore */
      }
    });

    // High-fidelity wait: try domcontentloaded first for speed
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });

    // DNS-rebinding defense-in-depth. The page.route guard's validateForWorker resolves the
    // hostname independently of the browser's own connect-time resolution, so a TTL-0 rebind can
    // pass validation yet have the browser connect to a private/metadata IP (169.254.169.254 /
    // RFC1918). The browser reports the IP it ACTUALLY connected to via serverAddr — re-check it
    // against the same SSRF policy and refuse to return the body if it is internal. This does not
    // prevent the TCP connection itself, but it stops the rendered response (e.g. cloud IAM
    // credentials) from being exfiltrated to the researcher/report, which is the real harm here.
    const serverAddr = await response?.serverAddr().catch(() => null);
    if (serverAddr?.ipAddress) {
      const ip: string = serverAddr.ipAddress;
      validateForWorkerSync(ip.includes(':') ? `http://[${ip}]/` : `http://${ip}/`);
    }

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
      } catch (_waitError: unknown) {
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
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch((err: any) => logToDebugFile('DEBUG', `[ThreadWorker] Swallowed page close/wait error: ${err.message || String(err)}`));
      html = await page.content();
    }

    // Skip jitter in mock mode; in real browsing, add 500–1500ms to mimic human behavior
    const jitter = process.env['PI_RESEARCH_MOCK_SCRAPE'] === 'true'
      ? 0
      : Math.floor(Math.random() * 1000) + 500;
    if (jitter > 0) await new Promise(r => setTimeout(r, jitter));

    // Re-validate the final rendered main-frame document's connected IP (catches a client-side
    // navigation to a DNS-rebinding host that occurred after the initial goto passed).
    const finalAddr = await finalMainFrameAddr;
    if (finalAddr?.ipAddress) {
      const fip: string = finalAddr.ipAddress;
      validateForWorkerSync(fip.includes(':') ? `http://[${fip}]/` : `http://${fip}/`);
    }

    await page.close();
    return { contentType, html, jitter };
  } catch (error) {
    await page.close().catch((err: any) => logToDebugFile('DEBUG', `[ThreadWorker] Swallowed page close/wait error: ${err.message || String(err)}`));
    throw error;
  }
}

// Primary health probe target: the live search provider. Verifying it is the most
// representative precondition for research, but DDG is also the endpoint most prone
// to bot-blocking/rate-limiting automated browser traffic — so a failure here is NOT
// proof the web is unreachable.
const HEALTH_PRIMARY_URL = 'https://lite.duckduckgo.com/lite/';
// Neutral, automation-tolerant reachability fallback (IANA-operated, no bot
// protection, returns a stable non-empty title). A successful load here proves the
// browser CAN reach the open web, which disambiguates "the search provider blocked
// or hiccupped" from a genuine connectivity outage.
const HEALTH_FALLBACK_URL = 'https://example.com/';

/**
 * Execute a health check attempt against a given URL (defaults to the search provider).
 */
async function executeHealthCheckAttempt(
  _context: any,
  navTimeoutMs: number,
  url: string = HEALTH_PRIMARY_URL
): Promise<{ success: boolean; navMs: number }> {
  const page = await createPageSafe(_context);
  page.setDefaultTimeout(navTimeoutMs);
  page.setDefaultNavigationTimeout(navTimeoutMs);

  try {
    const navStart = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const navMs = Date.now() - navStart;

    if (navMs > 3000) {
      logToDebugFile('WARN', `[Worker-${workerId}] Health navigation to ${url} was slow: ${navMs}ms (expected <1s). Possible rate-limit or network congestion.`);
    }

    const title = await page.title();
    await page.close();
    return { success: !!title, navMs };
  } catch (error) {
    await page.close().catch((err: any) => logToDebugFile('DEBUG', `[ThreadWorker] Swallowed page close/wait error: ${err.message || String(err)}`));
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
  } catch (firstError: unknown) {
    // One retry: if the first attempt fails, the page may have been in a bad state
    // (challenge redirect, partial load, transient network blip). A second attempt
    // on a fresh page helps distinguish a real outage from a one-off failure.
    logToDebugFile('WARN', `[Worker-${workerId}] Health check attempt 1 failed: ${firstError instanceof Error ? firstError.message : String(firstError)}. Retrying once...`);
    try {
      return await executeHealthCheckAttempt(_context, HEALTH_TIMEOUT);
    } catch (retryError: unknown) {
      const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
      // A TIMEOUT is left to propagate: upstream (isBusyPoolHealthFailure) already
      // treats timed-out probes as a congested-but-live pool and proceeds, and
      // re-probing would only add latency to an already-slow path.
      const isTimeout = /tim(e|ed)\s*out|timeout/i.test(retryMsg);
      if (!isTimeout) {
        // The search provider failed twice with a non-timeout (e.g. net::ERR*) error.
        // That is most often DDG-specific bot-blocking, NOT a dead connection — the
        // observed false negative where the open web was fully reachable yet research
        // aborted with "check your internet". Confirm raw web reachability against a
        // neutral endpoint before declaring failure; if it loads, the browser is
        // healthy enough to research (search has its own retries/fallbacks downstream).
        logToDebugFile('WARN', `[Worker-${workerId}] Search-provider health probe failed twice (${retryMsg}); verifying open-web reachability via fallback endpoint...`);
        try {
          const fallback = await executeHealthCheckAttempt(_context, HEALTH_TIMEOUT, HEALTH_FALLBACK_URL);
          logToDebugFile('WARN', `[Worker-${workerId}] Fallback endpoint reachable — open web is up, search provider is degraded. Proceeding with research.`);
          return fallback;
        } catch (fallbackError: unknown) {
          logToDebugFile('ERROR', `[Worker-${workerId}] Health check failed after retry + fallback probe: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
          throw retryError;
        }
      }
      logToDebugFile('ERROR', `[Worker-${workerId}] Health check failed after retry: ${retryMsg}`);
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