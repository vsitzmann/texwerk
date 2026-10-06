/**
 * The prose of a LaTeX source, for spell and grammar checking: the same
 * string with everything that is not running text (commands, math, comments,
 * citation keys, verbatim blocks, …) blanked to spaces. Lengths and offsets
 * are unchanged, so a checker's findings map straight back onto the source.
 * Newlines are kept, so paragraphs stay paragraphs.
 */

// Environments whose whole body is not prose.
const OPAQUE_ENVS = new Set([
  'equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*', 'gather', 'gather*', 'multline', 'multline*',
  'eqnarray', 'eqnarray*', 'flalign', 'flalign*', 'math', 'displaymath', 'split', 'cases',
  'verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted', 'comment', 'tikzpicture', 'pgfpicture', 'axis',
  'filecontents', 'filecontents*', 'thebibliography',
]);

// Commands whose arguments are keys, paths, lengths or code — never prose.
const OPAQUE_ARGS = new Set([
  'cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'parencite', 'textcite', 'autocite', 'nocite',
  'ref', 'eqref', 'autoref', 'cref', 'Cref', 'pageref', 'nameref', 'vref', 'label',
  'includegraphics', 'input', 'include', 'includeonly', 'subfile', 'bibliography', 'bibliographystyle', 'addbibresource',
  'usepackage', 'RequirePackage', 'documentclass', 'usetikzlibrary', 'graphicspath',
  'begin', 'end', 'url', 'path', 'href', 'hypersetup', 'input',
  'newcommand', 'renewcommand', 'providecommand', 'newenvironment', 'renewenvironment', 'DeclareMathOperator',
  'def', 'let', 'setlength', 'addtolength', 'setcounter', 'addtocounter', 'vspace', 'hspace', 'vspace*', 'hspace*',
  'definecolor', 'color', 'textcolor', 'colorbox', 'pagestyle', 'thispagestyle', 'pagenumbering', 'linespread',
  'fontsize', 'selectfont', 'resizebox', 'scalebox', 'rule', 'raisebox', 'multicolumn', 'multirow', 'cline',
  'newtheorem', 'theoremstyle', 'captionsetup', 'geometry', 'lstinputlisting', 'inputminted', 'verb',
  'setlist', 'newlist', 'titleformat', 'titlespacing', 'tikzset', 'pgfplotsset', 'sisetup', 'lstset', 'tcbset', 'bibitem',
]);

// Definitions: the defined name and the whole body are code.
const DEFINITIONS = new Set([
  'def', 'gdef', 'edef', 'xdef', 'let', 'newcommand', 'renewcommand', 'providecommand', 'newcommand*', 'renewcommand*',
  'DeclareMathOperator', 'DeclareMathOperator*', 'DeclareRobustCommand', 'newenvironment', 'renewenvironment',
]);

// \href{url}{text}: only the first argument is opaque. \textcolor{c}{text} too.
const FIRST_ARG_ONLY = new Set(['href', 'textcolor', 'colorbox']);

const isLetter = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '@';

export function latexProse(src: string): string {
  const out = src.split('');
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let i = Math.max(0, from); i < Math.min(to, n); i++) if (out[i] !== '\n') out[i] = ' ';
  };

  /** End of the balanced group opening at `i` (src[i] is `open`), exclusive. */
  const groupEnd = (i: number, open: string, close: string): number => {
    let depth = 0;
    for (let j = i; j < n; j++) {
      const c = src[j];
      if (c === '\\') { j++; continue; }
      if (c === '%') { while (j < n && src[j] !== '\n') j++; continue; }
      if (c === open) depth++;
      else if (c === close && --depth === 0) return j + 1;
    }
    return n;
  };
  const skipSpace = (i: number) => { while (i < n && (src[i] === ' ' || src[i] === '\t')) i++; return i; };

  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '%') {
      const e = src.indexOf('\n', i);
      blank(i, e < 0 ? n : e);
      i = e < 0 ? n : e;
    } else if (c === '$') {
      const display = src[i + 1] === '$';
      const close = display ? '$$' : '$';
      let j = i + close.length;
      while (j < n && !(src.startsWith(close, j) && src[j - 1] !== '\\')) j++;
      const end = Math.min(n, j + close.length);
      blank(i, end);
      i = end;
    } else if (c === '\\') {
      const next = src[i + 1] ?? '';
      if (next === '(' || next === '[') {
        const close = next === '(' ? '\\)' : '\\]';
        const j = src.indexOf(close, i + 2);
        const end = j < 0 ? n : j + 2;
        blank(i, end);
        i = end;
        continue;
      }
      if (!isLetter(next)) {
        // \\, \%, \&, \_ … — a symbol, not a word.
        blank(i, i + 2);
        i += 2;
        continue;
      }
      let j = i + 1;
      while (j < n && isLetter(src[j])) j++;
      let name = src.slice(i + 1, j);
      if (src[j] === '*') { name += '*'; j++; }
      blank(i, j);
      if (name === 'begin' || name === 'end') {
        const k = skipSpace(j);
        if (src[k] === '{') {
          const e = groupEnd(k, '{', '}');
          const env = src.slice(k + 1, e - 1);
          blank(j, e);
          j = e;
          if (name === 'begin' && OPAQUE_ENVS.has(env)) {
            const endTag = `\\end{${env}}`;
            const at = src.indexOf(endTag, j);
            const stop = at < 0 ? n : at + endTag.length;
            blank(j, stop);
            j = stop;
          } else {
            // Environment arguments: \begin{tabular}{ll}, \begin{figure}[t].
            for (;;) {
              const k2 = skipSpace(j);
              if (src[k2] === '{' || src[k2] === '[') {
                const e2 = groupEnd(k2, src[k2], src[k2] === '{' ? '}' : ']');
                blank(j, e2);
                j = e2;
              } else break;
            }
          }
        }
        i = j;
        continue;
      }
      if (name === 'verb' || name === 'lstinline') {
        const delim = src[j];
        const e = delim ? src.indexOf(delim === '{' ? '}' : delim, j + 1) : -1;
        const stop = e < 0 ? n : e + 1;
        blank(j, stop);
        i = stop;
        continue;
      }
      if (DEFINITIONS.has(name)) {
        // \def\va{{\bm{a}}}, \newcommand{\x}[1]{…}, \def\foo#1{…}: blank to the end of the body.
        let k = skipSpace(j);
        if (src[k] === '\\') { const name0 = ++k; while (k < n && isLetter(src[k])) k++; if (k === name0) k++; }
        for (;;) {
          k = skipSpace(k);
          if (src[k] === '{' || src[k] === '[') k = groupEnd(k, src[k], src[k] === '{' ? '}' : ']');
          else if (src[k] === '#' && /\d/.test(src[k + 1] ?? '')) k += 2;
          else break;
        }
        blank(j, k);
        i = k;
        continue;
      }
      // Optional arguments are options, never prose.
      let k = skipSpace(j);
      while (src[k] === '[') {
        const e = groupEnd(k, '[', ']');
        blank(j, e);
        j = e;
        k = skipSpace(j);
      }
      // A key=value group (\setlist{leftmargin=1em}, \foo{width=3cm}) is settings.
      if (!OPAQUE_ARGS.has(name) && src[k] === '{') {
        const e = groupEnd(k, '{', '}');
        if (/^[\s\w-]+=/.test(src.slice(k + 1, e - 1))) { blank(j, e); j = e; k = skipSpace(j); }
      }
      if (OPAQUE_ARGS.has(name)) {
        let args = 0;
        while (src[k] === '{' && (!FIRST_ARG_ONLY.has(name) || args === 0)) {
          const e = groupEnd(k, '{', '}');
          blank(j, e);
          j = e;
          args++;
          k = skipSpace(j);
          while (src[k] === '[') { const e2 = groupEnd(k, '[', ']'); blank(j, e2); j = e2; k = skipSpace(j); }
        }
      }
      i = j;
    } else if (c === '{' || c === '}' || c === '&' || c === '~' || c === '#' || c === '^' || c === '_') {
      out[i] = ' ';
      i++;
    } else if ((c === '`' || c === "'") && src[i + 1] === c) {
      // TeX quotes ``…'' read as "…".
      // Opening quote hugs the next word, closing quote the previous one.
      out[i] = c === '`' ? ' ' : '"';
      out[i + 1] = c === '`' ? '"' : ' ';
      i += 2;
    } else if (c === '`') {
      out[i] = "'";
      i++;
    } else {
      i++;
    }
  }
  return out.join('');
}

/**
 * Words a spelling checker should leave alone, as word processors do by
 * default: acronyms (ICLR, KV), words with digits (FP8, H200) and initials.
 */
export function isExemptWord(word: string): boolean {
  const w = word.replace(/['’]s$/, '').replace(/\.$/, '');
  return w.length <= 1 || /\d/.test(w) || (w === w.toUpperCase() && w !== w.toLowerCase());
}

/** Files whose content is prose with LaTeX markup. */
export function isProseFile(path: string): boolean {
  return /\.(tex|ltx)$/i.test(path);
}

/**
 * Paragraph-sized chunks of `text` (split at blank lines), with their offsets,
 * so a checker can cache results and only re-check paragraphs that changed.
 */
export function paragraphs(text: string): { from: number; text: string }[] {
  const out: { from: number; text: string }[] = [];
  const re = /\n(?:[ \t]*\n)+/g;
  let start = 0;
  for (let m = re.exec(text); ; m = re.exec(text)) {
    const end = m ? m.index : text.length;
    const chunk = text.slice(start, end);
    if (chunk.trim()) out.push({ from: start, text: chunk });
    if (!m) break;
    start = m.index + m[0].length;
  }
  return out;
}
