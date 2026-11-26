/** Cover art and song details from inside an audio file: ID3 (MP3, WAV, AAC),
 * FLAC pictures and Vorbis comments, Ogg comments, MP4 "covr" and "ilst". */
import { ADTS, CustomSource, FLAC, Input, MP3, MP4, OGG, QTFF, WAVE, type AttachedImage, type MetadataTags } from "mediabunny";

import type { SongInfo } from "../api";
import { BlobBytes, HttpBytes } from "./bytes";

/** What the server keeps of a tag: trimmed, and short enough to be accepted. */
const text = (value: string | undefined, max = 200) => value?.replace(/\0+$/, "").trim().slice(0, max) || undefined;

/** 3 of 12 → "3/12"; 3 alone → "3". */
const position = (n: number | undefined, total: number | undefined) =>
  n && n > 0 && n <= 9999 ? (total && total >= n && total <= 9999 ? `${n}/${total}` : String(n)) : undefined;

/** The song's details as the server stores them; only what the file has. */
export function songInfo(tags: MetadataTags): SongInfo {
  const year = tags.date && !Number.isNaN(tags.date.getTime()) ? tags.date.getUTCFullYear() : undefined;
  const song: SongInfo = {
    title: text(tags.title),
    artist: text(tags.artist),
    album: text(tags.album),
    album_artist: text(tags.albumArtist),
    track: position(tags.trackNumber, tags.tracksTotal),
    disc: position(tags.discNumber, tags.discsTotal),
    year: year && year >= 1 && year <= 9999 ? year : undefined,
    genre: text(tags.genre),
  };
  return Object.fromEntries(Object.entries(song).filter(([, v]) => v !== undefined)) as SongInfo;
}

/** Tags often name the wrong type, or none a browser knows ("JPG"); the first bytes don't lie. */
function imageType({ data, mimeType }: AttachedImage): string {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46)) return "image/webp";
  return mimeType;
}

export type SongTags = { images: Blob[]; song: SongInfo };

/** The pictures in the file, front cover first, and its song details; none if
 * it has none or isn't readable audio. Throws if the file couldn't be fetched,
 * or on `signal`. Only the part holding the tags is read, usually the start. */
export async function songTags(source: Blob | string, size: number, signal?: AbortSignal): Promise<SongTags> {
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
    const tags: MetadataTags = await input.getMetadataTags().catch(() => ({}));
    signal?.throwIfAborted();
    if (failure) throw failure;
    const front = (i: AttachedImage) => (i.kind === "coverFront" ? 0 : 1);
    const images = [...(tags.images ?? [])]
      .sort((a, b) => front(a) - front(b))
      .map((i) => new Blob([i.data as Uint8Array<ArrayBuffer>], { type: imageType(i) }));
    return { images, song: songInfo(tags) };
  } finally {
    signal?.removeEventListener("abort", stop);
    input.dispose();
    bytes.close();
  }
}

/** Just the pictures, front cover first. */
export const coverArt = async (source: Blob | string, size: number, signal?: AbortSignal): Promise<Blob[]> =>
  (await songTags(source, size, signal)).images;
