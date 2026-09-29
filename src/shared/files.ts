/**
 * File classification and path rules, shared by the server, the browser
 * client and the local mirror bridge so all three agree on what is a text
 * document (collaboratively edited through Yjs) and what is an opaque file
 * (uploaded and served as bytes).
 */

/** Extensions always edited as text. */
const TEXT_EXTENSIONS = new Set([
  'tex', 'ltx', 'latex', 'bib', 'bbx', 'cbx', 'lbx', 'sty', 'cls', 'bst', 'clo', 'cfg', 'def', 'dtx', 'ins',
  'fd', 'ist', 'tikz', 'pgf', 'pgf-plot', 'txt', 'md', 'markdown', 'rst', 'csv', 'tsv', 'dat', 'json',
  'yaml', 'yml', 'toml', 'xml', 'html', 'css', 'js', 'mjs', 'ts', 'py', 'r', 'm', 'jl', 'lua', 'sh', 'gp',
  'plt', 'mk', 'makefile', 'latexmkrc', 'gitignore', 'bbl', 'ini', 'conf', 'asy', 'mp', 'glo', 'gls',
]);

/** Extensions never edited as text, even if they happen to decode. */
const BINARY_EXTENSIONS = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'eps', 'ps', 'svg', 'zip', 'gz',
  'tar', 'ttf', 'otf', 'woff', 'woff2', 'mp4', 'mov', 'webm', 'mp3', 'wav', 'xlsx', 'docx', 'pptx', 'ico',
]);

export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']);

/** Text documents larger than this are handled as opaque files. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export function extensionOf(path: string): string {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name.toLowerCase();
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Decide whether bytes are a text document. Known extensions decide on their
 * own; anything else is text when it is small, valid UTF-8 and free of NULs.
 */
export function isTextFile(path: string, bytes?: Uint8Array): boolean {
  const ext = extensionOf(path);
  if (BINARY_EXTENSIONS.has(ext)) return false;
  if (bytes && bytes.length > MAX_TEXT_BYTES) return false;
  if (TEXT_EXTENSIONS.has(ext)) return bytes ? decodesAsText(bytes) : true;
  if (!bytes) return false;
  return decodesAsText(bytes);
}

function decodesAsText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Top-level names inside a project that are never part of the document tree. */
export const RESERVED_DIRS = new Set(['.git', '.texwerk']);

/**
 * Normalise a project-relative path, or return null when it is unsafe:
 * absolute, escaping upward, empty, or touching a reserved directory.
 */
export function cleanPath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0) return null;
  if (parts.some((p) => p === '..' || p.includes('\0'))) return null;
  if (RESERVED_DIRS.has(parts[0])) return null;
  return parts.join('/');
}

/**
 * A project id: its path under the projects root, folders included
 * ("Lab/2027/Paper"). Every segment must be a valid name.
 */
export function cleanProjectId(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split('/').map((p) => cleanProjectName(p));
  if (!parts.length || parts.some((p) => p === null)) return null;
  return parts.join('/');
}

/** A valid single project or folder name. */
export function cleanProjectName(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (!name || name.length > 120) return null;
  if (name.startsWith('.') || /[/\\\0]/.test(name)) return null;
  return name;
}

/**
 * LaTeX build by-products. The mirror bridge never uploads these, so an agent
 * or person that runs latexmk locally does not flood the shared project.
 */
const BUILD_ARTIFACT = /\.(aux|log|fls|fdb_latexmk|synctex\.gz|synctex\(busy\)|synctex|blg|toc|lof|lot|nav|snm|vrb|xdv|run\.xml|bcf|out|idx|ilg|ind|dvi)$/i;

export function isBuildArtifact(path: string): boolean {
  return BUILD_ARTIFACT.test(path);
}

/** Editor swap and backup files the bridge ignores. */
export function isEditorTempFile(path: string): boolean {
  const name = path.split('/').pop() ?? '';
  return name.endsWith('~') || /^\.?#/.test(name) || /\.sw[a-p]x?$/.test(name) || name === '4913'
    || /\.tmp(\.|$)/i.test(name) || /___jb_(tmp|old)___$/.test(name) || /\.crswap$/.test(name)
    || name.startsWith('.texwerk-tmp-') || name === '.DS_Store';
}

/** Stable per-person colour for carets and presence dots. */
const PALETTE = ['#7aa2f7', '#9ece6a', '#e0af68', '#f7768e', '#bb9af7', '#7dcfff', '#ff9e64', '#73daca', '#c0caf5', '#2ac3de'];

export function colorFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
