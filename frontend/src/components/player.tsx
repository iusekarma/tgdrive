import {
  AudioLines, Captions, CaptionsOff, Check, Gauge, Maximize, Minimize, Pause, PictureInPicture2, Play, Volume1, Volume2, VolumeX,
} from "lucide-react";
import {
  useCallback, useEffect, useRef, useState,
  type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject,
} from "react";

import { formatLength, isTransportStream } from "../format";
import { BlobBytes, FetchError, HttpBytes } from "../player/bytes";
import type { AudioChoice, Engine as EngineType } from "../player/engine";
import { languageKey, languageName, parseSubtitles, sidecarTag, type Cue } from "../player/subtitles";
import { fade, useIdle } from "./idle";
import { Loading } from "./loading";
import { Menu, MENU_ROW, MenuHeading } from "./menu";

/** Where a video comes from: a URL that answers range requests, or a local copy. */
export type VideoSource = { url: string; size: number; blob?: Blob };
/** A subtitle file lying next to the video. */
export type SubtitleFile = { id: string; name: string; url: string };

const VOLUME_KEY = "tgdrive.volume";
const MUTED_KEY = "tgdrive.muted";
const AUDIO_KEY = "tgdrive.audioLanguage";
const SUBS_KEY = "tgdrive.subtitleLanguage";
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const SKIP = 5;
const CONTROLS_HEIGHT = 80;

const saved = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const save = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: the choice just isn't remembered */
  }
};

function Message({ children }: { children: ReactNode }) {
  return <div className="max-w-sm px-6 text-center text-sm text-white/75">{children}</div>;
}

// --- how the video gets to the element -----------------------------------------

type Mode = "engine" | "stream" | "native";

/** Plays MPEG transport streams by repackaging them in the browser (mpegts.js,
 * loaded only when needed). It keeps as little ahead and behind as the engine does. */
function useTransportStream(video: RefObject<HTMLVideoElement | null>, url: string, enabled: boolean, fail: () => void) {
  useEffect(() => {
    const el = video.current;
    if (!enabled || !el) return;
    let player: { destroy(): void } | null = null;
    let live = true;
    void import("mpegts.js").then(({ default: mpegts }) => {
      if (!live) return;
      if (!mpegts.isSupported()) return fail();
      const p = mpegts.createPlayer(
        { type: "mpegts", isLive: false, url: new URL(url, location.href).href },
        {
          enableWorker: false, seekType: "range",
          lazyLoad: true, lazyLoadMaxDuration: 60, lazyLoadRecoverDuration: 30,
          autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 60, autoCleanupMinBackwardDuration: 20,
        },
      );
      p.on(mpegts.Events.ERROR, fail);
      p.attachMediaElement(el);
      p.load();
      if (el.autoplay) void (p.play() as Promise<void> | undefined)?.catch(() => undefined);
      player = p;
    }, fail);
    return () => {
      live = false;
      player?.destroy();
    };
  }, [video, url, enabled, fail]);
}

/** Runs the engine, loaded only when a video is opened. */
function useEngine(
  video: RefObject<HTMLVideoElement | null>,
  source: VideoSource,
  enabled: boolean,
  onUnsupported: () => void,
  onLost: (message: string) => void,
) {
  const engine = useRef<EngineType | null>(null);
  // Bumped when its tracks change, to draw again.
  const [, setVersion] = useState(0);
  const { url, size, blob } = source;
  useEffect(() => {
    const el = video.current;
    if (!enabled || !el) return;
    const controller = new AbortController();
    const bytes = blob ? new BlobBytes(blob) : new HttpBytes(url, size);
    const onError = (e: unknown) => {
      if (controller.signal.aborted) return;
      if (e instanceof FetchError) onLost(e.message);
      else onUnsupported();
    };
    void import("../player/engine").then(async ({ Engine }) => {
      if (!Engine.supported()) return onUnsupported();
      const opened = await Engine.open(
        el, bytes, saved(AUDIO_KEY), { onTracks: () => setVersion((v) => v + 1), onError }, controller.signal,
      );
      if (controller.signal.aborted) return opened.destroy();
      engine.current = opened;
      setVersion((v) => v + 1);
    }).catch(onError);
    return () => {
      controller.abort();
      engine.current?.destroy();
      engine.current = null;
      bytes.close();
    };
  }, [video, url, size, blob, enabled, onUnsupported, onLost]);
  return engine;
}

// --- subtitles -------------------------------------------------------------------

interface SubtitleChoice {
  id: string;
  label: string;
  language: string | null;
  isDefault: boolean;
  forced: boolean;
  /** What it is, if it can't be shown. */
  format: string | null;
  /** Not here yet for a file; still growing for a track. */
  cues: () => Cue[] | null;
}

const trackLabel = (name: string | null, language: string | undefined, n: number) => {
  const spoken = languageName(language);
  if (spoken && name && !name.toLowerCase().includes(spoken.toLowerCase())) return `${spoken} (${name})`;
  return name || spoken || `Track ${n}`;
};

/** Subtitle files are fetched when chosen. */
function useSubtitleFile(file: SubtitleFile | null) {
  const [loaded, setLoaded] = useState<{ id: string; cues: Cue[] | null } | null>(null);
  useEffect(() => {
    if (!file) return;
    const controller = new AbortController();
    fetch(file.url, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.arrayBuffer();
      })
      .then((data) => setLoaded({ id: file.id, cues: parseSubtitles(file.name, data) }))
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ id: file.id, cues: null });
      });
    return () => controller.abort();
  }, [file?.id, file?.url, file?.name]);
  return loaded && loaded.id === file?.id ? loaded : null;
}

/** The cues on screen now; checked each frame, drawn again only when they change. */
function useActiveCues(video: RefObject<HTMLVideoElement | null>, cues: (() => Cue[] | null) | null, offset: () => number) {
  const [active, setActive] = useState<Cue[]>([]);
  const latest = useRef({ cues, offset });
  latest.current = { cues, offset };
  const on = cues !== null;
  useEffect(() => {
    if (!on) return setActive([]);
    let frame = 0;
    let shown: Cue[] = [];
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const el = video.current;
      if (!el) return;
      const time = el.currentTime + latest.current.offset();
      const now = (latest.current.cues?.() ?? []).filter((c) => c.start <= time && time < c.end);
      if (now.length === shown.length && now.every((c, i) => c === shown[i])) return;
      shown = now;
      setActive(now);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [video, on]);
  return active;
}

/** Over the picture itself, not the bars around it. */
function Subtitles({ video, cues, raised }: { video: RefObject<HTMLVideoElement | null>; cues: Cue[]; raised: boolean }) {
  const [box, setBox] = useState({ left: 0, top: 0, width: 0, height: 0 });
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const measure = () => {
      const scale = Math.min(el.clientWidth / (el.videoWidth || 16), el.clientHeight / (el.videoHeight || 9));
      const [width, height] = [(el.videoWidth || 16) * scale, (el.videoHeight || 9) * scale];
      setBox({ width, height, left: (el.clientWidth - width) / 2, top: (el.clientHeight - height) / 2 });
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    el.addEventListener("resize", measure);
    return () => {
      watch.disconnect();
      el.removeEventListener("resize", measure);
    };
  }, [video]);

  const draw = (cue: Cue, key: number) => (
    <p key={key} className="whitespace-pre-line [text-wrap:balance]">
      <span className="box-decoration-clone rounded-sm bg-black/45 px-[0.3em] py-[0.05em]">
        {cue.runs.map((r, i) => (
          <span key={i} className={`${r.bold ? "font-bold" : ""} ${r.italic ? "italic" : ""}`}>
            {r.text}
          </span>
        ))}
      </span>
    </p>
  );
  const column = (a: number) => (a % 3 === 1 ? "text-left" : a % 3 === 2 ? "text-center" : "text-right");
  const row = (a: number) => (a > 6 ? "top-[4%]" : a > 3 ? "top-1/2 -translate-y-1/2" : "");
  // Clear of the controls, unless the bar below the picture already keeps them apart.
  const bottom = Math.max(box.height * 0.05, raised ? CONTROLS_HEIGHT - box.top : 0);
  const groups = new Map<number, Cue[]>();
  for (const c of cues) if (!c.at) groups.set(c.align, [...(groups.get(c.align) ?? []), c]);
  return (
    <div
      className="pointer-events-none absolute overflow-hidden font-medium leading-snug text-white [text-shadow:0_0_3px_#000,0_1px_3px_#000]"
      style={{ ...box, fontSize: Math.max(13, box.height * 0.047) }}
    >
      {[...groups].map(([align, list]) => (
        <div
          key={align}
          className={`absolute inset-x-[4%] flex flex-col gap-0.5 transition-[bottom] ${column(align)} ${row(align)}`}
          style={align > 3 ? undefined : { bottom }}
        >
          {list.map(draw)}
        </div>
      ))}
      {cues.filter((c) => c.at).map((c, i) => (
        <div
          key={i}
          className={`absolute w-max max-w-[92%] ${column(c.align)}`}
          style={{
            left: `${c.at!.x * 100}%`,
            top: `${c.at!.y * 100}%`,
            transform: `translate(${[-100, 0, -50][c.align % 3]}%, ${c.align > 6 ? 0 : c.align > 3 ? -50 : -100}%)`,
          }}
        >
          {draw(c, i)}
        </div>
      ))}
    </div>
  );
}

// --- controls ----------------------------------------------------------------------

const BUTTON = "inline-flex shrink-0 rounded-lg p-2 text-white/85 hover:bg-white/15 hover:text-white";

function Pick({ checked, disabled, note, onSelect, children }: {
  checked: boolean;
  disabled?: boolean;
  note?: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      aria-disabled={disabled}
      onClick={disabled ? undefined : onSelect}
      className={`${MENU_ROW} ${disabled ? "cursor-not-allowed opacity-50" : "text-ink"}`}
    >
      <Check size={16} className={`shrink-0 text-accent ${checked ? "" : "invisible"}`} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {note && <span className="block truncate text-xs text-muted">{note}</span>}
      </span>
    </button>
  );
}

interface Span {
  start: number;
  end: number;
}

const clockLabel = (s: number) => formatLength(Math.floor(Math.max(0, s)));

/** What has been played, what is in memory, and what isn't. */
function SeekBar({ time, duration, buffered, onSeek }: {
  time: number;
  duration: number;
  buffered: Span[];
  onSeek: (time: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const at = (e: PointerEvent) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * duration;
  };
  const pct = (t: number) => `${duration > 0 ? Math.min(100, (t / duration) * 100) : 0}%`;
  const shown = drag ?? time;
  return (
    <div
      ref={bar}
      role="slider"
      tabIndex={0}
      aria-label="Position"
      aria-valuemin={0}
      aria-valuemax={Math.floor(duration)}
      aria-valuenow={Math.floor(shown)}
      aria-valuetext={`${clockLabel(shown)} of ${clockLabel(duration)}`}
      className="group/bar relative flex h-5 touch-none cursor-pointer items-center"
      onPointerDown={(e) => {
        if (e.button !== 0 || !(duration > 0)) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(at(e));
      }}
      onPointerMove={(e) => {
        if (!(duration > 0)) return;
        setHover(at(e));
        if (drag !== null) setDrag(at(e));
      }}
      // Moves once, where it is let go: each place passed over would be fetched otherwise.
      onPointerUp={(e) => {
        if (drag === null) return;
        onSeek(at(e));
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
      onPointerLeave={() => setHover(null)}
    >
      <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/20 transition-[height] group-hover/bar:h-1.5">
        {buffered.map((b, i) => (
          <div
            key={i}
            data-buffered
            className="absolute inset-y-0 bg-white/40"
            style={{ left: pct(b.start), width: `calc(${pct(b.end)} - ${pct(b.start)})` }}
          />
        ))}
        <div className="absolute inset-y-0 left-0 bg-[var(--accent)]" style={{ width: pct(shown) }} />
      </div>
      <div
        className="absolute size-3 -translate-x-1/2 rounded-full bg-white opacity-0 shadow group-hover/bar:opacity-100 group-focus-visible/bar:opacity-100"
        style={{ left: pct(shown) }}
      />
      {(drag ?? hover) !== null && (
        <span
          className="pointer-events-none absolute bottom-full mb-1 -translate-x-1/2 rounded bg-black/80 px-1.5 py-0.5 text-xs tabular-nums text-white"
          style={{ left: `clamp(1.75rem, ${pct((drag ?? hover)!)}, calc(100% - 1.75rem))` }}
        >
          {clockLabel((drag ?? hover)!)}
        </span>
      )}
    </div>
  );
}

// --- the player ----------------------------------------------------------------------

export interface VideoPlayerProps {
  source: VideoSource;
  name: string;
  subtitles?: SubtitleFile[];
  autoPlay?: boolean;
  /** Takes the keyboard when opened. */
  focus?: boolean;
  onLoadedMetadata?: (video: HTMLVideoElement) => void;
  onTimeUpdate?: (video: HTMLVideoElement) => void;
}

/** Fills the space it's given from the start, so nothing jumps once the video's size is known. */
export function VideoPlayer(props: VideoPlayerProps) {
  const stream = isTransportStream(props.name);
  const [mode, setMode] = useState<Mode>(stream ? "stream" : "engine");
  const [failed, setFailed] = useState(false);
  // What was playing when one way of playing failed is where the next starts.
  const resume = useRef(0);
  const giveUp = useCallback((time: number) => {
    resume.current = time;
    setMode((m) => {
      if (m !== "engine") setFailed(true);
      return "native";
    });
  }, []);
  if (failed) {
    return (
      <Message>Your browser can't show this video. Download it to open it in another app.</Message>
    );
  }
  // A new element for each way, with nothing left over from the last.
  return <Player key={mode} {...props} mode={mode} startAt={resume.current} onFail={giveUp} />;
}

function Player({
  source, name, subtitles: files = [], autoPlay = true, focus = false, onLoadedMetadata, onTimeUpdate, mode, startAt, onFail,
}: VideoPlayerProps & { mode: Mode; startAt: number; onFail: (time: number) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [idle, wake] = useIdle(root);
  const [playing, setPlaying] = useState(false);
  // Until the first frame is in, and whenever playback stalls for more.
  const [waiting, setWaiting] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState<Span[]>([]);
  const [volume, setVolume] = useState(() => {
    const v = Number(saved(VOLUME_KEY) ?? 1);
    return v >= 0 && v <= 1 ? v : 1;
  });
  const [muted, setMuted] = useState(saved(MUTED_KEY) === "1");
  const [rate, setRate] = useState(1);
  const [soundOnly, setSoundOnly] = useState(false);
  const [full, setFull] = useState(false);
  const [lost, setLost] = useState<string | null>(null);
  // Undefined until the person chooses: then it follows what they chose last.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);

  const fail = useCallback(() => onFail(video.current?.currentTime ?? 0), [onFail]);
  useTransportStream(video, source.url, mode === "stream", fail);
  const engine = useEngine(video, source, mode === "engine", fail, setLost);

  useEffect(() => {
    if (!focus) return;
    // After the dialog it is in has opened, which moves the focus too.
    const frame = requestAnimationFrame(() => root.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [focus]);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.volume = volume;
    el.muted = muted;
    el.playbackRate = rate;
  }, [volume, muted, rate]);
  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const audio = engine.current?.audio ?? [];
  const tracks = engine.current?.subtitles ?? [];
  const choices: SubtitleChoice[] = [
    ...tracks.map((t, i) => ({
      id: t.id,
      label: trackLabel(t.name || null, t.language, i + 1),
      language: languageKey(t.language),
      isDefault: t.isDefault,
      forced: t.forced,
      format: t.format,
      cues: () => t.cues,
    })),
    ...files.map((f) => {
      const tag = sidecarTag(name, f.name) ?? "";
      const language = tag.split(".").map(languageKey).find(Boolean) ?? null;
      return {
        id: f.id,
        label: languageName(language ?? undefined) ?? (tag || f.name),
        language,
        isDefault: false,
        forced: /\bforced\b/i.test(tag),
        format: null,
        cues: () => null,
      };
    }),
  ];
  const wanted = saved(SUBS_KEY);
  const usable = choices.filter((c) => !c.format);
  const automatic = wanted
    ? (usable.find((c) => c.language === wanted && !c.forced) ?? (wanted === "any" ? usable[0] : undefined))
    : undefined;
  const subtitle = picked === undefined ? automatic : usable.find((c) => c.id === picked);
  const file = files.find((f) => f.id === subtitle?.id) ?? null;
  const loadedFile = useSubtitleFile(file);
  const cues = useActiveCues(
    video,
    subtitle ? (file ? () => loadedFile?.cues ?? null : subtitle.cues) : null,
    // A subtitle file's times start with the video; a track's are the file's own.
    () => (file ? 0 : (engine.current?.cueOffset ?? 0)),
  );

  function pickSubtitle(id: string | null) {
    setPicked(id);
    const choice = choices.find((c) => c.id === id);
    save(SUBS_KEY, choice ? (choice.language ?? "any") : "");
  }
  function pickAudio(a: AudioChoice) {
    engine.current?.setAudio(a.id);
    const key = languageKey(a.language);
    if (key) save(AUDIO_KEY, key);
  }

  const toggle = () => {
    const el = video.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  };
  const seek = (to: number) => {
    const el = video.current;
    if (!el || !(duration > 0)) return;
    el.currentTime = Math.min(Math.max(0, to), duration);
    setTime(el.currentTime);
  };
  const loud = (v: number) => {
    const next = Math.min(1, Math.max(0, Math.round(v * 100) / 100));
    setVolume(next);
    setMuted(false);
    save(VOLUME_KEY, String(next));
    save(MUTED_KEY, "0");
  };
  const mute = () => {
    save(MUTED_KEY, muted ? "0" : "1");
    setMuted(!muted);
  };
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (root.current?.requestFullscreen) void root.current.requestFullscreen().catch(() => undefined);
    // iPhones show only the video itself full screen.
    else (video.current as unknown as { webkitEnterFullscreen?: () => void })?.webkitEnterFullscreen?.();
  };
  const cycleSubtitles = () => {
    const i = usable.findIndex((c) => c.id === subtitle?.id);
    pickSubtitle(usable[i + 1]?.id ?? null);
  };

  function onKeyDown(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    if (e.target instanceof HTMLInputElement) return e.stopPropagation();
    // A focused button is pressed by it.
    const onButton = e.target instanceof HTMLButtonElement;
    const now = video.current?.currentTime ?? 0;
    // Shift with an arrow is the viewer's: the previous or next file.
    if (e.shiftKey && e.key.startsWith("Arrow")) return;
    if (e.key === " " && onButton) return e.stopPropagation();
    const key = e.key.toLowerCase();
    if (key === " " || key === "k") toggle();
    else if (key === "arrowleft") seek(now - SKIP);
    else if (key === "arrowright") seek(now + SKIP);
    else if (key === "j") seek(now - SKIP * 2);
    else if (key === "l") seek(now + SKIP * 2);
    else if (key === "home") seek(0);
    else if (key === "end") seek(duration - 1);
    else if (key === "arrowup") loud(volume + 0.05);
    else if (key === "arrowdown") loud(volume - 0.05);
    else if (key === "m") mute();
    else if (key === "f") fullscreen();
    else if (key === "c") cycleSubtitles();
    else return;
    e.preventDefault();
    e.stopPropagation();
    wake();
  }

  const spans = () => {
    const el = video.current;
    if (!el) return;
    setBuffered(Array.from({ length: el.buffered.length }, (_, i) => ({ start: el.buffered.start(i), end: el.buffered.end(i) })));
  };
  const ahead = buffered.find((b) => b.start <= time + 0.3 && time < b.end);
  const aheadSeconds = ahead ? Math.floor(ahead.end - time) : 0;

  const hidden = idle && playing;
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const current = audio.find((a) => a.id === engine.current?.audioId);
  return (
    <div
      ref={root}
      tabIndex={-1}
      role="group"
      aria-label={`Video player: ${name}`}
      onKeyDown={onKeyDown}
      onPointerMove={wake}
      onPointerDown={wake}
      className={`@container relative h-full w-full overflow-hidden bg-black outline-none ${hidden ? "cursor-none" : ""}`}
    >
      <video
        ref={video}
        src={mode === "native" ? source.url : undefined}
        autoPlay={autoPlay}
        playsInline
        preload="metadata"
        className="block h-full w-full bg-black"
        onPointerUp={(e) => {
          if (e.pointerType === "mouse" && e.button === 0) toggle();
        }}
        onDoubleClick={fullscreen}
        onError={() => {
          if (video.current?.error) fail();
        }}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          setDuration(el.duration);
          // Left to itself, the browser plays the sound of a video it can't decode, over a black picture.
          setSoundOnly(el.videoWidth === 0);
          if (startAt > 0) el.currentTime = startAt;
          el.playbackRate = rate;
          // Not playing yet, so it may not fetch a frame until asked: ready enough.
          if (!autoPlay) setWaiting(false);
          onLoadedMetadata?.(el);
        }}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => {
          setTime(e.currentTarget.currentTime);
          spans();
          onTimeUpdate?.(e.currentTarget);
        }}
        onProgress={spans}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedData={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onPlaying={() => setWaiting(false)}
        onSeeked={() => setWaiting(false)}
        onSeeking={spans}
        onWaiting={() => setWaiting(true)}
      />
      {cues.length > 0 && <Subtitles video={video} cues={cues} raised={!hidden} />}
      {soundOnly && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Message>Your browser can't show this video's picture, only play its sound.</Message>
        </div>
      )}
      {waiting && !lost && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {/* A soft shadow, so it shows on a bright frame too. */}
          <div className="flex size-44 items-center justify-center bg-[radial-gradient(closest-side,rgb(0_0_0/0.72),rgb(0_0_0/0.6)_55%,transparent)]">
            <Loading />
          </div>
        </div>
      )}
      {lost && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70">
          <Message>{lost}</Message>
          <button
            type="button"
            onClick={() => {
              setLost(null);
              if (engine.current) engine.current.retry();
              else onFail(time);
            }}
            className="rounded-md bg-white/10 px-4 py-2 text-sm text-white/90 hover:bg-white/20"
          >
            Try again
          </button>
        </div>
      )}
      {!playing && !waiting && !lost && !soundOnly && (
        <button
          type="button"
          data-control
          aria-label="Play"
          onClick={toggle}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/55 p-5 text-white hover:bg-black/75"
        >
          <Play size={32} className="translate-x-0.5 fill-current" aria-hidden="true" />
        </button>
      )}

      <div
        data-control
        className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/55 to-transparent px-3 pb-2 pt-8 ${fade(hidden)}`}
      >
        <SeekBar time={time} duration={duration} buffered={buffered} onSeek={seek} />
        <div className="flex items-center gap-0.5 text-sm">
          <button type="button" onClick={toggle} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (Space)" : "Play (Space)"} className={BUTTON}>
            {playing ? <Pause size={20} className="fill-current" /> : <Play size={20} className="fill-current" />}
          </button>
          <button type="button" onClick={mute} aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute (m)" : "Mute (m)"} className={BUTTON}>
            <VolumeIcon size={20} />
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => loud(Number(e.target.value))}
            aria-label="Volume"
            className="hidden w-20 accent-white @md:block"
          />
          <span className="whitespace-nowrap px-2 text-xs tabular-nums text-white/90">
            {clockLabel(time)} <span className="text-white/50">/ {clockLabel(Number.isFinite(duration) ? duration : 0)}</span>
          </span>
          {aheadSeconds > 0 && (
            <span data-ahead className="hidden whitespace-nowrap text-xs tabular-nums text-white/50 @xl:inline">
              {aheadSeconds} s buffered
            </span>
          )}
          <span className="flex-1" />
          {choices.length > 0 && (
            <Menu
              label="Subtitles"
              trigger={subtitle ? <Captions size={20} /> : <CaptionsOff size={20} />}
              buttonClass={BUTTON}
              width="w-72"
            >
              {(close) => (
                <>
                  <MenuHeading>Subtitles</MenuHeading>
                  <Pick checked={!subtitle} onSelect={() => (pickSubtitle(null), close())}>
                    Off
                  </Pick>
                  {choices.map((c) => (
                    <Pick
                      key={c.id}
                      checked={c.id === subtitle?.id}
                      disabled={c.format !== null}
                      note={
                        c.format ? `${c.format}: can't be shown here`
                        : c.id === loadedFile?.id && !loadedFile.cues ? "Couldn't be loaded"
                        : files.some((f) => f.id === c.id) ? files.find((f) => f.id === c.id)!.name
                        : c.forced ? "Forced" : undefined
                      }
                      onSelect={() => (pickSubtitle(c.id), close())}
                    >
                      {c.label}
                    </Pick>
                  ))}
                </>
              )}
            </Menu>
          )}
          {audio.length > 0 && (
            <Menu label="Audio" trigger={<AudioLines size={20} />} buttonClass={BUTTON} width="w-72">
              {(close) => (
                <>
                  <MenuHeading>Audio</MenuHeading>
                  {audio.map((a, i) => (
                    <Pick
                      key={a.id}
                      checked={a.id === current?.id}
                      disabled={!a.how}
                      note={a.how ? `${a.format}${a.how === "decode" && a.channels > 2 ? ", mixed to stereo" : ""}` : `${a.format}: can't be played here`}
                      onSelect={() => (pickAudio(a), close())}
                    >
                      {trackLabel(a.name, a.language, i + 1)}
                    </Pick>
                  ))}
                </>
              )}
            </Menu>
          )}
          <Menu
            label="Speed"
            trigger={rate === 1 ? <Gauge size={20} /> : <span className="px-0.5 text-xs font-medium leading-5 tabular-nums">{rate}×</span>}
            buttonClass={BUTTON}
            width="w-40"
          >
            {(close) => (
              <>
                <MenuHeading>Speed</MenuHeading>
                {SPEEDS.map((s) => (
                  <Pick key={s} checked={s === rate} onSelect={() => (setRate(s), close())}>
                    {s === 1 ? "Normal" : `${s}×`}
                  </Pick>
                ))}
              </>
            )}
          </Menu>
          {document.pictureInPictureEnabled && (
            <button
              type="button"
              aria-label="Picture in picture"
              title="Picture in picture"
              onClick={() =>
                void (document.pictureInPictureElement ? document.exitPictureInPicture() : video.current?.requestPictureInPicture())
                  ?.catch(() => undefined)}
              className={`${BUTTON} max-@sm:hidden`}
            >
              <PictureInPicture2 size={20} />
            </button>
          )}
          <button type="button" onClick={fullscreen} aria-label={full ? "Exit full screen" : "Full screen"} title={full ? "Exit full screen (f)" : "Full screen (f)"} className={BUTTON}>
            {full ? <Minimize size={20} /> : <Maximize size={20} />}
          </button>
        </div>
      </div>
    </div>
  );
}
