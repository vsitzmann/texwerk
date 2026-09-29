import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

export async function runLatexmk(projectDir: string, settings: ProjectSettings): Promise<CompileRun> {
  const outDir = join(projectDir, BUILD_DIR);
  await mkdir(outDir, { recursive: true });
  const main = settings.mainFile;
  if (!main || !existsSync(join(projectDir, main))) {
    return { ok: false, pdf: null, output: `Main file "${main}" not found. Choose a main file in the compile menu.`, log: '', issues: [] };
  }
  const args = [
    ENGINE_FLAG[settings.engine] ?? '-pdf',
    '-f', '-interaction=nonstopmode', '-file-line-error', '-synctex=1',
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
  await writeFile(join(outDir, 'texwerk-output.txt'), output.text);
  const hasErrors = issues.some((i) => i.level === 'error');
  return {
    ok: output.code === 0 && !hasErrors,
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
