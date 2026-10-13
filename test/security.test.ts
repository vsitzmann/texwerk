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
    await writeFile(join(paper, 'peek.tex'), '\\documentclass{article}\\begin{document}\\input{../Other/secret}\\end{document}\n');
    const settings = { mainFile: 'main.tex', engine: 'pdflatex' as const, autoCompile: false };
    const sandboxed = setupCompileSandbox(root);
    const run = await runLatexmk(paper, settings);
    assert.ok(run.ok && run.pdf, run.output);
    assert.ok(!existsSync(marker), 'a latexmkrc in the project never runs');
    if (!sandboxed) { t.skip('bubblewrap cannot create a sandbox here'); return; }
    const peek = await runLatexmk(paper, { ...settings, mainFile: 'peek.tex' });
    assert.ok(!peek.output.includes('SECRETTEXT') && !(peek.pdf && existsSync(peek.pdf)), 'another project is out of reach');
    assert.match(peek.issues.map((i) => i.message).join('\n'), /secret\.tex' not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
