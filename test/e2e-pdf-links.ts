/**
 * Hyperlinks in the PDF viewer, and a new comment's pin, in a real browser
 * against a running server:
 *
 *   node test/e2e-pdf-links.ts <serverOrigin>   (CHROMIUM=/usr/bin/chromium by default)
 *
 * - hyperref's \ref, \cite and table of contents scroll the viewer to their
 *   target; \url opens in a new tab;
 * - a comment made while the editor is open gets its pin without a recompile.
 */
import { strict as assert } from 'node:assert';
import { chromium } from 'playwright-core';

const origin = process.argv[2] ?? 'http://127.0.0.1:5810';
const project = `pdf-links-test-${Date.now().toString(36)}`;
const q = `?project=${encodeURIComponent(project)}`;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${origin}${path}`, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error}`);
  return j;
};

const MAIN = String.raw`\documentclass{article}
\usepackage{lipsum}
\usepackage{hyperref}
\begin{document}
\tableofcontents
\section{Intro}
See Section~\ref{sec:far} and \cite{knuth}, or \url{https://example.org/texwerk}.

The sentence about marmalade sandwiches is here.
\lipsum[1-20]
\section{Far away}\label{sec:far}
\lipsum[21-30]
\begin{thebibliography}{9}
\bibitem{knuth} D. Knuth. The TeXbook.
\end{thebibliography}
\end{document}
`;

await api('POST', '/api/projects', { name: project, blank: true });
await api('PUT', `/api/file${q}&path=main.tex`, MAIN);
await api('POST', `/api/settings${q}`, { mainFile: 'main.tex', autoCompile: false });
await api('POST', `/api/compile${q}&wait=1`);
const compiled = await api('POST', `/api/compile${q}&wait=1`); // twice: the toc and \ref
assert.ok(compiled.compile.hasPdf, 'the document compiles');

let failed = false;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed = true; console.log(`FAIL ${name}\n${(e as Error).message}`); }
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
  await page.addInitScript(() => localStorage.setItem('texwerk-name', 'Link Test'));
  await page.goto(`${origin}/${q}`);
  await page.waitForSelector('.pdf-page canvas', { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelectorAll('.pdf-link').length >= 4, null, { timeout: 10_000 });

  await check('\\url opens in a new tab', async () => {
    const href = await page.$eval('a.pdf-link[href^="http"]', (a) => [(a as HTMLAnchorElement).href, (a as HTMLAnchorElement).target]);
    assert.deepEqual(href, ['https://example.org/texwerk', '_blank']);
  });

  const internal = await page.$$eval('a.pdf-link[href="#"]', (els) => els.length);
  await check('internal links scroll the viewer to their target', async () => {
    assert.ok(internal >= 3, `${internal} internal links`);
    // The first is the table of contents' "Intro", which is on page 1 anyway.
    for (let i = 1; i < internal; i++) {
      await page.$eval('.pdf-scroll', (el) => el.scrollTo({ top: 0 }));
      await page.waitForTimeout(200);
      const link = page.locator('a.pdf-link[href="#"]').nth(i);
      if (!(await link.isVisible())) continue;
      await link.click();
      await page.waitForTimeout(1200);
      const top = await page.$eval('.pdf-scroll', (el) => el.scrollTop);
      assert.ok(top > 300, `link ${i} left the viewer at scrollTop ${top}`);
    }
  });

  await check('a comment made in the editor gets its pin without a recompile', async () => {
    const before = await page.$$eval('.pdf-pin', (els) => els.length);
    await page.waitForSelector('.cm-content .cm-line');
    await page.evaluate(() => {
      const walker = document.createTreeWalker(document.querySelector('.cm-content')!, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const at = n.textContent!.indexOf('marmalade sandwiches');
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(n, at);
        range.setEnd(n, at + 'marmalade sandwiches'.length);
        (document.querySelector('.cm-content') as HTMLElement).focus();
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        return;
      }
      throw new Error('no marmalade in the editor');
    });
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+Alt+m');
    await page.waitForSelector('textarea.reply-box');
    await page.keyboard.type('New pin from the editor');
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction((n) => document.querySelectorAll('.pdf-pin').length > n, before, { timeout: 5_000 });
  });

  await check('a comment made through the API gets its pin without a recompile', async () => {
    const before = await page.$$eval('.pdf-pin', (els) => els.length);
    await api('POST', `/api/comments${q}`, { op: 'create', path: 'main.tex', quote: 'Far away', text: 'New pin' });
    await page.waitForFunction((n) => document.querySelectorAll('.pdf-pin').length > n, before, { timeout: 5_000 });
  });
} finally {
  await browser.close();
}
if (failed) process.exit(1);
console.log('pdf links work');
