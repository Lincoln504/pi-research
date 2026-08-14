/**
 * User-Agent pool shape.
 *
 * These strings are refreshed by hand as Chrome and Firefox ship (roughly every
 * four weeks each). This guards the refresh itself: a hand-edited UA that says
 * `rv:153.0` but `Firefox/152.0`, or a Chrome token missing its zeroed minor
 * triplet, is a sharper fingerprint than the stale version it replaced. It
 * deliberately does NOT assert a version FLOOR — that would need updating on the
 * browsers' schedule rather than this project's, and would go red for reasons
 * unrelated to any change here.
 */

import { describe, it, expect } from 'vitest';
import { USER_AGENTS } from '../../../src/utils/user-agent.ts';

describe('USER_AGENTS', () => {
  it('is a non-empty pool of unique strings', () => {
    expect(USER_AGENTS.length).toBeGreaterThan(1);
    expect(new Set(USER_AGENTS).size).toBe(USER_AGENTS.length);
  });

  it('every entry is a well-formed Chrome or Firefox desktop UA', () => {
    // Chrome froze the minor/build/patch triplet at 0.0.0 under UA reduction.
    const chrome = /^Mozilla\/5\.0 \((?:Windows NT 10\.0; Win64; x64|Macintosh; Intel Mac OS X 10_15_7|X11; Linux x86_64)\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/(\d+)\.0\.0\.0 Safari\/537\.36$/;
    const firefox = /^Mozilla\/5\.0 \((?:Windows NT 10\.0; Win64; x64|Macintosh; Intel Mac OS X 10\.15); rv:(\d+)\.0\) Gecko\/20100101 Firefox\/(\d+)\.0$/;

    for (const ua of USER_AGENTS) {
      const c = chrome.exec(ua);
      const f = firefox.exec(ua);
      expect(Boolean(c) || Boolean(f), `malformed UA: ${ua}`).toBe(true);
      // Gecko's `rv:` and the trailing Firefox token must name the same major;
      // a mismatch is a fingerprint no real Firefox produces.
      if (f) expect(f[1], `rv/Firefox major mismatch: ${ua}`).toBe(f[2]);
    }
  });

  it('covers both engines across the platforms it claims', () => {
    const majors = (re: RegExp) =>
      new Set(USER_AGENTS.map((ua) => re.exec(ua)?.[1]).filter(Boolean) as string[]);
    const chromeMajors = majors(/Chrome\/(\d+)\./);
    const firefoxMajors = majors(/Firefox\/(\d+)\./);

    expect(chromeMajors.size).toBeGreaterThanOrEqual(2);
    expect(firefoxMajors.size).toBeGreaterThanOrEqual(2);
    // Real traffic is dominated by the current and previous major; a pool
    // spanning a wide range would stand out rather than blend in.
    for (const set of [chromeMajors, firefoxMajors]) {
      const nums = [...set].map(Number).sort((a, b) => a - b);
      expect(nums[nums.length - 1]! - nums[0]!).toBeLessThanOrEqual(2);
    }
  });
});
