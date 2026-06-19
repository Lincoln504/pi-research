import { describe, it, expect } from 'vitest';
import { PI_BROWSER_MARKER } from '../../../src/infrastructure/browser/browser-cleanup.ts';

/**
 * Safety contract: the orphan sweep must positively identify OUR Camoufox
 * processes and must NEVER match the user's own system Firefox — killing a
 * personal browser on a desktop would be a severe regression. These are real
 * command lines captured from `ps -eo args`.
 */
describe('PI_BROWSER_MARKER', () => {
  const OURS = [
    '/home/u/.cache/camoufox/camoufox-bin -no-remote -headless -profile /home/u/.cache/pi-research/profiles/playwright_firefoxdev_profile-i8tZLw -juggler-pipe -silent',
    '/home/u/.cache/camoufox/camoufox-bin -contentproc -parentBuildID 20250315105650 -prefsHandle 0',
    'C:\\Users\\u\\.cache\\pi-research\\profiles\\playwright_firefoxdev_profile-xyz\\firefox.exe',
  ];
  const THEIRS = [
    'firefox',
    '/usr/lib/firefox/firefox-bin -contentproc -ipcHandle 0 -signalPipe 1',
    '/usr/lib/firefox/firefox -P default-release',
    '/snap/firefox/1234/usr/lib/firefox/firefox',
    '/Applications/Firefox.app/Contents/MacOS/firefox',
  ];

  it('matches every pi-research Camoufox command line', () => {
    for (const cmd of OURS) expect(PI_BROWSER_MARKER.test(cmd), cmd).toBe(true);
  });

  it('never matches the user system Firefox', () => {
    for (const cmd of THEIRS) expect(PI_BROWSER_MARKER.test(cmd), cmd).toBe(false);
  });
});
