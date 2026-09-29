import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { colorFor, isBuildArtifact, isEditorTempFile, isTextFile } from '../shared/files.ts';
import { Provider } from '../shared/provider.ts';
import { BRIDGE_HEADER, type BinInfo, type CompileSummary, type ServerEvent } from '../shared/protocol.ts';
import { applyEditsToYText, editsBetween } from '../shared/textDiff.ts';
import { watchTree } from '../shared/watchTree.ts';

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
 *  - new, deleted and renamed files travel both ways.
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
const LOCAL_DIR = '.texwerk';

function sha(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 40);
}

function usage(): never {
  process.stderr.write('usage: node texwerk-connect.mjs \'<server>/?project=<name>\' [folder]\n');
  process.exit(2);
}

const [, , sessionArg, folderArg] = process.argv;
if (!sessionArg || sessionArg === '-h' || sessionArg === '--help') usage();
const session = new URL(sessionArg);
const projectParam = session.searchParams.get('project');
if (!projectParam) usage();
const project: string = projectParam;
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

function watchStructure(): void {
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
      if (change.action === 'add') void mkdir(abs(key), { recursive: true });
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
  if (!ready || ignored(rel)) return;
  let info;
  try { info = await stat(abs(rel)); } catch { info = null; }

  if (!info) {
    // Deleted locally. Our own removals echo here; skip those (only
    // removals — a file we just wrote and someone then deleted is a delete).
    const removed = selfRemoved.get(rel);
    if (removed && Date.now() - removed < 2000) return;
    if (texts.has(rel) || bins.has(rel) || dirs.has(rel)) {
      try {
        await http('POST', '/api/fs', JSON.stringify({ op: 'delete', path: rel }));
        log(`deleted ${rel} on the server`);
      } catch (err) { log(String((err as Error).message)); }
    }
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

/** Show the agent's caret where it last edited, so people can see it working. */
function pointCaretAt(path: string, ytext: Y.Text, edit: { at: number; insert: string }): void {
  const pos = Math.min(ytext.length, edit.at + edit.insert.length);
  const rel = Y.createRelativePositionFromTypeIndex(ytext, pos);
  awareness.setLocalStateField('file', path);
  awareness.setLocalStateField('cursor', { anchor: Y.relativePositionToJSON(rel), head: Y.relativePositionToJSON(rel) });
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
  deletes it for everyone (it stays restorable from the history).
- Build products (*.aux, *.log, …) and anything under \`.texwerk/\` stay local.

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
const show = (c) => {
  const errors = c.issues.filter((i) => i.level === 'error');
  const warnings = c.issues.filter((i) => i.level === 'warning');
  console.log((c.ok ? 'OK' : 'FAILED') + ' — ' + c.mainFile + ': ' + errors.length + ' error(s), ' + warnings.length + ' warning(s)' + (c.hasPdf ? '' : ', no PDF'));
  for (const i of [...errors, ...warnings]) console.log((i.level === 'error' ? 'error  ' : 'warning') + '  ' + (i.file ? i.file + (i.line ? ':' + i.line : '') + '  ' : '') + i.message);
};
(async () => {
  const headers = { 'x-texwerk-bridge': '1' };
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
  log(`mirroring "${project}" from ${origin} into ${root}`);
  startSession();
  watchTree(root, (rel) => scheduleLocal(rel), (rel) => ignored(rel) || rel.split('/').pop()!.startsWith('.texwerk-tmp-'));
  setInterval(() => { if (ready) void saveMarker(); }, 10_000);
  const stop = () => { void saveMarker().finally(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function startSession(): void {
  const wsUrl = new URL(`/ws?${query({ bridge: '1' })}`, origin);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  let firstSync = true;
  new Provider({
    url: wsUrl.href,
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
