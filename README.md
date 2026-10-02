# TeXWerk

**Collaborative LaTeX editing for trusted networks and tailnets — DeckWerk's
headless collaboration server, for papers.**

Open the server's address, pick a project, and write: file tree on the left,
editor in the middle, the compiled PDF on the right. Everyone who has the
project open sees everyone else's caret and edits live. Bring your own agent
(Claude Code, Codex, …) or your own editor with one command that mirrors the
project into a local folder and keeps it in sync both ways.

No accounts. On a tailnet with `--access`, your tailnet login is your identity.

## Features

- **Real-time co-editing.** Every text file is a [Yjs](https://yjs.dev) CRDT
  document; edits and carets reach other people within milliseconds. Undo is
  per person.
- **Agents and local editors.** **Agent…** prints a one-line
  `curl … && node texwerk-connect.mjs …` command (Node 22+, nothing to
  install). It mirrors the project into a folder, and any save there — by an
  agent or by VS Code, Vim, Emacs — reaches everyone in tens of milliseconds,
  merged character by character with what others are typing. A save built on
  a version that was already outdated (an agent read the file, someone typed,
  the agent saved) is merged against the version it came from, so it never
  reverts other people's work. The agent's caret shows up in the browser, and
  its edits are attributed to "*you* · agent" in the history. Compile results
  are mirrored to `.texwerk/output.pdf` / `.texwerk/output.log`, and
  `node .texwerk/tw compile` compiles on the server and prints the errors.
- **LaTeX help while typing.** Enter after `\begin{itemize}` closes the
  environment and puts an `\item` inside; Enter on an item starts the next
  one, and Enter on an empty last item leaves the list. Picking an
  environment from the completion list inserts it whole, with Tab stops
  (a figure gets placement, file, caption and label). `\ref{` lists the
  project's labels, `\cite{` the keys of its .bib files, `\includegraphics{`
  / `\input{` its files, and `\` the usual commands plus the project's own
  `\newcommand`s. Renaming a `\begin{…}` from the list renames its `\end`.
- **Vim keybindings**, switched on per browser with **Vim** above the editor.
  `:w` compiles; `u` / `Ctrl+R` are the same per-person undo as `Ctrl+Z`.
- **Full edit history.** Every version of every file is kept (coalesced into
  steps after 5 s of quiet or 1 minute of continuous editing). The History
  view groups changes by time and author, shows diffs, restores single files
  or the whole project to any point.
- **Comments.** Select text and press **💬 Comment** (or Ctrl+Alt+M). The
  text gets a highlight in the author's colour and a speech-bubble mark in
  the gutter; the PDF gets a pin in the margin at the same place (via
  SyncTeX). Threads are conversations: reply, edit, resolve, reopen. The
  **Comments** tab lists them — open ones in document order, resolved ones
  greyed at the bottom — and jumps to the text. View-only people can comment.
  Nothing is written into the .tex files: threads live beside them, stay
  attached to their words while people type, are committed with every label
  (`.texwerk/comments.json`), and come along on request as **Project as .zip
  + comments** or **Compiled PDF with comments** (real PDF sticky notes).
  Agents see them in `.texwerk/comments.md` and use `node .texwerk/tw
  comments | comment | reply | resolve`.
- **Chat.** The **Chat** tab next to **Comments** is a running conversation
  for the whole project, open to view-only people too. Enter sends,
  Shift+Enter starts a new line, `@` completes the names of the people here
  plus `@agent` and `@all`. `main.tex:12` or `comment:<id>` in a message
  (or attached by an agent) jumps to the line or opens the thread. The tab
  counts unread messages (per browser), mentions of you are highlighted and
  put "(N)" in the window title, and the bell in the tab switches on browser
  notifications for mentions (and @all / @everyone) while the page is in the
  background. The chat is saved to `.texwerk/chat.jsonl` (one message per
  line) and committed with every label; a revert does not roll it back.
  Agents see the newest 200 messages in `.texwerk/chat.md` and use `node
  .texwerk/tw chat [--since <id>]`, `node .texwerk/tw say "text" [--ref
  main.tex:12 | --ref comment:<id>]` — shown as "*you* · agent" — and `node
  .texwerk/tw chat --wait [--all]`, which blocks until someone writes
  `@agent` (with `--all`: until any person writes anything) and prints it, so
  an agent session can sit and wait for instructions. `node .texwerk/tw help`
  lists every command.
- **Who wrote what.** The **Authors** switch above the editor tints the text by
  who last wrote each part of it — people, "… · agent" for mirrored agents,
  and whoever uploaded, restored or pulled for server-side changes — with a
  legend of everyone's share of the file. It comes straight from the
  collaborative document (every character remembers the client that typed
  it), survives server restarts and renames, and costs nothing extra.
- **Labels are git commits.** Every project folder is a git repository.
  **Label version** commits the whole project, authored by you, and the label
  appears in the history, where the project can be reverted to it. **Git…**
  sets a remote and pushes/pulls; it can generate the server's SSH key to add
  as a deploy key.
- **Files.** Overleaf-style file tree: drag and drop files or whole folders
  from the desktop (onto the tree, a folder, or anywhere in the window), move
  files by dragging, rename, delete (restorable from history), set the main
  document.
- **Viewer.** The compiled PDF (PDF.js; keeps your place across recompiles,
  zoom, SyncTeX both ways: double-click the PDF to jump to the source,
  `Ctrl+Alt+→` / ⇢ to jump from the cursor to the PDF), or the image/PDF
  selected in the file tree.
- **Compile.** `latexmk` with pdfLaTeX, XeLaTeX or LuaLaTeX; auto-compile after
  edits or `Ctrl+S` / `Ctrl+Enter`. The Log tab lists errors and warnings with
  links to the line, and the raw latexmk output and TeX log.
- **Download** the project as a .zip or the compiled PDF at any time. New
  projects from a template, from an uploaded .zip, or by cloning a git repo.

## Running it

Needs Node 22.18+ (TypeScript runs natively), git, and TeX Live with `latexmk`
(and `synctex` for SyncTeX).

```bash
npm ci
npm run build                     # browser client + texwerk-connect.mjs
npm run serve -- /path/to/projects
```

The server listens on port 5810, every interface. Each top-level folder of
`/path/to/projects` is a project; nothing outside it is served.

| Reachable from | Command |
| --- | --- |
| The local network (and the tailnet) | `npm run serve -- /path/to/projects` |
| The tailnet only | `npm run serve -- /path/to/projects --host "$(tailscale ip -4)"` |
| The tailnet only, HTTPS, tailnet identities | `npm run serve -- /path/to/projects --host 127.0.0.1 --access you@example.com`<br>plus `tailscale serve --bg --https=10000 http://127.0.0.1:5810` |

With `--access`, identity comes from the `Tailscale-User-Login` headers that
`tailscale serve` adds, trusted only on loopback. Without it, people type a
name, used for carets and the history. Either way, everyone who can reach the
server can open and edit every project: this is for trusted networks. Never
expose it with `tailscale funnel`.

### As a system service (this machine)

`deploy/` sets TeXWerk up the way DeckWerk runs here: its own `texwerk` user,
projects under `/srv/texwerk/projects` (writable by you too), a sandboxed
systemd unit, and `tailscale serve` on HTTPS port 10000.

```bash
sudo ./deploy/install.sh     # once: TeX Live, user, folders, node, build, service, tailscale serve
sudo ./deploy/update.sh      # deploy the committed HEAD of this checkout and restart
```

A restart persists every open project first, including the collaborative
document itself (`.texwerk/ydoc.bin`), which is reloaded on start — so open
tabs and mirror bridges simply reconnect and carry on. Only if that saved
document is missing is it rebuilt from the files; then tabs reload and bridges
re-sync, keeping local edits they had not sent yet.

## How it works

- `src/server/` — HTTP + WebSocket server. Each open project holds one Y.Doc
  (`text`: path → Y.Text, `bin`: path → hash, `dirs`), written back to plain
  files on disk within ~120 ms; changes on disk (git pull, a shell on the
  server) are folded back in as minimal edits. `history.ts` keeps the edit
  history in `.texwerk/history/`, `git.ts` the labels, `compile.ts` runs
  latexmk into `.texwerk/build/`. `.texwerk/` is excluded from git.
- `src/client/` — the browser app (CodeMirror 6 + y-codemirror.next, PDF.js).
- `src/bridge/connect.ts` — the mirror bridge, bundled into
  `dist/texwerk-connect.mjs` and served by the server.
- `src/shared/` — protocol, file rules, the Yjs provider, the watcher.

The WebSocket protocol is y-protocols sync/awareness in binary frames plus
JSON events. Every connection starts with a `hello` carrying the document
*epoch*; a client holding state from another epoch (the server restarted)
discards it instead of merging, which would duplicate every document.

## Tests

```bash
npm test                                    # unit tests
node test/e2e-bridge.ts <origin> <project> <mirrorDir>          # with a server and a running bridge
node test/e2e-latex-editing.ts <origin> <projectsRoot>          # completion, Enter and vim in Chromium
MODE=all node test/stress-bridge.ts <origin> <project> <mirrorDir> 8
```

The stress test has two collaborators typing while an "agent" rewrites the
mirrored file every 60 ms (half in place, half by atomic rename), and checks
that every edit survives and all copies converge.

## Limits

- TeX runs with its default file access: a document can `\input` any file the
  `texwerk` user can read. The systemd sandbox limits that to the system
  itself; don't run the server with access to secrets.
- Editors that keep a stale buffer and save it will revert others' changes in
  that file, as with any file-based sync. Turn on auto-reload of changed files.
- Two people typing at exactly the same spot at the same moment interleave
  their letters, as in every real-time editor.
