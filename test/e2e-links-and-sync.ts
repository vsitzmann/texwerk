/**
 * Comment links, double-click to the PDF, and the lineno override, in a real
 * browser against a running server:
 *
 *   node test/e2e-links-and-sync.ts <serverOrigin>   (CHROMIUM=/usr/bin/chromium by default)
 *
 * - a two-column `lineno[switch]` document compiles with tex/lineno.sty and
 *   numbers the right column on the right (TeX Live 2026's 5.7 does not);
 * - a comment's Link button copies `?project=…&comment=<id>`, and opening that
 *   address shows the thread's card and its text;
 * - double-clicking a word in the editor shows that place in the PDF.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const origin = process.argv[2] ?? 'http://127.0.0.1:5810';
const project = `links-test-${Date.now().toString(36)}`;
const q = `?project=${encodeURIComponent(project)}`;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${origin}${path}`, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error}`);
  return j;
};

const MAIN = String.raw`\documentclass[twocolumn]{article}
\usepackage[switch]{lineno}
\usepackage{lipsum}
\linenumbers
\begin{document}
\lipsum[1-6]

Here is the commented sentence about focal stacks.

\lipsum[7-12]
\end{document}
`;

await api('POST', '/api/projects', { name: project, blank: true });
await api('PUT', `/api/file${q}&path=main.tex`, MAIN);
await api('POST', `/api/settings${q}`, { mainFile: 'main.tex', autoCompile: false });
const compiled = await api('POST', `/api/compile${q}&wait=1`);
assert.ok(compiled.compile.hasPdf, 'the document compiles');

let failed = false;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed = true; console.log(`FAIL ${name}\n${(e as Error).message}`); }
}

await check('lineno comes from tex/ and numbers the right column on the right', async () => {
  const { log } = await api('GET', `/api/compile${q}`);
  assert.match(log, /Package: lineno .* v5\.9/);
  const pdf = await fetch(`${origin}/pdf/${encodeURIComponent(project)}/output.pdf`).then((r) => r.arrayBuffer());
  const text = execFileSync('pdftotext', ['-layout', '-f', '1', '-l', '1', '-', '-'], { input: Buffer.from(pdf) }).toString();
  // With [switch], a line of both columns ends in the right column's number.
  assert.ok(text.split('\n').some((l) => /^\s*\d+\s+\S.*\S\s+\d+\s*$/.test(l)), text.slice(0, 1500));
});

const { id } = await api('POST', `/api/comments${q}`, { op: 'create', path: 'main.tex', quote: 'commented sentence', text: 'Is this right?' });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
const page = await context.newPage();
await page.addInitScript(() => localStorage.setItem('texwerk-name', 'Link Test'));

try {
  await check('the Link button copies an address that opens the thread', async () => {
    await page.goto(`${origin}/${q}`);
    await page.waitForSelector('.cm-content');
    await page.locator('.viewer-tabs .tab', { hasText: 'Comments' }).click();
    await page.locator(`.thread-card[data-id="${id}"] button`, { hasText: 'Link' }).click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(link, `${origin}/?project=${encodeURIComponent(project)}&comment=${id}`);

    // Someone else opens it, with another file showing and the PDF tab up.
    await api('PUT', `/api/file${q}&path=other.tex`, 'other\n');
    await page.goto(`${origin}/${q}&file=other.tex`);
    await page.waitForSelector('.cm-content');
    await page.goto(link);
    await page.waitForSelector(`.thread-card.selected[data-id="${id}"]`);
    assert.equal(await page.locator('.viewer-tabs .tab.active').textContent().then((t) => t?.startsWith('Comments')), true);
    assert.equal(await page.locator('.editor-host').count(), 1);
    await page.waitForFunction(() => document.querySelector('.pane .path')?.textContent === 'main.tex');
    assert.ok(!new URL(page.url()).searchParams.has('comment'), 'the comment parameter is dropped after use');
  });

  await check('a link to a resolved thread lists all threads', async () => {
    await api('POST', `/api/comments${q}`, { op: 'resolve', id });
    await page.goto(`${origin}/?project=${encodeURIComponent(project)}&comment=${id}`);
    await page.waitForSelector(`.thread-card.selected.resolved[data-id="${id}"]`);
    await api('POST', `/api/comments${q}`, { op: 'reopen', id });
  });

  await check('double-clicking a word shows it in the PDF', async () => {
    await page.goto(`${origin}/${q}&file=main.tex`);
    await page.waitForSelector('.cm-content');
    await page.locator('.viewer-tabs .tab', { hasText: 'Comments' }).click();
    await page.waitForTimeout(500);
    await page.locator('.cm-line', { hasText: 'commented sentence' }).getByText('focal', { exact: false }).first().dblclick();
    await page.waitForSelector('.pdf-marker', { timeout: 5000 });
    assert.equal(await page.locator('.viewer-tabs .tab.active').textContent(), 'PDF');
    const selected = await page.evaluate(() => getSelection()?.toString() ?? '');
    assert.ok(selected.length > 0, 'the double-click still selects the word');
  });
} finally {
  await browser.close();
  await api('POST', `/api/projects/delete${q}`).catch(() => undefined);
}
process.exit(failed ? 1 : 0);
