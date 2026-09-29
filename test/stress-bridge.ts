/**
 * Stress test for the mirror bridge.
 *
 *   node test/stress-bridge.ts <serverOrigin> <project> <mirrorDir> [seconds]
 *
 * Two collaborators type into main.tex over the WebSocket while an "agent"
 * keeps rewriting the mirrored file on disk (read, insert a marker line, write
 * back — the way agents and editors save). At the end every marker from all
 * three must be in the document, and the server, both collaborators and the
 * local file must be identical.
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { Provider } from '../src/shared/provider.ts';

const [origin, project, mirror, secondsArg] = process.argv.slice(2);
const seconds = Number(secondsArg ?? 8);
const file = join(mirror, 'main.tex');

async function client(name: string) {
  const doc = new Y.Doc();
  const ws = new URL(`/ws?project=${encodeURIComponent(project)}&name=${name}`, origin);
  ws.protocol = 'ws:';
  await new Promise<void>((resolve) => new Provider({ url: ws.href, doc, awareness: new Awareness(doc), onSynced: resolve }));
  return doc.getMap<Y.Text>('text').get('main.tex')!;
}

const bob = await client('Bob');
const eve = await client('Eve');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const expected: string[] = [];
const run = (Date.now() % 100000).toString(36);
let stop = false;

async function typist(t: Y.Text, name: string, every: number, lane: number) {
  let n = 0;
  while (!stop) {
    const marker = `[${name}${n++}.${run}]`;
    expected.push(marker);
    // Type into a random position at a line start inside the body, char by char.
    const text = t.toString();
    const body = text.indexOf('\\begin{document}');
    // Stay off the \end{document} line, where the agent inserts: typing at the
    // very spot someone else inserts legitimately splits words.
    const end = text.lastIndexOf('\\end{document}');
    // Each typist keeps to its own lines: two people typing at the very same
    // spot at the same moment interleave their letters in any real-time editor.
    const lines = [...text.matchAll(/\n/g)].map((m) => m.index! + 1).filter((i) => i > body && i < end)
      .filter((_, k) => k % 2 === lane);
    const start = lines[Math.floor(Math.random() * lines.length)] ?? text.length;
    // Track the caret the way an editor does, so concurrent inserts elsewhere don't split the marker.
    let caret = Y.createRelativePositionFromTypeIndex(t, start);
    for (const ch of `${marker}\n`) {
      const at = Y.createAbsolutePositionFromRelativePosition(caret, t.doc!)!.index;
      t.insert(at, ch);
      caret = Y.createRelativePositionFromTypeIndex(t, at + 1);
      await sleep(2);
    }
    await sleep(every);
  }
}

async function agent(every: number) {
  let n = 0;
  while (!stop) {
    const marker = `[agent${n++}.${run}]`;
    expected.push(marker);
    const text = readFileSync(file, 'utf8');
    const idx = text.lastIndexOf('\\end{document}');
    const next = `${text.slice(0, idx)}${marker}\n${text.slice(idx)}`;
    const tmp = `${file}.tmp.${process.pid}.${n}`; // how Claude Code saves atomically
    // Half the saves in place, half via rename, like different editors.
    if (n % 2) writeFileSync(file, next); else { writeFileSync(tmp, next); renameSync(tmp, file); }
    await sleep(every);
  }
}

const mode = process.env.MODE ?? 'all';
const runs = [
  ...(mode !== 'agent' ? [typist(bob, 'bob', 30, 0), typist(eve, 'eve', 45, 1)] : []),
  ...(mode !== 'typists' ? [agent(Number(process.env.AGENT_MS ?? 60))] : []),
];
await sleep(seconds * 1000);
stop = true;
await Promise.all(runs);
await sleep(1500);

const server = await (await fetch(`${origin}/raw/${encodeURIComponent(project)}/main.tex`)).text();
const local = readFileSync(file, 'utf8');
const missing = expected.filter((m) => !server.includes(m));
const dupes = expected.filter((m) => server.split(m).length > 2);
console.log(`${expected.length} edits (${expected.filter((m) => m.startsWith('[agent')).length} agent saves)`);
console.log(`converged: server==bob ${server === bob.toString()}, server==eve ${server === eve.toString()}, server==local ${server === local}`);
console.log(`missing: ${missing.length ? missing.join(' ') : 'none'}; duplicated: ${dupes.length ? dupes.join(' ') : 'none'}`);
for (const m of missing) {
  const id = m.slice(1, -1);
  const at = server.indexOf(id);
  console.log(`  ${m}: ${at < 0 ? 'gone entirely' : `fragment found: ${JSON.stringify(server.slice(Math.max(0, at - 12), at + id.length + 12))}`}`);
}
const leftovers = server.match(/\[(bob|eve|agent)\d+\.\w+\]/g)?.filter((m) => !m.endsWith(`.${run}]`)) ?? [];
if (leftovers.length) console.log(`leftovers from earlier runs: ${leftovers.join(' ')}`);
const ok = !missing.length && !dupes.length && server === bob.toString() && server === eve.toString() && server === local
  && server.startsWith('\\documentclass');
console.log(ok ? 'STRESS OK' : 'STRESS FAILED');
// Remove the markers again.
const clean = bob.toString().replace(/\[(bob|eve|agent)\d+\.\w+\]\n/g, '');
bob.doc!.transact(() => { bob.delete(0, bob.length); bob.insert(0, clean); });
await sleep(800);
process.exit(ok ? 0 : 1);
