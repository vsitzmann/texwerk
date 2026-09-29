/** Small DOM and chrome helpers shared by the picker and the editor. */

type Attrs = Record<string, string | number | boolean | EventListener | null | undefined>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = String(value);
    else if (key === 'style') node.setAttribute('style', String(value));
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

// ------------------------------------------------------------- identity

const NAME_KEY = 'texwerk-name';

export function storedName(): string {
  try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; }
}

export function storeName(name: string): void {
  try { localStorage.setItem(NAME_KEY, name); } catch { /* private window */ }
}

/** Every request carries the typed name (ignored when tailnet identity is on). */
export function withName(url: string): string {
  const u = new URL(url, location.href);
  const name = storedName();
  if (name) u.searchParams.set('name', name);
  return u.pathname + u.search;
}

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array) init.body = body as BodyInit;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
  }
  const response = await fetch(withName(url), init);
  const text = await response.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!response.ok) throw new Error((data as { error?: string })?.error ?? `${response.status} ${response.statusText}`);
  return data as T;
}

/** PUT with upload progress, for drag-and-drop uploads. */
export function upload(url: string, file: Blob, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', withName(url));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        let message = `${xhr.status}`;
        try { message = JSON.parse(xhr.responseText).error ?? message; } catch { /* keep */ }
        reject(new Error(message));
      }
    };
    xhr.onerror = () => reject(new Error('network error'));
    xhr.send(file);
  });
}

// ------------------------------------------------------------- feedback

let toastTimer: number | undefined;

export function toast(message: string, kind: 'ok' | 'bad' | '' = '', ms = 3500): void {
  document.querySelector('.toast')?.remove();
  const node = h('div', { class: `toast ${kind}` }, message);
  document.body.append(node);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.remove(), ms);
}

/**
 * Run `work` with delayed activity feedback: nothing for fast operations,
 * the status text after 500 ms for slow ones.
 */
export async function withBusy<T>(setStatus: (text: string | null) => void, text: string, work: () => Promise<T>): Promise<T> {
  const timer = window.setTimeout(() => setStatus(text), 500);
  try {
    return await work();
  } finally {
    window.clearTimeout(timer);
    setStatus(null);
  }
}

// ------------------------------------------------------------- dialogs

export function dialog(content: (close: () => void) => Node[], opts: { wide?: boolean; onClose?: () => void } = {}): () => void {
  const backdrop = h('div', { class: 'backdrop' });
  const box = h('div', { class: `dialog${opts.wide ? ' wide' : ''}`, role: 'dialog' });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  box.append(...content(close));
  backdrop.append(box);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  (box.querySelector('input, textarea, button.primary') as HTMLElement | null)?.focus();
  return close;
}

export function prompt(title: string, label: string, initial = '', okText = 'OK'): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    dialog((close) => {
      const input = h('input', { value: initial, spellcheck: 'false' });
      const finish = () => { result = input.value.trim() || null; close(); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(); });
      setTimeout(() => {
        input.focus();
        // Select the name without its extension, the part people usually change.
        const dot = initial.lastIndexOf('.');
        input.setSelectionRange(0, dot > 0 ? dot : initial.length);
      });
      return [
        h('h2', {}, title),
        h('p', { class: 'muted' }, label),
        input,
        h('div', { class: 'actions' },
          h('button', { onclick: close }, 'Cancel'),
          h('button', { class: 'primary', onclick: finish }, okText)),
      ];
    }, { onClose: () => resolve(result) });
  });
}

export function confirmDialog(title: string, message: string, okText: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    dialog((close) => [
      h('h2', {}, title),
      h('p', {}, message),
      h('div', { class: 'actions' },
        h('button', { onclick: close }, 'Cancel'),
        h('button', { class: danger ? 'danger' : 'primary', onclick: () => { result = true; close(); } }, okText)),
    ], { onClose: () => resolve(result) });
  });
}

/** A dropdown menu anchored under `anchor`. Closes on outside click. */
export function menu(anchor: HTMLElement, items: Node[]): () => void {
  document.querySelector('.menu')?.remove();
  const node = h('div', { class: 'menu' }, ...items);
  document.body.append(node);
  const rect = anchor.getBoundingClientRect();
  const width = node.offsetWidth;
  node.style.top = `${rect.bottom + 2}px`;
  node.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - width - 4))}px`;
  const close = () => { node.remove(); document.removeEventListener('mousedown', outside, true); };
  const outside = (e: MouseEvent) => { if (!node.contains(e.target as Node) && e.target !== anchor) close(); };
  setTimeout(() => document.addEventListener('mousedown', outside, true));
  node.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('button')) close(); });
  return close;
}

export function menuAt(x: number, y: number, items: Node[]): void {
  const anchor = h('div', { style: `position:fixed;left:${x}px;top:${y}px;width:0;height:0` });
  document.body.append(anchor);
  menu(anchor, items);
  setTimeout(() => anchor.remove());
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const scratch = h('textarea', { style: 'position:fixed;opacity:0' });
  scratch.value = text;
  document.body.append(scratch);
  scratch.select();
  document.execCommand('copy');
  scratch.remove();
}

export function timeAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `today ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })} ${time}`;
}

export function initials(name: string): string {
  const parts = name.replace(/ · agent$/, '').split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}
