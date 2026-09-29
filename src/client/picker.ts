import { api, dialog, h, prompt, storedName, timeAgo, toast } from './ui.ts';

interface ProjectRow {
  name: string;
  modified: number;
  open: boolean;
  people: string[];
}

/** The landing page: every project on the server, and ways to start one. */
export async function renderPicker(app: HTMLElement, access: boolean): Promise<void> {
  document.title = 'TeXWerk';
  const list = h('div', { class: 'picker-list' });
  const status = h('span', { class: 'muted' });

  const refresh = async () => {
    const { projects } = await api<{ projects: ProjectRow[] }>('GET', '/api/projects');
    list.replaceChildren();
    if (!projects.length) list.append(h('div', { class: 'picker-empty' }, 'No projects yet. Create one, import a .zip, or clone a git repository.'));
    for (const p of projects) {
      const rename = h('button', { class: 'ghost icon', title: 'Rename project' }, 'Rename');
      rename.addEventListener('click', async (e) => {
        e.preventDefault();
        const to = await prompt('Rename project', 'The project folder on the server is renamed too.', p.name, 'Rename');
        if (!to || to === p.name) return;
        try { await api('POST', '/api/projects/rename', { from: p.name, to }); await refresh(); } catch (err) { toast((err as Error).message, 'bad'); }
      });
      const row = h('a', { class: 'picker-row', href: `?project=${encodeURIComponent(p.name)}` },
        h('span', { class: 'pname' }, p.name),
        h('span', { class: 'people' }, p.people.length ? `● ${p.people.join(', ')}` : ''),
        h('span', { class: 'when' }, timeAgo(p.modified)),
        h('span', { class: 'row-actions' }, rename));
      list.append(row);
    }
  };

  const open = (name: string) => { location.href = `?project=${encodeURIComponent(name)}`; };

  const create = async () => {
    const name = await prompt('New project', 'A folder with a main.tex to start from. It becomes a git repository.', '', 'Create');
    if (!name) return;
    try { const r = await api<{ name: string }>('POST', '/api/projects', { name }); open(r.name); } catch (err) { toast((err as Error).message, 'bad'); }
  };

  const importZip = () => {
    const input = h('input', { type: 'file', accept: '.zip,application/zip' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const name = await prompt('Import project', `Name for the project made from ${file.name}.`, file.name.replace(/\.zip$/i, ''), 'Import');
      if (!name) return;
      const timer = setTimeout(() => { status.textContent = `Uploading ${file.name}…`; }, 500);
      try {
        const r = await api<{ name: string }>('POST', `/api/projects/import?name=${encodeURIComponent(name)}`, file);
        open(r.name);
      } catch (err) {
        toast((err as Error).message, 'bad');
      } finally {
        clearTimeout(timer);
        status.textContent = '';
      }
    });
    input.click();
  };

  const cloneRepo = () => {
    dialog((close) => {
      const url = h('input', { placeholder: 'https://github.com/you/paper.git  or  git@github.com:you/paper.git', spellcheck: 'false' });
      const name = h('input', { placeholder: 'Project name', spellcheck: 'false' });
      const out = h('pre', { class: 'out bad', hidden: true });
      const go = h('button', { class: 'primary' }, 'Clone');
      url.addEventListener('input', () => {
        if (!name.dataset.touched) name.value = url.value.split(/[/:]/).pop()!.replace(/\.git$/, '');
      });
      name.addEventListener('input', () => { name.dataset.touched = '1'; });
      go.addEventListener('click', async () => {
        go.disabled = true;
        go.textContent = 'Cloning…';
        try {
          const r = await api<{ name: string }>('POST', '/api/projects/clone', { url: url.value.trim(), name: name.value.trim() });
          close();
          open(r.name);
        } catch (err) {
          out.hidden = false;
          out.textContent = (err as Error).message;
        } finally {
          go.disabled = false;
          go.textContent = 'Clone';
        }
      });
      return [
        h('h2', {}, 'Clone a git repository'),
        h('p', { class: 'muted' }, 'Private repositories need the server\'s SSH key as a deploy key (Git… inside any project shows it).'),
        url, name, out,
        h('div', { class: 'actions' }, h('button', { onclick: close }, 'Cancel'), go),
      ];
    });
  };

  app.replaceChildren(h('div', { class: 'picker' },
    h('div', { class: 'picker-head' },
      h('h1', {}, 'TEXWERK'),
      h('span', { class: 'tag' }, 'collaborative LaTeX'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted' }, access ? '' : storedName())),
    h('div', { class: 'picker-actions' },
      h('button', { class: 'primary', onclick: create }, '+ New project'),
      h('button', { onclick: importZip }, 'Import .zip'),
      h('button', { onclick: cloneRepo }, 'Clone git repo'),
      h('span', { class: 'spacer' }),
      status),
    list,
    h('div', { class: 'picker-foot' },
      'Every project is a folder on this server and a git repository. ',
      'Anyone who can reach this address can open and edit every project.')));
  await refresh();
  const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh().catch(() => {}); }, 10_000);
  window.addEventListener('pagehide', () => clearInterval(timer));
}
