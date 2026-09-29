/**
 * The wire protocol between the server and its clients (browser tabs and
 * mirror bridges).
 *
 * One WebSocket per project at /ws?project=<name>. Binary frames carry the
 * standard y-protocols messages: a leading varUint of MSG_SYNC or
 * MSG_AWARENESS. Text frames carry JSON events (ServerEvent) that are not
 * document state: who you are, compile status, history and git changes.
 *
 * The project's Y.Doc holds:
 *   text: Y.Map<Y.Text>   path -> document, for every text file
 *   bin:  Y.Map<BinInfo>  path -> {hash, size}, for every other file
 *   dirs: Y.Map<true>     path -> true, for every folder (so empty ones show)
 * Only the server adds or removes keys in these maps; clients change the
 * contents of Y.Text values and ask for structural changes over HTTP.
 */

export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;

export interface BinInfo {
  hash: string;
  size: number;
}

export interface Identity {
  login: string;
  name: string;
  color: string;
}

export interface CompileSummary {
  /** Monotonic per project; the PDF URL carries it to bust caches. */
  rev: number;
  state: 'idle' | 'running' | 'done';
  ok: boolean;
  /** A PDF exists (possibly from an earlier successful run). */
  hasPdf: boolean;
  startedAt: number;
  finishedAt: number;
  by: string;
  mainFile: string;
  issues: CompileIssue[];
}

export interface CompileIssue {
  level: 'error' | 'warning' | 'badbox';
  file: string;
  line: number | null;
  message: string;
}

export type ServerEvent =
  /**
   * First message on every connection. `epoch` identifies this load of the
   * project's document on the server: after a server restart it changes, and
   * a client holding state from the old epoch must discard it rather than
   * merge it (which would duplicate every document).
   */
  | { t: 'hello'; epoch: string; you: Identity; project: string; readOnly: boolean; compile: CompileSummary; settings: ProjectSettings }
  | { t: 'compile'; compile: CompileSummary }
  | { t: 'history' }
  | { t: 'git' }
  | { t: 'settings'; settings: ProjectSettings }
  | { t: 'renamed'; from: string; to: string }
  | { t: 'notice'; message: string };

export interface ProjectSettings {
  mainFile: string;
  engine: 'pdflatex' | 'xelatex' | 'lualatex';
  autoCompile: boolean;
}

export interface HistoryEntry {
  id: number;
  ts: number;
  path: string;
  op: 'add' | 'edit' | 'delete' | 'restore';
  /** Content hash after the change; absent for deletions. */
  hash?: string;
  binary?: boolean;
  authors: string[];
}

export interface GitLabel {
  commit: string;
  message: string;
  author: string;
  ts: number;
  /** Last history entry id included in this label, when TeXWerk made it. */
  historyId: number | null;
}

/** HTTP header the mirror bridge sends so the server can tell it apart. */
export const BRIDGE_HEADER = 'x-texwerk-bridge';
