/**
 * Fuzzer for the mirror: random sequences of what people and agents do to a
 * mirror folder — edit, create, delete a file or a folder, and the accidents:
 * `rm -rf` of the folder while the mirror runs, deleting most of the files,
 * a second mirror on the same folder, deleting files while the mirror is
 * stopped. After every step the server must hold exactly what a model of the
 * legitimate changes says, and the mirror the same files as the server.
 *
 *   node --test test/mirror-fuzz.test.ts
 *   FUZZ_SEEDS=1,2,3 FUZZ_STEPS=60 node --test test/mirror-fuzz.test.ts
 *
 * A failure prints the seed and the steps so far; rerun with FUZZ_SEEDS=<seed>.
 */
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { isMassDeletion, MASS_DELETION_WINDOW_MS } from '../src/shared/deletionGuard.ts';
import { BRIDGE, exited, harness, output, sleep, until, type Harness } from './support/mirrorHarness.ts';

const SEEDS = (process.env.FUZZ_SEEDS ?? `${Date.now() % 100000},7`).split(',').map(Number);
const STEPS = Number(process.env.FUZZ_STEPS ?? 25);

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const START: Record<string, string> = {
  'main.tex': 'Main.\n',
  'intro.tex': 'Intro.\n',
  'figures/a.txt': 'a\n',
  'figures/b.txt': 'b\n',
  'figures/c.txt': 'c\n',
  'appendix/x.tex': 'x\n',
};

for (const seed of SEEDS) {
  test(`mirror fuzz, seed ${seed}, ${STEPS} steps`, async () => {
    const random = rng(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)];
    const h: Harness = await harness(START);
    /** What the server must hold: path -> content. */
    const model = new Map(Object.entries(START));
    const steps: string[] = [];
    let n = 0;
    let folder = '';
    let bridge: ChildProcess | null = null;

    const files = () => [...model.keys()].sort();
    const sameFiles = async (dir: string) => JSON.stringify(await h.localFiles(dir)) === JSON.stringify(files());
    const startMirror = async () => {
      folder = join(h.root, `mirror-${n++}`);
      bridge = h.startBridge(folder);
      await until('mirror in sync', async () => (await sameFiles(folder)) && existsSync(join(folder, '.texwerk', 'mirror.json')));
      await sleep(250);
    };
    const check = async (what: string) => {
      // Wait for quiet: deletions are batched (~400 ms), uploads settle (~200 ms).
      await until(`${what}: server matches the model`, async () => JSON.stringify(await h.serverFiles()) === JSON.stringify(files()), 6000);
      for (const [p, content] of model) {
        await until(`${what}: server content of ${p}`, async () => (await readFile(join(h.projectDir, p), 'utf8').catch(() => null)) === content, 6000);
      }
      if (bridge && !exited(bridge)) await until(`${what}: mirror matches the server`, () => sameFiles(folder), 6000);
    };

    const ops: Array<[number, () => Promise<string | null>]> = [
      [4, async () => { // edit a file
        const p = pick(files());
        const content = `${model.get(p)}edit ${steps.length}\n`;
        await writeFile(join(folder, p), content);
        model.set(p, content);
        return `edit ${p}`;
      }],
      [3, async () => { // create a file, sometimes in a new folder
        const dir = pick(['', 'figures/', 'appendix/', `new${steps.length}/`]);
        const p = `${dir}f${steps.length}.tex`;
        await mkdir(join(folder, dir), { recursive: true });
        await writeFile(join(folder, p), `new ${steps.length}\n`);
        model.set(p, `new ${steps.length}\n`);
        return `create ${p}`;
      }],
      [3, async () => { // delete one file
        const p = pick(files());
        await rm(join(folder, p));
        if (!isMassDeletion(1, model.size)) model.delete(p);
        return `delete ${p}`;
      }],
      [2, async () => { // delete a folder
        const dirs = [...new Set(files().filter((p) => p.includes('/')).map((p) => p.split('/')[0]))];
        if (!dirs.length) return null;
        const d = pick(dirs);
        const inside = files().filter((p) => p.startsWith(`${d}/`));
        await rm(join(folder, d), { recursive: true });
        if (!isMassDeletion(inside.length, model.size)) for (const p of inside) model.delete(p);
        return `delete folder ${d} (${inside.length} of ${model.size} files)`;
      }],
      [1, async () => { // accident: delete most or all files, folder kept
        const all = files();
        const count = Math.max(Math.ceil(all.length * 0.6), Math.min(all.length, 3));
        const doomed = all.slice(0, count);
        for (const p of doomed) await rm(join(folder, p));
        if (!isMassDeletion(doomed.length, all.length)) for (const p of doomed) model.delete(p);
        return `delete ${doomed.length} of ${all.length} files`;
      }],
      [1, async () => { // accident: rm -rf the folder while the mirror runs
        const b = bridge!;
        await rm(folder, { recursive: true, force: true });
        await until('the mirror stops', () => exited(b));
        assert.ok(!existsSync(folder), 'the stopped mirror must not recreate its folder');
        await startMirror();
        return 'rm -rf the mirror folder';
      }],
      [1, async () => { // accident: rm -rf, and a new mirror set up on the same path right away
        const b = bridge!;
        const path = folder;
        await rm(path, { recursive: true, force: true });
        await mkdir(path);
        await until('the old mirror stops', () => exited(b));
        await rm(path, { recursive: true, force: true });
        await startMirror();
        return 'rm -rf and recreate the mirror folder';
      }],
      [1, async () => { // a second mirror on the same folder
        const second = h.startBridge(folder);
        await until('the second mirror refuses', () => exited(second));
        assert.match(output(second), /already mirroring/);
        return 'second mirror on the same folder';
      }],
      [1, async () => { // files deleted while the mirror is stopped, then restarted
        const b = bridge!;
        const stopper = spawn(process.execPath, [BRIDGE, '--stop', folder], { stdio: 'ignore' });
        await new Promise((r) => stopper.once('exit', r));
        await until('the mirror stops', () => exited(b));
        for (const p of files().slice(0, Math.ceil(model.size / 2))) await rm(join(folder, p), { force: true });
        bridge = h.startBridge(folder);
        await until('mirror in sync', () => sameFiles(folder));
        return 'delete files while stopped, restart';
      }],
    ];
    const weighted = ops.flatMap(([w, op]) => Array<() => Promise<string | null>>(w).fill(op));

    try {
      await startMirror();
      for (let i = 0; i < STEPS; i++) {
        const before = model.size;
        const step = await pick(weighted)();
        if (step === null) continue;
        steps.push(step);
        await check(step);
        // Deletions closer together than this are one batch on the server;
        // keep the steps apart so the model (one step, one batch) holds.
        if (step.startsWith('delete')) await sleep(MASS_DELETION_WINDOW_MS);
        assert.ok(!isMassDeletion(before - model.size, before), 'the model itself never loses most of the project');
      }
    } catch (err) {
      (err as Error).message = `seed ${seed} failed after steps:\n  ${steps.join('\n  ')}\n${(err as Error).message}\nmirror log:\n${bridge ? output(bridge) : ''}`;
      throw err;
    } finally {
      await h.close();
    }
  });
}
