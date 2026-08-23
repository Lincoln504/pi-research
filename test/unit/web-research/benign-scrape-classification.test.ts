/**
 * What counts as an expected per-URL scrape outcome versus a real fault.
 *
 * Each string below was taken from a production run log, where it was reported at
 * ERROR: a university PDF host with an expired certificate, two sites too slow to
 * answer inside the scrape budget, an attachment that turned out not to be a PDF.
 * None is actionable — the URL is already accounted for as "not scraped" — and each
 * inflated both the ERROR log and the diagnostic error count.
 *
 * The exclusions matter as much as the matches: `page.goto: Target closed` is how a
 * crashed or force-closed browser surfaces, and a missing PDF native module breaks
 * every URL rather than one, so both must keep reporting as faults.
 */

import { describe, it, expect } from 'vitest';
import { isBenignScrapeFailure } from '../../../src/web-research/scraper-utils.ts';

describe('isBenignScrapeFailure — navigation-level outcomes', () => {
  const benign = [
    'page.goto: Timeout 15000ms exceeded.',
    'page.goto: Timeout 30000 ms exceeded.',
    'page.goto: SEC_ERROR_UNKNOWN_ISSUER',
    'page.goto: MOZILLA_PKIX_ERROR_SELF_SIGNED_CERT',
    'page.goto: net::ERR_NAME_NOT_RESOLVED',
    'page.goto: NS_ERROR_CONNECTION_REFUSED',
    'Unsupported download: dataset.zip is not a PDF',
  ];
  for (const msg of benign) {
    it(`treats "${msg.slice(0, 44)}" as an expected per-URL outcome`, () => {
      expect(isBenignScrapeFailure(new Error(msg))).toBe(true);
    });
  }

  const faults = [
    'page.goto: Target closed',
    'PDF extraction unavailable: pdf-oxide-wasm failed to load',
    'Cannot read properties of undefined (reading url)',
    'Timeout 15000ms exceeded.',
  ];
  for (const msg of faults) {
    it(`keeps "${msg.slice(0, 44)}" classified as a fault`, () => {
      expect(isBenignScrapeFailure(new Error(msg))).toBe(false);
    });
  }

  it('still matches the outcomes it covered before', () => {
    for (const msg of [
      'Fetch blocked: Cloudflare challenge unresolved',
      'Fetch returned stub: nav-only page',
      'HTTP 404',
      'HTTP 503',
      'PDF too large (412MB, max 100MB)',
      'Could not extract content from PDF',
      'Browser HTML too large (31MB, max 25MB)',
      'HTML response too large (28MB, max 25MB)',
    ]) {
      expect(isBenignScrapeFailure(new Error(msg)), msg).toBe(true);
    }
  });
});
