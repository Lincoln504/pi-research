/**
 * Web Research Extension - Scrapers
 *
 * Re-exports from the web scraper module
 */

export {
  scrapeSingle,
  scrape,
  getDependencyStatus,
  initScraperDependencies,
} from './web-scraper.ts';
export type * from './scraper-types.ts';
export * from './scraper-utils.ts';