import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { colorFor } from '@shared/files.ts';
import { Provider } from '@shared/provider.ts';
import type { BinInfo, CompileSummary, Identity, ProjectSettings, ServerEvent } from '@shared/protocol.ts';
import { CodeEditor } from './codeEditor.ts';
import { FileTree } from './tree.ts';
import { HistoryView } from './historyView.ts';
import { Viewer, type PdfPin } from './viewer.ts';
import { Comments } from './comments.ts';
import { authorRuns } from '@shared/provenance.ts';
import type { AuthorInfo } from '@shared/protocol.ts';
import type { CommentThread } from '@shared/comments.ts';
import { api, copyText, dialog, h, initials, menu, storedName, storeName, toast, withName } from './ui.ts';
import { showPicker, showShareDialog, type Me } from './picker.ts';

/**
 * The project editor: file tree | code editor | PDF viewer, with live
 * collaboration over one WebSocket. Everyone's caret and selection show in
 * the editor; everyone's current file shows in the tree and the toolbar.
 */

interface PeerState {
  user?: { name: string; color: string; colorLight: string; agent?: boolean };
  file?: string | null;
  cursor?: unknown;
}

export async function renderEditor(app: HTMLElement, project: string, meInfo: Me): Promise<void> {
  const access = meInfo.access;
  // `project` changes when the project is renamed from here or elsewhere
  // (followMove); everything reads it at the time of use.
  let projectName = project.split('/').pop()!;
  document.title = `${projectName} — TeXWerk`;
  let readOnly = false;
  const doc = new Y.Doc();
  const texts = doc.getMap<Y.Text>('text');
  const bins = doc.getMap<BinInfo>('bin');
  const dirs = doc.getMap<boolean>('dirs');
  const awareness = new Awareness(doc);
  let me: Identity = { login: '', name: storedName() || 'Anonymous', color: colorFor(storedName()) };
  let settings: ProjectSettings = { mainFile: '', engine: 'pdflatex', autoCompile: true };
  let compile: CompileSummary | null = null;
  let current: CodeEditor | null = null;
  let currentPath: string | null = null;
  let historyView: HistoryView | null = null;

  // ------------------------------------------------------------ chrome
  const presenceEl = h('div', { class: 'presence' });
  const brand = h('a', { class: 'brand', href: './', title: 'All projects' }, '‹ TEXWERK');
  brand.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    showPicker({ me: meInfo, dismissable: true, current: project });
  });
  const compileBtn = h('button', { class: 'primary', title: 'Compile (Ctrl+S / Ctrl+Enter)' }, '▶ Recompile');
  const compileMore = h('button', { class: 'primary', title: 'Compile settings' }, '▾');
  const historyBtn = h('button', { title: 'Full edit history, labelled versions' }, 'History');
  const labelBtn = h('button', { title: 'Save a named version (a git commit)' }, 'Label version');
  const gitBtn = h('button', { title: 'Git remote, push and pull' }, 'Git…');
  const agentBtn = h('button', { title: 'Mirror this project to your computer for your editor or agent' }, 'Agent…');
  const downloadBtn = h('button', { title: 'Download' }, 'Download ▾');
  const shareBtn = h('button', { title: 'Who can open and edit this project' }, 'Share…');
  // Narrow windows show one of editor and viewer at a time.
  const paneToggle = h('button', { class: 'pane-toggle', title: 'Switch between the editor and the PDF' }, 'PDF');
  paneToggle.addEventListener('click', () => {
    const showing = body.classList.toggle('show-viewer');
    paneToggle.textContent = showing ? 'Editor' : 'PDF';
  });
  const roBadge = h('span', { class: 'readonly-badge', title: 'You have view-only access to this project', hidden: true }, 'view only');
  const titleEl = h('span', { class: 'title', title: project }, projectName);
  const toolbar = h('div', { class: 'toolbar' },
    brand,
    h('span', { class: 'sep' }),
    titleEl,
    roBadge,
    h('span', { class: 'group' }, compileBtn, compileMore),
    h('span', { class: 'spacer' }),
    presenceEl,
    h('span', { class: 'sep' }),
    historyBtn, labelBtn, gitBtn, agentBtn, ...(access ? [shareBtn] : []), downloadBtn, paneToggle);

  const statusConn = h('span', {}, h('span', { class: 'dot' }), 'connecting');
  const statusCompile = h('span', {});
  const statusBusy = h('span', { class: 'busy' });
  const statusCursor = h('span', {});
  const statusbar = h('div', { class: 'statusbar' }, statusConn, statusCompile, statusBusy, h('span', { class: 'spacer' }), statusCursor);

  const setStatus = (text: string | null) => { statusBusy.textContent = text ?? ''; };

  const editorHead = h('div', { class: 'pane-head' }, h('span', { class: 'label' }, 'Editor'));
  // Authors: colour the text by who last wrote each part of it.
  const authorsMap = doc.getMap<AuthorInfo>('authors');
  let showAuthors = false;
  try { showAuthors = localStorage.getItem('texwerk-show-authors') === '1'; } catch { /* default off */ }
  const authorsBtn = h('button', { class: `ghost icon authors-toggle${showAuthors ? ' on' : ''}`, title: 'Colour the text by who last wrote it' }, 'Authors');
  const authorsLegend = h('span', { class: 'authors-legend' });
  authorsBtn.addEventListener('click', () => {
    showAuthors = !showAuthors;
    authorsBtn.classList.toggle('on', showAuthors);
    try { localStorage.setItem('texwerk-show-authors', showAuthors ? '1' : '0'); } catch { /* ignore */ }
    updateAuthors();
  });
  let authorsTimer: number | undefined;
  function scheduleAuthors(): void {
    if (!showAuthors) return;
    window.clearTimeout(authorsTimer);
    authorsTimer = window.setTimeout(updateAuthors, 250);
  }
  function updateAuthors(): void {
    if (!current || !currentPath) return;
    const ytext = texts.get(currentPath);
    if (!showAuthors || !ytext) {
      current.setAuthors(null);
      authorsLegend.replaceChildren();
      return;
    }
    const runs = authorRuns(ytext, authorsMap);
    const total = runs.reduce((n, r) => n + (r.to - r.from), 0) || 1;
    const share = new Map<string, { chars: number; color: string }>();
    for (const r of runs) {
      const s = share.get(r.author) ?? { chars: 0, color: r.color };
      s.chars += r.to - r.from;
      share.set(r.author, s);
    }
    current.setAuthors(runs.map((r) => ({ from: r.from, to: r.to, color: r.color, label: `Last written by ${r.author}` })));
    authorsLegend.replaceChildren(...[...share.entries()].sort((a, b) => b[1].chars - a[1].chars).map(([name, s]) =>
      h('span', { class: 'authors-chip', style: `--c:${s.color}`, title: `${name}: ${(s.chars / total * 100).toFixed(1)}% of this file` },
        `${name} ${Math.round(s.chars / total * 100)}%`)));
  }
  doc.getMap('text').observeDeep(() => scheduleAuthors());
  // Vim keybindings, per browser.
  let vimOn = false;
  try { vimOn = localStorage.getItem('texwerk-vim') === '1'; } catch { /* default off */ }
  const vimBtn = h('button', { class: `ghost icon authors-toggle${vimOn ? ' on' : ''}`, title: 'Vim keybindings (:w compiles)' }, 'Vim');
  vimBtn.addEventListener('click', () => {
    vimOn = !vimOn;
    vimBtn.classList.toggle('on', vimOn);
    try { localStorage.setItem('texwerk-vim', vimOn ? '1' : '0'); } catch { /* ignore */ }
    current?.setVim(vimOn);
    current?.view.focus();
  });
  authorsMap.observe(() => scheduleAuthors());
  const editorHost = h('div', { class: 'editor-host' });
  const editorPane = h('div', { class: 'pane' }, editorHead, editorHost);

  const tree = new FileTree({
    project: () => project, texts, bins, dirs,
    onOpen: (path) => openFile(path),
    setStatus,
    getMainFile: () => settings.mainFile,
    setMainFile: (path) => void saveSettings({ mainFile: path }),
  });
  const viewer = new Viewer({
    project: () => project,
    onJumpToSource: (file, line) => openFile(file, line),
    onCloseFile: () => tree.setViewing(null),
    onSyncFromCursor: () => void syncToPdf(),
    onPinClick: (id, rect) => comments.openThread(id, rect),
    onPdfLoaded: () => schedulePins(0),
  });

  // ------------------------------------------------------------ comments
  let pinsTimer: number | undefined;
  let pinsRequest = 0;
  const comments = new Comments({
    project: () => project,
    doc,
    me: () => me,
    canModerate: () => meInfo.admin,
    reveal: (t) => revealThread(t),
    onChange: () => {
      updateEditorComments();
      viewer.setCommentsPanel(comments.panel, comments.openCount);
      schedulePins(500);
    },
  });
  viewer.setCommentsPanel(comments.panel, comments.openCount);

  function updateEditorComments(): void {
    if (!current || !currentPath) return;
    current.setComments(comments.visible(currentPath).map((t) => ({
      id: t.id, from: t.from!, to: t.to!, color: colorFor(t.login.replace(/:agent$/, '')), replies: t.messages.length,
    })));
  }

  function revealThread(t: CommentThread): void {
    if (t.from === null) { toast('The text this comment was on has been deleted.'); return; }
    openFile(t.path);
    setTimeout(() => current?.selectRange(t.from!, t.to!), 0);
  }

  function schedulePins(delay: number): void {
    window.clearTimeout(pinsTimer);
    pinsTimer = window.setTimeout(() => void refreshPins(), delay);
  }
  async function refreshPins(): Promise<void> {
    const threads = comments.visible();
    if (!viewer.pdfLoaded || !threads.length) { viewer.setPins([]); return; }
    const request = ++pinsRequest;
    try {
      const r = await api<{ results: Array<{ page: number; x: number; top: number; bottom: number } | null> }>('POST', `/api/synctex/lines?project=${encodeURIComponent(project)}`,
        { items: threads.map((t) => ({ file: t.path, line: t.line })) });
      if (request !== pinsRequest) return;
      const pins: PdfPin[] = [];
      for (const [i, t] of threads.entries()) {
        const pos = r.results[i];
        if (!pos) continue;
        // SyncTeX knows the paragraph; the PDF's own text says where the words are.
        const spot = await viewer.locate(pos.page, pos.top, pos.bottom, t.quote, pos.x);
        if (!spot) continue;
        pins.push({ id: t.id, page: pos.page, x: spot.x, y: spot.y, width: spot.width, height: spot.height, color: colorFor(t.login.replace(/:agent$/, '')), title: `${t.messages[0]?.author}: ${t.messages[0]?.text ?? ''}`.slice(0, 200) });
      }
      if (request !== pinsRequest) return;
      viewer.setPins(pins);
    } catch { /* no synctex: no pins */ }
  }

  const leftSplit = h('div', { class: 'splitter' });
  const rightSplit = h('div', { class: 'splitter right' });
  const body = h('div', { class: 'body' }, tree.root, leftSplit, editorPane, rightSplit, viewer.root);
  const shell = h('div', { class: 'shell' }, toolbar, h('div'), body, statusbar);
  app.replaceChildren(shell);
  restoreLayout(body);
  bindSplitter(leftSplit, body, 'left');
  bindSplitter(rightSplit, body, 'right');

  if (!access) {
    // A small way to change the typed name without leaving the project.
    const nameInput = h('input', { value: storedName(), spellcheck: 'false' });
    const rename = () => {
      const v = nameInput.value.trim();
      if (!v || v === storedName()) return;
      storeName(v);
      location.reload();
    };
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') rename(); });
    statusbar.insertBefore(h('span', {}, 'you: ', nameInput), statusCursor);
    nameInput.style.cssText = 'width:120px;padding:0 5px;height:18px;font-size:11px';
  }

  // ------------------------------------------------------------ connection
  const wsUrl = () => {
    const url = new URL(withName(`/ws?project=${encodeURIComponent(project)}`), location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.href;
  };
  let synced = false;
  let pendingOpen: string | null = new URLSearchParams(location.search).get('file');
  const provider = new Provider({
    url: wsUrl(),
    doc,
    awareness,
    onStatus: (status, detail) => {
      const dot = status === 'connected' ? 'ok' : status === 'connecting' ? 'warn' : 'bad';
      statusConn.replaceChildren(h('span', { class: `dot ${dot}` }), status === 'connected' ? 'live' : status === 'connecting' ? 'connecting…' : `offline${detail ? ` — ${detail}` : ' — reconnecting'}`);
    },
    onSynced: () => {
      if (synced) return;
      synced = true;
      const initial = pendingOpen && (texts.has(pendingOpen) || bins.has(pendingOpen)) ? pendingOpen
        : settings.mainFile && texts.has(settings.mainFile) ? settings.mainFile
          : [...texts.keys()].find((p) => p.endsWith('.tex')) ?? null;
      pendingOpen = null;
      if (initial) openFile(initial);
      else showPlaceholder();
    },
    onEvent: (event) => onServerEvent(event),
    // The server restarted and reloaded the project: this tab's copy belongs
    // to the old document. Start over from the server's.
    onReset: () => {
      statusConn.replaceChildren(h('span', { class: 'dot warn' }), 'server restarted — reloading…');
      setTimeout(() => location.reload(), 600);
    },
  });
  window.addEventListener('beforeunload', () => provider.destroy());

  function onServerEvent(event: ServerEvent): void {
    if (event.t === 'hello') {
      me = event.you;
      settings = event.settings;
      if (event.readOnly !== readOnly) {
        readOnly = event.readOnly;
        applyReadOnly();
      }
      awareness.setLocalStateField('user', { name: me.name, color: me.color, colorLight: `${me.color}33` });
      setCompile(event.compile);
      void api<{ compile: CompileSummary; output: string; log: string }>('GET', `/api/compile?project=${encodeURIComponent(project)}`)
        .then((r) => viewer.setCompile(r.compile, r.output, r.log));
      tree.render();
    } else if (event.t === 'compile') {
      setCompile(event.compile);
      if (event.compile.state === 'done') {
        void api<{ compile: CompileSummary; output: string; log: string }>('GET', `/api/compile?project=${encodeURIComponent(project)}`)
          .then((r) => viewer.setCompile(r.compile, r.output, r.log));
      }
    } else if (event.t === 'settings') {
      settings = event.settings;
      tree.render();
    } else if (event.t === 'history' || event.t === 'git') {
      if (historyView) scheduleHistoryRefresh();
    } else if (event.t === 'renamed') {
      if (currentPath === event.from) setTimeout(() => openFile(event.to), 30);
    } else if (event.t === 'moved') {
      followMove(event.to);
    } else if (event.t === 'notice') {
      toast(event.message);
    }
  }

  /** View-only access: nothing on screen may look like it changes the project. */
  function applyReadOnly(): void {
    roBadge.hidden = !readOnly;
    updateTitleAffordance();
    for (const b of [compileMore, labelBtn, gitBtn, agentBtn]) b.hidden = readOnly;
    tree.setReadOnly(readOnly);
    if (currentPath) {
      const path = currentPath;
      currentPath = null;
      openFile(path);
    }
  }

  shareBtn.addEventListener('click', () => showShareDialog(project, meInfo));

  // ------------------------------------------------------------ renaming
  /**
   * The project now lives at `to` — renamed from this tab or another. The
   * server closes our socket once the folder has moved; pointing the provider
   * at the new id first makes the reconnect resume the same document.
   */
  function followMove(to: string): void {
    if (to === project) return;
    project = to;
    projectName = to.split('/').pop()!;
    if (!titleEl.querySelector('input')) titleEl.textContent = projectName;
    document.title = `${projectName} — TeXWerk`;
    const params = new URLSearchParams(location.search);
    params.set('project', to);
    history.replaceState(history.state, '', `${location.pathname}?${params}`);
    provider.setUrl(wsUrl());
  }

  // Click the name to rename the project in place. Only the owner may (the
  // server checks too); a view-only person or a non-owner just sees the name.
  let canRename = !access;
  const updateTitleAffordance = () => {
    titleEl.classList.toggle('editable', canRename && !readOnly);
    titleEl.title = canRename && !readOnly ? `${project} — click to rename` : project;
  };
  if (access) {
    void api<{ canManage?: boolean }>('GET', `/api/access?project=${encodeURIComponent(project)}`)
      .then((r) => { canRename = Boolean(r.canManage); updateTitleAffordance(); }, () => {});
  }
  updateTitleAffordance();
  titleEl.addEventListener('click', () => {
    if (!canRename || readOnly || titleEl.querySelector('input')) return;
    const input = h('input', { class: 'title-input', value: projectName, spellcheck: 'false', maxlength: '120', 'aria-label': 'Project name' });
    // As wide as the name, so the toolbar does not jump while typing.
    const fit = () => { input.style.width = `${Math.max(8, input.value.length + 2)}ch`; };
    fit();
    titleEl.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (commit: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (commit && name && name !== projectName) {
        input.disabled = true;
        setStatus('Renaming…');
        try {
          const r = await api<{ id: string }>('POST', `/api/projects/rename?project=${encodeURIComponent(project)}&newName=${encodeURIComponent(name)}`);
          followMove(r.id);
          toast(`Renamed to ${projectName}`, 'ok');
        } catch (err) {
          toast((err as Error).message, 'bad');
        } finally {
          setStatus(null);
        }
      }
      titleEl.replaceChildren(projectName);
      updateTitleAffordance();
    };
    input.addEventListener('input', fit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); void finish(false); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => void finish(true));
  });

  // ------------------------------------------------------------ files
  function showPlaceholder(): void {
    current?.destroy();
    current = null;
    currentPath = null;
    editorHead.replaceChildren(h('span', { class: 'label' }, 'Editor'));
    editorHost.replaceChildren(h('div', { class: 'editor-placeholder' },
      h('div', {}, h('div', {}, 'No file open.'), h('div', { class: 'muted' }, 'Pick a file on the left, or drop files there to upload.'))));
    awareness.setLocalStateField('file', null);
    awareness.setLocalStateField('cursor', null);
    tree.select(null);
  }

  function openFile(path: string, line?: number): void {
    if (historyView) closeHistory();
    const ytext = texts.get(path);
    if (!ytext) {
      const info = bins.get(path);
      if (!info) { toast(`${path} is not in the project`, 'bad'); return; }
      viewer.showFile(path, info.hash);
      tree.setViewing(path);
      return;
    }
    if (currentPath !== path) {
      current?.destroy();
      // Our caret leaves the old file before it appears in the new one.
      awareness.setLocalStateField('cursor', null);
      editorHost.replaceChildren();
      current = new CodeEditor(editorHost, {
        path,
        ytext,
        readOnly,
        awareness,
        vim: vimOn,
        project: {
          texts: () => [...texts.entries()].map(([p, t]) => [p, () => t.toString()] as [string, () => string]),
          files: () => [...texts.keys(), ...bins.keys()],
        },
        onCursor: (l, c) => { statusCursor.textContent = `Ln ${l}, Col ${c}`; },
        onCompile: () => void runCompile(),
        onSyncToPdf: () => void syncToPdf(),
        onComment: (from, to, rect) => {
          const quote = ytext.toString().slice(from, to);
          comments.compose(path, from, to, quote, rect, () => current?.view.focus());
        },
        onOpenThread: (ids, rect) => comments.openThread(ids[0], rect),
      });
      currentPath = path;
      updateEditorComments();
      awareness.setLocalStateField('file', path);
      const isMain = path === settings.mainFile;
      editorHead.replaceChildren(
        h('span', { class: 'label' }, 'Editor'),
        h('span', { class: 'path' }, path),
        isMain ? h('span', { class: 'main-badge', style: 'color:var(--yellow);font-size:9.5px' }, 'MAIN') : '',
        h('span', { class: 'spacer' }),
        authorsLegend,
        authorsBtn,
        vimBtn);
      updateAuthors();
      tree.select(path);
      const url = new URL(location.href);
      url.searchParams.set('file', path);
      history.replaceState(null, '', url);
    }
    if (line) setTimeout(() => current?.goToLine(line), 0);
    else current!.view.focus();
  }

  // An open file deleted or renamed elsewhere.
  texts.observe((event) => {
    if (currentPath && event.keysChanged.has(currentPath) && !texts.has(currentPath)) {
      const gone = currentPath;
      setTimeout(() => { if (currentPath === gone && !texts.has(gone)) showPlaceholder(); }, 60);
    }
  });
  bins.observe((event) => {
    const viewing = viewer.viewingFile;
    if (viewing && event.keysChanged.has(viewing)) {
      const info = bins.get(viewing);
      if (info) viewer.showFile(viewing, info.hash);
      else { viewer.closeFile(); tree.setViewing(null); }
    }
  });

  // ------------------------------------------------------------ presence
  function renderPresence(): void {
    const people: Array<{ id: number; state: PeerState }> = [];
    const byFile = new Map<string, string[]>();
    for (const [id, state] of awareness.getStates() as Map<number, PeerState>) {
      if (!state.user) continue;
      people.push({ id, state });
      if (id !== doc.clientID && state.file) {
        const list = byFile.get(state.file) ?? [];
        list.push(`${state.user.name}|${state.user.color}`);
        byFile.set(state.file, list);
      }
    }
    tree.setPresence(byFile);
    people.sort((a, b) => (a.id === doc.clientID ? -1 : b.id === doc.clientID ? 1 : a.state.user!.name.localeCompare(b.state.user!.name)));
    presenceEl.replaceChildren(...people.map(({ id, state }) => {
      const u = state.user!;
      const isMe = id === doc.clientID;
      const agent = Boolean(u.agent) || / · agent$/.test(u.name);
      const node = h('span', {
        class: `person${isMe ? ' me' : ''}${agent ? ' agent' : ''}`,
        style: `background:${u.color}`,
        title: `${u.name}${isMe ? ' (you)' : ''}${state.file ? ` — ${state.file}` : ''}`,
      }, agent ? '⚙' : initials(u.name));
      if (!isMe && state.file) node.addEventListener('click', () => followPeer(state));
      return node;
    }));
  }
  awareness.on('change', renderPresence);

  /** Jump to where someone is working. */
  function followPeer(state: PeerState): void {
    if (!state.file) return;
    openFile(state.file);
    const cursor = state.cursor as { head?: unknown } | null | undefined;
    const ytext = texts.get(state.file);
    if (cursor?.head && ytext && current) {
      try {
        const rel = Y.createRelativePositionFromJSON(cursor.head);
        const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc);
        if (abs && abs.type === ytext) current.revealPosition(abs.index);
      } catch { /* stale */ }
    }
  }

  // ------------------------------------------------------------ compile
  let compileClickedAt = 0;
  let compileLabelTimer: number | undefined;
  function setCompile(summary: CompileSummary): void {
    compile = summary;
    viewer.setCompile(summary);
    const running = summary.state === 'running';
    // A compile with nothing to do finishes in a tenth of a second; keep the
    // busy state up long enough to be seen, so a click visibly did something.
    window.clearTimeout(compileLabelTimer);
    const shownFor = Date.now() - compileClickedAt;
    if (running || shownFor < 700) {
      compileBtn.textContent = '… Compiling';
      compileBtn.classList.add('busy');
      if (!running) compileLabelTimer = window.setTimeout(() => setCompile(summary), 700 - shownFor);
      if (!running) return;
    } else {
      compileBtn.textContent = '▶ Recompile';
      compileBtn.classList.remove('busy');
    }
    const errors = summary.issues.filter((i) => i.level === 'error').length;
    if (running) statusCompile.replaceChildren(h('span', { class: 'dot warn' }), `compiling${summary.by ? ` (${summary.by})` : ''}…`);
    else if (summary.rev === 0) statusCompile.replaceChildren(h('span', { class: 'dot' }), 'not compiled');
    else statusCompile.replaceChildren(h('span', { class: `dot ${summary.ok ? 'ok' : errors ? 'bad' : 'warn'}` }),
      summary.ok
        ? (summary.upToDate ? `up to date — nothing changed since the last compile (${new Date(summary.finishedAt).toLocaleTimeString()})` : `compiled ${new Date(summary.finishedAt).toLocaleTimeString()}`)
        : `${errors} error${errors === 1 ? '' : 's'}`);
    if (!running && compileClickedAt && Date.now() - compileClickedAt < 5 * 60_000 && summary.by === me.name) {
      compileClickedAt = 0;
      if (summary.upToDate && summary.ok) toast('Already up to date — nothing changed since the last compile.', '', 2200);
      statusCompile.classList.remove('flash');
      void statusCompile.offsetWidth;
      statusCompile.classList.add('flash');
    }
  }

  async function runCompile(clean = false): Promise<void> {
    compileClickedAt = Date.now();
    compileBtn.textContent = '… Compiling';
    compileBtn.classList.add('busy');
    try {
      await api('POST', `/api/compile?project=${encodeURIComponent(project)}${clean ? '&clean=1' : ''}`);
    } catch (err) { toast((err as Error).message, 'bad'); }
  }

  async function saveSettings(patch: Partial<ProjectSettings>): Promise<void> {
    try {
      const r = await api<{ settings: ProjectSettings }>('POST', `/api/settings?project=${encodeURIComponent(project)}`, patch);
      settings = r.settings;
      tree.render();
    } catch (err) { toast((err as Error).message, 'bad'); }
  }

  async function syncToPdf(): Promise<void> {
    if (!current || !currentPath) return;
    const line = current.currentLine();
    const r = await api<{ page: number | null; y?: number }>('GET', `/api/synctex/view?project=${encodeURIComponent(project)}&file=${encodeURIComponent(currentPath)}&line=${line}`);
    if (r.page) viewer.revealInPdf(r.page, r.y ?? 0);
    else toast('No position in the PDF for this line (compile first).');
  }

  compileBtn.addEventListener('click', () => void runCompile());
  compileMore.addEventListener('click', () => {
    const mainSelect = h('select', {});
    for (const p of [...texts.keys()].filter((f) => f.endsWith('.tex')).sort()) {
      mainSelect.append(h('option', { value: p, selected: p === settings.mainFile }, p));
    }
    mainSelect.addEventListener('change', () => void saveSettings({ mainFile: mainSelect.value }));
    const engine = h('select', {});
    for (const e of ['pdflatex', 'xelatex', 'lualatex'] as const) engine.append(h('option', { value: e, selected: e === settings.engine }, e));
    engine.addEventListener('change', () => void saveSettings({ engine: engine.value as ProjectSettings['engine'] }));
    const auto = h('input', { type: 'checkbox', checked: settings.autoCompile });
    auto.addEventListener('change', () => void saveSettings({ autoCompile: (auto as HTMLInputElement).checked }));
    menu(compileMore, [
      h('div', { class: 'menu-head' }, 'Compile'),
      h('label', { class: 'item' }, auto, 'Auto-compile after edits'),
      h('div', { class: 'menu-field' }, h('span', { class: 'muted' }, 'main'), mainSelect),
      h('div', { class: 'menu-field' }, h('span', { class: 'muted' }, 'engine'), engine),
      h('div', { class: 'menu-sep' }),
      h('button', { onclick: () => viewer.showTab('log') }, 'Show compile log'),
      h('button', { title: 'Delete all build files (aux, bbl, …) and compile again', onclick: () => void runCompile(true) }, 'Recompile from scratch'),
    ]);
  });

  // ------------------------------------------------------------ history
  let historyTimer: number | undefined;
  function scheduleHistoryRefresh(): void {
    window.clearTimeout(historyTimer);
    historyTimer = window.setTimeout(() => void historyView?.refresh(), 400);
  }

  function openHistory(): void {
    if (historyView) { closeHistory(); return; }
    historyView = new HistoryView({ project: () => project, onClose: closeHistory, onLabel: openLabelDialog });
    editorPane.style.display = 'none';
    rightSplit.style.display = 'none';
    viewer.root.style.display = 'none';
    body.append(historyView.root);
    historyBtn.classList.add('on');
    void historyView.refresh().catch((err) => toast((err as Error).message, 'bad'));
  }

  function closeHistory(): void {
    historyView?.destroy();
    historyView?.root.remove();
    historyView = null;
    editorPane.style.display = '';
    rightSplit.style.display = '';
    viewer.root.style.display = '';
    historyBtn.classList.remove('on');
  }
  historyBtn.addEventListener('click', openHistory);

  function openLabelDialog(): void {
    dialog((close) => {
      const input = h('input', { placeholder: 'e.g. Submitted to NeurIPS', spellcheck: 'false' });
      const go = h('button', { class: 'primary' }, 'Label');
      const submit = async () => {
        const message = input.value.trim();
        if (!message) { input.focus(); return; }
        go.disabled = true;
        try {
          await api('POST', `/api/label?project=${encodeURIComponent(project)}`, { message });
          close();
          toast(`Labelled "${message}"`, 'ok');
          if (historyView) scheduleHistoryRefresh();
        } catch (err) { toast((err as Error).message, 'bad'); go.disabled = false; }
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void submit(); });
      go.addEventListener('click', () => void submit());
      return [
        h('h2', {}, 'Label this version'),
        h('p', { class: 'muted' }, 'Saves the whole project as a named version: a git commit authored by you. Labels show in the history, can be reverted to, and are what Git… pushes.'),
        input,
        h('div', { class: 'actions' }, h('button', { onclick: close }, 'Cancel'), go),
      ];
    });
  }
  labelBtn.addEventListener('click', openLabelDialog);

  // ------------------------------------------------------------ git
  gitBtn.addEventListener('click', () => {
    dialog((close) => {
      const info = h('div', { class: 'kv' }, h('span', {}, 'loading…'));
      const remote = h('input', { placeholder: 'git@github.com:you/paper.git', spellcheck: 'false' });
      const out = h('pre', { class: 'out', hidden: true });
      const keyBox = h('div', { class: 'deploy-key' });
      const run = async (label: string, work: () => Promise<{ output?: string }>) => {
        out.hidden = false;
        out.classList.remove('bad');
        out.textContent = `${label}…`;
        try {
          const r = await work();
          out.textContent = r.output || `${label}: done.`;
        } catch (err) {
          out.classList.add('bad');
          out.textContent = (err as Error).message;
        }
        await load();
      };
      const load = async () => {
        const r = await api<{ status: { branch: string; remote: string; ahead: number | null; behind: number | null; dirty: boolean; hasCommits: boolean }; deployKey: string | null; host: string }>('GET', `/api/git?project=${encodeURIComponent(project)}`);
        const { status } = r;
        // Filled on first load even though the field has focus; later only if untouched.
        if (!remote.dataset.loaded || document.activeElement !== remote) remote.value = status.remote;
        remote.dataset.loaded = '1';
        info.replaceChildren(
          h('span', {}, 'branch'), h('b', {}, status.branch),
          h('span', {}, 'since label'), h('b', {}, !status.hasCommits ? 'no labels yet — label a version to make the first commit' : status.dirty ? 'unlabelled changes' : 'nothing new'),
          h('span', {}, 'remote'), h('b', {}, status.ahead === null ? (status.remote ? 'not pushed yet' : 'none')
            : `${status.ahead} to push, ${status.behind} to pull`));
        renderKey(r.deployKey, status.remote || remote.value.trim(), r.host);
      };
      /** GitHub owner/repo from a remote URL, when it is one. */
      const githubRepo = (url: string) => /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
      const renderKey = (key: string | null, url: string, host: string) => {
        const ssh = /^(git@|ssh:\/\/)/.test(url);
        if (url && !ssh) {
          keyBox.replaceChildren(h('p', { class: 'muted' }, 'This remote uses HTTPS: fine for pulling public repositories. To push, use the SSH address (git@github.com:owner/repo.git) and a deploy key.'));
          return;
        }
        if (!key) {
          keyBox.replaceChildren(
            h('p', { class: 'muted' }, 'To push to (or pull from) a private repository, this project gets its own SSH key, which you add to that one repository as a deploy key. It can reach that repository and nothing else, and it does not depend on anyone\'s personal account.'),
            h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => void api('POST', `/api/git/deploy-key?project=${encodeURIComponent(project)}`).then(load, (err) => toast((err as Error).message, 'bad')) }, 'Create this project\'s deploy key')));
          return;
        }
        const m = githubRepo(url);
        const repo = m ? `${m[1]}/${m[2]}` : 'OWNER/REPO';
        const title = `TeXWerk: ${projectName} (${host})`;
        const agentText = [
          `Please give the TeXWerk server push access to the GitHub repository ${repo}, using the GitHub CLI (gh).`,
          '',
          ...(m ? [] : [
            'The TeXWerk project has no GitHub remote yet. First create a private repository for it (ask me for the',
            `owner and name if unsure; suggested name: ${projectName.replace(/[^\w.-]+/g, '-')}), e.g.:`,
            '    gh repo create OWNER/REPO --private',
            'and tell me its SSH address (git@github.com:OWNER/REPO.git) so I can paste it into TeXWerk as the remote.',
            '',
          ]),
          `Then add this SSH public key to ${repo} as a deploy key WITH WRITE ACCESS:`,
          '',
          "cat > /tmp/texwerk-deploy-key.pub <<'EOF'",
          key,
          'EOF',
          `gh repo deploy-key add /tmp/texwerk-deploy-key.pub --repo ${repo} --allow-write --title "${title}"`,
          '',
          `Check it with: gh repo deploy-key list --repo ${repo}`,
          'It is a public key; it is safe to share. Do not generate a different key: TeXWerk already holds the private half.',
        ].join('\n');
        keyBox.replaceChildren(
          h('p', {}, 'This project\'s deploy key. Add it to ', m ? h('b', {}, repo) : 'the repository', ' with write access — once:'),
          h('pre', { class: 'cmd' }, key),
          h('ul', {},
            h('li', {}, 'By hand: on GitHub open the repository → Settings → Deploy keys → Add deploy key, paste the key, tick ', h('b', {}, 'Allow write access'), '.'),
            h('li', {}, 'Or let your agent do it (it needs the GitHub CLI, gh, logged in as someone who administers the repository): copy the instructions below into it.')),
          h('div', { class: 'actions' },
            h('button', { onclick: () => void copyText(key).then(() => toast('Key copied', 'ok', 1200)) }, 'Copy key'),
            h('button', { onclick: () => void copyText(agentText).then(() => toast('Instructions copied — paste them into your agent', 'ok', 2500)) }, 'Copy instructions for your agent'),
            h('button', { title: 'Check that the server can reach the repository with this key', onclick: () => void run('Testing the connection', () => api('POST', `/api/git/test?project=${encodeURIComponent(project)}`)) }, 'Test connection')),
          h('details', {}, h('summary', {}, 'Show the instructions for your agent'), h('pre', { class: 'cmd agent-text' }, agentText)));
      };
      void load();
      return [
        h('h2', {}, 'Git'),
        h('p', { class: 'muted' }, 'This project is a git repository on the server. Each label is a commit; push sends labels to the remote, pull merges the remote in (unlabelled changes are committed first).'),
        info,
        h('h3', {}, 'Remote (origin)'),
        h('div', { class: 'row' }, remote,
          h('button', { onclick: () => void run('Saving remote', () => api('POST', `/api/git/remote?project=${encodeURIComponent(project)}`, { url: remote.value.trim() })) }, 'Save')),
        h('div', { class: 'row' },
          h('button', { onclick: openLabelDialog }, 'Label version…'),
          h('span', { class: 'spacer' }),
          h('button', { onclick: () => void run('Pulling', () => api('POST', `/api/git/pull?project=${encodeURIComponent(project)}`)) }, 'Pull'),
          h('button', { class: 'primary', onclick: () => void run('Pushing', () => api('POST', `/api/git/push?project=${encodeURIComponent(project)}`)) }, 'Push')),
        out,
        h('h3', {}, 'Deploy key'),
        keyBox,
        h('div', { class: 'actions' }, h('button', { onclick: close }, 'Close')),
      ];
    }, { wide: true });
  });

  // ------------------------------------------------------------ agent
  agentBtn.addEventListener('click', () => {
    const origin = location.origin;
    const session = `${origin}/?project=${encodeURIComponent(project)}${access ? '' : `&name=${encodeURIComponent(me.name)}`}`;
    const folder = project.replace(/[^\w.-]+/g, '-');
    const command = `curl -fsSL ${origin}/texwerk-connect.mjs -o texwerk-connect.mjs && node texwerk-connect.mjs '${session}' ${folder}`;
    dialog((close) => [
      h('h2', {}, 'Bring your own agent — or editor'),
      h('p', {}, 'Run this on your computer (needs Node 22+). It mirrors the project into ', h('code', {}, `./${folder}`), ' and keeps it in sync both ways, live, for as long as it runs.'),
      h('pre', { class: 'cmd' }, command),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => void copyText(command).then(() => toast('Command copied', 'ok', 1500)) }, 'Copy command')),
      h('h3', {}, 'Then'),
      h('ul', {},
        h('li', {}, 'Start Claude Code, Codex or any agent in that folder. Every save it makes reaches everyone here within a fraction of a second, merged character by character with what people are typing, and shows in History as ', h('b', {}, `${me.name} · agent`), '.'),
        h('li', {}, 'Or open the folder in your own editor (VS Code, Vim, Emacs…). Turn on auto-reload of changed files so collaborators\' edits appear in your buffer.'),
        h('li', {}, 'The agent can compile and read the result: ', h('code', {}, 'node .texwerk/tw compile'), ' prints errors; the PDF lands in ', h('code', {}, '.texwerk/output.pdf'), '. Instructions are in ', h('code', {}, '.texwerk/AGENT.md'), '.')),
      h('p', { class: 'muted' }, 'Nothing runs on the server on your behalf. Ctrl+C stops the mirror; the folder stays.'),
      h('div', { class: 'actions' }, h('button', { onclick: close }, 'Close')),
    ], { wide: true });
  });

  // ------------------------------------------------------------ download
  downloadBtn.addEventListener('click', () => {
    const go = (url: string) => { const a = h('a', { href: withName(url) }); document.body.append(a); a.click(); a.remove(); };
    menu(downloadBtn, [
      h('button', { onclick: () => go(`/api/zip?project=${encodeURIComponent(project)}`) }, 'Project as .zip'),
      h('button', { onclick: () => go(`/api/zip?project=${encodeURIComponent(project)}&comments=1`) }, 'Project as .zip + comments'),
      h('div', { class: 'menu-sep' }),
      h('button', { disabled: !compile?.hasPdf, onclick: () => go(`/pdf/${encodeURIComponent(project)}/output.pdf?download=1`) }, 'Compiled PDF'),
      h('button', { disabled: !compile?.hasPdf, title: 'The PDF with each open comment as a sticky note, for any PDF reader', onclick: () => void downloadAnnotated() }, 'Compiled PDF with comments'),
    ]);
  });

  async function downloadAnnotated(): Promise<void> {
    await refreshPins();
    const timer = window.setTimeout(() => setStatus('Adding comments to the PDF…'), 500);
    try {
      const r = await fetch(withName(`/pdf/${encodeURIComponent(project)}/output.pdf?comments=1`), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ positions: viewer.pinPositions() }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `${r.status}`);
      const url = URL.createObjectURL(await r.blob());
      const a = h('a', { href: url, download: `${projectName} (comments).pdf` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      toast(`Could not build the PDF: ${(err as Error).message}`, 'bad');
    } finally {
      window.clearTimeout(timer);
      setStatus(null);
    }
  }

  // ------------------------------------------------------------ window-level drop
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    dragDepth++;
    if (!document.querySelector('.drop-overlay')) document.body.append(h('div', { class: 'drop-overlay' }, 'Drop to upload into the project root — or onto a folder in the file tree'));
  });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.querySelector('.drop-overlay')?.remove(); });
  window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    dragDepth = 0;
    document.querySelector('.drop-overlay')?.remove();
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    void tree.dropFiles(e.dataTransfer, '');
  });

  // ------------------------------------------------------------ keys
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'Enter')) { e.preventDefault(); void runCompile(); }
  });

}

// ------------------------------------------------------------ layout

function restoreLayout(body: HTMLElement): void {
  try {
    const saved = JSON.parse(localStorage.getItem('texwerk-layout') ?? '{}') as { tree?: number; viewer?: number };
    if (saved.tree) body.style.setProperty('--tree-w', `${saved.tree}px`);
    if (saved.viewer) body.style.setProperty('--viewer-w', `${saved.viewer}px`);
  } catch { /* defaults */ }
}

function bindSplitter(handle: HTMLElement, body: HTMLElement, side: 'left' | 'right'): void {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    const rect = body.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      if (side === 'left') {
        const w = Math.max(140, Math.min(500, ev.clientX - rect.left));
        body.style.setProperty('--tree-w', `${w}px`);
      } else {
        const w = Math.max(240, Math.min(rect.width - 400, rect.right - ev.clientX));
        body.style.setProperty('--viewer-w', `${w}px`);
      }
    };
    const up = () => {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      try {
        localStorage.setItem('texwerk-layout', JSON.stringify({
          tree: parseInt(body.style.getPropertyValue('--tree-w')) || undefined,
          viewer: parseInt(body.style.getPropertyValue('--viewer-w')) || undefined,
        }));
      } catch { /* ignore */ }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}
