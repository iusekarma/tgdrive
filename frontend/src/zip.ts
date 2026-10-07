// Lists a zip's contents, and reads single entries, without downloading it. A zip ends with its "central
// directory", an index of every entry, so two or three range requests at the
// end of the file are enough however large the archive is. Each one costs the
// server one chunk fetch from Telegram.

export interface ZipEntry {
  /** The full path inside the archive, without a trailing slash for folders. */
  path: string;
  dir: boolean;
  size: number;
  compressed: number;
  /** Seconds, local time as the zip stores it. */
  modified: number | null;
  encrypted: boolean;
  /** Where the entry's local header starts, and how its data is compressed (0 stored, 8 deflate). */
  offset: number;
  method: number;
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** The end record is 22 bytes plus a comment of at most 64 KiB. */
const TAIL = 22 + 0xffff;
/** More than this is a damaged file or millions of entries; neither is worth listing here. */
const DIRECTORY_MAX = 64 * 1024 * 1024;

export class ZipError extends Error {}

async function readRange(url: string, start: number, end: number, signal?: AbortSignal): Promise<DataView<ArrayBuffer>> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal });
  if (!res.ok) throw new Error(`The file couldn't be read (${res.status}).`);
  const buf = await res.arrayBuffer();
  // A server that ignores Range sends everything; refuse rather than misread it.
  if (res.status !== 206 && !(start === 0 && buf.byteLength === end)) throw new Error("The server ignored the range.");
  return new DataView(buf);
}

const u64 = (v: DataView, at: number) => Number(v.getBigUint64(at, true));

/** DOS date and time fields → seconds since the epoch, read as UTC so it shows as stored. */
function dosTime(date: number, time: number): number | null {
  if (date === 0) return null;
  const ms = Date.UTC(
    (date >> 9) + 1980, ((date >> 5) & 0xf) - 1, date & 0x1f,
    time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2,
  );
  return Number.isFinite(ms) ? ms / 1000 : null;
}

const utf8 = new TextDecoder("utf-8");
// Names without the UTF-8 flag are in the archiver's code page, usually CP437.
// Plain ASCII is the same either way; anything else is read as UTF-8, which is
// what most modern tools write even when they forget the flag.
const decodeName = (bytes: Uint8Array) => utf8.decode(bytes);

function parseDirectory(v: DataView, count: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > v.byteLength || v.getUint32(at, true) !== CENTRAL) throw new ZipError("The archive's index is damaged.");
    const flags = v.getUint16(at + 8, true);
    let compressed = v.getUint32(at + 20, true);
    let size = v.getUint32(at + 24, true);
    let offset = v.getUint32(at + 42, true);
    const nameLength = v.getUint16(at + 28, true);
    const extraLength = v.getUint16(at + 30, true);
    const commentLength = v.getUint16(at + 32, true);
    const nameStart = at + 46;
    const name = decodeName(new Uint8Array(v.buffer, v.byteOffset + nameStart, nameLength));

    // ZIP64 sizes live in extra field 0x0001, present only for the fields that overflowed.
    let x = nameStart + nameLength;
    const extraEnd = x + extraLength;
    while (x + 4 <= extraEnd) {
      const id = v.getUint16(x, true);
      const length = v.getUint16(x + 2, true);
      if (id === 0x0001) {
        let f = x + 4;
        const end = f + length;
        if (size === 0xffffffff && f + 8 <= end) (size = u64(v, f)), (f += 8);
        if (compressed === 0xffffffff && f + 8 <= end) (compressed = u64(v, f)), (f += 8);
        if (offset === 0xffffffff && f + 8 <= end) offset = u64(v, f);
        break;
      }
      x += 4 + length;
    }

    const dir = name.endsWith("/");
    entries.push({
      path: name.replace(/\/+$/, ""),
      dir,
      size: dir ? 0 : size,
      compressed: dir ? 0 : compressed,
      modified: dosTime(v.getUint16(at + 14, true), v.getUint16(at + 12, true)),
      encrypted: (flags & 1) === 1,
      offset,
      method: v.getUint16(at + 10, true),
    });
    at = extraEnd + commentLength;
  }
  return entries;
}

/** Every entry in the zip at `url` (which must honour Range requests). */
export async function listZip(url: string, size: number, signal?: AbortSignal): Promise<ZipEntry[]> {
  if (size < 22) throw new ZipError("This isn't a zip file.");
  const tailStart = Math.max(0, size - TAIL);
  const tail = await readRange(url, tailStart, size, signal);

  let eocd = -1;
  for (let at = tail.byteLength - 22; at >= 0; at -= 1) {
    if (tail.getUint32(at, true) === EOCD) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("This isn't a zip file, or it is damaged.");

  let count = tail.getUint16(eocd + 10, true);
  let dirSize = tail.getUint32(eocd + 12, true);
  let dirStart = tail.getUint32(eocd + 16, true);

  // ZIP64: past 65,535 entries or 4 GiB the real values are in a second record.
  if (count === 0xffff || dirSize === 0xffffffff || dirStart === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || tail.getUint32(loc, true) !== ZIP64_LOCATOR) throw new ZipError("The archive's index is damaged.");
    const recordAt = u64(tail, loc + 8);
    const rel = recordAt - tailStart;
    const record = rel >= 0 && rel + 56 <= tail.byteLength
      ? new DataView(tail.buffer, tail.byteOffset + rel, 56)
      : await readRange(url, recordAt, recordAt + 56, signal);
    if (record.getUint32(0, true) !== ZIP64_EOCD) throw new ZipError("The archive's index is damaged.");
    count = u64(record, 32);
    dirSize = u64(record, 40);
    dirStart = u64(record, 48);
  }

  if (count === 0) return [];
  if (dirSize > DIRECTORY_MAX) throw new ZipError("This archive's index is too large to list here.");
  if (dirStart + dirSize > size) throw new ZipError("The archive's index is damaged.");

  // Usually the index is already in the tail that was read.
  const rel = dirStart - tailStart;
  const directory = rel >= 0
    ? new DataView(tail.buffer, tail.byteOffset + rel, dirSize)
    : await readRange(url, dirStart, dirStart + dirSize, signal);
  return parseDirectory(directory, count);
}

/** Room for the local header's name and extra field, which can differ from the central copy. */
const LOCAL_SLACK = 1024;

/** One file from the zip, decompressed: one range request (two if its local
 * header is unusually long). Stored and deflated entries only, the two that
 * comic and photo archives use. */
export async function readZipEntry(
  url: string,
  size: number,
  entry: ZipEntry,
  type = "",
  signal?: AbortSignal,
): Promise<Blob> {
  if (entry.encrypted) throw new ZipError("This page is password protected.");
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError("This page is compressed in a way the browser can't read.");
  const guess = Math.min(size, entry.offset + 30 + LOCAL_SLACK + entry.compressed);
  let v = await readRange(url, entry.offset, guess, signal);
  if (v.byteLength < 30 || v.getUint32(0, true) !== LOCAL) throw new ZipError("The archive is damaged.");
  const dataStart = 30 + v.getUint16(26, true) + v.getUint16(28, true);
  if (dataStart + entry.compressed > v.byteLength) {
    const from = entry.offset + dataStart;
    v = await readRange(url, from, from + entry.compressed, signal);
  } else {
    v = new DataView(v.buffer, v.byteOffset + dataStart, entry.compressed);
  }
  const data = new Blob([v], { type });
  if (entry.method === 0) return data;
  return new Response(data.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob().then(
    (b) => new Blob([b], { type }),
  );
}
