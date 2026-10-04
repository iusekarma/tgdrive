import { api, type Entry } from "./api";
import { previewKind } from "./format";

/** Matches the server: larger images are not fetched from Telegram just to thumbnail them. */
const SERVER_SOURCE_MAX = 50 * 1024 * 1024;
const SIZE = 320;
/** Thumbnails that are still being made hold a connection; keep most of the browser's six free. */
const PARALLEL = 3;

/** Whether asking the server for a thumbnail can succeed. */
export function hasThumbnail(entry: Entry): boolean {
  if (entry.kind !== "file") return false;
  return entry.thumb || (previewKind(entry.name) === "image" && entry.size <= SERVER_SOURCE_MAX);
}

// --- loading -----------------------------------------------------------------

// Object URLs for this tab only. The server sends thumbnails with no-store,
// so decrypted previews never land in the browser's disk cache.
const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();
let active = 0;
const waiting: (() => void)[] = [];

const key = (drive: string, id: string) => `${drive}\n${id}`;

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await work();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

export function cachedThumbnail(drive: string, id: string): string | null | undefined {
  return cache.get(key(drive, id));
}

/** Resolves to an object URL, or null when there is no thumbnail. */
export function loadThumbnail(drive: string, id: string): Promise<string | null> {
  const k = key(drive, id);
  if (cache.has(k)) return Promise.resolve(cache.get(k) ?? null);
  let job = pending.get(k);
  if (!job) {
    job = slot(async () => {
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
}

/** Drop decrypted thumbnails from memory, for one drive or all of them. */
export function forgetThumbnails(drive?: string) {
  for (const [k, url] of cache) {
    if (drive !== undefined && !k.startsWith(`${drive}\n`)) continue;
    if (url) URL.revokeObjectURL(url);
    cache.delete(k);
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

async function fromImage(file: Blob): Promise<Blob | null> {
  const bitmap = await createImageBitmap(file);
  try {
    return await toBlob(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/** Draws the frame the video element is showing. */
export function captureFrame(video: HTMLVideoElement): Promise<Blob | null> {
  if (!video.videoWidth || !video.videoHeight) return Promise.resolve(null);
  return toBlob(video, video.videoWidth, video.videoHeight);
}

/** Seeks to about 10% in (at most 30 s), so the frame isn't a black title card. */
function fromVideo(file: Blob): Promise<Blob | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    const done = (result: Blob | null) => {
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const timer = setTimeout(() => done(null), 15_000);
    video.muted = true;
    video.preload = "auto";
    video.onloadedmetadata = () => {
      video.currentTime = Number.isFinite(video.duration) ? Math.min(video.duration * 0.1, 30) : 0;
    };
    video.onseeked = () => void captureFrame(video).then(done, () => done(null));
    video.onerror = () => done(null);
    video.src = url;
  });
}

/** Made from the local copy right after an upload, so Telegram is never asked
 * for the file. Best effort: formats the browser can't decode get no thumbnail. */
export async function sendThumbnail(drive: string, id: string, file: File): Promise<boolean> {
  const kind = previewKind(file.name);
  if (kind !== "image" && kind !== "video") return false;
  try {
    const image = kind === "image" ? await fromImage(file) : await fromVideo(file);
    if (!image) return false;
    await api.putThumbnail(drive, id, image);
    remember(drive, id, image);
    return true;
  } catch {
    return false;
  }
}

/** For videos uploaded before thumbnails existed: saves the frame being watched. */
export async function sendFrame(drive: string, id: string, video: HTMLVideoElement): Promise<boolean> {
  try {
    const image = await captureFrame(video);
    if (!image) return false;
    await api.putThumbnail(drive, id, image);
    remember(drive, id, image);
    return true;
  } catch {
    return false;
  }
}
