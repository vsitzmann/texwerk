import { api, confirmDialog, copyText, dialog, h, menu, prompt, toast } from './ui.ts';

/**
 * The projects browser, ported from DeckWerk's deck picker: a file manager
 * for the server's projects that takes the window — header with breadcrumbs,
 * column labels, a scrolling list of folders and projects, a footer of
 * actions. With access control on, projects are grouped by how you relate to
 * them and each row says who owns it and who can open it.
 */

export interface ProjectEntry {
  id: string;
  name: string;
  folder: string;
  files: number;
  editedAt: number;
  editors: number;
  people: string[];
  owner?: string;
  visibility?: 'public' | 'private';
  publicRole?: 'edit' | 'view';
  role: 'owner' | 'edit' | 'view';
  canManage: boolean;
  sharedWithMe?: boolean;
}

export interface FolderEntry {
  path: string;
  name: string;
  parent: string;
  projects: number;
  owner?: string;
  canManage: boolean;
}

export interface Me {
  you: { login: string; name: string };
  access: boolean;
  admin: boolean;
}

const folderOf = (id: string) => (id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '');

export function projectUrl(id: string): string {
  return `./?project=${encodeURIComponent(id)}`;
}

/** "just now", "5 min ago", "3 h ago", "yesterday", then the date. */
export function editedAgo(ts: number, now = Date.now()): string {
  const minutes = Math.floor((now - ts) / 60_000);
  if (!(minutes >= 1)) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  if (hours < 48) return 'yesterday';
  const date = new Date(ts);
  return date.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** One row: a name that opens the thing, then the columns that describe it. */
function pickerRow(tag: 'button' | 'div', name: string, cells: string[]): HTMLElement {
  const row = h(tag, { class: 'picker-row' }, h('span', { class: 'picker-name' }, name));
  for (const text of cells) row.append(h('span', { class: 'picker-cell' }, text));
  return row;
}

/** A row with the fixed-width slot its buttons live in, so columns align. */
function rowGroup(row: HTMLElement, buttons: HTMLElement[]): HTMLElement {
  return h('div', { class: 'picker-row-group' }, row, h('div', { class: 'picker-actions' }, ...buttons));
}

function rowButton(label: string, hint: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', { class: 'picker-row-button', title: hint }, label);
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function groupOf(p: ProjectEntry, me: Me): string {
  if (p.owner === me.you.login) return 'Your projects';
  if (p.sharedWithMe) return 'Shared with you';
  if (p.visibility === 'public') return 'Public';
  return 'Other private projects (admin)';
}
const GROUP_ORDER = ['Your projects', 'Shared with you', 'Public', 'Other private projects (admin)'];

/**
 * Show the browser. On the landing page it is the page; from inside a
 * project it opens over the editor and can be dismissed.
 */
export function showPicker(opts: { me: Me; dismissable: boolean; folder?: string; current?: string }): void {
  document.querySelector('.picker-overlay')?.remove();
  const overlay = h('div', { class: `picker-overlay${opts.dismissable ? '' : ' landing'}` });
  const box = h('div', { class: 'picker', tabindex: '-1' });
  let folder = opts.folder ?? (opts.current ? folderOf(opts.current) : '');
  const trail = h('div', { class: 'picker-trail' });
  const list = h('div', { class: 'picker-list' }, h('div', { class: 'picker-group' }, 'Loading…'));
  const progress = h('p', { class: 'picker-progress', role: 'status', hidden: true });
  const report = (text: string) => { progress.hidden = !text; progress.textContent = text; };
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && opts.dismissable && !document.querySelector('.backdrop')) close(); };
  const reopen = (next: string) => { folder = next; void render(); };
  const go = (id: string) => { if (id === opts.current) close(); else location.href = projectUrl(id); };
  const fail = (what: string) => (err: unknown) => toast(`${what} failed: ${(err as Error).message}`, 'bad');

  const folderRow = (entry: FolderEntry): HTMLElement => {
    const row = pickerRow('button', entry.name, [
      `${entry.projects} project${entry.projects === 1 ? '' : 's'}`, '', '', opts.me.access ? entry.owner ?? '' : '', '',
    ]);
    row.classList.add('picker-folder');
    row.addEventListener('click', () => reopen(entry.path));
    if (!entry.canManage) return rowGroup(row, []);
    const rename = rowButton('Rename…', 'Give this folder another name', async () => {
      const name = await prompt('Rename folder', 'Projects inside keep their contents; their links change.', entry.name, 'Rename');
      if (!name || name === entry.name) return;
      await api('POST', `/api/folders/rename?path=${encodeURIComponent(entry.path)}&name=${encodeURIComponent(name)}`)
        .then(() => reopen(folder), fail('Rename'));
    });
    const remove = rowButton('Delete…', 'Delete this folder (only when it is empty)', async () => {
      if (!await confirmDialog('Delete folder', `Delete the folder “${entry.name}”? Only an empty folder can be deleted.`, 'Delete', true)) return;
      await api('DELETE', `/api/folders?path=${encodeURIComponent(entry.path)}`).then(() => reopen(folder), fail('Delete'));
    });
    return rowGroup(row, [rename, remove]);
  };

  const projectRow = (p: ProjectEntry, folders: FolderEntry[]): HTMLElement => {
    const accessCell = p.role === 'view' ? 'view only'
      : p.visibility ? (p.visibility === 'public' ? (p.publicRole === 'view' ? 'public · view' : 'public') : 'private') : '';
    const row = pickerRow('button', p.name, [
      `${p.files} file${p.files === 1 ? '' : 's'}`,
      editedAgo(p.editedAt),
      p.editors > 0 ? `${p.editors} editing` : '',
      opts.me.access && p.owner && p.owner !== opts.me.you.login ? p.owner : '',
      accessCell,
    ]);
    row.children[2]?.setAttribute('title', new Date(p.editedAt).toLocaleString());
    if (p.editors > 0) { row.children[3]?.classList.add('picker-live'); row.children[3]?.setAttribute('title', p.people.join(', ')); }
    if (p.id === opts.current) row.classList.add('active');
    row.addEventListener('click', () => go(p.id));
    if (!p.canManage) return rowGroup(row, []);
    const rename = rowButton('Rename…', 'Give this project another name', async () => {
      const name = await prompt('Rename project', 'The project folder on the server is renamed too.', p.name, 'Rename');
      if (!name || name === p.name) return;
      await api<{ id: string }>('POST', `/api/projects/rename?project=${encodeURIComponent(p.id)}&name=${encodeURIComponent(name)}`)
        .then((r) => (p.id === opts.current ? go(r.id) : reopen(folder)), fail('Rename'));
    });
    const move = rowButton('Move…', 'Put this project in a folder', () => showMoveDialog(p, folders, (r) => (p.id === opts.current ? go(r) : reopen(folderOf(r)))));
    const share = rowButton('Share…', 'Change who can open this project', () => showShareDialog(p.id, opts.me, () => reopen(folder)));
    return rowGroup(row, opts.me.access ? [rename, move, share] : [rename, move]);
  };

  const renderTrail = (folders: FolderEntry[]) => {
    trail.replaceChildren();
    const segments = folder ? folder.split('/') : [];
    const crumb = (label: string, path: string, last: boolean) => {
      trail.append(h('button', { class: 'picker-crumb', disabled: last, onclick: () => reopen(path) }, label));
      if (!last) trail.append(h('span', { class: 'picker-crumb-sep' }, '›'));
    };
    crumb('All projects', '', segments.length === 0);
    segments.forEach((s, i) => crumb(s, segments.slice(0, i + 1).join('/'), i === segments.length - 1));
    if (folder && !folders.some((f) => f.path === folder)) trail.append(h('span', { class: 'picker-crumb-sep' }, '· no longer available'));
  };

  const render = async () => {
    let data: { projects: ProjectEntry[]; folders: FolderEntry[] };
    try { data = await api('GET', '/api/projects'); } catch { list.replaceChildren(h('div', { class: 'picker-group' }, 'Could not reach the server.')); return; }
    renderTrail(data.folders);
    list.replaceChildren();
    const here = data.projects.filter((p) => p.folder === folder);
    const children = data.folders.filter((f) => f.parent === folder);
    for (const f of children) list.append(folderRow(f));
    if (!here.length && !children.length) {
      list.append(h('div', { class: 'picker-group' }, folder ? 'This folder is empty.' : 'No projects yet — create one, import a .zip, or clone a git repository.'));
      return;
    }
    if (!opts.me.access) { for (const p of here) list.append(projectRow(p, data.folders)); return; }
    const groups = new Map<string, ProjectEntry[]>();
    for (const p of here) groups.set(groupOf(p, opts.me), [...(groups.get(groupOf(p, opts.me)) ?? []), p]);
    for (const g of GROUP_ORDER) {
      const entries = groups.get(g);
      if (!entries?.length) continue;
      list.append(h('div', { class: 'picker-group' }, g));
      for (const p of entries) list.append(projectRow(p, data.folders));
    }
  };

  // ------------------------------------------------------------ footer
  const newProject = async () => {
    const name = await prompt('New project', 'A folder with a main.tex to start from. It becomes a git repository.', '', 'Create');
    if (!name) return;
    await api<{ id: string }>('POST', '/api/projects', { name, folder }).then((r) => go(r.id), fail('Create'));
  };
  const newFolder = async () => {
    const name = await prompt('New folder', folder ? `Inside ${folder}.` : 'At the top level.', '', 'Create');
    if (!name) return;
    await api<{ path: string }>('POST', `/api/folders?path=${encodeURIComponent(folder ? `${folder}/${name}` : name)}`).then((r) => reopen(r.path), fail('Create'));
  };
  const importZip = () => {
    const input = h('input', { type: 'file', accept: '.zip,application/zip' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const name = await prompt('Import project', `Name for the project made from ${file.name}.`, file.name.replace(/\.zip$/i, ''), 'Import');
      if (!name) return;
      const timer = setTimeout(() => report(`Uploading ${file.name} (${(file.size / 1e6).toFixed(1)} MB)…`), 500);
      try {
        const r = await api<{ id: string }>('POST', `/api/projects/import?name=${encodeURIComponent(name)}&folder=${encodeURIComponent(folder)}`, file);
        go(r.id);
      } catch (err) { fail('Import')(err); } finally { clearTimeout(timer); report(''); }
    });
    input.click();
  };
  const cloneRepo = () => {
    dialog((closeDialog) => {
      const url = h('input', { placeholder: 'https://github.com/you/paper.git  or  git@github.com:you/paper.git', spellcheck: 'false' });
      const name = h('input', { placeholder: 'Project name', spellcheck: 'false' });
      const out = h('pre', { class: 'out bad', hidden: true });
      const goBtn = h('button', { class: 'primary' }, 'Clone');
      url.addEventListener('input', () => { if (!name.dataset.touched) name.value = url.value.split(/[/:]/).pop()!.replace(/\.git$/, ''); });
      name.addEventListener('input', () => { name.dataset.touched = '1'; });
      goBtn.addEventListener('click', async () => {
        goBtn.disabled = true;
        goBtn.textContent = 'Cloning…';
        try {
          const r = await api<{ id: string }>('POST', '/api/projects/clone', { url: url.value.trim(), name: name.value.trim(), folder });
          closeDialog();
          go(r.id);
        } catch (err) {
          out.hidden = false;
          out.textContent = (err as Error).message;
        } finally { goBtn.disabled = false; goBtn.textContent = 'Clone'; }
      });
      return [
        h('h2', {}, 'Clone a git repository'),
        h('p', { class: 'muted' }, 'For a private repository: create a new project instead, then in Git… set the remote, create the project\'s deploy key, add it to the repository, and Pull.'),
        url, name, out,
        h('div', { class: 'actions' }, h('button', { onclick: closeDialog }, 'Cancel'), goBtn),
      ];
    });
  };
  const importBtn = h('button', {}, 'Import… ▾');
  importBtn.addEventListener('click', () => menu(importBtn, [
    h('button', { onclick: importZip }, 'Project from .zip…'),
    h('button', { onclick: cloneRepo }, 'Clone a git repository…'),
  ]));
  const actions = h('div', { class: 'picker-footer-actions' },
    opts.dismissable ? h('button', { onclick: close }, 'Cancel') : '',
    h('button', { onclick: newProject }, 'New project…'),
    h('button', { onclick: newFolder }, 'New folder…'),
    importBtn);

  const who = opts.me.access ? h('span', { class: 'picker-who', title: opts.me.you.login }, `${opts.me.you.name}${opts.me.admin ? ' · admin' : ''}`) : '';
  box.append(
    h('div', { class: 'picker-head' }, h('h2', {}, 'Projects on this server'), trail, who),
    h('div', { class: 'picker-columns' }, rowGroup(pickerRow('div', 'Name', ['Size', 'Last edit', 'Editing', 'Owner', 'Access']), [])),
    list,
    h('div', { class: 'picker-foot' }, progress, actions));
  overlay.append(box);
  if (opts.dismissable) overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  box.focus();
  void render();
  const timer = setInterval(() => { if (!document.body.contains(overlay)) clearInterval(timer); else if (document.visibilityState === 'visible' && !document.querySelector('.backdrop, .menu')) void render(); }, 10_000);
}

/** Move one project into another folder (owner or admin only). */
function showMoveDialog(p: ProjectEntry, folders: FolderEntry[], onMoved: (id: string) => void): void {
  dialog((close) => {
    const select = h('select', {});
    for (const option of [{ path: '', label: 'All projects (top level)' }, ...folders.map((f) => ({ path: f.path, label: f.path }))]) {
      select.append(h('option', { value: option.path, selected: option.path === p.folder }, option.label));
    }
    const save = h('button', { class: 'primary' }, 'Move');
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const r = await api<{ id: string }>('POST', `/api/projects/move?project=${encodeURIComponent(p.id)}&folder=${encodeURIComponent(select.value)}`);
        close();
        onMoved(r.id);
      } catch (err) { save.disabled = false; toast(`Move failed: ${(err as Error).message}`, 'bad'); }
    });
    return [
      h('h2', {}, `Move “${p.name}”`),
      h('label', { class: 'share-field' }, 'Folder', select),
      h('div', { class: 'actions' }, h('button', { onclick: close }, 'Cancel'), save),
    ];
  });
}

interface AccessInfo {
  enabled: boolean;
  owner: string;
  visibility: 'public' | 'private';
  publicRole: 'edit' | 'view';
  sharedWith: Array<{ login: string; role: 'edit' | 'view' }>;
  canManage: boolean;
  role: 'owner' | 'edit' | 'view';
}

const ROLE_LABEL = { edit: 'Can edit', view: 'Can view' } as const;

/** Visibility + share list for one project — DeckWerk's Share dialog. */
export function showShareDialog(id: string, me: Me, onSaved?: () => void): void {
  const body = h('div', { class: 'share-body' }, 'Loading…');
  const actions = h('div', { class: 'actions' });
  dialog((close) => {
    actions.append(h('button', { onclick: close }, 'Close'));
    void (async () => {
      const info = await api<AccessInfo>('GET', `/api/access?project=${encodeURIComponent(id)}`);
      body.replaceChildren();
      const link = `${location.origin}/${projectUrl(id).slice(2)}`;
      const copy = h('button', { class: 'share-copy', onclick: () => void copyText(link).then(() => toast('Link copied', 'ok', 1500), () => toast(link)) }, 'Copy link');
      if (!info.enabled) {
        body.append(h('p', { class: 'muted' }, 'Access control is off on this server: everyone who can reach it can open and edit every project.'));
        actions.prepend(copy);
        return;
      }
      if (!info.canManage) {
        body.append(
          h('p', { class: 'share-owner' }, `Owner: ${info.owner}`),
          h('p', {}, `${info.visibility === 'public' ? 'This project is public: everyone on this server can open it.' : 'This project is private; the owner shared it with you.'} ${info.role === 'view' ? 'You can view it, but not change it.' : 'You can edit it.'}`));
        actions.prepend(copy);
        return;
      }
      const known = await api<Array<{ login: string; name: string }>>('GET', '/api/users').catch(() => []);
      const nameOf = (login: string) => known.find((u) => u.login === login)?.name;
      const shares = info.sharedWith.map((s) => ({ ...s }));
      const entry = h('input', { placeholder: known.length ? 'Add people by name or login…' : 'tailnet login, e.g. alice@example.com', list: 'share-known-users', spellcheck: 'false' });
      const newRole = h('select', {}, h('option', { value: 'edit' }, ROLE_LABEL.edit), h('option', { value: 'view' }, ROLE_LABEL.view));
      const datalist = h('datalist', { id: 'share-known-users' });
      const people = h('div', { class: 'share-people' });
      const personRow = (login: string, control: Node) => {
        const name = nameOf(login);
        return h('div', { class: 'share-person' },
          h('span', { class: 'share-person-who' }, h('span', { class: 'share-person-name' }, name ?? login), name ? h('span', { class: 'share-person-login' }, login) : ''),
          control);
      };
      const renderPeople = () => {
        people.replaceChildren(personRow(info.owner, h('span', { class: 'share-role-fixed' }, 'Owner')));
        for (const share of shares) {
          const role = h('select', { title: `What ${share.login} can do` },
            h('option', { value: 'edit', selected: share.role === 'edit' }, ROLE_LABEL.edit),
            h('option', { value: 'view', selected: share.role === 'view' }, ROLE_LABEL.view));
          role.addEventListener('change', () => { share.role = role.value === 'view' ? 'view' : 'edit'; });
          const remove = h('button', { class: 'ghost icon', title: `Stop sharing with ${share.login}` }, '✕');
          remove.addEventListener('click', () => { shares.splice(shares.indexOf(share), 1); renderPeople(); });
          people.append(personRow(share.login, h('span', { class: 'share-person-controls' }, role, remove)));
        }
        datalist.replaceChildren(...known.filter((u) => u.login !== info.owner && !shares.some((s) => s.login === u.login))
          .map((u) => h('option', { value: u.login, label: u.name })));
      };
      const addEntry = () => {
        const typed = entry.value.trim().toLowerCase();
        if (!typed) return;
        const login = known.find((u) => u.login === typed || u.name.toLowerCase() === typed)?.login ?? typed;
        if (login !== info.owner && !shares.some((s) => s.login === login)) shares.push({ login, role: newRole.value === 'view' ? 'view' : 'edit' });
        entry.value = '';
        renderPeople();
      };
      entry.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addEntry(); } });
      entry.addEventListener('change', () => { if (known.some((u) => u.login === entry.value.trim().toLowerCase())) addEntry(); });

      const visibility = h('select', { title: 'Who can open this project without being listed above' },
        h('option', { value: 'private', selected: info.visibility === 'private' }, 'Restricted'),
        h('option', { value: 'public', selected: info.visibility === 'public' }, 'Everyone on this server'));
      const publicRole = h('select', { title: 'What everyone else can do' },
        h('option', { value: 'view', selected: info.publicRole === 'view' }, ROLE_LABEL.view),
        h('option', { value: 'edit', selected: info.publicRole === 'edit' }, ROLE_LABEL.edit));
      const note = h('p', { class: 'share-note' });
      const syncGeneral = () => {
        const isPublic = visibility.value === 'public';
        publicRole.hidden = !isPublic;
        note.textContent = isPublic
          ? (publicRole.value === 'view' ? 'Anyone on this server can open it. Only the people listed above can change it.' : 'Anyone on this server can open and change it.')
          : 'Only the people listed above can open it.';
      };
      visibility.addEventListener('change', syncGeneral);
      publicRole.addEventListener('change', syncGeneral);
      renderPeople();
      syncGeneral();

      const save = h('button', { class: 'primary' }, 'Save');
      save.addEventListener('click', async () => {
        save.disabled = true;
        try {
          await api('PUT', `/api/access?project=${encodeURIComponent(id)}`, { visibility: visibility.value, publicRole: publicRole.value, sharedWith: shares });
          toast(visibility.value === 'public' ? `Public · everyone ${publicRole.value === 'view' ? 'can view' : 'can edit'}` : `Private · shared with ${shares.length}`, 'ok');
          close();
          onSaved?.();
        } catch (err) { save.disabled = false; toast(`Sharing failed: ${(err as Error).message}`, 'bad'); }
      });
      body.append(
        h('section', { class: 'share-section' }, h('h3', {}, 'People with access'),
          h('div', { class: 'share-add' }, entry, newRole, h('button', { onclick: addEntry }, 'Add'), datalist), people),
        h('section', { class: 'share-section' }, h('h3', {}, 'General access'), h('div', { class: 'share-general' }, visibility, publicRole), note));
      actions.prepend(copy);
      actions.append(save);
    })().catch((err) => { body.textContent = `Could not load sharing: ${(err as Error).message}`; });
    return [h('h2', {}, `Share “${id.split('/').pop()}”`), body, actions];
  });
}
