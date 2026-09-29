import { statSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import type { CommentThread } from '../shared/comments.ts';
import { synctex } from './compile.ts';
import type { Project } from './project.ts';

/**
 * Comments in the PDF, without touching the LaTeX.
 *
 * SyncTeX already maps source lines to places on the page (it powers
 * double-click-to-source), so a comment's line is enough to know where it
 * lands. The browser draws pins there; `annotatePdf` writes real PDF
 * sticky-note annotations into a copy for download, which every PDF reader
 * shows as comments.
 */

export interface PdfPosition {
  page: number;
  /** PDF points from the page's top-left, as SyncTeX reports them. */
  x: number;
  y: number;
  /** The whole block the source line produced on that page (a paragraph is one line). */
  top: number;
  bottom: number;
}

const cache = new Map<string, PdfPosition | null>();

export async function pdfPosition(project: Project, file: string, line: number): Promise<PdfPosition | null> {
  if (!project.lastPdf || !Number.isFinite(line) || line < 1) return null;
  let stamp = 0;
  try { stamp = statSync(project.lastPdf).mtimeMs; } catch { return null; }
  const key = `${project.lastPdf}|${stamp}|${file}|${line}`;
  if (cache.has(key)) return cache.get(key)!;
  const out = await synctex(project.dir, ['view', '-i', `${line}:0:${join(project.dir, file)}`, '-o', project.lastPdf]);
  // One record per box the line produced (a paragraph gives one per visual
  // line, in no particular order). Keep the first page's, spanning top to bottom.
  const records = out.split(/^Output:/m).slice(1).map((r) => ({
    page: Number(/^Page:(\d+)/m.exec(r)?.[1] ?? 0),
    h: Number(/^h:([\d.]+)/m.exec(r)?.[1] ?? 0),
    v: Number(/^v:([\d.]+)/m.exec(r)?.[1] ?? 0),
    H: Number(/^H:([\d.]+)/m.exec(r)?.[1] ?? 0),
  })).filter((r) => r.page > 0);
  let result: PdfPosition | null = null;
  if (records.length) {
    const page = Math.min(...records.map((r) => r.page));
    const onPage = records.filter((r) => r.page === page);
    const top = Math.min(...onPage.map((r) => r.v - r.H));
    const bottom = Math.max(...onPage.map((r) => r.v));
    result = { page, x: Math.min(...onPage.map((r) => r.h)), y: top + Math.min(10, bottom - top), top, bottom };
  }
  if (cache.size > 5000) cache.clear();
  cache.set(key, result);
  return result;
}

/** A copy of `pdf` with one sticky note per thread, in the right margin at its line. */
export async function annotatePdf(pdf: Buffer, threads: CommentThread[], positions: Array<PdfPosition | null>): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const pages = doc.getPages();
  threads.forEach((thread, i) => {
    const pos = positions[i];
    const page = pos ? pages[pos.page - 1] : undefined;
    if (!pos || !page) return;
    const { width, height } = page.getSize();
    // On the commented words when we know where they are, else in the margin.
    const x = pos.x > 0 ? Math.min(width - 20, Math.max(2, pos.x - 9)) : width - 34;
    const y = height - pos.y + (pos.x > 0 ? 14 : 0);
    const conversation = thread.messages.map((m) => `${m.author}: ${m.text}`).join('\n\n');
    const annot = doc.context.register(doc.context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [x, y - 6, x + 18, y + 12],
      Contents: PDFHexString.fromText(`“${thread.quote.slice(0, 200)}”\n\n${conversation}`),
      T: PDFHexString.fromText(thread.author),
      Name: 'Comment',
      Open: false,
      C: [0.88, 0.69, 0.41],
      F: 4,
    }));
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (annots && 'push' in annots) (annots as unknown as { push: (v: unknown) => void }).push(annot);
    else page.node.set(PDFName.of('Annots'), doc.context.obj([annot]));
  });
  return doc.save({ useObjectStreams: false });
}
