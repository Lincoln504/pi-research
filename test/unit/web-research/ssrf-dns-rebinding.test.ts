/**
 * Security regression tests for the request-time DNS-rebinding branch of
 * validateUrlForSSRF.
 *
 * validateUrlForSSRF first runs the synchronous literal/pattern screen
 * (validateUrlForSSRFSync). A non-literal hostname passes that screen and reaches
 * the DNS branch, which resolves the hostname via dns.resolve4/resolve6 and
 * rejects any result that is a private/reserved address (block_type
 * dns_rebinding_v4 / dns_rebinding_v6). This is the ONLY code path that catches:
 *   - DNS rebinding (public answer at validation, private at connect),
 *   - decimal/octal IP representations that resolve to private space,
 *   - the CGNAT / shared-address (RFC 6598 100.64.0.0/10) range.
 *
 * Every other SSRF test in this repo hits an IP literal or the localhost pattern
 * and returns before the DNS branch, so that branch had zero coverage. These
 * tests exercise it by mocking node:dns/promises (the same module scraper-utils
 * resolves through) — deterministic and fully offline, no real DNS is issued.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted mock fns so vi.mock's factory (which is hoisted above the imports) can
// reference them. Each test drives what the hostname "resolves" to.
const { mockResolve4, mockResolve6 } = vi.hoisted(() => ({
  mockResolve4: vi.fn<(host: string) => Promise<string[]>>(),
  mockResolve6: vi.fn<(host: string) => Promise<string[]>>(),
}));

vi.mock('node:dns/promises', () => ({
  resolve4: mockResolve4,
  resolve6: mockResolve6,
}));

import { validateUrlForSSRF } from '../../../src/web-research/scraper-utils.ts';

const FLAG = 'PI_RESEARCH_ALLOW_LOOPBACK_SCRAPE';

// A hostname that is NOT an IP literal and matches none of the internal-network
// patterns, so the sync screen passes and the DNS branch runs.
const HOST = 'rebind.example.com';

describe('validateUrlForSSRF — request-time DNS-rebinding branch', () => {
  beforeEach(() => {
    // Default: nothing resolves. Individual tests override one family.
    mockResolve4.mockResolvedValue([]);
    mockResolve6.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env[FLAG];
  });

  it('rejects a hostname that rebinds to IPv4 loopback (127.0.0.1)', async () => {
    mockResolve4.mockResolvedValue(['127.0.0.1']);
    await expect(validateUrlForSSRF(`http://${HOST}/`)).rejects.toThrow(
      'private/reserved IPv4'
    );
  });

  it('rejects a hostname that rebinds to an RFC1918 private address (10.x)', async () => {
    mockResolve4.mockResolvedValue(['10.0.0.5']);
    await expect(validateUrlForSSRF(`http://${HOST}/`)).rejects.toThrow(
      'private/reserved IPv4'
    );
  });

  it('rejects a hostname that rebinds to an RFC1918 private address (192.168.x)', async () => {
    mockResolve4.mockResolvedValue(['192.168.1.10']);
    await expect(validateUrlForSSRF(`http://${HOST}/`)).rejects.toThrow(
      'private/reserved IPv4'
    );
  });

  it('rejects a hostname that rebinds to a CGNAT / shared-address (100.64.0.0/10) IP', async () => {
    // RFC 6598 space is routinely routed to internal infra by cloud/hosting
    // providers — this range is reachable ONLY through the DNS branch's isPrivateIp.
    mockResolve4.mockResolvedValue(['100.64.0.1']);
    await expect(validateUrlForSSRF(`http://${HOST}/`)).rejects.toThrow(
      'private/reserved IPv4'
    );
  });

  it('rejects the cloud-metadata link-local address (169.254.169.254) resolved via DNS', async () => {
    mockResolve4.mockResolvedValue(['169.254.169.254']);
    await expect(validateUrlForSSRF(`http://${HOST}/`)).rejects.toThrow(
      'private/reserved IPv4'
    );
  });

  it('rejects a hostname that rebinds to an IPv6 private address (AAAA-only)', async () => {
    mockResolve4.mockResolvedValue([]);
    mockResolve6.mockResolvedValue(['fc00::1']);
    await expect(validateUrlForSSRF(`http://${HOST}/`)).rejects.toThrow(
      'private/reserved IPv6'
    );
  });

  it('rejects when ANY resolved address is private, even alongside a public one', async () => {
    // A rebinding record may mix a public and a private answer; a single private
    // address must fail closed.
    mockResolve4.mockResolvedValue(['93.184.216.34', '10.0.0.5']);
    await expect(validateUrlForSSRF(`http://${HOST}/`)).rejects.toThrow(
      'private/reserved IPv4'
    );
  });

  it('passes a hostname that resolves only to a public address', async () => {
    mockResolve4.mockResolvedValue(['93.184.216.34']);
    mockResolve6.mockResolvedValue([]);
    await expect(validateUrlForSSRF(`http://${HOST}/`)).resolves.toBeUndefined();
  });

  it('does NOT relax the DNS branch for a non-loopback private IP even with the loopback flag', async () => {
    // The loopback affordance is a SYNC-screen-only literal path; a hostname that
    // resolves to RFC1918 space via DNS must still be rejected.
    process.env[FLAG] = 'true';
    mockResolve4.mockResolvedValue(['10.0.0.5']);
    await expect(validateUrlForSSRF(`http://${HOST}/`)).rejects.toThrow(
      'private/reserved IPv4'
    );
  });
});
