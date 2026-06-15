/**
 * Security regression tests for the PI_RESEARCH_ALLOW_LOOPBACK_SCRAPE flag.
 *
 * This flag exists ONLY so integration tests can scrape a localhost server with
 * the real browser. It must:
 *   - be off by default (loopback blocked like every other internal target), and
 *   - when on, relax ONLY loopback — cloud-metadata (169.254.169.254) and RFC1918
 *     LAN ranges must stay blocked so the dangerous SSRF targets are never opened.
 *
 * All cases below are caught by the synchronous hostname checks (no DNS), so the
 * tests are deterministic and offline.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { validateUrlForSSRF } from '../../../src/web-research/scraper-utils.ts';

const FLAG = 'PI_RESEARCH_ALLOW_LOOPBACK_SCRAPE';

describe('validateUrlForSSRF — loopback allowance flag', () => {
  afterEach(() => {
    delete process.env[FLAG];
  });

  describe('default (flag unset): every internal target is blocked', () => {
    it('blocks loopback 127.0.0.1', async () => {
      await expect(validateUrlForSSRF('http://127.0.0.1:8080/')).rejects.toThrow();
    });
    it('blocks localhost', async () => {
      await expect(validateUrlForSSRF('http://localhost:3000/')).rejects.toThrow();
    });
    it('blocks cloud-metadata 169.254.169.254', async () => {
      await expect(validateUrlForSSRF('http://169.254.169.254/latest/meta-data/')).rejects.toThrow();
    });
  });

  describe('flag on: relaxes ONLY loopback', () => {
    it('allows loopback 127.0.0.1', async () => {
      process.env[FLAG] = 'true';
      await expect(validateUrlForSSRF('http://127.0.0.1:8080/')).resolves.toBeUndefined();
    });
    it('allows localhost', async () => {
      process.env[FLAG] = 'true';
      await expect(validateUrlForSSRF('http://localhost:3000/')).resolves.toBeUndefined();
    });
    it('STILL blocks cloud-metadata 169.254.169.254', async () => {
      process.env[FLAG] = 'true';
      await expect(validateUrlForSSRF('http://169.254.169.254/latest/meta-data/')).rejects.toThrow();
    });
    it('STILL blocks RFC1918 LAN ranges (10.x and 192.168.x)', async () => {
      process.env[FLAG] = 'true';
      await expect(validateUrlForSSRF('http://10.0.0.1/')).rejects.toThrow();
      await expect(validateUrlForSSRF('http://192.168.1.1/')).rejects.toThrow();
    });
    it('only "true" enables it — other values stay blocked', async () => {
      process.env[FLAG] = '1';
      await expect(validateUrlForSSRF('http://127.0.0.1/')).rejects.toThrow();
    });
  });
});
