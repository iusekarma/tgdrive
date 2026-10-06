import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import { api, type Entry, type FileInfo } from "./api";

// Details are gathered for free: from the local copy while uploading, from a
// preview the browser is already showing, or by the server while it makes an
// image's thumbnail. Nothing here ever downloads a file just to describe it.

export const infoKey = (drive: string, id: string) => ["info", drive, id];

/** Details only change when something learns more, which updates this cache, so they are never refetched. */
export function useFileInfo(drive: string, entry: Entry | null) {
  return useQuery({
    queryKey: infoKey(drive, entry?.id ?? ""),
    queryFn: () => api.fileInfo(drive, entry?.id ?? ""),
    enabled: entry?.kind === "file",
    staleTime: Infinity,
  });
}

/** Saves what a preview found out about a file, unless it is already known. */
export function useLearn(drive: string, id: string) {
  const queryClient = useQueryClient();
  const sent = useRef(new Set<string>()).current;
  return (fields: FileInfo) => {
    const known = queryClient.getQueryData<FileInfo>(infoKey(drive, id));
    const fresh = Object.fromEntries(
      Object.entries(fields).filter(([k, v]) => v !== undefined && known?.[k as keyof FileInfo] !== v),
    ) as FileInfo;
    const signature = JSON.stringify(fresh);
    if (Object.keys(fresh).length === 0 || sent.has(signature)) return;
    sent.add(signature);
    void api.putFileInfo(drive, id, fresh).then(
      (info) => queryClient.setQueryData(infoKey(drive, id), info),
      () => undefined,
    );
  };
}

/** Seconds, to a hundredth: media elements can report a hair's difference between loads. */
export function seconds(duration: number): number | undefined {
  return Number.isFinite(duration) && duration > 0 ? Math.round(duration * 100) / 100 : undefined;
}

// --- EXIF, from a local file ---------------------------------------------------

const EXIF_SCAN = 256 * 1024;

const exifText = (value: string | undefined) => value?.replace(/\0+$/, "").trim() || undefined;

/** "2024:05:01 12:30:00" → "2024-05-01 12:30:00". */
function exifDate(value: string | undefined): string | undefined {
  const m = value && /^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})/.exec(value);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}` : undefined;
}

/** "Canon" + "Canon EOS R5" → "Canon EOS R5"; "Apple" + "iPhone 15" → "Apple iPhone 15". */
export function cameraName(make?: string, model?: string): string | undefined {
  if (make && model && model.startsWith(make.split(" ")[0])) return model;
  return [make, model].filter(Boolean).join(" ") || undefined;
}

function readTiff(t: DataView): Pick<FileInfo, "taken" | "camera"> {
  const le = t.getUint16(0) === 0x4949; // "II": little-endian
  const u16 = (at: number) => t.getUint16(at, le);
  const u32 = (at: number) => t.getUint32(at, le);
  const entries = (ifd: number) => {
    const found = new Map<number, number>();
    for (let i = 0, n = u16(ifd); i < n; i += 1) found.set(u16(ifd + 2 + i * 12), ifd + 2 + i * 12);
    return found;
  };
  const ascii = (entry: number | undefined) => {
    if (entry === undefined || u16(entry + 2) !== 2) return undefined;
    const count = u32(entry + 4);
    const at = count > 4 ? u32(entry + 8) : entry + 8;
    return exifText(String.fromCharCode(...new Uint8Array(t.buffer, t.byteOffset + at, Math.min(count, 256))));
  };
  const ifd0 = entries(u32(4));
  const sub = ifd0.get(0x8769);
  const original = sub === undefined ? undefined : ascii(entries(u32(sub + 8)).get(0x9003));
  return {
    taken: exifDate(original ?? ascii(ifd0.get(0x0132))),
    camera: cameraName(ascii(ifd0.get(0x010f)), ascii(ifd0.get(0x0110)))?.slice(0, 200),
  };
}

/** When and with what a JPEG was taken. Reads only the start of the file, where EXIF lives. */
export async function readExif(file: Blob): Promise<Pick<FileInfo, "taken" | "camera">> {
  try {
    const view = new DataView(await file.slice(0, EXIF_SCAN).arrayBuffer());
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return {};
    let at = 2;
    while (at + 4 <= view.byteLength) {
      const marker = view.getUint16(at);
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break; // start of the image data
      const length = view.getUint16(at + 2);
      if (marker === 0xffe1 && at + 10 <= view.byteLength && view.getUint32(at + 4) === 0x45786966) {
        const end = Math.min(at + 2 + length, view.byteLength);
        return readTiff(new DataView(view.buffer, at + 10, end - at - 10));
      }
      at += 2 + length;
    }
  } catch {
    // Truncated or malformed EXIF: it just isn't shown.
  }
  return {};
}
