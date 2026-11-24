/** Cover art from inside an audio file: ID3 (MP3, WAV, AAC), FLAC pictures, Ogg comments, MP4 "covr". */
import { ADTS, CustomSource, FLAC, Input, MP3, MP4, OGG, QTFF, WAVE, type AttachedImage } from "mediabunny";

import { BlobBytes, HttpBytes } from "./bytes";

/** Tags often name the wrong type, or none a browser knows ("JPG"); the first bytes don't lie. */
function imageType({ data, mimeType }: AttachedImage): string {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46)) return "image/webp";
  return mimeType;
}

/** The pictures in the file, front cover first; none if it has none or isn't
 * readable audio. Throws if the file couldn't be fetched, or on `signal`.
 * Only the part holding the tags is read, usually the start. */
export async function coverArt(source: Blob | string, size: number, signal?: AbortSignal): Promise<Blob[]> {
  signal?.throwIfAborted();
  const bytes = typeof source === "string" ? new HttpBytes(source, size) : new BlobBytes(source);
  const stop = () => bytes.close();
  signal?.addEventListener("abort", stop);
  let failure: unknown;
  const input = new Input({
    formats: [MP4, QTFF, WAVE, OGG, FLAC, MP3, ADTS],
    source: new CustomSource({
      getSize: () => size,
      read: (start, end) =>
        bytes.read(start, end).catch((e: unknown) => {
          failure ??= e;
          throw e;
        }),
      handleUnhandledError: () => undefined,
    }),
  });
  try {
    const { images = [] } = await input.getMetadataTags().catch(() => ({ images: [] }));
    signal?.throwIfAborted();
    if (failure) throw failure;
    const front = (i: AttachedImage) => (i.kind === "coverFront" ? 0 : 1);
    return [...images]
      .sort((a, b) => front(a) - front(b))
      .map((i) => new Blob([i.data as Uint8Array<ArrayBuffer>], { type: imageType(i) }));
  } finally {
    signal?.removeEventListener("abort", stop);
    input.dispose();
    bytes.close();
  }
}
