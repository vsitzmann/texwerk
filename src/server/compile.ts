import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { CompileIssue, ProjectSettings } from '../shared/protocol.ts';

/**
 * One latexmk run in the project folder, output into `.texwerk/build`.
 *
 * Runs non-stop and forced (-f) like Overleaf, so a document with errors
 * still produces as much PDF as TeX manages. Shell escape stays at TeX's
 * restricted default. The combined latexmk output and the TeX log are kept
 * for the Log panel; the log is also parsed into a list of errors and
 * warnings with file and line.
 */

export const BUILD_DIR = join('.texwerk', 'build');
const TIMEOUT_MS = 240_000;

export interface CompileRun {
  ok: boolean;
  upToDate: boolean;
  pdf: string | null;
  output: string;
  log: string;
  issues: CompileIssue[];
}

const ENGINE_FLAG: Record<ProjectSettings['engine'], string> = {
  pdflatex: '-pdf',
  xelatex: '-pdfxe',
  lualatex: '-pdflua',
};

/**
 * `force` reruns TeX even when latexmk thinks nothing changed — after a failed
 * run the sources may be the same while the environment is not (a package
 * installed, a figure fixed outside the project). `clean` empties the build
 * directory first ("Recompile from scratch").
 */
export async function runLatexmk(projectDir: string, settings: ProjectSettings, opts: { force?: boolean; clean?: boolean } = {}): Promise<CompileRun> {
  const outDir = join(projectDir, BUILD_DIR);
  if (opts.clean) await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const main = settings.mainFile;
  if (!main || !existsSync(join(projectDir, main))) {
    return { ok: false, upToDate: false, pdf: null, output: `Main file "${main}" not found. Choose a main file in the compile menu.`, log: '', issues: [] };
  }
  const args = [
    ENGINE_FLAG[settings.engine] ?? '-pdf',
    '-f', ...(opts.force ? ['-g'] : []), '-interaction=nonstopmode', '-file-line-error', '-synctex=1',
    `-outdir=${outDir}`, main,
  ];
  const output = await new Promise<{ code: number | null; text: string }>((resolve) => {
    let text = '';
    const child = spawn('latexmk', args, { cwd: projectDir, env: { ...process.env, max_print_line: '1000' } });
    const timer = setTimeout(() => { text += '\n[TeXWerk] Compile timed out and was stopped.\n'; child.kill('SIGKILL'); }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { text += d; });
    child.stderr.on('data', (d) => { text += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, text: `${text}\n[TeXWerk] Could not start latexmk: ${err.message}. Is TeX Live installed on the server?\n` });
    });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, text }); });
  });
  const stem = basename(main).replace(/\.[^.]+$/, '');
  let log = '';
  try { log = await readFile(join(outDir, `${stem}.log`), 'latin1'); } catch { /* no log */ }
  const pdfPath = join(outDir, `${stem}.pdf`);
  const issues = parseLog(log);
  // BibTeX reports into its own log; a missing style or database there only
  // shows up as "??" citations otherwise.
  try { issues.unshift(...parseBibtexLog(await readFile(join(outDir, `${stem}.blg`), 'latin1'), projectDir, main)); } catch { /* no bibtex run */ }
  await writeFile(join(outDir, 'texwerk-output.txt'), output.text);
  const hasErrors = issues.some((i) => i.level === 'error');
  return {
    ok: output.code === 0 && !hasErrors,
    upToDate: /All targets .* are up-to-date/.test(output.text),
    pdf: existsSync(pdfPath) ? pdfPath : null,
    output: output.text,
    log,
    issues,
  };
}

/** Pull errors, warnings and bad boxes out of a TeX log. */
export function parseLog(log: string): CompileIssue[] {
  const issues: CompileIssue[] = [];
  const lines = log.split(/\r?\n/);
  const seen = new Set<string>();
  const push = (issue: CompileIssue) => {
    const key = `${issue.level}|${issue.file}|${issue.line}|${issue.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = /^(\.?\/?[^:\s][^:]*\.(?:tex|sty|cls|bib|ltx|bbl|tikz)):(\d+): (.*)$/.exec(line);
    if (m) {
      let message = m[3];
      // The context lines after an error ("l.12 \foo") help; keep one.
      const context = lines.slice(i + 1, i + 4).find((l) => /^l\.\d+/.test(l));
      if (context) message += ` — ${context.replace(/^l\.\d+\s*/, '').trim()}`;
      push({ level: 'error', file: m[1].replace(/^\.\//, ''), line: Number(m[2]), message });
      continue;
    }
    if (line.startsWith('! ')) {
      push({ level: 'error', file: '', line: null, message: line.slice(2) });
      continue;
    }
    m = /^(LaTeX|Package [\w-]+|Class [\w-]+) Warning: (.*)$/.exec(line);
    if (m) {
      let message = m[2];
      let j = i + 1;
      while (j < lines.length && /^\(\S*\)\s+/.test(lines[j])) { message += ` ${lines[j].replace(/^\(\S*\)\s+/, '')}`; j++; }
      const at = /on input line (\d+)/.exec(message);
      push({ level: 'warning', file: currentFile(lines, i), line: at ? Number(at[1]) : null, message: `${m[1]}: ${message}` });
      continue;
    }
    if (/^(Over|Under)full \\[hv]box/.test(line)) {
      const at = /lines? (\d+)/.exec(line);
      push({ level: 'badbox', file: currentFile(lines, i), line: at ? Number(at[1]) : null, message: line.trim() });
    }
  }
  return issues;
}

/** Errors from a BibTeX log, pointed at the line of the main file that caused them. */
export function parseBibtexLog(blg: string, projectDir: string, mainFile: string): CompileIssue[] {
  const issues: CompileIssue[] = [];
  let source = '';
  try { source = readFileSync(join(projectDir, mainFile), 'utf8'); } catch { /* unreadable */ }
  const lineOf = (pattern: RegExp) => {
    const i = source.search(pattern);
    return i < 0 ? null : source.slice(0, i).split('\n').length;
  };
  for (const m of blg.matchAll(/^I couldn't open (style|database) file (\S+)/gm)) {
    const what = m[1] === 'style' ? 'bibliography style' : 'bibliography database';
    issues.push({
      level: 'error',
      file: mainFile,
      line: lineOf(m[1] === 'style' ? /\\bibliographystyle\s*\{/ : /\\bibliography\s*\{/),
      message: `BibTeX could not find the ${what} "${m[2]}" — citations will show as ??`,
    });
  }
  for (const m of blg.matchAll(/^(.*)---line (\d+) of file (\S+)$/gm)) {
    if (!m[1].trim() || /couldn't open|I found no/.test(m[1])) continue;
    issues.push({ level: 'error', file: m[3], line: Number(m[2]), message: `BibTeX: ${m[1].trim()}` });
  }
  for (const m of blg.matchAll(/^Warning--(.*)$/gm)) {
    issues.push({ level: 'warning', file: '', line: null, message: `BibTeX: ${m[1].trim()}` });
  }
  return issues;
}

/**
 * Best effort: the innermost "(./file.tex" opened before line `index`.
 * TeX's parenthesis tracking in logs is famously unreliable; this is only
 * used for warnings, where -file-line-error does not help.
 */
function currentFile(lines: string[], index: number): string {
  for (let i = index; i >= 0 && i > index - 400; i--) {
    const all = [...lines[i].matchAll(/\((\.\/[^\s()]+\.(?:tex|ltx))/g)];
    if (all.length) return all[all.length - 1][1].replace(/^\.\//, '');
  }
  return '';
}

/** SyncTeX: PDF position -> source line, and back. */
export function synctex(projectDir: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('synctex', args, { cwd: projectDir });
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out));
  });
}
