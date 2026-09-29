import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Identity } from '../shared/protocol.ts';

/**
 * Per-project access control, ported from DeckWerk's collab server
 * (`--access <adminLogin>`). Identity comes from Tailscale (identity.ts); this
 * module decides what that identity may do.
 *
 * A project's permissions live in `.texwerk/access.json` inside the project —
 * never in the project's own files, so they are not committed to git, not
 * mirrored to anyone's machine, and not editable through the document. A
 * project without the sidecar is public and admin-owned (and editable by
 * everyone), so turning access control on over existing projects changes
 * nothing until somebody restricts one.
 *
 * Every grant carries a role — `edit` or `view`. Roles only add up: a
 * person's role is the most permissive of their explicit share and what the
 * project's public setting gives everyone.
 *
 * Folders are directories that hold projects (and other folders); they carry
 * a `.texwerk-folder.json` naming their creator. Folder visibility is derived:
 * see `folderVisibleTo`.
 */

export interface AccessConfig {
  /** Tailnet login of the administrator; sees and manages everything. */
  admin: string;
}

export type AccessRole = 'edit' | 'view';
export type ProjectRole = 'owner' | AccessRole;

export interface Share {
  login: string;
  role: AccessRole;
}

export interface ProjectAccess {
  owner: string;
  visibility: 'public' | 'private';
  sharedWith: Share[];
  /** What `visibility: "public"` grants everyone else. */
  publicRole: AccessRole;
}

export const FOLDER_MARKER = '.texwerk-folder.json';

export function normalizeLogin(value: string): string {
  return value.trim().toLowerCase();
}

function asRole(value: unknown, fallback: AccessRole): AccessRole {
  return value === 'view' || value === 'edit' ? value : fallback;
}

/** One entry per login; a duplicate keeps the more permissive role. */
export function normalizeShares(value: unknown): Share[] {
  if (!Array.isArray(value)) return [];
  const byLogin = new Map<string, Share>();
  for (const entry of value) {
    const raw = typeof entry === 'string' ? { login: entry, role: 'edit' } : entry;
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as { login?: unknown; role?: unknown };
    if (typeof candidate.login !== 'string' || !candidate.login.trim()) continue;
    const login = normalizeLogin(candidate.login);
    const role = asRole(candidate.role, 'edit');
    if (byLogin.get(login)?.role === 'edit') continue;
    byLogin.set(login, { login, role });
  }
  return [...byLogin.values()];
}

function sidecar(projectDir: string): string {
  return join(projectDir, '.texwerk', 'access.json');
}

/** A missing or unreadable sidecar is public, admin-owned, editable. */
export async function readAccess(projectDir: string, config: AccessConfig): Promise<ProjectAccess> {
  const fallback: ProjectAccess = { owner: normalizeLogin(config.admin), visibility: 'public', sharedWith: [], publicRole: 'edit' };
  let raw: string;
  try { raw = await readFile(sidecar(projectDir), 'utf8'); } catch { return fallback; }
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectAccess>;
    return {
      owner: typeof parsed.owner === 'string' && parsed.owner.trim() ? normalizeLogin(parsed.owner) : fallback.owner,
      visibility: parsed.visibility === 'private' ? 'private' : 'public',
      sharedWith: normalizeShares(parsed.sharedWith),
      publicRole: asRole(parsed.publicRole, 'edit'),
    };
  } catch {
    // A corrupt sidecar must not lock the admin out; treat it as absent.
    return fallback;
  }
}

export async function writeAccess(projectDir: string, access: ProjectAccess): Promise<void> {
  await mkdir(join(projectDir, '.texwerk'), { recursive: true });
  const partial = `${sidecar(projectDir)}.${process.pid}.tmp`;
  await writeFile(partial, `${JSON.stringify(access, null, 2)}\n`, 'utf8');
  await rename(partial, sidecar(projectDir));
}

/** This person's role, or null if they may not open the project at all. */
export function roleFor(login: string, access: ProjectAccess, config: AccessConfig): ProjectRole | null {
  if (login === normalizeLogin(config.admin) || access.owner === login) return 'owner';
  const granted: AccessRole[] = [];
  const share = access.sharedWith.find((entry) => entry.login === login);
  if (share) granted.push(share.role);
  if (access.visibility === 'public') granted.push(access.publicRole);
  if (granted.length === 0) return null;
  return granted.includes('edit') ? 'edit' : 'view';
}

export function canManage(login: string, access: ProjectAccess, config: AccessConfig): boolean {
  return login === normalizeLogin(config.admin) || access.owner === login;
}

export async function readFolderOwner(dir: string, config: AccessConfig): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, FOLDER_MARKER), 'utf8')) as { owner?: unknown };
    if (typeof parsed.owner === 'string' && parsed.owner.trim()) return normalizeLogin(parsed.owner);
  } catch { /* missing or corrupt: the admin's */ }
  return normalizeLogin(config.admin);
}

export async function writeFolderMarker(dir: string, owner: string): Promise<void> {
  await writeFile(join(dir, FOLDER_MARKER), `${JSON.stringify({ owner: normalizeLogin(owner) }, null, 2)}\n`, 'utf8');
}

/**
 * A folder is visible exactly when it holds at least one project this person
 * may open, at any depth — plus always to the admin and to its creator (who
 * has to be able to put the first project in).
 */
export function folderVisibleTo(login: string, folder: { owner: string; accessibleProjects: number }, config: AccessConfig): boolean {
  if (login === normalizeLogin(config.admin)) return true;
  if (folder.owner === login) return true;
  return folder.accessibleProjects > 0;
}

export interface KnownUser {
  login: string;
  name: string;
  lastSeen: string;
}

/**
 * Everyone whose tailnet identity the server has seen, persisted as
 * `.texwerk-users.json` in the projects root. It exists so the share dialog
 * can autocomplete logins and show names; it grants nothing.
 */
export class UserDirectory {
  private users = new Map<string, KnownUser>();
  private loaded: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
        if (Array.isArray(raw)) {
          for (const entry of raw as Array<Partial<KnownUser>>) {
            if (typeof entry.login !== 'string' || !entry.login) continue;
            const login = normalizeLogin(entry.login);
            this.users.set(login, { login, name: entry.name || login, lastSeen: entry.lastSeen ?? new Date(0).toISOString() });
          }
        }
      } catch { /* start empty */ }
    })();
    return this.loaded;
  }

  async note(identity: Identity): Promise<void> {
    await this.load();
    const existing = this.users.get(identity.login);
    const now = new Date();
    const name = identity.name === identity.login && existing ? existing.name : identity.name;
    const stale = !existing || existing.name !== name || now.getTime() - Date.parse(existing.lastSeen) > 3600_000;
    if (!stale) return;
    this.users.set(identity.login, { login: identity.login, name, lastSeen: now.toISOString() });
    const snapshot = this.list();
    this.writing = this.writing.then(async () => {
      const partial = `${this.file}.${process.pid}.tmp`;
      await writeFile(partial, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      await rename(partial, this.file);
    }).catch(() => {});
    await this.writing;
  }

  list(): KnownUser[] {
    return [...this.users.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async all(): Promise<KnownUser[]> {
    await this.load();
    return this.list();
  }
}
