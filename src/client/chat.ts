import type * as Y from 'yjs';
import { chatArray, mentionsName, refLabel, type ChatMessage, type ChatRef } from '@shared/chat.ts';
import { colorFor } from '@shared/files.ts';
import { api, formatTime, h, toast } from './ui.ts';

/**
 * The project chat in the browser (the Chat tab). Messages come from the
 * project's Y.Doc, so the list updates live; sending goes through /api/chat,
 * so view-only people can chat too. Unread messages are counted against the
 * last one read in this browser, per project; a mention of you (or @all /
 * @everyone) also shows in the window title and, if you switched on the bell
 * and the page is hidden, as a browser notification.
 */

export interface ChatOptions {
  project: () => string;
  doc: Y.Doc;
  me: () => { login: string; name: string };
  /** Names of the people here now, for @-completion. */
  present: () => string[];
  /** Whether the Chat tab is what the viewer shows. */
  visible: () => boolean;
  openRef: (ref: ChatRef) => void;
  /** The unread count or mention state changed. */
  onChange: () => void;
  /** Path of a text file in the project, if `path` is one (for linking file:line in text). */
  isFile: (path: string) => boolean;
}

const NOTIFY_KEY = 'texwerk-chat-notify';
const readKey = (project: string) => `texwerk-chat-read:${project}`;
/** file.tex:12 and comment:ab12cd34 in a message become links. */
const LINK_RE = /([\w./-]+\.[A-Za-z]{1,5}):(\d+)|comment:([\w-]+)/g;
const MAX_SHOWN = 500;

export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 6 * 3600) return `${Math.round(s / 3600)} h ago`;
  return formatTime(ts);
}

export class Chat {
  readonly panel = h('div', { class: 'chat-view' });
  private readonly opts: ChatOptions;
  private readonly list = h('div', { class: 'chat-list' });
  private readonly input = h('textarea', { class: 'reply-box chat-input', rows: '1', placeholder: 'Message… (@ to mention, Enter to send)' });
  private readonly suggest = h('div', { class: 'chat-suggest', hidden: true });
  private readonly bell = h('button', { class: 'ghost icon chat-bell' });
  private messages: ChatMessage[] = [];
  private lastRead = 0;
  private seen = new Set<string>();
  private picked = new Set<string>();
  private choices: string[] = [];
  private choice = 0;
  unread = 0;
  mentioned = 0;

  constructor(opts: ChatOptions) {
    this.opts = opts;
    try { this.lastRead = Number(localStorage.getItem(readKey(opts.project()))) || 0; } catch { /* private window */ }
    const send = h('button', { class: 'primary', title: 'Send (Enter)' }, 'Send');
    send.addEventListener('click', () => void this.send());
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('input', () => { this.grow(); this.updateSuggest(); });
    this.input.addEventListener('blur', () => setTimeout(() => { this.suggest.hidden = true; }, 150));
    this.bell.addEventListener('click', () => void this.toggleNotify());
    this.renderBell();
    this.panel.append(
      h('div', { class: 'comments-bar' }, h('span', { class: 'chat-title' }, 'Project chat'), h('span', { class: 'spacer' }), this.bell),
      this.list,
      h('div', { class: 'chat-compose' }, this.suggest, this.input, send));
    const array = chatArray(opts.doc);
    let queued = false;
    array.observe(() => {
      if (queued) return;
      queued = true;
      // Not requestAnimationFrame: it stalls in a hidden tab, which is when notifications matter.
      window.setTimeout(() => { queued = false; this.refresh(); }, 30);
    });
    document.addEventListener('visibilitychange', () => this.markReadIfSeen());
    window.addEventListener('focus', () => this.markReadIfSeen());
    // Relative times age.
    setInterval(() => { if (this.opts.visible()) this.renderList(false); }, 60_000);
    queueMicrotask(() => {
      // What is already there on load is never "new": no notifications for it.
      this.seen = new Set(array.toArray().map((m) => m.id));
      this.refresh();
    });
  }

  private mine(m: ChatMessage): boolean {
    const me = this.opts.me();
    return !m.agent && m.author === me.name && (m.login ?? '') === me.login;
  }

  private forMe(m: ChatMessage): boolean {
    return !this.mine(m) && mentionsName(m, this.opts.me().name);
  }

  private refresh(): void {
    this.messages = chatArray(this.opts.doc).toArray();
    for (const m of this.messages) {
      if (this.seen.has(m.id)) continue;
      this.seen.add(m.id);
      if (this.forMe(m) && document.hidden) this.notify(m);
    }
    this.renderList(true);
    this.markReadIfSeen();
    this.count();
  }

  private count(): void {
    const unread = this.messages.filter((m) => m.ts > this.lastRead && !this.mine(m));
    const mentioned = unread.filter((m) => this.forMe(m)).length;
    if (unread.length === this.unread && mentioned === this.mentioned) return;
    this.unread = unread.length;
    this.mentioned = mentioned;
    this.opts.onChange();
  }

  /** "(N) " for unread mentions, to put in front of the window title. */
  get titlePrefix(): string {
    return this.mentioned ? `(${this.mentioned}) ` : '';
  }

  /** The Chat tab is showing and the page is in front: everything is read. */
  markReadIfSeen(): void {
    if (!this.opts.visible() || document.hidden || !this.messages.length) return;
    const last = this.messages[this.messages.length - 1].ts;
    if (last > this.lastRead) {
      this.lastRead = last;
      try { localStorage.setItem(readKey(this.opts.project()), String(last)); } catch { /* ignore */ }
    }
    this.count();
  }

  /** The tab was opened: show the newest message and the input. */
  shown(): void {
    this.renderList(true);
    this.markReadIfSeen();
    this.input.focus();
  }

  // ------------------------------------------------------------ notifications

  private notifyOn(): boolean {
    try { return localStorage.getItem(NOTIFY_KEY) === '1' && 'Notification' in window && Notification.permission === 'granted'; } catch { return false; }
  }

  private renderBell(): void {
    const on = this.notifyOn();
    this.bell.textContent = on ? '🔔' : '🔕';
    this.bell.classList.toggle('on', on);
    this.bell.title = on
      ? 'Notifications on: you get one when you are mentioned while this tab is in the background. Click to turn off.'
      : 'Get a browser notification when you are mentioned (or @all) while this tab is in the background';
  }

  private async toggleNotify(): Promise<void> {
    if (!('Notification' in window)) { toast('This browser has no notifications.', 'bad'); return; }
    if (this.notifyOn()) {
      try { localStorage.setItem(NOTIFY_KEY, '0'); } catch { /* ignore */ }
    } else {
      // Asked only here, on a click: browsers ignore requests without one.
      const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      if (permission !== 'granted') toast('Notifications are blocked for this site in the browser settings.', 'bad');
      else try { localStorage.setItem(NOTIFY_KEY, '1'); } catch { /* ignore */ }
    }
    this.renderBell();
  }

  private notify(m: ChatMessage): void {
    if (!this.notifyOn()) return;
    try {
      const n = new Notification(`${m.author} in ${this.opts.project()}`, { body: m.text.slice(0, 300), tag: `texwerk-chat-${m.id}` });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* not allowed here */ }
  }

  // ------------------------------------------------------------ list

  private textWithLinks(text: string): Node[] {
    const out: Array<Node | string> = [];
    let at = 0;
    for (const match of text.matchAll(LINK_RE)) {
      const ref: ChatRef | null = match[3] ? { commentId: match[3] } : this.opts.isFile(match[1]) ? { file: match[1], line: Number(match[2]) } : null;
      if (!ref) continue;
      out.push(text.slice(at, match.index), this.refLink(ref, match[0]));
      at = match.index! + match[0].length;
    }
    out.push(text.slice(at));
    return out.map((x) => (typeof x === 'string' ? document.createTextNode(x) : x));
  }

  private refLink(ref: ChatRef, label = refLabel(ref)): HTMLElement {
    return h('a', { class: 'chat-ref', href: '#', title: 'commentId' in ref ? 'Open the comment thread' : 'Go to this line', onclick: (e: Event) => { e.preventDefault(); this.opts.openRef(ref); } }, label);
  }

  private renderList(stick: boolean): void {
    const atBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
    const shown = this.messages.slice(-MAX_SHOWN);
    const now = Date.now();
    const items: Node[] = [];
    if (!shown.length) {
      items.push(h('div', { class: 'comments-empty' }, 'No messages yet. Write to everyone working on this project; @agent reaches a mirrored agent waiting with ', h('code', {}, 'tw chat --wait'), '.'));
    }
    let prev: ChatMessage | null = null;
    for (const m of shown) {
      const color = colorFor(m.agent && m.login ? `${m.login}:agent` : m.login || m.author);
      const grouped = prev && prev.author === m.author && m.ts - prev.ts < 5 * 60_000;
      const unread = m.ts > this.lastRead && !this.mine(m);
      const item = h('div', { class: `chat-msg${this.forMe(m) ? ' mention' : ''}${unread ? ' unread' : ''}${grouped ? ' grouped' : ''}`, 'data-id': m.id });
      if (!grouped) {
        item.append(h('div', { class: 'msg-head' },
          h('span', { class: 'msg-dot', style: `background:${color}` }),
          h('span', { class: 'msg-author' }, m.author),
          h('span', { class: 'msg-time', title: new Date(m.ts).toLocaleString() }, relativeTime(m.ts, now))));
      }
      item.append(h('div', { class: 'msg-text' }, ...this.textWithLinks(m.text), m.ref ? h('span', { class: 'chat-ref-wrap' }, ' → ', this.refLink(m.ref)) : null));
      items.push(item);
      prev = m;
    }
    this.list.replaceChildren(...items);
    if (stick && atBottom || stick && this.opts.visible()) this.list.scrollTop = this.list.scrollHeight;
  }

  // ------------------------------------------------------------ composing

  private grow(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(160, this.input.scrollHeight)}px`;
  }

  private async send(): Promise<void> {
    const text = this.input.value.trim();
    if (!text) return;
    const mentions = [...this.picked].filter((n) => text.includes(`@${n}`));
    try {
      await api('POST', `/api/chat?project=${encodeURIComponent(this.opts.project())}`, { text, mentions });
      this.input.value = '';
      this.picked.clear();
      this.grow();
    } catch (err) {
      toast((err as Error).message, 'bad');
    }
  }

  /** The "@na" being typed before the caret, if any. */
  private typedMention(): { start: number; query: string } | null {
    const before = this.input.value.slice(0, this.input.selectionStart ?? 0);
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    return m ? { start: before.length - m[2].length - 1, query: m[2].toLowerCase() } : null;
  }

  private updateSuggest(): void {
    const typed = this.typedMention();
    if (!typed) { this.suggest.hidden = true; this.choices = []; return; }
    const me = this.opts.me().name;
    const names = [...new Set([...this.opts.present().filter((n) => n !== me && !/ · agent$/.test(n)), 'agent', 'all'])];
    this.choices = names.filter((n) => n.toLowerCase().split(/\s+/).some((w) => w.startsWith(typed.query)) || n.toLowerCase().startsWith(typed.query)).slice(0, 8);
    if (!this.choices.length) { this.suggest.hidden = true; return; }
    this.choice = Math.min(this.choice, this.choices.length - 1);
    this.suggest.replaceChildren(...this.choices.map((n, i) => {
      const hint = n === 'agent' ? 'mirrored agents' : n === 'all' ? 'everyone in this project' : '';
      const row = h('div', { class: `chat-choice${i === this.choice ? ' active' : ''}` }, `@${n}`, hint ? h('span', { class: 'hint' }, hint) : null);
      row.addEventListener('mousedown', (e) => { e.preventDefault(); this.pick(n); });
      return row;
    }));
    this.suggest.hidden = false;
  }

  private pick(name: string): void {
    const typed = this.typedMention();
    if (!typed) return;
    const caret = this.input.selectionStart ?? this.input.value.length;
    const v = this.input.value;
    this.input.value = `${v.slice(0, typed.start)}@${name} ${v.slice(caret)}`;
    const at = typed.start + name.length + 2;
    this.input.setSelectionRange(at, at);
    this.picked.add(name);
    this.suggest.hidden = true;
    this.choices = [];
    this.input.focus();
  }

  private onKey(e: KeyboardEvent): void {
    e.stopPropagation();
    if (!this.suggest.hidden && this.choices.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.choice = (this.choice + (e.key === 'ArrowDown' ? 1 : -1) + this.choices.length) % this.choices.length;
        this.updateSuggest();
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); this.pick(this.choices[this.choice]); return; }
      if (e.key === 'Escape') { e.preventDefault(); this.suggest.hidden = true; return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void this.send(); }
  }
}
