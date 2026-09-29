import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { Writable } from 'node:stream';

/**
 * ZIP archives: streamed out for "Download project", read back in for
 * "Import .zip". Adapted from DeckWerk's zip module; text-heavy LaTeX
 * projects compress well, so this writer deflates.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): [number, number] {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return [time, day];
}

export interface ZipFile {
  name: string;
  load: () => Promise<Buffer>;
}

function write(out: Writable, chunk: Uint8Array): Promise<void> {
  return out.write(chunk) ? Promise.resolve() : new Promise((resolve) => out.once('drain', resolve));
}

export async function writeZip(out: Writable, files: ZipFile[]): Promise<void> {
  const [time, day] = dosDateTime(new Date());
  const records: Array<{ name: Buffer; crc: number; size: number; csize: number; method: number; offset: number }> = [];
  let offset = 0;
  for (const file of files) {
    const data = await file.load();
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(data);
    const deflated = deflateRawSync(data);
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0800, 6);
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(day, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(name.length, 26);
    await write(out, h);
    await write(out, name);
    await write(out, body);
    records.push({ name, crc, size: data.length, csize: body.length, method, offset });
    offset += 30 + name.length + body.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const r of records) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(20, 6);
    h.writeUInt16LE(0x0800, 8);
    h.writeUInt16LE(r.method, 10);
    h.writeUInt16LE(time, 12);
    h.writeUInt16LE(day, 14);
    h.writeUInt32LE(r.crc, 16);
    h.writeUInt32LE(r.csize, 20);
    h.writeUInt32LE(r.size, 24);
    h.writeUInt16LE(r.name.length, 28);
    h.writeUInt32LE(r.offset, 42);
    await write(out, h);
    await write(out, r.name);
    centralSize += 46 + r.name.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  await write(out, eocd);
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export function readZip(archive: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 22 - 0xffff); i--) {
    if (archive.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error('damaged zip');
    const method = archive.readUInt16LE(cursor + 10);
    const csize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    const start = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    const raw = archive.subarray(start, start + csize);
    if (method === 0) entries.push({ name, data: Buffer.from(raw) });
    else if (method === 8) entries.push({ name, data: inflateRawSync(raw) });
    else throw new Error(`unsupported zip compression method ${method}`);
  }
  return entries;
}
