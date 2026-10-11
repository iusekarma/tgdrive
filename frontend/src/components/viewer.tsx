import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft, ChevronRight, Download, File as FileIcon, Film, Folder, Image as ImageIcon, Images, Info, List, Lock,
  Music, Play, RectangleVertical, Rows2, StretchHorizontal, X,
} from "lucide-react";
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject,
} from "react";

import { api, type Entry, type FileInfo } from "../api";
import { seconds, useLearn } from "../fileinfo";
import { formatDate, formatSize, isTransportStream, previewKind } from "../format";
import { sendFrame } from "../thumbs";
import { listZip, readZipEntry, zipEntryStart, type ZipEntry } from "../zip";
import { EntryDetails } from "./details";

const DARK_BUTTON = "inline-flex rounded-md p-2 text-white/75 hover:bg-white/10 hover:text-white";
const INFO_KEY = "tgdrive.viewerInfo";

function useSavedFlag(key: string): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  function change(next: boolean) {
    setOn(next);
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {
      /* private mode: the choice just isn't remembered */
    }
  }
  return [on, change];
}

function Unplayable({ what }: { what: string }) {
  return (
    <p className="max-w-sm px-6 text-center text-sm text-white/75">
      Your browser can't show this {what}. Download it to open it in another app.
    </p>
  );
}

// --- text ------------------------------------------------------------------

const TEXT_PREVIEW_LIMIT = 512 * 1024;

function TextPreview({ url, size }: { url: string; size: number }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (size === 0) {
      setText("");
      return;
    }
    const controller = new AbortController();
    // A range request, so a huge log file doesn't get pulled in whole.
    fetch(url, { headers: { Range: `bytes=0-${TEXT_PREVIEW_LIMIT - 1}` }, signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.text();
      })
      .then(setText)
      .catch((e: unknown) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) setFailed(true);
      });
    return () => controller.abort();
  }, [url, size]);

  if (failed) return <p className="text-sm text-white/75">This file couldn't be loaded. Try downloading it instead.</p>;
  if (text === null) return <p className="text-sm text-white/75">Loading…</p>;
  if (text === "") return <p className="text-sm text-white/75">This file is empty.</p>;
  return (
    <div className="flex h-full w-full max-w-5xl flex-col">
      <pre className="min-h-0 flex-1 overflow-auto rounded-md border border-line bg-paper p-4 text-sm leading-relaxed text-ink">
        {text}
      </pre>
      {size > TEXT_PREVIEW_LIMIT && (
        <p className="mt-2 text-sm text-white/75">Showing the first 512 KB. Download the file to see the rest.</p>
      )}
    </div>
  );
}

// --- video -----------------------------------------------------------------

/** Plays MPEG transport streams by repackaging them in the browser (mpegts.js,
 * loaded only when needed). Returns false where Media Source isn't available. */
function useTransportStream(video: RefObject<HTMLVideoElement | null>, url: string, enabled: boolean) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = video.current;
    if (!enabled || !el) return;
    let player: { destroy(): void } | null = null;
    let live = true;
    void import("mpegts.js").then(({ default: mpegts }) => {
      if (!live) return;
      if (!mpegts.isSupported()) return setFailed(true);
      const p = mpegts.createPlayer(
        { type: "mpegts", isLive: false, url: new URL(url, location.href).href },
        { enableWorker: false, lazyLoad: true, seekType: "range" },
      );
      p.on(mpegts.Events.ERROR, () => setFailed(true));
      p.attachMediaElement(el);
      p.load();
      if (el.autoplay) void (p.play() as Promise<void> | undefined)?.catch(() => undefined);
      player = p;
    }, () => setFailed(true));
    return () => {
      live = false;
      player?.destroy();
    };
  }, [video, url, enabled]);
  return failed;
}

/** Fills the space it's given from the start, so nothing jumps once the video's size is known. */
function VideoPlayer({
  url,
  name,
  autoPlay = true,
  onLoadedMetadata,
  onTimeUpdate,
}: {
  url: string;
  name: string;
  autoPlay?: boolean;
  onLoadedMetadata?: (video: HTMLVideoElement) => void;
  onTimeUpdate?: (video: HTMLVideoElement) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const stream = isTransportStream(name);
  const streamFailed = useTransportStream(ref, url, stream);
  const [failed, setFailed] = useState(false);
  if (failed || streamFailed) return <Unplayable what="video" />;
  return (
    <video
      ref={ref}
      src={stream ? undefined : url}
      controls
      autoPlay={autoPlay}
      preload="metadata"
      className="block h-full w-full bg-black"
      onError={() => setFailed(true)}
      onLoadedMetadata={(e) => onLoadedMetadata?.(e.currentTarget)}
      onTimeUpdate={(e) => onTimeUpdate?.(e.currentTarget)}
    />
  );
}

/** Videos uploaded before thumbnails existed get one from the first frame
 * watched past the 2 s mark, so it isn't a black title card. */
function VideoPreview({
  drive,
  entry,
  url,
  learn,
}: {
  drive: string;
  entry: Entry;
  url: string;
  learn: (info: FileInfo) => void;
}) {
  const queryClient = useQueryClient();
  const captured = useRef(entry.thumb);
  return (
    <VideoPlayer
      url={url}
      name={entry.name}
      onLoadedMetadata={(video) =>
        learn({
          width: video.videoWidth || undefined,
          height: video.videoHeight || undefined,
          duration: seconds(video.duration),
        })
      }
      onTimeUpdate={(video) => {
        if (captured.current || video.currentTime < Math.min(2, video.duration / 2)) return;
        captured.current = true;
        void sendFrame(drive, entry.id, video).then((sent) => {
          if (sent) void queryClient.invalidateQueries({ queryKey: ["nodes", drive] });
        });
      }}
    />
  );
}

// --- zip -------------------------------------------------------------------

interface ZipFolder {
  dirs: Set<string>;
  files: ZipEntry[];
}

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** Folders by path ("" is the top), including ones only implied by a file's path. */
function buildTree(entries: ZipEntry[]): Map<string, ZipFolder> {
  const tree = new Map<string, ZipFolder>();
  const folder = (path: string): ZipFolder => {
    let f = tree.get(path);
    if (!f) {
      f = { dirs: new Set(), files: [] };
      tree.set(path, f);
      if (path) folder(parentOf(path)).dirs.add(path);
    }
    return f;
  };
  folder("");
  for (const e of entries) {
    if (!e.path) continue;
    if (e.dir) folder(e.path);
    else folder(parentOf(e.path)).files.push(e);
  }
  return tree;
}

const PAGE_TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", bmp: "image/bmp",
};
const pageType = (path: string) => PAGE_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
const isZipVideo = (e: ZipEntry) => !pageType(e.path) && previewKind(baseName(e.path), e.size) === "video";
/** macOS resource forks and dot files, which archivers add and nobody means to look at. */
const junk = (path: string) => /(^|\/)(__MACOSX\/|\.)/.test(path);

/** What the reader steps through, in name order: page images, and videos too if asked. */
function readable(entries: ZipEntry[], videos: boolean): ZipEntry[] {
  return entries
    .filter((e) => !e.dir && !junk(e.path) && (pageType(e.path) || (videos && isZipVideo(e))))
    .sort((a, b) => byName(a.path, b.path));
}

/** Rows drawn at once; a folder with more says so rather than freezing the tab. */
const ZIP_ROWS = 2000;

function ArchivePreview({
  drive,
  entry,
  pager,
  idle,
}: {
  drive: string;
  entry: Entry;
  pager: RefObject<Pager | null>;
  idle: boolean;
}) {
  const url = api.fileUrl(drive, entry.id);
  const listing = useQuery({
    queryKey: ["zip", drive, entry.id],
    queryFn: ({ signal }) => listZip(url, entry.size, signal),
    staleTime: Infinity,
    retry: false,
  });
  const tree = useMemo(() => buildTree(listing.data ?? []), [listing.data]);
  const media = useMemo(() => readable(listing.data ?? [], true), [listing.data]);
  const mediaIndex = useMemo(() => new Map(media.map((e, i) => [e, i])), [media]);
  const [here, setHere] = useState("");
  const [gallery, setGallery] = useState(false);
  const [startAt, setStartAt] = useState<number | undefined>();

  if (listing.isPending) return <p className="text-sm text-white/75">Reading the archive's index…</p>;
  if (listing.error) return <p className="text-sm text-white/75">{listing.error.message}</p>;

  const files = listing.data.filter((e) => !e.dir);
  if (gallery && media.length > 0) {
    return (
      <ZipReader
        drive={drive}
        archive={entry}
        items={media}
        initial={startAt}
        pager={pager}
        idle={idle}
        extra={
          <button
            type="button"
            onClick={() => setGallery(false)}
            aria-label="Show files"
            title="Show files"
            className={DARK_BUTTON}
          >
            <List size={18} />
          </button>
        }
      />
    );
  }

  const total = files.reduce((sum, e) => sum + e.size, 0);
  const packed = files.reduce((sum, e) => sum + e.compressed, 0);
  const folder = tree.get(here) ?? tree.get("")!;
  const dirs = [...folder.dirs].sort(byName);
  const items = [...folder.files].sort((a, b) => byName(a.path, b.path));
  const crumbs = here ? here.split("/") : [];
  const rows = dirs.length + items.length;
  const open = (at?: number) => {
    setStartAt(at);
    setGallery(true);
  };

  return (
    <div className="flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-line bg-paper text-ink">
      <div className="flex items-start gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <nav aria-label="Folder in archive" className="flex flex-wrap items-center gap-1 text-sm">
            <button type="button" className="rounded px-1 py-0.5 hover:bg-ink/5" onClick={() => setHere("")}>
              {entry.name}
            </button>
            {crumbs.map((name, i) => (
              <span key={i} className="flex items-center gap-1">
                <ChevronRight size={14} className="text-muted" aria-hidden="true" />
                <button
                  type="button"
                  className="rounded px-1 py-0.5 hover:bg-ink/5"
                  onClick={() => setHere(crumbs.slice(0, i + 1).join("/"))}
                >
                  {name}
                </button>
              </span>
            ))}
          </nav>
          <p className="mt-1 text-xs text-muted">
            {files.length.toLocaleString()} {files.length === 1 ? "file" : "files"}, {formatSize(total)} unpacked
            {total > 0 && ` (${formatSize(packed)} packed)`}
          </p>
        </div>
        {media.length > 0 && (
          <button
            type="button"
            onClick={() => open()}
            className="inline-flex shrink-0 items-center gap-2 rounded-md border border-line px-3 py-1.5 text-sm hover:bg-ink/5"
          >
            <Images size={16} aria-hidden="true" />
            View {media.length.toLocaleString()} {media.every((e) => !isZipVideo(e)) ? "images" : "items"}
          </button>
        )}
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
        {rows === 0 && <li className="px-4 py-3 text-sm text-muted">This archive is empty.</li>}
        {dirs.slice(0, ZIP_ROWS).map((path) => (
          <li key={path}>
            <button
              type="button"
              onClick={() => setHere(path)}
              className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-ink/5"
            >
              <Folder size={18} className="shrink-0 text-brass" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-medium">{baseName(path)}</span>
            </button>
          </li>
        ))}
        {items.slice(0, Math.max(0, ZIP_ROWS - dirs.length)).map((e) => {
          const at = mediaIndex.get(e) ?? -1;
          const Icon = at < 0 ? FileIcon : isZipVideo(e) ? Film : ImageIcon;
          const row = (
            <>
              <Icon size={18} className="shrink-0 text-muted" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{baseName(e.path)}</span>
              {e.encrypted && <Lock size={14} className="shrink-0 text-muted" aria-label="Password protected" />}
              <span className="hidden w-28 shrink-0 text-right text-muted sm:block">
                {e.modified !== null && formatDate(e.modified)}
              </span>
              <span className="w-20 shrink-0 text-right tabular-nums text-muted">{formatSize(e.size)}</span>
            </>
          );
          return (
            <li key={e.path}>
              {at < 0 ? (
                <div className="flex items-center gap-3 px-4 py-2 text-sm">{row}</div>
              ) : (
                <button
                  type="button"
                  onClick={() => open(at)}
                  className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-ink/5"
                >
                  {row}
                </button>
              )}
            </li>
          );
        })}
        {rows > ZIP_ROWS && (
          <li className="px-4 py-3 text-sm text-muted">
            And {(rows - ZIP_ROWS).toLocaleString()} more. Download the archive to see everything.
          </li>
        )}
      </ul>
    </div>
  );
}

// --- reading a zip: comics, and photos and videos in an archive ---------------

/** Pages read ahead, so turning is instant. */
const READ_AHEAD = 2;
const PAGE_KEY = (id: string) => `tgdrive.page.${id}`;
const MODE_KEY = "tgdrive.readMode";
/** Deflated videos have to be unpacked whole; past this size only when asked. */
const AUTO_UNPACK = 256 * 1024 * 1024;

/** Turns a page (-1 or 1); false at either end, so the viewer moves on to the next file. */
type Pager = (dir: -1 | 1) => boolean;

type ReadMode = "pages" | "scroll" | "strip";
const MODES: { mode: ReadMode; label: string; Icon: typeof RectangleVertical }[] = [
  { mode: "pages", label: "One page at a time", Icon: RectangleVertical },
  { mode: "scroll", label: "Scroll down, with gaps", Icon: StretchHorizontal },
  { mode: "strip", label: "Scroll down, no gaps", Icon: Rows2 },
];

function useReadMode(): [ReadMode, (mode: ReadMode) => void] {
  const [mode, setMode] = useState<ReadMode>(() => {
    try {
      const saved = localStorage.getItem(MODE_KEY);
      return MODES.some((m) => m.mode === saved) ? (saved as ReadMode) : "pages";
    } catch {
      return "pages";
    }
  });
  function change(next: ReadMode) {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      /* private mode: the choice just isn't remembered */
    }
  }
  return [mode, change];
}

const pageQuery = (drive: string, archive: Entry, item: ZipEntry) => ({
  queryKey: ["zipPage", drive, archive.id, item.path],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    readZipEntry(api.fileUrl(drive, archive.id), archive.size, item, pageType(item.path), signal),
  staleTime: Infinity,
  // Pages are a few MB each; only the ones near the reader stay in memory.
  gcTime: 30_000,
  retry: 1,
});

/** An object URL for the blob. The last one stays usable after the blob goes,
 * so a page stays on screen while the next one loads; it is revoked once replaced. */
function useObjectUrl(blob: Blob | null | undefined): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (blob) setSrc(URL.createObjectURL(blob));
  }, [blob]);
  useEffect(() => () => {
    if (src) URL.revokeObjectURL(src);
  }, [src]);
  return src;
}

const Note = ({ children }: { children: ReactNode }) => (
  <p className="px-4 text-center text-sm text-white/75">{children}</p>
);

function ZipImage({
  drive,
  archive,
  item,
  onRatio,
}: {
  drive: string;
  archive: Entry;
  item: ZipEntry;
  onRatio: (ratio: number) => void;
}) {
  const page = useQuery(pageQuery(drive, archive, item));
  const src = useObjectUrl(page.data);
  if (page.error) return <Note>{page.error.message}</Note>;
  if (!src) return <Note>Loading…</Note>;
  return (
    <img
      src={src}
      alt={baseName(item.path)}
      className="block h-full w-full object-contain"
      draggable={false}
      onLoad={(e) => onRatio(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)}
    />
  );
}

/** A video inside a zip. Stored ones (usual for video, which doesn't compress)
 * are a plain slice of the zip, which the server serves as a file of its own,
 * so they stream and seek like any video. Deflated ones are unpacked whole first. */
function ZipVideo({
  drive,
  archive,
  item,
  autoPlay,
  onRatio,
}: {
  drive: string;
  archive: Entry;
  item: ZipEntry;
  autoPlay: boolean;
  onRatio?: (ratio: number) => void;
}) {
  const url = api.fileUrl(drive, archive.id);
  const name = baseName(item.path);
  const readableHere = !item.encrypted && (item.method === 0 || item.method === 8);
  const stored = readableHere && item.method === 0;
  const start = useQuery({
    queryKey: ["zipStart", drive, archive.id, item.path],
    queryFn: ({ signal }) => zipEntryStart(url, item, signal),
    enabled: stored,
    staleTime: Infinity,
    retry: 1,
  });

  const [unpack, setUnpack] = useState(autoPlay && item.compressed <= AUTO_UNPACK);
  const [loaded, setLoaded] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!readableHere || stored || !unpack) return;
    const controller = new AbortController();
    readZipEntry(url, archive.size, item, "", controller.signal, setLoaded).then(setBlob, (e: unknown) => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "The video couldn't be read.");
    });
    return () => controller.abort();
  }, [url, archive.size, item, readableHere, stored, unpack]);
  const blobUrl = useObjectUrl(blob);

  if (item.encrypted) return <Note>This video is password protected.</Note>;
  if (!readableHere) return <Note>This video is compressed in a way the browser can't read.</Note>;
  const failed = error ?? start.error?.message;
  if (failed) return <Note>{failed}</Note>;
  const src = stored
    ? start.data !== undefined && api.fileSliceUrl(drive, archive.id, start.data, item.size, name)
    : blobUrl;
  if (src) {
    return (
      <VideoPlayer
        url={src}
        name={name}
        autoPlay={autoPlay}
        onLoadedMetadata={(v) => v.videoWidth && v.videoHeight && onRatio?.(v.videoWidth / v.videoHeight)}
      />
    );
  }
  if (!stored && !unpack) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setUnpack(true);
        }}
        className="inline-flex items-center gap-2 rounded-md bg-white/10 px-4 py-2 text-sm text-white/90 hover:bg-white/20"
      >
        <Play size={16} aria-hidden="true" />
        Unpack and play ({formatSize(item.compressed)})
      </button>
    );
  }
  return (
    <Note>
      {stored ? "Loading video…" : `Unpacking video… ${formatSize(loaded)} of ${formatSize(item.compressed)}`}
    </Note>
  );
}

/** One page at a time, the next couple read ahead. Tapping either half turns. */
function SinglePage({
  drive,
  archive,
  items,
  current,
  turn,
}: {
  drive: string;
  archive: Entry;
  items: ZipEntry[];
  current: number;
  turn: Pager;
}) {
  const queryClient = useQueryClient();
  const shown = items[current];
  const video = isZipVideo(shown);
  const image = useQuery({ ...pageQuery(drive, archive, shown), enabled: !video });
  const src = useObjectUrl(image.data);

  useEffect(() => {
    // Read ahead only once this page is in, so it never waits behind the next ones.
    if (!video && !image.data) return;
    for (const e of items.slice(current + 1, current + 1 + READ_AHEAD)) {
      if (!isZipVideo(e)) void queryClient.prefetchQuery(pageQuery(drive, archive, e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image.data, video, current, items]);

  if (video) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <ZipVideo key={shown.path} drive={drive} archive={archive} item={shown} autoPlay />
      </div>
    );
  }
  return (
    <div
      className="relative flex h-full w-full cursor-pointer items-center justify-center"
      onClick={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        turn(e.clientX < box.left + box.width / 2 ? -1 : 1);
      }}
    >
      {image.error ? (
        <Note>{image.error.message}</Note>
      ) : src ? (
        <img
          src={src}
          alt={`Page ${current + 1}`}
          className={`max-h-full max-w-full object-contain transition-opacity ${image.isFetching && !image.data ? "opacity-40" : ""}`}
          draggable={false}
        />
      ) : (
        <Note>Loading page…</Note>
      )}
      {image.isPending && src && (
        <span className="absolute rounded-md bg-black/60 px-3 py-1.5 text-sm text-white/90">Loading page…</span>
      )}
    </div>
  );
}

/** How far past the screen pages are loaded while scrolling, in screen heights. */
const SCROLL_AHEAD = "100% 0px";

/** All pages one under another. Only those near the screen are loaded; the
 * rest hold their place at the shape they had, or a guess from the others. */
function ScrollPages({
  drive,
  archive,
  items,
  gaps,
  current,
  onPage,
  scroller,
  boxes,
}: {
  drive: string;
  archive: Entry;
  items: ZipEntry[];
  gaps: boolean;
  current: number;
  onPage: (page: number) => void;
  scroller: RefObject<HTMLDivElement | null>;
  boxes: RefObject<(HTMLDivElement | null)[]>;
}) {
  const [near, setNear] = useState<Set<number>>(() => new Set([current]));
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const frame = useRef(0);
  const guess = Object.values(ratios)[0] ?? (items.every(isZipVideo) ? 16 / 9 : 0.7);

  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (seen) =>
        setNear((was) => {
          const next = new Set(was);
          for (const s of seen) {
            const i = Number((s.target as HTMLElement).dataset.index);
            if (s.isIntersecting) next.add(i);
            else next.delete(i);
          }
          return next;
        }),
      { root, rootMargin: SCROLL_AHEAD },
    );
    for (const box of boxes.current.slice(0, items.length)) if (box) observer.observe(box);
    return () => observer.disconnect();
  }, [scroller, boxes, items]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  /** The page reached is the last one whose top is above a third of the way down, or the last at the bottom. */
  function onScroll() {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const root = scroller.current;
      if (!root) return;
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 2) return onPage(items.length - 1);
      const line = root.getBoundingClientRect().top + root.clientHeight / 3;
      let lo = 0;
      let hi = items.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        const top = boxes.current[mid]?.getBoundingClientRect().top ?? Infinity;
        if (top <= line) lo = mid;
        else hi = mid - 1;
      }
      onPage(lo);
    });
  }

  const remember = (path: string) => (ratio: number) =>
    setRatios((was) => (Number.isFinite(ratio) && ratio > 0 && was[path] !== ratio ? { ...was, [path]: ratio } : was));

  return (
    <div ref={scroller} tabIndex={-1} onScroll={onScroll} className="h-full w-full overflow-y-auto outline-none">
      <div className={`mx-auto flex max-w-3xl flex-col ${gaps ? "gap-3 pb-24" : "pb-20"}`}>
        {items.map((item, i) => (
          <div
            key={item.path}
            ref={(el) => {
              boxes.current[i] = el;
            }}
            data-index={i}
            className="flex w-full shrink-0 items-center justify-center"
            style={{ aspectRatio: ratios[item.path] ?? guess }}
          >
            {near.has(i) &&
              (isZipVideo(item) ? (
                <ZipVideo
                  drive={drive}
                  archive={archive}
                  item={item}
                  autoPlay={false}
                  onRatio={remember(item.path)}
                />
              ) : (
                <ZipImage drive={drive} archive={archive} item={item} onRatio={remember(item.path)} />
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Reads images (and videos) from a zip without fetching it whole: a page at
 * a time, or scrolling down through them all. The place is remembered per file. */
function ZipReader({
  drive,
  archive,
  items,
  initial,
  pager,
  idle,
  extra,
}: {
  drive: string;
  archive: Entry;
  items: ZipEntry[];
  /** Where to open instead of the remembered place. */
  initial?: number;
  pager: RefObject<Pager | null>;
  idle: boolean;
  /** Shown at the start of the controls. */
  extra?: ReactNode;
}) {
  const [mode, setMode] = useReadMode();
  const vertical = mode !== "pages";
  const [page, setPage] = useState(() => {
    if (initial !== undefined) return initial;
    try {
      return Number(localStorage.getItem(PAGE_KEY(archive.id))) || 0;
    } catch {
      return 0;
    }
  });
  const current = Math.min(page, items.length - 1);
  const scroller = useRef<HTMLDivElement>(null);
  const boxes = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    try {
      localStorage.setItem(PAGE_KEY(archive.id), String(current));
    } catch {
      /* private mode: the place just isn't remembered */
    }
  }, [archive.id, current]);

  // Switching to scrolling starts where the reader was, with the keyboard scrolling it.
  useLayoutEffect(() => {
    if (!vertical) return;
    boxes.current[current]?.scrollIntoView({ block: "start" });
    scroller.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  function jump(to: number) {
    setPage(to);
    if (vertical) boxes.current[to]?.scrollIntoView({ block: "start" });
  }
  const turn = (dir: -1 | 1) => {
    const to = current + dir;
    if (to < 0 || to >= items.length) return false;
    jump(to);
    return true;
  };
  useEffect(() => {
    pager.current = turn;
    return () => {
      pager.current = null;
    };
  });

  return (
    <div className="relative h-full w-full">
      {vertical ? (
        <ScrollPages
          drive={drive}
          archive={archive}
          items={items}
          gaps={mode === "scroll"}
          current={current}
          onPage={setPage}
          scroller={scroller}
          boxes={boxes}
        />
      ) : (
        <SinglePage drive={drive} archive={archive} items={items} current={current} turn={turn} />
      )}
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-linear-to-t from-black/80 to-transparent px-2 pb-2 pt-10 ${fade(idle)}`}
      >
        <div
          data-control
          className={`flex w-full max-w-2xl items-center gap-1 text-sm text-white/75 sm:gap-2 ${idle ? "" : "pointer-events-auto"}`}
        >
          {extra}
          <button
            type="button"
            onClick={() => turn(-1)}
            disabled={current === 0}
            aria-label="Previous page"
            className={`${DARK_BUTTON} hidden disabled:opacity-30 sm:inline-flex`}
          >
            <ChevronLeft size={18} />
          </button>
          <input
            type="range"
            min={1}
            max={items.length}
            value={current + 1}
            onChange={(e) => jump(Number(e.target.value) - 1)}
            aria-label="Page"
            className="min-w-0 flex-1 accent-[var(--teal)]"
          />
          <span className="w-20 shrink-0 text-center tabular-nums">
            {current + 1} / {items.length}
          </span>
          <button
            type="button"
            onClick={() => turn(1)}
            disabled={current === items.length - 1}
            aria-label="Next page"
            className={`${DARK_BUTTON} hidden disabled:opacity-30 sm:inline-flex`}
          >
            <ChevronRight size={18} />
          </button>
          <div role="group" aria-label="Reading mode" className="flex shrink-0 border-l border-white/15 pl-1 sm:pl-2">
            {MODES.map(({ mode: m, label, Icon }) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                aria-label={label}
                title={label}
                className={`${DARK_BUTTON} ${mode === m ? "bg-white/15 text-white" : ""}`}
              >
                <Icon size={18} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A .cbz: the zip's index, then its page images. */
function ComicPreview({
  drive,
  entry,
  pager,
  idle,
}: {
  drive: string;
  entry: Entry;
  pager: RefObject<Pager | null>;
  idle: boolean;
}) {
  const listing = useQuery({
    queryKey: ["zip", drive, entry.id],
    queryFn: ({ signal }) => listZip(api.fileUrl(drive, entry.id), entry.size, signal),
    staleTime: Infinity,
    retry: false,
  });
  const pages = useMemo(() => readable(listing.data ?? [], false), [listing.data]);

  if (listing.isPending) return <p className="text-sm text-white/75">Reading the comic's index…</p>;
  if (listing.error) return <p className="text-sm text-white/75">{listing.error.message}</p>;
  if (pages.length === 0) return <p className="text-sm text-white/75">There are no pages in this file.</p>;
  return <ZipReader drive={drive} archive={entry} items={pages} pager={pager} idle={idle} />;
}

// --- the viewer --------------------------------------------------------------

/** Controls fade out this long after the pointer last moved, unless it rests on one. */
const IDLE_MS = 2500;
const fade = (idle: boolean) => `transition-opacity duration-300 ${idle ? "pointer-events-none opacity-0" : ""}`;

function useIdle(root: RefObject<HTMLElement | null>): [boolean, () => void] {
  const [idle, setIdle] = useState(false);
  const timer = useRef(0);
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(timer.current);
    const check = () => {
      if (root.current?.querySelector("[data-control]:hover, [data-control]:focus-visible, [data-control] :focus-visible")) {
        timer.current = window.setTimeout(check, IDLE_MS);
      } else {
        setIdle(true);
      }
    };
    timer.current = window.setTimeout(check, IDLE_MS);
  }, [root]);
  useEffect(() => {
    wake();
    return () => window.clearTimeout(timer.current);
  }, [wake]);
  return [idle, wake];
}

/** What fills the stage for one file. Keyed by file, so each starts afresh. */
function Stage({
  drive,
  entry,
  pager,
  idle,
}: {
  drive: string;
  entry: Entry;
  pager: RefObject<Pager | null>;
  idle: boolean;
}) {
  const kind = previewKind(entry.name, entry.size);
  const inlineUrl = api.fileUrl(drive, entry.id, true);
  // The browser is loading the file to show it anyway, so what it finds out is kept.
  const learn = useLearn(drive, entry.id);
  const [failed, setFailed] = useState(false);

  if (kind === "image") {
    if (failed) return <Unplayable what="image" />;
    return (
      <img
        src={inlineUrl}
        alt={entry.name}
        className="max-h-full max-w-full object-contain"
        onError={() => setFailed(true)}
        onLoad={(e) => learn({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
      />
    );
  }
  if (kind === "video") return <VideoPreview drive={drive} entry={entry} url={inlineUrl} learn={learn} />;
  if (kind === "audio") {
    if (failed) return <Unplayable what="audio file" />;
    return (
      <div className="flex w-full max-w-lg flex-col items-center gap-6">
        <Music size={72} className="text-white/40" aria-hidden="true" />
        <audio
          src={inlineUrl}
          controls
          autoPlay
          className="w-full"
          onError={() => setFailed(true)}
          onLoadedMetadata={(e) => learn({ duration: seconds(e.currentTarget.duration) })}
        />
      </div>
    );
  }
  if (kind === "pdf") return <iframe src={inlineUrl} title={entry.name} className="h-full w-full max-w-5xl bg-white" />;
  if (kind === "text") return <TextPreview url={api.fileUrl(drive, entry.id)} size={entry.size} />;
  if (kind === "archive") return <ArchivePreview drive={drive} entry={entry} pager={pager} idle={idle} />;
  if (kind === "comic") return <ComicPreview drive={drive} entry={entry} pager={pager} idle={idle} />;
  return <Unplayable what="file" />;
}

const typing = (target: EventTarget) =>
  target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLMediaElement;

/** Full-window viewer, stepping through the files in `entries` it can show. */
export function Viewer({
  drive,
  entries,
  start,
  locationOf,
  onClose,
}: {
  drive: string;
  entries: Entry[];
  start: Entry;
  locationOf: (entry: Entry) => string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [entry, setEntry] = useState(start);
  const [showInfo, setShowInfo] = useSavedFlag(INFO_KEY);
  const swipe = useRef<number | null>(null);
  /** Set while a comic is open: arrows turn its pages before moving between files. */
  const pager = useRef<Pager | null>(null);
  const [idle, wake] = useIdle(ref);

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);

  const items = entries.filter((e) => e.kind === "file" && previewKind(e.name, e.size));
  const index = items.findIndex((e) => e.id === entry.id);
  // A file deleted or renamed meanwhile stays on screen; stepping goes on from where it was.
  const prev = index > 0 ? items[index - 1] : null;
  const next = index >= 0 && index < items.length - 1 ? items[index + 1] : null;

  function step(dir: -1 | 1) {
    if (pager.current?.(dir)) return;
    const to = dir < 0 ? prev : next;
    if (to) setEntry(to);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Tab") wake();
    if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "i") setShowInfo(!showInfo);
    else return;
    e.preventDefault();
  }

  // A horizontal swipe on a touch screen steps, as photo apps do.
  function onPointerDown(e: PointerEvent) {
    swipe.current = e.pointerType === "touch" ? e.clientX : null;
  }
  function onPointerUp(e: PointerEvent) {
    if (swipe.current === null) return;
    const dx = e.clientX - swipe.current;
    swipe.current = null;
    if (dx > 60) step(-1);
    else if (dx < -60) step(1);
  }

  const kind = previewKind(entry.name, entry.size);
  const swipeable = kind === "image" || kind === "audio" || kind === "comic" || kind === "archive";
  const arrow = `absolute top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white/80 hover:bg-black/70 hover:text-white ${fade(idle)}`;

  return (
    <dialog
      ref={ref}
      aria-label={entry.name}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={onKeyDown}
      onPointerMove={wake}
      onPointerDown={wake}
      className="m-0 h-dvh max-h-none w-dvw max-w-none flex-col bg-neutral-950 open:flex p-0 text-white backdrop:bg-black"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2">
        <div className="min-w-0 flex-1 pl-1">
          <h2 className="truncate text-sm font-medium">{entry.name}</h2>
          <p className="text-xs text-white/60">
            {formatSize(entry.size)}
            {index >= 0 && items.length > 1 && ` · ${index + 1} of ${items.length}`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowInfo(!showInfo)}
          aria-pressed={showInfo}
          aria-label="Details"
          title="Details (i)"
          className={`${DARK_BUTTON} ${showInfo ? "bg-white/15 text-white" : ""}`}
        >
          <Info size={18} />
        </button>
        <a
          href={api.fileUrl(drive, entry.id)}
          download={entry.name}
          aria-label="Download"
          title="Download"
          className={DARK_BUTTON}
        >
          <Download size={18} />
        </a>
        <button type="button" onClick={onClose} aria-label="Close" title="Close (Esc)" className={DARK_BUTTON}>
          <X size={20} />
        </button>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <div
          className="relative flex min-w-0 flex-1 items-center justify-center p-2 sm:px-16 sm:py-4"
          onPointerDown={swipeable ? onPointerDown : undefined}
          onPointerUp={swipeable ? onPointerUp : undefined}
        >
          <Stage key={entry.id} drive={drive} entry={entry} pager={pager} idle={idle} />
          {prev && (
            <button
              type="button"
              data-control
              onClick={() => setEntry(prev)}
              aria-label={`Previous: ${prev.name}`}
              title="Previous (←)"
              className={`${arrow} left-2`}
            >
              <ChevronLeft size={24} />
            </button>
          )}
          {next && (
            <button
              type="button"
              data-control
              onClick={() => setEntry(next)}
              aria-label={`Next: ${next.name}`}
              title="Next (→)"
              className={`${arrow} right-2`}
            >
              <ChevronRight size={24} />
            </button>
          )}
        </div>
        {showInfo && (
          <aside
            aria-label="Details"
            className="absolute inset-y-0 right-0 z-10 w-80 max-w-full overflow-y-auto border-l border-line bg-paper px-5 py-5 text-ink lg:static"
          >
            <EntryDetails drive={drive} entry={entry} location={locationOf(entry)} />
          </aside>
        )}
      </div>
    </dialog>
  );
}
