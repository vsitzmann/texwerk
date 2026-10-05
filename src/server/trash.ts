import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Nothing in TeXWerk is ever really deleted. "Delete" moves the item into a
 * trash folder that no listing shows, and there is no way to empty it.
 *
 *  - Files and folders of a project go to `<project>/.texwerk/trash/` — inside
 *    the project, so the project's own access rules (`.texwerk/access.json`)
 *    keep deciding who may see them, and `.texwerk/` is never committed,
 *    mirrored or watched.
 *  - Whole projects (and empty project folders) go to `<root>/.trash/`. A
 *    project keeps its `.texwerk/access.json`, so who may see it in the trash
 *    is still decided by its own sharing settings.
 *
 * Every trashed item gets its own entry folder `<timestamp>-<random>/` holding
 * `meta.json` and the item itself under `item/<original name>`, so two
 * deletions of the same name never collide.
 */

export interface TrashMeta {
  id: string;
  kind: 'file' | 'dir' | 'project' | 'folder';
  /** Project-relative path (file/dir) or project/folder id (project/folder). */
  path: string;
  deletedAt: string;
  deletedBy: string;
}

export const PROJECT_TRASH = ['.texwerk', 'trash'];
export const ROOT_TRASH = '.trash';

const ENTRY_ID = /^\d{8}T\d{9}Z-[0-9a-f]{8}$/;

/** Only ids this module created; anything else (../, /, …) is refused. */
export function validTrashId(id: unknown): id is string {
  return typeof id === 'string' && ENTRY_ID.test(id);
}

function newId(): string {
  return `${new Date().toISOString().replace(/[-:.]/g, '')}-${randomBytes(4).toString('hex')}`;
}

/** Move `source` into a new entry under `trashDir`. */
export async function moveToTrash(trashDir: string, source: string, meta: Omit<TrashMeta, 'id'>): Promise<TrashMeta> {
  const id = newId();
  const entry = join(trashDir, id);
  await mkdir(join(entry, 'item'), { recursive: true });
  const full: TrashMeta = { id, ...meta };
  await writeFile(join(entry, 'meta.json'), `${JSON.stringify(full, null, 2)}\n`, 'utf8');
  await rename(source, itemPath(trashDir, full));
  return full;
}

export function itemPath(trashDir: string, meta: TrashMeta): string {
  return join(trashDir, meta.id, 'item', meta.path.split('/').pop()!);
}

export async function readEntry(trashDir: string, id: string): Promise<TrashMeta | null> {
  if (!validTrashId(id)) return null;
  try {
    const meta = JSON.parse(await readFile(join(trashDir, id, 'meta.json'), 'utf8')) as TrashMeta;
    if (meta.id !== id || typeof meta.path !== 'string') return null;
    if (!existsSync(itemPath(trashDir, meta))) return null; // restored already
    return meta;
  } catch { return null; }
}

/** Every entry still in the trash, newest first. */
export async function listTrash(trashDir: string): Promise<TrashMeta[]> {
  let names: string[];
  try { names = await readdir(trashDir); } catch { return []; }
  const out: TrashMeta[] = [];
  for (const n of names) {
    const meta = await readEntry(trashDir, n);
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/** Move an entry's item back to `target`; the entry folder keeps its meta.json as a record. */
export async function restoreFromTrash(trashDir: string, meta: TrashMeta, target: string): Promise<void> {
  if (existsSync(target)) throw new Error('something with that name exists there now');
  await rename(itemPath(trashDir, meta), target);
  await writeFile(join(trashDir, meta.id, 'restored.json'), `${JSON.stringify({ restoredAt: new Date().toISOString(), to: target }, null, 2)}\n`, 'utf8');
}
