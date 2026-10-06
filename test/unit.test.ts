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

test('deploy key: one per project, used for its remote, and a first pull adopts the remote', async () => {
  const { ensureDeployKey, readDeployKey, pull, push, git: run } = await import('../src/server/git.ts');
  const base = await mkdtemp(join(tmpdir(), 'texwerk-deploy-'));
  try {
    // A "remote" with one commit on main.
    const remote = join(base, 'remote.git');
    const seed = join(base, 'seed');
    await run(base, ['init', '-q', '--bare', '-b', 'main', remote]);
    await run(base, ['init', '-q', '-b', 'main', seed]);
    await writeFile(join(seed, 'paper.tex'), 'from the remote');
    await run(seed, ['add', '-A']);
    await run(seed, ['-c', 'user.name=x', '-c', 'user.email=x@y', 'commit', '-qm', 'seed']);
    await run(seed, ['push', '-q', remote, 'main']);
    // A fresh project with nothing labelled yet, a stray template file, and the remote.
    const project = join(base, 'project');
    await import('node:fs/promises').then((fs) => fs.mkdir(project));
    await ensureRepo(project);
    await writeFile(join(project, 'paper.tex'), 'template that should be replaced');
    await run(project, ['remote', 'add', 'origin', remote]);
    assert.equal(await readDeployKey(project), null);
    const key = await ensureDeployKey(project, 'texwerk:test');
    assert.match(key, /^ssh-ed25519 \S+ texwerk:test$/);
    assert.equal(await ensureDeployKey(project, 'other'), key, 'the key is created once');
    const pulled = await pull(project, 'Alice', 'alice@test');
    assert.ok(pulled.ok, pulled.output);
    assert.equal(await readFile(join(project, 'paper.tex'), 'utf8'), 'from the remote');
    // Label and push back.
    await writeFile(join(project, 'paper.tex'), 'edited in TeXWerk');
    const labelled = await commitAll(project, 'Edit', 'Alice', 'alice@test', 3);
    assert.ok(labelled.ok, labelled.output);
    const pushed = await push(project);
    assert.ok(pushed.ok, pushed.output);
    assert.match((await run(remote, ['log', '-1', '--format=%s %an'])).output, /^Edit Alice$/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('BibTeX errors are reported against the line that caused them', async () => {
  const { parseBibtexLog } = await import('../src/server/compile.ts');
  const dir = await mkdtemp(join(tmpdir(), 'texwerk-blg-'));
  try {
    await writeFile(join(dir, 'paper.tex'), '\\documentclass{article}\n\\begin{document}\nx\n\\bibliography{refs}\n\\bibliographystyle{styles/icml2024}\n\\end{document}\n');
    const blg = "I couldn't open style file styles/icml2024.bst\n---line 134 of file paper.aux\n : \\bibstyle{styles/icml2024\nI found no style file---while reading file paper.aux\nWarning--empty journal in foo2020\n";
    const issues = parseBibtexLog(blg, dir, 'paper.tex');
    const error = issues.find((i) => i.level === 'error')!;
    assert.match(error.message, /could not find the bibliography style "styles\/icml2024.bst"/);
    assert.deepEqual([error.file, error.line], ['paper.tex', 5]);
    assert.equal(issues.filter((i) => i.level === 'error').length, 1, 'the follow-on "I found no style file" is not a second error');
    assert.ok(issues.some((i) => i.level === 'warning' && /empty journal/.test(i.message)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('LaTeX: an environment knows whether it is closed, and which one is open', async () => {
  const { findEnd, openEnvAt } = await import('../src/client/latex.ts');
  const doc = '\\begin{document}\n\\begin{itemize}\n\\item a\n\\end{itemize}\n\\end{document}\n';
  const after = (s: string) => doc.indexOf(s) + s.length;
  assert.equal(findEnd(doc, after('\\begin{itemize}'), 'itemize').closed, true);
  // A new \begin inside the list has no \end yet.
  const added = doc.replace('\\item a\n', '\\item a\n\\begin{enumerate}\n');
  assert.equal(findEnd(added, added.indexOf('\\begin{enumerate}') + 17, 'enumerate').closed, false);
  // Renamed \begin: balanced, so closed, and its old \end is reported.
  const renamed = doc.replace('\\begin{itemize}', '\\begin{enumerate}');
  const r = findEnd(renamed, renamed.indexOf('\\begin{enumerate}') + 17, 'enumerate');
  assert.equal(r.closed, true);
  assert.equal(r.stale?.name, 'itemize');
  assert.equal(openEnvAt(doc, doc.indexOf('\\item'))?.name, 'itemize');
  assert.equal(openEnvAt(doc, after('\\end{itemize}'))?.name, 'document');
  // Commented-out environments don't count.
  assert.equal(openEnvAt('% \\begin{itemize}\nx', 19), null);
});

test('renaming an open project moves everyone in it, edits made during the move included', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { existsSync, readFileSync } = await import('node:fs');
  const { Awareness } = await import('y-protocols/awareness');
  const { Provider } = await import('../src/shared/provider.ts');
  const { startServer } = await import('../src/server/server.ts');
  const root = await mkdtemp(join(tmpdir(), 'texwerk-rename-'));
  await mkdir(join(root, 'Draft'));
  await writeFile(join(root, 'Draft', 'main.tex'), 'Hello.\n');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = await startServer({ rootDir: root, clientDir: null, bridgeFile: null, port, host: '127.0.0.1', access: null });
  const until = async (what: string, check: () => boolean, ms = 5000) => {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > ms) throw new Error(`timed out: ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const join_ = (name: string) => {
    const doc = new Y.Doc();
    const url = (id: string) => `ws://127.0.0.1:${port}/ws?project=${encodeURIComponent(id)}&name=${name}`;
    let synced = 0;
    const statuses: string[] = [];
    const provider: InstanceType<typeof Provider> = new Provider({
      url: url('Draft'), doc, awareness: new Awareness(doc),
      onSynced: () => { synced++; },
      onStatus: (s, detail) => statuses.push(`${s}${detail ? `:${detail}` : ''}`),
      // What the editor and the bridge do with it.
      onEvent: (event) => { if (event.t === 'moved') provider.setUrl(url(event.to)); },
    });
    return { doc, provider, statuses, synced: () => synced, text: () => doc.getMap<Y.Text>('text').get('main.tex')?.toString() ?? '' };
  };
  const alice = join_('Alice');
  const bob = join_('Bob');
  try {
    await until('both synced', () => alice.synced() > 0 && bob.synced() > 0 && bob.text() === 'Hello.\n');
    const renamed = fetch(`http://127.0.0.1:${port}/api/projects/rename?project=Draft&newName=${encodeURIComponent('Final paper')}&name=Alice`, { method: 'POST' });
    // Bob keeps typing while the folder moves.
    bob.doc.getMap<Y.Text>('text').get('main.tex')!.insert(0, 'Bob. ');
    const r = await renamed;
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { id: 'Final paper' });
    assert.ok(!existsSync(join(root, 'Draft')), 'the old folder is gone');
    await until('both reconnected', () => alice.synced() > 1 && bob.synced() > 1);
    alice.doc.getMap<Y.Text>('text').get('main.tex')!.insert(alice.text().length, 'Alice.\n');
    await until('edits converge', () => alice.text() === 'Bob. Hello.\nAlice.\n' && bob.text() === alice.text());
    await until('on disk under the new name', () => {
      try { return readFileSync(join(root, 'Final paper', 'main.tex'), 'utf8') === 'Bob. Hello.\nAlice.\n'; } catch { return false; }
    });
    // Nothing reopened the old id behind everyone's back.
    assert.ok(!existsSync(join(root, 'Draft')));
    assert.ok(!alice.statuses.concat(bob.statuses).some((s) => s.includes('no project')), 'nobody landed on the old id');
  } finally {
    alice.provider.destroy();
    bob.provider.destroy();
    alice.doc.destroy(); // and with it the awareness and its timer
    bob.doc.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('chat: mentions, refs and the jsonl round trip', async () => {
  const { findMentions, fromJsonl, toJsonl, parseRef, messagesSince, chatMarkdown, mentionsName } = await import('../src/shared/chat.ts');
  assert.deepEqual(findMentions('@Ann Lee and @agent, see this; mail@example.com', ['Ann', 'Ann Lee', 'Bob']).sort(), ['agent', 'ann lee']);
  assert.deepEqual(findMentions('@all: done. @agents is no mention', []), ['all']);
  assert.deepEqual(findMentions('@Bobby', ['Bob']), [], 'a name must end where the mention ends');
  assert.deepEqual(parseRef('sections/intro.tex:12'), { file: 'sections/intro.tex', line: 12 });
  assert.deepEqual(parseRef('comment:ab12cd34'), { commentId: 'ab12cd34' });
  assert.equal(parseRef('main.tex'), null);
  const messages = [
    { id: 'a1', author: 'Ann', login: 'ann@x', agent: false, ts: 1000, text: 'Hi @agent,\nshorten this', mentions: ['agent'], ref: { file: 'main.tex', line: 3 } },
    { id: 'b2', author: 'Ann · agent', login: 'ann@x', agent: true, ts: 2000, text: 'Done.', mentions: [], ref: { commentId: 'c3' } },
    { id: 'c3', author: 'Bob', agent: false, ts: 3000, text: '{"json": "inside"}', mentions: ['everyone'] },
  ];
  const jsonl = toJsonl(messages);
  assert.equal(jsonl.split('\n').filter(Boolean).length, 3);
  assert.deepEqual(fromJsonl(jsonl), messages);
  // A torn last line or a merge marker costs only that line.
  assert.deepEqual(fromJsonl(`${jsonl}<<<<<<< HEAD\n{"id":"x","te`), messages);
  assert.deepEqual(messagesSince(messages, 'a1').map((m) => m.id), ['b2', 'c3']);
  assert.deepEqual(messagesSince(messages, 'c3'), []);
  assert.equal(messagesSince(messages, 'nope').length, 3);
  assert.ok(mentionsName(messages[2], 'Ann'), '@everyone reaches everyone');
  assert.ok(!mentionsName(messages[1], 'Ann'));
  const md = chatMarkdown('Paper', messages, 2);
  assert.ok(md.includes('3 message(s), the newest 2 shown'));
  assert.ok(!md.includes('[a1]') && md.includes('[b2]') && md.includes('Ann · agent: Done. [→ comment c3]'));
});

test('chat is saved to chat.jsonl, restored on open, and committed with labels', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { Project } = await import('../src/server/project.ts');
  const { chatArray } = await import('../src/shared/chat.ts');
  const root = await mkdtemp(join(tmpdir(), 'texwerk-chat-'));
  const dir = join(root, 'Paper');
  await mkdir(dir);
  await writeFile(join(dir, 'main.tex'), 'Hello.\n');
  try {
    const p = new Project('Paper', dir);
    await p.open();
    const m = p.say('Please look at @agent', { author: 'Ann', login: 'ann@x', agent: false }, ['Ann'], { file: 'main.tex', line: 1 });
    assert.deepEqual(m.mentions, ['agent']);
    const woken = p.waitChat(5000);
    p.say('On it.', { author: 'Ann · agent', login: 'ann@x', agent: true }, []);
    await woken;
    await p.close();
    const saved = (await readFile(join(dir, '.texwerk', 'chat.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(saved.map((x) => x.text), ['Please look at @agent', 'On it.']);
    assert.equal(saved[1].agent, true);
    assert.deepEqual(saved[0].ref, { file: 'main.tex', line: 1 });

    // Without the saved document, the chat comes back from the file.
    await rm(join(dir, '.texwerk', 'ydoc.bin'), { force: true });
    const q = new Project('Paper', dir);
    await q.open();
    assert.deepEqual(chatArray(q.doc).toArray().map((x) => x.id), saved.map((x) => x.id));
    // A chat.jsonl changed while the server was down wins over the saved document.
    await q.close();
    await writeFile(join(dir, '.texwerk', 'chat.jsonl'), `${JSON.stringify(saved[0])}\n`);
    const r = new Project('Paper', dir);
    await r.open();
    assert.deepEqual(chatArray(r.doc).toArray().map((x) => x.text), ['Please look at @agent']);
    r.saveChat();
    const c = await commitAll(dir, 'With chat', 'Ann', 'ann@x', -1);
    assert.ok(c.ok, c.output);
    const { execFileSync } = await import('node:child_process');
    assert.ok(execFileSync('git', ['-C', dir, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' }).includes('.texwerk/chat.jsonl'));
    await r.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('agents chat through the mirror: tw say, tw chat, tw chat --wait, chat.md', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { spawn, execFile } = await import('node:child_process');
  const { startServer } = await import('../src/server/server.ts');
  const root = await mkdtemp(join(tmpdir(), 'texwerk-chatbridge-'));
  const mirror = join(root, 'mirror');
  await mkdir(join(root, 'projects', 'Paper'), { recursive: true });
  await writeFile(join(root, 'projects', 'Paper', 'main.tex'), 'Hello.\n');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const origin = `http://127.0.0.1:${port}`;
  const server = await startServer({ rootDir: join(root, 'projects'), clientDir: null, bridgeFile: null, port, host: '127.0.0.1', access: null });
  const bridge = spawn(process.execPath, [join(import.meta.dirname, '../src/bridge/connect.ts'), `${origin}/?project=Paper&name=Ann`, mirror], { stdio: 'ignore' });
  const tw = (...args: string[]) => new Promise<string>((done, fail) =>
    execFile(process.execPath, [join(mirror, '.texwerk', 'tw'), ...args], (err, out, errOut) => (err ? fail(new Error(`${err.message}\n${errOut}`)) : done(out))));
  const until = async (what: string, check: () => Promise<boolean> | boolean, ms = 8000) => {
    const start = Date.now();
    while (!await check()) {
      if (Date.now() - start > ms) throw new Error(`timed out: ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const chatMd = () => readFile(join(mirror, '.texwerk', 'chat.md'), 'utf8').catch(() => '');
  const human = (text: string) => fetch(`${origin}/api/chat?project=Paper&name=Bob`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  try {
    await until('mirror ready', async () => (await chatMd()).startsWith('# Chat in Paper'));
    assert.match(await tw('say', 'Fixed the intro', '--ref', 'main.tex:1'), /^sent \w+/);
    const listed = await tw('chat');
    assert.match(listed, /Ann · agent: Fixed the intro \[→ main\.tex:1\]/);
    await until('chat.md follows', async () => (await chatMd()).includes('Ann · agent: Fixed the intro'));
    const saved = (await (await fetch(`${origin}/api/chat?project=Paper&name=Bob`)).json()) as { messages: Array<{ agent: boolean; login?: string; ref?: unknown }> };
    assert.equal(saved.messages[0].agent, true);
    assert.deepEqual(saved.messages[0].ref, { file: 'main.tex', line: 1 });

    // --wait skips messages that are not for the agent, and returns on @agent.
    let waited = '';
    const waiting = tw('chat', '--wait').then((out) => { waited = out; });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await human('just chatting')).status, 200);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(waited, '', 'a message without @agent does not wake it');
    await human('@agent please shorten the abstract');
    await waiting;
    assert.match(waited, /Bob: @agent please shorten the abstract/);
    assert.ok(!waited.includes('just chatting'));
    // --all: any message by a person.
    const any = tw('chat', '--wait', '--all');
    await new Promise((r) => setTimeout(r, 200));
    await human('hello');
    assert.match(await any, /Bob: hello/);
    const first = saved.messages[0] as unknown as { id: string };
    const after = await tw('chat', '--since', first.id);
    assert.ok(!after.includes('Fixed the intro') && after.includes('Bob: hello'));
  } finally {
    bridge.kill('SIGTERM');
    await new Promise((r) => bridge.once('exit', r));
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('typing a closing bracket steps over an existing one only when balanced', async () => {
  const { shouldStepOver } = await import('../src/client/latex.ts');
  assert.equal(shouldStepOver('\\textbf{word}', 12, '}'), true);
  assert.equal(shouldStepOver('f(x)', 3, ')'), true);
  assert.equal(shouldStepOver('{a{b}', 4, '}'), false); // outer group still open
  assert.equal(shouldStepOver('\\{a\\}', 3, '}'), false); // typing \}
  assert.equal(shouldStepOver('{a}', 1, '}'), false); // not before a closer
  assert.equal(shouldStepOver('{a} % {\n', 2, '}'), true); // comment ignored
  assert.equal(shouldStepOver('\\{ {a}', 5, '}'), true); // escaped brace ignored
});

// ------------------------------------------------------------ spellcheck prose

import { isExemptWord, latexProse, paragraphs } from '../src/shared/prose.ts';

test('latexProse keeps prose at its offsets and blanks markup', () => {
  const src = 'We show in \\cref{fig:teaser} that $x^2$ is \\emph{very} fast~\\citep[p.~3]{smith2020}. % a note\n'
    + '\\begin{equation}\n  E = mc^2\n\\end{equation}\n\\section{Related Work}\n' + "``Quoted'' text \\href{https://x.y}{our site}.";
  const prose = latexProse(src);
  assert.equal(prose.length, src.length);
  assert.equal(prose.split('\n').length, src.split('\n').length);
  const words = prose.split(/\s+/).filter(Boolean);
  assert.deepEqual(words, ['We', 'show', 'in', 'that', 'is', 'very', 'fast', '.', 'Related', 'Work', '"Quoted"', 'text', 'our', 'site', '.']);
  // Each surviving word sits exactly where it is in the source.
  const at = prose.indexOf('very');
  assert.equal(src.slice(at, at + 4), 'very');
});

test('paragraphs splits at blank lines with offsets', () => {
  const text = 'One two.\n\n  \nThree.\nFour.\n\n';
  assert.deepEqual(paragraphs(text), [{ from: 0, text: 'One two.' }, { from: 13, text: 'Three.\nFour.' }]);
});

test('latexProse blanks settings; isExemptWord skips acronyms, numbers and initials', () => {
  assert.equal(latexProse('\\setlist{leftmargin=1em}\\foo{width=3cm} ok').trim(), 'ok');
  assert.equal(latexProse('\\def\\va{{\\bm{a}}}\\newcommand{\\R}[1]{\\mathbb{R}^{#1}} ok \\def\\foo#1{a #1} fine').replace(/\s+/g, ' ').trim(), 'ok fine');
  for (const w of ['ICLR', 'FP8', 'H200', 'S.', "ORCD's", 'x']) assert.ok(isExemptWord(w), w);
  for (const w of ['metod', 'Gradeint', 'NeRF']) assert.ok(!isExemptWord(w), w);
});
