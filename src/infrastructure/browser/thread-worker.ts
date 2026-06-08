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

/**
 * Main task execution function
 */
async function runTask(data: TaskData | undefined): Promise<TaskResult> {
  if (!data) {
    return { error: 'No task data provided', duration: 0 };
  }
  const { type, query, url, queuedAt: _queuedAt, taskTimeoutMs: _taskTimeoutMs } = data;
  const startTime = Date.now();

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

    return result;
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);

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

export default worker;

// DEFERRED: Eagerly warming the browser when the worker starts is disabled
// to prevent "thundering herd" resource spikes. Instead, the browser is
// initialized lazily upon receipt of the first task in runTask().
/*
if (!FULL_MOCK_MODE) {
  initBrowser().catch(() => {});
}
*/
