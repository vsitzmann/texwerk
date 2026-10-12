import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { colorFor, isBuildArtifact, isEditorTempFile, isTextFile } from '../shared/files.ts';
import { isMassDeletion } from '../shared/deletionGuard.ts';
import { Provider } from '../shared/provider.ts';
import { BRIDGE_HEADER, type BinInfo, type CompileSummary, type ServerEvent } from '../shared/protocol.ts';
import { applyEditsToYText, editsBetween } from '../shared/textDiff.ts';
import { watchTree } from '../shared/watchTree.ts';
import { allThreads, commentsMarkdown } from '../shared/comments.ts';
import { chatArray, chatMarkdown } from '../shared/chat.ts';

/**
 * texwerk-connect.mjs — mirror a live TeXWerk project into a local folder.
 *
 *   curl -fsSL https://server/texwerk-connect.mjs -o texwerk-connect.mjs
 *   node texwerk-connect.mjs 'https://server/?project=Paper' [folder]
 *
 * The folder becomes an ordinary directory of files that any editor or
 * agent can work in. This process keeps a full Yjs replica of the project:
 *
 *  - remote edits are applied to the replica and written to disk within
 *    milliseconds (atomic rename, so readers never see half a file);
 *  - a local save is diffed against what was last written and applied to the
 *    replica as character-level edits, which Yjs merges with whatever
 *    collaborators typed meanwhile. A save that races a remote edit is
 *    rebased through it, so neither side's change is lost;
 *  - binary files (figures) are downloaded and uploaded whole;
 *  - new, deleted and renamed files travel both ways — but a mirror never
 *    empties the project: deletions wait a moment and go together, and are
 *    dropped (with the files restored here) if the folder itself was deleted
 *    or replaced, or if they would delete most of the project (see
 *    flushDeletes). One folder is mirrored by one process (`.texwerk/lock`);
 *    `node texwerk-connect.mjs --stop <folder>` stops it.
 *
 * Everything under `.texwerk/` is local only: the agent guide, a small `tw`
 * helper for compiling, the latest PDF and log. Editor swap files and LaTeX
 * build products are never uploaded.
 */

const LOCAL_DEBOUNCE_MS = 40;
const REMOTE_FLUSH_MS = 15;
/** A file modified by someone else more recently than this may be mid-write. */
const SETTLE_MS = 30;
/** Never wait longer than this for a file that keeps changing. */
const MAX_DEFER_MS = 250;
/** A new file must exist unchanged this long before it is uploaded. */
const NEW_FILE_SETTLE_MS = 200;
/** Local deletions are collected until none has come for this long. */
const DELETE_QUIET_MS = 400;
const LOCAL_DIR = '.texwerk';
const LOCK_FILE = 'lock';

function sha(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 40);
}

function usage(): never {
  process.stderr.write('usage: node texwerk-connect.mjs \'<server>/?project=<name>\' [folder]\n       node texwerk-connect.mjs --stop <folder>\n');
  process.exit(2);
}

/** The pid in `<folder>/.texwerk/lock`, if that process is still running. */
function lockHolder(folder: string): number | null {
  let pid: number;
  try { pid = Number(JSON.parse(readFileSync(join(folder, LOCAL_DIR, LOCK_FILE), 'utf8')).pid); } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EPERM') return null; }
  // A stale lock whose pid now belongs to some other program is not a mirror
  // (and must never be what --stop kills). Checkable where /proc exists.
  try { if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('connect')) return null; } catch { /* no /proc */ }
  return pid;
}

const [, , sessionArg, folderArg] = process.argv;
if (!sessionArg || sessionArg === '-h' || sessionArg === '--help') usage();
if (sessionArg === '--stop') {
  if (!folderArg) usage();
  const pid = lockHolder(resolve(folderArg));
  if (pid === null) { process.stdout.write(`no mirror is running in ${resolve(folderArg)}\n`); process.exit(0); }
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (lockHolder(resolve(folderArg)) === pid && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  process.stdout.write(`stopped the mirror (pid ${pid}) in ${resolve(folderArg)}\n`);
  process.exit(0);
}
const session = new URL(sessionArg);
const projectParam = session.searchParams.get('project');
if (!projectParam) usage();
/** Changes if the project is renamed while mirrored (a `moved` event). */
let project: string = projectParam;
const typedName = session.searchParams.get('name');
const origin = session.origin;
const root = resolve(folderArg ?? project.replace(/[^\w.-]+/g, '-'));

const query = (extra: Record<string, string> = {}) => {
  const q = new URLSearchParams({ project, ...extra });
  if (typedName) q.set('name', typedName);
  return q.toString();
};

async function http(method: string, path: string, body?: BodyInit, extra: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(`${origin}${path}?${query(extra)}`, {
    method,
    body,
    headers: { [BRIDGE_HEADER]: '1', ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}) },
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res;
}

const DEBUG = Boolean(process.env.TEXWERK_DEBUG);
function debug(message: string): void {
  if (DEBUG) process.stdout.write(`  · ${Date.now() % 100000} ${message}\n`);
}

function log(message: string): void {
  process.stdout.write(`[${new Date().toLocaleTimeString()}] ${message}\n`);
}

// ------------------------------------------------------------ the folder itself

/**
 * The mirror folder as it was when we started (device and inode of the folder
 * and of its `.texwerk/`). If either is gone or replaced — `rm -rf` of the
 * folder, a new mirror set up on the same path — every file in it looks
 * deleted, and none of that may reach the server. The mirror stops instead.
 */
let folderId: string | null = null;
let stopping = false;
function currentFolderId(): string | null {
  try {
    const a = statSync(root);
    const b = statSync(join(root, LOCAL_DIR));
    return `${a.dev}:${a.ino}/${b.dev}:${b.ino}`;
  } catch {
    return null;
  }
}

/** False (and the mirror stopping) once the folder was deleted or replaced. */
function folderIntact(): boolean {
  if (stopping) return false;
  if (folderId === null || currentFolderId() === folderId) return true;
  stopping = true;
  log(`the mirror folder ${root} was deleted or replaced — stopping. Nothing was deleted on the server.`);
  process.exit(1);
}

// ------------------------------------------------------------ replica

// The replica. Replaced wholesale when the server's document is reloaded
// (see Provider onReset). No garbage collection: past versions must stay
// reconstructible (see Version).
let doc = new Y.Doc({ gc: false });
let texts = doc.getMap<Y.Text>('text');
let bins = doc.getMap<BinInfo>('bin');
let dirs = doc.getMap<boolean>('dirs');
let awareness = new Awareness(doc);
const LOCAL = { local: true };

/** What we last wrote to (or read from) disk for each text file. */
const shadow = new Map<string, string>();

/**
 * Per text file, the recent versions that were on disk, each with a Yjs
 * snapshot of the replica at that moment. A save found on disk is matched to
 * the version it was most likely built from — usually the latest, but an
 * agent may have read the file just before we rewrote it — and applied to a
 * fork of the replica taken at that version. Merging the fork back lets Yjs
 * reconcile the save with everything that happened since, exactly as it does
 * for two people typing, so a stale save never reads as a revert of newer
 * changes.
 */
interface Version {
  content: string;
  snap: Y.Snapshot;
  ts: number;
}
const histories = new Map<string, Version[]>();
const MAX_VERSIONS = 16;
const VERSION_TTL_MS = 15_000;
/** How far back a save may plausibly have been read. */
const STALE_WINDOW_MS = 2_000;

/** Record that disk now holds `content`, as of snapshot `snap`. */
function setShadow(path: string, content: string, snap: Y.Snapshot = Y.snapshot(doc)): void {
  shadow.set(path, content);
  const versions = histories.get(path) ?? [];
  const now = Date.now();
  versions.push({ content, snap, ts: now });
  while (versions.length > MAX_VERSIONS || (versions.length > 1 && now - versions[0].ts > VERSION_TTL_MS)) versions.shift();
  histories.set(path, versions);
}

function editCost(edits: Array<{ remove: number; insert: string }>): number {
  return edits.reduce((sum, e) => sum + e.remove + e.insert.length, 0);
}
/** Hash of each binary file as last synced. */
const binHash = new Map<string, string>();
const remoteTimers = new Map<string, NodeJS.Timeout>();
const localTimers = new Map<string, NodeJS.Timeout>();
/** Paths we are writing ourselves, and paths we removed; the watcher ignores their echo. */
const selfTouched = new Map<string, number>();
const selfRemoved = new Map<string, number>();
let ready = false;
/** Connected to the server with a synced replica. Local saves wait otherwise. */
let online = false;
let me = typedName ?? 'you';

function abs(rel: string): string {
  return join(root, ...rel.split('/'));
}

function ignored(rel: string): boolean {
  const parts = rel.split('/');
  if (parts[0] === LOCAL_DIR || parts[0] === '.git' || parts[0] === 'node_modules') return true;
  if (parts.some((p) => p === '.DS_Store')) return true;
  if (isEditorTempFile(rel) || isBuildArtifact(rel)) return true;
  if (parts.length === 1 && (rel === 'texwerk-connect.mjs')) return true;
  return false;
}

async function writeAtomic(rel: string, data: string | Uint8Array): Promise<void> {
  if (!folderIntact()) return;
  const target = abs(rel);
  await mkdir(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.texwerk-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  selfTouched.set(rel, Date.now());
  await writeFile(tmp, data);
  await rename(tmp, target);
}

/**
 * Text files are compared and written synchronously. Every read-compare-write
 * of a document then happens in one turn of the event loop, so a remote flush
 * and a local save can never interleave and mistake each other's half-done
 * work for an edit.
 */
function writeTextSync(rel: string, content: string, expectStamp?: string): boolean {
  if (!folderIntact()) return false;
  const target = abs(rel);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.texwerk-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmp, content);
  // Last check right before the rename: a save that landed while we were
  // merging or writing the temp file must be read, never replaced.
  if (expectStamp !== undefined && fileStamp(rel) !== expectStamp) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    return false;
  }
  selfTouched.set(rel, Date.now());
  renameSync(tmp, target);
  try { ownMtime.set(rel, statSync(target).mtimeMs); } catch { /* raced a delete */ }
  return true;
}

/** mtime of each file right after we last wrote it. */
const ownMtime = new Map<string, number>();

/**
 * Whether someone else is plausibly still writing `rel`: an editor that saves
 * in place truncates first and writes after, and reading in between would
 * look like the whole tail was deleted. Wait until the file has been quiet.
 */
const deferredSince = new Map<string, number>();

/**
 * Read a text file only in a quiet moment: the stat before and after the read
 * must agree, and the file must not have been modified (by someone else)
 * within SETTLE_MS — a writer that truncates first would otherwise hand us a
 * half-empty file that looks like a mass deletion. Returns 'busy' to retry.
 * A file that never settles is read anyway after MAX_DEFER_MS, still only
 * when the two stats agree.
 */
function readSettled(rel: string): string | null | 'busy' {
  const before = fileStamp(rel);
  const content = readTextSync(rel);
  const after = fileStamp(rel);
  if (before !== after) return 'busy';
  if (content === null) return null;
  let mtime: number;
  try { mtime = statSync(abs(rel)).mtimeMs; } catch { return null; }
  const recent = mtime !== ownMtime.get(rel) && Date.now() - mtime < SETTLE_MS;
  if (!recent) { deferredSince.delete(rel); return content; }
  const since = deferredSince.get(rel) ?? Date.now();
  deferredSince.set(rel, since);
  if (Date.now() - since > MAX_DEFER_MS) { deferredSince.delete(rel); return content; }
  return 'busy';
}

function readTextSync(rel: string): string | null {
  try { return readFileSync(abs(rel), 'utf8'); } catch { return null; }
}

// ------------------------------------------------------------ remote -> disk

function observeText(path: string, ytext: Y.Text): void {
  ytext.observe((_event, tr) => {
    if (ready && tr.origin !== LOCAL) scheduleSync(path, REMOTE_FLUSH_MS);
  });
}

function scheduleSync(path: string, delay: number): void {
  // Typing streams many small updates; sync on the first promptly rather
  // than pushing it back with every keystroke.
  if (remoteTimers.has(path)) return;
  remoteTimers.set(path, setTimeout(() => { remoteTimers.delete(path); syncText(path); }, delay));
}

/**
 * Bring one text file and the replica together, both ways, synchronously:
 * fold in whatever was saved on disk since we last looked, then write the
 * replica's text back if it differs.
 */
function syncText(path: string): void {
  const ytext = texts.get(path);
  if (!ytext) return;
  // Offline, a save stays on disk only: folded into the replica it could not
  // reach the server, and would be lost if the server comes back with a
  // reloaded document. The reconnect rescans (see startSession).
  if (!online) return;
  const before = fileStamp(path);
  const disk = readSettled(path);
  if (disk === 'busy') { debug(`sync ${path}: unsettled, retry`); scheduleSync(path, SETTLE_MS); return; }
  const base = shadow.get(path);
  if (disk !== null && base !== undefined && disk !== base) mergeSave(path, ytext, disk);
  const content = ytext.toString();
  if (content !== disk) {
    if (!writeTextSync(path, content, before)) {
      debug(`sync ${path}: changed under us, retry`);
      scheduleSync(path, 5);
      return;
    }
    debug(`sync ${path}: write ${content.length}`);
  }
  if (shadow.get(path) !== content) setShadow(path, content);
}

function fileStamp(rel: string): string {
  try {
    const st = statSync(abs(rel));
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

/** Apply a save found on disk to the replica (see Version). */
function mergeSave(path: string, ytext: Y.Text, disk: string): void {
  const versions = histories.get(path) ?? [];
  let best: { version: Version; edits: ReturnType<typeof editsBetween>; cost: number } | null = null;
  const now = Date.now();
  // Newest first, ties to the newest: the version needing the fewest edits to
  // become the save is the one it was built from.
  for (let i = versions.length - 1; i >= 0; i--) {
    if (best && now - versions[i].ts > STALE_WINDOW_MS) break;
    const edits = editsBetween(versions[i].content, disk);
    const cost = editCost(edits);
    if (!best || cost < best.cost) best = { version: versions[i], edits, cost };
    if (cost === 0) break;
  }
  if (!best || !best.edits.length) return;
  const fork = Y.createDocFromSnapshot(doc, best.version.snap);
  const forkText = fork.getMap<Y.Text>('text').get(path);
  if (!forkText || forkText.toString() !== best.version.content) {
    // Should not happen; fall back to applying the diff to the latest text.
    debug(`merge ${path}: snapshot mismatch, applying against current text`);
    doc.transact(() => applyEditsToYText(ytext, editsBetween(ytext.toString(), disk)), LOCAL);
    fork.destroy();
    return;
  }
  fork.transact(() => applyEditsToYText(forkText, best!.edits));
  const stale = versions.length - 1 - versions.indexOf(best.version);
  debug(`merge ${path}: ${best.edits.length} edit(s) from a save based ${stale} version(s) back of ${versions.length}, cost ${best.cost}, removes ${best.edits.reduce((n, e) => n + e.remove, 0)}${best.edits.some((e) => e.remove) ? ` ${JSON.stringify(best.edits.filter((e) => e.remove).map((e) => best!.version.content.slice(e.at, e.at + e.remove)))}` : ''}`);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(fork, Y.encodeStateVector(doc)), LOCAL);
  // What is on disk now is itself a version later saves may build on.
  setShadow(path, disk, Y.snapshot(fork));
  fork.destroy();
  const last = best.edits[best.edits.length - 1];
  const at = last.at + last.insert.length;
  pointCaretAt(path, ytext, { at: Math.min(at, ytext.length), insert: '' });
}

async function syncBinaryDown(path: string, info: BinInfo): Promise<void> {
  if (binHash.get(path) === info.hash) return;
  try {
    const local = await readFile(abs(path));
    if (sha(local) === info.hash) { binHash.set(path, info.hash); return; }
  } catch { /* missing */ }
  const res = await fetch(`${origin}/raw/${encodeURIComponent(project)}/${path.split('/').map(encodeURIComponent).join('/')}?${typedName ? `name=${encodeURIComponent(typedName)}` : ''}`,
    { headers: { [BRIDGE_HEADER]: '1' } });
  if (!res.ok) { log(`could not download ${path}: ${res.status}`); return; }
  const data = new Uint8Array(await res.arrayBuffer());
  binHash.set(path, info.hash);
  await writeAtomic(path, data);
}

async function removeLocal(path: string): Promise<void> {
  selfRemoved.set(path, Date.now());
  shadow.delete(path);
  histories.delete(path);
  binHash.delete(path);
  await rm(abs(path), { recursive: true, force: true });
}

/** `.texwerk/comments.md`: every thread, current, for agents to read. */
let commentsTimer: NodeJS.Timeout | null = null;
function scheduleCommentsFile(): void {
  if (commentsTimer) return;
  commentsTimer = setTimeout(() => {
    commentsTimer = null;
    void writeFile(join(root, LOCAL_DIR, 'comments.md'), commentsMarkdown(project, allThreads(doc))).catch(() => {});
  }, 300);
}

/** `.texwerk/chat.md`: the newest chat messages, for agents to read. */
let chatTimer: NodeJS.Timeout | null = null;
function scheduleChatFile(): void {
  if (chatTimer) return;
  chatTimer = setTimeout(() => {
    chatTimer = null;
    void writeFile(join(root, LOCAL_DIR, 'chat.md'), chatMarkdown(project, chatArray(doc).toArray())).catch(() => {});
  }, 300);
}

function watchStructure(): void {
  chatArray(doc).observe(() => scheduleChatFile());
  scheduleChatFile();
  doc.getMap('comments').observeDeep(() => scheduleCommentsFile());
  // Line numbers in the digest follow the text.
  doc.getMap('text').observeDeep(() => { if (doc.getMap('comments').size) scheduleCommentsFile(); });
  scheduleCommentsFile();
  texts.observe((event) => {
    for (const [key, change] of event.changes.keys) {
      if (change.action === 'delete' || change.action === 'update') {
        if (change.action === 'delete' && !texts.has(key) && !bins.has(key)) void removeLocal(key).then(() => log(`- ${key}`));
      }
      if (change.action === 'add' || change.action === 'update') {
        const ytext = texts.get(key)!;
        observeText(key, ytext);
        // A file created locally already has the right content on disk.
        if (shadow.get(key) !== ytext.toString()) scheduleSync(key, REMOTE_FLUSH_MS);
        if (change.action === 'add' && shadow.get(key) !== ytext.toString()) log(`+ ${key}`);
      }
    }
  });
  bins.observe((event) => {
    for (const [key, change] of event.changes.keys) {
      if (change.action === 'delete' && !texts.has(key) && !bins.has(key)) void removeLocal(key).then(() => log(`- ${key}`));
      else if (change.action !== 'delete') void syncBinaryDown(key, bins.get(key)!);
    }
  });
  dirs.observe((event) => {
    for (const [key, change] of event.changes.keys) {
      if (change.action === 'add') { if (folderIntact()) void mkdir(abs(key), { recursive: true }); }
      else if (change.action === 'delete') {
        // Only remove the folder if it is empty; its files are handled above.
        setTimeout(() => void readdir(abs(key)).then((e) => { if (!e.length) void rm(abs(key), { recursive: true }); }).catch(() => {}), 200);
      }
    }
  });
}

// ------------------------------------------------------------ disk -> remote

function scheduleLocal(rel: string, delay = LOCAL_DEBOUNCE_MS): void {
  const t = localTimers.get(rel);
  if (t) clearTimeout(t);
  localTimers.set(rel, setTimeout(() => { localTimers.delete(rel); void onLocalChange(rel); }, delay));
}

async function onLocalChange(rel: string): Promise<void> {
  if (!ready || ignored(rel) || !folderIntact()) return;
  let info;
  try { info = await stat(abs(rel)); } catch { info = null; }

  if (!info) {
    // Deleted locally. Our own removals echo here; skip those (only
    // removals — a file we just wrote and someone then deleted is a delete).
    const removed = selfRemoved.get(rel);
    if (removed && Date.now() - removed < 2000) return;
    if (texts.has(rel) || bins.has(rel) || dirs.has(rel)) queueDelete(rel);
    return;
  }
  if (info.isDirectory()) {
    if (!dirs.has(rel)) {
      try { await http('POST', '/api/fs', JSON.stringify({ op: 'mkdir', path: rel })); } catch { /* exists */ }
    }
    for (const e of await readdir(abs(rel))) scheduleLocal(`${rel}/${e}`);
    return;
  }
  if (!info.isFile()) return;
  const ytext = texts.get(rel);
  if (ytext) {
    const t = remoteTimers.get(rel);
    if (t) { clearTimeout(t); remoteTimers.delete(rel); }
    syncText(rel);
    return;
  }
  if (!bins.has(rel)) {
    // A file we have never seen: atomic savers create short-lived temp files
    // next to the real one. Upload only what is still there a moment later.
    const stamp = fileStamp(rel);
    await new Promise((r) => setTimeout(r, NEW_FILE_SETTLE_MS));
    if (fileStamp(rel) !== stamp || texts.has(rel)) { if (fileStamp(rel) !== 'missing') scheduleLocal(rel); return; }
  }
  const data = await readFile(abs(rel));
  const hash = sha(data);
  if (bins.has(rel) && (bins.get(rel)!.hash === hash || binHash.get(rel) === hash)) return;
  // A new file, or a changed binary: upload it whole.
  const touched = selfTouched.get(rel);
  if (touched && Date.now() - touched < 1000 && binHash.get(rel) === hash) return;
  try {
    if (isTextFile(rel, data)) setShadow(rel, data.toString('utf8'));
    else binHash.set(rel, hash);
    await http('PUT', '/api/file', data, { path: rel });
    log(`uploaded ${rel}`);
  } catch (err) {
    log(String((err as Error).message));
  }
}

// ------------------------------------------------------------ local deletions

const pendingDeletes = new Set<string>();
let deleteTimer: NodeJS.Timeout | null = null;

function queueDelete(rel: string): void {
  pendingDeletes.add(rel);
  if (deleteTimer) clearTimeout(deleteTimer);
  deleteTimer = setTimeout(() => { deleteTimer = null; void flushDeletes(); }, DELETE_QUIET_MS);
}

/**
 * Send the deletions collected since the last quiet moment — unless the
 * folder itself went away (stop), or they would delete most of the project
 * (refuse, and put the files back here from the replica). See isMassDeletion.
 */
async function flushDeletes(): Promise<void> {
  const batch = [...pendingDeletes].filter((p) => (texts.has(p) || bins.has(p) || dirs.has(p)) && !existsSync(abs(p)));
  pendingDeletes.clear();
  if (!batch.length || !folderIntact()) return;
  const files = [...texts.keys(), ...bins.keys()];
  const under = (p: string) => files.filter((f) => f === p || f.startsWith(`${p}/`));
  const doomed = new Set(batch.flatMap(under));
  if (isMassDeletion(doomed.size, files.length)) {
    log(`refusing to delete ${doomed.size} of ${files.length} files on the server at once — restored them here. Delete them in the browser if you mean it.`);
    for (const p of batch) await restoreLocal(p);
    return;
  }
  // A deleted folder takes its files with it: one request for the folder.
  for (const p of batch.filter((p) => !batch.some((q) => p.startsWith(`${q}/`)))) {
    try {
      await http('POST', '/api/fs', JSON.stringify({ op: 'delete', path: p }));
      log(`deleted ${p} on the server`);
    } catch (err) {
      log(`${(err as Error).message} — restored ${p} here`);
      await restoreLocal(p);
    }
  }
}

/** Write `rel` (a file, or a folder and everything in it) back from the replica. */
async function restoreLocal(rel: string): Promise<void> {
  const inside = (p: string) => p === rel || p.startsWith(`${rel}/`);
  for (const d of dirs.keys()) if (inside(d)) await mkdir(abs(d), { recursive: true });
  for (const [p, ytext] of texts) {
    if (!inside(p)) continue;
    const content = ytext.toString();
    if (writeTextSync(p, content)) setShadow(p, content);
  }
  for (const [p, info] of bins) {
    if (!inside(p)) continue;
    binHash.delete(p);
    await syncBinaryDown(p, info);
  }
}

/**
 * How long the agent's caret stays after its last edit. An agent that
 * finished its work should not leave a caret in everyone's editor; the next
 * edit brings it back.
 */
const CARET_IDLE_MS = Number(process.env.TEXWERK_CARET_IDLE_MS) || 20_000;
let caretTimer: NodeJS.Timeout | null = null;

/** Show the agent's caret where it last edited, so people can see it working. */
function pointCaretAt(path: string, ytext: Y.Text, edit: { at: number; insert: string }): void {
  const pos = Math.min(ytext.length, edit.at + edit.insert.length);
  const rel = Y.createRelativePositionFromTypeIndex(ytext, pos);
  awareness.setLocalStateField('file', path);
  awareness.setLocalStateField('cursor', { anchor: Y.relativePositionToJSON(rel), head: Y.relativePositionToJSON(rel) });
  if (caretTimer) clearTimeout(caretTimer);
  caretTimer = setTimeout(() => {
    caretTimer = null;
    // The agent stays in the presence list; only its caret goes.
    awareness.setLocalStateField('cursor', null);
    awareness.setLocalStateField('file', null);
  }, CARET_IDLE_MS);
  caretTimer.unref();
}

// ------------------------------------------------------------ initial sync

/**
 * First sync after (re)connecting. The server is authoritative, except for a
 * text file edited locally while this bridge was not running: if the server
 * still has what we last saw, the local edit is pushed; if both changed, the
 * server wins and the local copy is kept under `.texwerk/conflicts/`.
 */
async function initialSync(): Promise<void> {
  const markerPath = join(root, LOCAL_DIR, 'mirror.json');
  let marker: { project: string; origin: string; files: Record<string, string> } | null = null;
  try { marker = JSON.parse(await readFile(markerPath, 'utf8')); } catch { /* first run */ }
  if (marker && (marker.project !== project || marker.origin !== origin)) {
    process.stderr.write(`${root} mirrors "${marker.project}" from ${marker.origin}; pick another folder.\n`);
    process.exit(1);
  }
  const known = marker?.files ?? {};
  if (!folderIntact()) return;
  for (const d of dirs.keys()) await mkdir(abs(d), { recursive: true });
  for (const [path, ytext] of texts) {
    observeText(path, ytext);
    const remote = ytext.toString();
    let local: string | null = null;
    try { local = await readFile(abs(path), 'utf8'); } catch { local = null; }
    if (local !== null && local !== remote) {
      const lastSeen = known[path];
      // Never seen before but different: created on both sides while offline.
      const localChanged = lastSeen === undefined || sha(local) !== lastSeen;
      const remoteChanged = lastSeen === undefined || sha(remote) !== lastSeen;
      if (localChanged && !remoteChanged) {
        doc.transact(() => applyEditsToYText(ytext, editsBetween(remote, local!)), LOCAL);
        setShadow(path, local);
        log(`pushed offline edit to ${path}`);
        continue;
      }
      if (localChanged) {
        const saved = join(LOCAL_DIR, 'conflicts', `${path.replace(/\//g, '__')}.${Date.now()}`);
        await mkdir(dirname(join(root, saved)), { recursive: true });
        await writeFile(join(root, saved), local);
        log(`${path} changed here and on the server while offline — kept yours as ${saved}`);
      }
    }
    setShadow(path, remote);
    if (local !== remote) writeTextSync(path, remote);
  }
  for (const [path, info] of bins) await syncBinaryDown(path, info);
  // Local files the server does not have: new while offline → upload; deleted remotely → remove.
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (ignored(childRel) || e.name.startsWith('.texwerk-tmp-')) continue;
      if (e.isDirectory()) { await walk(join(dir, e.name), childRel); continue; }
      if (!e.isFile() || texts.has(childRel) || bins.has(childRel)) continue;
      if (known[childRel] !== undefined) { await removeLocal(childRel); log(`- ${childRel} (deleted on the server)`); }
      else await onLocalChange(childRel);
    }
  };
  ready = true;
  await walk(root, '');
  await saveMarker();
}

async function saveMarker(): Promise<void> {
  const files: Record<string, string> = {};
  // What each file was when disk and replica last agreed.
  for (const [p, t] of texts) files[p] = sha(shadow.get(p) ?? t.toString());
  for (const [p, b] of bins) files[p] = b.hash;
  await writeFile(join(root, LOCAL_DIR, 'mirror.json'), JSON.stringify({ project, origin, name: typedName ?? undefined, files }, null, 1));
}

// ------------------------------------------------------------ agent helpers

function agentGuide(): string {
  return `# Working in a live TeXWerk project

This folder is a live mirror of the TeXWerk project **${project}** on ${origin}.
Other people are editing the same files right now, in their browsers.

- Edit files normally and save. Each save reaches every collaborator within a
  fraction of a second, merged character by character with their typing.
  Your changes show up in the project history as "${me} · agent".
- Prefer small, targeted edits over rewriting whole files: a collaborator may
  be typing in the same file, and a rewrite of a region they are editing
  loses the intent of both.
- Re-read a file before editing it if some time has passed — it may have
  changed underneath you.
- New files and folders you create are added to the project; deleting a file
  deletes it for everyone (it stays restorable from the history). Deleting
  most of the project at once is refused and the files come back here.
- Never delete this folder while the mirror runs. Stop it first with
  \`node texwerk-connect.mjs --stop <this folder>\` (if the folder goes anyway,
  the mirror stops and the server keeps everything).
- Build products (*.aux, *.log, …) and anything under \`.texwerk/\` stay local.

## Comments

People (and agents) leave comments on ranges of text. They are not in the
.tex files: \`.texwerk/comments.md\` lists every thread — file, line, the
quoted text, and the conversation — and is kept current while this mirror
runs. Treat open comments as review feedback addressed to whoever works on
the text.

    node .texwerk/tw comments                         # open threads (--all for resolved too)
    node .texwerk/tw reply <id> "Done — shortened."   # answer in a thread
    node .texwerk/tw resolve <id>                     # when it is addressed (reopen <id> undoes)
    node .texwerk/tw comment <file> <line> "text"     # comment on a whole line
    node .texwerk/tw comment <file> <line> "text" --quote "exact words"   # on specific words near that line

When you address a comment, change the text, then reply saying what you did
and resolve it. Your comments and replies show as "${me} · agent".

## Chat

The project has a chat, next to the comments: people talk to each other and
to you there. \`.texwerk/chat.md\` holds the newest 200 messages (id, time,
author) and is kept current while this mirror runs. A message containing
**@agent** is addressed to you; so are @all and @everyone.

    node .texwerk/tw chat                      # the conversation (--since <id> for what came after it)
    node .texwerk/tw say "Done, see main.tex:42"
    node .texwerk/tw say "Fixed" --ref main.tex:42      # with a link to a line (or --ref comment:<id>)
    node .texwerk/tw chat --wait               # block until someone writes @agent, then print it
    node .texwerk/tw chat --wait --all         # … or until anyone (not an agent) writes anything

To work on instructions from the chat, loop: \`tw chat --wait\`, do what it
asks, answer with \`tw say\`, wait again. Your messages show as "${me} · agent".

## Compiling

The server compiles the project (latexmk). To compile and see the result:

    node .texwerk/tw compile      # compile now; prints errors and warnings
    node .texwerk/tw log          # the full log of the last compile
    node .texwerk/tw status       # main file, last result

After every compile (yours or anyone's) the PDF is written to
\`.texwerk/output.pdf\` and the log to \`.texwerk/output.log\`.
Don't run latexmk in this folder yourself unless you need to; the server's
compile is what everyone sees.
`;
}

const TW_SCRIPT = `#!/usr/bin/env node
// TeXWerk helper for agents: compile on the server and report.
const cfg = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'mirror.json'), 'utf8'));
const name = cfg.name ? '&name=' + encodeURIComponent(cfg.name) : '';
const base = cfg.origin + '/api/compile?project=' + encodeURIComponent(cfg.project) + name;
const cmd = process.argv[2] || 'compile';
const args = process.argv.slice(3);
const commentsUrl = cfg.origin + '/api/comments?project=' + encodeURIComponent(cfg.project) + name;
const chatUrl = cfg.origin + '/api/chat?project=' + encodeURIComponent(cfg.project) + name;
const stamp = (ts) => new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
const line = (m) => '[' + m.id + '] ' + stamp(m.ts) + ' ' + m.author + ': ' + m.text.split('\\n').join('\\n    ')
  + (m.ref ? ' [→ ' + (m.ref.commentId ? 'comment ' + m.ref.commentId : m.ref.file + ':' + m.ref.line) + ']' : '');
const getChat = async (since, wait) => {
  const r = await fetch(chatUrl + (since ? '&since=' + encodeURIComponent(since) : '') + (wait ? '&wait=1' : ''), { headers: { 'x-texwerk-bridge': '1' } });
  const j = await r.json();
  if (!r.ok) { console.error(j.error); process.exit(1); }
  return j.messages;
};
const opt = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const post = async (body) => {
  const r = await fetch(commentsUrl, { method: 'POST', headers: { 'x-texwerk-bridge': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) { console.error(j.error); process.exit(1); }
  return j;
};
const show = (c) => {
  const errors = c.issues.filter((i) => i.level === 'error');
  const warnings = c.issues.filter((i) => i.level === 'warning');
  console.log((c.ok ? 'OK' : 'FAILED') + ' — ' + c.mainFile + ': ' + errors.length + ' error(s), ' + warnings.length + ' warning(s)' + (c.hasPdf ? '' : ', no PDF'));
  for (const i of [...errors, ...warnings]) console.log((i.level === 'error' ? 'error  ' : 'warning') + '  ' + (i.file ? i.file + (i.line ? ':' + i.line : '') + '  ' : '') + i.message);
};
(async () => {
  const headers = { 'x-texwerk-bridge': '1' };
  if (cmd === 'comments') {
    const r = await fetch(commentsUrl, { headers });
    const j = await r.json();
    if (!r.ok) { console.error(j.error); process.exit(1); }
    const list = j.threads.filter((t) => args.includes('--all') || !t.resolved);
    if (!list.length) console.log(args.includes('--all') ? 'No comments.' : 'No open comments.');
    for (const t of list) {
      console.log('[' + t.id + '] ' + (t.line ? t.path + ':' + t.line : t.path + ' (text deleted)') + (t.resolved ? '  (resolved)' : ''));
      console.log('  > ' + t.quote.split('\\n').join('\\n  > '));
      for (const m of t.messages) console.log('  ' + m.author + ': ' + m.text.split('\\n').join('\\n    '));
      console.log('');
    }
    return;
  }
  if (cmd === 'reply' || cmd === 'resolve' || cmd === 'reopen') {
    if (!args[0] || (cmd === 'reply' && !args[1])) { console.error('usage: tw ' + cmd + ' <id>' + (cmd === 'reply' ? ' "text"' : '')); process.exit(2); }
    await post({ op: cmd, id: args[0], text: args[1] });
    console.log('ok');
    return;
  }
  if (cmd === 'comment') {
    const qi = args.indexOf('--quote');
    const quote = qi >= 0 ? args[qi + 1] : undefined;
    const rest = qi >= 0 ? args.slice(0, qi).concat(args.slice(qi + 2)) : args;
    const [file, line, text] = rest;
    if (!file || !line || !text) { console.error('usage: tw comment <file> <line> "text" [--quote "exact words"]'); process.exit(2); }
    const j = await post({ op: 'create', path: file, line: Number(line), quote, text });
    console.log('created ' + j.id);
    return;
  }
  if (cmd === 'chat' && args.includes('--wait')) {
    // Waits for a message by a person that mentions @agent (@all, @everyone),
    // or with --all for any message by a person.
    let since = opt('--since');
    if (!since) { const all = await getChat(); since = all.length ? all[all.length - 1].id : undefined; }
    for (;;) {
      const list = since ? await getChat(since, true) : await getChat();
      if (!since && !list.length) { await new Promise((r) => setTimeout(r, 2000)); continue; }
      if (list.length) since = list[list.length - 1].id;
      const hits = list.filter((m) => !m.agent && (args.includes('--all') || m.mentions.some((x) => x === 'agent' || x === 'all' || x === 'everyone')));
      if (hits.length) { for (const m of hits) console.log(line(m)); return; }
    }
  }
  if (cmd === 'chat') {
    const list = await getChat(opt('--since'));
    if (!list.length) console.log('No messages.');
    for (const m of list) console.log(line(m));
    return;
  }
  if (cmd === 'say') {
    const ref = opt('--ref');
    const ri = args.indexOf('--ref');
    const text = (ri >= 0 ? args.slice(0, ri).concat(args.slice(ri + 2)) : args).join(' ');
    if (!text) { console.error('usage: tw say "text" [--ref file:line | --ref comment:<id>]'); process.exit(2); }
    const r = await fetch(chatUrl, { method: 'POST', headers: { 'x-texwerk-bridge': '1', 'content-type': 'application/json' }, body: JSON.stringify({ text, ref }) });
    const j = await r.json();
    if (!r.ok) { console.error(j.error); process.exit(1); }
    console.log('sent ' + j.message.id);
    return;
  }
  if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    console.log([
      'node .texwerk/tw compile | log | status',
      'node .texwerk/tw comments [--all] | comment <file> <line> "text" [--quote "words"] | reply <id> "text" | resolve <id> | reopen <id>',
      'node .texwerk/tw chat [--since <id>]          print the chat',
      'node .texwerk/tw chat --wait [--all]          wait for the next message to @agent (--all: any message by a person)',
      'node .texwerk/tw say "text" [--ref file:line | --ref comment:<id>]',
    ].join('\\n'));
    return;
  }
  if (cmd === 'compile') {
    const r = await fetch(base + '&wait=1', { method: 'POST', headers });
    const j = await r.json();
    if (!r.ok) { console.error(j.error); process.exit(1); }
    show(j.compile);
    process.exit(j.compile.ok ? 0 : 1);
  }
  const r = await fetch(base, { headers });
  const j = await r.json();
  if (cmd === 'log') console.log(j.log || j.output);
  else show(j.compile);
})().catch((e) => { console.error(e.message); process.exit(1); });
`;

async function writeHelpers(): Promise<void> {
  if (!folderIntact()) return;
  const dir = join(root, LOCAL_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'AGENT.md'), agentGuide());
  await writeFile(join(dir, 'tw'), TW_SCRIPT);
  await writeFile(join(dir, 'package.json'), '{"type":"commonjs"}\n');
  await chmod(join(dir, 'tw'), 0o755);
}

async function onCompile(c: CompileSummary): Promise<void> {
  if (c.state !== 'done') return;
  const errors = c.issues.filter((i) => i.level === 'error').length;
  log(`compiled (${c.by}): ${c.ok ? 'ok' : `${errors} error(s)`}`);
  try {
    if (c.hasPdf) {
      const pdf = await fetch(`${origin}/pdf/${encodeURIComponent(project)}/output.pdf?${typedName ? `name=${encodeURIComponent(typedName)}` : ''}`, { headers: { [BRIDGE_HEADER]: '1' } });
      if (pdf.ok) await writeFile(join(root, LOCAL_DIR, 'output.pdf'), new Uint8Array(await pdf.arrayBuffer()));
    }
    const res = await http('GET', '/api/compile');
    const j = await res.json() as { log: string; output: string };
    await writeFile(join(root, LOCAL_DIR, 'output.log'), j.log || j.output || '');
  } catch { /* best effort */ }
}

// ------------------------------------------------------------ main

async function main(): Promise<void> {
  await mkdir(join(root, LOCAL_DIR), { recursive: true });
  const other = lockHolder(root);
  if (other !== null && other !== process.pid) {
    process.stderr.write(`another texwerk-connect (pid ${other}) is already mirroring into ${root}; stop it with: node texwerk-connect.mjs --stop ${root}\n`);
    process.exit(1);
  }
  const lockPath = join(root, LOCAL_DIR, LOCK_FILE);
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, project, origin }));
  folderId = currentFolderId();
  process.on('exit', () => {
    try { if (lockHolder(root) === process.pid) unlinkSync(lockPath); } catch { /* folder gone */ }
  });
  log(`mirroring "${project}" from ${origin} into ${root}`);
  startSession();
  watchTree(root, (rel) => scheduleLocal(rel), (rel) => ignored(rel) || rel.split('/').pop()!.startsWith('.texwerk-tmp-'));
  // Also notice a deleted folder when nothing else happens.
  setInterval(() => { folderIntact(); }, 1000);
  setInterval(() => { if (ready && folderIntact()) void saveMarker(); }, 10_000);
  const stop = () => { void (ready && folderIntact() ? saveMarker() : Promise.resolve()).finally(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function sessionUrl(): string {
  const wsUrl = new URL(`/ws?${query({ bridge: '1' })}`, origin);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return wsUrl.href;
}

function startSession(): void {
  let firstSync = true;
  const provider: Provider = new Provider({
    url: sessionUrl(),
    doc,
    awareness,
    onStatus: (status, detail) => {
      if (status !== 'connected') online = false;
      if (status === 'disconnected') log(`disconnected${detail ? `: ${detail}` : ''} — reconnecting`);
    },
    onEvent: (event: ServerEvent) => {
      if (event.t === 'hello') {
        me = event.you.name;
        awareness.setLocalStateField('user', { name: `${me} · agent`, color: colorFor(`${event.you.login}:agent`), colorLight: `${colorFor(`${event.you.login}:agent`)}33`, agent: true });
        void writeHelpers();
      } else if (event.t === 'compile') {
        void onCompile(event.compile);
      } else if (event.t === 'moved' && event.to !== project) {
        // Renamed on the server: follow it. The folder here keeps its name;
        // mirror.json (which `tw` reads) and AGENT.md take the new one.
        log(`the project was renamed to "${event.to}"`);
        project = event.to;
        provider.setUrl(sessionUrl());
        if (ready) void saveMarker();
        void writeHelpers();
      }
    },
    onReset: () => void resetSession(),
    onSynced: () => {
      online = true;
      if (!firstSync) {
        log('reconnected');
        // Saves made while offline: pick them up now.
        void rescanLocal();
        return;
      }
      firstSync = false;
      void initialSync().then(async () => {
        watchStructure();
        // Anything that changed remotely while the first sync was running.
        for (const [path, ytext] of texts) if (shadow.get(path) !== ytext.toString()) syncText(path);
        for (const [path, info] of bins) await syncBinaryDown(path, info);
        log(`in sync: ${texts.size} text file(s), ${bins.size} other file(s)`);
        log(`agents: see ${join(root, LOCAL_DIR, 'AGENT.md')} — compile with: node .texwerk/tw compile`);
        log('watching for changes — Ctrl+C to stop');
      });
    },
  });
}

/** Look at every local file again, as if each had just been saved. */
async function rescanLocal(): Promise<void> {
  for (const path of texts.keys()) syncText(path);
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (ignored(childRel) || e.name.startsWith('.texwerk-tmp-')) continue;
      if (e.isDirectory()) await walk(join(dir, e.name), childRel);
      else if (!texts.has(childRel)) scheduleLocal(childRel);
    }
  };
  await walk(root, '');
  for (const p of [...texts.keys(), ...bins.keys()]) if (!existsSync(abs(p))) scheduleLocal(p);
}

/**
 * The server reloaded the project (it restarted). Our replica belongs to the
 * old document and must not be merged into the new one. Record what we knew,
 * start over with an empty replica, and let the first sync reconcile the
 * folder against the server file by file — local edits not yet sent are
 * pushed, exactly as after running offline.
 */
async function resetSession(): Promise<void> {
  log('the server restarted — re-syncing');
  ready = false;
  online = false;
  await saveMarker();
  for (const t of [...remoteTimers.values(), ...localTimers.values()]) clearTimeout(t);
  remoteTimers.clear();
  localTimers.clear();
  histories.clear();
  shadow.clear();
  doc.destroy();
  doc = new Y.Doc({ gc: false });
  texts = doc.getMap<Y.Text>('text');
  bins = doc.getMap<BinInfo>('bin');
  dirs = doc.getMap<boolean>('dirs');
  awareness = new Awareness(doc);
  startSession();
}

void main();
