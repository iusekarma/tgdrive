/** Writes fragmented MP4, the form Media Source takes. Mediabunny makes the
 * header; the fragments are written here, because its own are always whole
 * runs between keyframes, and those can be ten seconds (tens of MB) long. */
import {
  EncodedAudioPacketSource, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, NullTarget, Output,
  type AudioCodec, type VideoCodec,
} from "mediabunny";

type Bytes = Uint8Array<ArrayBuffer>;

export interface Init {
  data: Bytes;
  timescale: number;
}

export function concat(parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function header(add: (output: Output) => { feed: () => Promise<unknown> }): Promise<Init> {
  const parts: Uint8Array[] = [];
  const output = new Output({
    format: new Mp4OutputFormat({
      fastStart: "fragmented",
      onFtyp: (data) => parts.push(data.slice()),
      onMoov: (data) => parts.push(data.slice()),
    }),
    target: new NullTarget(),
  });
  const { feed } = add(output);
  await output.start();
  await feed();
  await output.finalize();
  const data = concat(parts);
  return { data, timescale: timescaleOf(data) };
}

// The packet goes in at 0, so the header describes no start offset: fragments carry their own times.
export const videoInit = (codec: VideoCodec, packet: EncodedPacket, decoderConfig: VideoDecoderConfig, rotation: 0 | 90 | 180 | 270) =>
  header((output) => {
    const source = new EncodedVideoPacketSource(codec);
    output.addVideoTrack(source, { rotation });
    return { feed: () => source.add(packet.clone({ timestamp: 0, type: "key" }), { decoderConfig }) };
  });

export const audioInit = (codec: AudioCodec, packet: EncodedPacket, decoderConfig: AudioDecoderConfig) =>
  header((output) => {
    const source = new EncodedAudioPacketSource(codec);
    output.addAudioTrack(source);
    return { feed: () => source.add(packet.clone({ timestamp: 0, type: "key" }), { decoderConfig }) };
  });

/** From the one track's mdhd box. */
function timescaleOf(data: Uint8Array): number {
  for (let i = 4; i < data.length - 28; i++) {
    if (data[i] === 0x6d && data[i + 1] === 0x64 && data[i + 2] === 0x68 && data[i + 3] === 0x64) {
      const view = new DataView(data.buffer, data.byteOffset);
      return view.getUint32(i + (data[i + 4] === 1 ? 24 : 16));
    }
  }
  throw new Error("no mdhd");
}

export interface Sample {
  data: Uint8Array;
  /** Both in timescale units. */
  dts: number;
  pts: number;
  duration: number;
  key: boolean;
}

/** One moof + mdat. The header's single track is number 1. */
export function fragment(sequence: number, samples: Sample[]): Bytes {
  const payload = samples.reduce((n, s) => n + s.data.length, 0);
  const trunSize = 8 + 4 + 4 + 4 + samples.length * 16;
  const trafSize = 8 + 16 + 20 + trunSize;
  const moofSize = 8 + 16 + trafSize;
  const out = new Uint8Array(moofSize + 8 + payload);
  const view = new DataView(out.buffer);
  let at = 0;
  const u32 = (v: number) => {
    view.setUint32(at, v);
    at += 4;
  };
  const box = (size: number, type: string) => {
    u32(size);
    for (const c of type) out[at++] = c.charCodeAt(0);
  };
  box(moofSize, "moof");
  box(16, "mfhd");
  u32(0);
  u32(sequence);
  box(trafSize, "traf");
  box(16, "tfhd");
  u32(0x020000); // data offsets count from this moof
  u32(1);
  box(20, "tfdt");
  u32(0x01000000);
  const dts = Math.max(0, samples[0].dts);
  u32(Math.floor(dts / 2 ** 32));
  u32(dts >>> 0);
  box(trunSize, "trun");
  u32(0x01000f01); // version 1: composition offsets are signed
  u32(samples.length);
  u32(moofSize + 8);
  for (const s of samples) {
    u32(s.duration);
    u32(s.data.length);
    u32(s.key ? 0x02000000 : 0x01010000);
    view.setInt32(at, s.pts - s.dts);
    at += 4;
  }
  box(8 + payload, "mdat");
  for (const s of samples) {
    out.set(s.data, at);
    at += s.data.length;
  }
  return out;
}
