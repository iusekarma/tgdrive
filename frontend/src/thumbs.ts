import { useSyncExternalStore } from "react";

import { api, type Entry, type FileInfo } from "./api";
import { readExif, seconds } from "./fileinfo";
import { previewKind } from "./format";
import { comicPages, listZip, pageType, readZipEntry, type ZipSource } from "./zip";

/** Matches the server: larger images are not fetched from Telegram just to thumbnail them. */
const SERVER_SOURCE_MAX = 50 * 1024 * 1024;
const SIZE = 320;
/** Thumbnails that are still being made hold a connection, and the browser has
 * six. At most this many for showing and for making them, and in all. */
const PARALLEL = { show: 3, make: 3 };
const PARALLEL_ALL = 5;
/** How many files makeThumbnail() can usefully work on at once. */
export const MAKE_PARALLEL = PARALLEL.make;

/** Whether asking the server for a thumbnail can succeed. */
export function hasThumbnail(entry: Entry): boolean {
  if (entry.kind !== "file") return false;
  return entry.thumb || (previewKind(entry.name, entry.size) === "image" && entry.size <= SERVER_SOURCE_MAX);
}

// --- loading -----------------------------------------------------------------

// Object URLs for this tab only. The server sends thumbnails with no-store,
// so decrypted previews never land in the browser's disk cache.
const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();
// Thumbnails this tab is making from a just-uploaded file. Asking the server
// meanwhile would have it fetch the whole file back from Telegram to make one.
const making = new Map<string, Promise<void>>();
// Audio files found to have no cover art, so they aren't fetched again to look.
const coverless = new Set<string>();

type Lane = keyof typeof PARALLEL;
const active: Record<Lane, number> = { show: 0, make: 0 };
const waiting: Record<Lane, (() => void)[]> = { show: [], make: [] };

const key = (drive: string, id: string) => `${drive}\n${id}`;

/** Lets in whoever there is room for; showing goes before making. */
function admit() {
  for (const lane of ["show", "make"] as const) {
    while (waiting[lane].length && active[lane] < PARALLEL[lane] && active.show + active.make < PARALLEL_ALL) {
      active[lane] += 1;
      waiting[lane].shift()?.();
    }
  }
}

async function slot<T>(lane: Lane, work: () => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => {
    waiting[lane].push(resolve);
    admit();
  });
  try {
    return await work();
  } finally {
    active[lane] -= 1;
    admit();
  }
}

export function cachedThumbnail(drive: string, id: string): string | null | undefined {
  return cache.get(key(drive, id));
}

// Bumped when a thumbnail changes under a component already showing one.
const versions = new Map<string, number>();
const listeners = new Set<() => void>();

function changed(k: string) {
  versions.set(k, (versions.get(k) ?? 0) + 1);
  for (const listener of listeners) listener();
}

/** Changes when this file's thumbnail is replaced, so whatever shows it loads it again. */
export function useThumbnailVersion(drive: string, id: string): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => versions.get(key(drive, id)) ?? 0,
  );
}

/** Resolves to an object URL, or null when there is no thumbnail. */
export async function loadThumbnail(drive: string, id: string, lane: Lane = "show"): Promise<string | null> {
  const k = key(drive, id);
  await making.get(k);
  if (cache.has(k)) return Promise.resolve(cache.get(k) ?? null);
  let job = pending.get(k);
  if (!job) {
    job = slot(lane, async () => {
      const res = await fetch(api.thumbnailUrl(drive, id));
      if (res.ok) return URL.createObjectURL(await res.blob());
      return res.status === 404 ? null : undefined;
    })
      .catch(() => undefined)
      .then((url) => {
        pending.delete(k);
        // 404 means "none" and is remembered; other failures are retried next time.
        if (url !== undefined) cache.set(k, url);
        return url ?? null;
      });
    pending.set(k, job);
  }
  return job;
}

function remember(drive: string, id: string, image: Blob) {
  const k = key(drive, id);
  const old = cache.get(k);
  if (old) URL.revokeObjectURL(old);
  cache.set(k, URL.createObjectURL(image));
  changed(k);
}

function forget(k: string) {
  const old = cache.get(k);
  if (old) URL.revokeObjectURL(old);
  cache.delete(k);
}

/** Drop decrypted thumbnails from memory, for one drive or all of them. */
export function forgetThumbnails(drive?: string) {
  for (const k of [...cache.keys()]) {
    if (drive === undefined || k.startsWith(`${drive}\n`)) forget(k);
  }
}

// --- making them in the browser ----------------------------------------------

function toBlob(source: CanvasImageSource, width: number, height: number): Promise<Blob | null> {
  const scale = Math.min(1, SIZE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  // Browsers that can't encode WebP fall back to PNG; the server re-encodes either way.
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.8));
}

/** A thumbnail (when one can be drawn) and what was learned while decoding. */
type Look = { image: Blob | null; info: FileInfo };

async function fromImage(file: Blob): Promise<Look> {
  const bitmap = await createImageBitmap(file);
  try {
    const info = { width: bitmap.width, height: bitmap.height, ...(await readExif(file)) };
    return { image: await toBlob(bitmap, bitmap.width, bitmap.height), info };
  } finally {
    bitmap.close();
  }
}

/** A comic's cover: its first page, read from the zip without fetching the
 * rest. `index` is where to read the zip's index, if not from `source`. */
async function fromComic(
  source: ZipSource,
  size: number,
  signal?: AbortSignal,
  index: ZipSource = source,
): Promise<Blob | null> {
  const [first] = comicPages(await listZip(index, size, signal));
  if (!first) return null;
  const page = await readZipEntry(source, size, first, pageType(first.path), signal);
  return (await fromImage(page)).image;
}

/** The cover art inside an audio file (album art), or null if it has none that can be drawn. */
async function fromCover(source: Blob | string, size: number, signal?: AbortSignal): Promise<Blob | null> {
  // Mediabunny is large, and only needed here and by the player.
  const { coverArt } = await import("./player/cover");
  for (const picture of await coverArt(source, size, signal)) {
    const image = await fromImage(picture).then((look) => look.image, () => null);
    if (image) return image;
  }
  return null;
}

/** Draws the frame the video element is showing. */
function captureFrame(video: HTMLVideoElement): Promise<Blob | null> {
  if (!video.videoWidth || !video.videoHeight) return Promise.resolve(null);
  return toBlob(video, video.videoWidth, video.videoHeight);
}

/** Where a video's thumbnail is taken: a tenth of the way in, but at least
 * 3 s and at most 3 min, so it's a real scene rather than a black title card
 * or a logo. Never past halfway, for short clips. */
export function frameTime(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(Math.max(duration * 0.1, 3), 180, duration / 2);
}

/** Loads media (a local copy, or a URL on this server) far enough to answer
 * `read`, then lets it go. */
function fromMedia(
  source: Blob | string,
  tag: "video" | "audio",
  read: (media: HTMLMediaElement, done: (look: Look) => void, info: FileInfo) => void,
  signal?: AbortSignal,
): Promise<Look> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ image: null, info: {} });
    const local = typeof source !== "string";
    const url = local ? URL.createObjectURL(source) : source;
    const media = document.createElement(tag);
    const info: FileInfo = {};
    const done = (look: Look) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      media.removeAttribute("src");
      media.load();
      if (local) URL.revokeObjectURL(url);
      resolve(look);
    };
    // From the server, the frame may first have to come from Telegram.
    const timer = setTimeout(() => done({ image: null, info }), local ? 15_000 : 45_000);
    const stop = () => done({ image: null, info });
    signal?.addEventListener("abort", stop);
    media.muted = true;
    // From the server, only what the seek needs: each byte read may first come from Telegram.
    media.preload = tag === "video" && local ? "auto" : "metadata";
    media.onerror = () => done({ image: null, info });
    read(media, done, info);
    media.src = url;
  });
}

/** Seeks to frameTime() and draws that frame. */
const fromVideo = (source: Blob | string, signal?: AbortSignal) =>
  fromMedia(source, "video", (media, done, info) => {
    const video = media as HTMLVideoElement;
    video.onloadedmetadata = () => {
      Object.assign(info, { width: video.videoWidth || undefined, height: video.videoHeight || undefined });
      info.duration = seconds(video.duration);
      video.currentTime = frameTime(video.duration);
    };
    video.onseeked = () =>
      void captureFrame(video).then(
        (image) => done({ image, info }),
        () => done({ image: null, info }),
      );
  }, signal);

const audioInfo = (file: Blob) =>
  fromMedia(file, "audio", (audio, done, info) => {
    audio.onloadedmetadata = () => {
      info.duration = seconds(audio.duration);
      done({ image: null, info });
    };
  });

/** Audio from a local copy: its length, and its cover art if it has any. */
async function fromAudio(file: Blob): Promise<Look & { coverless: boolean }> {
  const [{ info }, cover] = await Promise.all([
    audioInfo(file),
    fromCover(file, file.size).catch(() => undefined),
  ]);
  return { image: cover ?? null, info, coverless: cover === null };
}

/** Whether the file was looked at and has nothing to make a thumbnail from. */
export const hasNoCover = (drive: string, id: string) => coverless.has(key(drive, id));

/** Made from the local copy right after an upload, so Telegram is never asked
 * for the file: a thumbnail for images, videos, comics and audio with cover art, and details (dimensions,
 * duration, when it was taken) for anything. Best effort: formats the browser
 * can't decode get neither. Returns the details as the server now has them. */
export async function sendDetails(
  drive: string,
  id: string,
  file: File,
): Promise<{ thumb: boolean; info: FileInfo | null }> {
  const kind = previewKind(file.name, file.size);
  const k = key(drive, id);
  let made = () => {};
  if (kind === "image" || kind === "video" || kind === "comic") making.set(k, new Promise<void>((resolve) => (made = resolve)));
  let look: Look = { image: null, info: {} };
  let thumb = false;
  try {
    try {
      if (kind === "image") look = await fromImage(file);
      else if (kind === "video") look = await fromVideo(file);
      else if (kind === "audio") {
        const audio = await fromAudio(file);
        if (audio.coverless) coverless.add(k);
        look = audio;
      }
      else if (kind === "comic") look = { image: await fromComic(file, file.size), info: {} };
    } catch {
      // Not decodable here; the file's own date is still worth keeping.
    }
    if (look.image) {
      try {
        await api.putThumbnail(drive, id, look.image);
        remember(drive, id, look.image);
        thumb = true;
      } catch {
        /* shown as an icon */
      }
    }
  } finally {
    // Without one, the server may still manage (an image this browser can't decode).
    making.delete(k);
    made();
  }
  const fields = { ...look.info, modified: Math.floor(file.lastModified / 1000) };
  const info = await api.putFileInfo(drive, id, fields).catch(() => null);
  return { thumb, info };
}

async function send(drive: string, id: string, image: Blob | null): Promise<boolean> {
  if (!image) return false;
  try {
    await api.putThumbnail(drive, id, image);
    remember(drive, id, image);
    return true;
  } catch {
    return false;
  }
}

/** For a file opened in the viewer without a thumbnail: saves one from the
 * image being shown. */
export function sendPicture(drive: string, id: string, img: HTMLImageElement): Promise<boolean> {
  if (!img.naturalWidth || !img.naturalHeight) return Promise.resolve(false);
  return toBlob(img, img.naturalWidth, img.naturalHeight).then((image) => send(drive, id, image), () => false);
}

/** Saves the frame a video element is showing (one the browser can only play
 * through mpegts.js, which a second element can't seek on its own). */
export function sendFrame(drive: string, id: string, video: HTMLVideoElement): Promise<boolean> {
  return captureFrame(video).then((image) => send(drive, id, image), () => false);
}

/** Saves a frame frameTime() into a video on the server, read with a second,
 * hidden player, so it doesn't matter where the one being watched is. */
export function sendVideoFrame(drive: string, id: string): Promise<boolean> {
  return fromVideo(api.fileUrl(drive, id, true)).then((look) => send(drive, id, look.image), () => false);
}

/** Throws the file's thumbnail away and makes a new one, as makeThumbnail()
 * does: images up to 50 MB on the server, which fetches the file itself, so
 * the browser downloads nothing; anything else here. Resolves to
 * whether there is one now. */
export async function regenerateThumbnail(drive: string, entry: Entry): Promise<boolean> {
  const k = key(drive, entry.id);
  try {
    await api.deleteThumbnail(drive, entry.id);
  } catch {
    return false;
  }
  forget(k);
  try {
    return await makeThumbnail(drive, { ...entry, thumb: false }, new AbortController().signal);
  } finally {
    changed(k);   // whatever shows it loads the new one, or the icon
  }
}

/** For a file that has no thumbnail: images the server can thumbnail are left
 * to it, so the browser doesn't download them; larger ones, videos, comics and
 * audio are drawn here from the server's copy (a video only as far as the
 * frame, a comic only its index and first page, audio only its tags).
 * Resolves to whether there is one now; if not, hasNoCover() says whether that
 * is because the file has none. Stops early when `signal` aborts. */
export async function makeThumbnail(drive: string, entry: Entry, signal: AbortSignal): Promise<boolean> {
  const kind = previewKind(entry.name, entry.size);
  if (kind === "image" && entry.size <= SERVER_SOURCE_MAX) {
    return (await loadThumbnail(drive, entry.id, "make")) !== null;
  }
  return slot("make", async () => {
    if (signal.aborted) return false;
    let image: Blob | null = null;
    try {
      const url = api.fileUrl(drive, entry.id);
      const inline = api.fileUrl(drive, entry.id, true);
      if (kind === "image") {
        const res = await fetch(inline, { signal });
        if (res.ok) image = (await fromImage(await res.blob())).image;
      } else if (kind === "video") {
        image = (await fromVideo(inline, signal)).image;
      } else if (kind === "comic") {
        // The index is at the end and the first page usually at the start: have the server fetch both at once.
        image = await fromComic(url, entry.size, signal, api.fileUrlAhead(drive, entry.id, 0));
      } else if (kind === "audio") {
        image = await fromCover(url, entry.size, signal);
        if (!image) coverless.add(key(drive, entry.id));
      }
    } catch {
      return false;   // not decodable here, or stopped
    }
    return !signal.aborted && send(drive, entry.id, image);
  });
}
