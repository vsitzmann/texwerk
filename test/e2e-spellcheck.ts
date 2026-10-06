/**
 * Spelling and grammar in a real browser: misspellings in prose are
 * underlined, markup (commands, math, citation keys, comments) is not;
 * right-click offers suggestions that edit the file, Add to dictionary, and
 * Ignore; the Spell toggle turns it off.
 *
 *   node test/e2e-spellcheck.ts <serverOrigin> <projectsRoot>   (CHROMIUM=/usr/bin/chromium by default)
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const origin = process.argv[2] ?? 'http://127.0.0.1:5810';
const root = process.argv[3];
if (!root) throw new Error('usage: node test/e2e-spellcheck.ts <serverOrigin> <projectsRoot>');
const project = `spell-test-${Date.now().toString(36)}`;
const q = `?project=${encodeURIComponent(project)}`;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${origin}${path}`, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error}`);
  return j;
};

const MAIN = String.raw`\documentclass{article}
\begin{document}
We propsoe a new metod for \emph{neural} rendering \citep{xyzzyqq2020}. % comented out
The loss $\mathcal{L}_{rcnstr}$ is minimized with Gradeint descent.
\end{document}
`;

await api('POST', '/api/projects', { name: project, blank: true });
await api('PUT', `/api/file${q}&path=main.tex`, MAIN);
await api('POST', `/api/settings${q}`, { mainFile: 'main.tex', autoCompile: false });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
await page.addInitScript(() => localStorage.setItem('texwerk-name', 'Spell Test'));
page.on('pageerror', (e) => { throw e; });

const flagged = () => page.locator('.cm-spell-error').allTextContents();
const onDisk = () => readFile(join(root, project, 'main.tex'), 'utf8');

try {
  await page.goto(`${origin}/${q}&file=main.tex`);
  await page.waitForSelector('.cm-content');
  const t0 = Date.now();
  await page.waitForSelector('.cm-spell-error', { timeout: 30_000 });
  console.log(`first findings after ${Date.now() - t0} ms`);

  assert.deepEqual((await flagged()).sort(), ['Gradeint', 'metod', 'propsoe']);

  // A suggestion replaces the word, and the edit reaches the server.
  await page.locator('.cm-spell-error', { hasText: 'propsoe' }).click({ button: 'right' });
  await page.locator('.menu button', { hasText: /^propose$/ }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.cm-spell-error')].some((e) => e.textContent === 'propsoe'));
  for (let i = 0; i < 50 && !(await onDisk()).includes('We propose a new metod'); i++) await page.waitForTimeout(100);
  assert.match(await onDisk(), /We propose a new metod/);

  // Undo is the person's own: Ctrl+Z puts the typo back.
  await page.keyboard.press('Control+z');
  await page.waitForSelector('.cm-spell-error:text-is("propsoe")');

  // Add to dictionary: never flagged again, also after a reload.
  await page.locator('.cm-spell-error', { hasText: 'metod' }).click({ button: 'right' });
  await page.locator('.menu button', { hasText: 'to dictionary' }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.cm-spell-error')].some((e) => e.textContent === 'metod'));
  await page.reload();
  await page.waitForSelector('.cm-spell-error');
  await page.waitForTimeout(500);
  assert.deepEqual((await flagged()).sort(), ['Gradeint', 'propsoe']);

  // Ignore: gone for this session.
  await page.locator('.cm-spell-error', { hasText: 'Gradeint' }).click({ button: 'right' });
  await page.locator('.menu button', { hasText: /^Ignore$/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.cm-spell-error').length === 1);

  // The toggle turns it off.
  await page.locator('button', { hasText: /^Spell$/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.cm-spell-error').length === 0);
  console.log('spellcheck e2e: ok');
} finally {
  await browser.close();
}
