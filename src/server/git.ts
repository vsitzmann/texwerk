import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitLabel } from '../shared/protocol.ts';

/**
 * Every project folder is a git repository.
 *
 * Git is where *labelled versions* live: "Label this version" flushes the
 * edit history and commits the whole project with the label as the message,
 * authored by whoever pressed the button, with a `TeXWerk-History: <id>`
 * trailer pointing at the history entry it corresponds to. The history panel
 * shows those labels inline, and push/pull move them to and from a remote.
 *
 * The server's working files are never staged behind anyone's back; only a
 * label (or a revert, which labels itself) creates a commit. Everything runs
 * non-interactively: no password prompts, no host-key questions.
 */

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
};

export interface GitResult {
  ok: boolean;
  output: string;
}

export function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: GIT_ENV, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout}${stderr}`.trim() || (err ? String(err.message) : '') });
    });
  });
}

/** Make `dir` a repository if it is not one, and keep .texwerk/ out of it. */
export async function ensureRepo(dir: string): Promise<void> {
  if (!existsSync(join(dir, '.git'))) {
    await git(dir, ['init', '-q', '-b', 'main']);
  }
  const exclude = join(dir, '.git', 'info', 'exclude');
  await mkdir(join(dir, '.git', 'info'), { recursive: true });
  let current = '';
  try { current = await readFile(exclude, 'utf8'); } catch { /* new */ }
  if (!current.split('\n').includes('.texwerk/')) {
    await appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}# TeXWerk history and build output\n.texwerk/\n`);
  }
}

function authorArgs(name: string, email: string): string[] {
  const safeEmail = email.includes('@') ? email : `${email.replace(/[^a-z0-9._-]/gi, '_')}@texwerk.local`;
  return ['-c', `user.name=${name}`, '-c', `user.email=${safeEmail}`];
}

export async function commitAll(dir: string, message: string, name: string, email: string, historyId: number): Promise<GitResult> {
  await ensureRepo(dir);
  const add = await git(dir, ['add', '-A']);
  if (!add.ok) return add;
  const trailer = historyId >= 0 ? ['-m', `TeXWerk-History: ${historyId}`] : [];
  return git(dir, [...authorArgs(name, email), 'commit', '--allow-empty', '-q', '-m', message, ...trailer]);
}

export async function labels(dir: string): Promise<GitLabel[]> {
  const r = await git(dir, ['log', '-n', '500', '--format=%H%x1f%an%x1f%at%x1f%s%x1f%b%x1e']);
  if (!r.ok) return [];
  const out: GitLabel[] = [];
  for (const record of r.output.split('\x1e')) {
    const [commit, author, at, subject, body] = record.trim().split('\x1f');
    if (!commit) continue;
    const m = /^TeXWerk-History:\s*(\d+)\s*$/m.exec(body ?? '');
    out.push({ commit, author, ts: Number(at) * 1000, message: subject ?? '', historyId: m ? Number(m[1]) : null });
  }
  return out;
}

export interface GitStatus {
  branch: string;
  remote: string;
  ahead: number | null;
  behind: number | null;
  dirty: boolean;
}

export async function status(dir: string): Promise<GitStatus> {
  const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).output || 'main';
  const remote = (await git(dir, ['remote', 'get-url', 'origin'])).ok
    ? (await git(dir, ['remote', 'get-url', 'origin'])).output : '';
  let ahead: number | null = null;
  let behind: number | null = null;
  const counts = await git(dir, ['rev-list', '--left-right', '--count', `HEAD...@{upstream}`]);
  if (counts.ok) {
    const [a, b] = counts.output.split(/\s+/).map(Number);
    ahead = a;
    behind = b;
  }
  const dirty = (await git(dir, ['status', '--porcelain'])).output.length > 0;
  return { branch, remote, ahead, behind, dirty };
}

export async function setRemote(dir: string, url: string): Promise<GitResult> {
  const has = (await git(dir, ['remote', 'get-url', 'origin'])).ok;
  if (!url) return has ? git(dir, ['remote', 'remove', 'origin']) : { ok: true, output: '' };
  return git(dir, has ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url]);
}

export async function push(dir: string): Promise<GitResult> {
  const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).output || 'main';
  return git(dir, ['push', '-u', 'origin', branch], 120_000);
}

export async function pull(dir: string, name: string, email: string): Promise<GitResult> {
  const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).output || 'main';
  const fetch = await git(dir, ['fetch', 'origin'], 120_000);
  if (!fetch.ok) return fetch;
  // Unlabelled work in progress is committed first so a pull never discards it.
  if ((await git(dir, ['status', '--porcelain'])).output) {
    const saved = await commitAll(dir, 'Changes before pull', name, email, -1);
    if (!saved.ok) return saved;
  }
  return git(dir, [...authorArgs(name, email), 'merge', '--no-edit', `origin/${branch}`], 120_000);
}

/** Make the working tree match `commit`: its files, and nothing else. */
export async function checkoutTree(dir: string, commit: string): Promise<GitResult> {
  if (!/^[0-9a-f]{7,40}$/.test(commit)) return { ok: false, output: 'bad commit' };
  const listed = await git(dir, ['ls-tree', '-r', '--name-only', '-z', commit]);
  if (!listed.ok) return listed;
  const keep = new Set(listed.output.split('\0').filter(Boolean));
  const tracked = (await git(dir, ['ls-files', '-z'])).output.split('\0').filter(Boolean);
  const untracked = (await git(dir, ['ls-files', '-z', '--others', '--exclude-standard'])).output.split('\0').filter(Boolean);
  const { rm } = await import('node:fs/promises');
  for (const f of [...tracked, ...untracked]) {
    if (!keep.has(f)) await rm(join(dir, f), { force: true });
  }
  return git(dir, ['checkout', commit, '--', '.']);
}

export async function clone(parent: string, url: string, name: string): Promise<GitResult> {
  return git(parent, ['clone', '--', url, name], 300_000);
}
