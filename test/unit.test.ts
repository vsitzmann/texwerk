import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import * as Y from 'yjs';
import { cleanPath, cleanProjectName, isBuildArtifact, isEditorTempFile, isTextFile } from '../src/shared/files.ts';
import { applyEditsToYText, editsBetween, setYText } from '../src/shared/textDiff.ts';
import { parseLog } from '../src/server/compile.ts';
import { commitAll, ensureRepo, labels } from '../src/server/git.ts';
import { History } from '../src/server/history.ts';
import { readZip, writeZip } from '../src/server/zip.ts';

test('editsBetween + applyEditsToYText reproduce the target', () => {
  const cases = [
    ['', 'hello'],
    ['hello', ''],
    ['\\section{A}\ntext\n', '\\section{B}\nmore text\n\\end{document}\n'],
    ['aaaa', 'abab'],
    ['same', 'same'],
  ];
  for (const [before, after] of cases) {
    const doc = new Y.Doc();
    const t = doc.getText('t');
    t.insert(0, before);
    applyEditsToYText(t, editsBetween(before, after));
    assert.equal(t.toString(), after);
  }
});

test('setYText keeps a concurrent edit elsewhere in the document', () => {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.getText('t').insert(0, 'line one\nline two\nline three\n');
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  // A replaces the whole file with a version that edits line one; B types in line three.
  setYText(a.getText('t'), 'LINE ONE\nline two\nline three\n');
  b.getText('t').insert(b.getText('t').toString().indexOf('three') + 5, '!');
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  assert.equal(a.getText('t').toString(), 'LINE ONE\nline two\nline three!\n');
  assert.equal(b.getText('t').toString(), a.getText('t').toString());
});

test('paths: unsafe paths and reserved folders are refused', () => {
  assert.equal(cleanPath('figures/a.png'), 'figures/a.png');
  assert.equal(cleanPath('./a//b.tex'), 'a/b.tex');
  assert.equal(cleanPath('../etc/passwd'), null);
  assert.equal(cleanPath('a/../../b'), null);
  assert.equal(cleanPath('.git/config'), null);
  assert.equal(cleanPath('.texwerk/history/log.jsonl'), null);
  assert.equal(cleanPath(''), null);
  assert.equal(cleanProjectName('My Paper'), 'My Paper');
  assert.equal(cleanProjectName('../x'), null);
  assert.equal(cleanProjectName('.hidden'), null);
});

test('file classification', () => {
  assert.equal(isTextFile('main.tex', Buffer.from('\\documentclass{article}')), true);
  assert.equal(isTextFile('fig.png', Buffer.from('not really a png')), false);
  assert.equal(isTextFile('README', Buffer.from('plain words')), true);
  assert.equal(isTextFile('blob', Buffer.from([0, 1, 2, 3])), false);
  assert.equal(isBuildArtifact('main.aux'), true);
  assert.equal(isBuildArtifact('main.synctex.gz'), true);
  assert.equal(isBuildArtifact('main.tex'), false);
  assert.equal(isEditorTempFile('.main.tex.swp'), true);
  assert.equal(isEditorTempFile('main.tex~'), true);
  assert.equal(isEditorTempFile('main.tex.tmp.1234.99'), true);
  assert.equal(isEditorTempFile('main.tex'), false);
});

test('parseLog finds file:line errors, warnings and bad boxes', () => {
  const log = [
    '(./main.tex',
    './main.tex:12: Undefined control sequence.',
    'l.12 \\foo',
    '',
    'LaTeX Warning: Reference `sec:x\' on page 1 undefined on input line 20.',
    '',
    'Overfull \\hbox (3.2pt too wide) in paragraph at lines 30--32',
    './chapters/intro.tex:4: Missing $ inserted.',
  ].join('\n');
  const issues = parseLog(log);
  const errors = issues.filter((i) => i.level === 'error');
  assert.equal(errors.length, 2);
  assert.deepEqual([errors[0].file, errors[0].line], ['main.tex', 12]);
  assert.match(errors[0].message, /Undefined control sequence\. — \\foo/);
  assert.deepEqual([errors[1].file, errors[1].line], ['chapters/intro.tex', 4]);
  const warning = issues.find((i) => i.level === 'warning')!;
  assert.equal(warning.line, 20);
  assert.equal(warning.file, 'main.tex');
  const box = issues.find((i) => i.level === 'badbox')!;
  assert.equal(box.line, 30);
});

test('zip round trip', async () => {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c) => chunks.push(c));
  const files = [
    { name: 'p/main.tex', data: Buffer.from('\\documentclass{article}\n'.repeat(50)) },
    { name: 'p/figures/a.bin', data: Buffer.from([1, 2, 3, 4, 5]) },
  ];
  await writeZip(out, files.map((f) => ({ name: f.name, load: async () => f.data })));
  out.end();
  const entries = readZip(Buffer.concat(chunks));
  assert.deepEqual(entries.map((e) => e.name), files.map((f) => f.name));
  for (const [i, e] of entries.entries()) assert.ok(e.data.equals(files[i].data));
});

test('history coalesces edits, keeps every version, and reconstructs past states', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'texwerk-history-'));
  try {
    const content = new Map<string, string>([['a.tex', 'v1']]);
    const h = new History(dir, async (p) => (content.has(p) ? { data: Buffer.from(content.get(p)!), binary: false } : null));
    await h.load();
    await h.snapshot('a.tex', ['alice'], 'edit');
    content.set('a.tex', 'v2');
    h.touch('a.tex', 'bob');
    h.touch('a.tex', 'carol');
    await h.flush(); // not idle yet: nothing recorded
    assert.equal(h.all().length, 1);
    await h.flush(true);
    assert.equal(h.all().length, 2);
    assert.deepEqual(h.all()[1].authors.sort(), ['bob', 'carol']);
    content.delete('a.tex');
    await h.snapshot('a.tex', ['dave'], 'delete');
    assert.equal(h.all()[2].op, 'delete');
    // Past states and blobs survive a reload from disk.
    const again = new History(dir, async () => null);
    await again.load();
    assert.equal(again.all().length, 3);
    const at2 = again.stateAt(2).get('a.tex')!;
    assert.equal((await again.readBlob(at2.hash!))!.toString(), 'v2');
    assert.equal(again.stateAt(3).has('a.tex'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('labels are git commits that point back into the history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'texwerk-git-'));
  try {
    await ensureRepo(dir);
    await writeFile(join(dir, 'main.tex'), 'hello');
    await import('node:fs/promises').then((fs) => fs.mkdir(join(dir, '.texwerk'), { recursive: true }));
    await writeFile(join(dir, '.texwerk', 'secret'), 'never committed');
    const r = await commitAll(dir, 'First draft', 'Alice', 'alice@example.com', 7);
    assert.ok(r.ok, r.output);
    const [label] = await labels(dir);
    assert.equal(label.message, 'First draft');
    assert.equal(label.author, 'Alice');
    assert.equal(label.historyId, 7);
    const exclude = await readFile(join(dir, '.git', 'info', 'exclude'), 'utf8');
    assert.match(exclude, /^\.texwerk\/$/m);
    const { git } = await import('../src/server/git.ts');
    const tracked = (await git(dir, ['ls-files'])).output.split('\n');
    assert.deepEqual(tracked, ['main.tex']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
