import type * as Y from 'yjs';
import { extensionOf, IMAGE_EXTENSIONS } from '@shared/files.ts';
import type { BinInfo } from '@shared/protocol.ts';
import { api, confirmDialog, dialog, h, menuAt, prompt, toast, upload, withName } from './ui.ts';

/**
 * The file browser on the left, Overleaf-style: folders, files, the main
 * document marked, who is looking at what. Files and whole folders can be
 * dropped onto it (or onto a folder row) from the desktop, and rows can be
 * dragged onto folders to move them.
 */

export interface TreeOptions {
  project: () => string;
  texts: Y.Map<Y.Text>;
  bins: Y.Map<BinInfo>;
  dirs: Y.Map<boolean>;
  onOpen: (path: string) => void;
  setStatus: (text: string | null) => void;
  getMainFile: () => string;
  setMainFile: (path: string) => void;
}

interface TrashItem { id: string; kind: string; path: string; deletedAt: string; deletedBy: string }

interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  children: TreeNode[];
}

const INTERNAL_DRAG = 'application/x-texwerk-path';

function kindLabel(path: string, dir: boolean): [string, string] {
  if (dir) return ['dir', 'dir'];
  const ext = extensionOf(path);
  if (ext === 'tex' || ext === 'sty' || ext === 'cls') return [ext, 'tex'];
  if (ext === 'bib' || ext === 'bst') return [ext, 'bib'];
  if (IMAGE_EXTENSIONS.has(ext) || ext === 'eps') return [ext.slice(0, 4), 'img'];
  if (ext === 'pdf') return ['pdf', 'pdf'];
  return [ext.slice(0, 4) || '·', ''];
}

export class FileTree {
  readonly root = h('div', { class: 'pane tree-pane' });
  private readonly list = h('div', { class: 'tree', tabindex: '0' });
  private readonly opts: TreeOptions;
  private readonly collapsed = new Set<string>();
  selected: string | null = null;
  viewing: string | null = null;
  private presence = new Map<string, string[]>();
  private renaming: string | null = null;
  private renderQueued = false;
  private readOnly = false;
  private readonly headButtons: HTMLElement[] = [];

  constructor(opts: TreeOptions) {
    this.opts = opts;
    try { for (const p of JSON.parse(localStorage.getItem(`texwerk-collapsed:${opts.project()}`) ?? '[]')) this.collapsed.add(p); } catch { /* none */ }
    this.headButtons.push(
      h('button', { class: 'ghost icon', title: 'New file', onclick: () => void this.newFile('') }, '+file'),
      h('button', { class: 'ghost icon', title: 'New folder', onclick: () => void this.newFolder('') }, '+dir'),
      h('button', { class: 'ghost icon', title: 'Upload files', onclick: () => this.pickUpload('') }, '↑'));
    const trashBtn = h('button', { class: 'ghost icon', title: 'Trash: deleted files and folders', onclick: () => void this.showTrash() }, 'trash');
    const head = h('div', { class: 'pane-head' }, h('span', { class: 'label' }, 'Files'), h('span', { class: 'spacer' }), ...this.headButtons, trashBtn);
    this.hint = h('div', { class: 'tree-hint' }, 'Drop files or folders here to upload.');
    this.root.append(head, this.list, this.hint);
    for (const map of [opts.texts, opts.bins, opts.dirs]) map.observe(() => this.queueRender());
    this.bindDrop(this.list, () => '');
    this.list.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.tree-row')) return;
      e.preventDefault();
      menuAt(e.clientX, e.clientY, this.folderMenu(''));
    });
    this.render();
  }

  private hint: HTMLElement;

  /** Viewers browse and download; nothing that changes the project is offered. */
  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
    for (const b of this.headButtons) b.hidden = readOnly;
    this.hint.hidden = readOnly;
    this.render();
  }

  setPresence(byFile: Map<string, string[]>): void {
    this.presence = byFile;
    this.queueRender();
  }

  select(path: string | null): void {
    this.selected = path;
    if (path) for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) this.collapsed.delete(path.slice(0, i));
    this.queueRender();
  }

  setViewing(path: string | null): void {
    this.viewing = path;
    this.queueRender();
  }

  private queueRender(): void {
    // Re-rendering would replace the rename field under the person typing.
    if (this.renderQueued || this.renaming) return;
    this.renderQueued = true;
    requestAnimationFrame(() => { this.renderQueued = false; this.render(); });
  }

  private build(): TreeNode {
    const root: TreeNode = { name: '', path: '', dir: true, children: [] };
    const byPath = new Map<string, TreeNode>([['', root]]);
    const ensureDir = (path: string): TreeNode => {
      const existing = byPath.get(path);
      if (existing) return existing;
      const parent = ensureDir(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
      const node: TreeNode = { name: path.split('/').pop()!, path, dir: true, children: [] };
      parent.children.push(node);
      byPath.set(path, node);
      return node;
    };
    for (const d of this.opts.dirs.keys()) ensureDir(d);
    for (const f of [...this.opts.texts.keys(), ...this.opts.bins.keys()]) {
      const parent = ensureDir(f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '');
      parent.children.push({ name: f.split('/').pop()!, path: f, dir: false, children: [] });
    }
    const sort = (n: TreeNode) => {
      n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.dir ? -1 : 1));
      n.children.forEach(sort);
    };
    sort(root);
    return root;
  }

  render(): void {
    const tree = this.build();
    const rows: HTMLElement[] = [];
    const main = this.opts.getMainFile();
    const walk = (node: TreeNode, depth: number) => {
      for (const child of node.children) {
        rows.push(this.row(child, depth, main));
        if (child.dir && !this.collapsed.has(child.path)) walk(child, depth + 1);
      }
    };
    walk(tree, 0);
    const scroll = this.list.scrollTop;
    this.list.replaceChildren(...(rows.length ? rows : [h('div', { class: 'tree-empty' }, 'Empty project. Drop files here or create one with +file.')]));
    this.list.scrollTop = scroll;
    const input = this.list.querySelector('input.rename') as HTMLInputElement | null;
    if (input) { input.focus(); const dot = input.value.lastIndexOf('.'); input.setSelectionRange(0, dot > 0 ? dot : input.value.length); }
  }

  private row(node: TreeNode, depth: number, main: string): HTMLElement {
    const [kind, kindClass] = kindLabel(node.path, node.dir);
    const people = this.presence.get(node.path) ?? [];
    const row = h('div', {
      class: `tree-row${this.selected === node.path ? ' selected' : ''}${this.viewing === node.path ? ' viewing' : ''}`,
      style: `padding-left:${8 + depth * 14}px`,
      draggable: this.readOnly ? 'false' : 'true',
      title: node.path,
    },
    h('span', { class: 'twisty' }, node.dir ? (this.collapsed.has(node.path) ? '▸' : '▾') : ''),
    h('span', { class: `kind ${kindClass}` }, kind));
    if (this.renaming === node.path) {
      const input = h('input', { class: 'rename', value: node.name, spellcheck: 'false' });
      const finish = async (commit: boolean) => {
        if (this.renaming !== node.path) return;
        this.renaming = null;
        const name = input.value.trim();
        if (commit && name && name !== node.name && !name.includes('/')) {
          const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/') + 1) : '';
          await this.move(node.path, parent + name);
        }
        this.render();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void finish(true);
        if (e.key === 'Escape') void finish(false);
        e.stopPropagation();
      });
      input.addEventListener('blur', () => void finish(true));
      input.addEventListener('click', (e) => e.stopPropagation());
      row.append(input);
    } else {
      row.append(h('span', { class: 'name' }, node.name));
    }
    if (node.path === main) row.append(h('span', { class: 'main-badge', title: 'Main document' }, 'MAIN'));
    if (people.length) {
      const dots = h('span', { class: 'dots', title: people.map((p) => p.split('|')[0]).join(', ') });
      for (const p of people.slice(0, 4)) dots.append(h('span', { style: `background:${p.split('|')[1]}` }));
      row.append(dots);
    }
    const more = h('button', { class: 'ghost', title: 'More' }, '⋯');
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      menuAt(r.left, r.bottom, node.dir ? this.folderMenu(node.path) : this.fileMenu(node.path));
    });
    row.append(h('span', { class: 'row-actions' }, more));

    row.addEventListener('click', () => {
      if (node.dir) {
        if (this.collapsed.has(node.path)) this.collapsed.delete(node.path); else this.collapsed.add(node.path);
        try { localStorage.setItem(`texwerk-collapsed:${this.opts.project()}`, JSON.stringify([...this.collapsed])); } catch { /* ignore */ }
        this.render();
      } else {
        this.opts.onOpen(node.path);
      }
    });
        row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      menuAt(e.clientX, e.clientY, node.dir ? this.folderMenu(node.path) : this.fileMenu(node.path));
    });
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer!.setData(INTERNAL_DRAG, node.path);
      e.dataTransfer!.effectAllowed = 'move';
    });
    if (node.dir) this.bindDrop(row, () => node.path);
    return row;
  }

  private fileMenu(path: string): HTMLElement[] {
    if (this.readOnly) {
      const dl = withName(`/raw/${encodeURIComponent(this.opts.project())}/${path.split('/').map(encodeURIComponent).join('/')}?download=1`);
      return [
        h('button', { onclick: () => this.opts.onOpen(path) }, 'Open'),
        h('button', { onclick: () => { const a = h('a', { href: dl }); document.body.append(a); a.click(); a.remove(); } }, 'Download'),
      ];
    }
    const url = withName(`/raw/${encodeURIComponent(this.opts.project())}/${path.split('/').map(encodeURIComponent).join('/')}?download=1`);
    const items: HTMLElement[] = [
      h('button', { onclick: () => this.opts.onOpen(path) }, 'Open'),
      h('button', { onclick: () => { this.renaming = path; this.render(); } }, 'Rename'),
      h('button', { onclick: () => { const a = h('a', { href: url }); document.body.append(a); a.click(); a.remove(); } }, 'Download'),
    ];
    if (this.opts.texts.has(path) && path.endsWith('.tex')) {
      items.push(h('button', { onclick: () => this.opts.setMainFile(path) }, 'Set as main document'));
    }
    items.push(h('div', { class: 'menu-sep' }), h('button', { onclick: () => void this.remove(path) }, 'Delete…'));
    return items;
  }

  private folderMenu(path: string): HTMLElement[] {
    if (this.readOnly) return [h('div', { class: 'menu-head' }, 'View only')];
    const items: HTMLElement[] = [
      h('button', { onclick: () => void this.newFile(path) }, 'New file'),
      h('button', { onclick: () => void this.newFolder(path) }, 'New folder'),
      h('button', { onclick: () => this.pickUpload(path) }, 'Upload files…'),
    ];
    if (path) {
      items.push(
        h('div', { class: 'menu-sep' }) ,
        h('button', { onclick: () => { this.renaming = path; this.render(); } }, 'Rename') ,
        h('button', { onclick: () => void this.remove(path) }, 'Delete…') ,
      );
    }
    return items;
  }

  private async newFile(dir: string): Promise<void> {
    const name = await prompt('New file', dir ? `In ${dir}/` : 'In the project root. Use a/b.tex to create folders too.', 'untitled.tex', 'Create');
    if (!name) return;
    const path = dir ? `${dir}/${name}` : name;
    try {
      await api('POST', `/api/fs?project=${encodeURIComponent(this.opts.project())}`, { op: 'newfile', path });
      setTimeout(() => this.opts.onOpen(path), 50);
    } catch (err) { toast((err as Error).message, 'bad'); }
  }

  private async newFolder(dir: string): Promise<void> {
    const name = await prompt('New folder', dir ? `In ${dir}/` : 'In the project root.', 'figures', 'Create');
    if (!name) return;
    try { await api('POST', `/api/fs?project=${encodeURIComponent(this.opts.project())}`, { op: 'mkdir', path: dir ? `${dir}/${name}` : name }); } catch (err) { toast((err as Error).message, 'bad'); }
  }

  private async remove(path: string): Promise<void> {
    const isDir = this.opts.dirs.has(path);
    const ok = await confirmDialog(`Delete ${isDir ? 'folder' : 'file'}`, `Delete "${path}"${isDir ? ' and everything in it' : ''}? It is moved to the project's trash and can be restored from there.`, 'Delete', true);
    if (!ok) return;
    try { await api('POST', `/api/fs?project=${encodeURIComponent(this.opts.project())}`, { op: 'delete', path }); } catch (err) { toast((err as Error).message, 'bad'); }
  }

  /** Deleted files and folders of this project; nothing can be removed from here. */
  private async showTrash(): Promise<void> {
    const project = encodeURIComponent(this.opts.project());
    let items: TrashItem[];
    try { items = (await api<{ items: TrashItem[] }>('GET', `/api/trash?project=${project}`)).items; } catch (err) { toast((err as Error).message, 'bad'); return; }
    dialog((close) => {
      const rows = items.map((t) => {
        const restore = h('button', { title: `Put it back at ${t.path}` }, 'Restore');
        restore.addEventListener('click', async () => {
          try {
            await api('POST', `/api/trash/restore?project=${project}&id=${encodeURIComponent(t.id)}`);
            toast(`Restored ${t.path}`);
            close();
          } catch (err) { toast((err as Error).message, 'bad'); }
        });
        return h('div', { class: 'trash-row' },
          h('div', { class: 'trash-name' }, `${t.path}${t.kind === 'dir' ? '/' : ''}`,
            h('div', { class: 'muted' }, `deleted ${new Date(t.deletedAt).toLocaleString()} by ${t.deletedBy}`)),
          this.readOnly ? '' : restore);
      });
      return [
        h('h2', {}, 'Trash'),
        h('p', { class: 'muted' }, 'Deleted files and folders of this project. They are kept for good.'),
        h('div', { class: 'trash-list' }, ...(rows.length ? rows : [h('p', { class: 'muted' }, 'The trash is empty.')])),
        h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: close }, 'Close')),
      ];
    }, { wide: true });
  }

  private async move(from: string, to: string): Promise<void> {
    try { await api('POST', `/api/fs?project=${encodeURIComponent(this.opts.project())}`, { op: 'move', path: from, to }); } catch (err) { toast((err as Error).message, 'bad'); }
  }

  // ------------------------------------------------------------- uploads

  private pickUpload(dir: string): void {
    const input = h('input', { type: 'file', multiple: true });
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])].map((f) => ({ file: f, path: dir ? `${dir}/${f.name}` : f.name }));
      void this.uploadAll(files);
    });
    input.click();
  }

  private bindDrop(target: HTMLElement, dirOf: () => string): void {
    const cls = target === this.list ? 'drop-target' : 'drop-into';
    let depth = 0;
    target.addEventListener('dragenter', (e) => {
      e.preventDefault();
      e.stopPropagation();
      depth++;
      document.querySelectorAll('.drop-into, .drop-target').forEach((n) => n !== target && n.classList.remove('drop-into', 'drop-target'));
      target.classList.add(cls);
    });
    target.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer!.dropEffect = e.dataTransfer!.types.includes(INTERNAL_DRAG) ? 'move' : 'copy';
      target.classList.add(cls);
    });
    target.addEventListener('dragleave', (e) => {
      e.stopPropagation();
      depth = Math.max(0, depth - 1);
      if (depth === 0) target.classList.remove(cls);
    });
    target.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.readOnly) { target.classList.remove(cls); return; }
      depth = 0;
      target.classList.remove(cls);
      document.querySelector('.drop-overlay')?.remove();
      const dir = dirOf();
      const internal = e.dataTransfer!.getData(INTERNAL_DRAG);
      if (internal) {
        const name = internal.split('/').pop()!;
        const to = dir ? `${dir}/${name}` : name;
        if (to !== internal && !to.startsWith(`${internal}/`)) void this.move(internal, to);
        return;
      }
      void this.dropFiles(e.dataTransfer!, dir);
    });
  }

  /** Files and folders dropped from the desktop, folders walked recursively. */
  async dropFiles(data: DataTransfer, dir: string): Promise<void> {
    if (this.readOnly) { toast('You have view-only access to this project', 'bad'); return; }
    const out: Array<{ file: File; path: string }> = [];
    const entries = [...data.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
    const prefix = dir ? `${dir}/` : '';
    if (!entries.length) {
      for (const f of [...data.files]) out.push({ file: f, path: prefix + f.name });
    }
    const walk = async (entry: FileSystemEntry, base: string): Promise<void> => {
      if (entry.isFile) {
        const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
        out.push({ file, path: base + entry.name });
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        let batch: FileSystemEntry[];
        do {
          batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
          for (const child of batch) await walk(child, `${base}${entry.name}/`);
        } while (batch.length);
      }
    };
    for (const entry of entries) await walk(entry, prefix);
    const filtered = out.filter((f) => !f.path.split('/').some((part) => part === '.git' || part === '.DS_Store' || part === '__MACOSX'));
    await this.uploadAll(filtered);
  }

  async uploadAll(files: Array<{ file: File; path: string }>): Promise<void> {
    if (!files.length) return;
    const total = files.reduce((s, f) => s + f.file.size, 0) || 1;
    let done = 0;
    let failed = 0;
    const started = Date.now();
    const show = (text: string) => { if (Date.now() - started > 400) this.opts.setStatus(text); };
    for (const [i, { file, path }] of files.entries()) {
      try {
        await upload(`/api/file?project=${encodeURIComponent(this.opts.project())}&path=${encodeURIComponent(path)}`, file, (fraction) => {
          show(`Uploading ${path} (${i + 1}/${files.length}) — ${Math.round(((done + fraction * file.size) / total) * 100)}%`);
        });
      } catch (err) {
        failed++;
        toast(`Could not upload ${path}: ${(err as Error).message}`, 'bad');
      }
      done += file.size;
    }
    this.opts.setStatus(null);
    if (!failed) toast(files.length === 1 ? `Uploaded ${files[0].path}` : `Uploaded ${files.length} files`, 'ok', 2000);
    if (files.length === 1 && !failed) {
      const only = files[0].path;
      setTimeout(() => this.opts.onOpen(only), 100);
    }
  }
}
