import { execFile } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { LARGE_FILE_BYTES, type GitLabel } from '../shared/protocol.ts';

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

/**
 * Repositories come from anywhere (clone, pull), so git runs with settings
 * that no repository can override: symbolic links are checked out as plain
 * files (a link to `../other-project` would let writes into this project
 * land in another), and no hook or fsmonitor command ever runs.
 */
const SAFE_CONFIG: Array<[string, string]> = [
  ['core.symlinks', 'false'],
  ['core.hooksPath', '/dev/null'],
  ['core.fsmonitor', 'false'],
  ['protocol.ext.allow', 'never'],
];

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
  GIT_CONFIG_COUNT: String(SAFE_CONFIG.length),
  ...Object.fromEntries(SAFE_CONFIG.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])),
};

/**
 * `.texwerk/` holds the server's own state (who may open the project, its
 * deploy key, its settings). A label commits only the comment threads and
 * the chat from it, so a tree that carries anything else there did not come
 * from TeXWerk and must not be checked out over that state.
 */
const SHARED_STATE = new Set(['.texwerk/comments.json', '.texwerk/chat.jsonl']);

async function foreignState(dir: string, treeish: string): Promise<string | null> {
  const listed = await git(dir, ['ls-tree', '-r', '--name-only', '-z', treeish, '--', '.texwerk']);
  if (!listed.ok) return null;
  const bad = listed.output.split('\0').filter((f) => f && !SHARED_STATE.has(f));
  return bad.length ? `The remote carries files in .texwerk/ (${bad.slice(0, 3).join(', ')}), where TeXWerk keeps its own state. Remove them from the repository first.` : null;
}

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
  // Projects inherit a default ACL that lets the group read new files, and
  // ssh refuses a private key anyone but its owner can read. chmod 600 also
  // drops the ACL mask, so this heals keys made before the fix too.
  try { chmodSync(key, 0o600); } catch { /* not ours to change; ssh will say so */ }
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

export function git(cwd: string, args: string[], timeoutMs = 60_000, input?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile('git', args, { cwd, env: envFor(cwd), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim() || (err ? String(err.message) : '');
      resolve({ ok: !err, output: err ? explain(output, cwd) : output });
    });
    // A git that exits without reading its input (a bad repository) must
    // not take the server down with EPIPE; its exit status says what failed.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
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

/** A blanket "every PDF" rule, as LaTeX .gitignore templates carry to keep compiled papers out. */
const BLANKET_PDF_RULE = /^(\/|\*\*\/)?\*\.(pdf|\[pP\]\[dD\]\[fF\])$/i;

/**
 * PDFs that a blanket `*.pdf` rule in the repository's .gitignore hides but
 * that are not compiled output: the figures. The rule is there to keep the
 * compiled paper out of git, and TeXWerk compiles into .texwerk/ anyway, so
 * honouring it for figures would only leave them out of every label and
 * push, and a clone would not compile. A PDF next to a LaTeX document of the
 * same name (`main.pdf` beside a `main.tex` with \documentclass) is compiled
 * output and stays ignored; one beside a snippet that only includes it
 * (`header.pdf` beside `header.tex`) is a figure. Any PDF a more specific
 * rule (a named file, a folder) ignores stays ignored.
 */
export async function ignoredFigurePdfs(dir: string): Promise<string[]> {
  const listed = await git(dir, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard']);
  if (!listed.ok) return [];
  const candidates: string[] = [];
  for (const f of listed.output.split('\0')) {
    if (!/\.pdf$/i.test(f) || f.startsWith('.texwerk/')) continue;
    const source = await readFile(join(dir, f.replace(/\.pdf$/i, '.tex')), 'utf8').catch(() => '');
    if (!/\\documentclass/.test(source)) candidates.push(f);
  }
  if (!candidates.length) return [];
  // -v names the rule that ignores each file: source, line, pattern, path.
  const r = await git(dir, ['check-ignore', '-v', '-z', '--stdin'], 60_000, candidates.map((f) => `${f}\0`).join(''));
  const fields = r.output.split('\0');
  const figures: string[] = [];
  for (let k = 0; k + 3 < fields.length; k += 4) {
    if (BLANKET_PDF_RULE.test(fields[k + 2])) figures.push(fields[k + 3]);
  }
  return figures;
}

/**
 * Files of `LARGE_FILE_BYTES` or more that `commitAll` would commit now (new
 * or changed), largest first, so a label can ask before putting them into
 * the history for good.
 */
export async function largeFilesToCommit(dir: string): Promise<Array<{ path: string; bytes: number }>> {
  await ensureRepo(dir);
  // Version 2: no entry starts with a space, which git()'s trim would eat.
  const listed = await git(dir, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
  const paths: string[] = [];
  const fields = listed.output.split('\0');
  // Fields before the path: changed (1), renamed or copied (2), unmerged (u), untracked (?).
  const skip: Record<string, number> = { 1: 8, 2: 9, u: 10, '?': 1 };
  for (let i = 0; i < fields.length; i++) {
    const n = skip[fields[i][0]];
    if (!n) continue;
    paths.push(fields[i].split(' ').slice(n).join(' '));
    if (fields[i][0] === '2') i++; // followed by the old path
  }
  paths.push(...await ignoredFigurePdfs(dir));
  const sized = await Promise.all([...new Set(paths)].map(async (path) => {
    const info = await stat(join(dir, path)).catch(() => null); // deleted: nothing to commit
    return { path, bytes: info?.isFile() ? info.size : 0 };
  }));
  return sized.filter((f) => f.bytes >= LARGE_FILE_BYTES).sort((a, b) => b.bytes - a.bytes);
}

function authorArgs(name: string, email: string): string[] {
  const safeEmail = email.includes('@') ? email : `${email.replace(/[^a-z0-9._-]/gi, '_')}@texwerk.local`;
  return ['-c', `user.name=${name}`, '-c', `user.email=${safeEmail}`];
}

export async function commitAll(dir: string, message: string, name: string, email: string, historyId: number): Promise<GitResult> {
  await ensureRepo(dir);
  const add = await git(dir, ['add', '-A']);
  if (!add.ok) return add;
  const figures = await ignoredFigurePdfs(dir);
  for (let i = 0; i < figures.length; i += 200) {
    const added = await git(dir, ['add', '-f', '--', ...figures.slice(i, i + 200)]);
    if (!added.ok) return added;
  }
  // .texwerk/ is excluded from git, except the comment threads and the
  // chat, which are part of the work: every label records them.
  for (const kept of ['comments.json', 'chat.jsonl']) {
    if (!existsSync(join(dir, '.texwerk', kept))) continue;
    const added = await git(dir, ['add', '-f', `.texwerk/${kept}`]);
    if (!added.ok) return added;
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
  const dirty = (await git(dir, ['status', '--porcelain'])).output.length > 0 || (await ignoredFigurePdfs(dir)).length > 0;
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
    const foreign = await foreignState(dir, `origin/${branch}`);
    if (foreign) return { ok: false, output: foreign };
    return git(dir, ['checkout', '-f', '-B', branch, '--track', `origin/${branch}`]);
  }
  const foreign = await foreignState(dir, `origin/${branch}`);
  if (foreign) return { ok: false, output: foreign };
  // Unlabelled work in progress is committed first so a pull never discards it.
  // (Git would overwrite an ignored figure with the remote's without asking.)
  if ((await git(dir, ['status', '--porcelain'])).output || (await ignoredFigurePdfs(dir)).length) {
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
  const r = await git(parent, ['clone', '--no-checkout', '--', url, name], 300_000);
  if (!r.ok) return r;
  const dir = join(parent, name);
  const foreign = await foreignState(dir, 'HEAD');
  if (foreign) {
    await rm(dir, { recursive: true, force: true });
    return { ok: false, output: foreign };
  }
  if (!(await git(dir, ['rev-parse', '--verify', '-q', 'HEAD'])).ok) return r; // an empty repository
  const checkout = await git(dir, ['checkout', '-q']);
  return checkout.ok ? r : checkout;
}
