/** A PDF's first page, drawn by PDFium in a worker of its own. A PDF's index
 * is usually at its end, so a file on the server is read there and around its
 * first page, and the rest isn't fetched. */

export interface PageRequest {
  /** A URL on this server (read with range requests), or a local copy. */
  source: Blob | string;
  /** Where to read the start of the file, if not from `source`. */
  opening?: string;
  size: number;
  /** The longest side, in pixels. */
  side: number;
}

export type PageReply = { width: number; height: number; pixels: Uint8ClampedArray<ArrayBuffer> } | null;

/** PDFium counts bytes in 32 bits, signed in places. */
const SIZE_MAX = 2 ** 31 - 1;
const LOCAL_TIMEOUT = 20_000;
/** The parts it needs may first have to come from Telegram. */
const SERVER_TIMEOUT = 60_000;

/** The first page, or null if it can't be drawn: damaged, needs a password, or too much to read. */
export function firstPage(request: PageRequest, signal?: AbortSignal): Promise<ImageData | null> {
  if (signal?.aborted || request.size === 0 || request.size > SIZE_MAX) return Promise.resolve(null);
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const done = (page: ImageData | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      worker.terminate();
      resolve(page);
    };
    const stop = () => done(null);
    const timer = setTimeout(stop, typeof request.source === "string" ? SERVER_TIMEOUT : LOCAL_TIMEOUT);
    signal?.addEventListener("abort", stop);
    worker.onerror = stop;
    worker.onmessage = ({ data }: MessageEvent<PageReply>) =>
      done(data && new ImageData(data.pixels, data.width, data.height));
    worker.postMessage(request);
  });
}
