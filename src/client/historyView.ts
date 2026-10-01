import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { unifiedMergeView } from '@codemirror/merge';
import { colorFor } from '@shared/files.ts';
import type { GitLabel, HistoryEntry } from '@shared/protocol.ts';
import { api, confirmDialog, formatTime, h, toast, withName } from './ui.ts';

/**
 * The history view: every change to the project, grouped into bursts of
 * work, with labelled versions (git commits) shown in between. Picking a
 * change shows what it did to each file as a diff; any file can be restored
 * to that version, or the whole project put back to that point. A label can
 * be reverted to, which restores its commit and records the revert as a new
 * labelled version.
 */

const GROUP_GAP_MS = 10 * 60_000;

interface Group {
  kind: 'group';
  first: HistoryEntry;
  last: HistoryEntry;
  entries: HistoryEntry[];
  authors: string[];
  files: string[];
}

interface LabelItem {
  kind: 'label';
  label: GitLabel;
}

type Item = Group | LabelItem;

export interface HistoryOptions {
  project: () => string;
  onClose: () => void;
  onLabel: () => void;
}

export class HistoryView {
  readonly root = h('div', { class: 'history' });
  private readonly list = h('div', { class: 'history-list' });
  private readonly main = h('div', { class: 'history-main' });
  private entries: HistoryEntry[] = [];
  private items: Item[] = [];
  private selected: Item | null = null;
  private selectedFile: string | null = null;
  private diffView: EditorView | null = null;
  private readonly blobCache = new Map<string, Promise<string>>();
  private readonly opts: HistoryOptions;

  constructor(opts: HistoryOptions) {
    this.opts = opts;
    this.root.append(this.list, this.main);
  }

  async refresh(): Promise<void> {
    const data = await api<{ entries: HistoryEntry[]; labels: GitLabel[] }>('GET', `/api/history?project=${encodeURIComponent(this.opts.project())}`);
    this.entries = data.entries;
    this.items = this.buildItems(data.entries, data.labels);
    const keep = this.selected;
    this.selected = keep
      ? this.items.find((i) => (i.kind === 'label' && keep.kind === 'label' ? i.label.commit === keep.label.commit
        : i.kind === 'group' && keep.kind === 'group' ? i.first.id === keep.first.id : false)) ?? null
      : null;
    if (!this.selected) this.selected = this.items.find((i) => i.kind === 'group') ?? null;
    this.renderList();
    await this.renderMain();
  }

  private buildItems(entries: HistoryEntry[], labels: GitLabel[]): Item[] {
    const groups: Group[] = [];
    let current: Group | null = null;
    const labelIds = labels.map((l) => l.historyId).filter((id): id is number => id !== null);
    for (const e of entries) {
      // A label always ends a group, so it sits between the changes it includes and the rest.
      const labelBetween = current !== null && labelIds.some((id) => id >= current!.last.id && id < e.id);
      if (current && !labelBetween && e.ts - current.last.ts < GROUP_GAP_MS) {
        current.entries.push(e);
        current.last = e;
      } else {
        current = { kind: 'group', first: e, last: e, entries: [e], authors: [], files: [] };
        groups.push(current);
      }
    }
    for (const g of groups) {
      g.authors = [...new Set(g.entries.flatMap((e) => e.authors))];
      g.files = [...new Set(g.entries.map((e) => e.path))];
    }
    // Newest first; a label sits above the changes it includes.
    const items: Item[] = [];
    const remaining = [...labels];
    for (const g of groups.reverse()) {
      const above = remaining.filter((l) => (l.historyId !== null ? l.historyId >= g.last.id : l.ts >= g.last.ts));
      for (const l of above) { items.push({ kind: 'label', label: l }); remaining.splice(remaining.indexOf(l), 1); }
      items.push(g);
    }
    for (const l of remaining) items.push({ kind: 'label', label: l });
    return items;
  }

  private renderList(): void {
    const rows: HTMLElement[] = [];
    if (!this.items.length) rows.push(h('div', { class: 'history-item' }, h('span', { class: 'muted' }, 'No history yet.')));
    for (const item of this.items) {
      if (item.kind === 'label') {
        const row = h('div', { class: `history-label${this.selected === item ? ' selected' : ''}`, title: item.label.message },
          h('span', { class: 'tag' }, 'label'),
          h('span', { class: 'msg' }, item.label.message),
          h('span', { class: 'meta' }, `${item.label.author} · ${formatTime(item.label.ts)}`));
        row.addEventListener('click', () => { this.selected = item; this.renderList(); void this.renderMain(); });
        rows.push(row);
      } else {
        const who = h('div', { class: 'who' });
        for (const a of item.authors) who.append(h('span', { style: `--c:${colorFor(a.replace(/ \(.*\)$/, '').replace(/ · agent$/, ''))}` }, a));
        const row = h('div', { class: `history-item${this.selected === item ? ' selected' : ''}` },
          h('div', { class: 'when' }, item.first.ts === item.last.ts || formatTime(item.first.ts) === formatTime(item.last.ts)
            ? formatTime(item.last.ts) : `${formatTime(item.first.ts)} – ${formatTime(item.last.ts).replace(/^today /, '')}`),
          who,
          h('div', { class: 'files' }, `${item.files.length} file${item.files.length === 1 ? '' : 's'}: ${item.files.join(', ')}`));
        row.addEventListener('click', () => { this.selected = item; this.selectedFile = null; this.renderList(); void this.renderMain(); });
        rows.push(row);
      }
    }
    this.list.replaceChildren(
      h('div', { class: 'pane-head' },
        h('span', { class: 'label' }, 'History'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'ghost icon', onclick: () => this.opts.onLabel() }, '+ label'),
        h('button', { class: 'ghost icon', onclick: () => this.opts.onClose() }, 'close')),
      ...rows);
  }

  private blob(hash: string): Promise<string> {
    let p = this.blobCache.get(hash);
    if (!p) {
      p = fetch(withName(`/api/history/blob?project=${encodeURIComponent(this.opts.project())}&hash=${hash}`)).then((r) => r.text());
      this.blobCache.set(hash, p);
    }
    return p;
  }

  /** The entry for `path` in effect just before history id `id` (exclusive). */
  private entryBefore(path: string, id: number): HistoryEntry | null {
    let found: HistoryEntry | null = null;
    for (const e of this.entries) {
      if (e.id >= id) break;
      if (e.path === path) found = e;
    }
    return found;
  }

  private async renderMain(): Promise<void> {
    this.diffView?.destroy();
    this.diffView = null;
    const item = this.selected;
    if (!item) {
      this.main.replaceChildren(h('div', { class: 'viewer-empty' }, 'Pick a change on the left.'));
      return;
    }
    if (item.kind === 'label') {
      const l = item.label;
      const revert = h('button', { class: 'danger' }, 'Revert project to this label…');
      revert.addEventListener('click', async () => {
        const ok = await confirmDialog('Revert to label', `Put every file back the way it was at "${l.message}"? The current state stays in the history, and the revert is saved as a new label.`, 'Revert', true);
        if (!ok) return;
        try {
          await api('POST', `/api/git/revert?project=${encodeURIComponent(this.opts.project())}`, { commit: l.commit, message: l.message });
          toast(`Reverted to "${l.message}"`, 'ok');
          await this.refresh();
        } catch (err) { toast((err as Error).message, 'bad'); }
      });
      this.main.replaceChildren(
        h('div', { class: 'history-actions' },
          h('span', { class: 'info' }, `Label "${l.message}" by ${l.author}, ${formatTime(l.ts)} · commit ${l.commit.slice(0, 8)}`),
          h('span', { class: 'spacer' }), revert),
        h('div', { class: 'viewer-empty' }, h('div', {},
          h('div', { class: 'big' }, l.message),
          h('div', {}, 'A labelled version is a git commit of the whole project. Push it from Git… in the toolbar.'))));
      return;
    }
    const g = item;
    const file = this.selectedFile && g.files.includes(this.selectedFile) ? this.selectedFile : g.files[0];
    this.selectedFile = file;
    const before = this.entryBefore(file, g.first.id);
    let lastInGroup = [...g.entries].reverse().find((e) => e.path === file)!;
    const createdAndDeleted = lastInGroup.op === 'delete' && (!before || before.op === 'delete');
    // Added and deleted within this group: show what it contained.
    if (createdAndDeleted) lastInGroup = [...g.entries].reverse().find((e) => e.path === file && e.op !== 'delete') ?? lastInGroup;
    const chips = h('div', { class: 'history-files' });
    for (const f of g.files) {
      const last = [...g.entries].reverse().find((e) => e.path === f)!;
      const prior = this.entryBefore(f, g.first.id);
      const added = !prior || prior.op === 'delete';
      const op = last.op === 'delete' ? (added ? 'add+delete' : 'delete') : added ? 'add' : 'edit';
      const b = h('button', { class: f === file ? 'on' : '' }, h('span', { class: `op ${op.replace('+', '-')}` }, op), f);
      b.addEventListener('click', () => { this.selectedFile = f; void this.renderMain(); });
      chips.append(b);
    }
    const restoreFile = h('button', {}, 'Restore this file');
    restoreFile.addEventListener('click', async () => {
      const ok = await confirmDialog('Restore file', `Set "${file}" back to this version? Everyone sees the change live, and it can be undone from the history too.`, 'Restore');
      if (!ok) return;
      try {
        await api('POST', `/api/history/restore-file?project=${encodeURIComponent(this.opts.project())}`, { path: file, hash: lastInGroup.op === 'delete' ? null : lastInGroup.hash ?? null });
        toast(`Restored ${file}`, 'ok');
      } catch (err) { toast((err as Error).message, 'bad'); }
    });
    const restoreAll = h('button', { class: 'danger' }, 'Restore project to here…');
    restoreAll.addEventListener('click', async () => {
      const ok = await confirmDialog('Restore project', `Put every file back to how it was at ${formatTime(g.last.ts)}? The current state stays in the history.`, 'Restore project', true);
      if (!ok) return;
      try {
        await api('POST', `/api/history/restore-project?project=${encodeURIComponent(this.opts.project())}`, { id: g.last.id });
        toast('Project restored', 'ok');
      } catch (err) { toast((err as Error).message, 'bad'); }
    });
    const diffHost = h('div', { class: 'history-diff' });
    this.main.replaceChildren(
      chips,
      h('div', { class: 'history-actions' },
        h('span', { class: 'info' }, `${g.authors.join(', ')} · ${formatTime(g.last.ts)}`),
        h('span', { class: 'spacer' }), restoreFile, restoreAll),
      diffHost);
    if (lastInGroup.binary || before?.binary) {
      diffHost.append(h('div', { class: 'viewer-empty' }, `${file} is a binary file — ${lastInGroup.op === 'delete' ? 'deleted' : 'changed'} in this step.`));
      return;
    }
    const [oldText, newText] = await Promise.all([
      before && before.op !== 'delete' && before.hash ? this.blob(before.hash) : Promise.resolve(''),
      lastInGroup.op !== 'delete' && lastInGroup.hash ? this.blob(lastInGroup.hash) : Promise.resolve(''),
    ]);
    if (this.selected !== g || this.selectedFile !== file) return;
    this.diffView = new EditorView({
      parent: diffHost,
      state: EditorState.create({
        doc: newText,
        extensions: [
          lineNumbers(),
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          EditorView.lineWrapping,
          unifiedMergeView({ original: oldText, mergeControls: false, highlightChanges: true, gutter: true, collapseUnchanged: { margin: 3, minSize: 6 } }),
          EditorView.theme({}, { dark: true }),
        ],
      }),
    });
  }

  destroy(): void {
    this.diffView?.destroy();
  }
}
