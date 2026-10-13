import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

/**
 * Requests from other websites. A page that someone on the network opens in
 * their browser can send requests to TeXWerk as that person (cross-site
 * request forgery), or point a domain of its own at the server's address and
 * then read the answers (DNS rebinding). Hence:
 *
 * - The Host must be a name the server is reached by on the network: an IP
 *   address, `localhost`, a single-label name (a tailnet's MagicDNS name or a
 *   LAN host), `*.ts.net`, `*.local`, or a name given with `--allow-host`.
 *   Nobody can point a public domain of their own at one of these.
 * - A request from a web page must come from one of this server's own pages:
 *   its Origin must name the host it was sent to. Requests without an Origin
 *   (the mirror bridge, curl, links and images) pass.
 *
 * Returns why a request is refused, or null.
 */
export function refusal(request: IncomingMessage, allowHosts: readonly string[]): string | null {
  const host = String(request.headers.host ?? '').toLowerCase();
  if (!hostAllowed(host, allowHosts)) {
    return `TeXWerk does not answer to the name "${host}". If that is how people reach this server, start it with --allow-host ${hostname(host) ?? host}.`;
  }
  const origin = request.headers.origin;
  if (origin === undefined) return null;
  // Behind `tailscale serve` the browser's host arrives as X-Forwarded-Host.
  const forwarded = isLoopback(request) ? String(request.headers['x-forwarded-host'] ?? '').toLowerCase() : '';
  let from: string;
  try { from = new URL(origin).host.toLowerCase(); } catch { return 'request from another website refused'; }
  return from === host || (forwarded && from === forwarded) ? null : 'request from another website refused';
}

function hostname(host: string): string | null {
  try { return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, ''); } catch { return null; }
}

export function hostAllowed(host: string, allowHosts: readonly string[]): boolean {
  const name = hostname(host);
  if (!name) return false;
  if (isIP(name) || name === 'localhost' || !name.includes('.')) return true;
  if (name.endsWith('.ts.net') || name.endsWith('.local')) return true;
  return allowHosts.some((h) => h.toLowerCase() === name);
}

function isLoopback(request: IncomingMessage): boolean {
  const remote = request.socket.remoteAddress ?? '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}
