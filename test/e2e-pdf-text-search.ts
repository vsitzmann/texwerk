/**
 * Selecting text in the PDF, and Ctrl/Cmd+F in the PDF and in the editor,
 * in a real browser against a running server:
 *
 *   node test/e2e-pdf-text-search.ts <serverOrigin>   (CHROMIUM=/usr/bin/chromium by default)
 *
 * - every drawn page carries a text layer whose words sit on the printed ones,
 *   and dragging across them selects that text;
 * - Ctrl+F after a click in the PDF opens its search bar, which counts the
 *   hits on every page (also one hyphenated across a line), highlights them
 *   on the printed words, and steps through them with Enter;
 * - Ctrl+F after a click in the editor opens the editor's own search.
 */
import { strict as assert } from 'node:assert';
import { chromium } from 'playwright-core';

const origin = process.argv[2] ?? 'http://127.0.0.1:5810';
const project = `search-test-${Date.now().toString(36)}`;
const q = `?project=${encodeURIComponent(project)}`;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${origin}${path}`, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error}`);
  return j;
};

const filler = 'This sentence is only here to fill the paragraph so that the lines wrap naturally across the page width. ';
const main = String.raw`\documentclass{article}
\begin{document}
Opening words of the paper. ${filler.repeat(2)}A zeppelin appears here. ${filler.repeat(3)}
\hsize=8em
Another zeppelin, and \hbox{zep-}\break pelin split by hand. ${filler}
\newpage
\hsize=30em
Page two has a zeppelin too. ${filler}
\end{document}
`;
await api('POST', '/api/projects', { name: project, blank: true });
await api('PUT', `/api/file${q}&path=main.tex`, main);
await api('POST', `/api/settings${q}`, { mainFile: 'main.tex' });
assert.ok((await api('POST', `/api/compile${q}&wait=1`)).compile.hasPdf, 'the test document compiles');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--no-sandbox'] });
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); assert.ok(ok, what); };
try {
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  await page.addInitScript(() => localStorage.setItem('texwerk-name', 'Search Test'));
  await page.goto(`${origin}/${q}&file=main.tex`);
  await page.waitForFunction(() => document.querySelectorAll('.pdf-page .textLayer span').length > 20, null, { timeout: 30_000 });

  const words = await page.evaluate(() => [...document.querySelectorAll('.pdf-page .textLayer span')].map((s) => s.textContent).join(' '));
  check(words.includes('Opening words of the paper'), 'the first page has a text layer with its words');

  // Drag-select the opening words.
  const span = page.locator('.pdf-page .textLayer span', { hasText: 'Opening words' }).first();
  const box = (await span.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const selected = await page.evaluate(() => getSelection()?.toString() ?? '');
  check(/Opening words/.test(selected), `dragging selects the PDF's text ("${selected.slice(0, 40)}")`);

  // Ctrl+F after a click in the PDF: its search bar, prefilled with the selection.
  await page.keyboard.press(`${mod}+f`);
  await page.waitForSelector('.pdf-find input');
  check(await page.evaluate(() => document.activeElement === document.querySelector('.pdf-find input')), 'Ctrl+F over the PDF opens its search bar');
  check((await page.inputValue('.pdf-find input')).startsWith('Opening words'), 'the bar starts with the selected text');
  await page.fill('.pdf-find input', 'zeppelin');
  await page.waitForFunction(() => /of 4$/.test(document.querySelector('.pdf-find .count')?.textContent ?? ''));
  check(true, 'four hits on two pages, two of them hyphenated across a line');
  const pagesWithHits = await page.evaluate(() => [...new Set([...document.querySelectorAll('.pdf-find-hit')].map((h) => [...h.parentElement!.parentElement!.children].indexOf(h.parentElement!) + 1))]);
  check(pagesWithHits.join() === '1,2', `hits are drawn on pages ${pagesWithHits.join(', ')}`);
  // The highlight covers the word in the text layer.
  const overlap = await page.evaluate(() => {
    const hit = document.querySelector('.pdf-find-hit')!.getBoundingClientRect();
    const spans = [...document.querySelectorAll('.pdf-page .textLayer span')].filter((s) => s.textContent!.includes('zep'));
    return spans.some((s) => { const r = s.getBoundingClientRect(); return Math.abs(r.top - hit.top) < 4 && hit.left >= r.left - 2 && hit.right <= r.right + 2; });
  });
  check(overlap, 'the highlight sits on the printed word');
  await page.keyboard.press('Enter');
  check((await page.textContent('.pdf-find .count')) === '2 of 4', 'Enter goes to the next hit');
  await page.keyboard.press('Shift+Enter');
  check((await page.textContent('.pdf-find .count')) === '1 of 4', 'Shift+Enter goes back');
  await page.keyboard.press('Escape');
  check(await page.evaluate(() => !document.querySelector('.pdf-find') && !document.querySelector('.pdf-find-hit')), 'Escape closes the bar and clears the highlights');

  // Ctrl+F after a click in the editor: the editor's own search.
  await page.click('.cm-content');
  await page.keyboard.press(`${mod}+f`);
  await page.waitForSelector('.cm-panel.cm-search');
  check(await page.evaluate(() => Boolean(document.activeElement?.closest('.cm-search'))) && !(await page.$('.pdf-find')), 'Ctrl+F in the editor opens the editor search');
} finally {
  await browser.close();
}
console.log('PDF text and search work');
