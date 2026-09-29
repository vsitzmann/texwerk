import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { extensionOf, IMAGE_EXTENSIONS } from '@shared/files.ts';
import type { CompileIssue, CompileSummary } from '@shared/protocol.ts';
import { h, withName } from './ui.ts';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * The right-hand pane: the compiled PDF by default, the compile log, or the
 * file picked in the tree (images and PDFs rendered, anything else offered
 * as a download). The PDF keeps its scroll position across recompiles and
 * supports SyncTeX both ways.
 */

type Tab = 'pdf' | 'log' | 'comments' | 'file';

/** A comment's pin on the PDF, at its SyncTeX position. */
export interface PdfPin {
  id: string;
  page: number;
  y: number;
  color: string;
  title: string;
}

export interface ViewerOptions {
  project: string;
  onJumpToSource: (file: string, line: number) => void;
  onCloseFile: () => void;
  onSyncFromCursor: () => void;
  onPinClick: (id: string, rect: DOMRect) => void;
  /** A new PDF finished loading (pins need fresh positions). */
  onPdfLoaded: () => void;
}

class PdfView {
  readonly scroll = h('div', { class: 'pdf-scroll' });
  private readonly pagesEl = h('div', { class: 'pdf-pages' });
  private doc: PDFDocumentProxy | null = null;
  private task: PDFDocumentLoadingTask | null = null;
  private pages: Array<{ el: HTMLDivElement; page: PDFPageProxy; rendered: number; width: number; height: number }> = [];
  private observer: IntersectionObserver;
  scale = 1;
  fitWidth = true;
  private loadToken = 0;
  onZoom: (() => void) | null = null;
  onDoubleClick: ((page: number, x: number, y: number) => void) | null = null;
  onPinClick: ((id: string, rect: DOMRect) => void) | null = null;
  private pins: PdfPin[] = [];

  /** Pins in the right margin of each page; several on one spot stack. */
  setPins(pins: PdfPin[]): void {
    this.pins = pins;
    this.drawPins();
  }

  private drawPins(): void {
    for (const el of this.pagesEl.querySelectorAll('.pdf-pin')) el.remove();
    const taken = new Map<string, number>();
    for (const pin of this.pins) {
      const p = this.pages[pin.page - 1];
      if (!p) continue;
      const top = Math.max(0, pin.y * this.scale - 11);
      const key = `${pin.page}:${Math.round(top / 18)}`;
      const n = taken.get(key) ?? 0;
      taken.set(key, n + 1);
      const el = h('button', { class: 'pdf-pin', title: pin.title, style: `top:${top}px;right:${6 + n * 16}px;--c:${pin.color}` });
      el.addEventListener('click', (e) => { e.stopPropagation(); this.onPinClick?.(pin.id, el.getBoundingClientRect()); });
      el.addEventListener('dblclick', (e) => e.stopPropagation());
      p.el.append(el);
    }
  }

  constructor() {
    this.scroll.append(this.pagesEl);
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) void this.renderPage(Number((entry.target as HTMLElement).dataset.index));
      }
    }, { root: this.scroll, rootMargin: '600px 0px' });
    new ResizeObserver(() => { if (this.fitWidth && this.doc) this.applyScale(this.fitScale()); }).observe(this.scroll);
    this.scroll.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    }, { passive: false });
  }

  async load(url: string): Promise<void> {
    const token = ++this.loadToken;
    const task = pdfjs.getDocument({ url });
    let doc: PDFDocumentProxy;
    try { doc = await task.promise; } catch { return; }
    if (token !== this.loadToken) { void task.destroy(); return; }
    const pages: typeof this.pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const el = h('div', { class: 'pdf-page', 'data-index': String(i - 1) }) as HTMLDivElement;
      el.addEventListener('dblclick', (e) => {
        const rect = el.getBoundingClientRect();
        this.onDoubleClick?.(i, (e.clientX - rect.left) / this.scale, (e.clientY - rect.top) / this.scale);
      });
      pages.push({ el, page, rendered: 0, width: vp.width, height: vp.height });
    }
    if (token !== this.loadToken) { void task.destroy(); return; }
    // Keep the reader's place: same relative scroll position in the new PDF.
    const ratioY = this.scroll.scrollHeight > 0 ? this.scroll.scrollTop / this.scroll.scrollHeight : 0;
    const ratioX = this.scroll.scrollLeft;
    const old = this.task;
    this.observer.disconnect();
    this.doc = doc;
    this.task = task;
    this.pages = pages;
    if (this.fitWidth) this.scale = this.fitScale();
    this.layout();
    // Render what will be visible before swapping, so a recompile does not flash white.
    const firstVisible = Math.floor(ratioY * pages.length);
    await Promise.all([firstVisible, firstVisible + 1].filter((i) => i < pages.length).map((i) => this.renderPage(i)));
    if (token !== this.loadToken) return;
    this.pagesEl.replaceChildren(...pages.map((p) => p.el));
    this.scroll.scrollTop = ratioY * this.scroll.scrollHeight;
    this.scroll.scrollLeft = ratioX;
    for (const p of pages) this.observer.observe(p.el);
    void old?.destroy();
    this.drawPins();
    this.onZoom?.();
  }

  clear(): void {
    this.loadToken++;
    void this.task?.destroy();
    this.task = null;
    this.doc = null;
    this.pages = [];
    this.pagesEl.replaceChildren();
  }

  get loaded(): boolean {
    return this.doc !== null;
  }

  private fitScale(): number {
    const widest = Math.max(1, ...this.pages.map((p) => p.width));
    // Hidden (another tab is showing): keep the current scale until visible again.
    if (this.scroll.clientWidth < 50) return this.scale;
    return Math.max(0.2, (this.scroll.clientWidth - 28) / widest);
  }

  private layout(): void {
    for (const p of this.pages) {
      p.el.style.width = `${Math.floor(p.width * this.scale)}px`;
      p.el.style.height = `${Math.floor(p.height * this.scale)}px`;
    }
  }

  private applyScale(scale: number): void {
    const anchor = this.scroll.scrollHeight > 0 ? (this.scroll.scrollTop + this.scroll.clientHeight / 2) / this.scroll.scrollHeight : 0;
    this.scale = scale;
    this.layout();
    this.scroll.scrollTop = anchor * this.scroll.scrollHeight - this.scroll.clientHeight / 2;
    this.drawPins();
    for (const p of this.pages) p.rendered = 0;
    for (const p of this.pages) {
      const r = p.el.getBoundingClientRect();
      const view = this.scroll.getBoundingClientRect();
      if (r.bottom > view.top - 600 && r.top < view.bottom + 600) void this.renderPage(Number(p.el.dataset.index));
    }
    this.onZoom?.();
  }

  zoom(factor: number): void {
    this.fitWidth = false;
    this.applyScale(Math.max(0.2, Math.min(5, this.scale * factor)));
  }

  fit(): void {
    this.fitWidth = true;
    this.applyScale(this.fitScale());
  }

  private async renderPage(index: number): Promise<void> {
    const p = this.pages[index];
    if (!p) return;
    const scale = this.scale * (window.devicePixelRatio || 1);
    if (p.rendered === scale) return;
    p.rendered = scale;
    const viewport = p.page.getViewport({ scale });
    const canvas = h('canvas') as HTMLCanvasElement;
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    try {
      await p.page.render({ canvas, viewport }).promise;
    } catch {
      p.rendered = 0;
      return;
    }
    if (p.rendered !== scale) return;
    p.el.querySelector('canvas')?.remove();
    p.el.prepend(canvas);
  }

  /** Scroll to a SyncTeX position (PDF points from the page's top-left). */
  reveal(page: number, y: number): void {
    const p = this.pages[page - 1];
    if (!p) return;
    const top = p.el.offsetTop + y * this.scale;
    this.scroll.scrollTo({ top: top - this.scroll.clientHeight / 3, behavior: 'smooth' });
    const marker = h('div', { class: 'pdf-marker', style: `top:${y * this.scale - 14}px` });
    p.el.append(marker);
    setTimeout(() => marker.remove(), 2000);
  }
}

export class Viewer {
  readonly root = h('div', { class: 'pane viewer-pane' });
  private readonly tabs = h('div', { class: 'viewer-tabs' });
  private readonly body = h('div', { class: 'viewer-body' });
  private readonly pdf = new PdfView();
  private readonly logView = h('div', { class: 'log-view' });
  private readonly fileView = h('div');
  private readonly empty = h('div', { class: 'viewer-empty' });
  private tab: Tab = 'pdf';
  private file: { path: string; hash: string } | null = null;
  private compile: CompileSummary | null = null;
  private output = '';
  private log = '';
  private showRaw = false;
  private readonly opts: ViewerOptions;
  private lastPdfRev = -1;
  private commentsPanel: HTMLElement | null = null;
  private commentCount = 0;
  private loadingPdf = false;

  constructor(opts: ViewerOptions) {
    this.opts = opts;
    this.root.append(this.tabs, this.body);
    this.pdf.onZoom = () => this.renderTabs();
    this.pdf.onDoubleClick = (page, x, y) => void this.syncToSource(page, x, y);
    this.pdf.onPinClick = (id, rect) => this.opts.onPinClick(id, rect);
    this.render();
  }

  setCompile(summary: CompileSummary, output?: string, log?: string): void {
    this.compile = summary;
    if (output !== undefined) this.output = output;
    if (log !== undefined) this.log = log;
    if (summary.state === 'done' && summary.hasPdf && summary.rev !== this.lastPdfRev) {
      this.lastPdfRev = summary.rev;
      this.loadingPdf = true;
      void this.pdf.load(withName(`/pdf/${encodeURIComponent(this.opts.project)}/output.pdf?rev=${summary.rev}`))
        .finally(() => { this.loadingPdf = false; this.render(); this.opts.onPdfLoaded(); });
    }
    this.render();
  }

  setPins(pins: PdfPin[]): void {
    this.pdf.setPins(pins);
  }

  get pdfLoaded(): boolean {
    return this.pdf.loaded;
  }

  setCommentsPanel(panel: HTMLElement, openCount: number): void {
    this.commentsPanel = panel;
    if (openCount !== this.commentCount) {
      this.commentCount = openCount;
      this.renderTabs();
    }
  }

  showFile(path: string, hash: string): void {
    this.file = { path, hash };
    this.tab = 'file';
    this.render();
  }

  closeFile(): void {
    this.file = null;
    if (this.tab === 'file') this.tab = 'pdf';
    this.render();
  }

  showTab(tab: Tab): void {
    this.tab = tab;
    this.render();
  }

  get viewingFile(): string | null {
    return this.tab === 'file' ? this.file?.path ?? null : null;
  }

  revealInPdf(page: number, y: number): void {
    this.showTab('pdf');
    this.pdf.reveal(page, y);
  }

  private async syncToSource(page: number, x: number, y: number): Promise<void> {
    const r = await fetch(withName(`/api/synctex/edit?project=${encodeURIComponent(this.opts.project)}&page=${page}&x=${x}&y=${y}`));
    const data = await r.json() as { file: string | null; line?: number };
    if (data.file && data.line) this.opts.onJumpToSource(data.file, data.line);
  }

  private renderTabs(): void {
    const c = this.compile;
    const errors = c?.issues.filter((i) => i.level === 'error').length ?? 0;
    const warnings = c?.issues.filter((i) => i.level === 'warning').length ?? 0;
    const tab = (id: Tab, ...content: Array<Node | string | null>) => {
      const b = h('button', { class: `tab${this.tab === id ? ' active' : ''}` }, ...content);
      b.addEventListener('click', () => this.showTab(id));
      return b;
    };
    const items: Node[] = [
      tab('pdf', 'PDF'),
      tab('log', 'Log',
        errors ? h('span', { class: 'count err' }, String(errors)) : null,
        !errors && warnings ? h('span', { class: 'count warn' }, String(warnings)) : null),
      tab('comments', 'Comments', this.commentCount ? h('span', { class: 'count' }, String(this.commentCount)) : null),
    ];
    if (this.file) {
      const close = h('span', { class: 'close', title: 'Close' }, '×');
      close.addEventListener('click', (e) => { e.stopPropagation(); this.opts.onCloseFile(); this.closeFile(); });
      items.push(tab('file', h('span', { class: 'fname' }, this.file.path.split('/').pop()!), close));
    }
    const tools = h('div', { class: 'tools' });
    // A large PDF takes a moment to arrive; until then the old one stays up.
    if (this.loadingPdf) tools.append(h('span', { class: 'loading', title: 'The new PDF is being downloaded and rendered' }, 'loading new PDF…'));
    if (this.tab === 'pdf' && this.pdf.loaded) {
      tools.append(
        h('button', { class: 'ghost icon', title: 'Go to the cursor position in the PDF (Ctrl+Alt+→)', onclick: () => this.opts.onSyncFromCursor() }, '⇢'),
        h('button', { class: 'ghost icon', title: 'Zoom out', onclick: () => this.pdf.zoom(1 / 1.15) }, '−'),
        h('span', { class: 'zoom' }, this.pdf.fitWidth ? 'fit' : `${Math.round(this.pdf.scale * 100)}%`),
        h('button', { class: 'ghost icon', title: 'Zoom in', onclick: () => this.pdf.zoom(1.15) }, '+'),
        h('button', { class: `ghost icon${this.pdf.fitWidth ? ' on' : ''}`, title: 'Fit width', onclick: () => this.pdf.fit() }, '↔'),
      );
    }
    if (this.tab === 'log') {
      tools.append(h('button', { class: `ghost icon${this.showRaw ? ' on' : ''}`, onclick: () => { this.showRaw = !this.showRaw; this.render(); } }, 'raw log'));
    }
    this.tabs.replaceChildren(...items, tools);
  }

  render(): void {
    this.renderTabs();
    const content: Node[] = [];
    if (this.tab === 'pdf') {
      if (this.pdf.loaded) content.push(this.pdf.scroll);
      else {
        const c = this.compile;
        this.empty.replaceChildren(h('div', {},
          h('div', { class: 'big' }, c?.state === 'running' ? 'Compiling…' : 'No PDF yet'),
          h('div', {}, c?.state === 'running' ? '' : c && c.rev > 0 ? 'The last compile produced no PDF — see the Log tab.' : 'Press Recompile (Ctrl+S).')));
        content.push(this.empty);
      }
    } else if (this.tab === 'log') {
      this.renderLog();
      content.push(this.logView);
    } else if (this.tab === 'comments' && this.commentsPanel) {
      content.push(this.commentsPanel);
    } else if (this.file) {
      this.renderFile();
      content.push(this.fileView);
    }
    // Keep the PDF element alive (and scrolled) while other tabs show.
    for (const child of [...this.body.children]) if (!content.includes(child)) child.remove();
    for (const node of content) if (node.parentNode !== this.body) this.body.append(node);
  }

  private renderLog(): void {
    const c = this.compile;
    this.logView.replaceChildren();
    if (!c || c.rev === 0) {
      this.logView.append(h('div', { class: 'log-summary' }, 'Not compiled yet.'));
      return;
    }
    const errors = c.issues.filter((i) => i.level === 'error');
    const summary = c.state === 'running'
      ? h('div', { class: 'log-summary' }, 'Compiling…')
      : h('div', { class: `log-summary ${c.ok ? 'ok' : 'bad'}` },
        c.ok ? `Compiled ${c.mainFile} in ${((c.finishedAt - c.startedAt) / 1000).toFixed(1)} s` : `${errors.length || 'Compile'} error${errors.length === 1 ? '' : 's'} in ${c.mainFile}`,
        h('span', { class: 'muted' }, ` · ${c.by} · ${new Date(c.finishedAt).toLocaleTimeString()}`));
    this.logView.append(summary);
    if (!this.showRaw) {
      const order: Record<CompileIssue['level'], number> = { error: 0, warning: 1, badbox: 2 };
      for (const issue of [...c.issues].sort((a, b) => order[a.level] - order[b.level])) {
        const row = h('div', { class: `issue ${issue.level}` },
          h('span', { class: 'lvl' }, issue.level === 'badbox' ? 'box' : issue.level),
          h('div', {},
            h('div', { class: 'msg' }, issue.message),
            issue.file ? h('div', { class: 'where' }, `${issue.file}${issue.line ? `:${issue.line}` : ''}`) : null));
        if (issue.file && issue.line) row.addEventListener('click', () => this.opts.onJumpToSource(issue.file, issue.line!));
        this.logView.append(row);
      }
      if (!c.issues.length) this.logView.append(h('div', { class: 'log-summary muted' }, 'No errors or warnings.'));
      return;
    }
    this.logView.append(
      h('div', { class: 'log-section' }, 'latexmk output'),
      h('pre', { class: 'log-raw' }, this.output || '(empty)'),
      h('div', { class: 'log-section' }, 'TeX log'),
      h('pre', { class: 'log-raw' }, this.log || '(no log)'));
  }

  private renderFile(): void {
    const { path, hash } = this.file!;
    const url = withName(`/raw/${encodeURIComponent(this.opts.project)}/${path.split('/').map(encodeURIComponent).join('/')}?v=${hash}`);
    const ext = extensionOf(path);
    const key = `${path}|${hash}`;
    if (this.fileView.dataset.key === key) return;
    this.fileView.dataset.key = key;
    if (IMAGE_EXTENSIONS.has(ext)) {
      const img = h('img', { src: url, alt: path });
      const wrap = h('div', { class: 'image-view' }, img);
      img.addEventListener('click', () => wrap.classList.toggle('actual'));
      this.fileView.replaceChildren(wrap);
    } else if (ext === 'pdf') {
      const view = new PdfView();
      this.fileView.replaceChildren(view.scroll);
      void view.load(url);
    } else {
      this.fileView.replaceChildren(h('div', { class: 'file-info' }, h('div', {},
        h('div', { class: 'big' }, path),
        h('p', {}, 'No preview for this kind of file.'),
        h('a', { href: `${url}&download=1` }, h('button', {}, 'Download')))));
    }
  }
}
