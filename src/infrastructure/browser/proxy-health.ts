/**
 * Liveness probe for the configured SOCKS proxy.
 *
 * WHY THIS EXISTS
 *
 * `~/.pi/research/proxy.json` routes EVERY browser request through a local
 * SOCKS5 proxy. Until this module, nothing verified that the proxy actually
 * forwards traffic: the health registry only checked that the browser is
 * installed, and the browser runtime check returns "ready (idle)" without
 * probing when the scheduler is idle. On 2026-10-29 the shipped proxy
 * (1.7.23) accepted the SOCKS handshake, connected upstream, and forwarded
 * nothing — a one-directional `pipeline()` — and the only symptom was
 * "Search completely failed: all 36 queries encountered worker errors" seven
 * minutes later, with `health` reporting "All systems operational".
 *
 * The probe speaks the protocol the browser speaks: SOCKS5 no-auth greeting,
 * CONNECT to an ordinary public host, one minimal HTTP request, and then it
 * requires at least one byte BACK. A tunnel that connects but never returns a
 * byte is the exact regression, so a connect-only check would not catch it.
 *
 * It is deliberately narrow: one host, one request, a few seconds. It is not a
 * substitute for the DuckDuckGo readiness probe; it answers "is the proxy
 * moving bytes", which is a different question from "is search working".
 */

import net from 'node:net';
import { getSocksProxyEndpoint, type SocksProxyEndpoint } from './proxy-prefs.ts';

export type ProxyProbeCode =
  | 'ok'
  | 'not-configured'
  | 'unreachable'
  | 'handshake-rejected'
  | 'connect-rejected'
  | 'no-data'
  | 'protocol-error';

export interface ProxyProbeResult {
  readonly healthy: boolean;
  readonly code: ProxyProbeCode;
  readonly reason: string;
  readonly endpoint: SocksProxyEndpoint | null;
  readonly latencyMs: number;
}

export interface ProxyProbeOptions {
  /** TCP connect + SOCKS handshake deadline. */
  readonly timeoutMs?: number;
  /** How long to wait for the first upstream byte after CONNECT succeeds. */
  readonly dataTimeoutMs?: number;
  /** Host:port the probe asks the proxy to reach. */
  readonly targetHost?: string;
  readonly targetPort?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_DATA_TIMEOUT_MS = 8_000;
// IANA's example host: automation-tolerant, tiny, stable, and reachable from
// every egress path that can serve a research run. The proxy resolves non-DDG
// names with normal DNS, so this also exercises its DNS path.
const DEFAULT_TARGET_HOST = 'example.com';
const DEFAULT_TARGET_PORT = 80;

function fail(
  code: ProxyProbeCode,
  reason: string,
  endpoint: SocksProxyEndpoint | null,
  startedAt: number,
): ProxyProbeResult {
  return { healthy: false, code, reason, endpoint, latencyMs: Date.now() - startedAt };
}

/**
 * Ask the proxy for one page and require bytes back.
 * Never throws: every failure is a classified result.
 */
export function probeSocksProxyForwarding(
  endpoint: SocksProxyEndpoint | null = getSocksProxyEndpoint(),
  options: ProxyProbeOptions = {},
): Promise<ProxyProbeResult> {
  const startedAt = Date.now();
  if (!endpoint) {
    return Promise.resolve({
      healthy: true,
      code: 'not-configured',
      reason: 'no SOCKS proxy configured (browser connects directly)',
      endpoint: null,
      latencyMs: 0,
    });
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dataTimeoutMs = options.dataTimeoutMs ?? DEFAULT_DATA_TIMEOUT_MS;
  const targetHost = options.targetHost ?? DEFAULT_TARGET_HOST;
  const targetPort = options.targetPort ?? DEFAULT_TARGET_PORT;
  const where = `${endpoint.host}:${endpoint.port}`;

  return new Promise<ProxyProbeResult>((resolve) => {
    const socket = net.connect({ host: endpoint.host, port: endpoint.port });
    let stage: 'greet' | 'connect' | 'data' = 'greet';
    let settled = false;
    let buffer = Buffer.alloc(0);

    const finish = (result: ProxyProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(dataTimer);
      socket.destroy();
      resolve(result);
    };

    const connectTimer = setTimeout(() => {
      finish(fail(
        stage === 'greet' ? 'unreachable' : 'no-data',
        stage === 'greet'
          ? `proxy at ${where} did not accept a TCP connection within ${timeoutMs}ms`
          : `proxy at ${where} accepted the connection but did not answer within ${timeoutMs}ms`,
        endpoint,
        startedAt,
      ));
    }, timeoutMs);
    connectTimer.unref?.();

    // Armed only after the success reply, so it measures the thing that broke:
    // the proxy said "connected" and then delivered nothing.
    let dataTimer: ReturnType<typeof setTimeout> | undefined;
    const armDataTimer = () => {
      dataTimer = setTimeout(() => {
        finish(fail(
          'no-data',
          `proxy at ${where} completed the SOCKS handshake to ${targetHost}:${targetPort} `
            + `but returned no data within ${dataTimeoutMs}ms `
            + '(the tunnel is not forwarding answers — check that the proxy process is running the current script and restart it)',
          endpoint,
          startedAt,
        ));
      }, dataTimeoutMs);
      dataTimer.unref?.();
    };

    socket.on('connect', () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00])); // SOCKS5, one method: no auth
    });

    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === 'greet') {
        if (buffer.length < 2) return;
        if (buffer[0] !== 0x05 || buffer[1] !== 0x00) {
          finish(fail(
            'protocol-error',
            `proxy at ${where} answered the SOCKS greeting with [${[...buffer.subarray(0, 2)]}] instead of [5,0]`,
            endpoint,
            startedAt,
          ));
          return;
        }
        buffer = buffer.subarray(2);
        const hostBytes = Buffer.from(targetHost, 'utf8');
        socket.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.length]),
          hostBytes,
          Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
        ]));
        stage = 'connect';
        return;
      }

      if (stage === 'connect') {
        if (buffer.length < 4) return;
        if (buffer[0] !== 0x05) {
          finish(fail('protocol-error', `proxy at ${where} answered the SOCKS request malformed`, endpoint, startedAt));
          return;
        }
        const reply = buffer[1];
        if (reply !== 0x00) {
          const meaning = reply === 0x02
            ? 'refused by ruleset'
            : reply === 0x03 ? 'network unreachable'
              : reply === 0x04 ? 'host unreachable'
                : reply === 0x05 ? 'connection refused by the target' : `SOCKS error ${reply}`;
          finish(fail(
            'connect-rejected',
            `proxy at ${where} refused CONNECT to ${targetHost}:${targetPort} (${meaning})`,
            endpoint,
            startedAt,
          ));
          return;
        }
        // Consume the bound-address field so leftover bytes cannot be mistaken
        // for the response body of the request below.
        const atyp = buffer[3];
        let addrLen: number;
        if (atyp === 0x01) {
          addrLen = 4;
        } else if (atyp === 0x04) {
          addrLen = 16;
        } else if (atyp === 0x03) {
          if (buffer.length < 5) return; // the domain-length byte is not in yet
          addrLen = 1 + (buffer[4] ?? 0);
        } else {
          finish(fail('protocol-error', `proxy at ${where} answered CONNECT with unknown address type ${atyp}`, endpoint, startedAt));
          return;
        }
        const replyLen = 4 + addrLen + 2;
        if (buffer.length < replyLen) return;
        buffer = buffer.subarray(replyLen);
        // The handshake is over: the connect deadline must not keep ticking while
        // we wait for the response, or a short connect budget would masquerade as
        // "no data". The data deadline takes over.
        clearTimeout(connectTimer);
        socket.write(
          `GET / HTTP/1.0\r\nHost: ${targetHost}\r\nConnection: close\r\n\r\n`,
        );
        stage = 'data';
        armDataTimer();
        // A pipelined byte that arrived with the reply counts as data.
        if (buffer.length > 0) {
          finish({
            healthy: true,
            code: 'ok',
            reason: `proxy at ${where} forwards traffic (first byte in ${Date.now() - startedAt}ms)`,
            endpoint,
            latencyMs: Date.now() - startedAt,
          });
        }
        return;
      }

      finish({
        healthy: true,
        code: 'ok',
        reason: `proxy at ${where} forwards traffic (first byte in ${Date.now() - startedAt}ms)`,
        endpoint,
        latencyMs: Date.now() - startedAt,
      });
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      const detail = err.code === 'ECONNREFUSED'
        ? 'nothing is listening there — is the proxy service running?'
        : err.message;
      finish(fail('unreachable', `proxy at ${where} is unusable: ${detail}`, endpoint, startedAt));
    });

    socket.on('close', () => {
      finish(fail(
        'no-data',
        `proxy at ${where} closed the tunnel before returning data`,
        endpoint,
        startedAt,
      ));
    });
  });
}

/**
 * A one-line diagnosis to append to a run-level search failure, or null when the
 * proxy is healthy/not configured. Kept separate from the probe used by the
 * health registry: this one is bounded tighter, because it runs while the user
 * is already waiting for an error.
 */
export async function describeProxyIfBroken(): Promise<string | null> {
  const endpoint = getSocksProxyEndpoint();
  if (!endpoint) return null;
  // TWO attempts. This verdict STOPS a run, so it must not rest on one sample: a
  // single refused connect during a proxy restart, or one oversized response,
  // would abort work that the next probe would have cleared. A genuinely dead
  // or one-way tunnel fails both attempts.
  let last = await probeSocksProxyForwarding(endpoint, { timeoutMs: 3_000, dataTimeoutMs: 3_000 });
  if (!last.healthy) {
    last = await probeSocksProxyForwarding(endpoint, { timeoutMs: 3_000, dataTimeoutMs: 6_000 });
  }
  if (last.healthy) return null;
  return `SOCKS proxy check: ${last.reason}.`;
}
