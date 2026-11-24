/** Subtitles inside Matroska files. Mediabunny reads the picture and sound but
 * not these, so clusters are walked again here, over bytes just read for playback. */
import type { Bytes } from "./bytes";
import { assCue, assHeader, plainCue, type AssHeader, type Cue } from "./subtitles";
import type { EmbeddedSubtitles, EmbeddedTrack } from "./embedded";

const ID = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab, SeekPosition: 0x53ac,
  Info: 0x1549a966, TimestampScale: 0x2ad7b1, Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7,
  TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63a2, Language: 0x22b59c, LanguageBCP47: 0x22b59d, Name: 0x536e,
  FlagDefault: 0x88, FlagForced: 0x55aa, ContentEncodings: 0x6d80, ContentEncoding: 0x6240,
  ContentCompression: 0x5034, ContentCompAlgo: 0x4254, ContentCompSettings: 0x4255, ContentEncryption: 0x5035,
  Cues: 0x1c53bb6b, CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7, CueTrack: 0xf7, CueClusterPosition: 0xf1,
  Cluster: 0x1f43b675, Timestamp: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, BlockDuration: 0x9b,
} as const;
/** What can follow a cluster; one of unknown size ends at any of them. */
const TOP_LEVEL = new Set<number>([ID.Cluster, ID.Cues, ID.SeekHead, ID.Info, ID.Tracks, 0x1941a469, 0x1043a770, 0x1254c367]);

interface Element {
  id: number;
  /** Of the content. */
  start: number;
  end: number;
  unknown: boolean;
}

/** Reads one element's header out of `data`, which starts at `base` in the file. */
function header(data: Uint8Array, at: number, base: number, limit: number): Element | null {
  const first = data[at];
  if (!first) return null;
  const idLength = Math.clz32(first) - 23;
  if (idLength > 4 || at + idLength >= data.length) return null;
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + data[at + i];
  const lead = data[at + idLength];
  if (!lead) return null;
  const length = Math.clz32(lead) - 23;
  if (at + idLength + length > data.length) return null;
  let size = lead & (0xff >> length);
  let ones = size === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const b = data[at + idLength + i];
    size = size * 256 + b;
    ones &&= b === 0xff;
  }
  const start = base + at + idLength + length;
  return { id, start, end: ones ? limit : Math.min(start + size, limit), unknown: ones };
}

function* children(data: Uint8Array): Generator<{ id: number; data: Uint8Array }> {
  for (let at = 0; at < data.length; ) {
    const el = header(data, at, 0, data.length);
    if (!el) return;
    yield { id: el.id, data: data.subarray(el.start, el.end) };
    at = el.end;
  }
}

const uint = (data: Uint8Array) => data.reduce((n, b) => n * 256 + b, 0);
const string = (data: Uint8Array) => new TextDecoder().decode(data).replace(/\0+$/, "");

interface Track extends EmbeddedTrack {
  number: number;
  codec: string;
  ass: AssHeader | null;
  /** Zlib, or bytes every packet starts with that were left out. */
  compression: "deflate" | Uint8Array | null;
  seen: Set<number>;
}

const TEXT = new Set(["S_TEXT/UTF8", "S_TEXT/ASCII", "S_TEXT/ASS", "S_TEXT/SSA", "S_ASS", "S_SSA", "S_TEXT/WEBVTT", "D_WEBVTT/SUBTITLES"]);
const IMAGE: Record<string, string> = { "S_HDMV/PGS": "PGS", S_VOBSUB: "VobSub", "S_DVBSUB": "DVB" };

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class MkvSubtitles implements EmbeddedSubtitles {
  tracks: Track[] = [];
  private segment = 0;
  private scale = 1_000_000;
  private cues: { time: number; pos: number; track: number }[] = [];
  private firstCluster = 0;
  /** Where reading left off, and the times it has covered up to there. */
  private next: { pos: number; from: number; time: number } | null = null;

  private constructor(private bytes: Bytes) {}

  static async open(bytes: Bytes): Promise<MkvSubtitles | null> {
    const mkv = new MkvSubtitles(bytes);
    return (await mkv.readHeader()) ? mkv : null;
  }

  private async element(pos: number): Promise<Element | null> {
    if (pos >= this.bytes.size) return null;
    const data = await this.bytes.read(pos, Math.min(pos + 12, this.bytes.size));
    return header(data, 0, pos, this.bytes.size);
  }

  private content = (el: Element) => this.bytes.read(el.start, el.end);

  private async readHeader(): Promise<boolean> {
    const ebml = await this.element(0);
    if (ebml?.id !== ID.EBML) return false;
    const segment = await this.element(ebml.end);
    if (segment?.id !== ID.Segment) return false;
    this.segment = segment.start;
    const elsewhere = new Map<number, number>();
    const done = new Set<number>();
    for (let pos = segment.start; pos < segment.end; ) {
      const el = await this.element(pos);
      if (!el) break;
      if (el.id === ID.Cluster) {
        this.firstCluster = pos;
        break;
      }
      if (el.id === ID.SeekHead) {
        for (const seek of children(await this.content(el))) {
          if (seek.id !== ID.Seek) continue;
          const fields = new Map([...children(seek.data)].map((c) => [c.id, uint(c.data)]));
          elsewhere.set(fields.get(ID.SeekID) ?? 0, fields.get(ID.SeekPosition) ?? 0);
        }
      } else if (el.end - el.start < 64 * 1024 * 1024) {
        await this.take(el, done);
      }
      pos = el.end;
    }
    if (!this.tracks.length) return true;
    for (const id of [ID.Info, ID.Cues]) {
      const pos = elsewhere.get(id);
      if (done.has(id) || pos === undefined) continue;
      const el = await this.element(this.segment + pos);
      if (el?.id === id) await this.take(el, done);
    }
    // Subtitles may be indexed too, but can lie well after the picture they belong to.
    const own = new Set(this.tracks.map((t) => t.number));
    this.cues = this.cues.filter((c) => !own.has(c.track)).sort((a, b) => a.time - b.time || b.pos - a.pos);
    return true;
  }

  private async take(el: Element, done: Set<number>) {
    if (el.id !== ID.Info && el.id !== ID.Tracks && el.id !== ID.Cues) return;
    done.add(el.id);
    const data = await this.content(el);
    for (const c of children(data)) {
      if (c.id === ID.TimestampScale) this.scale = uint(c.data) || this.scale;
      else if (c.id === ID.TrackEntry) this.addTrack(c.data);
      else if (c.id === ID.CuePoint) {
        let time = 0;
        for (const part of children(c.data)) {
          if (part.id === ID.CueTime) time = uint(part.data);
          if (part.id !== ID.CueTrackPositions) continue;
          const fields = new Map([...children(part.data)].map((p) => [p.id, uint(p.data)]));
          const pos = fields.get(ID.CueClusterPosition);
          if (pos !== undefined) this.cues.push({ time, pos: this.segment + pos, track: fields.get(ID.CueTrack) ?? 0 });
        }
      }
    }
  }

  private addTrack(data: Uint8Array) {
    const fields = new Map([...children(data)].map((c) => [c.id, c.data]));
    const number = (id: number, otherwise: number) => (fields.has(id) ? uint(fields.get(id)!) : otherwise);
    const text = (id: number) => (fields.has(id) ? string(fields.get(id)!) : "");
    if (number(ID.TrackType, 0) !== 17) return;
    const codec = text(ID.CodecID);
    let compression: Track["compression"] = null;
    let readable = TEXT.has(codec);
    for (const enc of children(fields.get(ID.ContentEncodings) ?? new Uint8Array())) {
      for (const part of children(enc.data)) {
        if (part.id === ID.ContentEncryption) readable = false;
        if (part.id !== ID.ContentCompression) continue;
        const how = new Map([...children(part.data)].map((c) => [c.id, c.data]));
        const algo = how.has(ID.ContentCompAlgo) ? uint(how.get(ID.ContentCompAlgo)!) : 0;
        if (algo === 0) compression = "deflate";
        else if (algo === 3) compression = how.get(ID.ContentCompSettings) ?? new Uint8Array();
        else readable = false;
      }
    }
    const priv = fields.get(ID.CodecPrivate);
    this.tracks.push({
      id: `mkv-${number(ID.TrackNumber, 0)}`,
      number: number(ID.TrackNumber, 0),
      codec,
      language: text(ID.LanguageBCP47) || text(ID.Language) || "eng",
      name: text(ID.Name),
      isDefault: number(ID.FlagDefault, 1) === 1,
      forced: number(ID.FlagForced, 0) === 1,
      format: readable ? null : (IMAGE[codec] ?? codec),
      ass: /ASS|SSA/.test(codec) && priv ? assHeader(string(priv)) : null,
      compression,
      cues: [],
      seen: new Set(),
    });
  }

  /** Reads the cues between two times (seconds), which playback has just read past. */
  async collect(from: number, to: number) {
    const wanted = new Map(this.tracks.filter((t) => !t.format).map((t) => [t.number, t]));
    if (!wanted.size) return;
    const unit = this.scale / 1e9;
    if (!this.next || from < this.next.from - 1 || from > this.next.time + 15) {
      const at = this.cues.filter((c) => c.time * unit <= from).at(-1);
      // Without an index there is nowhere to start from but the beginning, which may be gigabytes back.
      if (!at && from > 60) return;
      this.next = { pos: at?.pos ?? this.firstCluster, from: at ? from : 0, time: at ? at.time * unit : 0 };
    }
    if (to <= this.next.time) return;
    let { pos } = this.next;
    while (pos < this.bytes.size) {
      const el = await this.element(pos);
      if (!el) return;
      if (el.id !== ID.Cluster) {
        pos = el.end;
        continue;
      }
      const read = await this.cluster(el, wanted, unit, to);
      if (!read) return;
      pos = read.end;
      this.next = { ...this.next, pos, time: read.time };
    }
  }

  /** Null if the cluster starts after `to`: it is left for later. */
  private async cluster(cluster: Element, wanted: Map<number, Track>, unit: number, to: number) {
    let time = 0;
    let pos = cluster.start;
    while (pos < cluster.end) {
      const el = await this.element(pos);
      if (!el || (cluster.unknown && TOP_LEVEL.has(el.id))) break;
      if (el.id === ID.Timestamp) {
        time = uint(await this.content(el));
        if (time * unit > to) return null;
      } else if (el.id === ID.SimpleBlock) {
        await this.block(el, time, null, wanted, unit);
      } else if (el.id === ID.BlockGroup) {
        let block: Element | null = null;
        let duration: number | null = null;
        for (let at = el.start; at < el.end; ) {
          const part = await this.element(at);
          if (!part) break;
          if (part.id === ID.Block) block = part;
          else if (part.id === ID.BlockDuration) duration = uint(await this.content(part));
          at = part.end;
        }
        if (block) await this.block(block, time, duration, wanted, unit);
      }
      pos = el.end;
    }
    return { end: cluster.unknown ? pos : cluster.end, time: time * unit };
  }

  private async block(el: Element, cluster: number, duration: number | null, wanted: Map<number, Track>, unit: number) {
    const head = await this.bytes.read(el.start, Math.min(el.start + 12, el.end));
    const length = Math.clz32(head[0]) - 23;
    if (length > 8) return;
    let number = head[0] & (0xff >> length);
    for (let i = 1; i < length; i++) number = number * 256 + head[i];
    const track = wanted.get(number);
    if (!track || track.seen.has(el.start)) return;
    track.seen.add(el.start);
    const offset = ((head[length] << 8) | head[length + 1]) << 16 >> 16;
    let data: Uint8Array = await this.bytes.read(el.start + length + 3, el.end);
    try {
      if (track.compression === "deflate") data = await inflate(data);
      else if (track.compression) data = new Uint8Array([...track.compression, ...data]);
    } catch {
      return;
    }
    const start = (cluster + offset) * unit;
    const end = start + (duration === null ? 4 : duration * unit);
    const text = string(data);
    let cue: Cue | null;
    if (track.ass) {
      // ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text
      const fields = text.split(",");
      cue = assCue(start, end, fields[2] ?? "", fields.slice(8).join(","), track.ass);
    } else {
      // WebM's WebVTT puts the cue's id and settings on two lines of their own.
      cue = plainCue(start, end, track.codec.startsWith("D_WEBVTT") ? text.split("\n").slice(2).join("\n") : text);
    }
    if (cue) track.cues.push(cue);
  }
}
