/**
 * Thread Worker Browser Management
 *
 * Handles browser initialization, context management, and cleanup.
 */

import { getRandomRealisticUA } from '../utils/user-agent.ts';
import * as fs from 'node:fs';

let browser: any = null;
let context: any = null;
let initPromise: Promise<void> | null = null;
let workerId: string = '';

/**
 * Set the worker ID for logging purposes
 */
export function setWorkerId(id: string): void {
  workerId = id;
}

/**
 * Check if browser is connected
 */
const isBrowserConnected = () => {
  try {
    return browser && typeof browser.isConnected === 'function' && browser.isConnected();
  } catch {
    return false;
  }
};

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
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  } catch {
    // ignore
  }
}

/**
 * Initialize the browser instance
 */
export async function initBrowser(): Promise<void> {
  if (isBrowserConnected() && context) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      if (!isBrowserConnected() || !context) {
        logToDebugFile('INFO', `[Worker-${workerId}] Initializing browser instance...`);

        let CamoufoxModule: any;
        try {
          CamoufoxModule = await import('camoufox-js');
        } catch (e: any) {
          throw new Error(`[Worker] camoufox-js not found in node_modules. Please run 'npm install'. Original error: ${e.message}`, { cause: e });
        }

        const { Camoufox } = CamoufoxModule;

        // Launch browser without user_data_dir so Playwright creates an isolated
        // temp profile per instance. This avoids persistent-context semantics
        // (where context.browser() returns null) and the profile-lock contention
        // that came with sharing a single user_data_dir path.
        // Try with stealth addons first, fall back to basic config if it fails
        let launchedBrowser: any;
        try {
          launchedBrowser = await Camoufox({
            headless: true,
            humanize: true,

            // ENHANCED STEALTH OPTIONS
            addons: [
              'stealth',           // Core stealth features
              'canvas',            // Canvas fingerprint protection
              'webgl',             // WebGL fingerprint spoofing
              'fonts',             // Font fingerprint randomization
              'audio',             // Audio context spoofing
              'media',             // Media device spoofing
              'locale',            // Locale/language mimicking
              'permissions',       // Permission spoofing
            ],

            // Screen properties to mimic real display
            screen: {
              width: 1920,
              height: 1080,
              colorDepth: 24,
              pixelRatio: 1,
            },

            // Locale and timezone to match a real user
            locale: 'en-US',
            timezone: 'America/New_York',

            // Geolocation (optional, can be randomized)
            geolocation: {
              latitude: 40.7128,  // New York City
              longitude: -74.0060,
            },

            // Use realistic User-Agent
            userAgent: getRandomRealisticUA(),

            // Disable automation indicators that Cloudflare detects
            exclude: [
              '--enable-automation',
              '--disable-blink-features=AutomationControlled',
            ],
          });
        } catch (stealthError: any) {
          // Stealth addons may fail in some environments, try without them
          logToDebugFile('WARN', `[Worker-${workerId}] Stealth addons failed, retrying without: ${stealthError.message}`);
          launchedBrowser = await Camoufox({
            headless: true,
            humanize: true,

            // Screen properties to mimic real display
            screen: {
              width: 1920,
              height: 1080,
              colorDepth: 24,
              pixelRatio: 1,
            },

            // Locale and timezone to match a real user
            locale: 'en-US',
            timezone: 'America/New_York',

            // Use realistic User-Agent
            userAgent: getRandomRealisticUA(),

            // Disable automation indicators that Cloudflare detects
            exclude: [
              '--enable-automation',
              '--disable-blink-features=AutomationControlled',
            ],
          });
        }

        context = await launchedBrowser.newContext({
          viewport: { width: 1920, height: 1080 },
        });

        browser = launchedBrowser;
        logToDebugFile('INFO', `[Worker-${workerId}] Browser initialized.`);
      }
    } catch (e: any) {
      // Close any partially-launched browser to avoid orphaning the process.
      if (browser && typeof browser.close === 'function') {
        browser.close().catch(() => {});
      }
      browser = null;
      context = null;
      const msg = e instanceof Error ? e.message : String(e);

      if (msg.includes('Camoufox is not installed') || msg.includes('Version information not found')) {
        throw new Error(`[Worker] Browser binaries not found. Please run 'npm run setup' to install them.`, { cause: e });
      }

      throw e;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

/**
 * Get the current browser instance
 */
export function getBrowser(): any {
  return browser;
}

/**
 * Get the current browser context
 */
export function getContext(): any {
  return context;
}

/**
 * Reset browser and context (used after crashes)
 */
export function resetBrowser(): void {
  if (context) context.close().catch(() => {});
  if (browser) browser.close().catch(() => {});
  context = null;
  browser = null;
}

/**
 * Clean up browser resources
 */
export async function cleanupBrowser(): Promise<void> {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  context = null;
  browser = null;
}