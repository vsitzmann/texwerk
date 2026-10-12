/**
 * BibTeX entries for citation completion: a small parser that keeps the raw
 * entry, and a fuzzy search over key, authors, title, year and venue that
 * says which field matched and where.
 *
 * Plain functions without DOM or CodeMirror, so they run (and are tested) in
 * Node too.
 */

export interface BibEntry {
  key: string;
  /** article, inproceedings, …; empty for a \bibitem. */
  type: string;
  /** Field name (lower case) → value with braces and LaTeX accents resolved. */
  fields: Record<string, string>;
  /** "Vincent Sitzmann, Michael Zollhöfer, Gordon Wetzstein". */
  authors: string;
  /** [from, to) of each last name in `authors`. */
  lastNames: [number, number][];
  title: string;
  year: string;
  venue: string;
  /** The entry as written in the .bib file. */
  raw: string;
}

export type BibField = 'key' | 'author' | 'title' | 'year' | 'venue';

export interface BibHit {
  field: BibField;
  /** [from, to) ranges in the field's text (entry.key, .authors, .title, .year, .venue). */
  ranges: [number, number][];
}

export interface BibMatch {
  entry: BibEntry;
  score: number;
  /** One per field that matched, best first. Empty for an empty query. */
  hits: BibHit[];
}

// ------------------------------------------------------------ parsing

const ACCENTS: Record<string, string> = {
  '"': '̈', "'": '́', '`': '̀', '^': '̂', '~': '̃', '=': '̄', '.': '̇',
  u: '̆', v: '̌', H: '̋', c: '̧', k: '̨', r: '̊',
};
const LETTERS: Record<string, string> = {
  ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ',
};

/** A BibTeX value as people read it: accents resolved, braces and formatting commands gone. */
export function cleanBibText(s: string): string {
  return s
    // \"{o}, \"o, {\"o}, \c{c}
    .replace(/\\(["'`^~=.]|[uvHckr](?![a-zA-Z]))\s*\{?\s*(\\[ij](?![a-zA-Z])|[a-zA-Z])\s*\}?/g,
      (_m, acc: string, ch: string) => (ch.startsWith('\\') ? ch.slice(1) : ch) + ACCENTS[acc])
    .replace(/\\(ss|ae|AE|oe|OE|aa|AA|[oOlLij])(?![a-zA-Z])\s*/g, (_m, l: string) => LETTERS[l])
    .replace(/\\&/g, '&').replace(/\\%/g, '%').replace(/\\_/g, '_').replace(/\\\$/g, '$')
    .replace(/~/g, ' ')
    .replace(/\\[a-zA-Z]+\*?\s*/g, '') // \textit, \emph: keep their argument
    .replace(/[{}$]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFC');
}

/**
 * Index of the bracket that closes the one at `open`, or -1. Braces nest;
 * with `paren`, the entry was opened with ( and ends at a ) outside braces.
 */
function closingBrace(src: string, open: number, paren = false): number {
  let depth = 0;
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      if (depth === 0 && !paren) return i;
      depth--;
    } else if (c === ')' && paren && depth === 0) return i;
  }
  return -1;
}

/** "Sitzmann, Vincent and Gordon Wetzstein" → display string and last-name ranges. */
function formatAuthors(field: string): { authors: string; lastNames: [number, number][] } {
  const people = splitTopLevel(field, /\s+and\s+/i).map((p) => p.trim()).filter(Boolean);
  let authors = '';
  const lastNames: [number, number][] = [];
  for (const raw of people) {
    if (authors) authors += ', ';
    if (/^others$/i.test(raw)) { authors += 'et al.'; continue; }
    const parts = splitTopLevel(raw, /\s*,\s*/).map(cleanBibText);
    let first: string;
    let last: string;
    if (parts.length > 1) {
      // Last, First   or   von Last, Jr, First
      last = parts[0];
      first = parts.slice(1).reverse().join(' ');
    } else {
      // First von Last: the last name is the last word (or a {braced group}).
      const brace = /\{[^{}]*\}\s*$/.exec(raw);
      if (brace && !/\\/.test(brace[0])) {
        last = cleanBibText(brace[0]);
        first = cleanBibText(raw.slice(0, brace.index));
      } else {
        const words = parts[0].split(' ');
        last = words.pop() ?? '';
        first = words.join(' ');
      }
    }
    if (first) authors += first + ' ';
    lastNames.push([authors.length, authors.length + last.length]);
    authors += last;
  }
  return { authors, lastNames };
}

/** Split at `sep`, but not inside braces. */
function splitTopLevel(s: string, sep: RegExp): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  const re = new RegExp(sep.source, sep.flags.includes('g') ? sep.flags : sep.flags + 'g');
  let masked = '';
  for (const c of s) {
    if (c === '{') depth++;
    else if (c === '}') depth--;
    masked += depth > 0 && c !== '{' ? '\0' : c;
  }
  for (const m of masked.matchAll(re)) {
    out.push(s.slice(start, m.index));
    start = m.index + m[0].length;
  }
  out.push(s.slice(start));
  return out;
}

/** Every entry of a .bib file, in file order. @string, @comment and @preamble are skipped. */
export function parseBib(src: string): BibEntry[] {
  const out: BibEntry[] = [];
  /** @string{name = "value"} macros, used by bare field values. */
  const macros = new Map<string, string>(
    ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].map((mo) => [mo, mo[0].toUpperCase() + mo.slice(1)]));
  const head = /@\s*(\w+)\s*([{(])\s*/g;
  let m: RegExpExecArray | null;
  while ((m = head.exec(src))) {
    const type = m[1].toLowerCase();
    const open = m.index + m[0].indexOf(m[2]);
    const end = closingBrace(src, open, m[2] === '(');
    const stop = end < 0 ? src.length : end + 1;
    if (type === 'comment' || type === 'preamble') { head.lastIndex = Math.max(head.lastIndex, stop); continue; }
    const body = src.slice(m.index + m[0].length, end < 0 ? src.length : end);
    const keyMatch = type === 'string' ? /^/.exec(body)! : /^([^,\s{}()=]+)\s*,/.exec(body);
    if (!keyMatch) continue;
    const fields: Record<string, string> = {};
    const rawFields: Record<string, string> = {};
    let i = keyMatch[0].length;
    while (i < body.length) {
      const f = /^[\s,]*([A-Za-z][\w:.+-]*)\s*=\s*/.exec(body.slice(i));
      if (!f) break;
      i += f[0].length;
      let value = '';
      // value = part # part # …
      for (;;) {
        const c = body[i];
        if (c === '{') {
          const close = closingBrace(body, i);
          const j = close < 0 ? body.length : close;
          value += body.slice(i + 1, j);
          i = j + 1;
        } else if (c === '"') {
          let j = i + 1;
          let depth = 0;
          for (; j < body.length; j++) {
            if (body[j] === '\\') { j++; continue; }
            if (body[j] === '{') depth++;
            else if (body[j] === '}') depth--;
            else if (body[j] === '"' && depth === 0) break;
          }
          value += body.slice(i + 1, j);
          i = j + 1;
        } else {
          const bare = /^[^,#}\s]*/.exec(body.slice(i))![0];
          value += macros.get(bare.toLowerCase()) ?? bare;
          i += bare.length;
        }
        const hash = /^\s*#\s*/.exec(body.slice(i));
        if (!hash) break;
        i += hash[0].length;
      }
      const name = f[1].toLowerCase();
      rawFields[name] = value;
      fields[name] = cleanBibText(value);
    }
    if (type === 'string') {
      for (const [name, value] of Object.entries(rawFields)) macros.set(name, value);
      head.lastIndex = Math.max(head.lastIndex, stop);
      continue;
    }
    const { authors, lastNames } = formatAuthors(rawFields.author ?? rawFields.editor ?? '');
    out.push({
      key: keyMatch[1],
      type,
      fields,
      authors,
      lastNames,
      title: fields.title ?? '',
      year: fields.year ?? /\d{4}/.exec(fields.date ?? '')?.[0] ?? '',
      venue: fields.journal ?? fields.booktitle ?? fields.journaltitle ?? fields.publisher ?? fields.school
        ?? fields.institution ?? fields.howpublished ?? (fields.eprint ? `arXiv ${fields.eprint}` : ''),
      raw: src.slice(m.index, stop),
    });
    head.lastIndex = Math.max(head.lastIndex, stop);
  }
  return out;
}

/** A \bibitem{key} from a .tex file: a key and nothing else. */
export function bareEntry(key: string, raw = `\\bibitem{${key}}`): BibEntry {
  return { key, type: '', fields: {}, authors: '', lastNames: [], title: '', year: '', venue: '', raw };
}

// ------------------------------------------------------------ search

/** Lower case, accents removed, one character for one character (offsets stay valid). */
export function fold(s: string): string {
  let out = '';
  for (const c of s) {
    const base = c.normalize('NFD')[0].toLowerCase();
    // Keep UTF-16 lengths equal for astral characters.
    out += base.length === c.length ? base : c;
  }
  return out;
}

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** Whether position i starts a word (in a key, also letter↔digit and lower→Upper). */
function wordStart(text: string, i: number, key: boolean): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  const cur = text[i];
  if (!isWordChar(prev)) return true;
  if (key && /\d/.test(prev) !== /\d/.test(cur)) return true;
  return false;
}

interface FieldText { field: BibField; text: string; folded: string }

/** The cached folded texts of an entry. */
const foldedCache = new WeakMap<BibEntry, FieldText[]>();
function fieldTexts(e: BibEntry): FieldText[] {
  let f = foldedCache.get(e);
  if (!f) {
    f = ([['key', e.key], ['author', e.authors], ['title', e.title], ['year', e.year], ['venue', e.venue]] as [BibField, string][])
      .filter(([, t]) => t)
      .map(([field, text]) => ({ field, text, folded: fold(text) }));
    foldedCache.set(e, f);
  }
  return f;
}

/** How well one query token matches one field: the score and where. */
function matchToken(e: BibEntry, ft: FieldText, q: string): { score: number; ranges: [number, number][] } | null {
  const { field, folded } = ft;
  let best: { score: number; ranges: [number, number][] } | null = null;
  const consider = (score: number, ranges: [number, number][]) => {
    if (!best || score > best.score) best = { score, ranges };
  };
  for (let i = folded.indexOf(q); i >= 0; i = folded.indexOf(q, i + 1)) {
    const start = wordStart(folded, i, field === 'key');
    const range: [number, number][] = [[i, i + q.length]];
    switch (field) {
      case 'key':
        consider(i === 0 ? (q.length === folded.length ? 200 : 100) : start ? 80 : 50, range);
        break;
      case 'author': {
        const onLast = e.lastNames.some(([a, b]) => i >= a && i < b);
        const lastStart = e.lastNames.some(([a]) => a === i);
        // The first author's last name counts a little more than the others'.
        const firstAuthor = e.lastNames[0]?.[0] === i;
        consider(lastStart ? (firstAuthor ? 95 : 90) : start ? 70 : onLast ? 40 : 35, range);
        break;
      }
      case 'title': {
        const wholeWord = start && !isWordChar(folded[i + q.length]);
        consider(start ? (wholeWord ? 65 : 60) : 30, range);
        break;
      }
      case 'year':
        if (i === 0) consider(q.length === 4 ? 70 : 40, range);
        break;
      case 'venue':
        consider(start ? 40 : 20, range);
        break;
    }
    if (best && (best as { score: number }).score >= 95) break;
  }
  if (!best && field === 'key' && q.length >= 2) {
    // Fuzzy: the letters in order (sitzsrn → sitzmann2019srn).
    const ranges: [number, number][] = [];
    let j = 0;
    let gaps = 0;
    for (let i = 0; i < folded.length && j < q.length; i++) {
      if (folded[i] !== q[j]) continue;
      if (ranges.length && ranges[ranges.length - 1][1] === i) ranges[ranges.length - 1][1] = i + 1;
      else { if (ranges.length) gaps++; ranges.push([i, i + 1]); }
      j++;
    }
    if (j === q.length) consider(Math.max(5, 25 - 4 * gaps - (ranges[0][0] > 0 ? 5 : 0)), ranges);
  }
  return best;
}

/**
 * Entries matching `query`, best first. Each whitespace-separated word of the
 * query has to match some field; the best field for each word counts. An
 * empty query lists every entry in file order.
 */
export function searchBib(entries: readonly BibEntry[], query: string, limit = 200): BibMatch[] {
  const tokens = fold(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return entries.slice(0, limit).map((entry) => ({ entry, score: 0, hits: [] }));
  const out: (BibMatch & { index: number })[] = [];
  entries.forEach((entry, index) => {
    const texts = fieldTexts(entry);
    let score = 0;
    const byField = new Map<BibField, { score: number; ranges: [number, number][] }>();
    for (const q of tokens) {
      let best: { field: BibField; score: number; ranges: [number, number][] } | null = null;
      for (const ft of texts) {
        const m = matchToken(entry, ft, q);
        if (m && (!best || m.score > best.score)) best = { field: ft.field, ...m };
      }
      if (!best) return;
      score += best.score;
      const hit = byField.get(best.field);
      if (hit) { hit.score = Math.max(hit.score, best.score); hit.ranges.push(...best.ranges); }
      else byField.set(best.field, { score: best.score, ranges: [...best.ranges] });
    }
    const hits = [...byField.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .map(([field, h]) => ({ field, ranges: mergeRanges(h.ranges) }));
    out.push({ entry, score, hits, index });
  });
  out.sort((a, b) => b.score - a.score || a.index - b.index);
  return out.slice(0, limit).map(({ entry, score, hits }) => ({ entry, score, hits }));
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** The text a hit's ranges refer to. */
export function fieldText(e: BibEntry, field: BibField): string {
  return field === 'key' ? e.key : field === 'author' ? e.authors : field === 'title' ? e.title : field === 'year' ? e.year : e.venue;
}

/**
 * A window of at most `max` characters of `text` around the first range,
 * with "…" where it was cut, and the ranges moved to match.
 */
export function snippet(text: string, ranges: [number, number][], max = 72): { text: string; ranges: [number, number][] } {
  if (text.length <= max) return { text, ranges };
  const first = ranges[0]?.[0] ?? 0;
  let start = Math.max(0, Math.min(first - 16, text.length - max));
  // Start at a word, without passing the match.
  if (start > 0 && text[start - 1] !== ' ') {
    const sp = text.indexOf(' ', start);
    if (sp >= 0 && sp + 1 <= first) start = sp + 1;
  }
  const end = Math.min(text.length, start + max);
  const pre = start > 0 ? '…' : '';
  const post = end < text.length ? '…' : '';
  const shift = pre.length - start;
  return {
    text: pre + text.slice(start, end) + post,
    ranges: ranges
      .filter(([a, b]) => b > start && a < end)
      .map(([a, b]) => [Math.max(a, start) + shift, Math.min(b, end) + shift] as [number, number]),
  };
}
