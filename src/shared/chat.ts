import * as Y from 'yjs';

/**
 * The project chat, shared by the server, the browser and the mirror bridge.
 *
 * Messages live in the project's Y.Doc (`chat`: a Y.Array, oldest first), so
 * everyone sees them live. Like comments, only the server writes it (clients
 * go through /api/chat), which lets view-only people and agents chat too.
 * The server saves it to `.texwerk/chat.jsonl`, one message per line, and
 * that file is committed with every labelled version.
 */

export type ChatRef = { file: string; line: number } | { commentId: string };

export interface ChatMessage {
  id: string;
  /** Display name; "… · agent" for agents. */
  author: string;
  /** Tailnet login (or typed name) of the person, when known. */
  login?: string;
  agent: boolean;
  ts: number;
  text: string;
  /** Lower-cased names mentioned with @: people, "agent", "all", "everyone". */
  mentions: string[];
  ref?: ChatRef;
}

/** Words that mention more than one person. */
export const BROADCAST_MENTIONS = ['all', 'everyone'];

export function chatArray(doc: Y.Doc): Y.Array<ChatMessage> {
  return doc.getArray<ChatMessage>('chat');
}

/**
 * Who `text` mentions: every name in `names` written as "@name" (longest
 * first, so "@Ann Lee" beats "@Ann"), plus @agent, @all and @everyone.
 */
export function findMentions(text: string, names: string[]): string[] {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  const ends = (at: number) => at >= lower.length || !/[\p{L}\p{N}_]/u.test(lower[at]);
  /** Where a longer name already matched: "@Ann Lee" is not also "@Ann". */
  const taken = new Set<number>();
  for (const name of [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))].sort((a, b) => b.length - a.length)) {
    for (let i = lower.indexOf(`@${name}`); i >= 0; i = lower.indexOf(`@${name}`, i + 1)) {
      if (!taken.has(i) && ends(i + name.length + 1)) { found.add(name); taken.add(i); }
    }
  }
  for (const m of lower.matchAll(/@(agent|all|everyone)(?![\p{L}\p{N}_])/gu)) found.add(m[1]);
  return [...found];
}

/** Whether a message is addressed to `name` (directly or with @all/@everyone). */
export function mentionsName(m: ChatMessage, name: string): boolean {
  const n = name.trim().toLowerCase();
  return m.mentions.some((x) => x === n || BROADCAST_MENTIONS.includes(x));
}

/** "main.tex:12" or "comment:ab12cd34" → a ref; null if it is neither. */
export function parseRef(s: string): ChatRef | null {
  const c = /^(?:comment:|#)([\w-]+)$/.exec(s.trim());
  if (c) return { commentId: c[1] };
  const f = /^(.+):(\d+)$/.exec(s.trim());
  if (f && Number(f[2]) > 0) return { file: f[1], line: Number(f[2]) };
  return null;
}

export function refLabel(ref: ChatRef): string {
  return 'commentId' in ref ? `comment ${ref.commentId}` : `${ref.file}:${ref.line}`;
}

/** A stored message, checked and normalised; null if it is not one. */
export function cleanMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id || typeof r.text !== 'string') return null;
  const m: ChatMessage = {
    id: r.id,
    author: String(r.author ?? ''),
    agent: Boolean(r.agent),
    ts: Number(r.ts) || 0,
    text: r.text,
    mentions: Array.isArray(r.mentions) ? r.mentions.map(String) : [],
  };
  if (typeof r.login === 'string' && r.login) m.login = r.login;
  const ref = r.ref as Record<string, unknown> | undefined;
  if (ref && typeof ref.commentId === 'string') m.ref = { commentId: ref.commentId };
  else if (ref && typeof ref.file === 'string' && Number(ref.line) > 0) m.ref = { file: ref.file, line: Number(ref.line) };
  return m;
}

export function toJsonl(messages: ChatMessage[]): string {
  return messages.map((m) => `${JSON.stringify(m)}\n`).join('');
}

/** Lines that do not parse (a torn write, a merge conflict marker) are skipped. */
export function fromJsonl(text: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = cleanMessage(JSON.parse(line));
      if (m) out.push(m);
    } catch { /* skip */ }
  }
  return out;
}

/** Messages after the one with id `since` (all of them if it is unknown or absent). */
export function messagesSince(messages: ChatMessage[], since?: string | null): ChatMessage[] {
  if (!since) return messages;
  const i = messages.findIndex((m) => m.id === since);
  return i < 0 ? messages : messages.slice(i + 1);
}

const stamp = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace('T', ' ');

/** One message as a line (or a few) of text, for `tw chat` and chat.md. */
export function formatChatLine(m: ChatMessage): string {
  const ref = m.ref ? ` [→ ${refLabel(m.ref)}]` : '';
  return `[${m.id}] ${stamp(m.ts)} ${m.author}: ${m.text.replace(/\n/g, '\n    ')}${ref}`;
}

/** `.texwerk/chat.md`: the newest messages, for agents to read. */
export function chatMarkdown(project: string, messages: ChatMessage[], limit = 200): string {
  const shown = messages.slice(-limit);
  const lines = [`# Chat in ${project}`, ''];
  lines.push(`${messages.length} message(s)${messages.length > shown.length ? `, the newest ${shown.length} shown` : ''}, oldest first (times UTC).`
    + ' Answer with `node .texwerk/tw say "text"`; wait for the next message to you with `node .texwerk/tw chat --wait`.', '');
  for (const m of shown) lines.push(`- ${formatChatLine(m).replace(/\n {4}/g, '\n  ')}`);
  return `${lines.join('\n')}\n`;
}
