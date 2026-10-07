import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Folder } from "lucide-react";
import { useState, type FormEvent } from "react";

import { api, type Entry } from "../api";
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
