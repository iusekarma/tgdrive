import type { Entry } from "./api";
import { previewKind } from "./format";

// The tabs above a listing: one per sort of thing that is in it.

export type Category = "folder" | "image" | "video" | "audio" | "document" | "comic" | "archive" | "other";

export const CATEGORY_LABELS: Record<Category, string> = {
  folder: "Folders",
  image: "Images",
  video: "Videos",
  audio: "Audio",
  document: "Documents",
  comic: "Comics",
  archive: "Archives",
  other: "Other",
};

const DOCUMENTS = ["doc", "docx", "odt", "rtf", "xls", "xlsx", "ods", "ppt", "pptx", "odp", "epub", "mobi"];
const ARCHIVES = ["rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "cbr", "iso", "dmg"];

export function category(entry: Entry): Category {
  if (entry.kind === "dir") return "folder";
  const kind = previewKind(entry.name, entry.size);
  if (kind === "pdf" || kind === "text") return "document";
  if (kind) return kind;
  const ext = entry.name.slice(entry.name.lastIndexOf(".") + 1).toLowerCase();
  if (DOCUMENTS.includes(ext)) return "document";
  if (ARCHIVES.includes(ext)) return "archive";
  return "other";
}

/** How many of each there are, in the tabs' order. */
export function countCategories(entries: Entry[]): [Category, number][] {
  const counts = new Map<Category, number>();
  for (const entry of entries) {
    const c = category(entry);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return (Object.keys(CATEGORY_LABELS) as Category[]).flatMap((c) => {
    const n = counts.get(c);
    return n ? [[c, n] as [Category, number]] : [];
  });
}
