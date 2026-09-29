/**
 * End-to-end check of live co-editing through the mirror bridge.
 *
 *   node test/e2e-bridge.ts <serverOrigin> <project> <mirrorDir>
 *
 * Expects a running server and a running `texwerk-connect.mjs` mirroring
 * <project> into <mirrorDir>. Connects as a second collaborator ("Bob") over
 * the WebSocket and checks that:
 *   1. Bob's typing reaches the local file;
 *   2. a local save reaches Bob;
 *   3. a local save racing Bob's edit keeps both;
 *   4. new local files, binaries and deletions propagate.
 */
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { Provider } from '../src/shared/provider.ts';

const [origin, project, mirror] = process.argv.slice(2);
const doc = new Y.Doc();
const texts = doc.getMap<Y.Text>('text');
const bins = doc.getMap<unknown>('bin');
const ws = new URL(`/ws?project=${encodeURIComponent(project)}&name=Bob`, origin);
ws.protocol = 'ws:';
const synced = new Promise<void>((resolve) => {
  new Provider({ url: ws.href, doc, awareness: new Awareness(doc), onSynced: resolve });
});

async function until(what: string, check: () => Promise<boolean> | boolean, ms = 3000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return Date.now() - start;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out: ${what}`);
}

const file = join(mirror, 'main.tex');
const local = () => readFile(file, 'utf8').catch(() => '');

await synced;
const ytext = texts.get('main.tex')!;
await until('initial mirror', async () => (await local()) === ytext.toString());
console.log('ok   initial mirror matches');

// 1. remote -> local
const at = ytext.toString().indexOf('Start writing here.');
ytext.insert(at, 'Bob was here. ');
let t = await until('remote edit on disk', async () => (await local()).includes('Bob was here.'));
console.log(`ok   remote edit reached local file in ${t} ms`);

// 2. local -> remote
let content = await local();
await writeFile(file, content.replace('\\section{Introduction}', '\\section{Introduction (edited locally)}'));
t = await until('local edit at Bob', () => ytext.toString().includes('(edited locally)'));
console.log(`ok   local save reached collaborator in ${t} ms`);

// 3. race: Bob edits the end while the local file is saved with an edit at the start.
content = await local();
const endAt = ytext.toString().indexOf('\\end{document}');
ytext.insert(endAt, 'Bob appended this.\n\n');
await writeFile(file, content.replace('\\title{Untitled}', '\\title{Raced Title}'));
await until('both edits everywhere', async () => {
  const l = await local();
  const r = ytext.toString();
  return l === r && r.includes('Raced Title') && r.includes('Bob appended this.');
}, 5000);
console.log('ok   concurrent local save + remote edit both kept, and converged');

// 4. new text file, binary, delete
await writeFile(join(mirror, 'intro.tex'), 'Hello from the agent.\n');
t = await until('new file at Bob', () => texts.get('intro.tex')?.toString() === 'Hello from the agent.\n');
console.log(`ok   new local file appeared remotely in ${t} ms`);
await writeFile(join(mirror, 'fig.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
await until('binary at Bob', () => bins.has('fig.png'));
console.log('ok   binary upload');
await rm(join(mirror, 'intro.tex'));
await until('delete at Bob', () => !texts.has('intro.tex'));
console.log('ok   local delete propagated');

// A delete right after a remote edit to the same file (the bridge has just
// rewritten it) is still a delete, not an echo of the bridge's own write.
await writeFile(join(mirror, 'fresh.tex'), 'fresh\n');
await until('fresh at Bob', () => texts.get('fresh.tex')?.toString() === 'fresh\n');
texts.get('fresh.tex')!.insert(0, 'edited by Bob ');
await until('Bob edit on disk', async () => (await readFile(join(mirror, 'fresh.tex'), 'utf8')).startsWith('edited by Bob'));
await rm(join(mirror, 'fresh.tex'));
await until('fast delete at Bob', () => !texts.has('fresh.tex'));
console.log('ok   delete right after a remote edit propagated');

// Clean up our marks so the test can run again.
const r = ytext.toString();
doc.transact(() => {
  ytext.delete(0, ytext.length);
  ytext.insert(0, r.replace('Bob was here. ', '').replace(' (edited locally)', '').replace('Raced Title', 'Untitled').replace('Bob appended this.\n\n', ''));
});
await rm(join(mirror, 'fig.png'));
await until('cleanup', () => !bins.has('fig.png'));
console.log('all bridge checks passed');
process.exit(0);
