/**
 * End-to-end check that comment pins land on the commented words in the PDF
 * viewer.
 *
 *   node test/e2e-pdf-pins.ts <serverOrigin>        (CHROMIUM=/usr/bin/chromium by default)
 *
 * Needs a running server (with TeX) that this machine reaches without
 * tailnet headers (loopback counts as the admin). Creates a throwaway
 * project with known text, compiles it, comments on words in the middle of
 * paragraphs, across a line break, and on page 2, opens the editor in a
 * headless browser, and compares every pin's position with where pdf.js
 * itself says the word is printed.
 */
import { strict as assert } from 'node:assert';
import { chromium } from 'playwright-core';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const origin = process.argv[2] ?? 'http://127.0.0.1:5810';
const TOLERANCE_PT = 8;
const project = `pin-test-${Date.now().toString(36)}`;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${origin}${path}`, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error}`);
  return j;
};

const filler = 'This sentence is only here to fill the paragraph so that the lines wrap naturally across the page width. ';
const main = String.raw`\documentclass{article}
\begin{document}
First paragraph. ${filler.repeat(3)}Somewhere in the middle sits the word xylophone before more text. ${filler.repeat(2)}
% a TeX comment that is never printed
Second paragraph. ${filler.repeat(2)}Here comes quintessential photosynthesis again. ${filler.repeat(4)}
\newpage
Page two paragraph. ${filler.repeat(5)}Near the end we mention the zeppelin hangar once. ${filler}
\end{document}
`;

const targets = ['xylophone', 'quintessential photosynthesis', 'zeppelin hangar'];
const q = `?project=${encodeURIComponent(project)}`;
await api('POST', '/api/projects', { name: project, blank: true });
await api('PUT', `/api/file${q}&path=main.tex`, main);
await api('POST', `/api/settings${q}`, { mainFile: 'main.tex' });
const compiled = await api('POST', `/api/compile${q}&wait=1`);
assert.ok(compiled.compile.hasPdf, 'the test document compiles');
for (const quote of targets) await api('POST', `/api/comments${q}`, { op: 'create', path: 'main.tex', quote, text: `PIN ${quote}` });
await api('POST', `/api/comments${q}`, { op: 'create', path: 'main.tex', quote: '% a TeX comment that is never printed', text: 'PIN none' });

// Where pdf.js says each target's first word starts, in PDF points from the page's top-left.
const pdfData = new Uint8Array(await (await fetch(`${origin}/pdf/${encodeURIComponent(project)}/x.pdf`)).arrayBuffer());
const doc = await getDocument({ data: pdfData }).promise;
const expected = new Map<string, { page: number; x: number; y: number }>();
for (let n = 1; n <= doc.numPages; n++) {
  const page = await doc.getPage(n);
  const height = page.getViewport({ scale: 1 }).height;
  for (const item of (await page.getTextContent()).items) {
    if (!('str' in item)) continue;
    for (const t of targets) {
      const word = t.split(' ')[0];
      const at = item.str.indexOf(word);
      if (at < 0 || expected.has(t)) continue;
      const size = Math.hypot(item.transform[2], item.transform[3]);
      expected.set(t, { page: n, x: item.transform[4] + (at / item.str.length) * item.width, y: height - item.transform[5] - size * 0.8 });
    }
  }
}
assert.equal(expected.size, targets.length, 'every target word is printed');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--no-sandbox'] });
let failed = false;
try {
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  await page.addInitScript(() => localStorage.setItem('texwerk-name', 'Pin Test'));
  await page.goto(`${origin}/${q}`);
  await page.waitForFunction((n) => document.querySelectorAll('.pdf-pin').length >= n, targets.length, { timeout: 30_000 });
  await page.waitForTimeout(500);
  const pins = await page.$$eval('.pdf-pin', (els) => els.map((el) => {
    const pageEl = el.parentElement as HTMLElement;
    const index = [...pageEl.parentElement!.children].indexOf(pageEl);
    const markEl = pageEl.querySelector(`.pdf-comment-mark[data-thread="${(el as HTMLElement).dataset.thread}"]`) as HTMLElement;
    return {
      title: (el as HTMLElement).title, page: index + 1, left: parseFloat(markEl.style.left), top: parseFloat(markEl.style.top),
      bubbleTop: (el as HTMLElement).offsetTop, markHeight: markEl.offsetHeight, pageWidthPx: pageEl.clientWidth,
    };
  }));
  const pageWidthPt = (await (await doc.getPage(1)).getViewport({ scale: 1 })).width;
  assert.equal(pins.length, targets.length, 'one pin per printed comment, none for the TeX comment');
  for (const t of targets) {
    const pin = pins.find((p) => p.title.includes(`PIN ${t}`));
    const want = expected.get(t)!;
    assert.ok(pin, `a pin for "${t}"`);
    const scale = pin.pageWidthPx / pageWidthPt;
    const got = { page: pin.page, x: pin.left / scale, y: pin.top / scale };
    const dx = got.x - want.x;
    const dy = got.y - want.y;
    // The margin bubble must be level with the highlighted words.
    const level = Math.abs(pin.bubbleTop - pin.top) <= Math.max(14, pin.markHeight);
    const ok = got.page === want.page && Math.abs(dx) <= TOLERANCE_PT && Math.abs(dy) <= TOLERANCE_PT && level;
    console.log(`${ok ? 'ok  ' : 'FAIL'} "${t}": page ${got.page}/${want.page}, highlight off by ${dx.toFixed(1)} pt across, ${dy.toFixed(1)} pt down; margin bubble ${level ? 'level with it' : 'NOT level'}`);
    if (!ok) failed = true;
  }
} finally {
  await browser.close();
}
if (failed) process.exit(1);
console.log('all pins on their words');
