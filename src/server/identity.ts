import type { IncomingMessage } from 'node:http';
import { colorFor } from '../shared/files.ts';
import type { Identity } from '../shared/protocol.ts';

/**
 * Who is making a request — the same model as DeckWerk's collab server.
 *
 * With `--access <adminLogin>` the server binds loopback behind
 * `tailscale serve`, which stamps each proxied request with
 * Tailscale-User-Login / Tailscale-User-Name. Those headers are trusted only
 * from a loopback peer. A proxied request without a login (tagged node,
 * funnel) is refused. A bare loopback request is a shell on the machine
 * itself and counts as the admin.
 *
 * Without `--access` there is no identity to trust: the browser sends the
 * name its user typed, which is used for carets and history only.
 */
export interface AccessConfig {
  admin: string;
}

function isLoopback(request: IncomingMessage): boolean {
  const remote = request.socket.remoteAddress ?? '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function header(request: IncomingMessage, name: string): string {
  const raw = request.headers[name];
  return ((Array.isArray(raw) ? raw[0] : raw) ?? '').trim();
}

function make(login: string, name: string): Identity {
  return { login, name, color: colorFor(login) };
}

export function resolveIdentity(request: IncomingMessage, access: AccessConfig | null, claimedName: string | null): Identity | null {
  if (!access) {
    const name = (claimedName ?? '').trim().slice(0, 60) || 'Anonymous';
    return make(`guest:${name.toLowerCase()}`, name);
  }
  if (!isLoopback(request)) return null;
  const login = header(request, 'tailscale-user-login').toLowerCase();
  if (login) return make(login, header(request, 'tailscale-user-name') || login);
  if (header(request, 'x-forwarded-for')) return null;
  const admin = access.admin.trim().toLowerCase();
  return make(admin, admin);
}
