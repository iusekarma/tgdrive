/** Text tracks inside MP4 files (tx3g "timed text", WebVTT), from the index at the start or end of the file. */
import type { Bytes } from "./bytes";
import type { EmbeddedSubtitles, EmbeddedTrack } from "./embedded";
import { plainCue, type Cue } from "./subtitles";

const MOOV_MAX = 64 * 1024 * 1024;

interface Box {
  type: string;
  data: Uint8Array;
}

const viewOf = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const fourcc = (d: Uint8Array, at: number) => String.fromCharCode(d[at], d[at + 1], d[at + 2], d[at + 3]);

function* boxes(data: Uint8Array): Generator<Box> {
  const view = viewOf(data);
  for (let at = 0; at + 8 <= data.length; ) {
    let size = view.getUint32(at);
    let head = 8;
    if (size === 1 && at + 16 <= data.length) {
      size = view.getUint32(at + 8) * 2 ** 32 + view.getUint32(at + 12);
      head = 16;
    } else if (size === 0) size = data.length - at;
    if (size < head) return;
    yield { type: fourcc(data, at + 4), data: data.subarray(at + head, at + size) };
    at += size;
  }
}

function find(data: Uint8Array, ...path: string[]): Uint8Array | null {
  for (const type of path) {
    const box = [...boxes(data)].find((b) => b.type === type);
    if (!box) return null;
    data = box.data;
  }
  return data;
}

interface Item {
  start: number;
  end: number;
  pos: number;
  size: number;
}

interface Track extends EmbeddedTrack {
  kind: string;
  items: Item[];
  read: Set<number>;
}

export class Mp4Subtitles implements EmbeddedSubtitles {
  tracks: Track[] = [];
  private constructor(private bytes: Bytes) {}

  static async open(bytes: Bytes): Promise<Mp4Subtitles | null> {
    const mp4 = new Mp4Subtitles(bytes);
    for (let pos = 0; pos + 8 <= bytes.size; ) {
      const head = viewOf(await bytes.read(pos, Math.min(pos + 16, bytes.size)));
      let size = head.getUint32(0);
      if (size === 1 && head.byteLength >= 16) size = head.getUint32(8) * 2 ** 32 + head.getUint32(12);
      else if (size === 0) size = bytes.size - pos;
      const type = fourcc(new Uint8Array(head.buffer), 4);
      if (size < 8 || !/^[\w ]{4}$/.test(type)) return pos ? mp4 : null;
      if (type === "moov") {
        if (size > MOOV_MAX) return mp4;
        mp4.readMoov((await bytes.read(pos + 8, Math.min(pos + size, bytes.size))));
        return mp4;
      }
      pos += size;
    }
    return mp4;
  }

  private readMoov(moov: Uint8Array) {
    for (const trak of boxes(moov)) {
      if (trak.type !== "trak") continue;
      const hdlr = find(trak.data, "mdia", "hdlr");
      const stbl = find(trak.data, "mdia", "minf", "stbl");
      const mdhd = find(trak.data, "mdia", "mdhd");
      const tkhd = find(trak.data, "tkhd");
      const stsd = stbl && find(stbl, "stsd");
      if (!hdlr || !stbl || !mdhd || !tkhd || !stsd) continue;
      if (!["sbtl", "text", "subt", "clcp"].includes(fourcc(hdlr, 8))) continue;
      // QuickTime's chapter titles are a text track too.
      const kind = fourcc(stsd, 12);
      if (kind === "text") continue;
      const v1 = mdhd[0] === 1;
      const view = viewOf(mdhd);
      const timescale = view.getUint32(v1 ? 20 : 12) || 1000;
      const packed = view.getUint16(v1 ? 32 : 20);
      const language = String.fromCharCode(...[10, 5, 0].map((s) => ((packed >> s) & 31) + 0x60));
      const name = new TextDecoder().decode(hdlr.subarray(24)).replace(/[\0\x01-\x1f]/g, "");
      this.tracks.push({
        id: `mp4-${viewOf(tkhd).getUint32(tkhd[0] === 1 ? 20 : 12)}`,
        language: /^[a-z]{3}$/.test(language) ? language : "und",
        name: /handler/i.test(name) ? "" : name,
        isDefault: (tkhd[3] & 1) === 1,
        forced: false,
        format: kind === "tx3g" || kind === "wvtt" ? null : kind,
        kind,
        items: samples(stbl, timescale, startShift(trak.data, timescale, moov)),
        cues: [],
        read: new Set(),
      });
    }
  }

  async collect(from: number, to: number) {
    for (const track of this.tracks) {
      if (track.format) continue;
      for (const item of track.items) {
        if (item.end < from || item.start > to || track.read.has(item.pos)) continue;
        track.read.add(item.pos);
        const data = await this.bytes.read(item.pos, item.pos + item.size);
        const cue = track.kind === "tx3g" ? timedText(item, data) : webvtt(item, data);
        if (cue) track.cues.push(cue);
      }
    }
  }
}

/** An empty edit at the start delays the track. */
function startShift(trak: Uint8Array, timescale: number, moov: Uint8Array): number {
  const elst = find(trak, "edts", "elst");
  const mvhd = find(moov, "mvhd");
  if (!elst || !mvhd) return 0;
  const view = viewOf(elst);
  const movie = viewOf(mvhd).getUint32(mvhd[0] === 1 ? 20 : 12) || 1;
  const wide = elst[0] === 1;
  let shift = 0;
  let at = 8;
  for (let i = 0; i < view.getUint32(4) && at + (wide ? 20 : 12) <= elst.length; i++, at += wide ? 20 : 12) {
    const length = wide ? Number(view.getBigUint64(at)) : view.getUint32(at);
    const media = wide ? Number(view.getBigInt64(at + 8)) : view.getInt32(at + 4);
    if (media >= 0) return shift - media / timescale;
    shift += length / movie;
  }
  return shift;
}

/** Where each sample is and when it shows, from the sample tables. */
function samples(stbl: Uint8Array, timescale: number, shift: number): Item[] {
  const stts = find(stbl, "stts");
  const stsc = find(stbl, "stsc");
  const stsz = find(stbl, "stsz");
  const co64 = find(stbl, "co64");
  const stco = co64 ?? find(stbl, "stco");
  if (!stts || !stsc || !stsz || !stco) return [];
  const [times, map, sizes, chunks] = [stts, stsc, stsz, stco].map(viewOf);
  const fixed = sizes.getUint32(4);
  const total = sizes.getUint32(8);
  const items: Item[] = [];
  let time = 0;
  let timeEntry = 0;
  let left = times.getUint32(4) ? times.getUint32(8) : 0;
  let mapEntry = 0;
  const chunkCount = chunks.getUint32(4);
  for (let chunk = 1; chunk <= chunkCount && items.length < total; chunk++) {
    while (mapEntry + 1 < map.getUint32(4) && map.getUint32(8 + (mapEntry + 1) * 12) <= chunk) mapEntry += 1;
    const per = map.getUint32(8 + mapEntry * 12 + 4);
    let pos = co64 ? Number(chunks.getBigUint64(8 + (chunk - 1) * 8)) : chunks.getUint32(8 + (chunk - 1) * 4);
    for (let i = 0; i < per && items.length < total; i++) {
      while (left === 0) {
        timeEntry += 1;
        if (timeEntry >= times.getUint32(4)) return items;
        left = times.getUint32(8 + timeEntry * 8);
      }
      left -= 1;
      const duration = times.getUint32(8 + timeEntry * 8 + 4);
      const size = fixed || sizes.getUint32(12 + items.length * 4);
      items.push({ start: time / timescale + shift, end: (time + duration) / timescale + shift, pos, size });
      time += duration;
      pos += size;
    }
  }
  return items;
}

function timedText(item: Item, data: Uint8Array): Cue | null {
  if (data.length < 2) return null;
  const text = data.subarray(2, 2 + viewOf(data).getUint16(0));
  const utf16 = text[0] === 0xfe && text[1] === 0xff;
  return plainCue(item.start, item.end, new TextDecoder(utf16 ? "utf-16be" : "utf-8").decode(text));
}

function webvtt(item: Item, data: Uint8Array): Cue | null {
  const lines = [...boxes(data)]
    .filter((b) => b.type === "vttc")
    .map((b) => new TextDecoder().decode(find(b.data, "payl") ?? new Uint8Array()));
  return plainCue(item.start, item.end, lines.join("\n"));
}
