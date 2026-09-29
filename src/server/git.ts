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

/**
 * Every project has its own SSH deploy key, created on request and kept in
 * `.texwerk/` (never committed, never mirrored). GitHub accepts a deploy key
 * on one repository only, which is exactly the scope we want: a project's key
 * can reach its own repository and nothing else. Remote operations in the
 * project use that key and no other.
 */
export function deployKeyPath(dir: string): string {
  return join(dir, '.texwerk', 'deploy_key');
}

function envFor(cwd: string): NodeJS.ProcessEnv {
  const key = deployKeyPath(cwd);
  if (!existsSync(key)) return GIT_ENV;
  return {
    ...GIT_ENV,
    GIT_SSH_COMMAND: `ssh -i '${key.replace(/'/g, `'\\''`)}' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`,
  };
}

export async function ensureDeployKey(dir: string, comment: string): Promise<string> {
  const key = deployKeyPath(dir);
  if (!existsSync(key)) {
    await mkdir(join(dir, '.texwerk'), { recursive: true });
    await new Promise<void>((done, fail) => execFile('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', key],
      (err) => (err ? fail(err) : done())));
  }
  return (await readFile(`${key}.pub`, 'utf8')).trim();
}

export async function readDeployKey(dir: string): Promise<string | null> {
  try { return (await readFile(`${deployKeyPath(dir)}.pub`, 'utf8')).trim(); } catch { return null; }
}

/** Git's answer when a remote refuses us, turned into what to do about it. */
function explain(output: string, cwd: string): string {
  if (/Permission denied \(publickey\)|Repository not found|Could not read from remote repository/i.test(output)) {
    const hint = existsSync(deployKeyPath(cwd))
      ? 'The remote refused this project\'s deploy key. Add the key shown under "Deploy key" to the repository with write access (or check the remote address).'
      : 'The remote needs a key. Create this project\'s deploy key under "Deploy key" and add it to the repository with write access.';
    return `${hint}\n\n${output}`;
  }
  return output;
}

export function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: envFor(cwd), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim() || (err ? String(err.message) : '');
      resolve({ ok: !err, output: err ? explain(output, cwd) : output });
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
  // .texwerk/ is excluded from git, except the comment threads, which are
  // part of the work: every label records them.
  if (existsSync(join(dir, '.texwerk', 'comments.json'))) {
    const comments = await git(dir, ['add', '-f', '.texwerk/comments.json']);
    if (!comments.ok) return comments;
  }
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

/**
 * The checked-out branch — also in a repository with no commits yet, where
 * `rev-parse HEAD` fails (and its error must not become the branch name).
 */
async function currentBranch(dir: string): Promise<string> {
  const r = await git(dir, ['symbolic-ref', '--short', 'HEAD']);
  return r.ok && r.output ? r.output : 'main';
}

export interface GitStatus {
  branch: string;
  remote: string;
  ahead: number | null;
  behind: number | null;
  dirty: boolean;
  /** False until the first label. */
  hasCommits: boolean;
}

export async function status(dir: string): Promise<GitStatus> {
  const branch = await currentBranch(dir);
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
  const hasCommits = (await git(dir, ['rev-parse', '--verify', '-q', 'HEAD'])).ok;
  return { branch, remote, ahead, behind, dirty, hasCommits };
}

export async function setRemote(dir: string, url: string): Promise<GitResult> {
  const has = (await git(dir, ['remote', 'get-url', 'origin'])).ok;
  if (!url) return has ? git(dir, ['remote', 'remove', 'origin']) : { ok: true, output: '' };
  return git(dir, has ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url]);
}

export async function push(dir: string): Promise<GitResult> {
  if (!(await git(dir, ['rev-parse', '--verify', '-q', 'HEAD'])).ok) {
    return { ok: false, output: 'Nothing to push yet: label a version first — each label is a commit.' };
  }
  if (!(await git(dir, ['remote', 'get-url', 'origin'])).ok) return { ok: false, output: 'Set a remote first.' };
  const branch = await currentBranch(dir);
  return git(dir, ['push', '-u', 'origin', branch], 120_000);
}

/** The remote's default branch (what `git clone` would check out). */
async function remoteDefaultBranch(dir: string): Promise<string | null> {
  const r = await git(dir, ['ls-remote', '--symref', 'origin', 'HEAD'], 60_000);
  return /ref: refs\/heads\/(\S+)\s+HEAD/.exec(r.output)?.[1] ?? null;
}

/** Can this project's key reach the remote? For the Git dialog's "Test". */
export async function testRemote(dir: string): Promise<GitResult> {
  const r = await git(dir, ['ls-remote', '--heads', 'origin'], 60_000);
  if (r.ok) return { ok: true, output: 'Connected: the server can reach the repository with this project\'s key.' };
  return r;
}

export async function pull(dir: string, name: string, email: string): Promise<GitResult> {
  let branch = await currentBranch(dir);
  const fetch = await git(dir, ['fetch', 'origin'], 120_000);
  if (!fetch.ok) return fetch;
  // A project with no labels yet adopts the remote wholesale, like a clone:
  // there is no history of ours to merge.
  if (!(await git(dir, ['rev-parse', '--verify', '-q', 'HEAD'])).ok) {
    branch = (await remoteDefaultBranch(dir)) ?? branch;
    if (!(await git(dir, ['rev-parse', '--verify', '-q', `origin/${branch}`])).ok) {
      return { ok: true, output: 'The remote is empty: nothing to pull. Label a version and push to fill it.' };
    }
    return git(dir, ['checkout', '-f', '-B', branch, '--track', `origin/${branch}`]);
  }
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
