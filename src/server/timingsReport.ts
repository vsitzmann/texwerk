/**
 * Why was it slow? Reads the timings TeXWerk logs (see timings.ts) and
 * prints, per compile and per browser, where the wait went.
 *
 *   node src/server/timingsReport.ts <project folder | projects root> [--since 2026-11-18] [--slow 5]
 *
 * One line per PDF reaching a screen: when, who on what, how it started
 * (their click, someone else's compile, opening the project), the compile
 * (waiting, latexmk and its runs), the download (delta or whole, size,
 * speed), PDF.js reading and drawing, and the total wait. Lines with a wait
 * of `--slow` seconds or more (default 5) are marked, with the part that took
 * longest.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

type Entry = Record<string, unknown> & { t: string; kind: string; rev?: number };

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--')) ?? '.';
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const since = opt('since') ?? '';
const slowS = Number(opt('slow') ?? 5);

/** Every timings file under `target`: the project itself, or each project in a projects root. */
function logs(dir: string, depth = 0): string[] {
  const own = ['timings.1.jsonl', 'timings.jsonl'].map((f) => join(dir, '.texwerk', f)).filter(existsSync);
  if (own.length || depth > 3) return own;
  return readdirSync(dir).filter((f) => !f.startsWith('.')).map((f) => join(dir, f))
    .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } })
    .flatMap((p) => logs(p, depth + 1));
}

const n = (v: unknown) => (typeof v === 'number' ? v : 0);
const s = (ms: unknown) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : '–');
const mb = (b: unknown) => (typeof b === 'number' ? `${(b / 1e6).toFixed(b < 1e6 ? 2 : 1)}MB` : '–');

const files = logs(target);
if (!files.length) { console.error(`no .texwerk/timings.jsonl under ${target}`); process.exit(1); }
for (const file of files.filter((f) => f.endsWith('timings.jsonl'))) {
  const project = relative(target, join(file, '..', '..')) || '.';
  const entries: Entry[] = [file.replace('timings.jsonl', 'timings.1.jsonl'), file].filter(existsSync)
    .flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as Entry; } catch { return null; } }))
    .filter((e): e is Entry => Boolean(e) && e!.t >= since);
  const compiles = new Map(entries.filter((e) => e.kind === 'compile').map((e) => [e.rev, e]));
  const views = entries.filter((e) => e.kind === 'view');
  if (!views.length && !compiles.size) continue;
  console.log(`\n== ${project}: ${compiles.size} compiles, ${views.length} PDFs shown`);
  console.log('when (local)         who / device              start          compile          download                     draw    wait');
  let slow = 0;
  for (const v of views) {
    const c = compiles.get(v.rev);
    const wait = n(v.clickToShownMs) || n(v.doneToShownMs);
    // A view's own download, as the server saw it: same rev, same person, just before.
    const sent = entries.filter((e) => e.kind === 'pdf' && e.rev === v.rev && e.who === v.who && e.t <= v.t).pop();
    const parts: Array<[string, number]> = [
      ['compile', c ? n(c.totalMs) : n(v.compileMs)],
      ['download', n(v.fetchMs)],
      ['PDF.js', n(v.parseMs) + n(v.drawMs)],
      // From the click until the browser heard the compile was done, beyond the compile itself.
      ['getting the news', Math.max(0, n(v.clickToDoneMs) - (c ? n(c.totalMs) : n(v.compileMs)))],
    ];
    const worst = parts.reduce((a, b) => (b[1] > a[1] ? b : a));
    const isSlow = wait >= slowS * 1000;
    if (isSlow) slow++;
    const speed = n(v.fetchMs) > 0 ? `${((n(v.bytes) * 8) / (n(v.fetchMs) / 1000) / 1e6).toFixed(1)}Mb/s` : '';
    const compile = c ? `${s(c.totalMs)} (${c.runs}×${c.waitedMs ? `, waited ${s(c.waitedMs)}` : ''})` : s(v.compileMs);
    console.log([
      new Date(v.t).toLocaleString('sv').slice(0, 19).padEnd(20),
      `${String(v.who ?? '').slice(0, 14)} ${v.ua ?? ''} ${v.ip ?? ''}`.slice(0, 25).padEnd(26),
      String(v.trigger ?? '').padEnd(14),
      compile.padEnd(16),
      `${s(v.fetchMs)} ${v.mode ?? ''} ${mb(v.bytes)} ${speed}${v.fellBack ? ' fell back' : ''}`.padEnd(28),
      s(n(v.parseMs) + n(v.drawMs)).padEnd(7),
      `${s(wait)}${isSlow ? `  SLOW: ${worst[0]} ${s(worst[1])}` : ''}`,
      c && isSlow ? `  [server: load ${c.load1}, ${c.freeMemMb} MB free, event loop stalled up to ${c.loopMaxMs} ms${sent ? `; sent in ${s(sent.sendMs)}` : ''}${v.effectiveType ? `; browser says ${v.effectiveType} ${v.downlinkMbps} Mb/s` : ''}]` : '',
    ].join(' '));
  }
  console.log(`${slow} of ${views.length} waits were ${slowS} s or more.`);
}
