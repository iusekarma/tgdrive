import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download, File as FileIcon, Folder, Info, Lock, Music, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

import { api, type Entry, type FileInfo } from "../api";
import { seconds, useLearn } from "../fileinfo";
import { formatDate, formatSize, isTransportStream, previewKind } from "../format";
import { sendFrame } from "../thumbs";
import { listZip, readZipEntry, type ZipEntry } from "../zip";
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
      void (p.play() as Promise<void> | undefined)?.catch(() => undefined);
      player = p;
    }, () => setFailed(true));
    return () => {
      live = false;
      player?.destroy();
    };
  }, [video, url, enabled]);
  return failed;
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
  const ref = useRef<HTMLVideoElement>(null);
  const stream = isTransportStream(entry.name);
  const streamFailed = useTransportStream(ref, url, stream);
  const [failed, setFailed] = useState(false);
  if (failed || streamFailed) return <Unplayable what="video" />;
  return (
    <video
      ref={ref}
      src={stream ? undefined : url}
      controls
      autoPlay
      className="max-h-full max-w-full bg-black"
      onError={() => setFailed(true)}
      onLoadedMetadata={(e) => {
        const video = e.currentTarget;
        learn({
          width: video.videoWidth || undefined,
          height: video.videoHeight || undefined,
          duration: seconds(video.duration),
        });
      }}
      onTimeUpdate={(e) => {
        const video = e.currentTarget;
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

/** Rows drawn at once; a folder with more says so rather than freezing the tab. */
const ZIP_ROWS = 2000;

function ArchivePreview({ drive, entry }: { drive: string; entry: Entry }) {
  const url = api.fileUrl(drive, entry.id);
  const listing = useQuery({
    queryKey: ["zip", drive, entry.id],
    queryFn: ({ signal }) => listZip(url, entry.size, signal),
    staleTime: Infinity,
    retry: false,
  });
  const tree = useMemo(() => buildTree(listing.data ?? []), [listing.data]);
  const [here, setHere] = useState("");

  if (listing.isPending) return <p className="text-sm text-white/75">Reading the archive's index…</p>;
  if (listing.error) return <p className="text-sm text-white/75">{listing.error.message}</p>;

  const files = listing.data.filter((e) => !e.dir);
  const total = files.reduce((sum, e) => sum + e.size, 0);
  const packed = files.reduce((sum, e) => sum + e.compressed, 0);
  const folder = tree.get(here) ?? tree.get("")!;
  const dirs = [...folder.dirs].sort(byName);
  const items = [...folder.files].sort((a, b) => byName(a.path, b.path));
  const crumbs = here ? here.split("/") : [];
  const rows = dirs.length + items.length;

  return (
    <div className="flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-line bg-paper text-ink">
      <div className="border-b border-line px-4 py-3">
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
        {items.slice(0, Math.max(0, ZIP_ROWS - dirs.length)).map((e) => (
          <li key={e.path} className="flex items-center gap-3 px-4 py-2 text-sm">
            <FileIcon size={18} className="shrink-0 text-muted" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{baseName(e.path)}</span>
            {e.encrypted && <Lock size={14} className="shrink-0 text-muted" aria-label="Password protected" />}
            <span className="hidden w-28 shrink-0 text-right text-muted sm:block">
              {e.modified !== null && formatDate(e.modified)}
            </span>
            <span className="w-20 shrink-0 text-right tabular-nums text-muted">{formatSize(e.size)}</span>
          </li>
        ))}
        {rows > ZIP_ROWS && (
          <li className="px-4 py-3 text-sm text-muted">
            And {(rows - ZIP_ROWS).toLocaleString()} more. Download the archive to see everything.
          </li>
        )}
      </ul>
    </div>
  );
}

// --- comics ------------------------------------------------------------------

const PAGE_TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", bmp: "image/bmp",
};
const pageType = (path: string) => PAGE_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
/** Pages read ahead, so turning is instant. */
const READ_AHEAD = 2;
const PAGE_KEY = (id: string) => `tgdrive.page.${id}`;

/** Turns a page (-1 or 1); false at either end, so the viewer moves on to the next file. */
type Pager = (dir: -1 | 1) => boolean;

/** Reads a .cbz a page at a time: the zip's index, then one range request per
 * page, a couple ahead of the one on screen. The file is never fetched whole. */
function ComicPreview({ drive, entry, pager }: { drive: string; entry: Entry; pager: RefObject<Pager | null> }) {
  const queryClient = useQueryClient();
  const url = api.fileUrl(drive, entry.id);
  const listing = useQuery({
    queryKey: ["zip", drive, entry.id],
    queryFn: ({ signal }) => listZip(url, entry.size, signal),
    staleTime: Infinity,
    retry: false,
  });
  const pages = useMemo(
    () =>
      (listing.data ?? [])
        .filter((e) => !e.dir && pageType(e.path) && !/(^|\/)(__MACOSX\/|\.)/.test(e.path))
        .sort((a, b) => byName(a.path, b.path)),
    [listing.data],
  );
  const [page, setPage] = useState(() => {
    try {
      return Number(localStorage.getItem(PAGE_KEY(entry.id))) || 0;
    } catch {
      return 0;
    }
  });
  const current = Math.min(page, Math.max(0, pages.length - 1));

  const pageQuery = (e: ZipEntry) => ({
    queryKey: ["comicPage", drive, entry.id, e.path],
    queryFn: ({ signal }: { signal: AbortSignal }) => readZipEntry(url, entry.size, e, pageType(e.path), signal),
    staleTime: Infinity,
    // Pages are a few MB each; only the ones near the reader stay in memory.
    gcTime: 30_000,
    retry: 1,
  });
  const shown = pages[current] as ZipEntry | undefined;
  const image = useQuery({
    ...pageQuery(shown ?? ({ path: "" } as ZipEntry)),
    enabled: shown !== undefined,
  });
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!image.data) return;
    const u = URL.createObjectURL(image.data);
    setSrc(u);
    return () => URL.revokeObjectURL(u);
  }, [image.data]);

  useEffect(() => {
    // Read ahead only once this page is in, so it never waits behind the next ones.
    if (!image.data) return;
    for (const e of pages.slice(current + 1, current + 1 + READ_AHEAD)) void queryClient.prefetchQuery(pageQuery(e));
    try {
      localStorage.setItem(PAGE_KEY(entry.id), String(current));
    } catch {
      /* private mode: the place just isn't remembered */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image.data, current, pages]);

  const turn = (dir: -1 | 1) => {
    const to = current + dir;
    if (to < 0 || to >= pages.length) return false;
    setPage(to);
    return true;
  };
  useEffect(() => {
    pager.current = turn;
    return () => {
      pager.current = null;
    };
  });

  if (listing.isPending) return <p className="text-sm text-white/75">Reading the comic's index…</p>;
  if (listing.error) return <p className="text-sm text-white/75">{listing.error.message}</p>;
  if (pages.length === 0) return <p className="text-sm text-white/75">There are no pages in this file.</p>;

  return (
    <div className="flex h-full w-full flex-col items-center gap-3">
      <div
        className="relative flex min-h-0 w-full flex-1 cursor-pointer items-center justify-center"
        // Tapping the left or right half turns the page, as reading apps do.
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          turn(e.clientX < box.left + box.width / 2 ? -1 : 1);
        }}
      >
        {image.error ? (
          <p className="text-sm text-white/75">{image.error.message}</p>
        ) : src ? (
          <img
            src={src}
            alt={`Page ${current + 1}`}
            className={`max-h-full max-w-full object-contain transition-opacity ${image.isFetching && !image.data ? "opacity-40" : ""}`}
            draggable={false}
          />
        ) : (
          <p className="text-sm text-white/75">Loading page…</p>
        )}
        {image.isPending && src && (
          <span className="absolute rounded-md bg-black/60 px-3 py-1.5 text-sm text-white/90">Loading page…</span>
        )}
      </div>
      <div className="flex w-full max-w-xl shrink-0 items-center gap-3 text-sm text-white/75">
        <button
          type="button"
          onClick={() => turn(-1)}
          disabled={current === 0}
          aria-label="Previous page"
          className={`${DARK_BUTTON} disabled:opacity-30`}
        >
          <ChevronLeft size={18} />
        </button>
        <input
          type="range"
          min={1}
          max={pages.length}
          value={current + 1}
          onChange={(e) => setPage(Number(e.target.value) - 1)}
          aria-label="Page"
          className="min-w-0 flex-1 accent-[var(--teal)]"
        />
        <span className="w-20 shrink-0 text-center tabular-nums">
          {current + 1} / {pages.length}
        </span>
        <button
          type="button"
          onClick={() => turn(1)}
          disabled={current === pages.length - 1}
          aria-label="Next page"
          className={`${DARK_BUTTON} disabled:opacity-30`}
        >
          <ChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}

// --- the viewer --------------------------------------------------------------

/** What fills the stage for one file. Keyed by file, so each starts afresh. */
function Stage({ drive, entry, pager }: { drive: string; entry: Entry; pager: RefObject<Pager | null> }) {
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
  if (kind === "archive") return <ArchivePreview drive={drive} entry={entry} />;
  if (kind === "comic") return <ComicPreview drive={drive} entry={entry} pager={pager} />;
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
  const swipeable = kind === "image" || kind === "audio" || kind === "comic";

  return (
    <dialog
      ref={ref}
      aria-label={entry.name}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={onKeyDown}
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
          <Stage key={entry.id} drive={drive} entry={entry} pager={pager} />
          {prev && (
            <button
              type="button"
              onClick={() => setEntry(prev)}
              aria-label={`Previous: ${prev.name}`}
              title="Previous (←)"
              className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white/80 hover:bg-black/70 hover:text-white"
            >
              <ChevronLeft size={24} />
            </button>
          )}
          {next && (
            <button
              type="button"
              onClick={() => setEntry(next)}
              aria-label={`Next: ${next.name}`}
              title="Next (→)"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white/80 hover:bg-black/70 hover:text-white"
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
