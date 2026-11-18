/**
 * A compiled PDF as the difference from the one a viewer already has.
 *
 * After a text edit almost all of a paper's PDF is the same bytes as before:
 * figures are copied into it verbatim, only at other offsets. So instead of
 * the whole file (10 MB for a paper with photos), the server sends what
 * changed: copies of byte ranges of the old PDF, and the new bytes between
 * them. A one-word edit to a 10.6 MB paper comes to about 100 KB.
 *
 * Format, little-endian: "TWD1", the new file's length (u32), then ops until
 * the end: 0 = copy (u32 offset in the old file, u32 length), 1 = new bytes
 * (u32 length, the bytes).
 */

export const PDF_DELTA_TYPE = 'application/vnd.texwerk.pdf-delta';
/** Response header naming the PDF a response carries (its SHA-256, hex). */
export const PDF_HASH_HEADER = 'x-texwerk-pdf';

const MAGIC = [0x54, 0x57, 0x44, 0x31]; // TWD1
const COPY = 0;
const ADD = 1;
/** Matches shorter than this are not worth a copy op. */
const BLOCK = 32;
const PRIME = 16777619;

function blockHash(bytes: Uint8Array, at: number): number {
  let h = 0;
  for (let k = 0; k < BLOCK; k++) h = (Math.imul(h, PRIME) + bytes[at + k]) | 0;
  return h;
}

/** The delta that turns `base` into `target`. */
export function encodeDelta(base: Uint8Array, target: Uint8Array): Uint8Array {
  // Every BLOCK-aligned block of the old file, by hash.
  const index = new Map<number, number>();
  for (let at = 0; at + BLOCK <= base.length; at += BLOCK) {
    const h = blockHash(base, at);
    if (!index.has(h)) index.set(h, at);
  }
  // PRIME^(BLOCK-1), to drop the byte leaving the rolling window.
  let out = 1;
  for (let k = 1; k < BLOCK; k++) out = Math.imul(out, PRIME);

  const chunks: Uint8Array[] = [];
  let size = 0;
  const op = (bytes: Uint8Array) => { chunks.push(bytes); size += bytes.length; };
  const header = new Uint8Array(8);
  header.set(MAGIC);
  new DataView(header.buffer).setUint32(4, target.length, true);
  op(header);
  const add = (from: number, to: number) => {
    if (to <= from) return;
    const head = new Uint8Array(5);
    head[0] = ADD;
    new DataView(head.buffer).setUint32(1, to - from, true);
    op(head);
    op(target.subarray(from, to));
  };
  const copy = (offset: number, length: number) => {
    const o = new Uint8Array(9);
    o[0] = COPY;
    const view = new DataView(o.buffer);
    view.setUint32(1, offset, true);
    view.setUint32(5, length, true);
    op(o);
  };

  let pending = 0; // start of target bytes not yet covered by an op
  let i = 0;
  let h = target.length >= BLOCK ? blockHash(target, 0) : 0;
  while (i + BLOCK <= target.length) {
    const at = index.get(h);
    if (at !== undefined && sameBytes(base, at, target, i, BLOCK)) {
      // Grow the match both ways: back into the bytes not yet sent, and forward.
      let start = i;
      let from = at;
      while (start > pending && from > 0 && base[from - 1] === target[start - 1]) { start--; from--; }
      let end = i + BLOCK;
      let to = at + BLOCK;
      while (end < target.length && to < base.length && base[to] === target[end]) { end++; to++; }
      add(pending, start);
      copy(from, end - start);
      pending = end;
      i = end;
      if (i + BLOCK <= target.length) h = blockHash(target, i);
      continue;
    }
    if (i + BLOCK < target.length) h = (Math.imul(h - Math.imul(target[i], out), PRIME) + target[i + BLOCK]) | 0;
    i++;
  }
  add(pending, target.length);

  const delta = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { delta.set(c, at); at += c.length; }
  return delta;
}

function sameBytes(a: Uint8Array, ai: number, b: Uint8Array, bi: number, n: number): boolean {
  for (let k = 0; k < n; k++) if (a[ai + k] !== b[bi + k]) return false;
  return true;
}

/** Rebuilds the new file from the old one and a delta; throws on a delta that does not fit. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  const view = new DataView(delta.buffer, delta.byteOffset, delta.byteLength);
  if (delta.length < 8 || MAGIC.some((b, k) => delta[k] !== b)) throw new Error('not a PDF delta');
  const target = new Uint8Array(view.getUint32(4, true));
  let at = 8;
  let written = 0;
  while (at < delta.length) {
    const kind = delta[at];
    if (kind === COPY && at + 9 <= delta.length) {
      const offset = view.getUint32(at + 1, true);
      const length = view.getUint32(at + 5, true);
      if (offset + length > base.length || written + length > target.length) throw new Error('PDF delta out of range');
      target.set(base.subarray(offset, offset + length), written);
      written += length;
      at += 9;
    } else if (kind === ADD && at + 5 <= delta.length) {
      const length = view.getUint32(at + 1, true);
      if (at + 5 + length > delta.length || written + length > target.length) throw new Error('PDF delta out of range');
      target.set(delta.subarray(at + 5, at + 5 + length), written);
      written += length;
      at += 5 + length;
    } else {
      throw new Error('corrupt PDF delta');
    }
  }
  if (written !== target.length) throw new Error('PDF delta is short');
  return target;
}
