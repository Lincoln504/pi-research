import { describe, it, expect, vi, beforeEach } from 'vitest';
// We need to mock the external dependencies of scrapers.ts before importing it
vi.mock('@kreuzberg/html-to-markdown-node', () => ({
  convertWithVisitor: vi.fn().mockImplementation((html) => Promise.resolve(`Markdown for: ${html.slice(0, 20)}`)),
  JsHeadingStyle: { Atx: 'atx' },
  JsCodeBlockStyle: { Backticks: 'backticks' }
}));

// Mock utils for checkModule
vi.mock('../../../src/web-research/utils.ts', () => ({
  checkModule: vi.fn().mockReturnValue(true),
  trackContext: vi.fn(),
  untrackContextById: vi.fn(),
  clearTrackedContexts: vi.fn()
}));

import { initScraperDependencies, stopChromium } from '../../../src/web-research/scrapers.ts';

describe('scrapers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initScraperDependencies', () => {
    it('should initialize playwright availability', () => {
      initScraperDependencies();
      // No explicit way to check playwrightAvailable as it's not exported,
      // but we ensure it doesn't throw.
    });
  });

  describe('stopChromium', () => {
    it('should handle stopping when no browser is active', async () => {
      await expect(stopChromium()).resolves.not.toThrow();
    });

    it('should remain safe when stopping repeatedly', async () => {
      await expect(stopChromium()).resolves.not.toThrow();
      await expect(stopChromium()).resolves.not.toThrow();
    });
  });

  // Note: convertToMarkdown is private in scrapers.ts, so we can't test it directly
  // unless we export it or test via a public method like scrapeUrl.
  // Since scrapeUrl involves complex layer logic and Playwright, we'll focus
  // on the exported lifecycle and utility functions for now to avoid over-mocking.
});
