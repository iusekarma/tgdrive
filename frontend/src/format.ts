export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export type PreviewKind = "image" | "video" | "audio" | "pdf" | "text" | "archive" | "comic";

const KINDS: Record<PreviewKind, string[]> = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"],
  video: ["mp4", "webm", "mov", "m4v", "ogv", "mkv", "m2ts", "mts"],
  audio: ["mp3", "wav", "ogg", "m4a", "flac", "opus", "aac"],
  pdf: ["pdf"],
  text: [
    "txt", "md", "json", "csv", "log", "yml", "yaml", "toml", "ini", "conf", "xml", "html", "css",
    "js", "tsx", "jsx", "py", "sh", "sql", "c", "h", "cpp", "java", "go", "rs",
  ],
  // Zip-based formats, whose contents can be listed from the end of the file.
  archive: ["zip", "jar", "apk"],
  // Zipped page images, read a page at a time.
  comic: ["cbz"],
};

/** ".ts" is TypeScript or an MPEG transport stream; source files this large are rare. */
const TS_TEXT_MAX = 1024 * 1024;

const extension = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};

export function previewKind(name: string, size = 0): PreviewKind | null {
  const ext = extension(name);
  if (!ext) return null;
  if (ext === "ts") return size > TS_TEXT_MAX ? "video" : "text";
  for (const kind of Object.keys(KINDS) as PreviewKind[]) {
    if (KINDS[kind].includes(ext)) return kind;
  }
  return null;
}

/** MPEG transport streams, which browsers can't play without help (mpegts.js). */
export const isTransportStream = (name: string) => ["ts", "m2ts", "mts"].includes(extension(name));

export const PASSWORD_MIN = 8;
export const DRIVE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/;

export const driveUrl = (drive: string, folderId?: string | null) =>
  `/d/${encodeURIComponent(drive)}${folderId ? `/${folderId}` : ""}`;

/** A rough time left, e.g. "40 s", "12 min", "2 h 5 min". */
export function formatDuration(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** A clock-style media length, e.g. "0:42", "12:05", "1:02:09". */
export function formatLength(seconds: number): string {
  const s = Math.round(seconds);
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export function formatDateTime(date: Date): string {
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const TYPE_NAMES: Record<string, string> = {
  jpg: "JPEG image", jpeg: "JPEG image", png: "PNG image", gif: "GIF image", webp: "WebP image",
  avif: "AVIF image", bmp: "BMP image", svg: "SVG image", heic: "HEIC image", tif: "TIFF image", tiff: "TIFF image",
  mp4: "MP4 video", m4v: "MP4 video", mov: "QuickTime video", webm: "WebM video", mkv: "Matroska video",
  avi: "AVI video", ogv: "Ogg video", m2ts: "MPEG-TS video", mts: "MPEG-TS video",
  mp3: "MP3 audio", m4a: "AAC audio", aac: "AAC audio", wav: "WAV audio", flac: "FLAC audio",
  ogg: "Ogg audio", opus: "Opus audio",
  pdf: "PDF document", txt: "Plain text", md: "Markdown", csv: "CSV spreadsheet", json: "JSON",
  zip: "ZIP archive", cbz: "Comic book archive", cbr: "Comic book archive", jar: "Java archive", rar: "RAR archive", "7z": "7-Zip archive", tar: "Tar archive", gz: "Gzip archive",
  doc: "Word document", docx: "Word document", xls: "Excel spreadsheet", xlsx: "Excel spreadsheet",
  ppt: "PowerPoint deck", pptx: "PowerPoint deck", epub: "EPUB book", apk: "Android app", exe: "Windows program",
  iso: "Disc image", dmg: "Disk image",
};

/** "JPEG image", "MP4 video"; files it doesn't know are named by extension, e.g. "XYZ file". */
export function typeName(name: string, size = 0): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "File";
  const ext = name.slice(dot + 1).toLowerCase();
  if (ext === "ts") return previewKind(name, size) === "video" ? "MPEG-TS video" : "TypeScript";
  return TYPE_NAMES[ext] ?? `${ext.toUpperCase()} file`;
}
