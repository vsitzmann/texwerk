import type * as Y from 'yjs';
import type { AuthorInfo } from './protocol.ts';

/**
 * Who wrote what: every run of characters in a Y.Text remembers the client
 * that inserted it, and `authors` names the client. This walks the text and
 * returns it as runs of (author, text), neighbours by the same author merged.
 */
export interface AuthorRun {
  from: number;
  to: number;
  text: string;
  author: string;
  login: string;
  color: string;
  agent: boolean;
}

interface ItemLike {
  deleted: boolean;
  countable: boolean;
  length: number;
  id: { client: number };
  content: { str?: string };
  right: ItemLike | null;
}

export function authorRuns(ytext: Y.Text, authors: Y.Map<AuthorInfo>): AuthorRun[] {
  const runs: AuthorRun[] = [];
  let at = 0;
  let item = (ytext as unknown as { _start: ItemLike | null })._start;
  while (item) {
    if (!item.deleted && item.countable) {
      const info = authors.get(String(item.id.client));
      const author = info?.name ?? 'unknown';
      const text = typeof item.content.str === 'string' ? item.content.str : ''.padEnd(item.length, '￼');
      const last = runs[runs.length - 1];
      if (last && last.author === author && last.to === at) {
        last.to += item.length;
        last.text += text;
      } else {
        runs.push({ from: at, to: at + item.length, text, author, login: info?.login ?? '', color: info?.color ?? '#565f89', agent: Boolean(info?.agent) });
      }
      at += item.length;
    }
    item = item.right;
  }
  return runs;
}
