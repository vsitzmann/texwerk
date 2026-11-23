/**
 * The tailnet HTTPS listener (--tls-*): the server terminates TLS itself on
 * the tailnet address instead of behind `tailscale serve`, and with --access
 * each connection is whoever tailscaled's `whois` names for the peer. A
 * stand-in tailscaled answers on a Unix socket, as the real one does.
 *
 * What must hold: identity there comes from whois and nothing else (identity
 * headers the peer sends are ignored, even ones naming the admin), a peer
 * tailscaled does not know and a tagged device get nothing, the WebSocket
 * works over the same listener, and the loopback listener is unchanged.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { startServer } from '../src/server/server.ts';
import { userFromWhoIs } from '../src/server/tailscaleIdentity.ts';

const ADMIN = 'admin@example.com';

test('whois names the user; tagged devices and unknown peers are nobody', () => {
  assert.deepEqual(userFromWhoIs({ UserProfile: { LoginName: 'Ann@Example.com', DisplayName: 'Ann' } }), { login: 'ann@example.com', name: 'Ann' });
  assert.deepEqual(userFromWhoIs({ UserProfile: { LoginName: 'ann@example.com' } }), { login: 'ann@example.com', name: 'ann@example.com' });
  assert.deepEqual(userFromWhoIs({ UserProfile: { LoginName: 'ann@example.com', DisplayName: 'Ann\n[admin]\u202e' } }), { login: 'ann@example.com', name: 'Ann [admin]' });
  assert.equal(userFromWhoIs({ Node: { Tags: ['tag:server'] }, UserProfile: { LoginName: 'tagged-devices' } }), null);
  assert.equal(userFromWhoIs({ UserProfile: { LoginName: 'tagged-devices' } }), null);
  assert.equal(userFromWhoIs({}), null);
});

test('over the tailnet listener, identity is tailscaled’s whois and nothing else', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'texwerk-tls-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projects = join(root, 'projects');
  for (const [id, access] of [['Open', 'public'], ['Draft', null]] as const) {
    await mkdir(join(projects, id, '.texwerk'), { recursive: true });
    await writeFile(join(projects, id, 'main.tex'), `SECRET ${id}\n`);
    if (access) await writeFile(join(projects, id, '.texwerk', 'access.json'), JSON.stringify({ owner: ADMIN, visibility: access }));
  }

  // A certificate for the listener's address, as `tailscale cert` issues one for the machine's name.
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem'),
  ], { stdio: 'ignore' });
  const ca = await readFile(join(root, 'cert.pem'));

  // Who the stand-in tailscaled says the next peer is: a login, a tagged device, or unknown (null).
  let peer: string | 'tagged' | null = 'ann@example.com';
  const queries: string[] = [];
  const tailscaled = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://local-tailscaled.sock');
    if (url.pathname !== '/localapi/v0/whois' || request.headers.host !== 'local-tailscaled.sock') { response.writeHead(403).end(); return; }
    queries.push(url.searchParams.get('addr') ?? '');
    if (peer === null) { response.writeHead(404).end('no match for IP:port'); return; }
    const tagged = peer === 'tagged';
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      Node: { Name: 'laptop.example.ts.net.', Tags: tagged ? ['tag:ci'] : null },
      UserProfile: { LoginName: tagged ? 'tagged-devices' : peer, DisplayName: tagged ? 'Tagged Devices' : peer.split('@')[0] },
    }));
  });
  const socketPath = join(root, 'tailscaled.sock');
  await new Promise<void>((done) => tailscaled.listen(socketPath, done));
  t.after(() => tailscaled.close());

  const port = 20000 + Math.floor(Math.random() * 20000);
  const s = await startServer({
    rootDir: projects, clientDir: null, bridgeFile: null, port, host: '127.0.0.1', access: { admin: ADMIN },
    tls: { host: '127.0.0.1', port: 0, certFile: join(root, 'cert.pem'), keyFile: join(root, 'key.pem'), tailscaleSocket: socketPath },
  });
  t.after(() => s.close());
  assert.ok(s.tlsPort, 'the HTTPS listener is up');
  assert.ok(s.urls.includes(`https://127.0.0.1:${s.tlsPort}/`));

  // Each call is a fresh connection (agent: false), so a fresh whois; the certificate is verified.
  const tlsGet = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; text: string }>((done, fail) => {
    const req = httpsRequest({ host: '127.0.0.1', port: s.tlsPort, path, headers, ca, agent: false }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => done({ status: response.statusCode ?? 0, text }));
    });
    req.on('error', fail);
    req.end();
  });
  const catalog = async (headers: Record<string, string> = {}) => {
    const res = await tlsGet('/api/projects', headers);
    return res.status === 200 ? (JSON.parse(res.text) as { projects: Array<{ id: string }> }).projects.map((p) => p.id).sort() : res.status;
  };

  assert.deepEqual(await catalog(), ['Open'], 'ann sees only the public project');
  assert.match(queries.at(-1) ?? '', /^127\.0\.0\.1:\d+$/, 'whois was asked about the connection’s own peer address');
  assert.deepEqual(await catalog({ 'tailscale-user-login': ADMIN }), ['Open'], 'a header naming the admin changes nothing over TLS');
  assert.equal((await tlsGet('/raw/Draft/main.tex', { 'tailscale-user-login': ADMIN })).status, 403);
  peer = ADMIN;
  assert.deepEqual(await catalog(), ['Draft', 'Open'], 'the admin, named by whois, sees everything');
  peer = null;
  assert.equal(await catalog(), 403, 'a peer tailscaled does not know gets nothing');
  peer = 'tagged';
  assert.equal(await catalog(), 403, 'a tagged device gets nothing');

  // The live document travels over the same listener.
  peer = 'ann@example.com';
  const opened = await new Promise<string>((done) => {
    const ws = new WebSocket(`wss://127.0.0.1:${s.tlsPort}/ws?project=Open`, { ca });
    ws.once('message', () => { ws.close(); done('message'); });
    ws.once('close', (code) => done(`closed ${code}`));
    ws.once('error', (err) => done(`error ${err.message}`));
  });
  assert.equal(opened, 'message');
  peer = null;
  const refused = await new Promise<string>((done) => {
    const ws = new WebSocket(`wss://127.0.0.1:${s.tlsPort}/ws?project=Open`, { ca });
    ws.once('open', () => { ws.close(); done('open'); });
    ws.once('error', (err) => done(err.message));
  });
  assert.match(refused, /403/);

  // Loopback is as before: no header is the machine itself, the admin.
  const loopback = await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json() as { projects: Array<{ id: string }> };
  assert.deepEqual(loopback.projects.map((p) => p.id).sort(), ['Draft', 'Open']);
});
