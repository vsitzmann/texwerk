import { appendFile, rename, stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { freemem, loadavg } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * Where the time goes between "Recompile" and the new PDF on screen, kept per
 * project in `.texwerk/timings.jsonl`, one JSON object per line, so a slow
 * moment can be explained afterwards (`node src/server/timingsReport.ts`):
 *
 * - `compile`: the server's side of a compile: waiting behind another one,
 *   writing the files, latexmk (and how many TeX/BibTeX runs), keeping the
 *   PDF; with the machine's load, free memory and how long the server's
 *   event loop stalled since the last entry.
 * - `pdf`: a PDF sent to a viewer: whole, as a delta, or not at all (304);
 *   bytes, encoding time, and how long until the last byte left the server.
 * - `view`: a browser's side: the download as the browser saw it, PDF.js
 *   parsing and drawing, and from the click (or the compile finishing) until
 *   the new PDF is on screen; with what the browser knows of its connection.
 *
 * The file is cut to `timings.1.jsonl` past 5 MB. `.texwerk/` is never
 * committed, mirrored or visible to compiles.
 */

export const TIMINGS_FILE = join('.texwerk', 'timings.jsonl');
const MAX_BYTES = 5e6;

const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();

/** The machine's state now, and the longest event-loop stall since the last call. */
export function serverLoad(): { load1: number; freeMemMb: number; loopMaxMs: number } {
  const loopMaxMs = Math.round(loop.max / 1e6);
  loop.reset();
  return { load1: Math.round(loadavg()[0] * 100) / 100, freeMemMb: Math.round(freemem() / 1e6), loopMaxMs };
}

export async function logTiming(projectDir: string, entry: Record<string, unknown>): Promise<void> {
  const file = join(projectDir, TIMINGS_FILE);
  try {
    if (((await stat(file).catch(() => null))?.size ?? 0) > MAX_BYTES) await rename(file, join(projectDir, '.texwerk', 'timings.1.jsonl'));
    await appendFile(file, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);
  } catch { /* a log is not worth failing a compile or a download over */ }
}

/** The address a request came from: the tailnet IP that tailscale serve forwards, else the socket's. */
export function clientAddress(request: IncomingMessage): string {
  const forwarded = request.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || request.socket.remoteAddress || '';
}

/** What a browser may report about one PDF reaching its screen: numbers and a few short labels, nothing else. */
const VIEW_NUMBERS = ['rev', 'clickToDoneMs', 'compileMs', 'fetchMs', 'ttfbMs', 'bytes', 'parseMs', 'drawMs', 'doneToShownMs', 'clickToShownMs', 'downlinkMbps', 'rttMs', 'pages'] as const;
const VIEW_LABELS = ['trigger', 'mode', 'effectiveType', 'visibility'] as const;

export function cleanViewTiming(body: unknown): Record<string, unknown> {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of VIEW_NUMBERS) {
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v * 100) / 100;
  }
  for (const k of VIEW_LABELS) {
    const v = raw[k];
    if (typeof v === 'string') out[k] = v.replace(/[^\w.-]/g, '').slice(0, 20);
  }
  if (raw.fellBack === true) out.fellBack = true;
  return out;
}
