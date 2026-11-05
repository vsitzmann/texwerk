/**
 * From a figure double-clicked in the PDF back to its `\includegraphics`:
 * which one, on which line, and which project file it shows.
 *
 * SyncTeX names the source line of the box clicked, which for a figure is
 * usually the `\includegraphics` itself, but for several figures on one line
 * the line where TeX finished that line of boxes (often the caption below).
 * So the line is a starting point, and the figure's left-to-right position
 * among the figures beside it in the PDF says which include it is.
 */

const INCLUDE = /\\includegraphics\*?\s*(?:\[[^\]]*\]\s*)*\{([^}]*)\}/g;

/** The line without its TeX comment (an unescaped %). */
function uncommented(line: string): string {
  const m = /(^|[^\\])(\\\\)*%/.exec(line);
  return m ? line.slice(0, m.index + m[0].length - 1) : line;
}

/** The file names `\includegraphics` asks for on one line, in order. */
export function includesOnLine(line: string): string[] {
  return [...uncommented(line).matchAll(INCLUDE)].map((m) => m[1].trim());
}

export interface GraphicInclude {
  /** 1-based, like SyncTeX's. */
  line: number;
  /** As written: `fig/plot`, `teaser.pdf`. */
  name: string;
}

/**
 * The include SyncTeX's `line` (1-based) points at, for the figure that is
 * `index`-th from the left of `count` figures side by side in the PDF.
 * Null when there is no `\includegraphics` near the line.
 */
export function findInclude(text: string, line: number, index: number, count: number): GraphicInclude | null {
  const lines = text.split('\n');
  const at = (n: number) => includesOnLine(lines[n - 1] ?? '').map((name) => ({ line: n, name }));
  const pick = (found: GraphicInclude[]) => found[found.length === count ? index : Math.min(index, found.length - 1)];
  const here = at(line);
  if (here.length) return pick(here);
  // Otherwise the includes of the figure around the line, in source order.
  let first = line;
  while (first > 1 && line - first < 15 && !/\\begin\{(figure|wrapfigure|table|subfigure)\*?\}/.test(lines[first - 1] ?? '')) first--;
  let last = line;
  while (last < lines.length && last - line < 3 && !/\\end\{(figure|wrapfigure|table)\*?\}/.test(lines[last - 1] ?? '')) last++;
  const around: GraphicInclude[] = [];
  for (let n = first; n <= last; n++) around.push(...at(n));
  if (!around.length) return null;
  if (around.length === count) return around[index];
  // Can't tell them apart: the nearest one above the line.
  return [...around].reverse().find((f) => f.line <= line) ?? around[0];
}

/** Folders from every `\graphicspath{{a/}{b/}}` in the given sources. */
export function graphicsPaths(sources: string[]): string[] {
  const dirs: string[] = [];
  for (const source of sources) {
    for (const m of source.matchAll(/\\graphicspath\s*\{((?:\s*\{[^}]*\})+)\s*\}/g)) {
      for (const d of m[1].matchAll(/\{([^}]*)\}/g)) dirs.push(d[1].trim());
    }
  }
  return dirs;
}

/** Extensions pdfLaTeX tries for a name without one, in its order. */
const GRAPHIC_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.eps', '.PDF', '.PNG', '.JPG', '.JPEG'];

/**
 * The project file `\includegraphics{name}` shows: tried as written, then in
 * each `\graphicspath` folder, with pdfLaTeX's extensions when it has none;
 * failing that, a file of that name anywhere in the project.
 */
export function resolveGraphic(name: string, files: string[], paths: string[]): string | null {
  const clean = (p: string) => p.replace(/^"|"$/g, '').replace(/^(\.\/)+/, '').replace(/\/{2,}/g, '/');
  const wanted = clean(name.trim());
  if (!wanted) return null;
  const have = new Set(files);
  const names = /\.[a-z0-9]{2,4}$/i.test(wanted) ? [wanted, ...GRAPHIC_EXTENSIONS.map((e) => wanted + e)] : GRAPHIC_EXTENSIONS.map((e) => wanted + e);
  const dirs = ['', ...paths.map((d) => { const c = clean(d); return c && !c.endsWith('/') ? `${c}/` : c; })];
  for (const dir of dirs) {
    for (const n of names) if (have.has(dir + n)) return dir + n;
  }
  const base = names.map((n) => n.split('/').pop()!);
  return files.find((f) => base.some((b) => f === b || f.endsWith(`/${b}`))) ?? null;
}
