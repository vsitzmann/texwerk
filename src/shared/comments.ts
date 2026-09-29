import * as Y from 'yjs';

/**
 * Comment threads, shared by the server, the browser and the mirror bridge.
 *
 * Threads live in the project's Y.Doc (`comments`: id -> Y.Map), so every
 * participant sees them live. Each is anchored to a range of one text file by
 * two Yjs relative positions, which stay attached to the same characters
 * while people type around them. Only the server writes this map (clients
 * go through /api/comments), which is also what lets view-only people and
 * agents comment.
 *
 * Nothing is ever written into the .tex files: the server saves threads to
 * `.texwerk/comments.json` (absolute offsets plus the quoted text, since
 * relative positions do not survive a server restart), and that file is
 * committed with every labelled version.
 */

export interface CommentMessage {
  id: string;
  author: string;
  login: string;
  ts: number;
  text: string;
  edited?: number;
}

/** A thread as stored in comments.json and returned by GET /api/comments. */
export interface CommentThread {
  id: string;
  path: string;
  /** Offsets into the file; null once the commented text is gone. */
  from: number | null;
  to: number | null;
  /** 1-based line of `from`, for people and agents. */
  line: number | null;
  quote: string;
  author: string;
  login: string;
  createdAt: number;
  resolved: boolean;
  resolvedBy?: string;
  resolvedAt?: number;
  messages: CommentMessage[];
}

/** Field names inside a thread's Y.Map. */
export type ThreadMap = Y.Map<unknown>;

export function threadFromY(id: string, t: ThreadMap, doc: Y.Doc): CommentThread {
  const path = String(t.get('path') ?? '');
  const ytext = doc.getMap<Y.Text>('text').get(path);
  let from: number | null = null;
  let to: number | null = null;
  const resolve = (json: unknown) => {
    if (!json || !ytext) return null;
    try {
      const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), doc);
      return abs && abs.type === ytext ? abs.index : null;
    } catch {
      return null;
    }
  };
  from = resolve(t.get('start'));
  to = resolve(t.get('end'));
  // The whole range deleted: both ends collapse onto one point.
  if (from === null || to === null || to <= from) { from = null; to = null; }
  let line: number | null = null;
  if (from !== null && ytext) {
    const text = ytext.toString();
    line = 1;
    for (let i = 0; i < from; i++) if (text.charCodeAt(i) === 10) line++;
  }
  const messages = t.get('messages') as Y.Array<CommentMessage> | undefined;
  return {
    id,
    path,
    from,
    to,
    line,
    quote: String(t.get('quote') ?? ''),
    author: String(t.get('author') ?? ''),
    login: String(t.get('login') ?? ''),
    createdAt: Number(t.get('createdAt') ?? 0),
    resolved: Boolean(t.get('resolved')),
    resolvedBy: (t.get('resolvedBy') as string | undefined) ?? undefined,
    resolvedAt: (t.get('resolvedAt') as number | undefined) ?? undefined,
    messages: messages ? messages.toArray() : [],
  };
}

export function allThreads(doc: Y.Doc): CommentThread[] {
  const out: CommentThread[] = [];
  for (const [id, t] of doc.getMap<ThreadMap>('comments')) out.push(threadFromY(id, t, doc));
  return out;
}

/** Open threads first (in document order), resolved ones after, newest first. */
export function sortThreads(threads: CommentThread[]): CommentThread[] {
  return [...threads].sort((a, b) => {
    if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
    if (a.resolved) return (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0);
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return (a.from ?? Infinity) - (b.from ?? Infinity);
  });
}

/** A readable digest of all threads, for agents and the zip download. */
export function commentsMarkdown(project: string, threads: CommentThread[]): string {
  const lines = [`# Comments on ${project}`, ''];
  const open = sortThreads(threads).filter((t) => !t.resolved);
  const resolved = sortThreads(threads).filter((t) => t.resolved);
  lines.push(`${open.length} open, ${resolved.length} resolved. Ids work with \`node .texwerk/tw reply|resolve <id>\`.`, '');
  for (const [title, list] of [['Open', open], ['Resolved', resolved]] as const) {
    if (!list.length) continue;
    lines.push(`## ${title}`, '');
    for (const t of list) {
      const where = t.line !== null ? `${t.path}:${t.line}` : `${t.path} (commented text was deleted)`;
      lines.push(`### [${t.id}] ${where}${t.resolved ? ` — resolved by ${t.resolvedBy ?? '?'}` : ''}`, '');
      lines.push(...t.quote.split('\n').map((l) => `> ${l}`), '');
      for (const m of t.messages) lines.push(`- **${m.author}** (${new Date(m.ts).toISOString().slice(0, 16).replace('T', ' ')}): ${m.text.replace(/\n/g, '\n  ')}`);
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}
