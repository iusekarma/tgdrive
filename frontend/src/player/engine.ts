/**
 * Plays a video through Media Source: the file is read by byte range, taken
 * apart by Mediabunny, and the chosen tracks handed to a <video> as fragmented
 * MP4. That is what allows choosing an audio track (browsers only play the
 * first) and limiting how much is read ahead (they decide that themselves).
 */
import {
  AudioSampleSink, CustomSource, EncodedPacket, EncodedPacketSink, Input, MATROSKA, MP4, QTFF, WEBM,
  type AudioCodec, type AudioSample, type InputAudioTrack, type InputVideoTrack,
} from "mediabunny";

import { FetchError, type Bytes } from "./bytes";
import type { EmbeddedSubtitles, EmbeddedTrack } from "./embedded";
import { FLAC_BLOCK, flacDescription, flacFrame } from "./flac";
import { audioInit, fragment, videoInit, type Init, type Sample } from "./fmp4";
import { MkvSubtitles } from "./mkv";
import { Mp4Subtitles } from "./mp4";
import { languageKey } from "./subtitles";

/** Reading ahead stops at whichever comes first. */
const AHEAD_SECONDS = 60;
const AHEAD_BYTES = 64 * 1024 * 1024;
/** Unless that would be less than this. */
const AHEAD_LEAST = 10;
/** Before playback is first asked for: enough to show a frame. */
const AHEAD_IDLE = 1;
/** Kept behind the playhead, for skipping back; cleared once there is twice this. */
const BEHIND_SECONDS = 20;
const VIDEO_FRAGMENT_SECONDS = 0.5;
const VIDEO_FRAGMENT_BYTES = 4 * 1024 * 1024;
const AUDIO_FRAGMENT_SECONDS = 1;
/** Frames arrive in decoding order; how far a later one may show before an earlier one. */
const REORDER = 16;
/** Added to every time written and taken off again by the buffer, so none is negative. */
const BASE = 10;

/** The file is fine, but this browser can't play it this way. */
export class Unsupported extends Error {}

export interface AudioChoice {
  id: number;
  language: string | undefined;
  name: string | null;
  /** "Dolby Digital 5.1" */
  format: string;
  channels: number;
  /** How it will be played; null if it can't be. */
  how: "direct" | "decode" | null;
  isDefault: boolean;
  commentary: boolean;
}

const CODEC_NAMES: Record<string, string> = {
  aac: "AAC", mp3: "MP3", opus: "Opus", vorbis: "Vorbis", flac: "FLAC", ac3: "Dolby Digital", eac3: "Dolby Digital Plus",
  dts: "DTS", truehd: "Dolby TrueHD",
};
const LAYOUTS: Record<number, string> = { 1: "mono", 2: "stereo", 6: "5.1", 7: "6.1", 8: "7.1" };

/** Decoders for what browsers don't play, each about a megabyte, fetched only when one is needed. */
const DECODERS: Record<string, () => Promise<unknown>> = {
  ac3: () => import("@mediabunny/ac3").then((m) => m.registerAc3Decoder()),
  eac3: () => import("@mediabunny/ac3").then((m) => m.registerAc3Decoder()),
  dts: () => import("@mediabunny/dts").then((m) => m.registerDtsDecoder()),
  truehd: () => import("@mediabunny/truehd").then((m) => m.registerTrueHdDecoder()),
};

const canTake = (mime: string) => MediaSource.isTypeSupported(mime);
const FLAC_MIME = 'audio/mp4; codecs="flac"';

interface Fragment {
  data: Uint8Array<ArrayBuffer>;
  start: number;
  end: number;
  /** Starts of the keyframes in it: where the buffer may be cut. */
  keys: number[];
}

interface Feeding {
  mime: string;
  init: Uint8Array<ArrayBuffer>;
  fragments: AsyncGenerator<Fragment>;
}

const nextEvent = (target: EventTarget, names: string[], signal: AbortSignal, ms: number) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      for (const n of names) target.removeEventListener(n, done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    for (const n of names) target.addEventListener(n, done);
    signal.addEventListener("abort", done);
  });

/** Keeps one SourceBuffer filled around the playhead from one track. */
class Feed {
  private buffer: SourceBuffer;
  private mime: string;
  private last: Promise<unknown> = Promise.resolve();
  private controller = new AbortController();
  private held: { start: number; end: number; bytes: number; keys: number[] }[] = [];
  private maxBytes = AHEAD_BYTES;
  private start = 0;
  private end = 0;
  private restarting = false;
  /** The track was changed, and the browser may hold decoded frames of the old one. */
  private swapped = false;
  done = false;

  constructor(
    private engine: Engine,
    mime: string,
    private open: (from: number, signal: AbortSignal) => Promise<Feeding>,
  ) {
    this.mime = mime;
    this.buffer = engine.source.addSourceBuffer(mime);
  }

  /** Buffer operations run one at a time. */
  private op<T>(work: () => T): Promise<T> {
    const run = this.last.then(
      () =>
        new Promise<T>((resolve, reject) => {
          const b = this.buffer;
          if (this.engine.source.readyState === "closed") return reject(new FetchError("closed"));
          let result: T;
          const finish = () => {
            b.removeEventListener("updateend", finish);
            b.removeEventListener("error", failed);
            resolve(result);
          };
          const failed = () => {
            b.removeEventListener("updateend", finish);
            b.removeEventListener("error", failed);
            reject(new Unsupported("The browser refused the video's data."));
          };
          try {
            result = work();
          } catch (e) {
            return reject(e as Error);
          }
          if (!b.updating) return resolve(result);
          b.addEventListener("updateend", finish);
          b.addEventListener("error", failed);
        }),
    );
    this.last = run.catch(() => undefined);
    return run;
  }

  /** Whether playback at `time` needs nothing but what is here or coming next. */
  covers(time: number) {
    return !this.restarting && time >= this.start - 0.1 && time <= this.end + 1;
  }

  /** Throws away what is buffered and starts over at `from`. */
  restart(from: number, open = this.open) {
    if (open !== this.open) this.swapped = true;
    this.open = open;
    this.controller.abort();
    const controller = (this.controller = new AbortController());
    this.done = false;
    this.restarting = true;
    this.start = this.end = from;
    this.run(from, controller.signal).catch((e: unknown) => {
      if (!controller.signal.aborted) this.engine.fail(e);
    });
  }

  private async run(from: number, signal: AbortSignal) {
    const feeding = await this.open(from, signal);
    if (signal.aborted) return void feeding.fragments.return(undefined);
    await this.op(() => {
      if (!signal.aborted) this.buffer.remove(0, Infinity);
    });
    this.held = [];
    if (feeding.mime !== this.mime) {
      await this.op(() => {
        if (!signal.aborted) this.buffer.changeType(feeding.mime);
      });
      if (signal.aborted) return;
      this.mime = feeding.mime;
    }
    await this.op(() => {
      if (signal.aborted) return;
      this.buffer.timestampOffset = -BASE;
      this.buffer.appendBuffer(feeding.init);
    });
    let first = true;
    for await (const f of feeding.fragments) {
      if (signal.aborted) return;
      if (first) {
        this.start = Math.min(f.start, from);
        this.restarting = false;
        first = false;
      }
      await this.append(f, signal);
      if (signal.aborted) return;
      this.end = f.end;
      this.held.push({ start: f.start, end: f.end, bytes: f.data.length, keys: f.keys });
      this.engine.appended(this.start, this.end);
      // Joined onto those, the new track would play up to a frame early or late from here on.
      // A seek to the same place starts the decoder afresh.
      if (this.swapped && this.end > this.engine.video.currentTime + 0.2) {
        this.swapped = false;
        this.engine.video.currentTime = this.engine.video.currentTime;
      }
      await this.room(signal);
      if (signal.aborted) return;
    }
    // Cancelled, the fragments just stop; that isn't the end of the track.
    if (signal.aborted) return;
    this.restarting = false;
    this.done = true;
    this.engine.maybeEnd();
  }

  private async append(f: Fragment, signal: AbortSignal) {
    for (;;) {
      try {
        return await this.op(() => {
          if (!signal.aborted) this.buffer.appendBuffer(f.data);
        });
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "QuotaExceededError")) throw e;
        // This browser keeps less than we meant to: make room, and settle for less from now on.
        const ahead = this.bytesAhead();
        this.maxBytes = Math.max(4 * 1024 * 1024, Math.min(this.maxBytes, ahead) * 0.75);
        await this.trim(2);
        await nextEvent(this.engine.video, ["timeupdate", "seeking"], signal, 1000);
        if (signal.aborted) return;
      }
    }
  }

  private bytesAhead() {
    const now = this.engine.video.currentTime;
    return this.held.reduce((n, h) => (h.end > now ? n + h.bytes : n), 0);
  }

  /** Waits until more should be read. */
  private async room(signal: AbortSignal) {
    while (!signal.aborted) {
      const now = this.engine.video.currentTime;
      await this.trim(BEHIND_SECONDS * 2);
      const ahead = this.end - now;
      const limit = this.engine.started ? AHEAD_SECONDS : AHEAD_IDLE;
      if (ahead < limit && (this.bytesAhead() < this.maxBytes || ahead < AHEAD_LEAST)) return;
      await nextEvent(this.engine.video, ["timeupdate", "seeking", "play"], signal, 2000);
    }
  }

  /** Drops what has been played, if there is more than `over` seconds of it. */
  private async trim(over: number) {
    const now = this.engine.video.currentTime;
    if (now - this.start <= over) return;
    const keep = now - Math.min(BEHIND_SECONDS, over);
    // Cut at a keyframe: a cut elsewhere takes everything up to the next one along.
    let cut = 0;
    for (const h of this.held) for (const k of h.keys) if (k <= keep) cut = Math.max(cut, k);
    if (cut <= this.start) return;
    this.start = cut;
    this.held = this.held.filter((h) => h.end > cut);
    await this.op(() => this.buffer.remove(0, cut));
  }

  get updating() {
    return this.buffer.updating;
  }

  stop() {
    this.controller.abort();
  }
}

export interface EngineEvents {
  /** Called once the tracks are known, and when the choice of audio changes. */
  onTracks: () => void;
  onError: (error: Error) => void;
}

export class Engine {
  readonly source = new MediaSource();
  audio: AudioChoice[] = [];
  /** The one playing. */
  audioId: number | null = null;
  subtitles: EmbeddedTrack[] = [];
  started = false;

  private input: Input;
  private url = "";
  private feeds: { video?: Feed; audio?: Feed } = {};
  private tracks = new Map<number, InputAudioTrack>();
  private embedded: EmbeddedSubtitles | null = null;
  private collecting = false;
  private collectNext: [number, number] | null = null;
  private origin = 0;
  private dead = false;

  private constructor(
    readonly video: HTMLVideoElement,
    private bytes: Bytes,
    private events: EngineEvents,
  ) {
    this.input = new Input({
      formats: [MP4, QTFF, MATROSKA, WEBM],
      source: new CustomSource({
        getSize: () => bytes.size,
        read: (start, end) => bytes.read(start, end),
        maxCacheSize: 2 * 1024 * 1024,
        handleUnhandledError: () => undefined,
      }),
    });
  }

  static supported = () => typeof MediaSource !== "undefined";

  /** Throws Unsupported if the browser should be left to play the file itself. */
  static async open(
    video: HTMLVideoElement,
    bytes: Bytes,
    language: string | null,
    events: EngineEvents,
    signal: AbortSignal,
  ): Promise<Engine> {
    const engine = new Engine(video, bytes, events);
    try {
      await engine.load(language, signal);
      return engine;
    } catch (e) {
      engine.destroy();
      throw e;
    }
  }

  private async load(language: string | null, signal: AbortSignal) {
    if (!(await this.input.canRead())) throw new Unsupported("unknown container");
    const format = (await this.input.getFormat()).name;
    const track = await this.input.getPrimaryVideoTrack();
    const config = await track?.getDecoderConfig();
    if (!track || !config) throw new Unsupported("no video track that can be read");
    const videoMime = `video/mp4; codecs="${config.codec}"`;
    if (!canTake(videoMime)) throw new Unsupported(videoMime);

    const audio = await this.input.getAudioTracks();
    for (const t of audio) {
      this.audio.push(await describe(t));
      this.tracks.set(t.id, t);
    }
    const playable = this.audio.filter((a) => a.how);
    // The browser's own player may know what to do with it.
    if (audio.length && !playable.length) throw new Unsupported("no playable audio");

    const duration = (await this.input.getDurationFromMetadata()) ?? (await this.input.computeDuration());
    const starts = await Promise.all([track, ...audio].map((t) => t.getFirstTimestampOrNull().catch(() => null)));
    const known = starts.filter((s): s is number => s !== null);
    this.origin = Math.max(0, known.length ? Math.min(...known) : 0);
    signal.throwIfAborted();

    await new Promise<void>((resolve, reject) => {
      this.source.addEventListener("sourceopen", () => resolve(), { once: true });
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      this.url = URL.createObjectURL(this.source);
      this.video.src = this.url;
    });
    this.source.duration = Math.max(0.1, duration - this.origin);

    const open = async (from: number, stop: AbortSignal) => this.openVideo(track, videoMime, config, from, stop);
    this.feeds.video = new Feed(this, videoMime, open);
    const choice =
      (language && playable.find((a) => languageKey(a.language) === language && !a.commentary)) ||
      playable.find((a) => a.isDefault) ||
      playable[0];
    if (choice) {
      this.audioId = choice.id;
      this.feeds.audio = new Feed(this, audioMime(choice, await this.codecOf(choice)), this.opener(choice));
    }
    // Both buffers must exist before either is fed.
    this.video.addEventListener("seeking", this.onSeeking);
    this.video.addEventListener("play", this.onPlay);
    if (!this.video.paused || this.video.autoplay) this.started = true;
    this.feeds.video.restart(0);
    this.feeds.audio?.restart(0);
    this.events.onTracks();
    void this.findSubtitles(format);
  }

  private codecOf = async (a: AudioChoice) => (await this.tracks.get(a.id)!.getCodecParameterString()) ?? "";

  private async findSubtitles(format: string) {
    try {
      this.embedded = /matroska|webm/i.test(format)
        ? await MkvSubtitles.open(this.bytes)
        : await Mp4Subtitles.open(this.bytes);
    } catch {
      return; // the video plays without
    }
    if (this.dead || !this.embedded?.tracks.length) return;
    this.subtitles = this.embedded.tracks;
    this.events.onTracks();
    const { currentTime } = this.video;
    this.appended(currentTime, currentTime + 1);
  }

  /** Subtitles are read from the stretch of file that was just fetched for the picture. */
  appended(start: number, end: number) {
    if (!this.embedded) return;
    this.collectNext = [Math.max(start, this.video.currentTime - BEHIND_SECONDS) + this.origin, end + this.origin];
    if (this.collecting) return;
    this.collecting = true;
    void (async () => {
      while (this.collectNext && !this.dead) {
        const [from, to] = this.collectNext;
        this.collectNext = null;
        await this.embedded!.collect(from, to).catch(() => undefined);
      }
      this.collecting = false;
    })();
  }

  /** Cue times are the file's; add this to the playback position to compare. */
  get cueOffset() {
    return this.origin;
  }

  // --- control ----------------------------------------------------------------

  private onPlay = () => {
    this.started = true;
  };

  private onSeeking = () => {
    const time = this.video.currentTime;
    const late = [this.feeds.video, this.feeds.audio].filter((f): f is Feed => !!f && !f.covers(time));
    if (!late.length) return;
    this.bytes.abandon();
    for (const f of late) f.restart(time);
  };

  setAudio(id: number) {
    const choice = this.audio.find((a) => a.id === id);
    if (!choice?.how || id === this.audioId || !this.feeds.audio) return;
    this.audioId = id;
    this.feeds.audio.restart(this.video.currentTime, this.opener(choice));
    this.events.onTracks();
  }

  /** Where a network failure left off. */
  retry() {
    const time = this.video.currentTime;
    this.feeds.video?.restart(time);
    this.feeds.audio?.restart(time);
  }

  maybeEnd() {
    const feeds = [this.feeds.video, this.feeds.audio].filter((f): f is Feed => !!f);
    if (this.source.readyState !== "open" || feeds.some((f) => !f.done || f.updating)) return;
    this.source.endOfStream();
  }

  fail(e: unknown) {
    if (this.dead) return;
    this.events.onError(e instanceof Error ? e : new Error(String(e)));
  }

  destroy() {
    this.dead = true;
    this.feeds.video?.stop();
    this.feeds.audio?.stop();
    this.video.removeEventListener("seeking", this.onSeeking);
    this.video.removeEventListener("play", this.onPlay);
    this.input.dispose();
    this.bytes.close();
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.video.removeAttribute("src");
      this.video.load();
    }
  }

  // --- tracks to fragments ------------------------------------------------------

  private async openVideo(
    track: InputVideoTrack,
    mime: string,
    config: VideoDecoderConfig,
    from: number,
    signal: AbortSignal,
  ): Promise<Feeding> {
    const sink = new EncodedPacketSink(track);
    const at = from + this.origin;
    const first =
      (await sink.getKeyPacket(at, { verifyKeyPackets: true })) ??
      (await sink.getFirstKeyPacket({ verifyKeyPackets: true }));
    const codec = await track.getCodec();
    if (!first || !codec) throw new Unsupported("no keyframe");
    const init = await videoInit(codec, first, config, await track.getRotation());
    return { mime, init: init.data, fragments: this.videoFragments(sink, first, init, signal) };
  }

  private async *videoFragments(sink: EncodedPacketSink, first: EncodedPacket, init: Init, signal: AbortSignal) {
    const units = (seconds: number) => Math.round((seconds - this.origin + BASE) * init.timescale);
    let sequence = 1;
    let pending: EncodedPacket[] = []; // in decoding order
    const order: number[] = []; // their times, sorted
    let decodeTime = -Infinity;
    let out: Sample[] = [];
    let bytes = 0;

    const take = () => {
      const p = pending.shift()!;
      const dts: number = Math.max(order.shift()!, decodeTime + 1);
      if (out.length) out[out.length - 1].duration = dts - decodeTime;
      decodeTime = dts;
      out.push({ data: p.data, pts: units(p.timestamp), dts, duration: 0, key: p.type === "key" });
      bytes += p.data.length;
    };
    const flush = (): Fragment => {
      const last = out[out.length - 1];
      if (!last.duration) last.duration = out.length > 1 ? out[out.length - 2].duration : Math.round(init.timescale / 24);
      const pts = out.map((s) => s.pts);
      const fragmentOut: Fragment = {
        data: fragment(sequence++, out),
        start: Math.min(...pts) / init.timescale - BASE,
        end: (last.dts + last.duration) / init.timescale - BASE,
        keys: out.filter((s) => s.key).map((s) => s.pts / init.timescale - BASE),
      };
      out = [];
      bytes = 0;
      return fragmentOut;
    };

    for await (const p of sink.packets(first, undefined, { verifyKeyPackets: true })) {
      if (signal.aborted) return;
      const t = units(p.timestamp);
      let i = order.length;
      while (i > 0 && order[i - 1] > t) i--;
      order.splice(i, 0, t);
      pending.push(p);
      if (pending.length <= REORDER) continue;
      take();
      const spans = out[out.length - 1].dts - out[0].dts;
      if (out.length > 1 && (spans >= VIDEO_FRAGMENT_SECONDS * init.timescale || bytes >= VIDEO_FRAGMENT_BYTES)) {
        // The last one's duration is known only once the next is, so it waits.
        const held = out.pop()!;
        const size = bytes - held.data.length;
        bytes = size;
        yield flush();
        out = [held];
        bytes = held.data.length;
      }
    }
    while (pending.length) take();
    if (out.length) yield flush();
    pending = [];
  }

  private opener = (choice: AudioChoice) => async (from: number, signal: AbortSignal): Promise<Feeding> => {
    const track = this.tracks.get(choice.id)!;
    const codec = (await track.getCodec())!;
    const config = await track.getDecoderConfig();
    if (!config) throw new Unsupported("audio can't be read");
    if (choice.how === "decode") {
      await DECODERS[codec]?.();
      return this.decoded(track, from, signal);
    }
    const sink = new EncodedPacketSink(track);
    const first = (await sink.getPacket(from + this.origin - 0.05)) ?? (await sink.getFirstPacket());
    if (!first) throw new Unsupported("empty audio track");
    const init = await audioInit(codec, first, config);
    return {
      mime: audioMime(choice, config.codec),
      init: init.data,
      fragments: this.audioFragments(sink, first, init, signal),
    };
  };

  private async *audioFragments(sink: EncodedPacketSink, first: EncodedPacket, init: Init, signal: AbortSignal) {
    const units = (seconds: number) => Math.round((seconds - this.origin + BASE) * init.timescale);
    let sequence = 1;
    let out: Sample[] = [];
    const flush = (): Fragment => {
      const last = out[out.length - 1];
      const f: Fragment = {
        data: fragment(sequence++, out),
        start: out[0].pts / init.timescale - BASE,
        end: (last.pts + last.duration) / init.timescale - BASE,
        keys: [out[0].pts / init.timescale - BASE],
      };
      out = [];
      return f;
    };
    for await (const p of sink.packets(first)) {
      if (signal.aborted) return;
      const pts = units(p.timestamp);
      const previous = out[out.length - 1];
      if (previous) {
        if (pts <= previous.pts) continue;
        previous.duration = pts - previous.pts;
        if (pts - out[0].pts >= AUDIO_FRAGMENT_SECONDS * init.timescale) yield flush();
      }
      out.push({ data: p.data, pts, dts: pts, key: true, duration: Math.max(1, Math.round(p.duration * init.timescale)) });
    }
    if (out.length) yield flush();
  }

  /** Decoded here, mixed down to stereo, and passed on as FLAC. */
  private async decoded(track: InputAudioTrack, from: number, signal: AbortSignal): Promise<Feeding> {
    const samples = new AudioSampleSink(track).samples(Math.max(0, from + this.origin - 0.05));
    const first = await samples.next();
    if (first.done) throw new Unsupported("empty audio track");
    // Replaced before it was read from: there is no loop yet to clean up after.
    const letGo = () => {
      first.value.close();
      void samples.return(undefined);
    };
    signal.addEventListener("abort", letGo);
    if (signal.aborted) letGo();
    const rate = first.value.sampleRate;
    const channels = Math.min(2, first.value.numberOfChannels);
    const silence = Array.from({ length: channels }, () => new Int16Array(FLAC_BLOCK));
    const init = await audioInit(
      "flac" as AudioCodec,
      new EncodedPacket(flacFrame(silence, 0), "key", 0, FLAC_BLOCK / rate),
      { codec: "flac", sampleRate: rate, numberOfChannels: channels, description: flacDescription(rate, channels) },
    );
    const { origin } = this;
    async function* fragments(): AsyncGenerator<Fragment> {
      const pcm = Array.from({ length: channels }, () => new Int16Array(FLAC_BLOCK));
      let filled = 0;
      let index = 0;
      let sequence = 1;
      let out: Sample[] = [];
      let position = Math.round((first.value!.timestamp - origin + BASE) * rate); // of the block being filled
      const scale = (v: number) => Math.round((v * init.timescale) / rate);
      const flush = (): Fragment => {
        const start = out[0].pts;
        const f: Fragment = {
          data: fragment(sequence++, out),
          start: start / init.timescale - BASE,
          end: (out[out.length - 1].pts + out[out.length - 1].duration) / init.timescale - BASE,
          keys: [start / init.timescale - BASE],
        };
        out = [];
        return f;
      };
      const block = () => {
        const pts = scale(position);
        out.push({ data: flacFrame(pcm, index++), pts, dts: pts, key: true, duration: scale(position + FLAC_BLOCK) - pts });
        position += FLAC_BLOCK;
        filled = 0;
      };
      try {
        for (let item: IteratorResult<AudioSample, void> = first; !item.done; item = await samples.next()) {
          const sample = item.value;
          if (signal.aborted) return sample.close();
          const mixed = stereo(sample, channels);
          const at = Math.round((sample.timestamp - origin + BASE) * rate);
          sample.close();
          const drift = at - (position + filled);
          // A hole in the track: what comes next belongs later.
          if (drift > rate / 10) {
            for (const c of pcm) c.fill(0, filled);
            if (filled) block();
            position = Math.max(position, at);
          }
          for (let used = 0; used < mixed[0].length; ) {
            const n = Math.min(FLAC_BLOCK - filled, mixed[0].length - used);
            for (let c = 0; c < channels; c++) pcm[c].set(mixed[c].subarray(used, used + n), filled);
            filled += n;
            used += n;
            if (filled === FLAC_BLOCK) block();
          }
          if (out.length * FLAC_BLOCK >= AUDIO_FRAGMENT_SECONDS * rate) yield flush();
        }
        if (filled) {
          for (const c of pcm) c.fill(0, filled);
          block();
        }
        if (out.length) yield flush();
      } finally {
        await samples.return(undefined);
      }
    }
    return { mime: FLAC_MIME, init: init.data, fragments: fragments() };
  }
}

function audioMime(choice: AudioChoice, codec: string) {
  return choice.how === "decode" ? FLAC_MIME : `audio/mp4; codecs="${codec}"`;
}

async function describe(track: InputAudioTrack): Promise<AudioChoice> {
  const codec = await track.getCodec();
  const config = await track.getDecoderConfig().catch(() => null);
  const disposition = await track.getDisposition();
  const channels = await track.getNumberOfChannels().catch(() => 0);
  let how: AudioChoice["how"] = null;
  if (codec && config) {
    if (!codec.startsWith("pcm") && codec !== "vorbis" && canTake(`audio/mp4; codecs="${config.codec}"`)) how = "direct";
    else if (canTake(FLAC_MIME) && typeof WebAssembly !== "undefined") {
      if (DECODERS[codec] || (await track.canDecode())) how = "decode";
    }
  }
  const name = codec ? (CODEC_NAMES[codec] ?? (codec.startsWith("pcm") ? "PCM" : codec.toUpperCase())) : "Unknown format";
  return {
    id: track.id,
    language: await track.getLanguageCode(),
    name: await track.getName(),
    format: [name, LAYOUTS[channels] ?? (channels ? `${channels} channels` : "")].filter(Boolean).join(" "),
    channels,
    how,
    isDefault: disposition.default,
    commentary: disposition.commentary,
  };
}

/** 16-bit, two channels at most. Surround comes as L R C LFE, then the rest in left/right pairs. */
function stereo(sample: AudioSample, channels: number): Int16Array[] {
  const n = sample.numberOfFrames;
  const planes = Array.from({ length: sample.numberOfChannels }, (_, planeIndex) => {
    const plane = new Float32Array(n);
    sample.copyTo(plane, { planeIndex, format: "f32-planar" });
    return plane;
  });
  let mix: Float32Array[] = planes.slice(0, channels);
  if (planes.length > 2) {
    const half = Math.SQRT1_2;
    const [l, r] = [new Float32Array(n), new Float32Array(n)];
    // 1 front and 2 surrounds (3 channels: no LFE), up to 7.1.
    const centre = planes[2];
    const rest = planes.length >= 6 ? planes.slice(4) : planes.slice(3);
    const gain = 1 / (1 + half + (rest.length ? half : 0));
    for (let i = 0; i < n; i++) {
      let left = planes[0][i] + centre[i] * half;
      let right = planes[1][i] + centre[i] * half;
      const sides = half / Math.max(1, Math.ceil(rest.length / 2));
      for (let c = 0; c < rest.length; c++) {
        if (rest.length % 2 && c === rest.length - 1) {
          left += rest[c][i] * sides;
          right += rest[c][i] * sides;
        } else if (c % 2 === 0) left += rest[c][i] * sides;
        else right += rest[c][i] * sides;
      }
      // Films are mixed quiet; the full safe attenuation would make them quieter still.
      l[i] = left * gain * 1.4;
      r[i] = right * gain * 1.4;
    }
    mix = [l, r];
  }
  return mix.map((plane) => {
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(plane[i] * 32767)));
    return out;
  });
}

