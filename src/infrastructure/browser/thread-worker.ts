/**
 * Poolifier Worker
 *
 * Executes search and scrape tasks in worker processes using Camoufox.
 *
 * This module coordinates the worker lifecycle, browser management,
 * and task execution using extracted sub-modules.
 */

import { ClusterWorker } from 'poolifier';
import crypto from 'node:crypto';
import process from 'node:process';

// Import extracted modules
import {
  setWorkerId as setLifecycleWorkerId,
  setupIpcErrorHandler,
  setupUncaughtExceptionHandler,
  setupOrphanProtection,
  createKillHandler,
  setBrowserCleanup,
} from './thread-worker-lifecycle.ts';
import {
  setWorkerId,
  initBrowser,
  getContext,
  resetBrowser,
  cleanupBrowser,
} from './thread-worker-browser.ts';
import {
  setWorkerId as setMessagingWorkerId,
  executeSearchTask,
  executeScrapeTask,
  executeHealthCheck,
  shouldResetBrowser,
} from './thread-worker-messaging.ts';
import type { TaskData, TaskResult } from './thread-worker-types.ts';

// Generate a random ID for this worker process to track distribution in logs
const workerId = crypto.randomBytes(2).toString('hex');

// Diagnostic logging for CI - always log basic info to stderr
if (process.env['GITHUB_ACTIONS'] === 'true') {
  process.stderr.write(`[Worker-${workerId}] Process starting. PID=${process.pid}, PPID=${process.ppid}, NODE_ENV=${process.env['NODE_ENV']}\n`);
  process.stderr.write(`[Worker-${workerId}] MOCK_SEARCH=${process.env['PI_RESEARCH_MOCK_SEARCH']}, MOCK_SCRAPE=${process.env['PI_RESEARCH_MOCK_SCRAPE']}\n`);
}

// Set worker ID in all modules
setLifecycleWorkerId(workerId);
setWorkerId(workerId);
setMessagingWorkerId(workerId);

// Setup IPC error handler
setupIpcErrorHandler();

// Setup uncaught exception handler
setupUncaughtExceptionHandler();

// Setup browser cleanup callback for lifecycle module
setBrowserCleanup(cleanupBrowser);

// Setup orphaned worker protection
if (process.env['GITHUB_ACTIONS'] !== 'true') {
  setupOrphanProtection();
}

// When both search and scrape are mocked, skip Firefox entirely in task handlers
// and in the eager warm-up below. Firefox startup in cluster workers takes 60-90s
// on constrained CI runners; mocked tasks don't need a real browser at all.
const FULL_MOCK_MODE =
  process.env['PI_RESEARCH_MOCK_SEARCH'] === 'true' &&
  process.env['PI_RESEARCH_MOCK_SCRAPE'] === 'true';

if (process.env['GITHUB_ACTIONS'] === 'true') {
  process.stderr.write(`[Worker-${workerId}] FULL_MOCK_MODE=${FULL_MOCK_MODE}\n`);
}

/**
 * Main task execution function
 */
async function runTask(data: TaskData | undefined): Promise<TaskResult> {
  const taskId = crypto.randomBytes(4).toString('hex');
  if (!data) {
    return { error: 'No task data provided', duration: 0 };
  }
  const { type, query, url, queuedAt, taskTimeoutMs } = data;
  const startTime = Date.now();

  if (process.env['GITHUB_ACTIONS'] === 'true') {
    // Only log essential task info to avoid pipe pressure
    process.stderr.write(`[Worker-${workerId}] Task: ${type}\n`);
  }

  if (FULL_MOCK_MODE) {
    if (type === 'search') {
      return {
        results: [{ title: 'Mock Result', url: 'https://example.com/mock', content: `Mock search result for: ${query ?? ''}` }],
        duration: Date.now() - startTime,
        jitter: 0,
      };
    }
    if (type === 'scrape') {
      return {
        contentType: 'text/html',
        html: `<html><body><p>Mock content for ${url ?? ''}</p></body></html>`,
        duration: Date.now() - startTime,
        jitter: 0,
      };
    }
    if (type === 'healthcheck') {
      return { success: true, navMs: 0, duration: Date.now() - startTime };
    }
  }

  try {
    await initBrowser();
    const initMs = Date.now() - startTime;

    let result: any;
    if (type === 'search') {
      if (!query) throw new Error('Search task requires a query');
      const searchResult = await executeSearchTask(getContext(), query);
      result = { results: searchResult.results, duration: Date.now() - startTime, jitter: searchResult.jitter };
    } else if (type === 'scrape') {
      if (!url) throw new Error('Scrape task requires a URL');
      const scrapeResult = await executeScrapeTask(getContext(), url);
      result = { ...scrapeResult, duration: Date.now() - startTime };
    } else if (type === 'healthcheck') {
      const healthResult = await executeHealthCheck(getContext(), initMs);
      result = { ...healthResult, duration: Date.now() - startTime };
    } else {
      result = { error: 'Unknown task type', duration: Date.now() - startTime };
    }

    if (process.env['GITHUB_ACTIONS'] === 'true') {
      process.stderr.write(`[Worker-${workerId}] [Task-${taskId}] Task finished: ${type}\n`);
    }
    return result;
  } catch (error: any) {
    const errMsg = error instanceof Error ? error.message : String(error);

    if (process.env['GITHUB_ACTIONS'] === 'true') {
      process.stderr.write(`[Worker-${workerId}] [Task-${taskId}] Task FAILED: ${type} - ${errMsg}\n`);
    }

    // If the browser crashed or disconnected, clear the instance to force re-initialization on next task
    if (shouldResetBrowser(errMsg)) {
      resetBrowser();
    }

    return {
      error: errMsg,
      duration: Date.now() - startTime
    };
  }
}

const worker = new ClusterWorker(runTask, {
  killHandler: createKillHandler(),
});

if (process.env['GITHUB_ACTIONS'] === 'true') {
  process.stderr.write(`[Worker-${workerId}] ClusterWorker instantiated\n`);
}

export default worker;

// Eagerly warm the browser when the worker starts. Skipped in full mock mode
// so Firefox is never launched on constrained CI runners where startup takes 60-90s.
if (!FULL_MOCK_MODE) {
  initBrowser().catch(() => {});
}
