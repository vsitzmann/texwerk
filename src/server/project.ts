import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { watchTree } from '../shared/watchTree.ts';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { isTextFile, RESERVED_DIRS } from '../shared/files.ts';
import {
  MSG_AWARENESS, MSG_SYNC,
  type BinInfo, type CompileSummary, type Identity, type ProjectSettings, type ServerEvent,
} from '../shared/protocol.ts';
import { setYText } from '../shared/textDiff.ts';
import { BUILD_DIR, runLatexmk } from './compile.ts';
import { ensureRepo } from './git.ts';
import { hashBytes, History } from './history.ts';

/**
 * One open project: the authoritative Y.Doc, its connections, and the
 * two-way bridge between that document and ordinary files on disk.
 *
 * Files on disk stay the source of truth between sessions — latexmk, git
 * and a person with a shell all see plain files. While the project is open,
 * text files live in the Y.Doc and every change is written back within a
 * fraction of a second. Changes made on disk by anything else (git pull, an
 * editor on the server) are noticed by a recursive watcher and folded into
 * the document as minimal edits, so they reach everyone live.
 */

const PERSIST_DEBOUNCE_MS = 120;
const WATCH_DEBOUNCE_MS = 150;
const AUTO_COMPILE_DELAY_MS = 1500;
const UNLOAD_AFTER_MS = 10 * 60_000;

export interface Conn {
  ws: WebSocket;
  identity: Identity;
  bridge: boolean;
  awarenessIds: Set<number>;
}

/** Transaction origin for changes the server makes itself. */
export interface ServerOrigin {
  author: string;
}

function authorOf(origin: unknown): string | null {
  if (!origin || typeof origin !== 'object') return null;
  const o = origin as Partial<Conn> & Partial<ServerOrigin>;
  if (o.identity) return o.bridge ? `${o.identity.name} · agent` : o.identity.name;
  if (typeof o.author === 'string') return o.author;
  return null;
}

export class Project {
  readonly name: string;
  readonly dir: string;
  readonly doc = new Y.Doc();
  /** Changes whenever the document is loaded afresh (see ServerEvent hello). */
  readonly epoch = randomUUID();
  readonly texts: Y.Map<Y.Text>;
  readonly bins: Y.Map<BinInfo>;
  readonly dirs: Y.Map<boolean>;
  readonly awareness: awarenessProtocol.Awareness;
  readonly history: History;
  readonly conns = new Set<Conn>();
  settings: ProjectSettings = { mainFile: 'main.tex', engine: 'pdflatex', autoCompile: true };
  compile: CompileSummary = {
    rev: 0, state: 'idle', ok: false, hasPdf: false, startedAt: 0, finishedAt: 0, by: '', mainFile: '', issues: [],
  };
  lastPdf: string | null = null;
  lastOutput = '';
  lastLog = '';
  onUnload: (() => void) | null = null;

  private readonly pathOfText = new Map<Y.Text, string>();
  /** Hash of what is on disk for each file as far as we know (ours or observed). */
  private readonly diskHash = new Map<string, string>();
  private readonly persistTimers = new Map<string, NodeJS.Timeout>();
  private readonly watchTimers = new Map<string, NodeJS.Timeout>();
  private stopWatching: (() => void) | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private unloadTimer: NodeJS.Timeout | null = null;
  private autoCompileTimer: NodeJS.Timeout | null = null;
  private compileQueued: string | null = null;
  private compiling: Promise<void> | null = null;

  constructor(name: string, dir: string) {
    this.name = name;
    this.dir = dir;
    this.texts = this.doc.getMap('text');
    this.bins = this.doc.getMap('bin');
    this.dirs = this.doc.getMap('dirs');
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null);
    this.history = new History(dir, (path) => this.currentContent(path));
    this.history.onAppend = () => this.broadcastEvent({ t: 'history' });
  }

  // ---------------------------------------------------------------- loading

  async open(): Promise<void> {
    await ensureRepo(this.dir);
    await mkdir(join(this.dir, BUILD_DIR), { recursive: true });
    await this.history.load();
    await this.loadSettings();
    const origin: ServerOrigin = { author: 'disk' };
    const files = await this.scan();
    this.doc.transact(() => {
      for (const d of files.dirs) this.dirs.set(d, true);
      for (const f of files.files) {
        if (f.text !== null) {
          const ytext = new Y.Text(f.text);
          this.texts.set(f.path, ytext);
        } else {
          this.bins.set(f.path, { hash: f.hash, size: f.size });
        }
        this.diskHash.set(f.path, f.hash);
      }
    }, origin);
    this.reindexTexts();
    // Files that predate the history log (new project, copied in, cloned)
    // get a baseline entry so the first real edit has something to diff against.
    for (const f of files.files) {
      if (this.history.knownHash(f.path) !== f.hash) await this.history.snapshot(f.path, ['(on disk)'], 'edit');
    }
    if (this.settings.mainFile && !this.texts.has(this.settings.mainFile)) {
      this.settings.mainFile = this.guessMainFile();
      await this.saveSettings();
    }
    await this.restoreLastCompile();

    this.doc.on('update', (update: Uint8Array, origin: unknown) => this.broadcastUpdate(update, origin));
    this.doc.on('afterTransaction', (tr: Y.Transaction) => this.afterTransaction(tr));
    this.awareness.on('update', (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) =>
      this.onAwareness(changes, origin));
    this.startWatcher();
    this.flushTimer = setInterval(() => { void this.history.flush(); }, 5000);
    this.scheduleUnload();
  }

  private async scan(): Promise<{ dirs: string[]; files: Array<{ path: string; text: string | null; hash: string; size: number }> }> {
    const dirs: string[] = [];
    const files: Array<{ path: string; text: string | null; hash: string; size: number }> = [];
    const walk = async (abs: string, rel: string) => {
      let entries;
      try { entries = await readdir(abs, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (!rel && RESERVED_DIRS.has(e.name)) continue;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          dirs.push(childRel);
          await walk(join(abs, e.name), childRel);
        } else if (e.isFile()) {
          const data = await readFile(join(abs, e.name));
          const text = isTextFile(childRel, data) ? data.toString('utf8') : null;
          files.push({ path: childRel, text, hash: hashBytes(data), size: data.length });
        }
      }
    };
    await walk(this.dir, '');
    return { dirs, files };
  }

  private reindexTexts(): void {
    this.pathOfText.clear();
    for (const [path, ytext] of this.texts) this.pathOfText.set(ytext, path);
  }

  guessMainFile(): string {
    const candidates = [...this.texts.keys()].filter((p) => p.endsWith('.tex'));
    const withClass = candidates.filter((p) => /\\documentclass/.test(this.texts.get(p)!.toString()));
    const pick = (list: string[]) => list.find((p) => p === 'main.tex')
      ?? list.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0];
    return pick(withClass) ?? pick(candidates) ?? '';
  }

  private async loadSettings(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(join(this.dir, '.texwerk', 'settings.json'), 'utf8'));
      this.settings = { ...this.settings, ...raw };
    } catch {
      this.settings.mainFile = '';
    }
  }

  async saveSettings(): Promise<void> {
    await writeFile(join(this.dir, '.texwerk', 'settings.json'), JSON.stringify(this.settings, null, 2));
    this.broadcastEvent({ t: 'settings', settings: this.settings });
  }

  private async restoreLastCompile(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(join(this.dir, BUILD_DIR, 'texwerk-compile.json'), 'utf8')) as CompileSummary & { pdf: string | null };
      this.lastPdf = saved.pdf && existsSync(saved.pdf) ? saved.pdf : null;
      this.compile = { ...saved, state: 'done', hasPdf: Boolean(this.lastPdf) };
      this.lastOutput = await readFile(join(this.dir, BUILD_DIR, 'texwerk-output.txt'), 'utf8').catch(() => '');
      const stem = saved.mainFile.split('/').pop()!.replace(/\.[^.]+$/, '');
      this.lastLog = await readFile(join(this.dir, BUILD_DIR, `${stem}.log`), 'latin1').catch(() => '');
    } catch {
      /* never compiled */
    }
  }

  // ------------------------------------------------------------ connections

  addConn(conn: Conn): void {
    this.conns.add(conn);
    if (this.unloadTimer) { clearTimeout(this.unloadTimer); this.unloadTimer = null; }
    this.sendEvent(conn, {
      t: 'hello', epoch: this.epoch, you: conn.identity, project: this.name, readOnly: false, compile: this.compile, settings: this.settings,
    });
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    conn.ws.send(encoding.toUint8Array(enc));
    const states = [...this.awareness.getStates().keys()];
    if (states.length) {
      const aw = encoding.createEncoder();
      encoding.writeVarUint(aw, MSG_AWARENESS);
      encoding.writeVarUint8Array(aw, awarenessProtocol.encodeAwarenessUpdate(this.awareness, states));
      conn.ws.send(encoding.toUint8Array(aw));
    }
  }

  removeConn(conn: Conn): void {
    this.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(this.awareness, [...conn.awarenessIds], null);
    if (this.conns.size === 0) this.scheduleUnload();
  }

  handleMessage(conn: Conn, data: Uint8Array): void {
    const dec = decoding.createDecoder(data);
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.readSyncMessage(dec, enc, this.doc, conn);
      if (encoding.length(enc) > 1) conn.ws.send(encoding.toUint8Array(enc));
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), conn);
    }
  }

  private onAwareness({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown): void {
    const conn = origin as Conn | null;
    if (conn && this.conns.has(conn)) {
      for (const id of added.concat(updated)) conn.awarenessIds.add(id);
      for (const id of removed) conn.awarenessIds.delete(id);
    }
    const changed = added.concat(updated, removed);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
    const message = encoding.toUint8Array(enc);
    for (const c of this.conns) if (c !== conn && c.ws.readyState === 1) c.ws.send(message);
  }

  private broadcastUpdate(update: Uint8Array, origin: unknown): void {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    const message = encoding.toUint8Array(enc);
    for (const c of this.conns) if (c !== origin && c.ws.readyState === 1) c.ws.send(message);
  }

  broadcastEvent(event: ServerEvent): void {
    const text = JSON.stringify(event);
    for (const c of this.conns) if (c.ws.readyState === 1) c.ws.send(text);
  }

  private sendEvent(conn: Conn, event: ServerEvent): void {
    conn.ws.send(JSON.stringify(event));
  }

  // ---------------------------------------------------- document <-> disk

  private afterTransaction(tr: Y.Transaction): void {
    if (tr.changed.has(this.texts as unknown as Y.AbstractType<Y.YEvent<Y.Text>>)) this.reindexTexts();
    const author = authorOf(tr.origin);
    let textChanged = false;
    for (const type of tr.changed.keys()) {
      if (!(type instanceof Y.Text)) continue;
      const path = this.pathOfText.get(type);
      if (!path) continue;
      textChanged = true;
      this.schedulePersist(path);
      if (author && author !== 'disk-sync') this.history.touch(path, author);
    }
    if (textChanged && this.settings.autoCompile && author !== null) this.scheduleAutoCompile();
  }

  private schedulePersist(path: string): void {
    const existing = this.persistTimers.get(path);
    if (existing) clearTimeout(existing);
    this.persistTimers.set(path, setTimeout(() => {
      this.persistTimers.delete(path);
      this.persist(path);
    }, PERSIST_DEBOUNCE_MS));
  }

  /**
   * Text files are written synchronously, and read synchronously when the
   * watcher reports a change: the compare-and-apply against `diskHash` then
   * happens in one turn of the event loop, so an overlapping write can never
   * be mistaken for an outside edit and folded back into the document.
   */
  private persist(path: string): void {
    const ytext = this.texts.get(path);
    if (!ytext) return;
    const data = Buffer.from(ytext.toString(), 'utf8');
    const hash = hashBytes(data);
    if (this.diskHash.get(path) === hash) return;
    this.diskHash.set(path, hash);
    this.writeSync(path, data);
  }

  private writeSync(path: string, data: Buffer): void {
    const abs = join(this.dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = join(dirname(abs), `.texwerk-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(tmp, data);
    renameSync(tmp, abs);
  }

  /** Write every pending text change now (before a compile, label or zip). */
  async persistAll(): Promise<void> {
    const paths = [...this.persistTimers.keys()];
    for (const p of paths) { clearTimeout(this.persistTimers.get(p)!); this.persistTimers.delete(p); }
    for (const p of paths) this.persist(p);
  }

  private async writeAtomic(path: string, data: Buffer): Promise<void> {
    const abs = join(this.dir, path);
    await mkdir(dirname(abs), { recursive: true });
    const tmp = join(dirname(abs), `.texwerk-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
    await writeFile(tmp, data);
    await rename(tmp, abs);
  }

  private async currentContent(path: string): Promise<{ data: Buffer; binary: boolean } | null> {
    const ytext = this.texts.get(path);
    if (ytext) return { data: Buffer.from(ytext.toString(), 'utf8'), binary: false };
    if (!this.bins.has(path)) return null;
    try { return { data: await readFile(join(this.dir, path)), binary: true }; } catch { return null; }
  }

  private startWatcher(): void {
    const skip = (rel: string) => RESERVED_DIRS.has(rel.split('/')[0]) || rel.split('/').pop()!.startsWith('.texwerk-tmp-');
    this.stopWatching = watchTree(this.dir, (rel) => {
      const t = this.watchTimers.get(rel);
      if (t) clearTimeout(t);
      this.watchTimers.set(rel, setTimeout(() => {
        this.watchTimers.delete(rel);
        void this.reconcile(rel);
      }, WATCH_DEBOUNCE_MS));
    }, skip);
  }

  /** Fold whatever is on disk at `rel` into the document. */
  async reconcile(rel: string, author = 'disk'): Promise<void> {
    const abs = join(this.dir, rel);
    const origin: ServerOrigin = { author };
    let info;
    try { info = await lstat(abs); } catch { info = null; }
    // Symlinks are never followed: one could point anywhere on the server.
    if (info?.isSymbolicLink()) info = null;
    if (!info) {
      // Gone from disk: drop it, and anything that lived under it.
      const prefix = `${rel}/`;
      const doomed = [...this.texts.keys(), ...this.bins.keys()].filter((p) => p === rel || p.startsWith(prefix));
      const doomedDirs = [...this.dirs.keys()].filter((p) => p === rel || p.startsWith(prefix));
      if (!doomed.length && !doomedDirs.length) return;
      this.doc.transact(() => {
        for (const p of doomed) { this.texts.delete(p); this.bins.delete(p); this.diskHash.delete(p); }
        for (const d of doomedDirs) this.dirs.delete(d);
      }, origin);
      for (const p of doomed) await this.history.snapshot(p, [author], 'delete');
      return;
    }
    if (info.isDirectory()) {
      if (!this.dirs.has(rel)) this.doc.transact(() => this.dirs.set(rel, true), origin);
      // A directory moved in wholesale reports only itself; walk it.
      for (const e of await readdir(abs, { withFileTypes: true })) {
        const child = `${rel}/${e.name}`;
        if (e.isDirectory() || (!this.texts.has(child) && !this.bins.has(child))) await this.reconcile(child, author);
      }
      return;
    }
    if (!info.isFile()) return;
    let data: Buffer;
    try { data = readFileSync(abs); } catch { return; }
    const hash = hashBytes(data);
    if (this.diskHash.get(rel) === hash) return;
    this.diskHash.set(rel, hash);
    this.ensureParentDirs(rel, origin);
    if (isTextFile(rel, data)) {
      const text = data.toString('utf8');
      this.doc.transact(() => {
        this.bins.delete(rel);
        const existing = this.texts.get(rel);
        if (existing) setYText(existing, text);
        else this.texts.set(rel, new Y.Text(text));
      }, origin);
    } else {
      this.doc.transact(() => {
        this.texts.delete(rel);
        this.bins.set(rel, { hash, size: data.length });
      }, origin);
    }
    await this.history.snapshot(rel, [author], 'edit');
  }

  private ensureParentDirs(rel: string, origin: ServerOrigin): void {
    const parts = rel.split('/').slice(0, -1);
    const missing: string[] = [];
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (!this.dirs.has(d)) missing.push(d);
    }
    if (missing.length) this.doc.transact(() => { for (const d of missing) this.dirs.set(d, true); }, origin);
  }

  /** Re-read the whole folder (after git operations). */
  async reconcileAll(author: string): Promise<void> {
    const onDisk = await this.scan();
    const present = new Set(onDisk.files.map((f) => f.path));
    for (const d of onDisk.dirs) if (!this.dirs.has(d)) await this.reconcile(d, author);
    for (const f of onDisk.files) await this.reconcile(f.path, author);
    for (const p of [...this.texts.keys(), ...this.bins.keys()]) if (!present.has(p)) await this.reconcile(p, author);
    const dirsPresent = new Set(onDisk.dirs);
    for (const d of [...this.dirs.keys()]) if (!dirsPresent.has(d)) await this.reconcile(d, author);
  }

  // --------------------------------------------------------- file operations

  exists(path: string): boolean {
    return this.texts.has(path) || this.bins.has(path) || this.dirs.has(path);
  }

  /** Create or overwrite a file with `data` (upload, new file, bridge write). */
  async putFile(path: string, data: Buffer, author: string): Promise<void> {
    const origin: ServerOrigin = { author };
    if (this.dirs.has(path)) throw new Error(`"${path}" is a folder`);
    this.ensureParentDirs(path, origin);
    const hash = hashBytes(data);
    if (isTextFile(path, data)) {
      const text = data.toString('utf8');
      this.doc.transact(() => {
        this.bins.delete(path);
        const existing = this.texts.get(path);
        if (existing) setYText(existing, text);
        else this.texts.set(path, new Y.Text(text));
      }, origin);
      const pending = this.persistTimers.get(path);
      if (pending) { clearTimeout(pending); this.persistTimers.delete(path); }
      this.diskHash.set(path, hash);
      this.writeSync(path, data);
    } else {
      this.diskHash.set(path, hash);
      await this.writeAtomic(path, data);
      this.doc.transact(() => {
        this.texts.delete(path);
        this.bins.set(path, { hash, size: data.length });
      }, origin);
    }
    await this.history.snapshot(path, [author], 'edit');
  }

  async mkdir(path: string, author: string): Promise<void> {
    await mkdir(join(this.dir, path), { recursive: true });
    this.ensureParentDirs(`${path}/x`, { author });
  }

  async remove(path: string, author: string): Promise<void> {
    await this.persistAll();
    const prefix = `${path}/`;
    const doomed = [...this.texts.keys(), ...this.bins.keys()].filter((p) => p === path || p.startsWith(prefix));
    // History first, while the content is still readable: deleted files stay restorable.
    for (const p of doomed) await this.history.flushPath(p, author);
    await rm(join(this.dir, path), { recursive: true, force: true });
    await this.reconcile(path, author);
  }

  async move(from: string, to: string, author: string): Promise<void> {
    if (this.exists(to)) throw new Error(`"${to}" already exists`);
    await this.persistAll();
    const origin: ServerOrigin = { author };
    const prefix = `${from}/`;
    const mapPath = (p: string) => (p === from ? to : `${to}/${p.slice(prefix.length)}`);
    const movedTexts = [...this.texts.entries()].filter(([p]) => p === from || p.startsWith(prefix));
    const movedBins = [...this.bins.entries()].filter(([p]) => p === from || p.startsWith(prefix));
    const movedDirs = [...this.dirs.keys()].filter((p) => p === from || p.startsWith(prefix));
    await mkdir(dirname(join(this.dir, to)), { recursive: true });
    await rename(join(this.dir, from), join(this.dir, to));
    this.ensureParentDirs(to, origin);
    this.doc.transact(() => {
      for (const [p, ytext] of movedTexts) {
        const content = ytext.toString();
        this.texts.delete(p);
        this.texts.set(mapPath(p), new Y.Text(content));
      }
      for (const [p, info] of movedBins) { this.bins.delete(p); this.bins.set(mapPath(p), info); }
      for (const d of movedDirs) { this.dirs.delete(d); this.dirs.set(mapPath(d), true); }
    }, origin);
    for (const [p] of [...movedTexts, ...movedBins]) {
      const hash = this.diskHash.get(p);
      this.diskHash.delete(p);
      if (hash) this.diskHash.set(mapPath(p), hash);
      await this.history.snapshot(p, [author], 'delete');
      await this.history.snapshot(mapPath(p), [author], 'edit');
      this.broadcastEvent({ t: 'renamed', from: p, to: mapPath(p) });
    }
    if (this.settings.mainFile === from || this.settings.mainFile.startsWith(prefix)) {
      this.settings.mainFile = mapPath(this.settings.mainFile);
      await this.saveSettings();
    }
  }

  /** Restore `path` to a blob from history (or delete it if `hash` is null). */
  async restoreFile(path: string, hash: string | null, author: string): Promise<void> {
    if (hash === null) {
      if (this.exists(path)) await this.remove(path, author);
      return;
    }
    const data = await this.history.readBlob(hash);
    if (!data) throw new Error('that version is no longer available');
    await this.putFile(path, data, author);
  }

  /** Put the whole project back to how it was at history entry `id`. */
  async restoreProject(id: number, author: string): Promise<void> {
    await this.persistAll();
    const target = this.history.stateAt(id);
    const current = [...this.texts.keys(), ...this.bins.keys()];
    for (const path of current) {
      if (!target.has(path)) await this.remove(path, author);
    }
    for (const [path, entry] of target) {
      if (this.history.knownHash(path) !== entry.hash) await this.restoreFile(path, entry.hash ?? null, author);
    }
  }

  // ---------------------------------------------------------------- compile

  private scheduleAutoCompile(): void {
    if (this.autoCompileTimer) clearTimeout(this.autoCompileTimer);
    this.autoCompileTimer = setTimeout(() => {
      this.autoCompileTimer = null;
      void this.requestCompile('auto');
    }, AUTO_COMPILE_DELAY_MS);
  }

  /** Compile now, or right after the running compile if one is in flight. */
  requestCompile(by: string): Promise<void> {
    if (this.compiling) {
      this.compileQueued = by;
      return this.compiling;
    }
    this.compiling = this.runCompile(by).finally(() => {
      this.compiling = null;
      if (this.compileQueued) {
        const next = this.compileQueued;
        this.compileQueued = null;
        void this.requestCompile(next);
      }
    });
    return this.compiling;
  }

  private async runCompile(by: string): Promise<void> {
    await this.persistAll();
    if (!this.settings.mainFile) {
      this.settings.mainFile = this.guessMainFile();
      if (this.settings.mainFile) await this.saveSettings();
    }
    this.compile = { ...this.compile, state: 'running', startedAt: Date.now(), by, mainFile: this.settings.mainFile };
    this.broadcastEvent({ t: 'compile', compile: this.compile });
    const run = await runLatexmk(this.dir, this.settings);
    if (run.pdf) this.lastPdf = run.pdf;
    this.lastOutput = run.output;
    this.lastLog = run.log;
    this.compile = {
      rev: this.compile.rev + 1,
      state: 'done',
      ok: run.ok,
      hasPdf: Boolean(this.lastPdf),
      startedAt: this.compile.startedAt,
      finishedAt: Date.now(),
      by,
      mainFile: this.settings.mainFile,
      issues: run.issues,
    };
    await writeFile(join(this.dir, BUILD_DIR, 'texwerk-compile.json'), JSON.stringify({ ...this.compile, pdf: this.lastPdf }));
    this.broadcastEvent({ t: 'compile', compile: this.compile });
  }

  isCompiling(): Promise<void> | null {
    return this.compiling;
  }

  // ---------------------------------------------------------------- listing

  /** Every file path in the project, for zip export. */
  allFiles(): string[] {
    return [...this.texts.keys(), ...this.bins.keys()].sort();
  }

  relative(abs: string): string {
    return relative(this.dir, abs).split(sep).join('/');
  }

  // --------------------------------------------------------------- lifecycle

  private scheduleUnload(): void {
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = setTimeout(() => {
      if (this.conns.size === 0 && !this.compiling) void this.close().then(() => this.onUnload?.());
    }, UNLOAD_AFTER_MS);
  }

  async close(): Promise<void> {
    this.stopWatching?.();
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.autoCompileTimer) clearTimeout(this.autoCompileTimer);
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    await this.persistAll();
    await this.history.flush(true);
    for (const c of this.conns) c.ws.close(1001, 'server shutting down');
    this.doc.destroy();
  }
}
