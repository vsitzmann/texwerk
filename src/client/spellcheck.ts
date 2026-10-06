import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { Lint, WorkerLinter } from 'harper.js';
import { isExemptWord, latexProse, paragraphs } from '@shared/prose.ts';
import { h, menuAt } from './ui.ts';

/**
 * Spelling and grammar as you type, with Harper (https://writewithharper.com)
 * running in a web worker: nothing leaves the browser. Only the prose of a
 * .tex file is checked (see latexProse); results are cached per paragraph, so
 * typing re-checks one paragraph, not the paper.
 *
 * Right-click a flagged word for suggestions, Add to dictionary, or Ignore.
 * The dictionary and ignore list are per browser.
 */

export interface Finding {
  from: number;
  to: number;
  kind: string;
  message: string;
  suggestions: string[];
}

const DICT_KEY = 'texwerk-dictionary';
const SPELLING = new Set(['Spelling', 'Typo']);
// Kinds that are noise in LaTeX source or a matter of taste.
const SKIP = new Set(['Formatting', 'Style', 'Readability', 'Enhancement']);

function loadWords(): string[] {
  try { return JSON.parse(localStorage.getItem(DICT_KEY) ?? '[]') as string[]; } catch { return []; }
}

// ------------------------------------------------------------ the checker

let linterPromise: Promise<WorkerLinter> | null = null;

/** One Harper worker for the whole page, loaded the first time it's needed. */
function linter(): Promise<WorkerLinter> {
  linterPromise ??= (async () => {
    const [{ WorkerLinter, Dialect }, { binary }] = await Promise.all([import('harper.js'), import('harper.js/binary')]);
    const l = new WorkerLinter({ binary, dialect: Dialect.American });
    await l.setup();
    const words = loadWords();
    if (words.length) await l.importWords(words);
    return l;
  })();
  return linterPromise;
}

// Paragraph text → findings relative to the paragraph. Shared across files.
const cache = new Map<string, Finding[]>();
const ignored = new Set<string>();

function toFinding(l: Lint): Finding {
  const span = l.span();
  return {
    from: span.start,
    to: span.end,
    kind: l.lint_kind(),
    message: l.message(),
    suggestions: l.suggestions().slice(0, 6).map((s) => s.get_replacement_text()),
  };
}

/** Findings for a whole document, in document order. */
export async function check(source: string): Promise<Finding[]> {
  const prose = latexProse(source);
  const l = await linter();
  const out: Finding[] = [];
  for (const p of paragraphs(prose)) {
    let found = cache.get(p.text);
    if (!found) {
      found = (await l.lint(p.text, { language: 'plaintext' })).map(toFinding);
      if (cache.size > 5000) cache.clear();
      cache.set(p.text, found);
    }
    for (const f of found) {
      const from = p.from + f.from;
      const to = p.from + f.to;
      const word = source.slice(from, to);
      // Skip noise, and anything that reaches into blanked-out markup.
      if (SKIP.has(f.kind) || !word.trim() || word !== prose.slice(from, to)) continue;
      if (ignored.has(`${f.kind}:${word}`) || (SPELLING.has(f.kind) && isExemptWord(word))) continue;
      out.push({ ...f, from, to });
    }
  }
  return out;
}

async function addWord(word: string): Promise<void> {
  const words = loadWords();
  if (!words.includes(word)) words.push(word);
  try { localStorage.setItem(DICT_KEY, JSON.stringify(words)); } catch { /* per session only */ }
  await (await linter()).importWords([word]);
  cache.clear();
}

// ------------------------------------------------------------ the editor

const setFindings = StateEffect.define<Finding[]>();

const errorMark = Decoration.mark({ class: 'cm-spell-error' });
const grammarMark = Decoration.mark({ class: 'cm-spell-grammar' });

function withDeco(findings: Finding[]) {
  return { findings, deco: Decoration.set(findings.map((f) => (SPELLING.has(f.kind) ? errorMark : grammarMark).range(f.from, f.to)), true) };
}

const findingsField = StateField.define<{ findings: Finding[]; deco: DecorationSet }>({
  create: () => ({ findings: [], deco: Decoration.none }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setFindings)) {
        const len = tr.state.doc.length;
        return withDeco(e.value.filter((f) => f.to <= len && f.to > f.from));
      }
    }
    if (!tr.docChanged) return value;
    // Follow typing until the next check; drop findings the edit touched.
    const findings: Finding[] = [];
    for (const f of value.findings) {
      if (tr.changes.touchesRange(f.from, f.to)) continue;
      findings.push({ ...f, from: tr.changes.mapPos(f.from, 1), to: tr.changes.mapPos(f.to, -1) });
    }
    return withDeco(findings);
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

const DELAY = 600;

const checker = ViewPlugin.fromClass(class {
  private timer = 0;
  private run = 0;
  private readonly view: EditorView;
  constructor(view: EditorView) { this.view = view; this.schedule(50); }
  update(u: ViewUpdate) { if (u.docChanged) this.schedule(DELAY); }
  schedule(ms: number) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.recheck(), ms);
  }
  async recheck() {
    const run = ++this.run;
    const doc = this.view.state.doc;
    let findings: Finding[];
    try { findings = await check(doc.toString()); } catch (e) { console.warn('spellcheck failed', e); return; }
    // A newer check is on its way, or the text moved on: wait for that one.
    if (run !== this.run || this.view.state.doc !== doc) return;
    this.view.dispatch({ effects: setFindings.of(findings) });
  }
  destroy() { clearTimeout(this.timer); this.run++; }
});

/** Re-run every open editor's check (after the dictionary changed). */
function recheckAll(view: EditorView) {
  view.plugin(checker)?.schedule(0);
}

function findingAt(view: EditorView, pos: number): Finding | undefined {
  return view.state.field(findingsField).findings.find((f) => f.from <= pos && pos <= f.to);
}

function showMenu(view: EditorView, f: Finding, x: number, y: number) {
  const word = view.state.sliceDoc(f.from, f.to);
  const editable = !view.state.readOnly;
  const items: Node[] = [h('div', { class: 'menu-head spell-message' }, f.message.replace(/`/g, '"'))];
  for (const s of f.suggestions) {
    items.push(h('button', {
      disabled: !editable,
      onclick: () => {
        view.dispatch({ changes: { from: f.from, to: f.to, insert: s }, selection: { anchor: f.from + s.length }, userEvent: 'input.spellcheck' });
        view.focus();
      },
    }, s === '' ? h('i', {}, 'Remove') : s));
  }
  if (!f.suggestions.length) items.push(h('button', { disabled: true }, 'No suggestions'));
  items.push(h('div', { class: 'menu-sep' }));
  if (SPELLING.has(f.kind) && /^[\p{L}\p{N}'’-]+$/u.test(word)) {
    items.push(h('button', { onclick: () => { void addWord(word).then(() => recheckAll(view)); } }, `Add “${word}” to dictionary`));
  }
  items.push(h('button', { onclick: () => { ignored.add(`${f.kind}:${word}`); recheckAll(view); } }, 'Ignore'));
  menuAt(x, y, items);
}

const contextMenu = EditorView.domEventHandlers({
  contextmenu(e, view) {
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos === null) return false;
    const f = findingAt(view, pos);
    if (!f) return false;
    e.preventDefault();
    showMenu(view, f, e.clientX, e.clientY);
    return true;
  },
});

/** Inline spelling and grammar checking for a LaTeX document. */
export function spellcheck(): Extension {
  return [findingsField, checker, contextMenu];
}

/** The current findings, for tests. */
export function findingsOf(view: EditorView): Finding[] {
  return view.state.field(findingsField, false)?.findings ?? [];
}
