import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
  dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars, Decoration, type DecorationSet,
  gutter, GutterMarker, showTooltip, type Tooltip,
} from '@codemirror/view';
import { RangeSet, StateEffect, StateField, type EditorState as State } from '@codemirror/state';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import {
  StreamLanguage, HighlightStyle, syntaxHighlighting, bracketMatching, indentOnInput, foldGutter, foldKeymap,
} from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { tags as t } from '@lezer/highlight';
import * as Y from 'yjs';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { vim, Vim, CodeMirror as VimCM } from '@replit/codemirror-vim';
import type { Awareness } from 'y-protocols/awareness';
import { extensionOf } from '@shared/files.ts';
import { latexSupport, type LatexProject } from './latex.ts';

/**
 * A CodeMirror view bound to one Y.Text. Remote carets and selections come
 * from y-codemirror's awareness integration; undo is per person (Y.UndoManager
 * only tracks this client's own edits), so undo never reverts a collaborator.
 */

const tokyo = HighlightStyle.define([
  { tag: [t.keyword, t.tagName], color: '#7aa2f7' },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: '#ff9e64' },
  { tag: [t.number], color: '#ff9e64' },
  { tag: [t.string, t.special(t.string)], color: '#9ece6a' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#565f89', fontStyle: 'italic' },
  { tag: [t.bracket, t.brace, t.squareBracket, t.paren], color: '#bb9af7' },
  { tag: [t.variableName, t.typeName], color: '#7dcfff' },
  { tag: [t.definition(t.variableName), t.function(t.variableName)], color: '#7dcfff' },
  { tag: [t.heading], color: '#e0af68', fontWeight: 'bold' },
  { tag: [t.meta, t.processingInstruction], color: '#e0af68' },
  { tag: [t.operator], color: '#89ddff' },
  { tag: [t.invalid], color: '#f7768e' },
]);

// Flash a line after a jump (from the log, SyncTeX, or following someone).
const flashEffect = StateEffect.define<number>();
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashEffect)) {
        const line = tr.state.doc.line(Math.max(1, Math.min(e.value, tr.state.doc.lines)));
        deco = Decoration.set([Decoration.line({ class: 'cm-flash-line' }).range(line.from)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ------------------------------------------------------------ comments

/** A comment thread as the editor draws it. */
export interface CommentMark {
  id: string;
  from: number;
  to: number;
  color: string;
  replies: number;
}

const setCommentsEffect = StateEffect.define<CommentMark[]>();

class CommentMarker extends GutterMarker {
  readonly ids: string[];
  readonly color: string;
  readonly count: number;
  constructor(ids: string[], color: string, count: number) {
    super();
    this.ids = ids;
    this.color = color;
    this.count = count;
  }
  eq(other: CommentMarker): boolean {
    return other.ids.join() === this.ids.join() && other.color === this.color && other.count === this.count;
  }
  toDOM(): Node {
    const el = document.createElement('span');
    el.className = 'cm-comment-marker';
    el.dataset.threads = this.ids.join(' ');
    el.style.setProperty('--c', this.color);
    el.title = this.ids.length > 1 ? `${this.ids.length} comment threads` : `Comment${this.count > 1 ? ` · ${this.count} messages` : ''}`;
    if (this.ids.length > 1) el.textContent = String(this.ids.length);
    return el;
  }
}

const commentsField = StateField.define<{ marks: CommentMark[]; deco: DecorationSet; gutter: RangeSet<GutterMarker> }>({
  create: () => ({ marks: [], deco: Decoration.none, gutter: RangeSet.empty }),
  update(value, tr) {
    let marks = value.marks;
    for (const e of tr.effects) if (e.is(setCommentsEffect)) marks = e.value;
    if (marks === value.marks && !tr.docChanged) return value;
    if (marks === value.marks) {
      // Follow typing until the next authoritative update from the Y.Doc.
      return { marks, deco: value.deco.map(tr.changes), gutter: value.gutter.map(tr.changes) };
    }
    return build(marks, tr.state);
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.deco),
    gutter({ class: 'cm-comment-gutter', markers: (view) => view.state.field(f).gutter }),
  ],
});

function build(marks: CommentMark[], state: State) {
  const len = state.doc.length;
  const ranges = [];
  const byLine = new Map<number, { ids: string[]; color: string; count: number }>();
  for (const m of marks) {
    const from = Math.max(0, Math.min(m.from, len));
    const to = Math.max(from, Math.min(m.to, len));
    if (to > from) {
      ranges.push(Decoration.mark({
        class: 'cm-comment-range',
        attributes: { 'data-thread': m.id, style: `--c:${m.color}` },
      }).range(from, to));
    }
    const line = state.doc.lineAt(from).from;
    const entry = byLine.get(line) ?? { ids: [], color: m.color, count: 0 };
    entry.ids.push(m.id);
    entry.count += m.replies;
    byLine.set(line, entry);
  }
  const gutterMarks = [...byLine.entries()].sort((a, b) => a[0] - b[0])
    .map(([pos, e]) => new CommentMarker(e.ids, e.color, e.count).range(pos));
  return { marks, deco: Decoration.set(ranges, true), gutter: RangeSet.of(gutterMarks, true) };
}

/** The little Comment button beside a non-empty selection. */
function commentTooltip(onComment: () => void) {
  return StateField.define<readonly Tooltip[]>({
    create: () => [],
    update(_value, tr) {
      const sel = tr.state.selection.main;
      if (sel.empty) return [];
      return [{
        pos: sel.head,
        above: sel.head < sel.anchor,
        strictSide: false,
        arrow: false,
        create: () => {
          const dom = document.createElement('div');
          dom.className = 'cm-comment-tip';
          const b = document.createElement('button');
          b.textContent = '💬 Comment';
          b.title = 'Comment on the selected text (Ctrl+Alt+M)';
          b.addEventListener('mousedown', (e) => { e.preventDefault(); onComment(); });
          dom.append(b);
          return { dom };
        },
      }];
    },
    provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
  });
}

// ------------------------------------------------------------ provenance

/** A run of text and who last wrote it, as the Authors view draws it. */
export interface AuthorMark {
  from: number;
  to: number;
  color: string;
  label: string;
}

const setAuthorsEffect = StateEffect.define<AuthorMark[] | null>();

const authorsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setAuthorsEffect)) {
        if (!e.value) return Decoration.none;
        const len = tr.state.doc.length;
        return Decoration.set(e.value
          .filter((m) => m.to > m.from && m.from < len)
          .map((m) => Decoration.mark({
            class: 'cm-author',
            attributes: { title: m.label, style: `--c:${m.color}` },
          }).range(m.from, Math.min(m.to, len))), true);
      }
    }
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ------------------------------------------------------------ vim

// Vim's u / Ctrl-R go through CodeMirror's own history, which the editor
// doesn't have: undo is the Y.UndoManager's (per person).
const [yUndo, yRedo] = [yUndoManagerKeymap[0].run!, yUndoManagerKeymap[1].run!];
VimCM.commands.undo = (cm: { cm6: EditorView }) => { yUndo(cm.cm6); };
VimCM.commands.redo = (cm: { cm6: EditorView }) => { yRedo(cm.cm6); };
// :w compiles, like Ctrl+S.
const vimSave = new WeakMap<EditorView, () => void>();
Vim.defineEx('write', 'w', (cm: { cm6: EditorView }) => vimSave.get(cm.cm6)?.());

export interface CodeEditorOptions {
  path: string;
  ytext: Y.Text;
  awareness: Awareness;
  onCursor: (line: number, col: number) => void;
  onCompile: () => void;
  onSyncToPdf: () => void;
  readOnly?: boolean;
  /** The rest of the project, for completing labels, citations and files. */
  project?: Omit<LatexProject, 'path'>;
  /** Vim keybindings. */
  vim?: boolean;
  /** Start a comment on the selection. */
  onComment?: (from: number, to: number, rect: DOMRect) => void;
  /** Open the given thread(s), shown next to `rect`. */
  onOpenThread?: (ids: string[], rect: DOMRect) => void;
}

export class CodeEditor {
  readonly view: EditorView;
  readonly path: string;
  private readonly undo: Y.UndoManager;
  private readonly vimMode = new Compartment();

  constructor(parent: HTMLElement, opts: CodeEditorOptions) {
    this.path = opts.path;
    this.undo = new Y.UndoManager(opts.ytext);
    const ext = extensionOf(opts.path);
    const language: Extension[] = ['tex', 'sty', 'cls', 'ltx', 'bib', 'bbx', 'cbx', 'dtx', 'tikz'].includes(ext)
      ? [StreamLanguage.define(stex), latexSupport({ path: opts.path, texts: () => [], files: () => [], ...opts.project })]
      : [];
    const state = EditorState.create({
      doc: opts.ytext.toString(),
      extensions: [
        // Vim goes before every other keymap.
        this.vimMode.of(opts.vim ? vim({ status: true }) : []),
        lineNumbers(),
        foldGutter(),
        highlightSpecialChars(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        highlightSelectionMatches(),
        syntaxHighlighting(tokyo),
        EditorView.lineWrapping,
        // Read-only refuses edits but keeps the caret and keyboard selection,
        // so viewers can still select text to comment on.
        EditorState.readOnly.of(Boolean(opts.readOnly)),
        flashField,
        authorsField,
        commentsField,
        commentTooltip(() => this.startComment()),
        EditorView.domEventHandlers({
          click: (e) => {
            const range = (e.target as HTMLElement).closest('.cm-comment-range') as HTMLElement | null;
            if (range && this.view.state.selection.main.empty) {
              opts.onOpenThread?.([range.dataset.thread!], range.getBoundingClientRect());
            }
            return false;
          },
        }),
        ...language,
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { opts.onCompile(); return true; } },
          { key: 'Mod-Enter', preventDefault: true, run: () => { opts.onCompile(); return true; } },
          { key: 'Mod-Alt-ArrowRight', preventDefault: true, run: () => { opts.onSyncToPdf(); return true; } },
          { key: 'Mod-Alt-m', preventDefault: true, run: () => { this.startComment(); return true; } },
          ...closeBracketsKeymap,
          ...yUndoManagerKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        yCollab(opts.ytext, opts.awareness, { undoManager: this.undo }),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet || update.docChanged) {
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            opts.onCursor(line.number, head - line.from + 1);
          }
        }),
        EditorView.theme({}, { dark: true }),
      ],
    });
    this.view = new EditorView({ state, parent });
    vimSave.set(this.view, opts.onCompile);
    this.onComment = opts.onComment;
    // Gutter markers sit outside the content DOM that CodeMirror's own
    // handlers cover, so listen on the whole editor.
    this.view.dom.addEventListener('mousedown', (e) => {
      const marker = (e.target as HTMLElement).closest('.cm-comment-marker') as HTMLElement | null;
      if (!marker) return;
      e.preventDefault();
      opts.onOpenThread?.(marker.dataset.threads!.split(' '), marker.getBoundingClientRect());
    });
  }

  private readonly onComment?: (from: number, to: number, rect: DOMRect) => void;

  private startComment(): void {
    const sel = this.view.state.selection.main;
    if (sel.empty || !this.onComment) return;
    const coords = this.view.coordsAtPos(sel.to) ?? this.view.coordsAtPos(sel.from);
    const rect = coords ? new DOMRect(coords.left, coords.top, 1, coords.bottom - coords.top) : this.view.dom.getBoundingClientRect();
    this.onComment(sel.from, sel.to, rect);
  }

  setVim(on: boolean): void {
    this.view.dispatch({ effects: this.vimMode.reconfigure(on ? vim({ status: true }) : []) });
  }

  /** Colour the text by author; null turns the view off. */
  setAuthors(marks: AuthorMark[] | null): void {
    this.view.dispatch({ effects: setAuthorsEffect.of(marks) });
  }

  setComments(marks: CommentMark[]): void {
    this.view.dispatch({ effects: setCommentsEffect.of(marks) });
  }

  currentLine(): number {
    return this.view.state.doc.lineAt(this.view.state.selection.main.head).number;
  }

  goToLine(line: number, focus = true): void {
    const doc = this.view.state.doc;
    const target = doc.line(Math.max(1, Math.min(line, doc.lines)));
    this.view.dispatch({
      selection: { anchor: target.from },
      effects: [EditorView.scrollIntoView(target.from, { y: 'center' }), flashEffect.of(target.number)],
    });
    if (focus) this.view.focus();
  }

  /** Put the caret at a comment's text, scroll it to the middle and flash it. */
  selectRange(from: number, to: number): void {
    const len = this.view.state.doc.length;
    const a = Math.max(0, Math.min(from, len));
    const b = Math.max(a, Math.min(to, len));
    this.view.dispatch({
      // A caret, not a selection: the commented text is already highlighted,
      // and a selection would pop up the Comment button.
      selection: { anchor: a },
      effects: [EditorView.scrollIntoView(b > a ? a : a, { y: 'center' }), flashEffect.of(this.view.state.doc.lineAt(a).number)],
    });
    this.view.focus();
  }

  revealPosition(pos: number): void {
    const clamped = Math.max(0, Math.min(pos, this.view.state.doc.length));
    const line = this.view.state.doc.lineAt(clamped).number;
    this.view.dispatch({ effects: [EditorView.scrollIntoView(clamped, { y: 'center' }), flashEffect.of(line)] });
  }

  destroy(): void {
    this.view.destroy();
    this.undo.destroy();
  }
}
