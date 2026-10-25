/**
 * Local SOCKS proxy preference for the browser workers.
 *
 * `~/.pi/research/proxy.json` ({"host":"127.0.0.1","port":1080}) routes every
 * browser request through a local SOCKS proxy. It exists because the system
 * resolver returns an unreachable DuckDuckGo front-door IP from this machine's
 * egress path; the local proxy (scripts/ddg-socks-proxy.mjs) pins DDG hostnames
 * to the verified-live IP. A file rather than an env var, so a long-lived leader
 * picks it up without a restart.
 *
 * It lives in its own module because TWO code paths in the same worker process
 * need it, for different reasons:
 *   • thread-worker-browser.ts  — to launch the browser through it, and
 *   • thread-worker-messaging.ts — to know that a response's `serverAddr()` is
 *     the PROXY hop, not the origin, so the DNS-rebinding backstop does not
 *     condemn every proxied scrape (see isProxyHopAddress).
 *
 * Read fresh (short cache) so enabling/disabling the proxy does not need a
 * process restart, matching how the launcher already treats the file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

export interface SocksProxyEndpoint {
  readonly host: string;
  readonly port: number;
}

/** Override the preference file (tests, and non-default layouts). */
function proxyConfigPath(): string {
  return process.env['PI_RESEARCH_PROXY_JSON'] || `${homedir()}/.pi/research/proxy.json`;
}

let cached: SocksProxyEndpoint | null | undefined;
let cachedAt = 0;
const CACHE_TTL_MS = 10_000;

/**
 * The configured SOCKS endpoint, or null when the proxy is off.
 * Never throws: an unreadable/malformed file means "no proxy", exactly as the
 * launcher treats it.
 */
export function getSocksProxyEndpoint(): SocksProxyEndpoint | null {
  const now = Date.now();
  if (cached !== undefined && now - cachedAt < CACHE_TTL_MS) return cached;
  cachedAt = now;
  try {
    const file = proxyConfigPath();
    if (!existsSync(file)) {
      cached = null;
      return cached;
    }
    const cfg = JSON.parse(readFileSync(file, 'utf8')) as { host?: string; port?: number };
    const host = cfg.host ?? '127.0.0.1';
    const port = cfg.port ?? 1080;
    cached = host ? { host, port } : null;
    return cached;
  } catch {
    cached = null;
    return cached;
  }
}

/** Firefox prefs that route the browser through the configured SOCKS proxy. */
export function loadSocksProxyPrefs(): Record<string, string | number | boolean> {
  const endpoint = getSocksProxyEndpoint();
  if (!endpoint) return {};
  return {
    'network.proxy.type': 1,
    'network.proxy.socks': endpoint.host,
    'network.proxy.socks_port': endpoint.port,
    'network.proxy.socks_remote_dns': true,
    'network.proxy.socks_version': 5,
    'network.proxy.no_proxies_on': '',
  };
}

/** Drop the memoized endpoint (tests; also called when the file changes). */
export function resetSocksProxyCache(): void {
  cached = undefined;
  cachedAt = 0;
}

/**
 * True when `ip` describes the proxy hop rather than the origin server.
 *
 * PROVEN behaviour (measured 2026-10-25 on this machine, camoufox 0.5.8): through
 * the SOCKS proxy, `response.serverAddr().ipAddress` for https://example.com is
 * `0.0.0.0`; with the proxy off it is the real origin IP (`104.20.23.154`).
 *
 * Firefox cannot report the origin's address when a SOCKS5 proxy with remote DNS
 * resolves and connects on its behalf, so `0.0.0.0`/`::` mean "unknown", NOT
 * "connect to the unspecified address". Treating unknown as private poisoned
 * every proxied scrape: from the day the proxy landed (2026-09-03) until this
 * fix, 100% of browser-fallback scrapes failed with
 * 'Fetch blocked: a response was served from a private/reserved address', which
 * removed the path that gets content from sites answering a plain fetch with 403
 * (Stack Overflow, Android developer docs, DeepWiki were the ones failing in the
 * observed runs; some fallbacks fail for unrelated reasons too, so this was the
 * largest single cause rather than the only one).
 *
 * The check is deliberately gated on a configured proxy: with no proxy, Firefox
 * reports the true remote address, and an unspecified address there is anomalous
 * enough to keep blocking.
 */
export function isProxyHopAddress(ip: string, proxy: SocksProxyEndpoint | null = getSocksProxyEndpoint()): boolean {
  if (!proxy) return false;
  const addr = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (addr === '' || addr === '0.0.0.0' || addr === '::' || addr === '::0') return true;
  const proxyHost = proxy.host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return addr === proxyHost;
}
