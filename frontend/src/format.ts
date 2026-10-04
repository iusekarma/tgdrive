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

export type PreviewKind = "image" | "video" | "audio" | "pdf" | "text";

const KINDS: Record<PreviewKind, string[]> = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "bmp"],
  video: ["mp4", "webm", "mov", "m4v", "ogv", "mkv"],
  audio: ["mp3", "wav", "ogg", "m4a", "flac", "opus", "aac"],
  pdf: ["pdf"],
  text: [
    "txt", "md", "json", "csv", "log", "yml", "yaml", "toml", "ini", "conf", "xml", "html", "css",
    "js", "ts", "tsx", "jsx", "py", "sh", "sql", "c", "h", "cpp", "java", "go", "rs",
  ],
};

export function previewKind(name: string): PreviewKind | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  for (const kind of Object.keys(KINDS) as PreviewKind[]) {
    if (KINDS[kind].includes(ext)) return kind;
  }
  return null;
}

export const PASSWORD_MIN = 8;
export const DRIVE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/;

export const driveUrl = (drive: string, folderId?: string | null) =>
  `/d/${encodeURIComponent(drive)}${folderId ? `/${folderId}` : ""}`;
