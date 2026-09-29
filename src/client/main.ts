import { api, h, storedName, storeName } from './ui.ts';
import { showPicker, type Me } from './picker.ts';
import { renderEditor } from './editor.ts';

/**
 * One page, two views: without ?project= the project picker, with it the
 * editor. Without tailnet identity (--access), the first visit asks for a
 * name to show on carets and in history.
 */
async function boot(): Promise<void> {
  const app = document.getElementById('app')!;
  const me = await api<Me>('GET', '/api/me');
  if (!me.access && !storedName()) {
    await askName(app);
  }
  const project = new URLSearchParams(location.search).get('project');
  if (project) await renderEditor(app, project, me);
  else {
    document.title = 'TeXWerk';
    showPicker({ me, dismissable: false });
  }
}

function askName(app: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const input = h('input', { placeholder: 'Your name', autofocus: true, spellcheck: 'false' });
    const go = () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      storeName(name);
      app.replaceChildren();
      resolve();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    app.replaceChildren(h('div', { class: 'name-page' },
      h('div', { class: 'dialog', style: 'margin:80px auto' },
        h('h2', {}, 'Who are you?'),
        h('p', { class: 'muted' }, 'Collaborators see this name next to your cursor and in the history.'),
        input,
        h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: go }, 'Continue')))));
    input.focus();
  });
}

boot().catch((err) => {
  document.getElementById('app')!.replaceChildren(h('div', { class: 'picker' }, h('p', { class: 'muted' }, `Could not start: ${(err as Error).message}`)));
});
