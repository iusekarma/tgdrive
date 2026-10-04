import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Download, Folder } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { api, type Entry } from "../api";
import { formatSize, previewKind } from "../format";
import { sendFrame } from "../thumbs";
import { Button, Dialog, DialogActions, ErrorNote, Field, useSubmit } from "./ui";

/** One text field and a confirm button: used for "New folder" and "Rename". */
export function NameDialog({
  title,
  label,
  initial = "",
  action,
  busyAction,
  onClose,
  onSubmit,
}: {
  title: string;
  label: string;
  initial?: string;
  action: string;
  busyAction: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const { busy, error, setError, run } = useSubmit();

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError("Enter a name.");
    if (trimmed.includes("/")) return setError("Names can't contain a slash.");
    void run(() => onSubmit(trimmed));
  }

  return (
    <Dialog title={title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field
          label={label}
          autoFocus
          required
          maxLength={255}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => {
            // Preselect the name but not the extension, as file managers do.
            const dot = e.target.value.lastIndexOf(".");
            e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
          }}
        />
        <ErrorNote>{error}</ErrorNote>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? busyAction : action}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function describe(entries: Entry[]): string {
  if (entries.length === 1) return entries[0].name;
  const folders = entries.filter((e) => e.kind === "dir").length;
  const files = entries.length - folders;
  const parts = [];
  if (files) parts.push(`${files} ${files === 1 ? "file" : "files"}`);
  if (folders) parts.push(`${folders} ${folders === 1 ? "folder" : "folders"}`);
  return parts.join(" and ");
}

export function DeleteNodeDialog({
  entries,
  onClose,
  onConfirm,
}: {
  entries: Entry[];
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { busy, error, run } = useSubmit();
  const anyFolder = entries.some((e) => e.kind === "dir");
  return (
    <Dialog title={`Delete ${describe(entries)}?`} onClose={onClose}>
      <p className="text-sm text-muted">
        {anyFolder
          ? "Folders are deleted with everything inside them. "
          : ""}
        The copies in your Telegram channel are deleted too. It can't be undone.
      </p>
      <div className="mt-4">
        <ErrorNote>{error}</ErrorNote>
      </div>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" disabled={busy} onClick={() => void run(onConfirm)}>
          {busy ? "Deleting…" : "Delete"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** A small folder browser for choosing where to move something. */
export function MoveDialog({
  drive,
  entries,
  from,
  onClose,
  onMoved,
}: {
  drive: string;
  entries: Entry[];
  /** The folder the items are in; leave out when they come from several. */
  from?: string | null;
  onClose: () => void;
  onMoved: () => void;
}) {
  const [target, setTarget] = useState<string | null>(from ?? null);
  const listing = useQuery({ queryKey: ["nodes", drive, target], queryFn: () => api.list(drive, target) });
  const { busy, error, run } = useSubmit();

  // A folder that is being moved can't be the destination, so it isn't offered.
  const moving = new Set(entries.map((e) => e.id));
  const folders = listing.data?.entries.filter((e) => e.kind === "dir" && !moving.has(e.id)) ?? [];
  const crumbs = listing.data?.path ?? [];
  const here = crumbs.length > 0 ? crumbs[crumbs.length - 1].name : drive;

  return (
    <Dialog title={`Move ${describe(entries)}`} onClose={onClose}>
      <nav aria-label="Destination" className="flex flex-wrap items-center gap-1 text-sm">
        <button type="button" className="rounded px-1 py-0.5 hover:bg-ink/5" onClick={() => setTarget(null)}>
          {drive}
        </button>
        {crumbs.map((c) => (
          <span key={c.id} className="flex items-center gap-1">
            <ChevronRight size={14} className="text-muted" aria-hidden="true" />
            <button type="button" className="rounded px-1 py-0.5 hover:bg-ink/5" onClick={() => setTarget(c.id)}>
              {c.name}
            </button>
          </span>
        ))}
      </nav>

      <div className="mt-3 h-56 overflow-y-auto rounded-md border border-line bg-surface">
        {listing.isPending && <p className="p-3 text-sm text-muted">Loading…</p>}
        {listing.error && <p className="p-3 text-sm text-danger">{listing.error.message}</p>}
        {listing.data && folders.length === 0 && <p className="p-3 text-sm text-muted">No folders in here.</p>}
        <ul>
          {folders.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => setTarget(f.id)}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-ink/5"
              >
                <Folder size={16} className="shrink-0 text-brass" aria-hidden="true" />
                <span className="truncate">{f.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-4">
        <ErrorNote>{error}</ErrorNote>
      </div>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={busy || target === from || !listing.data}
          onClick={() =>
            void run(async () => {
              await api.moveMany(
                drive,
                entries.map((e) => e.id),
                target,
              );
              onMoved();
            })
          }
        >
          {busy ? "Moving…" : `Move to ${here}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

const TEXT_PREVIEW_LIMIT = 512 * 1024;

function TextPreview({ url, size }: { url: string; size: number }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (size === 0) {
      setText("");
      return;
    }
    const controller = new AbortController();
    // A range request, so a huge log file doesn't get pulled in whole.
    fetch(url, { headers: { Range: `bytes=0-${TEXT_PREVIEW_LIMIT - 1}` }, signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.text();
      })
      .then(setText)
      .catch((e: unknown) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) setFailed(true);
      });
    return () => controller.abort();
  }, [url, size]);

  if (failed) return <p className="text-sm text-danger">This file couldn't be loaded. Try downloading it instead.</p>;
  if (text === null) return <p className="text-sm text-muted">Loading…</p>;
  if (text === "") return <p className="text-sm text-muted">This file is empty.</p>;
  return (
    <>
      <pre className="max-h-[65vh] overflow-auto rounded-md border border-line bg-surface p-4 text-sm leading-relaxed">
        {text}
      </pre>
      {size > TEXT_PREVIEW_LIMIT && (
        <p className="mt-2 text-sm text-muted">Showing the first 512 KB. Download the file to see the rest.</p>
      )}
    </>
  );
}

/** Videos uploaded before thumbnails existed get one from the first frame
 * watched past the 2 s mark, so it isn't a black title card. */
function VideoPreview({ drive, entry, url }: { drive: string; entry: Entry; url: string }) {
  const queryClient = useQueryClient();
  const captured = useRef(entry.thumb);
  return (
    <video
      src={url}
      controls
      className="max-h-[65vh] w-full rounded-md bg-black"
      onTimeUpdate={(e) => {
        const video = e.currentTarget;
        if (captured.current || video.currentTime < Math.min(2, video.duration / 2)) return;
        captured.current = true;
        void sendFrame(drive, entry.id, video).then((sent) => {
          if (sent) void queryClient.invalidateQueries({ queryKey: ["nodes", drive] });
        });
      }}
    />
  );
}

export function PreviewDialog({ drive, entry, onClose }: { drive: string; entry: Entry; onClose: () => void }) {
  const kind = previewKind(entry.name);
  const inlineUrl = api.fileUrl(drive, entry.id, true);
  return (
    <Dialog title={entry.name} onClose={onClose} wide>
      <div className="flex justify-center">
        {kind === "image" && <img src={inlineUrl} alt={entry.name} className="max-h-[65vh] max-w-full rounded-md" />}
        {kind === "video" && <VideoPreview drive={drive} entry={entry} url={inlineUrl} />}
        {kind === "audio" && <audio src={inlineUrl} controls className="w-full" />}
        {kind === "pdf" && (
          <iframe src={inlineUrl} title={entry.name} className="h-[65vh] w-full rounded-md border border-line" />
        )}
        {kind === "text" && (
          <div className="w-full">
            <TextPreview url={api.fileUrl(drive, entry.id)} size={entry.size} />
          </div>
        )}
      </div>
      <DialogActions>
        <span className="mr-auto self-center text-sm text-muted">{formatSize(entry.size)}</span>
        <a
          href={api.fileUrl(drive, entry.id)}
          download={entry.name}
          className="inline-flex items-center gap-2 rounded-md bg-teal px-3.5 py-2 text-sm font-medium text-teal-ink hover:brightness-110"
        >
          <Download size={16} />
          Download
        </a>
      </DialogActions>
    </Dialog>
  );
}
