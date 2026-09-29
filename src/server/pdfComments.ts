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
}

const cache = new Map<string, PdfPosition | null>();

export async function pdfPosition(project: Project, file: string, line: number): Promise<PdfPosition | null> {
  if (!project.lastPdf || !Number.isFinite(line) || line < 1) return null;
  let stamp = 0;
  try { stamp = statSync(project.lastPdf).mtimeMs; } catch { return null; }
  const key = `${project.lastPdf}|${stamp}|${file}|${line}`;
  if (cache.has(key)) return cache.get(key)!;
  const out = await synctex(project.dir, ['view', '-i', `${line}:0:${join(project.dir, file)}`, '-o', project.lastPdf]);
  const page = Number(/^Page:(\d+)/m.exec(out)?.[1] ?? 0);
  const result = page ? {
    page,
    x: Number(/^h:([\d.]+)/m.exec(out)?.[1] ?? /^x:([\d.]+)/m.exec(out)?.[1] ?? 0),
    y: Number(/^y:([\d.]+)/m.exec(out)?.[1] ?? 0),
  } : null;
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
    const x = width - 34;
    const y = height - pos.y;
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
