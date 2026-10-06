/** A real server and real `texwerk-connect` processes, for the mirror safety tests and fuzzer. */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const BRIDGE = join(import.meta.dirname, '../../src/bridge/connect.ts');

export interface Harness {
  root: string;
  origin: string;
  projectDir: string;
  bridges: ChildProcess[];
  startBridge(folder: string): ChildProcess;
  serverFiles(): Promise<string[]>;
  localFiles(folder: string): Promise<string[]>;
  close(): Promise<void>;
}

export async function harness(files: Record<string, string>): Promise<Harness> {
  const { startServer } = await import('../../src/server/server.ts');
  const root = await mkdtemp(join(tmpdir(), 'texwerk-safety-'));
  const projectDir = join(root, 'projects', 'Paper');
  for (const [p, content] of Object.entries(files)) {
    await mkdir(join(projectDir, p, '..'), { recursive: true });
    await writeFile(join(projectDir, p), content, 'latin1');
  }
  const port = 20000 + Math.floor(Math.random() * 20000);
  const origin = `http://127.0.0.1:${port}`;
  const server = await startServer({ rootDir: join(root, 'projects'), clientDir: null, bridgeFile: null, port, host: '127.0.0.1', access: null });
  const bridges: ChildProcess[] = [];
  const list = async (dir: string, skip: (name: string) => boolean): Promise<string[]> => {
    const out: string[] = [];
    const walk = async (d: string, rel: string) => {
      let entries;
      try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (skip(e.name)) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(join(d, e.name), r);
        else out.push(r);
      }
    };
    await walk(dir, '');
    return out.sort();
  };
  return {
    root,
    origin,
    projectDir,
    bridges,
    startBridge(folder) {
      const bridge = spawn(process.execPath, [BRIDGE, `${origin}/?project=Paper&name=Ann`, folder],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      bridge.stdout!.on('data', (d) => { output += d; });
      bridge.stderr!.on('data', (d) => { output += d; });
      (bridge as ChildProcess & { output: () => string }).output = () => output;
      bridges.push(bridge);
      return bridge;
    },
    serverFiles: () => list(projectDir, (n) => n === '.texwerk' || n === '.git'),
    localFiles: (folder) => list(folder, (n) => n === '.texwerk' || n.startsWith('.texwerk-tmp-')),
    async close() {
      for (const b of bridges) {
        if (b.exitCode === null && b.signalCode === null) {
          b.kill('SIGTERM');
          await new Promise((r) => b.once('exit', r));
        }
      }
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function until(what: string, check: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!await check()) {
    if (Date.now() - start > ms) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const exited = (b: ChildProcess) => b.exitCode !== null || b.signalCode !== null;
export const output = (b: ChildProcess) => (b as ChildProcess & { output: () => string }).output();
