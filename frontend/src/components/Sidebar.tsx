import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Folder, HardDrive, LayoutGrid, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api, type Crumb, type DriveInfo } from "../api";
import { driveUrl } from "../format";

/** Tree rows are keyed by drive and folder; a drive's own row uses an empty folder id. */
const key = (drive: string, id: string | null) => `${drive}\n${id ?? ""}`;

const ROW = "flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pr-2 text-sm";

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
  current: { drive: string; folder: string | null };
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
  current: { drive: string; folder: string | null };
  expanded: Set<string>;
  onToggle: (k: string) => void;
}) {
  const k = key(drive, id);
  const open = expanded.has(k);
  // Known to be empty only once looked inside; until then it gets an arrow.
  const children = useQuery({ queryKey: ["nodes", drive, id], queryFn: () => api.list(drive, id), enabled: open });
  const empty = !!children.data && !children.data.entries.some((e) => e.kind === "dir");
  const here = current.drive === drive && current.folder === id;
  return (
    <li>
      <div className="flex items-center" style={{ paddingLeft: depth * 14 }}>
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
  current: { drive: string; folder: string | null };
  expanded: Set<string>;
  onToggle: (k: string) => void;
}) {
  const navigate = useNavigate();
  const k = key(drive.name, null);
  const open = drive.unlocked && expanded.has(k);
  const here = current.drive === drive.name && current.folder === null;
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
      <div className="flex items-center">
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

/** Every drive, and the folder tree of the unlocked ones. Opens itself down
 * to the folder being viewed. */
export default function Sidebar({ drive, folder, path }: { drive: string; folder: string | null; path: Crumb[] }) {
  const drives = useQuery({ queryKey: ["drives"], queryFn: api.drives });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([key(drive, null)]));

  const trail = path.map((c) => c.id).join("/");
  useEffect(() => {
    setExpanded((prev) => {
      const wanted = [key(drive, null), ...path.map((c) => key(drive, c.id))];
      if (wanted.every((k) => prev.has(k))) return prev;
      return new Set([...prev, ...wanted]);
    });
    // `trail` stands in for `path`, which is a new array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drive, trail]);

  function toggle(k: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(k)) next.add(k);
      return next;
    });
  }

  const current = { drive, folder };
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
        <h2 className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted">Drives</h2>
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
