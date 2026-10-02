import { EditorSelection, EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import {
  autocompletion, closeCompletion, completionStatus, selectedCompletion, snippet, startCompletion,
  type Completion, type CompletionContext, type CompletionResult,
} from '@codemirror/autocomplete';

/**
 * LaTeX editing help: completion of commands, environments, labels,
 * citation keys, files and packages, and an Enter key that closes
 * environments and continues lists.
 *
 *   \begin{itemize}⏎   →  \begin{itemize}
 *                            \item |
 *                          \end{itemize}
 *
 * Picking an environment from the completion list inserts it whole, with
 * Tab stops (figure: placement, file, caption, label). Enter on a non-empty
 * \item line starts the next item. Enter on an empty one removes it, and
 * leaves the list if it was the last item.
 */

/** What completion can see of the rest of the project. */
export interface LatexProject {
  /** The file being edited. */
  path: string;
  /** Every text file of the project, path → contents. */
  texts(): Iterable<[string, () => string]>;
  /** Every file path, text and binary. */
  files(): string[];
}

// ------------------------------------------------------------ scanning

/** Blank out % comments, keeping offsets. */
export function stripComments(text: string): string {
  return text.replace(/(^|[^\\])((?:\\\\)*)%.*$/gm,
    (m, a: string, b: string) => a + b + ' '.repeat(m.length - a.length - b.length));
}

export interface EnvToken { kind: 'begin' | 'end'; name: string; from: number; to: number }

export function envTokens(text: string): EnvToken[] {
  const out: EnvToken[] = [];
  for (const m of stripComments(text).matchAll(/\\(begin|end)\s*\{([^{}\s]*)\}/g)) {
    out.push({ kind: m[1] as 'begin' | 'end', name: m[2], from: m.index, to: m.index + m[0].length });
  }
  return out;
}

/**
 * Whether the \begin{name} that ends at `pos` already has its \end. If the
 * document is balanced but the \end that pairs with it has another name, the
 * \begin was renamed: that \end is returned as `stale`.
 */
export function findEnd(text: string, pos: number, name: string): { closed: boolean; stale?: EnvToken } {
  const tokens = envTokens(text);
  let depth = 0;
  let match: EnvToken | undefined;
  for (const t of tokens) {
    if (t.from < pos) continue;
    if (t.kind === 'begin') depth++;
    else if (depth === 0) { match = t; break; } else depth--;
  }
  if (match?.name === name) return { closed: true };
  const begins = tokens.filter((t) => t.kind === 'begin').length;
  if (begins > tokens.length - begins) return { closed: false };
  return { closed: true, stale: match };
}

/** The innermost environment open at `pos`. */
export function openEnvAt(text: string, pos: number): EnvToken | null {
  const stack: EnvToken[] = [];
  for (const t of envTokens(text)) {
    if (t.to > pos) break;
    if (t.kind === 'begin') stack.push(t);
    else {
      const i = stack.map((s) => s.name).lastIndexOf(t.name);
      if (i >= 0) stack.length = i;
    }
  }
  return stack.at(-1) ?? null;
}

// ------------------------------------------------------------ environments

/** Snippet syntax: ${} is a Tab stop, ${text} one with placeholder text. */
interface EnvTemplate { args?: string; body?: string }

const FIGURE = '\\centering\n\\includegraphics[width=\\linewidth]{${}}\n\\caption{${}}\n\\label{fig:${}}';
const TABLE = '\\centering\n\\caption{${}}\n\\label{tab:${}}\n\\begin{tabular}{${ll}}\n\t${}\n\\end{tabular}';
const ENVS: Record<string, EnvTemplate> = {
  itemize: { body: '\\item ${}' },
  enumerate: { body: '\\item ${}' },
  description: { body: '\\item[${}] ${}' },
  figure: { args: '[${t}]', body: FIGURE },
  'figure*': { args: '[${t}]', body: FIGURE },
  table: { args: '[${t}]', body: TABLE },
  'table*': { args: '[${t}]', body: TABLE },
  subfigure: { args: '{${0.48\\linewidth}}', body: '\\centering\n\\includegraphics[width=\\linewidth]{${}}\n\\caption{${}}' },
  wrapfigure: { args: '{${r}}{${0.4\\linewidth}}', body: FIGURE },
  tabular: { args: '{${ll}}' },
  'tabular*': { args: '{${\\linewidth}}{${ll}}' },
  tabularx: { args: '{${\\linewidth}}{${lX}}' },
  minipage: { args: '{${0.48\\linewidth}}' },
  array: { args: '{${cc}}' },
  thebibliography: { args: '{${99}}', body: '\\bibitem{${}} ${}' },
  frame: { body: '\\frametitle{${}}\n${}' },
  columns: { body: '\\begin{column}{${0.5\\textwidth}}\n\t${}\n\\end{column}' },
  column: { args: '{${0.5\\textwidth}}' },
  block: { args: '{${}}' },
  algorithmic: { args: '[${1}]', body: '\\State ${}' },
};
const ENV_NAMES = [
  'itemize', 'enumerate', 'description', 'figure', 'figure*', 'table', 'table*', 'subfigure', 'wrapfigure',
  'tabular', 'tabular*', 'tabularx', 'equation', 'equation*', 'align', 'align*', 'gather', 'gather*',
  'multline', 'multline*', 'split', 'cases', 'aligned', 'matrix', 'pmatrix', 'bmatrix', 'array',
  'center', 'flushleft', 'flushright', 'minipage', 'abstract', 'document', 'quote', 'quotation', 'verbatim',
  'theorem', 'lemma', 'proposition', 'corollary', 'definition', 'remark', 'example', 'proof',
  'algorithm', 'algorithmic', 'lstlisting', 'tikzpicture', 'thebibliography', 'frame', 'columns', 'column', 'block',
];
const LISTS = new Set(['itemize', 'enumerate', 'description', 'compactitem', 'compactenum', 'inparaenum']);

function envSnippet(name: string, withArgs: boolean): string {
  const t = ENVS[name] ?? {};
  const body = (t.body ?? '${}').split('\n').map((l) => (name === 'document' ? '' : '\t') + l).join('\n');
  return `${withArgs ? t.args ?? '' : ''}\n${body}\n\\end{${name}}`;
}

const escapeSnippet = (s: string) => s.replace(/[{}]/g, (c) => `\\${c}`);

/** Complete the name of a \begin{…} at from..to, inserting the \end if it has none. */
function applyBegin(view: EditorView, name: string, from: number, to: number): void {
  const { state } = view;
  const end = state.sliceDoc(to, to + 1) === '}' ? to + 1 : to;
  const doc = state.doc.toString();
  const after = from + name.length + 1;
  const { closed, stale } = findEnd(doc.slice(0, from) + name + '}' + doc.slice(end), after, name);
  if (!closed) {
    const hasArgs = /^[[{]/.test(state.sliceDoc(end, end + 1));
    snippet(escapeSnippet(name) + '}' + envSnippet(name, !hasArgs))(view, null, from, end);
    return;
  }
  const changes = [{ from, to: end, insert: name + '}' }];
  if (stale) {
    // The \begin was renamed: rename its \end too.
    const delta = name.length + 1 - (end - from);
    const nameTo = stale.to - 1 - delta;
    changes.push({ from: nameTo - stale.name.length, to: nameTo, insert: name });
  }
  view.dispatch({ changes, selection: { anchor: from + name.length + 1 }, userEvent: 'input.complete' });
}

// ------------------------------------------------------------ Enter

/** Enter right after \begin{name}: put the caret inside a closed environment. */
function enterAfterBegin(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.head);
  let before = line.text.slice(0, sel.head - line.from);
  let after = line.text.slice(sel.head - line.from);
  let head = sel.head;
  if (/\\begin\{[^{}\s]+$/.test(before) && after.startsWith('}')) {
    // \begin{itemize|} with the brace closeBrackets put there.
    before += '}';
    after = after.slice(1);
    head++;
  }
  const m = /\\begin\{([^{}\s]+)\}((?:\[[^\]]*\]|\{[^{}]*\})*)\s*$/.exec(stripComments(before));
  if (!m || after.trim()) return false;
  const name = m[1];
  if (findEnd(state.doc.toString(), head - (before.length - before.trimEnd().length), name).closed) return false;
  snippet(envSnippet(name, false))(view, null, head, line.to);
  return true;
}

/** Enter on an \item line inside a list: start the next item, or leave the list. */
function enterInList(view: EditorView): boolean {
  const { state } = view;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const m = /^(\s*)\\item\b(\[[^\]]*\])?\s*/.exec(line.text);
  if (!m || head < line.from + m[0].trimEnd().length) return false;
  const text = state.doc.toString();
  const env = openEnvAt(text, head);
  if (!env || !LISTS.has(env.name)) return false;
  const indent = m[1];

  if (!line.text.slice(m[0].length).trim()) {
    const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
    const endRe = new RegExp(`^\\s*\\\\end\\{${env.name.replace(/[*]/g, '\\*')}\\}\\s*$`);
    if (!next || !endRe.test(next.text)) {
      // An empty item in the middle: just drop the \item.
      view.dispatch({ changes: { from: line.from + indent.length, to: line.to }, userEvent: 'delete' });
      return true;
    }
    // The last item is empty: leave the list (and continue the outer one).
    const outer = openEnvAt(text, next.to);
    const nextIndent = /^\s*/.exec(next.text)![0];
    const insert = '\n' + nextIndent + (outer && LISTS.has(outer.name) ? '\\item ' : '');
    const changes = state.changes([{ from: line.from, to: next.from }, { from: next.to, insert }]);
    view.dispatch({ changes, selection: { anchor: changes.mapPos(next.to, 1) }, userEvent: 'input' });
    return true;
  }
  const rest = line.text.slice(head - line.from);
  const skip = rest.length - rest.trimStart().length;
  const marker = env.name === 'description' ? '\\item[]' : '\\item ';
  const insert = '\n' + indent + marker;
  view.dispatch({
    changes: { from: head, to: head + skip, insert },
    selection: { anchor: head + insert.length - (env.name === 'description' ? 1 : 0) },
    scrollIntoView: true,
    userEvent: 'input',
  });
  return true;
}

function latexEnter(view: EditorView): boolean {
  const { state } = view;
  if (state.readOnly || state.selection.ranges.length > 1 || !state.selection.main.empty) return false;
  return enterAfterBegin(view) || enterInList(view);
}

// ------------------------------------------------------------ completion

/**
 * Commands, with `{}` and `[text]` for arguments (Tab stops). A trailing
 * `!` reopens completion inside the braces (labels, keys, files).
 */
const COMMANDS = [
  'section{}', 'subsection{}', 'subsubsection{}', 'paragraph{}', 'chapter{}', 'part{}', 'section*{}', 'subsection*{}',
  'label{}', 'ref{}!', 'eqref{}!', 'cref{}!', 'Cref{}!', 'autoref{}!', 'pageref{}!', 'nameref{}!',
  'cite{}!', 'citep{}!', 'citet{}!', 'citeauthor{}!', 'citeyear{}!', 'parencite{}!', 'textcite{}!', 'autocite{}!', 'nocite{}!',
  'begin{}!', 'end{}!', 'item', 'usepackage{}!', 'documentclass{}', 'input{}!', 'include{}!',
  'includegraphics[${2:width=\\linewidth}]{${1}}!', 'bibliography{}!', 'bibliographystyle{}', 'addbibresource{}!',
  'emph{}', 'textbf{}', 'textit{}', 'texttt{}', 'textsc{}', 'textrm{}', 'textsf{}', 'underline{}', 'footnote{}',
  'caption{}', 'url{}', 'href{}{}', 'todo{}', 'text{}', 'mbox{}', 'textcolor{}{}', 'colorbox{}{}',
  'title{}', 'author{}', 'date{}', 'maketitle', 'tableofcontents', 'appendix', 'thanks{}',
  'centering', 'noindent', 'newline', 'newpage', 'clearpage', 'linebreak', 'par', 'medskip', 'bigskip', 'smallskip',
  'vspace{}', 'hspace{}', 'linewidth', 'textwidth', 'columnwidth',
  'hline', 'toprule', 'midrule', 'bottomrule', 'cmidrule{}', 'multicolumn{}{}{}', 'multirow{}{}{}',
  'newcommand{\\}{}', 'renewcommand{\\}{}', 'DeclareMathOperator{\\}{}', 'newenvironment{}{}{}', 'newtheorem{}{}',
  'frac{}{}', 'dfrac{}{}', 'tfrac{}{}', 'sqrt{}', 'binom{}{}', 'mathbf{}', 'mathrm{}', 'mathcal{}', 'mathbb{}',
  'mathit{}', 'mathsf{}', 'boldsymbol{}', 'bm{}', 'operatorname{}', 'hat{}', 'bar{}', 'tilde{}', 'vec{}', 'dot{}',
  'overline{}', 'underbrace{}_{}', 'overbrace{}^{}', 'widehat{}', 'widetilde{}',
  'left', 'right', 'big', 'Big', 'bigg', 'sum', 'prod', 'int', 'iint', 'oint', 'lim', 'max', 'min', 'arg', 'sup', 'inf',
  'log', 'exp', 'sin', 'cos', 'det', 'infty', 'partial', 'nabla', 'cdot', 'cdots', 'ldots', 'dots', 'vdots', 'ddots',
  'times', 'otimes', 'oplus', 'circ', 'pm', 'leq', 'geq', 'neq', 'approx', 'equiv', 'sim', 'simeq', 'propto',
  'in', 'notin', 'subset', 'subseteq', 'cup', 'cap', 'setminus', 'emptyset', 'forall', 'exists', 'mid',
  'to', 'rightarrow', 'leftarrow', 'Rightarrow', 'Leftrightarrow', 'mapsto', 'langle', 'rangle', 'lVert', 'rVert',
  'quad', 'qquad', 'top', 'intercal', 'mathbb{R}', 'mathbb{E}',
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta', 'iota', 'kappa',
  'lambda', 'mu', 'nu', 'xi', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega',
  'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Phi', 'Psi', 'Omega',
];
const PACKAGES = [
  'amsmath', 'amssymb', 'amsthm', 'mathtools', 'graphicx', 'hyperref', 'cleveref', 'booktabs', 'xcolor', 'tikz',
  'pgfplots', 'natbib', 'biblatex', 'geometry', 'microtype', 'subcaption', 'caption', 'algorithm', 'algpseudocode',
  'algorithmic', 'listings', 'enumitem', 'multirow', 'makecell', 'tabularx', 'array', 'float', 'wrapfig', 'siunitx',
  'url', 'inputenc', 'fontenc', 'times', 'lipsum', 'todonotes', 'bm', 'xspace', 'soul', 'comment', 'pifont',
];

/** `frac{}{}` → `frac{${}}{${}}`; `[text]` becomes a Tab stop with that text. */
function commandCompletion(spec: string): Completion {
  const reopen = spec.endsWith('!');
  const body = reopen ? spec.slice(0, -1) : spec;
  const label = /^[a-zA-Z]+\*?/.exec(body)![0];
  const rest = body.slice(label.length);
  if (!rest || /^\{[A-Z]\}$/.test(rest)) {
    return { label: body, type: 'keyword', apply: body };
  }
  const template = rest.includes('${') ? label + rest : label + rest
    .replace(/\[([^\]]*)\]/g, (_m, t: string) => `[\${${t}}]`)
    .replace(/\{(\\?)\}/g, (_m, bs: string) => `{${bs}\${}}`);
  return {
    label,
    detail: rest.replace(/\[[^\]]*\]/g, '[…]'),
    type: 'keyword',
    apply: (view, _c, from, to) => {
      // Editing an existing command (\textit{…} → \textbf): keep its arguments.
      if (/^[{[]/.test(view.state.sliceDoc(to, to + 1))) {
        view.dispatch({ changes: { from, to, insert: label }, selection: { anchor: from + label.length }, userEvent: 'input.complete' });
        return;
      }
      snippet(template)(view, null, from, to);
      if (reopen) startCompletion(view);
    },
  };
}
const BUILTIN_COMMANDS = COMMANDS.map(commandCompletion);

interface FileFacts {
  src: string;
  labels: { name: string; line: number }[];
  commands: { name: string; args: number }[];
  envs: string[];
  cites: { key: string; title?: string }[];
}

const factsCache = new Map<string, FileFacts>();

function factsOf(path: string, src: string): FileFacts {
  const hit = factsCache.get(path);
  if (hit && hit.src === src) return hit;
  const facts: FileFacts = { src, labels: [], commands: [], envs: [], cites: [] };
  if (path.endsWith('.bib')) {
    const entries = [...src.matchAll(/@(\w+)\s*[{(]\s*([^,\s{}]+)\s*,/g)]
      .filter((m) => !/^(comment|string|preamble)$/i.test(m[1]));
    entries.forEach((m, i) => {
      const chunk = src.slice(m.index, entries[i + 1]?.index ?? src.length);
      const title = /\btitle\s*=\s*[{"](.*)/i.exec(chunk)?.[1].replace(/[{}"]/g, '').replace(/,\s*$/, '').trim();
      facts.cites.push({ key: m[2], title: title && title.length > 70 ? title.slice(0, 68) + '…' : title });
    });
  } else {
    const clean = stripComments(src);
    const lineAt = (i: number) => clean.slice(0, i).split('\n').length;
    for (const m of clean.matchAll(/\\label\s*\{([^{}]+)\}/g)) facts.labels.push({ name: m[1], line: lineAt(m.index) });
    for (const m of clean.matchAll(/\\(?:re|provide)?newcommand\*?\s*\{?\s*\\([a-zA-Z]+)\s*\}?\s*(?:\[(\d)\])?/g)) {
      facts.commands.push({ name: m[1], args: Number(m[2] ?? 0) });
    }
    for (const m of clean.matchAll(/\\(?:DeclareMathOperator\*?\s*\{\s*\\|def\s*\\)([a-zA-Z]+)/g)) {
      facts.commands.push({ name: m[1], args: 0 });
    }
    // \end, not \begin: the \begin{figu} being typed is not an environment yet.
    for (const m of clean.matchAll(/\\(?:newenvironment|newtheorem|end)\s*\{([^{}\s]+)\}/g)) facts.envs.push(m[1]);
    for (const m of clean.matchAll(/\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/g)) facts.cites.push({ key: m[1] });
  }
  factsCache.set(path, facts);
  return facts;
}

function projectFacts(project: LatexProject): { path: string; facts: FileFacts }[] {
  const out = [];
  for (const [path, read] of project.texts()) {
    if (/\.(tex|sty|cls|ltx|bib|tikz)$/.test(path)) out.push({ path, facts: factsOf(path, read()) });
  }
  return out;
}

type ArgKind = 'env' | 'end' | 'ref' | 'cite' | 'tex' | 'graphics' | 'bib' | 'bibfile' | 'package';

function argKind(cmd: string): ArgKind | null {
  if (cmd === 'begin') return 'env';
  if (cmd === 'end') return 'end';
  if (/^(ref|eqref|[cC]ref|autoref|pageref|nameref|vref|labelcref|cpageref)\*?$/.test(cmd)) return 'ref';
  if (/^(no)?cite|cite\*?$|^(paren|text|auto|foot|super)cites?\*?$/i.test(cmd)) return 'cite';
  if (cmd === 'input' || cmd === 'include' || cmd === 'subfile' || cmd === 'includeonly') return 'tex';
  if (cmd === 'includegraphics' || cmd === 'includepdf' || cmd === 'includesvg') return 'graphics';
  if (cmd === 'bibliography') return 'bib';
  if (cmd === 'addbibresource') return 'bibfile';
  if (cmd === 'usepackage' || cmd === 'RequirePackage') return 'package';
  return null;
}

function argumentOptions(kind: ArgKind, project: LatexProject, context: CompletionContext): Completion[] {
  switch (kind) {
    case 'env':
    case 'end': {
      const names = new Set(ENV_NAMES);
      for (const { facts } of projectFacts(project)) for (const e of facts.envs) names.add(e);
      const open = kind === 'end' ? openEnvAt(context.state.doc.toString(), context.pos)?.name : undefined;
      return [...names].map((name) => ({
        label: name,
        type: 'type',
        boost: name === open ? 99 : 0,
        apply: kind === 'env'
          ? (view: EditorView, _c: Completion, from: number, to: number) => applyBegin(view, name, from, to)
          : (view: EditorView, _c: Completion, from: number, to: number) => {
            const end = view.state.sliceDoc(to, to + 1) === '}' ? to + 1 : to;
            view.dispatch({ changes: { from, to: end, insert: name + '}' }, selection: { anchor: from + name.length + 1 }, userEvent: 'input.complete' });
          },
      }));
    }
    case 'ref': {
      const out: Completion[] = [];
      for (const { path, facts } of projectFacts(project)) {
        for (const l of facts.labels) {
          out.push({ label: l.name, type: 'variable', detail: path === project.path ? `line ${l.line}` : `${path}:${l.line}` });
        }
      }
      return out;
    }
    case 'cite': {
      const seen = new Set<string>();
      const out: Completion[] = [];
      for (const { facts } of projectFacts(project)) {
        for (const c of facts.cites) {
          if (seen.has(c.key)) continue;
          seen.add(c.key);
          out.push({ label: c.key, type: 'text', detail: c.title });
        }
      }
      return out;
    }
    case 'tex':
      return project.files().filter((f) => f.endsWith('.tex') && f !== project.path)
        .map((f) => ({ label: f.slice(0, -4), type: 'file' }));
    case 'graphics':
      return project.files().filter((f) => /\.(png|jpe?g|pdf|eps|svg)$/i.test(f)).map((f) => ({ label: f, type: 'file' }));
    case 'bib':
      return project.files().filter((f) => f.endsWith('.bib')).map((f) => ({ label: f.slice(0, -4), type: 'file' }));
    case 'bibfile':
      return project.files().filter((f) => f.endsWith('.bib')).map((f) => ({ label: f, type: 'file' }));
    case 'package':
      return PACKAGES.map((p) => ({ label: p, type: 'namespace' }));
  }
}

function latexCompletions(project: LatexProject) {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/\\[a-zA-Z]*\*?/);
    // Not after a line break (\\), where Enter must stay Enter.
    const escaped = word && /(^|[^\\])(\\\\)*$/.exec(context.state.sliceDoc(Math.max(0, word.from - 50), word.from))![2];
    if (word && !escaped) {
      const seen = new Set(BUILTIN_COMMANDS.map((c) => c.label));
      const options = [...BUILTIN_COMMANDS];
      for (const { facts } of projectFacts(project)) {
        for (const c of facts.commands) {
          if (seen.has(c.name)) continue;
          seen.add(c.name);
          options.push(c.args ? commandCompletion(c.name + '{}'.repeat(c.args)) : { label: c.name, type: 'function' });
          options.at(-1)!.type = 'function';
        }
      }
      // Anything else this file already uses.
      for (const m of context.state.sliceDoc(0, 200_000).matchAll(/\\([a-zA-Z]{2,})/g)) {
        if (seen.has(m[1]) || m.index === word.from) continue;
        seen.add(m[1]);
        options.push({ label: m[1], type: 'text', boost: -1 });
      }
      return { from: word.from + 1, options, validFor: /^[a-zA-Z]*\*?$/ };
    }
    const arg = context.matchBefore(/\\([a-zA-Z]+\*?)\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)$/);
    if (!arg) return null;
    const m = /\\([a-zA-Z]+\*?)\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)$/.exec(arg.text)!;
    const kind = argKind(m[1]);
    if (!kind) return null;
    const inside = m[2];
    // Keys in a list (\cite{a, b}) complete one at a time.
    const list = kind === 'ref' || kind === 'cite' || kind === 'package';
    const keyStart = list ? inside.lastIndexOf(',') + 1 + /^\s*/.exec(inside.slice(inside.lastIndexOf(',') + 1))![0].length : 0;
    return {
      from: arg.to - inside.length + keyStart,
      options: argumentOptions(kind, project, context),
      validFor: list ? /^[^{},\s]*$/ : /^[^{}\s]*$/,
    };
  };
}

// ------------------------------------------------------------ extension

/**
 * Enter when the word before the caret already is the selected completion
 * (\item⏎, a finished \cite key): close the list and let Enter be Enter.
 */
function enterPastCompletion(view: EditorView): boolean {
  const { state } = view;
  const picked = completionStatus(state) === 'active' ? selectedCompletion(state) : null;
  if (!picked) return false;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const typed = /[^\s\\{},[\]]*$/.exec(line.text.slice(0, head - line.from))![0];
  if (typed !== picked.label) return false;
  closeCompletion(view);
  return false;
}

// ------------------------------------------------------------ Closing brackets

const OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * Typing a closing bracket right before the same closing bracket steps over
 * it when the document already has enough of them, so \textbf{word|} plus }
 * leaves the group instead of writing }}. closeBrackets only does this for
 * brackets it inserted itself in this session. Escaped \{ \} and comments
 * don't count.
 */
export function shouldStepOver(text: string, pos: number, close: string): boolean {
  const open = OPENER[close];
  if (!open || text[pos] !== close) return false;
  if (text[pos - 1] === '\\') return false; // typing \} is a literal brace
  const clean = stripComments(text);
  let depth = 0;
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '\\') { i++; continue; }
    if (clean[i] === open) depth++;
    else if (clean[i] === close) depth--;
  }
  return depth <= 0;
}

const stepOverClosing = EditorView.inputHandler.of((view, from, to, text) => {
  if (!(text in OPENER) || view.state.readOnly) return false;
  const doc = view.state.doc.toString();
  const ranges = view.state.selection.ranges;
  if (!ranges.every((r) => r.empty && shouldStepOver(doc, r.head, text))) return false;
  view.dispatch(view.state.update({
    selection: EditorSelection.create(ranges.map((r) => EditorSelection.cursor(r.head + 1)),
      view.state.selection.mainIndex),
    scrollIntoView: true, userEvent: 'input.type',
  }));
  return true;
});

export function latexSupport(project: LatexProject): Extension {
  return [
    Prec.highest(keymap.of([{ key: 'Enter', run: enterPastCompletion }])),
    Prec.high(stepOverClosing),
    autocompletion({ override: [latexCompletions(project)], icons: false }),
    keymap.of([{ key: 'Enter', run: latexEnter }]),
    // LaTeX quotes are `` and '', not pairs of ' or ".
    EditorState.languageData.of(() => [{ closeBrackets: { brackets: ['(', '[', '{'] } }]),
  ];
}
