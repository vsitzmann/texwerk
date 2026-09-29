import { execFile } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { cleanPath, cleanProjectName } from '../shared/files.ts';
import { BRIDGE_HEADER, type Identity, type ProjectSettings } from '../shared/protocol.ts';
import { synctex } from './compile.ts';
import * as gitOps from './git.ts';
import { resolveIdentity, type AccessConfig } from './identity.ts';
import { Project, type Conn } from './project.ts';
import { readZip, writeZip } from './zip.ts';

/**
 * The TeXWerk server: one HTTP port serving the browser client, a JSON API,
 * raw project files, the compiled PDFs, the mirror bridge script, and a
 * WebSocket per open project for live collaboration.
 *
 * Every top-level folder of `rootDir` is a project (and a git repository).
 * Nothing outside `rootDir` is ever read or written.
 */

export interface ServerOptions {
  rootDir: string;
  clientDir: string | null;
  bridgeFile: string | null;
  port: number;
  host: string;
  access: AccessConfig | null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json', '.wasm': 'application/wasm',
};

const MAX_BODY = 200 * 1024 * 1024;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'upload too large')); request.destroy(); return; }
      chunks.push(c);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const body = await readBody(request);
  try { return JSON.parse(body.toString('utf8') || '{}') as T; } catch { throw new HttpError(400, 'bad JSON'); }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  return `${kind}; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function sendFile(request: IncomingMessage, response: ServerResponse, abs: string, opts: { download?: string; noStore?: boolean } = {}): Promise<void> {
  let info;
  try { info = await stat(abs); } catch { throw new HttpError(404, 'not found'); }
  if (!info.isFile()) throw new HttpError(404, 'not found');
  const etag = `"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`;
  const headers: Record<string, string> = {
    'content-type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': opts.noStore ? 'no-store' : 'no-cache',
    etag,
    'accept-ranges': 'bytes',
  };
  if (opts.download) headers['content-disposition'] = contentDisposition('attachment', opts.download);
  if (!opts.noStore && request.headers['if-none-match'] === etag) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) {
      response.writeHead(416, { 'content-range': `bytes */${info.size}` });
      response.end();
      return;
    }
    response.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${info.size}`, 'content-length': String(end - start + 1) });
    createReadStream(abs, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { ...headers, 'content-length': String(info.size) });
  createReadStream(abs).pipe(response);
}

const TEMPLATE = String.raw`\documentclass[11pt]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{hyperref}

\title{Untitled}
\author{}
\date{\today}

\begin{document}
\maketitle

\section{Introduction}
Start writing here.

\end{document}
`;

export async function startServer(options: ServerOptions) {
  const rootDir = resolve(options.rootDir);
  await mkdir(rootDir, { recursive: true });
  const projects = new Map<string, Promise<Project>>();

  function projectDir(name: string): string {
    const clean = cleanProjectName(name);
    if (!clean) throw new HttpError(400, 'invalid project name');
    return join(rootDir, clean);
  }

  async function getProject(name: string | null): Promise<Project> {
    if (!name) throw new HttpError(400, 'missing ?project=');
    const dir = projectDir(name);
    let pending = projects.get(name);
    if (!pending) {
      if (!existsSync(dir)) throw new HttpError(404, `no project "${name}"`);
      pending = (async () => {
        const p = new Project(name, dir);
        await p.open();
        p.onUnload = () => { if (projects.get(name) === pending) projects.delete(name); };
        return p;
      })();
      projects.set(name, pending);
      pending.catch(() => projects.delete(name));
    }
    return pending;
  }

  async function closeProject(name: string): Promise<void> {
    const pending = projects.get(name);
    if (!pending) return;
    projects.delete(name);
    await (await pending).close();
  }

  async function listProjects() {
    const out: Array<{ name: string; modified: number; open: boolean; people: string[] }> = [];
    for (const e of await readdir(rootDir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = join(rootDir, e.name);
      let modified = (await stat(dir)).mtimeMs;
      try { modified = Math.max(modified, (await stat(join(dir, '.texwerk', 'history', 'log.jsonl'))).mtimeMs); } catch { /* none */ }
      const pending = projects.get(e.name);
      let people: string[] = [];
      if (pending) {
        const p = await pending.catch(() => null);
        if (p) people = [...new Set([...p.conns].map((c) => (c.bridge ? `${c.identity.name} · agent` : c.identity.name)))];
      }
      out.push({ name: e.name, modified, open: Boolean(pending), people });
    }
    return out.sort((a, b) => b.modified - a.modified);
  }

  function identityOf(request: IncomingMessage, url: URL): Identity {
    const identity = resolveIdentity(request, options.access, url.searchParams.get('name') ?? request.headers['x-texwerk-name'] as string ?? null);
    if (!identity) throw new HttpError(403, 'unidentified connection — this server is reachable only through tailscale serve');
    return identity;
  }

  function sshKeyPath(): string {
    return join(homedir(), '.ssh', 'id_ed25519');
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    const method = request.method ?? 'GET';
    const identity = identityOf(request, url);
    const who = request.headers[BRIDGE_HEADER] === '1' ? `${identity.name} · agent` : identity.name;
    const projectParam = url.searchParams.get('project');

    // ------------------------------------------------------------ static
    if (path === '/texwerk-connect.mjs' && options.bridgeFile) {
      return sendFile(request, response, options.bridgeFile, { noStore: true });
    }
    if (!path.startsWith('/api/') && !path.startsWith('/raw/') && !path.startsWith('/pdf/')) {
      if (!options.clientDir) throw new HttpError(404, 'client not built — run npm run build');
      const rel = path === '/' ? 'index.html' : path.slice(1);
      const abs = resolve(options.clientDir, rel);
      if (!abs.startsWith(options.clientDir) || !existsSync(abs)) return sendFile(request, response, join(options.clientDir, 'index.html'));
      return sendFile(request, response, abs);
    }

    // ---------------------------------------------------------- raw files
    // /raw/<project>/<path>: current bytes of a project file.
    const raw = /^\/raw\/([^/]+)\/(.+)$/.exec(path);
    if (raw && method === 'GET') {
      const project = await getProject(raw[1]);
      const rel = cleanPath(raw[2]);
      if (!rel) throw new HttpError(400, 'bad path');
      const ytext = project.texts.get(rel);
      const download = url.searchParams.has('download') ? rel.split('/').pop() : undefined;
      if (ytext) {
        const headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
        if (download) headers['content-disposition'] = contentDisposition('attachment', download);
        response.writeHead(200, headers);
        response.end(ytext.toString());
        return;
      }
      // A symlink inside a project (a cloned repo can carry one) must not
      // reach files outside it.
      let real: string;
      try { real = await realpath(join(project.dir, rel)); } catch { throw new HttpError(404, 'not found'); }
      if (!real.startsWith(`${await realpath(project.dir)}/`)) throw new HttpError(403, 'outside the project');
      return sendFile(request, response, real, { download });
    }
    // /pdf/<project>/<name>.pdf: the latest compiled PDF.
    const pdf = /^\/pdf\/([^/]+)\/[^/]*$/.exec(path);
    if (pdf && method === 'GET') {
      const project = await getProject(pdf[1]);
      if (!project.lastPdf) throw new HttpError(404, 'not compiled yet');
      const download = url.searchParams.has('download') ? `${project.name}.pdf` : undefined;
      return sendFile(request, response, project.lastPdf, { download, noStore: true });
    }

    // ---------------------------------------------------------------- api
    if (path === '/api/me') return json(response, 200, { you: identity, access: Boolean(options.access), host: hostname() });

    if (path === '/api/projects' && method === 'GET') return json(response, 200, { projects: await listProjects() });

    if (path === '/api/projects' && method === 'POST') {
      const body = await readJson<{ name: string; blank?: boolean }>(request);
      const dir = projectDir(body.name);
      if (existsSync(dir)) throw new HttpError(409, 'a project with that name exists');
      await mkdir(dir);
      if (!body.blank) await writeFile(join(dir, 'main.tex'), TEMPLATE);
      await gitOps.ensureRepo(dir);
      return json(response, 200, { name: cleanProjectName(body.name) });
    }

    if (path === '/api/projects/import' && method === 'POST') {
      const dir = projectDir(url.searchParams.get('name') ?? '');
      if (existsSync(dir)) throw new HttpError(409, 'a project with that name exists');
      const entries = readZip(await readBody(request));
      // An archive of a single folder is unwrapped: import its contents.
      const names = entries.map((e) => e.name.replace(/\\/g, '/'));
      const tops = new Set(names.map((n) => n.split('/')[0]));
      const strip = tops.size === 1 && names.every((n) => n.includes('/')) ? `${[...tops][0]}/` : '';
      await mkdir(dir);
      for (const [i, e] of entries.entries()) {
        const rel = cleanPath(names[i].slice(strip.length));
        if (!rel || rel.startsWith('__MACOSX/')) continue;
        await mkdir(join(dir, rel, '..'), { recursive: true });
        await writeFile(join(dir, rel), e.data);
      }
      await gitOps.ensureRepo(dir);
      return json(response, 200, { name: cleanProjectName(url.searchParams.get('name') ?? '') });
    }

    if (path === '/api/projects/clone' && method === 'POST') {
      const body = await readJson<{ url: string; name: string }>(request);
      const dir = projectDir(body.name);
      if (existsSync(dir)) throw new HttpError(409, 'a project with that name exists');
      if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(body.url)) throw new HttpError(400, 'use an https:// or ssh git URL');
      const r = await gitOps.clone(rootDir, body.url, cleanProjectName(body.name)!);
      if (!r.ok) return json(response, 400, { error: r.output });
      return json(response, 200, { name: cleanProjectName(body.name), output: r.output });
    }

    if (path === '/api/projects/rename' && method === 'POST') {
      const body = await readJson<{ from: string; to: string }>(request);
      const from = projectDir(body.from);
      const to = projectDir(body.to);
      if (!existsSync(from)) throw new HttpError(404, 'no such project');
      if (existsSync(to)) throw new HttpError(409, 'a project with that name exists');
      const open = projects.get(body.from);
      if (open && (await open).conns.size) throw new HttpError(409, 'close the project everywhere before renaming it');
      await closeProject(body.from);
      await rename(from, to);
      return json(response, 200, { name: cleanProjectName(body.to) });
    }

    if (path === '/api/ssh-key') {
      const pub = `${sshKeyPath()}.pub`;
      if (method === 'POST' && !existsSync(pub)) {
        await mkdir(join(homedir(), '.ssh'), { recursive: true, mode: 0o700 });
        await new Promise<void>((done) => execFile('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', `texwerk@${hostname()}`, '-f', sshKeyPath()], () => done()));
      }
      return json(response, 200, { publicKey: existsSync(pub) ? (await readFile(pub, 'utf8')).trim() : null });
    }

    // Everything below is scoped to one project.
    const project = await getProject(projectParam);
    const bodyPath = (p: unknown) => {
      const clean = cleanPath(String(p ?? ''));
      if (!clean) throw new HttpError(400, 'bad path');
      return clean;
    };

    if (path === '/api/file' && method === 'PUT') {
      const rel = bodyPath(url.searchParams.get('path'));
      await project.putFile(rel, await readBody(request), who);
      return json(response, 200, { ok: true });
    }

    if (path === '/api/fs' && method === 'POST') {
      const body = await readJson<{ op: string; path: string; to?: string }>(request);
      const rel = bodyPath(body.path);
      if (body.op === 'mkdir') await project.mkdir(rel, who);
      else if (body.op === 'newfile') {
        if (project.exists(rel)) throw new HttpError(409, `"${rel}" already exists`);
        await project.putFile(rel, Buffer.alloc(0), who);
      } else if (body.op === 'delete') await project.remove(rel, who);
      else if (body.op === 'move') {
        try { await project.move(rel, bodyPath(body.to), who); } catch (err) { throw new HttpError(409, (err as Error).message); }
      } else throw new HttpError(400, 'unknown op');
      return json(response, 200, { ok: true });
    }

    if (path === '/api/compile' && method === 'POST') {
      const done = project.requestCompile(who);
      if (url.searchParams.get('wait') === '1') {
        await done;
        // A compile queued behind a running one: wait for that too.
        while (project.isCompiling()) await project.isCompiling();
        return json(response, 200, { compile: project.compile, output: project.lastOutput });
      }
      return json(response, 202, { compile: project.compile });
    }

    if (path === '/api/compile' && method === 'GET') {
      return json(response, 200, { compile: project.compile, output: project.lastOutput, log: project.lastLog });
    }

    if (path === '/api/settings' && method === 'POST') {
      const body = await readJson<Partial<ProjectSettings>>(request);
      if (body.mainFile !== undefined) {
        const main = bodyPath(body.mainFile);
        if (!project.texts.has(main)) throw new HttpError(400, 'main file must be a text file in the project');
        project.settings.mainFile = main;
      }
      if (body.engine && ['pdflatex', 'xelatex', 'lualatex'].includes(body.engine)) project.settings.engine = body.engine;
      if (typeof body.autoCompile === 'boolean') project.settings.autoCompile = body.autoCompile;
      await project.saveSettings();
      return json(response, 200, { settings: project.settings });
    }

    if (path === '/api/synctex/edit') {
      if (!project.lastPdf) return json(response, 200, { file: null });
      const page = Number(url.searchParams.get('page'));
      const x = Number(url.searchParams.get('x'));
      const y = Number(url.searchParams.get('y'));
      const out = await synctex(project.dir, ['edit', '-o', `${page}:${x}:${y}:${project.lastPdf}`]);
      const input = /^Input:(.*)$/m.exec(out)?.[1];
      const line = Number(/^Line:(\d+)/m.exec(out)?.[1] ?? 0);
      if (!input) return json(response, 200, { file: null });
      const rel = project.relative(resolve(project.dir, input));
      return json(response, 200, { file: rel.startsWith('..') ? null : rel.replace(/^\.\//, ''), line });
    }

    if (path === '/api/synctex/view') {
      if (!project.lastPdf) return json(response, 200, { page: null });
      const file = bodyPath(url.searchParams.get('file'));
      const line = Number(url.searchParams.get('line'));
      const out = await synctex(project.dir, ['view', '-i', `${line}:0:${join(project.dir, file)}`, '-o', project.lastPdf]);
      const page = Number(/^Page:(\d+)/m.exec(out)?.[1] ?? 0);
      const y = Number(/^y:([\d.]+)/m.exec(out)?.[1] ?? 0);
      const x = Number(/^x:([\d.]+)/m.exec(out)?.[1] ?? 0);
      return json(response, 200, page ? { page, x, y } : { page: null });
    }

    if (path === '/api/history' && method === 'GET') {
      await project.history.flush();
      return json(response, 200, { entries: project.history.all(), labels: await gitOps.labels(project.dir) });
    }

    if (path === '/api/history/blob' && method === 'GET') {
      const data = await project.history.readBlob(url.searchParams.get('hash') ?? '');
      if (!data) throw new HttpError(404, 'no such version');
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable' });
      response.end(data);
      return;
    }

    if (path === '/api/history/restore-file' && method === 'POST') {
      const body = await readJson<{ path: string; hash: string | null }>(request);
      await project.restoreFile(bodyPath(body.path), body.hash, `${who} (restore)`);
      return json(response, 200, { ok: true });
    }

    if (path === '/api/history/restore-project' && method === 'POST') {
      const body = await readJson<{ id: number }>(request);
      await project.history.flush(true);
      await project.restoreProject(Number(body.id), `${who} (restore)`);
      await project.history.flush(true);
      return json(response, 200, { ok: true });
    }

    if (path === '/api/label' && method === 'POST') {
      const body = await readJson<{ message: string }>(request);
      const message = String(body.message ?? '').trim().slice(0, 200);
      if (!message) throw new HttpError(400, 'a label needs a name');
      await project.persistAll();
      await project.history.flush(true);
      const r = await gitOps.commitAll(project.dir, message, identity.name, identity.login, project.history.lastId());
      project.broadcastEvent({ t: 'git' });
      project.broadcastEvent({ t: 'history' });
      return json(response, r.ok ? 200 : 500, r.ok ? { ok: true } : { error: r.output });
    }

    if (path === '/api/git/revert' && method === 'POST') {
      const body = await readJson<{ commit: string; message: string }>(request);
      await project.persistAll();
      await project.history.flush(true);
      const r = await gitOps.checkoutTree(project.dir, body.commit);
      if (!r.ok) return json(response, 500, { error: r.output });
      await project.reconcileAll(`${who} (revert)`);
      await project.history.flush(true);
      const c = await gitOps.commitAll(project.dir, `Revert to "${body.message}"`, identity.name, identity.login, project.history.lastId());
      project.broadcastEvent({ t: 'git' });
      return json(response, c.ok ? 200 : 500, c.ok ? { ok: true } : { error: c.output });
    }

    if (path === '/api/git' && method === 'GET') {
      return json(response, 200, { status: await gitOps.status(project.dir) });
    }

    if (path === '/api/git/remote' && method === 'POST') {
      const body = await readJson<{ url: string }>(request);
      const remote = String(body.url ?? '').trim();
      if (remote && !/^(https?:\/\/|git@|ssh:\/\/)/.test(remote)) throw new HttpError(400, 'use an https:// or ssh git URL');
      const r = await gitOps.setRemote(project.dir, remote);
      project.broadcastEvent({ t: 'git' });
      return json(response, r.ok ? 200 : 400, r.ok ? { ok: true } : { error: r.output });
    }

    if (path === '/api/git/push' && method === 'POST') {
      const r = await gitOps.push(project.dir);
      project.broadcastEvent({ t: 'git' });
      return json(response, r.ok ? 200 : 400, r.ok ? { output: r.output } : { error: r.output });
    }

    if (path === '/api/git/pull' && method === 'POST') {
      await project.persistAll();
      await project.history.flush(true);
      const r = await gitOps.pull(project.dir, identity.name, identity.login);
      await project.reconcileAll(`${who} (git pull)`);
      project.broadcastEvent({ t: 'git' });
      return json(response, r.ok ? 200 : 400, r.ok ? { output: r.output } : { error: r.output });
    }

    if (path === '/api/zip' && method === 'GET') {
      await project.persistAll();
      response.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': contentDisposition('attachment', `${project.name}.zip`),
        'cache-control': 'no-store',
      });
      await writeZip(response, project.allFiles().map((rel) => ({
        name: `${project.name}/${rel}`,
        load: async () => {
          const t = project.texts.get(rel);
          return t ? Buffer.from(t.toString(), 'utf8') : readFile(join(project.dir, rel));
        },
      })));
      response.end();
      return;
    }

    throw new HttpError(404, 'not found');
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!response.headersSent) json(response, status, { error: (err as Error).message });
      else response.end();
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    let identity: Identity;
    try { identity = identityOf(request, url); } catch {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const name = url.searchParams.get('project');
      // The client speaks first (sync step 1) the moment the socket opens,
      // possibly before the project has finished loading: queue until ready.
      const early: Uint8Array[] = [];
      let deliver: ((data: Uint8Array) => void) | null = null;
      ws.on('message', (data, isBinary) => {
        if (!isBinary) return;
        const bytes = new Uint8Array(data as Buffer);
        if (deliver) deliver(bytes); else early.push(bytes);
      });
      getProject(name).then((project) => {
        if (ws.readyState !== ws.OPEN) return;
        const conn: Conn = { ws, identity, bridge: url.searchParams.get('bridge') === '1', awarenessIds: new Set() };
        deliver = (bytes) => {
          try {
            project.handleMessage(conn, bytes);
          } catch (err) {
            console.error(`[${project.name}] bad message from ${identity.name}:`, err);
          }
        };
        ws.on('close', () => project.removeConn(conn));
        project.addConn(conn);
        for (const bytes of early.splice(0)) deliver(bytes);
      }, (err: unknown) => {
        ws.close(err instanceof HttpError && err.status === 404 ? 4404 : 1011, (err as Error).message.slice(0, 120));
      });
    });
  });

  await new Promise<void>((done) => server.listen(options.port, options.host, done));

  const urls: string[] = [];
  const hosts = options.host === '0.0.0.0' || options.host === '::'
    ? Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4').map((i) => i!.address)
    : [options.host];
  for (const h of hosts) urls.push(`http://${h}:${options.port}/`);

  return {
    urls,
    async close() {
      server.close();
      for (const ws of wss.clients) ws.terminate();
      await Promise.all([...projects.values()].map(async (p) => (await p.catch(() => null))?.close()));
    },
  };
}

