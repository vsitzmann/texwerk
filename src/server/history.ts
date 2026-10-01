import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { HistoryEntry } from '../shared/protocol.ts';

/**
 * Full edit history, Overleaf-style.
 *
 * Every version of every file is kept as a content-addressed gzip blob under
 * `.texwerk/history/blobs`, and `.texwerk/history/log.jsonl` records one line
 * per change: which file, which content, who. Typing is coalesced — a file's
 * pending edits become one entry after it has been quiet for IDLE_MS or has
 * been changing for MAX_SPAN_MS — so the log reads as a list of meaningful
 * steps rather than keystrokes. The browser groups consecutive entries into
 * the change list it shows.
 *
 * The log is independent of git: labels are git commits that point back into
 * it (see git.ts), but history exists whether or not anyone ever labels.
 */

const IDLE_MS = 5_000;
const MAX_SPAN_MS = 60_000;

interface Pending {
  authors: Set<string>;
  first: number;
  last: number;
}

export function hashBytes(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 40);
}

export class History {
  private readonly dir: string;
  private entries: HistoryEntry[] = [];
  private readonly lastHash = new Map<string, string | null>();
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private writeChain: Promise<void> = Promise.resolve();
  /** Current content of a file (Y.Text or disk), or null when it is gone. */
  private readonly readCurrent: (path: string) => Promise<{ data: Buffer; binary: boolean } | null>;
  onAppend: (() => void) | null = null;

  constructor(projectDir: string, readCurrent: (path: string) => Promise<{ data: Buffer; binary: boolean } | null>) {
    this.dir = join(projectDir, '.texwerk', 'history');
    this.readCurrent = readCurrent;
  }

  async load(): Promise<void> {
    await mkdir(join(this.dir, 'blobs'), { recursive: true });
    const logPath = join(this.dir, 'log.jsonl');
    if (!existsSync(logPath)) return;
    const raw = await readFile(logPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as HistoryEntry;
        this.entries.push(entry);
        this.lastHash.set(entry.path, entry.op === 'delete' ? null : entry.hash ?? null);
        this.nextId = Math.max(this.nextId, entry.id + 1);
      } catch {
        // A torn last line from a crash: skip it, keep the rest.
      }
    }
  }

  all(): HistoryEntry[] {
    return this.entries;
  }

  lastId(): number {
    return this.nextId - 1;
  }

  knownHash(path: string): string | null | undefined {
    return this.lastHash.get(path);
  }

  /** Someone changed `path`; record it once it settles. */
  touch(path: string, author: string): void {
    const now = Date.now();
    const p = this.pending.get(path);
    if (p) {
      p.authors.add(author);
      p.last = now;
    } else {
      this.pending.set(path, { authors: new Set([author]), first: now, last: now });
    }
  }

  private flushChain: Promise<void> = Promise.resolve();

  /**
   * Called periodically; `force` records everything pending (labels,
   * shutdown). Flushes run one after another, so a forced one at close also
   * waits for a periodic one still writing — nothing lands after the project
   * is closed (and its folder possibly renamed).
   */
  flush(force = false): Promise<void> {
    const run = this.flushChain.then(() => this.flushDue(force));
    this.flushChain = run.catch(() => {});
    return run;
  }

  private async flushDue(force: boolean): Promise<void> {
    const now = Date.now();
    const due: Array<[string, Pending]> = [];
    for (const [path, p] of this.pending) {
      if (force || now - p.last >= IDLE_MS || now - p.first >= MAX_SPAN_MS) due.push([path, p]);
    }
    for (const [path] of due) this.pending.delete(path);
    for (const [path, p] of due) {
      await this.snapshot(path, [...p.authors], 'edit');
    }
  }

  /** Record pending edits to one file now (before it is deleted or moved). */
  async flushPath(path: string, author: string): Promise<void> {
    const p = this.pending.get(path);
    this.pending.delete(path);
    await this.snapshot(path, p ? [...p.authors] : [author], 'edit');
  }

  /**
   * Record the current state of `path` right now (uploads, deletes, renames,
   * restores). A no-op when the content is what the log already has.
   */
  async snapshot(path: string, authors: string[], op: HistoryEntry['op']): Promise<HistoryEntry | null> {
    const current = await this.readCurrent(path);
    const known = this.lastHash.get(path);
    if (!current) {
      if (known === undefined || known === null) return null;
      return this.append({ path, op: 'delete', authors });
    }
    const hash = hashBytes(current.data);
    if (known === hash) return null;
    await this.storeBlob(hash, current.data);
    const kind = known === undefined || known === null ? 'add' : op;
    return this.append({ path, op: kind, hash, binary: current.binary || undefined, authors });
  }

  private async append(partial: Omit<HistoryEntry, 'id' | 'ts'>): Promise<HistoryEntry> {
    const entry: HistoryEntry = { id: this.nextId++, ts: Date.now(), ...partial };
    this.entries.push(entry);
    this.lastHash.set(entry.path, entry.op === 'delete' ? null : entry.hash ?? null);
    const line = `${JSON.stringify(entry)}\n`;
    this.writeChain = this.writeChain.then(() => appendFile(join(this.dir, 'log.jsonl'), line));
    await this.writeChain;
    this.onAppend?.();
    return entry;
  }

  private blobPath(hash: string): string {
    return join(this.dir, 'blobs', hash.slice(0, 2), hash.slice(2));
  }

  private async storeBlob(hash: string, data: Buffer): Promise<void> {
    const path = this.blobPath(hash);
    if (existsSync(path)) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, gzipSync(data));
  }

  async readBlob(hash: string): Promise<Buffer | null> {
    if (!/^[0-9a-f]{40}$/.test(hash)) return null;
    try {
      return gunzipSync(await readFile(this.blobPath(hash)));
    } catch {
      return null;
    }
  }

  /** Every file's state as of history entry `id`: path -> entry (deletions omitted). */
  stateAt(id: number): Map<string, HistoryEntry> {
    const state = new Map<string, HistoryEntry>();
    for (const entry of this.entries) {
      if (entry.id > id) break;
      if (entry.op === 'delete') state.delete(entry.path);
      else state.set(entry.path, entry);
    }
    return state;
  }
}
