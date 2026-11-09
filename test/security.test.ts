/**
 * What a collaborator, a cloned repository or another website must not be
 * able to do to the server: write or read outside a project, run code, or
 * act as someone who has TeXWerk open in their browser.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { request, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import { WebSocket } from 'ws';
import { MSG_SYNC } from '../src/shared/protocol.ts';
import { refusal } from '../src/server/origin.ts';
import { unsafeKeys } from '../src/server/project.ts';
import { startServer } from '../src/server/server.ts';

const hasTex = (() => { try { execFileSync('latexmk', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function fakeRequest(headers: Record<string, string>, remote = '100.64.0.7'): IncomingMessage {
  return { headers, socket: { remoteAddress: remote } } as unknown as IncomingMessage;
}

test('updates that name files outside the project are recognised', () => {
  const doc = new Y.Doc();
  doc.getMap('text').set('main.tex', new Y.Text('hi'));
  const before = Y.encodeStateVector(doc);
  assert.deepEqual(unsafeKeys(Y.encodeStateAsUpdate(doc)), []);
  doc.getMap('text').set('main.tex', new Y.Text('replaced'));
  doc.getMap('text').set('sections/intro.tex', new Y.Text('ok'));
  doc.getMap('comments').set('../not-a-path', new Y.Map());
  assert.deepEqual(unsafeKeys(Y.encodeStateAsUpdate(doc, before)), [], 'clean paths, overwrites and other maps pass');
  for (const [map, key] of [['text', '../Other/main.tex'], ['bin', '.texwerk/access.json'], ['dirs', '.git'], ['text', '/etc/x'], ['text', 'a//b']]) {
    const evil = new Y.Doc();
    evil.getMap(map).set(key, map === 'text' ? new Y.Text('x') : true);
    assert.deepEqual(unsafeKeys(Y.encodeStateAsUpdate(evil)), [key], `${map}: ${key}`);
  }
});

test('requests from other websites and unknown host names are refused', () => {
  const ok = (h: Record<string, string>, remote?: string) => refusal(fakeRequest(h, remote), ['texwerk.example.org']) === null;
  assert.ok(ok({ host: '100.64.0.1:5810' }), 'an IP address, no Origin (bridge, curl)');
  assert.ok(ok({ host: 'lab-server:5810', origin: 'http://lab-server:5810' }), 'its own page');
  assert.ok(ok({ host: 'lab-server.tail1234.ts.net' }));
  assert.ok(ok({ host: 'texwerk.example.org', origin: 'https://texwerk.example.org' }), '--allow-host');
  assert.ok(!ok({ host: 'lab-server:5810', origin: 'https://evil.example' }), 'cross-site request');
  assert.ok(!ok({ host: 'lab-server:5810', origin: 'null' }), 'sandboxed frame');
  assert.ok(!ok({ host: 'rebound.evil.example:5810' }), 'DNS rebinding');
  // tailscale serve: the browser's host arrives as X-Forwarded-Host, trusted from loopback only.
  const proxied = { host: '127.0.0.1:5810', origin: 'https://lab.tail1234.ts.net:10000', 'x-forwarded-host': 'lab.tail1234.ts.net:10000' };
  assert.ok(ok(proxied, '127.0.0.1'));
  assert.ok(!ok(proxied, '100.64.0.7'));
});

async function server(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'texwerk-security-'));
  const projects = join(root, 'projects');
  await mkdir(join(projects, 'Paper'), { recursive: true });
  await mkdir(join(projects, 'Other'), { recursive: true });
  await writeFile(join(projects, 'Paper', 'main.tex'), '\\documentclass{article}\\begin{document}Hi\\end{document}\n');
  await writeFile(join(projects, 'Other', 'secret.tex'), 'SECRETTEXT\n');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const s = await startServer({ rootDir: projects, clientDir: null, bridgeFile: null, port, host: '127.0.0.1', access: null });
  t.after(async () => { await s.close(); await rm(root, { recursive: true, force: true }); });
  return { root, projects, origin: `http://127.0.0.1:${port}` };
}

test('with --access, everything is private by default', async (t) => {
  // Projects written straight to disk (the way an agent drafts a reference
  // letter) carry no access file. Nobody but the admin may see them, nor ones
  // whose access file is broken or does not say "public".
  const root = await mkdtemp(join(tmpdir(), 'texwerk-private-'));
  const projects = join(root, 'projects');
  const project = async (id: string, sidecar?: string) => {
    await mkdir(join(projects, id, '.texwerk'), { recursive: true });
    await writeFile(join(projects, id, 'main.tex'), `SECRET ${id}\n`);
    if (sidecar !== undefined) await writeFile(join(projects, id, '.texwerk', 'access.json'), sidecar);
  };
  await mkdir(join(projects, 'Reference letters', 'Visa'), { recursive: true });
  await writeFile(join(projects, 'Reference letters', '.texwerk-folder.json'), '{"owner":"admin@example.com"}');
  await writeFile(join(projects, 'Reference letters', 'Visa', '.texwerk-folder.json'), '{"owner":"admin@example.com"}');
  await project('Reference letters/Visa/O-1 letter');
  await project('Draft');
  await project('Broken', '{"owner": "admin@exam');
  await project('No visibility', '{"owner":"admin@example.com","sharedWith":[]}');
  await project('Shared', '{"owner":"admin@example.com","visibility":"private","sharedWith":[{"login":"ann@example.com","role":"view"}]}');
  await project('Open', '{"owner":"admin@example.com","visibility":"public"}');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const s = await startServer({ rootDir: projects, clientDir: null, bridgeFile: null, port, host: '127.0.0.1', access: { admin: 'admin@example.com' } });
  t.after(async () => { await s.close(); await rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  // On loopback the server trusts tailscale serve's identity header; none means the admin.
  const as = (login: string | null) => (login ? { 'tailscale-user-login': login } : {}) as Record<string, string>;
  const catalog = async (login: string | null) => {
    const res = await fetch(`${origin}/api/projects`, { headers: as(login) });
    assert.equal(res.status, 200);
    const body = await res.json() as { projects: Array<{ id: string }>; folders: Array<{ path: string }> };
    return { projects: body.projects.map((p) => p.id).sort(), folders: body.folders.map((f) => f.path).sort() };
  };

  const hidden = ['Reference letters/Visa/O-1 letter', 'Draft', 'Broken', 'No visibility', 'Shared'];
  assert.deepEqual(await catalog('mallory@example.com'), { projects: ['Open'], folders: [] }, 'a stranger sees only the public project');
  assert.deepEqual(await catalog('ann@example.com'), { projects: ['Open', 'Shared'], folders: [] }, 'ann sees what was shared with her');
  assert.deepEqual((await catalog(null)).projects, [...hidden, 'Open'].sort(), 'the admin sees everything');
  // The browser's "Public only" switch lists exactly what the catalog marks public.
  const marked = (await (await fetch(`${origin}/api/projects`)).json() as { projects: Array<{ id: string; visibility: string }> }).projects;
  assert.deepEqual(marked.filter((p) => p.visibility === 'public').map((p) => p.id), ['Open']);

  // A project is the same id whether a stranger lists it or guesses it.
  const create = await fetch(`${origin}/api/projects`, { method: 'POST', headers: as('ann@example.com'), body: JSON.stringify({ name: 'Anns paper' }) });
  assert.equal(create.status, 200);
  for (const id of [...hidden, 'Anns paper']) {
    const q = encodeURIComponent(id);
    for (const url of [`/raw/${q}/main.tex`, `/pdf/${q}/main.pdf`, `/api/zip?project=${q}`, `/api/history?project=${q}`,
      `/api/comments?project=${q}`, `/api/chat?project=${q}`, `/api/access?project=${q}`, `/api/git?project=${q}`]) {
      const res = await fetch(`${origin}${url}`, { headers: as('mallory@example.com') });
      const text = await res.text();
      if (id === 'Shared' && url.startsWith('/raw/')) {
        assert.equal((await fetch(`${origin}${url}`, { headers: as('ann@example.com') })).status, 200, 'ann can read what was shared with her');
      }
      assert.equal(res.status, 403, `${url} as a stranger`);
      assert.doesNotMatch(text, /SECRET/);
    }
    const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws?project=${q}`, { headers: as('mallory@example.com') });
    const received: string[] = [];
    ws.on('message', (data) => received.push(Buffer.from(data as ArrayBuffer).toString('latin1')));
    const code = await new Promise<number>((done) => { ws.once('close', (c) => done(c)); ws.once('error', () => done(-1)); });
    assert.equal(code, 4403, `${id} over the socket`);
    assert.ok(!received.some((m) => m.includes('SECRET')), `${id} leaked over the socket`);
  }
  assert.equal((await fetch(`${origin}/raw/Open/main.tex`, { headers: as('mallory@example.com') })).status, 200, 'a public project stays open');
  assert.equal((await fetch(`${origin}/raw/${encodeURIComponent('Reference letters/Visa/O-1 letter')}/main.tex`)).status, 200, 'the admin can read the letter');
});

test('a collaborator cannot write outside the project through the document', async (t) => {
  const { root, projects, origin } = await server(t);
  const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws?project=Paper&name=Mallory`);
  ws.binaryType = 'arraybuffer';
  await new Promise((done, fail) => { ws.once('open', done); ws.once('error', fail); });
  const evil = new Y.Doc();
  evil.getMap('text').set('../Other/main.tex', new Y.Text('overwritten'));
  evil.getMap('text').set('../../escaped.tex', new Y.Text('escaped'));
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(evil));
  ws.send(encoding.toUint8Array(enc));
  const code = await new Promise<number>((done) => ws.once('close', (c) => done(c)));
  assert.equal(code, 4400);
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!existsSync(join(projects, 'Other', 'main.tex')));
  assert.ok(!existsSync(join(root, 'escaped.tex')));
});

test('cross-site requests and foreign host names are refused; same-site and bridge requests work', async (t) => {
  const { origin } = await server(t);
  const post = (headers: Record<string, string>) => fetch(`${origin}/api/projects?name=Ann`, { method: 'POST', headers, body: JSON.stringify({ name: `p${Math.random().toString(36).slice(2, 8)}` }) });
  assert.equal((await post({ origin: 'https://evil.example', 'content-type': 'text/plain' })).status, 403);
  assert.equal((await post({ origin })).status, 200);
  assert.equal((await post({})).status, 200);
  // fetch() will not send another Host; a rebound name is what a browser would send.
  const rebound = await new Promise<number>((done, fail) => {
    request(`${origin}/api/projects`, { headers: { host: 'rebound.evil.example' } }, (r) => { r.resume(); done(r.statusCode!); }).on('error', fail).end();
  });
  assert.equal(rebound, 403);
  const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws?project=Paper&name=Ann`, { origin: 'https://evil.example' });
  const outcome = await new Promise<string>((done) => { ws.once('open', () => done('open')); ws.once('error', () => done('refused')); });
  assert.equal(outcome, 'refused');
});

test('files from a project are served so that they cannot run as TeXWerk', async (t) => {
  const { projects, origin } = await server(t);
  await writeFile(join(projects, 'Paper', 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  await writeFile(join(projects, 'Paper', 'page.html'), Buffer.concat([Buffer.from('<script>alert(1)</script>'), Buffer.from([0xff, 0xfe, 0])]));
  const svg = await fetch(`${origin}/raw/Paper/x.svg?name=Ann`);
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get('content-security-policy') ?? '', /^sandbox/);
  assert.equal(svg.headers.get('x-content-type-options'), 'nosniff');
  const html = await fetch(`${origin}/raw/Paper/page.html?name=Ann`);
  assert.match(html.headers.get('content-type') ?? '', /^text\/plain/);
});

test('git: no symbolic links, and nothing pulled over .texwerk/', async () => {
  const { clone, ensureRepo, git, pull } = await import('../src/server/git.ts');
  const base = await mkdtemp(join(tmpdir(), 'texwerk-git-'));
  try {
    const remote = join(base, 'remote.git');
    const seed = join(base, 'seed');
    await git(base, ['init', '-q', '--bare', '-b', 'main', remote]);
    await git(base, ['init', '-q', '-b', 'main', seed]);
    await writeFile(join(seed, 'paper.tex'), 'paper');
    await symlink('../../other-project', join(seed, 'figures'));
    await git(seed, ['add', '-A']);
    await git(seed, ['-c', 'user.name=x', '-c', 'user.email=x@y', 'commit', '-qm', 'seed']);
    await git(seed, ['push', '-q', remote, 'main']);
    const project = join(base, 'project');
    await mkdir(project);
    await ensureRepo(project);
    await git(project, ['remote', 'add', 'origin', remote]);
    const pulled = await pull(project, 'Ann', 'ann@test');
    assert.ok(pulled.ok, pulled.output);
    assert.ok((await lstat(join(project, 'figures'))).isFile(), 'the link is a plain file');

    // A remote that carries the server's own state.
    await mkdir(join(seed, '.texwerk'));
    await writeFile(join(seed, '.texwerk', 'access.json'), '{"owner":"mallory@example.com"}');
    await git(seed, ['add', '-f', '.texwerk/access.json']);
    await git(seed, ['-c', 'user.name=x', '-c', 'user.email=x@y', 'commit', '-qm', 'take over']);
    await git(seed, ['push', '-q', remote, 'main']);
    await mkdir(join(project, '.texwerk'), { recursive: true });
    await writeFile(join(project, '.texwerk', 'access.json'), '{"owner":"ann@example.com"}');
    const refused = await pull(project, 'Ann', 'ann@test');
    assert.ok(!refused.ok);
    assert.match(refused.output, /\.texwerk\/access\.json/);
    assert.match(await readFile(join(project, '.texwerk', 'access.json'), 'utf8'), /ann@example/);
    const cloned = await clone(base, remote, 'cloned');
    assert.ok(!cloned.ok);
    assert.ok(!existsSync(join(base, 'cloned')), 'the refused clone is removed');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('compiles run no code from the project and read no other project', { skip: !hasTex && 'latexmk is not installed' }, async (t) => {
  const { runLatexmk, setupCompileSandbox } = await import('../src/server/compile.ts');
  const root = await mkdtemp(join(tmpdir(), 'texwerk-compile-'));
  try {
    const paper = join(root, 'Paper');
    await mkdir(join(root, 'Other'), { recursive: true });
    await mkdir(paper);
    await writeFile(join(root, 'Other', 'secret.tex'), 'SECRETTEXT');
    const marker = join(root, 'ran');
    for (const rc of ['latexmkrc', '.latexmkrc']) await writeFile(join(paper, rc), `system("touch ${marker}");\n`);
    await writeFile(join(paper, 'main.tex'), '\\documentclass{article}\\begin{document}Hello\\end{document}\n');
    const settings = { mainFile: 'main.tex', engine: 'pdflatex' as const, autoCompile: false };
    const unsandboxed = setupCompileSandbox(root);
    const run = await runLatexmk(paper, settings);
    assert.ok(run.ok && run.pdf, run.output);
    assert.ok(!existsSync(marker), 'a latexmkrc in the project never runs');
    if (unsandboxed) { t.skip(`no sandbox here: ${unsandboxed}`); return; }
    // Directly, and through the server's own root in /proc.
    for (const path of ['../Other/secret', `/proc/${process.pid}/root${root}/Other/secret`]) {
      await writeFile(join(paper, 'peek.tex'), `\\documentclass{article}\\begin{document}\\input{${path}}\\end{document}\n`);
      const peek = await runLatexmk(paper, { ...settings, mainFile: 'peek.tex' });
      assert.ok(!peek.output.includes('SECRETTEXT') && !(peek.pdf && existsSync(peek.pdf)), `${path} is out of reach`);
      assert.match(peek.issues.map((i) => i.message).join('\n'), /secret\.tex' not found/, path);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
