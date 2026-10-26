import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { assertReadAllowed, createGuardedReadOperations } from '../../../src/tools/read-guard.ts';
import { frameUntrustedReport, UNTRUSTED_REPORT_NOTICE } from '../../../src/utils/untrusted-notice.ts';

describe('read guard', () => {
  let base: string;
  let proj: string;
  let outside: string;

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'pi-read-guard-')));
    proj = join(base, 'proj');
    outside = join(base, 'outside.txt');
    mkdirSync(join(proj, 'src'), { recursive: true });
    mkdirSync(join(proj, '.ssh'));
    mkdirSync(join(proj, '.git'));
    writeFileSync(join(proj, 'src', 'a.ts'), 'ok');
    writeFileSync(join(proj, '.env'), 'SECRET=1');
    writeFileSync(join(proj, '.env.production'), 'SECRET=1');
    writeFileSync(join(proj, 'server.pem'), 'k');
    writeFileSync(join(proj, '.envrc'), 'x');
    writeFileSync(join(proj, '.env.example'), 'KEY=');
    writeFileSync(join(proj, 'credentials.ts'), 'x');
    writeFileSync(join(proj, 'server.key'), 'k');
    writeFileSync(join(proj, 'id_ecdsa_sk'), 'k');
    writeFileSync(join(proj, '.dockerconfigjson'), '{}');
    mkdirSync(join(proj, '.terraform'));
    writeFileSync(join(proj, '.terraform', 'credentials.tfrc.json'), '{}');
    mkdirSync(join(proj, '..data'));
    writeFileSync(join(proj, '..data', 'cfg.json'), '{}');
    writeFileSync(join(proj, '.ssh', 'config'), 'x');
    writeFileSync(join(proj, '.git', 'config'), 'x');
    writeFileSync(outside, 'secret');
    if (platform() !== 'win32') symlinkSync(outside, join(proj, 'link.txt'));
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('allows an ordinary project file', async () => {
    await expect(assertReadAllowed(proj, join(proj, 'src', 'a.ts'))).resolves.toBeUndefined();
    const buf = await createGuardedReadOperations(proj).readFile(join(proj, 'src', 'a.ts'));
    expect(buf.toString()).toBe('ok');
  });

  it('denies paths outside the project and traversal', async () => {
    await expect(assertReadAllowed(proj, outside)).rejects.toThrow(/outside the project/);
    await expect(assertReadAllowed(proj, join(proj, '..', 'outside.txt'))).rejects.toThrow(/outside the project/);
    await expect(createGuardedReadOperations(proj).access(outside)).rejects.toThrow(/read denied/);
  });

  it.skipIf(platform() === 'win32')('denies a symlink that escapes the project', async () => {
    await expect(assertReadAllowed(proj, join(proj, 'link.txt'))).rejects.toThrow(/outside the project/);
    await expect(createGuardedReadOperations(proj).readFile(join(proj, 'link.txt'))).rejects.toThrow(/read denied/);
  });

  it('denies secret files and credential directories inside the project', async () => {
    for (const p of [
      '.env',
      '.env.production',
      'server.pem',
      '.envrc',
      'server.key',
      'tls.key',
      'id_ecdsa_sk',
      'id_rsa_sk',
      '.dockerconfigjson',
      'service-account.json',
    ]) {
      await expect(assertReadAllowed(proj, join(proj, p))).rejects.toThrow(/credential or secret/);
    }
    await expect(assertReadAllowed(proj, join(proj, '.ssh', 'config'))).rejects.toThrow(/credential or VCS/);
    await expect(assertReadAllowed(proj, join(proj, '.git', 'config'))).rejects.toThrow(/credential or VCS/);
    await expect(
      assertReadAllowed(proj, join(proj, '.terraform', 'credentials.tfrc.json')),
    ).rejects.toThrow(/credential or VCS/);
  });

  it('allows env templates and a ..-prefixed child directory', async () => {
    await expect(assertReadAllowed(proj, join(proj, '.env.example'))).resolves.toBeUndefined();
    await expect(assertReadAllowed(proj, join(proj, '..data', 'cfg.json'))).resolves.toBeUndefined();
    await expect(assertReadAllowed(proj, join(proj, 'credentials.ts'))).resolves.toBeUndefined();
  });

  it('refuses when the working directory is the home directory or an ancestor', async () => {
    const { homedir } = await import('node:os');
    await expect(assertReadAllowed(homedir(), join(homedir(), 'x.txt'))).rejects.toThrow(/home or filesystem root/);
    await expect(assertReadAllowed('/', '/etc/hostname')).rejects.toThrow(/home or filesystem root/);
  });
});

describe('untrusted report framing', () => {
  it('prepends the notice and leaves empty input alone', () => {
    expect(frameUntrustedReport('# Report')).toBe(`${UNTRUSTED_REPORT_NOTICE}\n\n# Report`);
    expect(frameUntrustedReport('')).toBe('');
  });
});
