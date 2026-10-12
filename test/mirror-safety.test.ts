/**
 * A mirror must never empty a project on the server. These tests run a real
 * server and real `texwerk-connect` processes and do to the mirror folder what
 * people and agents do by accident: delete the folder while the mirror is
 * still running, delete most of its files, start a second mirror on it.
 *
 *   node --test test/mirror-safety.test.ts
 */
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { isMassDeletion } from '../src/shared/deletionGuard.ts';
import { BRIDGE_HEADER } from '../src/shared/protocol.ts';
import { BRIDGE, exited, harness as start, output, sleep, until, type Harness } from './support/mirrorHarness.ts';

const FILES: Record<string, string> = {
  'main.tex': '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n',
  'notes.tex': 'Notes.\n',
  'refs.bib': '@misc{a, title={A}}\n',
  'figures/a.txt': 'figure a\n',
  'figures/b.txt': 'figure b\n',
  'figures/plot.png': '\x89PNG\r\n\x1a\nnot really a png',
  'references/rfp.pdf': '%PDF-1.4 not really a pdf',
};

const ALL = Object.keys(FILES).sort();
const harness = () => start(FILES);

async function mirrored(h: Harness, folder: string): Promise<ChildProcess> {
  const bridge = h.startBridge(folder);
  await until('mirror in sync', async () => JSON.stringify(await h.localFiles(folder)) === JSON.stringify(ALL)
    && existsSync(join(folder, '.texwerk', 'mirror.json')));
  // Let the watcher settle on the freshly written tree.
  await sleep(300);
  return bridge;
}

test('mass-deletion rule', () => {
  assert.equal(isMassDeletion(0, 10), false);
  assert.equal(isMassDeletion(1, 10), false);
  assert.equal(isMassDeletion(5, 10), false, 'half is allowed');
  assert.equal(isMassDeletion(6, 10), true, 'more than half is not');
  assert.equal(isMassDeletion(10, 10), true);
  assert.equal(isMassDeletion(2, 3), false, 'a tiny project may lose two of three files');
  assert.equal(isMassDeletion(3, 3), true, 'but never all of them');
  assert.equal(isMassDeletion(1, 1), true, 'nor its only file');
});

test('deleting the mirror folder while the mirror runs leaves the server untouched', async () => {
  const h = await harness();
  try {
    const folder = join(h.root, 'mirror');
    const bridge = await mirrored(h, folder);
    await rm(folder, { recursive: true, force: true });
    await until('bridge stops', () => exited(bridge));
    await sleep(500);
    assert.deepEqual(await h.serverFiles(), ALL);
    assert.match(output(bridge), /folder .* (was deleted|was replaced|is gone)/);
    assert.ok(!existsSync(folder), 'the bridge must not recreate the deleted folder');
  } finally {
    await h.close();
  }
});

test('the mirror folder deleted and recreated empty (a new mirror on the same path) leaves the server untouched', async () => {
  const h = await harness();
  try {
    const folder = join(h.root, 'mirror');
    const bridge = await mirrored(h, folder);
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder);
    await writeFile(join(folder, 'stray.tex'), 'from somewhere else\n');
    await until('bridge stops', () => exited(bridge));
    await sleep(500);
    assert.deepEqual(await h.serverFiles(), ALL);
  } finally {
    await h.close();
  }
});

test('deleting all files (folder kept) is refused, and the files come back locally', async () => {
  const h = await harness();
  try {
    const folder = join(h.root, 'mirror');
    const bridge = await mirrored(h, folder);
    for (const p of ALL) await rm(join(folder, p));
    await rm(join(folder, 'figures'), { recursive: true });
    await until('files restored locally', async () => JSON.stringify(await h.localFiles(folder)) === JSON.stringify(ALL));
    assert.deepEqual(await h.serverFiles(), ALL);
    assert.equal(await readFile(join(folder, 'main.tex'), 'utf8'), FILES['main.tex']);
    assert.ok(!exited(bridge), 'the mirror keeps running');
    assert.match(output(bridge), /refus/);
  } finally {
    await h.close();
  }
});

test('deleting most files is refused; a normal delete of a file or small folder still goes through', async () => {
  const h = await harness();
  try {
    const folder = join(h.root, 'mirror');
    await mirrored(h, folder);
    // Five of seven: refused.
    for (const p of ['main.tex', 'notes.tex', 'refs.bib', 'figures/a.txt', 'figures/b.txt']) await rm(join(folder, p));
    await until('files restored locally', async () => JSON.stringify(await h.localFiles(folder)) === JSON.stringify(ALL));
    assert.deepEqual(await h.serverFiles(), ALL);
    // One file: deleted.
    await sleep(300);
    await rm(join(folder, 'notes.tex'));
    await until('single delete reaches the server', async () => !(await h.serverFiles()).includes('notes.tex'));
    // A folder with two of the remaining six files: deleted.
    await rm(join(folder, 'references'), { recursive: true });
    await rm(join(folder, 'refs.bib'));
    await until('folder delete reaches the server', async () => {
      const s = await h.serverFiles();
      return !s.includes('references/rfp.pdf') && !s.includes('refs.bib');
    });
    assert.deepEqual(await h.serverFiles(), ['figures/a.txt', 'figures/b.txt', 'figures/plot.png', 'main.tex']);
  } finally {
    await h.close();
  }
});

test('a second mirror on the same folder refuses to start; --stop stops the running one', async () => {
  const h = await harness();
  try {
    const folder = join(h.root, 'mirror');
    const first = await mirrored(h, folder);
    const second = h.startBridge(folder);
    await until('second bridge exits', () => exited(second));
    assert.notEqual(second.exitCode, 0);
    assert.match(output(second), /already mirroring/);
    assert.ok(!exited(first));
    assert.deepEqual(await h.serverFiles(), ALL);

    const stopper = spawn(process.execPath, [BRIDGE, '--stop', folder], { stdio: 'ignore' });
    await new Promise((r) => stopper.once('exit', r));
    await until('first bridge stops', () => exited(first));
    // Now the folder can go without consequences.
    await rm(folder, { recursive: true, force: true });
    await sleep(500);
    assert.deepEqual(await h.serverFiles(), ALL);
  } finally {
    await h.close();
  }
});

test('restarting a mirror on a folder whose files were deleted while it was stopped restores them', async () => {
  const h = await harness();
  try {
    const folder = join(h.root, 'mirror');
    const bridge = await mirrored(h, folder);
    bridge.kill('SIGTERM');
    await until('bridge stops', () => exited(bridge));
    for (const p of ALL) await rm(join(folder, p), { force: true });
    await mirrored(h, folder);
    assert.deepEqual(await h.serverFiles(), ALL);
  } finally {
    await h.close();
  }
});

test('the server refuses mass deletion from a mirror, but not from the browser', async () => {
  const h = await harness();
  try {
    const del = (path: string, bridge: boolean) => fetch(`${h.origin}/api/fs?project=Paper&name=Ann`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bridge ? { [BRIDGE_HEADER]: '1' } : {}) },
      body: JSON.stringify({ op: 'delete', path }),
    });
    // An old bridge deleting file after file, as it did when its folder was removed.
    const statuses: number[] = [];
    for (const p of ALL) statuses.push((await del(p, true)).status);
    assert.ok(statuses.includes(409), `some deletions refused: ${statuses}`);
    const left = await h.serverFiles();
    assert.ok(left.length * 2 >= ALL.length, `at least half the files survive, got ${left}`);
    // People in the browser may delete what they like.
    for (const p of left) assert.equal((await del(p, false)).status, 200, p);
    assert.deepEqual(await h.serverFiles(), []);
  } finally {
    await h.close();
  }
});

test("the agent's caret shows where it edited, goes away when the agent is idle, and with the mirror", async () => {
  const { Awareness } = await import('y-protocols/awareness');
  const Y = await import('yjs');
  const { Provider } = await import('../src/shared/provider.ts');
  process.env.TEXWERK_CARET_IDLE_MS = '1500';
  const h = await harness();
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const provider = new Provider({ url: `${h.origin.replace('http', 'ws')}/ws?project=Paper&name=Bob`, doc, awareness });
  type Peer = { user?: { agent?: boolean }; cursor?: unknown; file?: string | null };
  const agent = () => [...(awareness.getStates() as Map<number, Peer>).values()].find((s) => s.user?.agent);
  try {
    // No compiles running into the end of the test.
    await fetch(`${h.origin}/api/settings?project=Paper&name=Bob`, { method: 'POST', body: JSON.stringify({ autoCompile: false }) });
    const folder = join(h.root, 'mirror');
    const bridge = await mirrored(h, folder);
    await until('agent present', () => Boolean(agent()));
    assert.equal(agent()!.cursor ?? null, null, 'no caret before the agent edits anything');
    await writeFile(join(folder, 'main.tex'), FILES['main.tex'].replace('Hello.', 'Hello, agent.'));
    await until('agent caret shown', () => Boolean(agent()?.cursor) && agent()?.file === 'main.tex');
    const shownAt = Date.now();
    await until('agent caret gone after idling', () => agent() !== undefined && !agent()!.cursor, 5000);
    assert.ok(Date.now() - shownAt > 1000, 'the caret stays while the agent is working');
    // The next edit brings it back; stopping the mirror removes the agent altogether.
    await writeFile(join(folder, 'main.tex'), FILES['main.tex'].replace('Hello.', 'Hello again.'));
    await until('agent caret back', () => Boolean(agent()?.cursor));
    bridge.kill('SIGTERM');
    await until('agent gone with the mirror', () => agent() === undefined);
  } finally {
    delete process.env.TEXWERK_CARET_IDLE_MS;
    provider.destroy();
    doc.destroy();
    await h.close();
  }
});
