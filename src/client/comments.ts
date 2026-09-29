import type * as Y from 'yjs';
import { allThreads, sortThreads, type CommentThread } from '@shared/comments.ts';
import { colorFor } from '@shared/files.ts';
import { api, confirmDialog, formatTime, h, toast } from './ui.ts';

/**
 * Comment threads in the browser: the list (the Comments tab), a thread
 * popover anchored in the editor or on the PDF, and the composer for a new
 * comment. Threads come from the project's Y.Doc, so everything here updates
 * live; every change goes through /api/comments, so view-only people can
 * comment too.
 */

export interface CommentsOptions {
  project: string;
  doc: Y.Doc;
  me: () => { login: string; name: string };
  canModerate: () => boolean;
  /** Jump to a thread's text in the editor (opening the file). */
  reveal: (thread: CommentThread) => void;
  /** Called whenever the set of threads changes. */
  onChange: () => void;
}

const SHOW_KEY = 'texwerk-show-comments';

export class Comments {
  readonly panel = h('div', { class: 'comments-view' });
  private readonly opts: CommentsOptions;
  private threads: CommentThread[] = [];
  private filter: 'open' | 'all' = 'open';
  private popover: HTMLElement | null = null;
  private popoverThread: string | null = null;
  private selected: string | null = null;
  show = true;

  constructor(opts: CommentsOptions) {
    this.opts = opts;
    try { this.show = localStorage.getItem(SHOW_KEY) !== '0'; } catch { /* default on */ }
    let queued = false;
    opts.doc.getMap('comments').observeDeep(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; this.refresh(); });
    });
    // Anchors move as people type; the list's line numbers follow lazily.
    let textQueued: number | undefined;
    opts.doc.getMap('text').observeDeep(() => {
      window.clearTimeout(textQueued);
      textQueued = window.setTimeout(() => { if (this.threads.length) this.refresh(); }, 400);
    });
    document.addEventListener('mousedown', (e) => {
      if (this.popover && !this.popover.contains(e.target as Node) && !(e.target as HTMLElement).closest('.cm-comment-marker, .pdf-pin, .pdf-comment-mark, .cm-comment-range, .cm-comment-tip')) this.closePopover();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.popover && !document.querySelector('.backdrop')) this.closePopover(); });
    // After the constructor returns: onChange may use the instance.
    queueMicrotask(() => this.refresh());
  }

  all(): CommentThread[] {
    return this.threads;
  }

  /** Open threads with text still attached — what the editor and PDF show. */
  visible(path?: string): CommentThread[] {
    if (!this.show) return [];
    return this.threads.filter((t) => !t.resolved && t.from !== null && (!path || t.path === path));
  }

  get openCount(): number {
    return this.threads.filter((t) => !t.resolved).length;
  }

  setShow(show: boolean): void {
    this.show = show;
    try { localStorage.setItem(SHOW_KEY, show ? '1' : '0'); } catch { /* ignore */ }
    this.renderPanel();
    this.opts.onChange();
  }

  private refresh(): void {
    this.threads = sortThreads(allThreads(this.opts.doc));
    this.renderPanel();
    if (this.popoverThread) {
      const t = this.threads.find((x) => x.id === this.popoverThread);
      if (t) this.popover?.replaceChildren(...this.threadBody(t, true));
      else this.closePopover();
    }
    this.opts.onChange();
  }

  private async act(body: Record<string, unknown>): Promise<boolean> {
    try {
      await api('POST', `/api/comments?project=${encodeURIComponent(this.opts.project)}`, body);
      return true;
    } catch (err) {
      toast((err as Error).message, 'bad');
      return false;
    }
  }

  // ------------------------------------------------------------ one thread

  private threadBody(t: CommentThread, inPopover: boolean): Node[] {
    const me = this.opts.me();
    const head = h('div', { class: 'thread-head' },
      h('span', { class: 'thread-where', title: 'Go to the text' },
        t.from === null ? `${t.path} · text deleted` : `${t.path}:${t.line}`),
      h('span', { class: 'spacer' }),
      t.resolved
        ? h('button', { class: 'ghost icon', title: 'Reopen this thread', onclick: () => void this.act({ op: 'reopen', id: t.id }) }, 'Reopen')
        : h('button', { class: 'ghost icon', title: 'Mark as resolved: hidden from the editor and PDF, kept in the list', onclick: () => void this.act({ op: 'resolve', id: t.id }).then((ok) => { if (ok && inPopover) this.closePopover(); }) }, '✓ Resolve'));
    head.querySelector('.thread-where')!.addEventListener('click', (e) => { e.stopPropagation(); this.opts.reveal(t); });
    const quote = h('div', { class: 'thread-quote', title: t.quote }, t.quote.length > 160 ? `${t.quote.slice(0, 160)}…` : t.quote);
    const messages = t.messages.map((m, i) => {
      const mine = m.login === me.login;
      const text = h('div', { class: 'msg-text' }, m.text);
      const tools = h('span', { class: 'msg-tools' });
      if (mine) {
        tools.append(h('button', { class: 'ghost icon', title: 'Edit', onclick: () => this.editMessage(t, m.id, m.text, text) }, 'edit'));
      }
      if (mine || this.opts.canModerate()) {
        tools.append(h('button', { class: 'ghost icon', title: i === 0 ? 'Delete the whole thread' : 'Delete this reply', onclick: async () => {
          if (i === 0 && !await confirmDialog('Delete thread', 'Delete this comment and all its replies?', 'Delete', true)) return;
          void this.act({ op: 'delete', id: t.id, messageId: m.id });
        } }, 'delete'));
      }
      return h('div', { class: 'msg' },
        h('div', { class: 'msg-head' },
          h('span', { class: 'msg-dot', style: `background:${colorFor(m.login.replace(/:agent$/, ''))}` }),
          h('span', { class: 'msg-author' }, m.author),
          h('span', { class: 'msg-time', title: new Date(m.ts).toLocaleString() }, `${formatTime(m.ts)}${m.edited ? ' · edited' : ''}`),
          h('span', { class: 'spacer' }), tools),
        text);
    });
    const reply = h('textarea', { class: 'reply-box', rows: '1', placeholder: t.resolved ? 'Reply (reopens the thread)…' : 'Reply…' });
    const send = h('button', { class: 'primary', hidden: true }, 'Reply');
    const submit = async () => {
      const text = reply.value.trim();
      if (!text) return;
      send.disabled = true;
      if (await this.act({ op: 'reply', id: t.id, text })) reply.value = '';
      send.disabled = false;
    };
    reply.addEventListener('input', () => { send.hidden = !reply.value.trim(); reply.style.height = 'auto'; reply.style.height = `${Math.min(160, reply.scrollHeight)}px`; });
    reply.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } e.stopPropagation(); });
    reply.addEventListener('click', (e) => e.stopPropagation());
    send.addEventListener('click', (e) => { e.stopPropagation(); void submit(); });
    return [head, quote, ...messages, h('div', { class: 'reply-row' }, reply, send)];
  }

  private editMessage(t: CommentThread, messageId: string, current: string, textEl: HTMLElement): void {
    const box = h('textarea', { class: 'reply-box', rows: '3' });
    box.value = current;
    const save = h('button', { class: 'primary' }, 'Save');
    const cancel = h('button', {}, 'Cancel');
    const row = h('div', { class: 'reply-row' }, box, cancel, save);
    textEl.replaceWith(row);
    box.focus();
    box.addEventListener('keydown', (e) => e.stopPropagation());
    cancel.addEventListener('click', () => row.replaceWith(textEl));
    save.addEventListener('click', () => void this.act({ op: 'edit', id: t.id, messageId, text: box.value }));
  }

  // ------------------------------------------------------------ popover

  /** Show a thread next to `rect` (a gutter marker, highlighted text or PDF pin). */
  openThread(id: string, rect: DOMRect): void {
    const t = this.threads.find((x) => x.id === id);
    if (!t) return;
    this.select(id);
    this.popoverThread = id;
    this.placePopover(this.threadBody(t, true), rect);
    (this.popover?.querySelector('.reply-box') as HTMLElement | null)?.focus();
  }

  /** The composer for a new comment on [from, to) of `path`. */
  compose(path: string, from: number, to: number, quote: string, rect: DOMRect, onDone: () => void): void {
    this.popoverThread = null;
    const box = h('textarea', { class: 'reply-box', rows: '3', placeholder: 'Add a comment…' });
    const post = h('button', { class: 'primary' }, 'Comment');
    const cancel = h('button', {}, 'Cancel');
    const submit = async () => {
      const text = box.value.trim();
      if (!text) { box.focus(); return; }
      post.disabled = true;
      if (await this.act({ op: 'create', path, from, to, text })) { this.closePopover(); onDone(); }
      post.disabled = false;
    };
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } e.stopPropagation(); });
    post.addEventListener('click', () => void submit());
    cancel.addEventListener('click', () => { this.closePopover(); onDone(); });
    this.placePopover([
      h('div', { class: 'thread-head' }, h('span', { class: 'thread-where' }, 'New comment')),
      h('div', { class: 'thread-quote' }, quote.length > 160 ? `${quote.slice(0, 160)}…` : quote),
      box,
      h('div', { class: 'actions' }, cancel, post),
    ], rect);
    box.focus();
  }

  private placePopover(content: Node[], rect: DOMRect): void {
    this.popover?.remove();
    const pop = h('div', { class: 'comment-popover' }, ...content);
    document.body.append(pop);
    const width = pop.offsetWidth;
    const left = Math.max(8, Math.min(rect.right + 10, window.innerWidth - width - 8));
    const top = Math.max(46, Math.min(rect.top - 8, window.innerHeight - pop.offsetHeight - 30));
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    this.popover = pop;
  }

  closePopover(): void {
    this.popover?.remove();
    this.popover = null;
    this.popoverThread = null;
  }

  // ------------------------------------------------------------ list

  select(id: string | null): void {
    this.selected = id;
    this.panel.querySelectorAll('.thread-card').forEach((c) => c.classList.toggle('selected', (c as HTMLElement).dataset.id === id));
    if (id) this.panel.querySelector(`.thread-card[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  private renderPanel(): void {
    const open = this.threads.filter((t) => !t.resolved);
    const resolved = this.threads.filter((t) => t.resolved);
    const toggle = h('label', { class: 'comments-toggle', title: 'Show comment highlights in the editor and pins in the PDF' },
      h('input', { type: 'checkbox', checked: this.show }), 'show in editor & PDF');
    toggle.querySelector('input')!.addEventListener('change', (e) => this.setShow((e.target as HTMLInputElement).checked));
    const filter = h('select', { title: 'Which threads to list' },
      h('option', { value: 'open', selected: this.filter === 'open' }, `Open (${open.length})`),
      h('option', { value: 'all', selected: this.filter === 'all' }, `All (${this.threads.length})`));
    filter.addEventListener('change', () => { this.filter = filter.value as 'open' | 'all'; this.renderPanel(); });
    const cards: Node[] = [];
    const list = this.filter === 'open' ? open : [...open, ...resolved];
    if (!list.length) {
      cards.push(h('div', { class: 'comments-empty' },
        this.threads.length ? 'No open comments.' : 'No comments yet. Select text in the editor and press Comment (Ctrl+Alt+M).'));
    }
    let resolvedHeading = false;
    for (const t of list) {
      if (t.resolved && !resolvedHeading) { cards.push(h('div', { class: 'comments-section' }, 'Resolved')); resolvedHeading = true; }
      const card = h('div', { class: `thread-card${t.resolved ? ' resolved' : ''}${t.id === this.selected ? ' selected' : ''}`, 'data-id': t.id }, ...this.threadBody(t, false));
      card.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('button, textarea, a')) return;
        this.select(t.id);
        this.opts.reveal(t);
      });
      cards.push(card);
    }
    const scroll = this.panel.querySelector('.comments-list')?.scrollTop ?? 0;
    // Keep a reply being typed across live updates.
    const typing = this.panel.contains(document.activeElement) && (document.activeElement as HTMLElement).classList.contains('reply-box');
    if (typing) return;
    const listEl = h('div', { class: 'comments-list' }, ...cards);
    this.panel.replaceChildren(h('div', { class: 'comments-bar' }, filter, h('span', { class: 'spacer' }), toggle), listEl);
    listEl.scrollTop = scroll;
  }
}
