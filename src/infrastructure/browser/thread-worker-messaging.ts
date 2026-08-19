/**
 * Thread Worker Messaging Logic
 *
 * Handles message processing and task execution for the thread worker.
 */

let workerId: string = '';

import { appendFileSync } from 'node:fs';
import { redactSecrets } from '../../utils/log-utils.ts';
import { safeUnref } from '../../utils/safe-unref.ts';
import { MAX_HTML_SIZE, MAX_PDF_SIZE } from '../../web-research/scraper-types.ts';

/**
 * Mutex lock to serialize page creation. Playwright/Firefox can deadlock if newPage()
 * is called concurrently on the exact same context instance.
 */
let pageCreationLock = Promise.resolve();

/** How long createPageSafe() waits for a straggling newPage() before force-releasing
 * the mutex. Must stay well above the 60s soft timeout below — it exists only to
 * bound the pathological case where newPage() never settles at all (see comment below). */
const PAGE_CREATION_HARD_RELEASE_MS = 5 * 60 * 1000;

/** Set when a hard-release fires while its newPage() call is still pending —
 * identifies the context that call was creating a page on. A concurrent
 * newPage() on that SAME context is exactly what pageCreationLock exists to
 * prevent, so any call for this context is rejected fast (without ever
 * calling newPage()) until the stuck call actually settles and clears this. */
let wedgedContext: any = null;

/** Exported for unit testing of the page-creation mutex's timeout behavior. */
export async function createPageSafe(context: any): Promise<any> {
  let release!: () => void;
  const nextLock = new Promise<void>(resolve => { release = resolve; });
  const currentLock = pageCreationLock;
  pageCreationLock = currentLock.then(() => nextLock);

  await currentLock;
  if (context === wedgedContext) {
    // Release immediately so the queue keeps flowing for OTHER contexts (or
    // this one, once the stuck call clears wedgedContext) instead of stalling
    // every future caller behind the still-pending call.
    release();
    throw new Error('Browser context is wedged from a prior page-creation call that never settled; a new browser context is required.');
  }
  const pagePromise = context.newPage();
  // Release the mutex once newPage() itself has actually settled — NOT when the
  // timeout race below settles. Releasing in an outer `finally` (the old shape)
  // fired as soon as the 60s timeout won the race, while newPage() was still
  // pending in the background — so the NEXT queued caller started its OWN
  // newPage() concurrently with this still-unsettled one, exactly the concurrent-
  // newPage() scenario this lock exists to prevent (see the comment above), and
  // it happens precisely when the browser is already under the stress that
  // causes 60s+ page-creation stalls in the first place. Attached before the
  // race starts so it's independent of which branch below returns/throws.
  //
  // A hard release timer bounds the case where newPage() never settles at all
  // (rather than just being slow) — without it, a single wedged newPage() call
  // would hold this lock forever and livelock every future createPageSafe() call
  // on this worker thread. It marks the context wedged rather than letting the
  // next caller straight through: a merely-slow (not hung) newPage() would
  // otherwise still be in flight when a new one starts on the same context.
  let hardReleased = false;
  const releaseOnce = (): void => {
    if (hardReleased) return;
    hardReleased = true;
    clearTimeout(hardReleaseTimer);
    release();
  };
  const hardReleaseTimer = setTimeout(() => {
    logToDebugFile('WARN', '[ThreadWorker] page-creation mutex force-released — newPage() did not settle within the hard timeout');
    wedgedContext = context;
    releaseOnce();
  }, PAGE_CREATION_HARD_RELEASE_MS);
  safeUnref(hardReleaseTimer);
  pagePromise.then(
    () => { if (wedgedContext === context) wedgedContext = null; releaseOnce(); },
    () => { if (wedgedContext === context) wedgedContext = null; releaseOnce(); },
  );
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
}

/**
 * Set the worker ID for logging purposes
 */
export function setWorkerId(id: string): void {
  workerId = id;
}

/**
 * Parse a millisecond timeout from an env var. Uses Number() rather than
 * parseInt() so trailing garbage is REJECTED rather than silently truncated —
 * parseInt('1m', 10) === 1, which turned a plausible duration-shorthand typo
 * into a near-instant timeout instead of falling back to the default.
 */
function parseTimeoutMs(envVar: string | undefined, def: number): number {
  if (envVar === undefined || envVar.trim() === '') return def;
  const n = Number(envVar.trim());
  if (!Number.isFinite(n) || n < 0) {
    logToDebugFile('WARN', `[ThreadWorker] Invalid timeout value "${envVar}", using default: ${def}ms`);
    return def;
  }
  return n;
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
/**
 * Bind a task-timeout signal to the page it is bounding.
 *
 * `page.setDefaultTimeout` bounds Playwright's action and navigation verbs
 * individually; it does not bound their sum, and it does not bound a Response read
 * at all. Closing the page is what actually ends the work: any in-flight call
 * rejects with 'Target closed', which runTask's catch already maps back to the
 * task timeout. Fire-and-forget, `{ once }` so the listener cannot outlive the task.
 */
function bindTaskAbortToPage(page: any, signal?: AbortSignal): void {
  if (!signal) return;
  const onAbort = () => { page.close().catch(() => {}); };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
}

export async function executeSearchTask(
  _context: any,
  query: string,
  signal?: AbortSignal
): Promise<{ results: any[]; jitter: number }> {
  const page = await createPageSafe(_context);
  const SEARCH_TIMEOUT = parseTimeoutMs(process.env['PI_RESEARCH_SEARCH_TIMEOUT_MS'], 45000);
  page.setDefaultTimeout(SEARCH_TIMEOUT);
  page.setDefaultNavigationTimeout(SEARCH_TIMEOUT);

  // Same binding the scrape path has used all along, and for the same reason: the
  // worker's task deadline was armed but its signal was only ever handed to
  // executeScrapeTask, so on a search it fired into nothing. Playwright's own
  // per-action timeouts still bound each verb, but the sum of them plus the jitter
  // sleep can outlast the whole task budget — and poolifier keeps counting this node
  // as executing until the worker replies, so the node stays pinned long after the
  // caller was answered. Closing the page rejects whatever is in flight with
  // 'Target closed', which runTask's catch already recognises as the timeout.
  bindTaskAbortToPage(page, signal);

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
 * Short-TTL, per-worker cache of per-hostname DNS-aware SSRF verdicts for
 * SUBRESOURCE requests. Subresources previously got only the synchronous
 * literal/pattern screen (no DNS), so a hostile page — whose own navigation
 * DNS-validated as public — could fetch() a hostname that resolves to a
 * private/link-local/metadata address (TTL-0 DNS rebinding) and read the
 * response into the DOM that page.content() returns. Every http(s) subresource
 * hostname now gets the same DNS-aware validateUrlForSSRF as navigations; this
 * cache keeps that to ONE resolution per hostname per TTL (the sync screen's
 * whole purpose was avoiding per-asset DNS stalls — a page with 40 assets on
 * one CDN host costs one lookup, not 40, and same-origin assets are seeded by
 * the navigation's own validation). The TTL is deliberately short so a verdict
 * cannot stay stale for long, and this pre-validation is only the first layer:
 * DNS pre-checks are inherently TOCTOU-racy against a rebinding resolver
 * (Firefox resolves independently at connect time; camoufox has no connect-time
 * IP pinning), so the response-side serverAddr() backstop in executeScrapeTask
 * is the authoritative rebinding defense.
 */
const SUBRESOURCE_DNS_VERDICT_TTL_MS = 15_000;
const SUBRESOURCE_DNS_VERDICT_MAX_ENTRIES = 256;
const subresourceDnsVerdicts = new Map<string, { expires: number; verdict: Promise<Error | null> }>();

function getCachedSubresourceVerdict(
  reqUrl: string,
  validate: (u: string) => Promise<void>,
): Promise<Error | null> {
  let hostname: string;
  try {
    hostname = new URL(reqUrl).hostname.toLowerCase();
  } catch (e) {
    return Promise.resolve(e instanceof Error ? e : new Error(String(e)));
  }
  const now = Date.now();
  const cached = subresourceDnsVerdicts.get(hostname);
  if (cached && cached.expires > now) return cached.verdict;
  // Store the SETTLED outcome (null = allowed, Error = blocked) instead of a
  // rejecting promise so a cached denial can never surface as an unhandled
  // rejection, and concurrent requests for the same hostname share one lookup.
  const verdict = validate(reqUrl).then(
    () => null,
    (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  );
  if (subresourceDnsVerdicts.size >= SUBRESOURCE_DNS_VERDICT_MAX_ENTRIES) {
    for (const [key, entry] of subresourceDnsVerdicts) {
      if (entry.expires <= now) subresourceDnsVerdicts.delete(key);
    }
    // Still full after dropping expired entries: evict oldest-inserted.
    while (subresourceDnsVerdicts.size >= SUBRESOURCE_DNS_VERDICT_MAX_ENTRIES) {
      const oldest = subresourceDnsVerdicts.keys().next().value;
      if (oldest === undefined) break;
      subresourceDnsVerdicts.delete(oldest);
    }
  }
  subresourceDnsVerdicts.set(hostname, { expires: now + SUBRESOURCE_DNS_VERDICT_TTL_MS, verdict });
  return verdict;
}

/** Seed the subresource verdict cache with a PASS for a hostname whose full DNS-aware validation just succeeded (the navigation), so same-origin assets don't pay a second resolution. */
function seedSubresourceVerdict(validatedUrl: string): void {
  try {
    const hostname = new URL(validatedUrl).hostname.toLowerCase();
    subresourceDnsVerdicts.set(hostname, {
      expires: Date.now() + SUBRESOURCE_DNS_VERDICT_TTL_MS,
      verdict: Promise.resolve(null),
    });
  } catch {
    /* unparseable URLs are rejected by the validator itself */
  }
}

/**
 * Execute a scrape task
 */
export async function executeScrapeTask(
  _context: any,
  url: string,
  signal?: AbortSignal
): Promise<{ contentType: string; html?: string; bufferB64?: string; jitter: number }> {
  const page = await createPageSafe(_context);
  const SCRAPE_TIMEOUT = parseTimeoutMs(process.env['PI_RESEARCH_SCRAPE_TIMEOUT_MS'], 15000);
  page.setDefaultTimeout(SCRAPE_TIMEOUT);
  page.setDefaultNavigationTimeout(SCRAPE_TIMEOUT);

  // Bind the task-timeout signal to this page: page.setDefaultTimeout only bounds
  // Playwright's action/navigation verbs, NOT Response reads — a large/slow PDF's
  // response.body() (or a slowloris trickle) has no ceiling and would pin the poolifier
  // worker slot indefinitely past the task deadline. Closing the page on abort rejects
  // any in-flight body()/content()/goto with 'Target closed', which the catch below
  // handles, freeing the slot at the deadline. Fire-and-forget close; { once } so the
  // listener is auto-removed.
  const onAbort = () => { page.close().catch(() => {}); };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  // Set by the response-side SSRF backstop (see page.on('response') below) when
  // ANY response was served from a private/reserved address: the scrape is
  // poisoned and must fail without returning content. Declared outside the try
  // so the catch can surface it instead of the secondary 'Target closed' error
  // produced by the poison-triggered page.close().
  let poisonedError: Error | null = null;
  const pendingAddrChecks: Array<Promise<void>> = [];

  // Set by the response-side early-abort check (see page.on('response') below) when the
  // main-frame document's OWN headers already declare a PDF larger than MAX_PDF_SIZE.
  // Declared outside the try for the same reason as poisonedError: the catch below needs
  // to surface this instead of the secondary 'Target closed' error the triggering
  // page.close() produces.
  let oversizedPdfError: Error | null = null;

  try {
    logToDebugFile('DEBUG', `[Worker-${workerId}] Starting scrape for: ${url}`);

    // Intercept EVERY request and validate it against SSRF rules: navigations
    // (server 3xx AND client-side meta-refresh / window.location / form submit)
    // get the full DNS-aware check; subresources (img/script/xhr/fetch) get the
    // SAME DNS-aware check, deduplicated per hostname by a short-TTL verdict
    // cache so a page full of same-host assets costs one resolution, not one
    // per asset. Without the DNS pass on subresources, a hostile page could
    // fetch() a TTL-0 rebinding hostname that resolves to an internal IP /
    // cloud metadata and read the response into the DOM that page.content()
    // serializes into the research report.
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
            // Same-origin assets of a just-validated document ride this verdict.
            seedSubresourceVerdict(reqUrl);
          } else {
            // Subresource (img/script/style/xhr/fetch). Synchronous literal/
            // pattern screen first: it is free, and a `true` return means the
            // test-only loopback affordance definitively accepted the target
            // (a DNS pass would wrongly reject localhost→127.0.0.1).
            const loopbackAccepted = validateForWorkerSync(reqUrl);
            if (!loopbackAccepted) {
              // DNS-aware pass, one resolution per hostname per short TTL.
              // Same-origin subresources are a cache hit (seeded by the
              // navigation) — for those, the rebinding TOCTOU window is closed
              // by the response-side serverAddr() backstop below, not here.
              const verdictError = await getCachedSubresourceVerdict(reqUrl, validateForWorker);
              if (verdictError) throw verdictError;
            }
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
    //
    // ADDITIONALLY: response-side rebinding backstop for EVERY response. The request-time DNS
    // pass above is inherently TOCTOU-racy — Firefox resolves hostnames itself at connect time
    // (camoufox has no connect-time IP pinning), so a TTL-0 resolver can answer public during
    // validation and private at connect. Firefox's juggler reports the IP each network-served
    // response ACTUALLY came from via serverAddr() (null for cached/route-fulfilled responses).
    // If any response arrived from a private/loopback/link-local/metadata address that wasn't
    // explicitly allowed (loopback test flag), internal data may already be in the DOM — poison
    // the scrape: close the page (aborting the load) and fail with a 'Fetch blocked:' error,
    // which isBenignScrapeFailure classifies as an expected per-URL outcome (debug, not ERROR).
    let finalMainFrameAddr: Promise<{ ipAddress?: string } | null> = Promise.resolve(null);
    page.on('response', (resp: any) => {
      try {
        if (resp.request().resourceType() === 'document' && resp.frame() === page.mainFrame()) {
          finalMainFrameAddr = resp.serverAddr().catch(() => null);

          // Early-abort a declared-oversized PDF as soon as its headers arrive, rather
          // than waiting for page.goto() to finish downloading the whole thing first.
          // 'response' fires on headers-received, well before the body is fully
          // transferred — for a direct navigation to a PDF URL, Playwright's goto()
          // does not resolve until the download completes, so without this the full
          // (possibly multi-hundred-MB) body is pulled into the browser process before
          // the PDF branch below ever gets to check Content-Length.
          //
          // This closes the gap only for a server that HONESTLY declares an oversized
          // Content-Length up front. A chunked-transfer response (no Content-Length) or
          // one that understates its length and then sends far more cannot be caught
          // this way — Playwright's public API exposes no incremental
          // bytes-received/streaming hook to abort mid-body on either engine. That
          // residual case is bounded instead by the task's own SCRAPE_TIMEOUT_MS +
          // BROWSER_TASK_TIMEOUT_MS deadline (see the onAbort/page.close() wiring
          // above), which forcibly closes the page — and with it any in-flight
          // download — once the task's time budget is exhausted, converting an
          // otherwise-unbounded read into one bounded by (bandwidth x that budget).
          const check2: Promise<void> = Promise.resolve(resp.headerValue('content-type'))
            .then(async (ct: string | null) => {
              // Matches the PDF branch below AND the fetch layer's own detection
              // (web-scraper.ts): a server can mislabel or omit content-type, so a
              // `.pdf` URL extension is an equally-trusted signal, not just the header.
              const looksLikePdf = ct?.includes('application/pdf') || url.toLowerCase().endsWith('.pdf');
              if (!looksLikePdf || oversizedPdfError || poisonedError) return;
              const declared = parseInt((await resp.headerValue('content-length').catch(() => null)) || '', 10);
              if (Number.isFinite(declared) && declared > MAX_PDF_SIZE) {
                const sizeMB = Math.round(declared / 1024 / 1024);
                oversizedPdfError = new Error(`PDF too large (${sizeMB}MB, max 100MB)`);
                logToDebugFile('DEBUG', `[Worker-${workerId}] Aborting oversized PDF (${sizeMB}MB declared) before download completes: ${url}`);
                page.close().catch(() => {});
              }
            })
            .catch(() => {});
          pendingAddrChecks.push(check2);
        }
        const check: Promise<void> = Promise.resolve(resp.serverAddr())
          .then((addr: { ipAddress?: string } | null) => {
            const ip = addr?.ipAddress;
            if (!ip || poisonedError) return;
            try {
              validateForWorkerSync(ip.includes(':') ? `http://[${ip}]/` : `http://${ip}/`);
            } catch (cause: unknown) {
              poisonedError = new Error(
                'Fetch blocked: a response was served from a private/reserved address (SSRF DNS-rebinding defense)',
                { cause },
              );
              logToDebugFile('WARN', `[Worker-${workerId}] SSRF rebinding defense: a response connected to a private/reserved address; poisoning scrape of ${url}`);
              // Abort the in-flight load; goto/content() reject with 'Target
              // closed', and the catch below surfaces poisonedError instead.
              page.close().catch(() => {});
            }
          })
          .catch(() => {});
        pendingAddrChecks.push(check);
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
    // HTTP status of the final navigation response. Never consulting it let
    // 404/500/403 pages return as normal {contentType, html} results — major
    // sites' rich error pages cleared the stub gate, were cached as scrape
    // SUCCESS, and became citable. The fetch layer enforces !response.ok; this
    // layer must match it (`HTTP <status>` is benign-classified per URL). The
    // one legitimate exception is a Cloudflare challenge, which arrives with
    // 403/503 — the HTML branch defers to the challenge wait below for that.
    const status = response?.status?.() ?? 0;

    // `.pdf` extension is an equally-trusted signal alongside the header (matches
    // the fetch layer's own detection in web-scraper.ts): a server that mislabels
    // or omits content-type would otherwise fall into the HTML branch below, whose
    // page.content() would serialize Firefox's PDF-viewer chrome instead of
    // extracting the document — a silent content loss for exactly the URLs this
    // feature advertises as supported, and specifically for the malformed/oddly-
    // served PDFs most likely to reach this browser fallback in the first place.
    if (contentType.includes('application/pdf') || url.toLowerCase().endsWith('.pdf')) {
      if (!response) throw new Error(`[Worker] No response received for PDF URL: ${url}`);
      // An errored "PDF" is an error page: fail BEFORE buffering its body.
      if (status >= 400) throw new Error(`HTTP ${status}`);
      // Enforce the parent's PDF cap HERE, not only after the IPC transfer:
      // buffering a multi-hundred-MB PDF (plus the base64 copy below) in the
      // worker can OOM-kill the process — stranding every sibling task — or hit
      // ERR_STRING_TOO_LONG. Content-Length first (free when present, and it
      // skips the read entirely)...
      const declaredLength = parseInt((await response.headerValue('content-length').catch(() => null)) || '', 10);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_PDF_SIZE) {
        const sizeMB = Math.round(declaredLength / 1024 / 1024);
        throw new Error(`PDF too large (${sizeMB}MB, max 100MB)`);
      }
      // The response-side early-abort check above (page.on('response')) may already have
      // decided this and be in the middle of closing the page — skip the (redundant,
      // about-to-fail) download attempt rather than race it.
      if (oversizedPdfError) throw oversizedPdfError;
      const buffer = await response.body();
      // ...then the actual bytes: the header is advisory and absent on chunked
      // responses, so the byte count is the check that actually bounds memory.
      // Checked BEFORE toString('base64') doubles the allocation.
      if (buffer.byteLength > MAX_PDF_SIZE) {
        const sizeMB = Math.round(buffer.byteLength / 1024 / 1024);
        throw new Error(`PDF too large (${sizeMB}MB, max 100MB)`);
      }
      // Discard the bytes if any observed response came from a private address.
      await Promise.allSettled(pendingAddrChecks);
      if (poisonedError) throw poisonedError;
      await page.close();
      // Base64, never a raw Buffer: this result crosses the poolifier cluster IPC
      // channel (default JSON serialization), where a Buffer arrives as
      // {type:'Buffer',data:[...]} — and the follower path adds a second JSON hop
      // through the leader's browser-server. A base64 string survives both hops
      // verbatim (and is ~3x smaller on the wire than the data-array form).
      return { contentType, bufferB64: buffer.toString('base64'), jitter: 0 };
    }

    // If it's HTML, check if we need to wait longer (JS-heavy sites)
    let html = await page.content();

    // DETECT CLOUDFLARE CHALLENGE
    const cfPatterns = ['_cf_chl_', 'cdn-cgi/challenge-platform', 'cf_chl_opt', 'Just a moment...', 'Checking your browser before accessing'];
    const hasCloudflare = cfPatterns.some((pattern: string) => html.includes(pattern));

    // HTTP-error enforcement for HTML (see the PDF branch above). A Cloudflare
    // challenge legitimately arrives with 403/503 and the wait below may clear
    // it to the real page, so a challenged response defers to that wait — whose
    // failure path already throws its own 'Fetch blocked:' error. Everything
    // else with a 4xx/5xx status is an error page, not content.
    if (status >= 400 && !hasCloudflare) {
      throw new Error(`HTTP ${status}`);
    }

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
        // A Cloudflare challenge that doesn't clear is an expected block, not a worker
        // fault (the thrown 'Fetch blocked' is demoted to WARN at the server boundary
        // via isCloudflareBlockError). Label the debug-file line WARN to match.
        logToDebugFile('WARN', `[Worker-${workerId}] Cloudflare challenge failed for: ${url}`);
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

    // Enforce the parent's rendered-HTML cap worker-side, BEFORE the string
    // crosses JSON IPC (and, for followers, a second JSON hop through the
    // leader's browser-server). The parent's identical check in web-scraper.ts
    // runs only after the transfer — too late to protect this process from a
    // pathological/hostile page ballooning worker memory. Same error wording.
    if (html.length > MAX_HTML_SIZE) {
      const sizeMB = Math.round(html.length / 1024 / 1024);
      throw new Error(`Browser HTML too large (${sizeMB}MB, max 25MB)`);
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

    // Response-side SSRF backstop: settle every serverAddr() inspection recorded
    // so far and refuse to return the captured HTML if any response — main frame
    // OR subresource (the same-origin fetch() rebinding case) — was served from
    // a private/reserved address.
    await Promise.allSettled(pendingAddrChecks);
    if (poisonedError) throw poisonedError;

    await page.close();
    return { contentType, html, jitter };
  } catch (error) {
    await page.close().catch((err: any) => logToDebugFile('DEBUG', `[ThreadWorker] Swallowed page close/wait error: ${err.message || String(err)}`));
    // An early-abort-triggered page.close() (oversized PDF, or SSRF poisoning) makes
    // the in-flight goto/content()/body() reject with 'Target closed'; report the
    // actual reason (a benign-classified failure) instead of that secondary teardown
    // error. oversizedPdfError takes priority since it can only be set on the PDF path,
    // where poisonedError (an HTML-only DOM-exfil concern) is not meaningful.
    if (oversizedPdfError) throw oversizedPdfError;
    if (poisonedError) throw poisonedError;
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
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
  url: string = HEALTH_PRIMARY_URL,
  signal?: AbortSignal
): Promise<{ success: boolean; navMs: number }> {
  const page = await createPageSafe(_context);
  page.setDefaultTimeout(navTimeoutMs);
  page.setDefaultNavigationTimeout(navTimeoutMs);
  // See executeSearchTask: the probe runs twice (primary then fallback), so its own
  // nav timeout bounds each attempt but not the pair.
  bindTaskAbortToPage(page, signal);

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
  initMs: number,
  signal?: AbortSignal
): Promise<{ success: boolean; navMs: number }> {
  // Nav timeout: read from env (passed through getBrowserEnv), floor at 10s.
  // The outer BrowserTaskScheduler.runHealthCheck() has its own 45s hard deadline.
  const configuredMs = parseTimeoutMs(process.env['PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS'], 0);
  const HEALTH_TIMEOUT = configuredMs > 0 ? Math.max(10000, configuredMs) : 10000;

  if (initMs > 3000) {
    logToDebugFile('WARN', `[Worker-${workerId}] Browser init was slow: ${initMs}ms — leaving less headroom for DDG navigation.`);
  }

  try {
    return await executeHealthCheckAttempt(_context, HEALTH_TIMEOUT, HEALTH_PRIMARY_URL, signal);
  } catch (firstError: unknown) {
    // One retry: if the first attempt fails, the page may have been in a bad state
    // (challenge redirect, partial load, transient network blip). A second attempt
    // on a fresh page helps distinguish a real outage from a one-off failure.
    logToDebugFile('WARN', `[Worker-${workerId}] Health check attempt 1 failed: ${firstError instanceof Error ? firstError.message : String(firstError)}. Retrying once...`);
    try {
      return await executeHealthCheckAttempt(_context, HEALTH_TIMEOUT, HEALTH_PRIMARY_URL, signal);
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
          const fallback = await executeHealthCheckAttempt(_context, HEALTH_TIMEOUT, HEALTH_FALLBACK_URL, signal);
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