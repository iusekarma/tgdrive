/** Draws a PDF's first page with PDFium, reading only the parts of the file
 * that takes. PDFium asks for bytes synchronously, so this must be a worker. */
import { init } from "@embedpdf/pdfium";
import wasmUrl from "@embedpdf/pdfium/pdfium.wasm?url";

import type { PageReply, PageRequest } from "./page";

const BLOCK = 1024 * 1024;
/** Requests end on these boundaries: the server reads whole chunks of this size from Telegram. */
const ALIGN = 16 * BLOCK;
const LONGEST_RUN = ALIGN / BLOCK;
/** A page that needs more than this, or a damaged file PDFium would search from end to end, isn't worth it. */
const READ_MAX = 64 * BLOCK;
const ATTEMPTS = 3;

/** FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER: with annotations, as RGBA. */
const RENDER_FLAGS = 0x01 | 0x10;

/** Workers have it; TypeScript's types for pages don't. */
declare class FileReaderSync {
  readAsArrayBuffer(blob: Blob): ArrayBuffer;
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<PageRequest>) => void) | null;
  postMessage(reply: PageReply, transfer?: Transferable[]): void;
};

class Reader {
  private blocks = new Map<number, Uint8Array>();
  private lastRun = 1;
  private total = 0;
  /** Set once any read failed: what is drawn after that has holes in it. */
  failed = false;

  constructor(
    private source: Blob | string,
    private opening: string | undefined,
    private size: number,
  ) {}

  /** Copies `length` bytes from `start` to `target`; false if they couldn't be read. */
  read(start: number, length: number, target: Uint8Array): boolean {
    if (this.failed || start + length > this.size) return false;
    try {
      for (let done = 0; done < length; ) {
        const i = Math.floor((start + done) / BLOCK);
        const from = start + done - i * BLOCK;
        const part = this.block(i).subarray(from, from + length - done);
        target.set(part, done);
        done += part.length;
      }
      return true;
    } catch {
      this.failed = true;
      return false;
    }
  }

  /** Reading on from what is already here asks for more at once. */
  private block(i: number): Uint8Array {
    const have = this.blocks.get(i);
    if (have) return have;
    this.lastRun = this.blocks.has(i - 1) ? Math.min(this.lastRun * 2, LONGEST_RUN) : 1;
    const start = i * BLOCK;
    const boundary = (Math.floor(start / ALIGN) + 1) * ALIGN;
    let end = Math.min(start + this.lastRun * BLOCK, boundary, this.size);
    for (let j = i + 1; j * BLOCK < end; j += 1) if (this.blocks.has(j)) end = j * BLOCK;
    this.total += end - start;
    if (this.total > READ_MAX) throw new Error("too much to read");
    const data = this.fetch(start, end);
    for (let at = 0; at < data.length; at += BLOCK) {
      this.blocks.set((start + at) / BLOCK, data.subarray(at, at + BLOCK));
    }
    return this.blocks.get(i)!;
  }

  private fetch(start: number, end: number): Uint8Array {
    if (typeof this.source !== "string") {
      return new Uint8Array(new FileReaderSync().readAsArrayBuffer(this.source.slice(start, end)));
    }
    const url = start === 0 ? (this.opening ?? this.source) : this.source;
    for (let attempt = 1; ; attempt += 1) {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, false);
      xhr.responseType = "arraybuffer";
      xhr.setRequestHeader("Range", `bytes=${start}-${end - 1}`);
      try {
        xhr.send();
      } catch {
        if (attempt >= ATTEMPTS) throw new Error("the file couldn't be read");
        continue;
      }
      const body = xhr.response as ArrayBuffer | null;
      if (xhr.status === 206 && body?.byteLength === end - start) return new Uint8Array(body);
      // A locked drive, a deleted file or a server without ranges won't change by asking again.
      if (xhr.status < 500 || attempt >= ATTEMPTS) throw new Error(`the file couldn't be read (${xhr.status})`);
    }
  }
}

async function draw({ source, opening, size, side }: PageRequest): Promise<PageReply> {
  const wasm = await fetch(wasmUrl);
  if (!wasm.ok) throw new Error("the PDF renderer couldn't be loaded");
  const lib = await init({ wasmBinary: await wasm.arrayBuffer() });
  lib.PDFiumExt_Init();
  const runtime = lib.pdfium;
  // Looked up each time: the buffer is replaced when its memory grows.
  const memory = () => (runtime as unknown as { HEAPU8: Uint8Array }).HEAPU8;

  const reader = new Reader(source, opening, size);
  // FPDF_FILEACCESS: the length, then m_GetBlock(param, position, buffer, length), then param.
  const getBlock = runtime.addFunction(
    (_param: number, position: number, buffer: number, length: number) =>
      reader.read(position >>> 0, length >>> 0, memory().subarray(buffer >>> 0, (buffer >>> 0) + (length >>> 0))) ? 1 : 0,
    "iiiii",
  );
  const access = runtime.wasmExports.malloc(12);
  runtime.setValue(access, size, "i32");
  runtime.setValue(access + 4, getBlock, "i32");
  runtime.setValue(access + 8, 0, "i32");

  // Nothing is closed or freed: the worker ends with this one page.
  const doc = lib.FPDF_LoadCustomDocument(access, "");
  const page = doc && lib.FPDF_LoadPage(doc, 0);
  if (!page) return null;   // damaged, or needs a password
  const w = lib.FPDF_GetPageWidthF(page);
  const h = lib.FPDF_GetPageHeightF(page);
  if (!(w > 0 && h > 0)) return null;
  const scale = side / Math.max(w, h);
  const width = Math.max(1, Math.round(w * scale));
  const height = Math.max(1, Math.round(h * scale));
  const bitmap = lib.FPDFBitmap_Create(width, height, 1);
  if (!bitmap) return null;
  lib.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
  lib.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, RENDER_FLAGS);
  if (reader.failed) return null;

  const from = lib.FPDFBitmap_GetBuffer(bitmap);
  const stride = lib.FPDFBitmap_GetStride(bitmap);
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const row = from + y * stride;
    pixels.set(memory().subarray(row, row + width * 4), y * width * 4);
  }
  return { width, height, pixels };
}

scope.onmessage = (e) => {
  draw(e.data).then(
    (reply) => scope.postMessage(reply, reply ? [reply.pixels.buffer] : []),
    () => scope.postMessage(null),
  );
};
