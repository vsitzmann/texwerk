/**
 * After a compile, viewers download only what changed in the PDF; and a
 * document that always has some error is not recompiled from scratch every
 * time.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyDelta, encodeDelta, PDF_DELTA_TYPE, PDF_HASH_HEADER } from '../src/shared/pdfDelta.ts';
import { startServer } from '../src/server/server.ts';
import type { CompileSummary } from '../src/shared/protocol.ts';

const hasTex = (() => { try { execFileSync('latexmk', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function random(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1103515245) + 12345) | 0; out[i] = x >>> 24; }
  return out;
}

test('a PDF delta rebuilds the new file, and is small when little changed', () => {
  const figure = random(300_000, 1);
  const text = random(5_000, 2);
  const before = new Uint8Array([...text, ...figure, ...random(2_000, 3)]);
  // A longer text pushes the figure along; the trailer is rewritten.
  const after = new Uint8Array([...text.subarray(0, 2_500), ...random(700, 4), ...text.subarray(2_500), ...figure, ...random(2_100, 5)]);
  const cases: Array<[Uint8Array, Uint8Array]> = [
    [before, after], [after, before], [before, before], [new Uint8Array(0), after], [before, new Uint8Array(0)],
    [new Uint8Array(10), new Uint8Array(31)], [random(1000, 6), random(1000, 7)],
  ];
  for (const [a, b] of cases) assert.deepEqual(applyDelta(a, encodeDelta(a, b)), b);
  assert.ok(encodeDelta(before, after).length < 3_500, 'only the changed bytes travel');
  assert.ok(encodeDelta(before, before).length < 30);
  assert.throws(() => applyDelta(before, new Uint8Array([1, 2, 3])));
  const delta = encodeDelta(before, after);
  assert.throws(() => applyDelta(before.subarray(0, 1000), delta), 'a delta for another base does not fit');
  assert.throws(() => applyDelta(before, delta.subarray(0, delta.length - 1)));
});

test('after a compile the viewer gets only what changed', { skip: !hasTex && 'latexmk is not installed' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'texwerk-delta-'));
  const projects = join(root, 'projects');
  await mkdir(join(projects, 'Paper'), { recursive: true });
  // A big incompressible "figure" (a PDF stream with random bytes): the part that should not travel again.
  await writeFile(join(projects, 'Paper', 'blob.bin'), random(400_000, 9));
  await writeFile(join(projects, 'Paper', 'main.tex'), String.raw`\documentclass{article}
\pdfcompresslevel=0
\begin{document}
Version one.
\immediate\pdfobj stream file {blob.bin}
\pdfrefobj\pdflastobj
\end{document}
`);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const s = await startServer({ rootDir: projects, clientDir: null, bridgeFile: null, port, host: '127.0.0.1', access: null });
  t.after(async () => { await s.close(); await rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  const compile = async () => {
    const res = await fetch(`${origin}/api/compile?project=Paper&wait=1`, { method: 'POST' });
    return (await res.json() as { compile: CompileSummary }).compile;
  };
  const pdfUrl = (base: string) => `${origin}/pdf/Paper/output.pdf?rev=1&base=${base}`;

  const first = await compile();
  assert.ok(first.hasPdf && first.pdfHash, 'the summary names the PDF');
  const full = await fetch(pdfUrl(''));
  assert.equal(full.headers.get('content-type'), 'application/pdf');
  assert.equal(full.headers.get(PDF_HASH_HEADER), first.pdfHash);
  const v1 = new Uint8Array(await full.arrayBuffer());
  assert.equal(sha256(v1), first.pdfHash);

  const put = await fetch(`${origin}/api/file?project=Paper&path=main.tex`, {
    method: 'PUT',
    body: String.raw`\documentclass{article}
\pdfcompresslevel=0
\begin{document}
Version two, a little longer.
\immediate\pdfobj stream file {blob.bin}
\pdfrefobj\pdflastobj
\end{document}
`,
  });
  assert.equal(put.status, 200);
  const second = await compile();
  assert.ok(second.pdfHash && second.pdfHash !== first.pdfHash);

  const res = await fetch(pdfUrl(first.pdfHash!));
  assert.equal(res.headers.get('content-type'), PDF_DELTA_TYPE);
  assert.equal(res.headers.get(PDF_HASH_HEADER), second.pdfHash);
  const delta = new Uint8Array(await res.arrayBuffer());
  const v2 = applyDelta(v1, delta);
  assert.equal(sha256(v2), second.pdfHash);
  assert.ok(delta.length < v2.length / 10, `delta ${delta.length} of ${v2.length} bytes`);

  // A base the server no longer has, or none: the whole PDF.
  const unknown = await fetch(pdfUrl('0'.repeat(64)));
  assert.equal(unknown.headers.get('content-type'), 'application/pdf');
  assert.equal(sha256(new Uint8Array(await unknown.arrayBuffer())), second.pdfHash);
  // Downloads and other clients are unchanged.
  const plain = await fetch(`${origin}/pdf/Paper/main.pdf?download`);
  assert.equal(plain.headers.get('content-type'), 'application/pdf');
  assert.match(plain.headers.get('content-disposition') ?? '', /attachment/);
  await plain.arrayBuffer();
});

test('a document with an error is not rerun from scratch on every compile, but is when nothing changed', { skip: !hasTex && 'latexmk is not installed' }, async () => {
  const { runLatexmk } = await import('../src/server/compile.ts');
  const dir = await mkdtemp(join(tmpdir(), 'texwerk-force-'));
  try {
    const settings = { mainFile: 'main.tex', engine: 'pdflatex' as const, autoCompile: false };
    const doc = (word: string) => writeFile(join(dir, 'main.tex'), `\\documentclass{article}\\begin{document}${word} \\ref{missing} \\undefinedmacro\\end{document}\n`);
    await doc('One');
    const runs = (output: string) => (output.match(/^Run number /gm) ?? []).length;
    const first = await runLatexmk(dir, settings);
    assert.ok(!first.ok && first.pdf, 'an error, and a PDF all the same');
    // Edited: latexmk reruns what the edit needs, no more.
    await doc('Two');
    const edited = await runLatexmk(dir, settings, { force: true });
    assert.equal(runs(edited.output), 1, edited.output);
    assert.ok(!edited.upToDate);
    // Unchanged: latexmk would decline ("gave an error in previous invocation"), so it is forced.
    const again = await runLatexmk(dir, settings, { force: true });
    assert.ok(runs(again.output) >= 1, again.output);
    assert.ok(!again.upToDate);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
