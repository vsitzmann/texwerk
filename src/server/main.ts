import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startServer } from './server.ts';

/**
 * TeXWerk collaboration server:
 *   npm run serve -- <projectsRootDir> [--port 5810] [--host 0.0.0.0] [--access <adminLogin>] [--allow-host <name>]
 *
 * Every top-level folder of <projectsRootDir> is a LaTeX project and a git
 * repository. Binds all interfaces by default so tailnet peers can reach it.
 *
 * --access <adminLogin> takes identity from `tailscale serve`'s
 * Tailscale-User-Login headers (trusted on loopback only — pair with
 * --host 127.0.0.1 and `tailscale serve`). Without it, people type a name.
 *
 * --allow-host <name> (repeatable): a DNS name people reach the server by,
 * besides IP addresses, localhost, single-label, *.ts.net and *.local names,
 * which are always allowed (see origin.ts).
 */
const args = process.argv.slice(2);
let rootDir: string | null = null;
let port = 5810;
let host = '0.0.0.0';
let access: string | null = null;
const allowHosts: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else if (args[i] === '--host') host = args[++i];
  else if (args[i] === '--access') access = args[++i];
  else if (args[i] === '--allow-host') allowHosts.push(...args[++i].split(','));
  else if (!args[i].startsWith('-') && !rootDir) rootDir = args[i];
}
if (!rootDir || Number.isNaN(port)) {
  process.stderr.write('usage: npm run serve -- <projectsRootDir> [--port 5810] [--host 0.0.0.0] [--access <adminLogin>] [--allow-host <name>]\n');
  process.exit(2);
}
if (access && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
  process.stderr.write('warning: --access trusts identity headers on loopback only. Bind --host 127.0.0.1 and front the server with `tailscale serve`.\n');
}

const appDir = resolve(import.meta.dirname, '..', '..');
const clientDir = join(appDir, 'dist', 'client');
const bridgeFile = join(appDir, 'dist', 'texwerk-connect.mjs');
const server = await startServer({
  rootDir: resolve(rootDir),
  clientDir: existsSync(join(clientDir, 'index.html')) ? clientDir : null,
  bridgeFile: existsSync(bridgeFile) ? bridgeFile : null,
  port,
  host,
  access: access ? { admin: access } : null,
  allowHosts,
});
process.stdout.write(`${JSON.stringify({ status: 'serving', rootDir: resolve(rootDir), access, urls: server.urls })}\n`);

const stop = () => { void server.close().then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
