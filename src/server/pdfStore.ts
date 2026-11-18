import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeDelta } from '../shared/pdfDelta.ts';

/**
 * The last few compiled PDFs of a project, named by their SHA-256, so that a
 * viewer holding one of them can be sent only what changed (see
 * shared/pdfDelta.ts). They live outside the build folder, so latexmk never
 * writes into a copy someone is downloading and "Recompile from scratch"
 * keeps them, and inside `.texwerk/`, which compiles cannot see.
 */

export const PDF_DIR = join('.texwerk', 'pdfs');
/** Viewers more than this many changed PDFs behind download the whole file. */
const KEEP = 4;
const HASH = /^[0-9a-f]{64}$/;

export function pdfSnapshot(projectDir: string, hash: string | undefined | null): string | null {
  if (!hash || !HASH.test(hash)) return null;
  const path = join(projectDir, PDF_DIR, `${hash}.pdf`);
  return existsSync(path) ? path : null;
}

/** Keeps a copy of the PDF just compiled; returns its hash. */
export async function snapshotPdf(projectDir: string, pdf: string): Promise<string> {
  const bytes = await readFile(pdf);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const dir = join(projectDir, PDF_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${hash}.pdf`);
  if (existsSync(path)) {
    const now = new Date();
    await utimes(path, now, now);
  } else {
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  }
  // Newest first; the rest go.
  const kept = await Promise.all((await readdir(dir)).filter((f) => f.endsWith('.pdf')).map(async (f) => ({ f, t: (await stat(join(dir, f)).catch(() => null))?.mtimeMs ?? 0 })));
  kept.sort((a, b) => b.t - a.t);
  await Promise.all(kept.slice(KEEP).map(({ f }) => rm(join(dir, f), { force: true })));
  return hash;
}

/** Recent deltas: everyone viewing a project asks for the same one after a compile. */
const recent = new Map<string, Uint8Array>();

/**
 * What turns PDF `base` into PDF `target`, or null when the delta would not
 * save much (an unrelated base) or either PDF is gone.
 */
export async function pdfDelta(projectDir: string, base: string, target: string): Promise<Uint8Array | null> {
  const key = `${projectDir}\0${base}\0${target}`;
  const hit = recent.get(key);
  if (hit) return hit;
  const from = pdfSnapshot(projectDir, base);
  const to = pdfSnapshot(projectDir, target);
  if (!from || !to) return null;
  const [a, b] = await Promise.all([readFile(from), readFile(to)]);
  const delta = encodeDelta(a, b);
  if (delta.length > b.length * 0.8) return null;
  recent.set(key, delta);
  if (recent.size > 8) recent.delete(recent.keys().next().value!);
  return delta;
}
