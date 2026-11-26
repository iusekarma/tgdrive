import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  Folder,
  HardDrive,
  KeyRound,
  LayoutGrid,
  LocateFixed,
  Lock,
  PanelLeft,
  Plus,
  Settings,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useMatch, useNavigate } from "react-router-dom";

import { api, type DriveInfo } from "../api";
import { driveUrl } from "../format";
import { forgetThumbnails } from "../thumbs";
import { useTheme } from "../theme";
import { Mark } from "./LockDial";
import { Menu, MenuDivider, MenuHeading, MenuItem } from "./menu";
import { ICON_BUTTON, Segmented } from "./ui";
import { useLockEverything } from "./VaultGate";

/** Tree rows are keyed by drive and folder; a drive's own row uses an empty folder id. */
const key = (drive: string, id: string | null) => `${drive}\n${id ?? ""}`;

const ROW = "flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-lg pr-2 text-sm transition-colors";
const state = (here: boolean) => (here ? "bg-ink/9 text-ink" : "text-ink/75 hover:bg-ink/5 hover:text-ink");

/** The folder being viewed (no drive on the drives page), and a count bumped each time it is asked to be shown. */
type Current = { drive: string | null; folder: string | null; reveal: number };

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
      className="inline-flex h-8 w-6 shrink-0 items-center justify-center rounded-md text-muted hover:text-ink"
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
      <p className="py-1.5 text-xs text-muted" style={{ paddingLeft: depth * 14 + 28 }}>
        Loading…
      </p>
    );
  }
  if (listing.error) return null;
  const folders = listing.data.entries.filter((e) => e.kind === "dir");
  return (
    <ul className="space-y-px pt-px">
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
          className={`${ROW} pl-1.5 ${state(here)}`}
        >
          <Folder size={15} className="shrink-0 fill-current opacity-55" aria-hidden="true" />
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

function DriveIcon({ drive }: { drive: DriveInfo }) {
  return drive.unlocked ? (
    <HardDrive size={16} className="shrink-0 opacity-70" aria-hidden="true" />
  ) : (
    <Lock size={16} className="shrink-0 text-brass" aria-hidden="true" />
  );
}

/** The drives page asks for the password, then opens it. */
const unlockState = (drive: string) => ({ state: { unlock: drive } });

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
  const queryClient = useQueryClient();
  const k = key(drive.name, null);
  const open = drive.unlocked && expanded.has(k);
  const here = current.drive === drive.name && current.folder === null;
  const ref = useReveal<HTMLDivElement>(here, current.reveal);
  const label = (
    <>
      <DriveIcon drive={drive} />
      <span className="truncate">{drive.name}</span>
    </>
  );
  const style = `${ROW} pl-1.5 ${state(here)}`;

  async function lock() {
    // Off the drive first, so its page doesn't ask for what was just locked.
    if (current.drive === drive.name) navigate("/");
    await api.lock(drive.name).catch(() => undefined);
    queryClient.removeQueries({ queryKey: ["nodes", drive.name] });
    forgetThumbnails(drive.name);
    await queryClient.invalidateQueries({ queryKey: ["drives"] });
  }

  return (
    <li>
      <div ref={ref} className="group/drive relative flex items-center">
        {drive.unlocked ? (
          <>
            <Toggle expanded={open} empty={false} label={drive.name} onToggle={() => onToggle(k)} />
            <Link
              to={driveUrl(drive.name)}
              aria-current={here ? "page" : undefined}
              title={drive.name}
              className={`${style} ${drive.protected ? "pr-8" : ""}`}
            >
              {label}
            </Link>
            {drive.protected && (
              <button
                type="button"
                onClick={() => void lock()}
                aria-label={`Lock ${drive.name}`}
                title={`Lock ${drive.name}`}
                className="absolute right-1 inline-flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-ink/9 hover:text-ink mouse:opacity-0 mouse:focus-visible:opacity-100 mouse:group-hover/drive:opacity-100"
              >
                <Lock size={13} aria-hidden="true" />
              </button>
            )}
          </>
        ) : (
          <>
            <span className="w-6 shrink-0" aria-hidden="true" />
            <button
              type="button"
              title={`Unlock ${drive.name}`}
              onClick={() => navigate("/", unlockState(drive.name))}
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

/** One drive in the rail: its icon, with its name as a tooltip. */
function RailDrive({ drive, here }: { drive: DriveInfo; here: boolean }) {
  const navigate = useNavigate();
  const style = `flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${state(here)}`;
  return drive.unlocked ? (
    <Link
      to={driveUrl(drive.name)}
      title={drive.name}
      aria-label={drive.name}
      aria-current={here ? "page" : undefined}
      className={style}
    >
      <DriveIcon drive={drive} />
    </Link>
  ) : (
    <button
      type="button"
      title={`Unlock ${drive.name}`}
      aria-label={`Unlock ${drive.name}`}
      onClick={() => navigate("/", unlockState(drive.name))}
      className={style}
    >
      <DriveIcon drive={drive} />
    </button>
  );
}

function SettingsMenu({ onMasterPassword }: { onMasterPassword: () => void }) {
  const [theme, setTheme] = useTheme();
  return (
    <Menu label="Settings" align="start" width="w-60" trigger={<Settings size={17} aria-hidden="true" />}>
      {(close) => (
        <>
          <MenuHeading>Appearance</MenuHeading>
          <Segmented
            label="Appearance"
            className="mx-2 mb-1.5"
            value={theme}
            onChange={setTheme}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
          <MenuDivider />
          <MenuItem
            onSelect={() => {
              close();
              onMasterPassword();
            }}
          >
            <KeyRound size={16} />
            Change master password
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

/**
 * On every page: all drives, the folder tree of the unlocked ones, and, at the
 * foot, locking everything and the settings. Folders open only when their
 * arrow is pressed; "Show current folder" opens the tree down to the folder
 * being viewed. As a rail (`rail`) it shows only icons; in a drawer (`onClose`), all of it.
 */
export default function Sidebar({
  rail = false,
  onToggleRail,
  onClose,
  onMasterPassword,
}: {
  rail?: boolean;
  onToggleRail?: () => void;
  onClose?: () => void;
  onMasterPassword: () => void;
}) {
  const navigate = useNavigate();
  const lockEverything = useLockEverything();
  const inFolder = useMatch("/d/:drive/:folderId");
  const inDrive = useMatch("/d/:drive");
  const drive = (inFolder ?? inDrive)?.params.drive ?? null;
  const folder = inFolder?.params.folderId ?? null;
  // The page's own listing, shared through the cache: the folders above the one being viewed.
  const listing = useQuery({
    queryKey: ["nodes", drive, folder],
    queryFn: () => api.list(drive ?? "", folder),
    enabled: drive !== null,
  });
  const drives = useQuery({ queryKey: ["drives"], queryFn: api.drives });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [reveal, setReveal] = useState(0);

  // Opens the drive and every folder above the one being viewed; the viewed
  // folder itself stays as it was.
  function showCurrent() {
    if (drive === null) return;
    const above = (listing.data?.path ?? []).slice(0, -1);
    const wanted = folder === null ? [] : [key(drive, null), ...above.map((c) => key(drive, c.id))];
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

  const createDrive = () => navigate("/", { state: { create: true } });
  const home = drive === null;

  if (rail) {
    return (
      <nav aria-label="Drives" className="flex h-full w-full flex-col items-center gap-1 px-2 py-3">
        <button
          type="button"
          onClick={onToggleRail}
          aria-label="Expand sidebar"
          title="Expand sidebar"
          className="group mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink hover:bg-ink/6"
        >
          <span className="group-hover:hidden group-focus-visible:hidden">
            <Mark />
          </span>
          <PanelLeft size={17} className="hidden group-hover:block group-focus-visible:block" aria-hidden="true" />
        </button>
        <Link
          to="/"
          title="All drives"
          aria-label="All drives"
          aria-current={home ? "page" : undefined}
          className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${state(home)}`}
        >
          <LayoutGrid size={16} className="opacity-70" aria-hidden="true" />
        </Link>
        <span className="my-2 h-px w-6 bg-line" />
        <div className="no-scrollbar flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">
          {drives.data?.map((d) => <RailDrive key={d.name} drive={d} here={drive === d.name} />)}
        </div>
        <button
          type="button"
          onClick={() => void lockEverything()}
          aria-label="Lock tgdrive"
          title="Lock tgdrive"
          className={ICON_BUTTON}
        >
          <Lock size={17} aria-hidden="true" />
        </button>
        <SettingsMenu onMasterPassword={onMasterPassword} />
      </nav>
    );
  }

  return (
    <nav aria-label="Drives" className="flex h-full w-full flex-col">
      <div className="flex h-16 shrink-0 items-center justify-between pl-5 pr-3">
        <Link to="/" className="flex items-center gap-2.5 rounded-md text-[15px] font-semibold tracking-tight">
          <Mark />
          tgdrive
        </Link>
        {onToggleRail && (
          <button
            type="button"
            onClick={onToggleRail}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            className={ICON_BUTTON}
          >
            <PanelLeft size={17} aria-hidden="true" />
          </button>
        )}
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close navigation" className={ICON_BUTTON}>
            <X size={18} aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="px-3">
        <Link to="/" aria-current={home ? "page" : undefined} className={`${ROW} pl-2.5 ${state(home)}`}>
          <LayoutGrid size={16} className="shrink-0 opacity-70" aria-hidden="true" />
          All drives
        </Link>
      </div>

      <div className="mt-6 flex items-center justify-between pb-1 pl-5 pr-3">
        <h2 className="text-xs text-muted">Drives</h2>
        <span className="flex">
          {folder !== null && (
            <button
              type="button"
              title="Show current folder"
              aria-label="Show current folder in tree"
              onClick={showCurrent}
              className={`${ICON_BUTTON} !h-7 !w-7`}
            >
              <LocateFixed size={14} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            title="Create drive"
            aria-label="Create drive"
            onClick={createDrive}
            className={`${ICON_BUTTON} !h-7 !w-7`}
          >
            <Plus size={15} aria-hidden="true" />
          </button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {drives.isPending && <p className="px-2.5 py-1 text-sm text-muted">Loading…</p>}
        <ul className="space-y-px">
          {drives.data?.map((d) => (
            <DriveRow
              key={d.name}
              drive={d}
              current={{ drive, folder, reveal }}
              expanded={expanded}
              onToggle={toggle}
            />
          ))}
        </ul>
      </div>

      <div className="flex shrink-0 items-center gap-1 p-3">
        <button
          type="button"
          onClick={() => void lockEverything()}
          className={`${ROW} pl-2.5 ${state(false)}`}
          title="Lock every drive and ask for the master password again"
        >
          <Lock size={16} className="shrink-0 opacity-70" aria-hidden="true" />
          Lock tgdrive
        </button>
        <SettingsMenu onMasterPassword={onMasterPassword} />
      </div>
    </nav>
  );
}
