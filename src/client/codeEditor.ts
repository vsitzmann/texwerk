import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
  dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars, Decoration, type DecorationSet,
} from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import {
  StreamLanguage, HighlightStyle, syntaxHighlighting, bracketMatching, indentOnInput, foldGutter, foldKeymap,
} from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { tags as t } from '@lezer/highlight';
import * as Y from 'yjs';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type { Awareness } from 'y-protocols/awareness';
import { extensionOf } from '@shared/files.ts';

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

const LATEX_COMMANDS = [
  'section', 'subsection', 'subsubsection', 'paragraph', 'chapter', 'part', 'label', 'ref', 'eqref', 'cref', 'Cref',
  'cite', 'citep', 'citet', 'emph', 'textbf', 'textit', 'texttt', 'underline', 'footnote', 'caption', 'includegraphics',
  'begin', 'end', 'item', 'usepackage', 'newcommand', 'renewcommand', 'input', 'include', 'bibliography',
  'bibliographystyle', 'maketitle', 'tableofcontents', 'centering', 'frac', 'sum', 'int', 'left', 'right',
  'mathbf', 'mathrm', 'mathcal', 'mathbb', 'hline', 'vspace', 'hspace', 'url', 'href', 'todo', 'autoref',
];
const ENVIRONMENTS = ['figure', 'table', 'equation', 'align', 'itemize', 'enumerate', 'tabular', 'center', 'abstract', 'document', 'minipage', 'description', 'verbatim', 'theorem', 'proof', 'lemma'];

function latexCompletions(context: import('@codemirror/autocomplete').CompletionContext) {
  const env = context.matchBefore(/\\begin\{\w*/);
  if (env) {
    const from = env.from + env.text.indexOf('{') + 1;
    return { from, options: ENVIRONMENTS.map((e) => ({ label: e, type: 'type' })) };
  }
  const word = context.matchBefore(/\\[a-zA-Z]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  return { from: word.from + 1, options: LATEX_COMMANDS.map((c) => ({ label: c, type: 'keyword' })) };
}

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

export interface CodeEditorOptions {
  path: string;
  ytext: Y.Text;
  awareness: Awareness;
  onCursor: (line: number, col: number) => void;
  onCompile: () => void;
  onSyncToPdf: () => void;
}

export class CodeEditor {
  readonly view: EditorView;
  readonly path: string;
  private readonly undo: Y.UndoManager;

  constructor(parent: HTMLElement, opts: CodeEditorOptions) {
    this.path = opts.path;
    this.undo = new Y.UndoManager(opts.ytext);
    const ext = extensionOf(opts.path);
    const language: Extension[] = ['tex', 'sty', 'cls', 'ltx', 'bib', 'bbx', 'cbx', 'dtx', 'tikz'].includes(ext)
      ? [StreamLanguage.define(stex), autocompletion({ override: [latexCompletions], icons: false })]
      : [];
    const state = EditorState.create({
      doc: opts.ytext.toString(),
      extensions: [
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
        flashField,
        ...language,
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { opts.onCompile(); return true; } },
          { key: 'Mod-Enter', preventDefault: true, run: () => { opts.onCompile(); return true; } },
          { key: 'Mod-Alt-ArrowRight', preventDefault: true, run: () => { opts.onSyncToPdf(); return true; } },
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
