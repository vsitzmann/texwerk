import { readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

/**
 * A recursive directory watcher built from one plain watch per directory.
 *
 * Node's own `fs.watch(dir, { recursive: true })` on Linux stops reporting a
 * file once it has been replaced by rename — which is exactly how atomic
 * saves work (ours, and those of many editors and agents). Per-directory
 * watches do not have that problem, so this watches every directory in the
 * tree individually and picks up directories as they appear.
 *
 * `onChange` receives forward-slash paths relative to `root`.
 */
export function watchTree(root: string, onChange: (rel: string) => void, skip: (rel: string) => boolean): () => void {
  const watchers = new Map<string, FSWatcher>();

  const add = (rel: string) => {
    if (watchers.has(rel) || (rel && skip(rel))) return;
    const abs = rel ? join(root, rel) : root;
    let watcher: FSWatcher;
    try {
      watcher = watch(abs, (_event, name) => {
        if (!name) return;
        const child = rel ? `${rel}/${name.toString()}` : name.toString();
        if (skip(child)) return;
        onChange(child);
        try {
          if (statSync(join(root, child)).isDirectory()) scan(child);
        } catch {
          // Gone: drop its watcher (and those below it).
          for (const key of [...watchers.keys()]) {
            if (key === child || key.startsWith(`${child}/`)) { watchers.get(key)!.close(); watchers.delete(key); }
          }
        }
      });
    } catch {
      return;
    }
    watcher.on('error', () => { watcher.close(); watchers.delete(rel); });
    watchers.set(rel, watcher);
  };

  const scan = (rel: string) => {
    add(rel);
    let entries;
    try { entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (!skip(child)) scan(child);
    }
  };

  scan('');
  return () => { for (const w of watchers.values()) w.close(); watchers.clear(); };
}
