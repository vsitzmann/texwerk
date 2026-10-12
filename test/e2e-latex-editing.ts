/**
 * LaTeX editing help in a real browser: environments closing on Enter and
 * from the completion list, \item continuation, label/cite/command
 * completion, and vim mode.
 *
 *   node test/e2e-latex-editing.ts <serverOrigin> <projectsRoot>   (CHROMIUM=/usr/bin/chromium by default)
 *
 * Reads the files back from <projectsRoot>, where the server writes them.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const origin = process.argv[2] ?? 'http://127.0.0.1:5810';
const root = process.argv[3];
if (!root) throw new Error('usage: node test/e2e-latex-editing.ts <serverOrigin> <projectsRoot>');
const project = `latex-test-${Date.now().toString(36)}`;
const q = `?project=${encodeURIComponent(project)}`;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${origin}${path}`, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error}`);
  return j;
};

const MAIN = String.raw`\documentclass{article}
\newcommand{\vect}[1]{\mathbf{#1}}
\begin{document}
\section{Intro}\label{sec:intro}
\begin{equation}\label{eq:loss}
x
\end{equation}
@
\end{document}
`;
const BIB = `@article{sitzmann2019srn,
  title={Scene Representation Networks},
  author={Sitzmann, Vincent and Zollh{\\"o}fer, Michael and Wetzstein, Gordon},
  booktitle={NeurIPS}, year={2019},
}
@inproceedings{mildenhall2020nerf,
  title={NeRF: Representing Scenes as Neural Radiance Fields for View Synthesis},
  author={Mildenhall, Ben and Srinivasan, Pratul P. and Tancik, Matthew},
  booktitle={ECCV}, year={2020},
}
`;

await api('POST', '/api/projects', { name: project, blank: true });
await api('PUT', `/api/file${q}&path=refs.bib`, BIB);
await api('PUT', `/api/file${q}&path=main.tex`, MAIN.replace('@', ''));
await api('POST', `/api/settings${q}`, { mainFile: 'main.tex', autoCompile: false });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
await page.addInitScript(() => localStorage.setItem('texwerk-name', 'LaTeX Test'));

const onDisk = () => readFile(join(root, project, 'main.tex'), 'utf8');
/** Reset main.tex, open it, and put the caret where the @ was. */
async function fresh(): Promise<void> {
  await api('PUT', `/api/file${q}&path=main.tex`, MAIN.replace('@', ''));
  await page.goto(`${origin}/${q}`);
  await page.waitForSelector('.cm-content');
  await page.waitForTimeout(400);
  await page.locator('.cm-line', { hasText: /^$/ }).first().click();
}
/** The text between \begin{document} and \end{document}, after the server wrote it. */
async function body(): Promise<string> {
  await page.waitForTimeout(500);
  const text = await onDisk();
  return text.slice(text.indexOf('\\end{equation}\n') + '\\end{equation}\n'.length, text.lastIndexOf('\\end{document}'));
}
const type = (p: Page, s: string) => p.keyboard.type(s, { delay: 15 });
const options = async () => {
  await page.waitForSelector('.cm-tooltip-autocomplete');
  await page.waitForTimeout(150); // CodeMirror ignores Enter right after the list changes
  return page.$$eval('.cm-completionLabel', (els) => els.map((e) => e.textContent));
};

let failed = false;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed = true; console.log(`FAIL ${name}\n${(e as Error).message}`); }
}

try {
  await check('Enter after \\begin{itemize} closes it with an \\item', async () => {
    await fresh();
    await type(page, '\\begin{itemize}');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await type(page, 'one');
    assert.equal(await body(), '\\begin{itemize}\n  \\item one\n\\end{itemize}\n');
  });

  await check('Enter on an item continues the list; on an empty last item leaves it', async () => {
    await page.keyboard.press('Enter');
    await type(page, 'two');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await type(page, 'after');
    assert.equal(await body(), '\\begin{itemize}\n  \\item one\n  \\item two\n\\end{itemize}\nafter\n');
  });

  await check('a finished command, then Enter, is a newline (completion does not eat Enter)', async () => {
    await fresh();
    await type(page, '\\centering');
    await options();
    await page.keyboard.press('Enter');
    await type(page, 'x');
    assert.equal(await body(), '\\centering\nx\n');
  });

  await check('Enter right after \\begin{x} that is already closed is a plain newline', async () => {
    await fresh();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    assert.ok((await onDisk()).includes('\\begin{equation}\\label{eq:loss}\n\nx\n\\end{equation}\n'), await onDisk());
  });

  await check('picking figure from the \\begin{ list inserts the whole environment', async () => {
    await fresh();
    await type(page, '\\begin{figu');
    assert.ok((await options()).includes('figure'));
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab'); // [t] → file
    await type(page, 'img.png');
    await page.keyboard.press('Tab');
    await type(page, 'Cap');
    assert.equal(await body(),
      '\\begin{figure}[t]\n  \\centering\n  \\includegraphics[width=\\linewidth]{img.png}\n  \\caption{Cap}\n  \\label{fig:}\n\\end{figure}\n');
  });

  await check('\\ref{ lists the labels, \\cite{ the bib keys, \\ the project\'s own commands', async () => {
    await fresh();
    await type(page, 'see \\ref{');
    const refs = await options();
    assert.ok(refs.includes('sec:intro') && refs.includes('eq:loss'), refs.join());
    await page.keyboard.press('Escape');
    await type(page, '} \\cite{sitz');
    assert.deepEqual(await options(), ['sitzmann2019srn']);
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowRight');
    await type(page, ' \\vec');
    assert.ok((await options()).includes('vect'));
    await page.keyboard.press('Escape');
    assert.equal(await body(), 'see \\ref{} \\cite{sitzmann2019srn} \\vec\n');
  });

  await check('a command typed out in full is still picked by Enter: \\cite⏎ → \\cite{|}', async () => {
    await fresh();
    await type(page, '\\cite');
    assert.ok((await options()).includes('cite'));
    await page.keyboard.press('Enter');
    // The braces come with the caret inside, and the keys are listed.
    assert.ok((await options()).includes('sitzmann2019srn'));
    await type(page, 'radiance');
    assert.deepEqual(await options(), ['mildenhall2020nerf']);
    await page.keyboard.press('Enter');
    assert.equal(await body(), '\\cite{mildenhall2020nerf}\n');
  });

  await check('\\citep{ searches authors and titles, shows the entry and what matched, one key at a time', async () => {
    await fresh();
    await type(page, '\\citep{mildenhall2020nerf, zollh');
    assert.deepEqual(await options(), ['sitzmann2019srn']);
    const shown = await page.$eval('.cm-tooltip-autocomplete li[aria-selected]', (li) => ({
      text: li.textContent, tag: li.querySelector('.cm-cite-tag')?.textContent, mark: li.querySelector('.cm-cite mark')?.textContent,
    }));
    assert.equal(shown.tag, 'author');
    assert.equal(shown.mark, 'Zollh');
    assert.ok(shown.text!.includes('Scene Representation Networks') && shown.text!.includes('NeurIPS') && shown.text!.includes('2019'), shown.text!);
    await page.waitForSelector('.cm-completionInfo .cm-cite-raw');
    assert.match(await page.textContent('.cm-completionInfo .cm-cite-raw') ?? '', /^@article\{sitzmann2019srn,/);
    await page.keyboard.press('Enter');
    assert.equal(await body(), '\\citep{mildenhall2020nerf, sitzmann2019srn}\n');
  });

  await check('\\\\ then Enter is a line break, not a completion', async () => {
    await fresh();
    await type(page, 'a \\\\');
    await page.keyboard.press('Enter');
    await type(page, 'b');
    assert.equal(await body(), 'a \\\\\nb\n');
  });

  await check('vim mode: dd deletes a line, u brings it back, i inserts', async () => {
    await fresh();
    await type(page, 'keep me');
    await page.waitForTimeout(700); // a separate undo step from the typing
    await page.click('button:has-text("Vim")');
    await page.keyboard.press('Escape');
    await type(page, 'dd');
    await page.waitForTimeout(400);
    assert.ok(!(await onDisk()).includes('keep me'));
    await type(page, 'u');
    await page.waitForTimeout(400);
    assert.ok((await onDisk()).includes('keep me'), 'undo restores the line');
    await type(page, 'A!');
    await page.keyboard.press('Escape');
    assert.equal(await body(), 'keep me!\n');
    await page.click('button:has-text("Vim")');
  });
} finally {
  await browser.close();
}
if (failed) process.exit(1);
console.log('all LaTeX editing checks passed');
