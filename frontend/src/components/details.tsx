import {
  BookOpen,
  File as FileIcon,
  FileArchive,
  FileText,
  Film,
  Folder,
  Image as ImageIcon,
  Music,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { type Entry } from "../api";
import { useFileInfo } from "../fileinfo";
import { formatDateTime, formatLength, formatSize, previewKind, typeName, type PreviewKind } from "../format";
import { cachedThumbnail, hasThumbnail, loadThumbnail } from "../thumbs";
import { Dialog, ICON_BUTTON } from "./ui";

const KIND_ICONS: Record<PreviewKind, LucideIcon> = {
  image: ImageIcon,
  video: Film,
  audio: Music,
  pdf: FileText,
  text: FileText,
  archive: FileArchive,
  comic: BookOpen,
};

/** The icon for a folder, or for a file by what the viewer would make of it. */
export function KindIcon({ entry, size, className = "" }: { entry: Entry; size: number; className?: string }) {
  if (entry.kind === "dir") return <Folder size={size} className={`text-brass ${className}`} aria-hidden="true" />;
  const kind = previewKind(entry.name, entry.size);
  const Icon = kind ? KIND_ICONS[kind] : FileIcon;
  return <Icon size={size} className={`text-muted ${className}`} aria-hidden="true" />;
}

/** The thumbnail the listing already loaded, or an icon. */
function Picture({ drive, entry }: { drive: string; entry: Entry }) {
  const wanted = hasThumbnail(entry);
  const [url, setUrl] = useState(() => (wanted ? cachedThumbnail(drive, entry.id) : null));
  useEffect(() => {
    if (!wanted) return setUrl(null);
    let live = true;
    void loadThumbnail(drive, entry.id).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [drive, entry.id, entry.thumb, wanted]);
  return (
    <div className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg bg-ink/[0.04]">
      {url ? <img src={url} alt="" className="h-full w-full object-contain" /> : <KindIcon entry={entry} size={44} />}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-3 py-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

const bytes = (n: number) => `${n.toLocaleString()} ${n === 1 ? "byte" : "bytes"}`;

/** "2024-05-01 12:30:00", camera-local, shown as is in the viewer's format. */
const takenAt = (taken: string) => formatDateTime(new Date(taken.replace(" ", "T")));

/** Everything known about one file or folder. Details are read from the server's
 * database; the file itself is never fetched to fill them in. */
export function EntryDetails({ drive, entry, location }: { drive: string; entry: Entry; location: string }) {
  const info = useFileInfo(drive, entry).data;
  const kind = entry.kind === "file" ? previewKind(entry.name, entry.size) : null;
  const media = kind === "image" || kind === "video" || kind === "audio";
  const shape = kind === "audio" ? info?.duration : kind === "image" ? info?.width : info?.width && info.duration;
  return (
    <div>
      <Picture drive={drive} entry={entry} />
      <h3 className="mt-3 break-words font-medium">{entry.name}</h3>
      <dl className="mt-2 text-sm">
        <Row label="Type">{entry.kind === "dir" ? "Folder" : typeName(entry.name, entry.size)}</Row>
        {entry.kind === "file" && (
          <Row label="Size">
            {formatSize(entry.size)}
            {entry.size >= 1024 && <span className="block text-xs text-muted">{bytes(entry.size)}</span>}
          </Row>
        )}
        {info?.width && info.height && (
          <Row label="Dimensions">
            {info.width} × {info.height}
          </Row>
        )}
        {info?.duration !== undefined && <Row label="Length">{formatLength(info.duration)}</Row>}
        {info?.taken && <Row label="Taken">{takenAt(info.taken)}</Row>}
        {info?.camera && <Row label="Camera">{info.camera}</Row>}
        {info?.modified !== undefined && <Row label="Modified">{formatDateTime(new Date(info.modified * 1000))}</Row>}
        <Row label="Added">{formatDateTime(new Date(entry.created_at * 1000))}</Row>
        <Row label="Location">{location}</Row>
      </dl>
      {media && info && !shape && (
        <p className="mt-3 text-xs text-muted">
          {kind === "audio" ? "Its length" : kind === "image" ? "Its dimensions" : "Its dimensions and length"} will
          show here after it's opened once.
        </p>
      )}
    </div>
  );
}

/** Several items, or the folder itself when nothing is selected. */
function Summary({ title, entries, note }: { title: string; entries: Entry[]; note?: string }) {
  const files = entries.filter((e) => e.kind === "file");
  const folders = entries.length - files.length;
  const plural = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? "" : "s"}`;
  return (
    <div>
      <div className="flex aspect-video w-full items-center justify-center rounded-lg bg-ink/[0.04]">
        <Folder size={44} className="text-brass" aria-hidden="true" />
      </div>
      <h3 className="mt-3 break-words font-medium">{title}</h3>
      <dl className="mt-2 text-sm">
        <Row label="Files">{plural(files.length, "file")}</Row>
        <Row label="Folders">{plural(folders, "folder")}</Row>
        <Row label="Size">{formatSize(files.reduce((sum, e) => sum + e.size, 0))}</Row>
      </dl>
      {note && <p className="mt-3 text-xs text-muted">{note}</p>}
    </div>
  );
}

/** A column beside the listing, for wide screens. */
export function DetailsPanel({
  drive,
  chosen,
  here,
  entries,
  locationOf,
  onClose,
}: {
  drive: string;
  chosen: Entry[];
  /** The folder, or search, being shown. */
  here: string;
  entries: Entry[];
  locationOf: (entry: Entry) => string;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="Details"
      className="sticky top-0 hidden h-screen w-80 shrink-0 self-start overflow-y-auto border-l border-line px-5 py-5 xl:block"
    >
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted">Details</h2>
        <button type="button" onClick={onClose} aria-label="Hide details" title="Hide details" className={ICON_BUTTON}>
          <X size={16} />
        </button>
      </div>
      {chosen.length === 1 ? (
        <EntryDetails drive={drive} entry={chosen[0]} location={locationOf(chosen[0])} />
      ) : chosen.length > 1 ? (
        <Summary title={`${chosen.length.toLocaleString()} selected`} entries={chosen} note="Folder sizes aren't counted." />
      ) : (
        <Summary title={here} entries={entries} note="Select an item to see its details. Subfolders aren't counted." />
      )}
    </aside>
  );
}

export function DetailsDialog({
  drive,
  entry,
  location,
  onClose,
}: {
  drive: string;
  entry: Entry;
  location: string;
  onClose: () => void;
}) {
  return (
    <Dialog title="Details" onClose={onClose}>
      <EntryDetails drive={drive} entry={entry} location={location} />
    </Dialog>
  );
}
