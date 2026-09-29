import diff from 'fast-diff';
import type * as Y from 'yjs';

/**
 * Whole-file saves meet character-level collaboration here.
 *
 * Anything that replaces a document wholesale — a file saved in a local
 * editor, an agent's write, a restore from history, a git pull — is turned
 * into the minimal insert/delete edits against a Y.Text. Collaborators typing
 * elsewhere in the same file keep their work and their carets.
 */

export interface Edit {
  /** Position in the old text. */
  at: number;
  remove: number;
  insert: string;
}

export function editsBetween(before: string, after: string): Edit[] {
  if (before === after) return [];
  const edits: Edit[] = [];
  let at = 0;
  for (const [kind, text] of diff(before, after)) {
    if (kind === diff.EQUAL) {
      at += text.length;
    } else if (kind === diff.DELETE) {
      const last = edits[edits.length - 1];
      if (last && last.at + last.remove === at && last.insert === '') last.remove += text.length;
      else edits.push({ at, remove: text.length, insert: '' });
      at += text.length;
    } else {
      const last = edits[edits.length - 1];
      if (last && last.at + last.remove === at) last.insert += text;
      else edits.push({ at, remove: 0, insert: text });
    }
  }
  return edits;
}

/** Apply edits expressed in old-text coordinates, back to front. */
export function applyEditsToYText(ytext: Y.Text, edits: Edit[]): void {
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
    if (e.remove) ytext.delete(e.at, e.remove);
    if (e.insert) ytext.insert(e.at, e.insert);
  }
}

/** Make `ytext` read `target` with the fewest edits. Call inside a transaction. */
export function setYText(ytext: Y.Text, target: string): Edit[] {
  const edits = editsBetween(ytext.toString(), target);
  applyEditsToYText(ytext, edits);
  return edits;
}
