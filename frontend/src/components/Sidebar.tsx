import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Folder, HardDrive, LayoutGrid, LocateFixed, Lock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api, type Crumb, type DriveInfo } from "../api";
import { driveUrl } from "../format";

/** Tree rows are keyed by drive and folder; a drive's own row uses an empty folder id. */
const key = (drive: string, id: string | null) => `${drive}\n${id ?? ""}`;

const ROW = "flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pr-2 text-sm";

/** The folder being viewed, and a count bumped each time it is asked to be shown. */
type Current = { drive: string; folder: string | null; reveal: number };

/** Scrolls the current row into view once it is asked to be shown. The row may
 * only appear after its parents load, so this also runs when it mounts. */
function useReveal<T extends HTMLElement>(here: boolean, reveal: number) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (here && reveal) ref.current?.scrollIntoView({ block: "nearest" });
  }, [here, reveal]);
  return ref;
}

function Toggle({
  expanded,
  empty,
  label,
  onToggle,
}: {
  expanded: boolean;
  empty: boolean;
  label: string;
  onToggle: () => void;
}) {
  if (empty) return <span className="w-6 shrink-0" aria-hidden="true" />;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
      onClick={onToggle}
      className="inline-flex w-6 shrink-0 justify-center rounded py-1.5 text-muted hover:bg-ink/5 hover:text-ink"
    >
      <ChevronRight size={14} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
    </button>
  );
}

/** The folders inside one folder, fetched only once it is expanded. Shares the
 * browser's cache, so the folder being viewed is never fetched twice. */
function Folders({
  drive,
  parent,
  depth,
  current,
  expanded,
  onToggle,
}: {
  drive: string;
  parent: string | null;
  depth: number;
  current: Current;
  expanded: Set<string>;
  onToggle: (k: string) => void;
}) {
  const listing = useQuery({ queryKey: ["nodes", drive, parent], queryFn: () => api.list(drive, parent) });
  if (listing.isPending) {
    return (
      <p className="py-1 text-xs text-muted" style={{ paddingLeft: depth * 14 + 28 }}>
        Loading…
      </p>
    );
  }
  if (listing.error) return null;
  const folders = listing.data.entries.filter((e) => e.kind === "dir");
  return (
    <ul>
      {folders.map((f) => (
        <FolderRow
          key={f.id}
          drive={drive}
          id={f.id}
          name={f.name}
          depth={depth}
          current={current}
          expanded={expanded}
          onToggle={onToggle}
        />
      ))}
    </ul>
  );
}

function FolderRow({
  drive,
  id,
  name,
  depth,
  current,
  expanded,
  onToggle,
}: {
  drive: string;
  id: string;
  name: string;
  depth: number;
  current: Current;
  expanded: Set<string>;
  onToggle: (k: string) => void;
}) {
  const k = key(drive, id);
  const open = expanded.has(k);
  // Known to be empty only once looked inside; until then it gets an arrow.
  const children = useQuery({ queryKey: ["nodes", drive, id], queryFn: () => api.list(drive, id), enabled: open });
  const empty = !!children.data && !children.data.entries.some((e) => e.kind === "dir");
  const here = current.drive === drive && current.folder === id;
  const ref = useReveal<HTMLDivElement>(here, current.reveal);
  return (
    <li>
      <div ref={ref} className="flex items-center" style={{ paddingLeft: depth * 14 }}>
        <Toggle expanded={open} empty={empty} label={name} onToggle={() => onToggle(k)} />
        <Link
          to={driveUrl(drive, id)}
          aria-current={here ? "page" : undefined}
          title={name}
          className={`${ROW} pl-1 ${here ? "bg-teal/10 font-medium text-ink" : "text-ink hover:bg-ink/5"}`}
        >
          <Folder size={15} className="shrink-0 text-brass" aria-hidden="true" />
          <span className="truncate">{name}</span>
        </Link>
      </div>
      {open && !empty && (
        <Folders
          drive={drive}
          parent={id}
          depth={depth + 1}
          current={current}
          expanded={expanded}
          onToggle={onToggle}
        />
      )}
    </li>
  );
}

function DriveRow({
  drive,
  current,
  expanded,
  onToggle,
}: {
  drive: DriveInfo;
  current: Current;
  expanded: Set<string>;
  onToggle: (k: string) => void;
}) {
  const navigate = useNavigate();
  const k = key(drive.name, null);
  const open = drive.unlocked && expanded.has(k);
  const here = current.drive === drive.name && current.folder === null;
  const ref = useReveal<HTMLDivElement>(here, current.reveal);
  const label = (
    <>
      {drive.unlocked ? (
        <HardDrive size={15} className="shrink-0 text-teal" aria-hidden="true" />
      ) : (
        <Lock size={15} className="shrink-0 text-brass" aria-hidden="true" />
      )}
      <span className="truncate">{drive.name}</span>
    </>
  );
  const style = `${ROW} pl-1 ${here ? "bg-teal/10 font-medium text-ink" : "text-ink hover:bg-ink/5"}`;
  return (
    <li>
      <div ref={ref} className="flex items-center">
        {drive.unlocked ? (
          <>
            <Toggle expanded={open} empty={false} label={drive.name} onToggle={() => onToggle(k)} />
            <Link
              to={driveUrl(drive.name)}
              aria-current={here ? "page" : undefined}
              title={drive.name}
              className={style}
            >
              {label}
            </Link>
          </>
        ) : (
          <>
            <span className="w-6 shrink-0" aria-hidden="true" />
            {/* The drives page asks for the password, then opens it. */}
            <button
              type="button"
              title={`Unlock ${drive.name}`}
              onClick={() => navigate("/", { state: { unlock: drive.name } })}
              className={`${style} text-left`}
            >
              {label}
            </button>
          </>
        )}
      </div>
      {open && (
        <Folders drive={drive.name} parent={null} depth={1} current={current} expanded={expanded} onToggle={onToggle} />
      )}
    </li>
  );
}

/** Every drive, and the folder tree of the unlocked ones. Folders open only
 * when their arrow is pressed; "Show current folder" opens the tree down to
 * the folder being viewed. */
export default function Sidebar({ drive, folder, path }: { drive: string; folder: string | null; path: Crumb[] }) {
  const drives = useQuery({ queryKey: ["drives"], queryFn: api.drives });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [reveal, setReveal] = useState(0);

  // Opens the drive and every folder above the one being viewed; the viewed
  // folder itself stays as it was.
  function showCurrent() {
    const wanted = [key(drive, null), ...path.slice(0, -1).map((c) => key(drive, c.id))];
    setExpanded((prev) => (wanted.every((k) => prev.has(k)) ? prev : new Set([...prev, ...wanted])));
    setReveal((n) => n + 1);
  }

  function toggle(k: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(k)) next.add(k);
      return next;
    });
  }

  const current = { drive, folder, reveal };
  return (
    <nav aria-label="Drives" className="space-y-4 px-3 py-6">
      <Link
        to="/"
        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-ink hover:bg-ink/5"
      >
        <LayoutGrid size={15} className="shrink-0 text-muted" aria-hidden="true" />
        All drives
      </Link>
      <div>
        <div className="flex items-center justify-between pb-1 pl-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Drives</h2>
          <button
            type="button"
            title="Show current folder"
            aria-label="Show current folder in tree"
            onClick={showCurrent}
            className="rounded p-1 text-muted hover:bg-ink/5 hover:text-ink"
          >
            <LocateFixed size={14} aria-hidden="true" />
          </button>
        </div>
        {drives.isPending && <p className="px-2 text-sm text-muted">Loading…</p>}
        <ul>
          {drives.data?.map((d) => (
            <DriveRow key={d.name} drive={d} current={current} expanded={expanded} onToggle={toggle} />
          ))}
        </ul>
      </div>
    </nav>
  );
}
