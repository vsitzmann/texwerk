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
import { cleanPath, colorFor, isTextFile, RESERVED_DIRS } from '../shared/files.ts';
import {
  MSG_AWARENESS, MSG_SYNC,
  type AuthorInfo, type BinInfo, type CompileSummary, type Identity, type ProjectSettings, type ServerEvent,
} from '../shared/protocol.ts';
import { setYText } from '../shared/textDiff.ts';
import { allThreads, type CommentMessage, type CommentThread, type ThreadMap } from '../shared/comments.ts';
import { chatArray, cleanMessage, findMentions, fromJsonl, toJsonl, type ChatMessage, type ChatRef } from '../shared/chat.ts';
import { authorRuns } from '../shared/provenance.ts';
import { isMassDeletion, MASS_DELETION_WINDOW_MS } from '../shared/deletionGuard.ts';
import { BUILD_DIR, runLatexmk } from './compile.ts';
import { ensureRepo } from './git.ts';
import { hashBytes, History } from './history.ts';
import { listTrash, moveToTrash, PROJECT_TRASH, readEntry, restoreFromTrash, type TrashMeta } from './trash.ts';

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
  /** View-only: may read and show a caret, never change the document. */
  readOnly: boolean;
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
  /**
   * Identifies this document's lineage (see ServerEvent hello). Kept across
   * restarts when the saved document is reloaded — clients' state then shares
   * its history and merges safely — and new whenever it had to be rebuilt
   * from the files.
   */
  epoch: string = randomUUID();
  readonly texts: Y.Map<Y.Text>;
  readonly bins: Y.Map<BinInfo>;
  readonly comments: Y.Map<ThreadMap>;
  readonly chat: Y.Array<ChatMessage>;
  readonly authors: Y.Map<AuthorInfo>;
  /** The server's own client id, and the ids it writes under for each author (see transactAs). */
  private readonly homeClient: number;
  private readonly clientOf = new Map<string, number>();
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
    this.comments = this.doc.getMap('comments');
    this.chat = chatArray(this.doc);
    this.authors = this.doc.getMap('authors');
    this.homeClient = this.doc.clientID;
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
    // The saved document keeps who wrote what; the files on disk are still
    // the truth for what the text is (anything changed outside TeXWerk while
    // the server was down is folded in as an edit "on disk").
    try {
      Y.applyUpdate(this.doc, await readFile(this.docFile()), origin);
      const saved = (await readFile(join(this.dir, '.texwerk', 'epoch'), 'utf8')).trim();
      if (saved) this.epoch = saved;
    } catch { /* first open, or unreadable: start from the files */ }
    await writeFile(join(this.dir, '.texwerk', 'epoch'), `${this.epoch}\n`);
    this.reindexTexts();
    const files = await this.scan();
    const onDisk = new Set(files.files.map((f) => f.path));
    const dirsOnDisk = new Set(files.dirs);
    this.transactAs('(on disk)', () => {
      for (const d of files.dirs) if (!this.dirs.has(d)) this.dirs.set(d, true);
      for (const d of [...this.dirs.keys()]) if (!dirsOnDisk.has(d)) this.dirs.delete(d);
      for (const f of files.files) {
        if (f.text !== null) {
          this.bins.delete(f.path);
          const existing = this.texts.get(f.path);
          if (!existing) this.texts.set(f.path, new Y.Text(f.text));
          else if (existing.toString() !== f.text) setYText(existing, f.text);
        } else {
          this.texts.delete(f.path);
          const known = this.bins.get(f.path);
          if (!known || known.hash !== f.hash) this.bins.set(f.path, { hash: f.hash, size: f.size });
        }
        this.diskHash.set(f.path, f.hash);
      }
      for (const p of [...this.texts.keys(), ...this.bins.keys()]) {
        if (!onDisk.has(p)) { this.texts.delete(p); this.bins.delete(p); }
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
    await this.loadComments();
    await this.loadChat();

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      this.broadcastUpdate(update, origin);
      this.noteAuthors(update, origin);
      this.scheduleDocSave();
    });
    this.doc.on('afterTransaction', (tr: Y.Transaction) => this.afterTransaction(tr));
    this.awareness.on('update', (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) =>
      this.onAwareness(changes, origin));
    this.comments.observeDeep(() => this.scheduleCommentSave(300));
    this.chat.observe(() => {
      this.scheduleChatSave(300);
      for (const wake of this.chatWaiters.splice(0)) wake();
    });
    this.startWatcher();
    this.flushTimer = setInterval(() => { void this.history.flush(); }, 1000);
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

  /**
   * The document to compile when nobody has said. Among files with a
   * \documentclass, prefer main.tex, then the one whose bibliography style
   * and inputs actually exist in the project (a leftover copy of the paper
   * usually points at something that is gone), then shallower paths.
   */
  guessMainFile(): string {
    const candidates = [...this.texts.keys()].filter((p) => p.endsWith('.tex'));
    const withClass = candidates.filter((p) => /\\documentclass/.test(this.texts.get(p)!.toString()));
    const exists = (rel: string, ext: string) => {
      const clean = rel.trim().replace(/^\.\//, '');
      return [clean, `${clean}${ext}`].some((p) => this.texts.has(p) || this.bins.has(p));
    };
    const score = (p: string) => {
      const src = this.texts.get(p)!.toString().replace(/(^|[^\\])%.*$/gm, '$1');
      let s = p === 'main.tex' ? 100 : 0;
      for (const m of src.matchAll(/\\bibliographystyle\s*\{([^}]+)\}/g)) {
        // Standard styles (plain, alpha, …) come from TeX Live, not the project.
        if (m[1].includes('/') && !exists(m[1], '.bst')) s -= 10;
      }
      for (const m of src.matchAll(/\\(?:input|include)\s*\{([^}]+)\}/g)) if (!exists(m[1], '.tex')) s -= 3;
      return s - p.split('/').length;
    };
    const pick = (list: string[]) => [...list].sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0];
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

  /** Where this project is being renamed to, once a rename has started. */
  private movedTo: string | null = null;

  /** Tell everyone connected, now and until the sockets close, the project's new id. */
  announceMove(to: string): void {
    this.movedTo = to;
    this.broadcastEvent({ t: 'moved', to });
  }

  addConn(conn: Conn): void {
    if (this.closed) {
      // Raced a rename: point it at the new id and let it reconnect there.
      if (this.movedTo) this.sendEvent(conn, { t: 'moved', to: this.movedTo });
      conn.ws.close(1012, 'project renamed');
      return;
    }
    this.conns.add(conn);
    if (this.unloadTimer) { clearTimeout(this.unloadTimer); this.unloadTimer = null; }
    this.sendEvent(conn, {
      t: 'hello', epoch: this.epoch, you: conn.identity, project: this.name, readOnly: conn.readOnly, compile: this.compile, settings: this.settings,
    });
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    conn.ws.send(encoding.toUint8Array(enc));
    if (this.movedTo) this.sendEvent(conn, { t: 'moved', to: this.movedTo });
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
    // Closed but the socket not yet (a rename in progress): the client still
    // holds the change and sends it again when it syncs with the new id.
    if (this.closed) return;
    const dec = decoding.createDecoder(data);
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      if (conn.readOnly) {
        // A viewer may ask for the document (step 1) but never send changes.
        if (decoding.readVarUint(dec) !== syncProtocol.messageYjsSyncStep1) return;
        syncProtocol.readSyncStep1(dec, enc, this.doc);
      } else {
        syncProtocol.readSyncMessage(dec, enc, this.doc, conn);
      }
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
    // Offsets in comments.json follow the text they are attached to.
    if (textChanged && this.comments.size) this.scheduleCommentSave(2000);
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
    // After close the folder may be moving (a rename): what is missing from
    // the old path was not deleted.
    if (this.closed) return;
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
      this.transactAs(author === 'disk' ? '(edited on disk)' : author, () => {
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
      this.transactAs(author, () => {
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

  /** Files mirrors deleted lately, for allowMirrorDelete. */
  private mirrorDeletes: Array<{ at: number; count: number }> = [];

  /**
   * Whether a mirror may delete `path` now. A mirror that deletes file after
   * file because its folder was removed (bridges from before the folder check
   * do) is stopped before it deletes most of the project; people in the
   * browser are never limited. Records the deletion when it is allowed.
   */
  allowMirrorDelete(path: string): boolean {
    const now = Date.now();
    this.mirrorDeletes = this.mirrorDeletes.filter((d) => now - d.at < MASS_DELETION_WINDOW_MS);
    const files = [...this.texts.keys(), ...this.bins.keys()];
    const count = files.filter((p) => p === path || p.startsWith(`${path}/`)).length;
    const recent = this.mirrorDeletes.reduce((n, d) => n + d.count, 0);
    if (isMassDeletion(recent + count, files.length + recent)) return false;
    this.mirrorDeletes.push({ at: now, count });
    return true;
  }

  async remove(path: string, author: string): Promise<void> {
    await this.persistAll();
    const prefix = `${path}/`;
    const doomed = [...this.texts.keys(), ...this.bins.keys()].filter((p) => p === path || p.startsWith(prefix));
    // History first, while the content is still readable: deleted files stay restorable.
    for (const p of doomed) await this.history.flushPath(p, author);
    // Never deleted: moved into the project's hidden trash (.texwerk/trash/).
    // Reconciling the now-missing path removes it from the shared document,
    // so open editors close it and mirrors delete their copy.
    let info;
    try { info = await lstat(join(this.dir, path)); } catch { info = null; }
    if (info) {
      await moveToTrash(this.trashDir, join(this.dir, path), {
        kind: info.isDirectory() ? 'dir' : 'file', path, deletedAt: new Date().toISOString(), deletedBy: author,
      });
    }
    await this.reconcile(path, author);
  }

  get trashDir(): string {
    return join(this.dir, ...PROJECT_TRASH);
  }

  listTrash(): Promise<TrashMeta[]> {
    return listTrash(this.trashDir);
  }

  /** Put a trashed file or folder back where it was; refuses if the path is taken. */
  async restoreTrashed(id: string, author: string): Promise<string> {
    const meta = await readEntry(this.trashDir, id);
    if (!meta || (meta.kind !== 'file' && meta.kind !== 'dir') || cleanPath(meta.path) !== meta.path) throw new Error('no such item in the trash');
    if (this.exists(meta.path)) throw new Error(`"${meta.path}" exists again; rename it first`);
    await mkdir(dirname(join(this.dir, meta.path)), { recursive: true });
    await restoreFromTrash(this.trashDir, meta, join(this.dir, meta.path));
    await this.reconcile(meta.path, author);
    return meta.path;
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
    // Moving a text file makes a new Y.Text, so its comments are re-anchored after.
    const movedComments = allThreads(this.doc).filter((t) => t.path === from || t.path.startsWith(prefix));
    await mkdir(dirname(join(this.dir, to)), { recursive: true });
    await rename(join(this.dir, from), join(this.dir, to));
    this.ensureParentDirs(to, origin);
    // A moved file is a new Y.Text; copy it run by run so every word keeps its author.
    const runs = new Map(movedTexts.map(([p, ytext]) => [p, authorRuns(ytext, this.authors)]));
    this.doc.transact(() => {
      for (const [p] of movedTexts) {
        this.texts.delete(p);
        this.texts.set(mapPath(p), new Y.Text());
      }
    }, origin);
    for (const [p] of movedTexts) {
      let at = 0;
      for (const run of runs.get(p)!) {
        const target = this.texts.get(mapPath(p))!;
        this.transactAs(run.author, () => target.insert(at, run.text), origin);
        at += run.text.length;
      }
    }
    this.doc.transact(() => {
      for (const [p, info] of movedBins) { this.bins.delete(p); this.bins.set(mapPath(p), info); }
      for (const d of movedDirs) { this.dirs.delete(d); this.dirs.set(mapPath(d), true); }
    }, origin);
    if (movedComments.length) {
      this.doc.transact(() => {
        for (const t of movedComments) {
          const m = this.comments.get(t.id);
          if (!m) continue;
          const anchor = this.anchor(mapPath(t.path), t.from, t.to, t.quote);
          m.set('path', mapPath(t.path));
          m.set('start', anchor?.start ?? null);
          m.set('end', anchor?.end ?? null);
        }
      }, origin);
    }
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

  private cleanNext = false;

  /** Compile now, or right after the running compile if one is in flight. */
  requestCompile(by: string, clean = false): Promise<void> {
    if (clean) this.cleanNext = true;
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
    const clean = this.cleanNext;
    this.cleanNext = false;
    // After a failed or PDF-less run, "nothing changed" is not an answer.
    const force = this.compile.rev > 0 && (!this.compile.ok || !this.lastPdf);
    const run = await runLatexmk(this.dir, this.settings, { force, clean });
    if (clean && !run.pdf) this.lastPdf = null;
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
      upToDate: run.upToDate,
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
    if (this.closed) return;
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = setTimeout(() => {
      if (this.conns.size === 0 && !this.compiling) void this.close().then(() => this.onUnload?.());
    }, UNLOAD_AFTER_MS);
  }

  // ------------------------------------------------------------- provenance

  private docFile(): string {
    return join(this.dir, '.texwerk', 'ydoc.bin');
  }

  private docSaveTimer: NodeJS.Timeout | null = null;

  private scheduleDocSave(): void {
    if (this.docSaveTimer) return;
    this.docSaveTimer = setTimeout(() => { this.docSaveTimer = null; this.saveDoc(); }, 2000);
  }

  saveDoc(): void {
    if (this.docSaveTimer) { clearTimeout(this.docSaveTimer); this.docSaveTimer = null; }
    mkdirSync(join(this.dir, '.texwerk'), { recursive: true });
    const tmp = `${this.docFile()}.${process.pid}.tmp`;
    writeFileSync(tmp, Y.encodeStateAsUpdate(this.doc));
    renameSync(tmp, this.docFile());
  }

  /** Record who each new Yjs client in an update belongs to. */
  private noteAuthors(update: Uint8Array, origin: unknown): void {
    const conn = origin as Conn | null;
    if (!conn || !this.conns.has(conn)) return;
    let clients: number[];
    try {
      clients = [...new Set(Y.decodeUpdate(update).structs.map((s) => s.id.client))];
    } catch {
      return;
    }
    const fresh = clients.filter((c) => !this.authors.has(String(c)));
    if (!fresh.length) return;
    const name = conn.bridge ? `${conn.identity.name} · agent` : conn.identity.name;
    queueMicrotask(() => this.doc.transact(() => {
      for (const c of fresh) {
        this.authors.set(String(c), {
          name, login: conn.identity.login, color: colorFor(conn.bridge ? `${conn.identity.login}:agent` : conn.identity.login),
          agent: conn.bridge || undefined, first: Date.now(),
        });
      }
    }, { author: 'authors' }));
  }

  /**
   * Run a server-side text change so its characters are attributed to
   * `author` (an upload, a restore, a pull, an edit on disk): each author
   * gets a client id of its own for this session, registered in `authors`.
   */
  private transactAs(author: string, fn: () => void, origin: unknown = { author }): void {
    let client = this.clientOf.get(author);
    if (client === undefined) {
      do { client = Math.floor(Math.random() * 0xffffffff); } while (this.authors.has(String(client)) || client === this.homeClient);
      this.clientOf.set(author, client);
      const login = author.startsWith('(') ? '' : author;
      this.doc.transact(() => this.authors.set(String(client!), { name: author, login, color: author.startsWith('(') ? '#565f89' : colorFor(author), first: Date.now() }), { author: 'authors' });
    }
    this.doc.clientID = client;
    try {
      this.doc.transact(fn, origin);
    } finally {
      this.doc.clientID = this.homeClient;
    }
  }

  // ---------------------------------------------------------------- comments

  private commentSaveTimer: NodeJS.Timeout | null = null;

  private commentsFile(): string {
    return join(this.dir, '.texwerk', 'comments.json');
  }

  private scheduleCommentSave(delay: number): void {
    if (this.commentSaveTimer) return;
    this.commentSaveTimer = setTimeout(() => {
      this.commentSaveTimer = null;
      this.saveComments();
    }, delay);
  }

  /** comments.json: absolute offsets and quotes, readable and diffable in git. */
  saveComments(): void {
    if (this.commentSaveTimer) { clearTimeout(this.commentSaveTimer); this.commentSaveTimer = null; }
    const threads = allThreads(this.doc).sort((a, b) => a.createdAt - b.createdAt);
    if (!threads.length && !existsSync(this.commentsFile())) return;
    mkdirSync(join(this.dir, '.texwerk'), { recursive: true });
    const tmp = `${this.commentsFile()}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(threads, null, 2)}\n`);
    renameSync(tmp, this.commentsFile());
  }

  /** Relative positions for [from, to) in `path`, found again by quote if the text moved. */
  private anchor(path: string, from: number | null, to: number | null, quote: string): { start: unknown; end: unknown } | null {
    const ytext = this.texts.get(path);
    if (!ytext) return null;
    const text = ytext.toString();
    let a = from;
    let b = to;
    if (a === null || b === null || b <= a || text.slice(a, b) !== quote) {
      if (!quote) return null;
      // The file changed while the server was down: the nearest copy of the quote.
      let best = -1;
      for (let i = text.indexOf(quote); i >= 0; i = text.indexOf(quote, i + 1)) {
        if (best < 0 || Math.abs(i - (from ?? 0)) < Math.abs(best - (from ?? 0))) best = i;
      }
      if (best < 0) return null;
      a = best;
      b = best + quote.length;
    }
    return {
      start: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, a, 0)),
      end: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, b, -1)),
    };
  }

  private putThread(t: CommentThread): void {
    const m = new Y.Map<unknown>();
    const anchor = this.anchor(t.path, t.from, t.to, t.quote);
    for (const [k, v] of Object.entries({
      path: t.path, quote: t.quote, author: t.author, login: t.login, createdAt: t.createdAt,
      resolved: t.resolved, resolvedBy: t.resolvedBy ?? null, resolvedAt: t.resolvedAt ?? null,
      start: anchor?.start ?? null, end: anchor?.end ?? null,
    })) m.set(k, v);
    const messages = new Y.Array<CommentMessage>();
    messages.push(t.messages);
    m.set('messages', messages);
    this.comments.set(t.id, m);
  }

  async loadComments(): Promise<void> {
    let threads: CommentThread[] = [];
    if (existsSync(this.commentsFile())) {
      try {
        threads = JSON.parse(await readFile(this.commentsFile(), 'utf8'));
        if (!Array.isArray(threads)) throw new Error('not a list');
      } catch (err) {
        // A git merge can leave conflict markers in it: keep what we have
        // rather than wiping every thread on the next save.
        console.error(`[${this.name}] comments.json unreadable, keeping current threads:`, (err as Error).message);
        return;
      }
    }
    this.doc.transact(() => {
      for (const key of [...this.comments.keys()]) this.comments.delete(key);
      for (const t of threads) if (t && t.id && t.path) this.putThread(t);
    }, { author: 'disk' });
  }

  private thread(id: string): ThreadMap {
    const t = this.comments.get(id);
    if (!t) throw new Error('no such comment');
    return t;
  }

  createComment(path: string, from: number, to: number, text: string, author: string, login: string): string {
    const ytext = this.texts.get(path);
    if (!ytext) throw new Error(`"${path}" is not a text file`);
    const content = ytext.toString();
    const a = Math.max(0, Math.min(from, content.length));
    const b = Math.max(a, Math.min(to, content.length));
    if (b <= a) throw new Error('select some text to comment on');
    const id = randomUUID().slice(0, 8);
    const now = Date.now();
    this.doc.transact(() => this.putThread({
      id, path, from: a, to: b, line: null, quote: content.slice(a, b), author, login, createdAt: now, resolved: false,
      messages: [{ id: randomUUID().slice(0, 8), author, login, ts: now, text }],
    }), { author });
    return id;
  }

  reply(id: string, text: string, author: string, login: string): void {
    const t = this.thread(id);
    this.doc.transact(() => {
      (t.get('messages') as Y.Array<CommentMessage>).push([{ id: randomUUID().slice(0, 8), author, login, ts: Date.now(), text }]);
      // Replying to a resolved thread reopens it: the conversation is live again.
      if (t.get('resolved')) { t.set('resolved', false); t.set('resolvedBy', null); t.set('resolvedAt', null); }
    }, { author });
  }

  setResolved(id: string, resolved: boolean, author: string): void {
    const t = this.thread(id);
    this.doc.transact(() => {
      t.set('resolved', resolved);
      t.set('resolvedBy', resolved ? author : null);
      t.set('resolvedAt', resolved ? Date.now() : null);
    }, { author });
  }

  /** Edit or delete one message; `mayModerate` lets owners change anyone's. Deleting the first message deletes the thread. */
  changeMessage(id: string, messageId: string, text: string | null, login: string, mayModerate: boolean): void {
    const t = this.thread(id);
    const messages = t.get('messages') as Y.Array<CommentMessage>;
    const index = messages.toArray().findIndex((m) => m.id === messageId);
    if (index < 0) throw new Error('no such message');
    const message = messages.get(index);
    if (message.login !== login && !mayModerate) throw new Error('you can only change your own messages');
    this.doc.transact(() => {
      if (text === null) {
        if (index === 0) this.comments.delete(id);
        else messages.delete(index, 1);
      } else {
        messages.delete(index, 1);
        messages.insert(index, [{ ...message, text, edited: Date.now() }]);
      }
    }, { author: login });
  }

  // ---------------------------------------------------------------- chat

  private chatSaveTimer: NodeJS.Timeout | null = null;
  private readonly chatWaiters: Array<() => void> = [];

  private chatFile(): string {
    return join(this.dir, '.texwerk', 'chat.jsonl');
  }

  private scheduleChatSave(delay: number): void {
    if (this.chatSaveTimer) return;
    this.chatSaveTimer = setTimeout(() => {
      this.chatSaveTimer = null;
      this.saveChat();
    }, delay);
  }

  /** chat.jsonl: one message per line, oldest first. */
  saveChat(): void {
    if (this.chatSaveTimer) { clearTimeout(this.chatSaveTimer); this.chatSaveTimer = null; }
    if (!this.chat.length && !existsSync(this.chatFile())) return;
    mkdirSync(join(this.dir, '.texwerk'), { recursive: true });
    const tmp = `${this.chatFile()}.${process.pid}.tmp`;
    writeFileSync(tmp, toJsonl(this.chat.toArray()));
    renameSync(tmp, this.chatFile());
  }

  /**
   * The chat from chat.jsonl. The saved document normally has it already;
   * the file wins when they differ (it was restored, copied in or edited).
   */
  async loadChat(): Promise<void> {
    if (!existsSync(this.chatFile())) return;
    let messages: ChatMessage[];
    try {
      messages = fromJsonl(await readFile(this.chatFile(), 'utf8'));
    } catch (err) {
      console.error(`[${this.name}] chat.jsonl unreadable, keeping the current chat:`, (err as Error).message);
      return;
    }
    const current = this.chat.toArray();
    if (current.length === messages.length && current.every((m, i) => m.id === messages[i].id)) return;
    this.doc.transact(() => {
      this.chat.delete(0, this.chat.length);
      this.chat.push(messages);
    }, { author: 'disk' });
  }

  /** Post a message; `names` are the people it may mention (everyone present). */
  say(text: string, who: { author: string; login: string; agent: boolean }, names: string[], ref?: ChatRef): ChatMessage {
    const m = cleanMessage({
      id: randomUUID().slice(0, 8), author: who.author, login: who.login, agent: who.agent, ts: Date.now(), text,
      mentions: findMentions(text, names), ref,
    })!;
    this.doc.transact(() => this.chat.push([m]), { author: who.author });
    return m;
  }

  /** Resolves on the next chat message, or after `ms`. */
  waitChat(ms: number): Promise<void> {
    return new Promise((done) => {
      const timer = setTimeout(() => { const i = this.chatWaiters.indexOf(wake); if (i >= 0) this.chatWaiters.splice(i, 1); done(); }, ms);
      const wake = () => { clearTimeout(timer); done(); };
      this.chatWaiters.push(wake);
    });
  }

  private closed = false;

  /**
   * Persist everything and stop. `closeConns: false` leaves the sockets open
   * for the caller to close (a rename closes them only once the folder has
   * moved, so nobody reconnects before the new id exists).
   */
  async close(closeConns = true): Promise<void> {
    // Sockets closed here come back through removeConn → scheduleUnload,
    // which must not persist a destroyed document a second time.
    if (this.closed) return;
    this.closed = true;
    this.stopWatching?.();
    for (const t of this.watchTimers.values()) clearTimeout(t);
    this.watchTimers.clear();
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.autoCompileTimer) clearTimeout(this.autoCompileTimer);
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    await this.persistAll();
    this.saveComments();
    this.saveChat();
    for (const wake of this.chatWaiters.splice(0)) wake();
    this.saveDoc();
    await this.history.flush(true);
    if (closeConns) for (const c of this.conns) c.ws.close(1001, 'server shutting down');
    this.doc.destroy();
  }
}
