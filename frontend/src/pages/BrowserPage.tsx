import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  File as FileIcon,
  FileText,
  Film,
  Folder,
  FolderInput,
  FolderPlus,
  FolderUp,
  Image as ImageIcon,
  KeyRound,
  Lock,
  LockOpen,
  Music,
  Pencil,
  Search,
  ShieldPlus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { api, ApiError, type Crumb, type DriveInfo, type Entry } from "../api";
import {
  DeleteDriveDialog,
  DrivePasswordDialog,
  RecoveryKeyDialog,
  RenameDriveDialog,
  type PasswordAction,
} from "../components/driveDialogs";
import { DeleteNodeDialog, MoveDialog, NameDialog, PreviewDialog } from "../components/fileDialogs";
import Sidebar from "../components/Sidebar";
import { Button, ErrorNote, ICON_BUTTON, Menu, MenuItem, PageHeader, useSavedView, ViewToggle } from "../components/ui";
import { pickedFromInput, readDropped, useUploads, type Picked } from "../components/uploads";
import { driveUrl, formatDate, formatSize, previewKind } from "../format";
import { cachedThumbnail, forgetThumbnails, hasThumbnail, loadThumbnail } from "../thumbs";

type Open =
  | { type: "newFolder" }
  | { type: "rename"; entry: Entry }
  | { type: "move"; entries: Entry[] }
  | { type: "delete"; entries: Entry[] }
  | { type: "preview"; entry: Entry }
  | { type: "password"; action: PasswordAction }
  | { type: "recoveryKey"; recoveryKey: string }
  | { type: "renameDrive" }
  | { type: "deleteDrive" }
  | null;

function EntryIcon({ entry, size = 20 }: { entry: Entry; size?: number }) {
  if (entry.kind === "dir") return <Folder size={size} className="shrink-0 text-brass" aria-hidden="true" />;
  const kind = previewKind(entry.name);
  const Icon =
    kind === "image" ? ImageIcon : kind === "video" ? Film : kind === "audio" ? Music : kind ? FileText : FileIcon;
  return <Icon size={size} className="shrink-0 text-muted" aria-hidden="true" />;
}

/** Fetched when scrolled into view, a few at a time; an icon until then or if there is none. */
function Thumb({ drive, entry, large = false }: { drive: string; entry: Entry; large?: boolean }) {
  const wanted = hasThumbnail(entry);
  const [url, setUrl] = useState<string | null | undefined>(() => (wanted ? cachedThumbnail(drive, entry.id) : null));
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!wanted) return setUrl(null);
    const cached = cachedThumbnail(drive, entry.id);
    if (cached !== undefined) return setUrl(cached);
    const el = ref.current;
    if (!el) return;
    let live = true;
    const observer = new IntersectionObserver(
      (items) => {
        if (!items.some((i) => i.isIntersecting)) return;
        observer.disconnect();
        void loadThumbnail(drive, entry.id).then((u) => live && setUrl(u));
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [drive, entry.id, entry.thumb, wanted]);

  const box = large
    ? "flex aspect-square w-full items-center justify-center overflow-hidden rounded-t-lg bg-ink/[0.04]"
    : "flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md";
  return (
    <span ref={ref} className={`${box} ${url && !large ? "bg-ink/[0.04]" : ""}`}>
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        <EntryIcon entry={entry} size={large ? 40 : 20} />
      )}
    </span>
  );
}

/** Opens a folder, previews a file it can show, or downloads it. A click that
 * the parent claims for selection (preventDefault) does none of those. */
function Opener({
  drive,
  entry,
  onClick,
  onPreview,
  className,
  children,
}: {
  drive: string;
  entry: Entry;
  onClick: (e: MouseEvent) => void;
  onPreview: () => void;
  className: string;
  children: ReactNode;
}) {
  if (entry.kind === "dir") {
    return (
      <Link to={driveUrl(drive, entry.id)} onClick={onClick} className={className}>
        {children}
      </Link>
    );
  }
  if (previewKind(entry.name)) {
    return (
      <button
        type="button"
        onClick={(e) => {
          onClick(e);
          if (!e.defaultPrevented) onPreview();
        }}
        className={`${className} text-left`}
      >
        {children}
      </button>
    );
  }
  return (
    <a href={api.fileUrl(drive, entry.id)} download={entry.name} onClick={onClick} className={className}>
      {children}
    </a>
  );
}

/** Where a search result lives, e.g. "Photos › Trips › Italy". */
function where(drive: string, path: Crumb[]): string {
  return [drive, ...path.map((c) => c.name)].join(" › ");
}

/** Shortcuts stay off while typing, but not while a selection checkbox has focus. */
const typingIn = (target: EventTarget | null) => {
  if (target instanceof HTMLInputElement) return !["checkbox", "radio", "button", "submit"].includes(target.type);
  return target instanceof HTMLElement && (target.isContentEditable || ["TEXTAREA", "SELECT"].includes(target.tagName));
};

export default function BrowserPage() {
  const { drive = "", folderId } = useParams();
  const parent = folderId ?? null;
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const uploads = useUploads();

  const [open, setOpen] = useState<Open>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [view, changeView] = useSavedView("tgdrive.view");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const anchor = useRef<number | null>(null);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  // The search lives in the URL, so Back returns to the results after opening one.
  const [params, setParams] = useSearchParams();
  const query = (params.get("q") ?? "").trim();
  const [typed, setTyped] = useState(query);
  // Follow the URL (Back, opening a folder) without undoing a space typed between words.
  useEffect(() => setTyped((t) => (t.trim() === query ? t : query)), [query]);
  useEffect(() => {
    if (typed.trim() === query) return;
    const timer = setTimeout(() => setParams(typed.trim() ? { q: typed.trim() } : {}, { replace: true }), 250);
    return () => clearTimeout(timer);
  }, [typed, query, setParams]);
  const searching = query !== "";

  const listing = useQuery({ queryKey: ["nodes", drive, parent], queryFn: () => api.list(drive, parent) });
  // Under "nodes", so every change that refreshes the folder refreshes the results too.
  const search = useQuery({
    queryKey: ["nodes", drive, "search", query],
    queryFn: () => api.search(drive, query),
    enabled: searching,
    placeholderData: keepPreviousData,
  });
  const drives = useQuery({ queryKey: ["drives"], queryFn: api.drives });
  const info = drives.data?.find((d) => d.name === drive);
  const status = listing.error instanceof ApiError ? listing.error.status : null;
  const driveLocked = listing.error instanceof ApiError && listing.error.locked === "drive";

  // The drive was locked elsewhere or timed out: ask for its password, then come back here.
  // (A locked vault is handled above the router, by the login screen.)
  const settled = !listing.isFetching;
  useEffect(() => {
    if (driveLocked && settled) {
      navigate("/", { replace: true, state: { unlock: drive, from: location.pathname } });
    }
  }, [driveLocked, settled, drive, location.pathname, navigate]);

  // Navigation is a transition: dropping the old name's cache any sooner would refetch it under that name.
  const renamedFrom = useRef<string | null>(null);
  useEffect(() => {
    const old = renamedFrom.current;
    if (old === null || old === drive) return;
    renamedFrom.current = null;
    queryClient.removeQueries({ queryKey: ["nodes", old] });
    forgetThumbnails(old);
  }, [drive, queryClient]);

  useEffect(() => {
    setNotice(null);
    setSelected(new Set());
    anchor.current = null;
  }, [drive, parent, query]);

  // While searching, results stand in for the folder: selection and actions work the same.
  const results = searching ? (search.data?.results ?? []) : [];
  const locations = new Map<string, Crumb[]>(results.map((r) => [r.id, r.path]));
  const entries: Entry[] = searching ? results : (listing.data?.entries ?? []);
  const crumbs = listing.data?.path ?? [];
  const chosen = entries.filter((e) => selected.has(e.id));
  const selecting = chosen.length > 0;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["nodes", drive] });
  const close = () => setOpen(null);
  const clearSelection = () => {
    setSelected(new Set());
    anchor.current = null;
  };

  function toggle(index: number, range: boolean) {
    const id = entries[index].id;
    setSelected((prev) => {
      const next = new Set(prev);
      if (range && anchor.current !== null) {
        const [from, to] = anchor.current < index ? [anchor.current, index] : [index, anchor.current];
        for (let i = from; i <= to; i += 1) next.add(entries[i].id);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!range) anchor.current = index;
  }

  /** While anything is selected, or with Ctrl/Cmd held, a click selects instead of opening. */
  const claimClick = (index: number) => (e: MouseEvent) => {
    if (selecting || e.ctrlKey || e.metaKey || e.shiftKey) {
      e.preventDefault();
      toggle(index, e.shiftKey);
    }
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (open || typingIn(e.target) || document.querySelector("dialog[open]")) return;
      if (e.key === "/") {
        e.preventDefault();
        searchInput.current?.focus();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && entries.length > 0) {
        e.preventDefault();
        setSelected(new Set(entries.map((x) => x.id)));
      } else if (e.key === "Escape" && selecting) {
        clearSelection();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selecting) {
        e.preventDefault();
        setOpen({ type: "delete", entries: chosen });
      } else if (e.key === "F2" && chosen.length === 1) {
        e.preventDefault();
        setOpen({ type: "rename", entry: chosen[0] });
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  function addFiles(files: Picked[], emptyFolders: string[][] = []) {
    if (files.length > 0 || emptyFolders.length > 0) uploads.enqueue(drive, parent, files, emptyFolders);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    setNotice(null);
    // Folders are read in after the drop, so `parent` is captured now.
    const target = { drive, parent };
    readDropped(e.dataTransfer).then(
      ({ files, folders }) => {
        if (files.length > 0 || folders.length > 0) uploads.enqueue(target.drive, target.parent, files, folders);
      },
      () => setNotice("Some of what was dropped couldn't be read. Try choosing it with Upload instead."),
    );
  }

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  function leaveDrive() {
    queryClient.removeQueries({ queryKey: ["nodes", drive] });
    forgetThumbnails(drive);
    void queryClient.invalidateQueries({ queryKey: ["drives"] });
    navigate("/");
  }

  async function lockDrive() {
    await api.lock(drive).catch(() => undefined);
    leaveDrive();
  }

  function itemMenu(entry: Entry) {
    return (
      <Menu label={`More actions for ${entry.name}`}>
        {(closeMenu) => {
          const pick = (next: Open) => () => {
            closeMenu();
            setOpen(next);
          };
          return (
            <>
              {entry.kind === "file" && (
                <a
                  role="menuitem"
                  href={api.fileUrl(drive, entry.id)}
                  download={entry.name}
                  onClick={closeMenu}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-ink hover:bg-ink/5"
                >
                  <Download size={16} />
                  Download
                </a>
              )}
              {locations.has(entry.id) && (
                <MenuItem
                  onSelect={() => {
                    closeMenu();
                    const path = locations.get(entry.id) ?? [];
                    navigate(driveUrl(drive, path.length ? path[path.length - 1].id : null));
                  }}
                >
                  <FolderInput size={16} />
                  Show in folder
                </MenuItem>
              )}
              <MenuItem onSelect={pick({ type: "rename", entry })}>
                <Pencil size={16} />
                Rename
              </MenuItem>
              <MenuItem onSelect={pick({ type: "move", entries: [entry] })}>
                <FolderInput size={16} />
                Move
              </MenuItem>
              <MenuItem danger onSelect={pick({ type: "delete", entries: [entry] })}>
                <Trash2 size={16} />
                Delete
              </MenuItem>
            </>
          );
        }}
      </Menu>
    );
  }

  function checkbox(entry: Entry, index: number, className = "") {
    return (
      <input
        type="checkbox"
        aria-label={`Select ${entry.name}`}
        checked={selected.has(entry.id)}
        // A checkbox's change event is a click, so it carries the Shift key.
        onChange={(e) => toggle(index, (e.nativeEvent as unknown as globalThis.MouseEvent).shiftKey)}
        className={`h-4 w-4 shrink-0 accent-[var(--teal)] ${className}`}
      />
    );
  }

  const allSelected = entries.length > 0 && chosen.length === entries.length;

  return (
    <div
      className="min-h-screen"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault();
      }}
      onDrop={onDrop}
    >
      <PageHeader wide>
        {info?.protected && (
          <Button onClick={() => void lockDrive()}>
            <Lock size={16} />
            Lock drive
          </Button>
        )}
        <Menu label="Drive settings">
          {(closeMenu) => {
            const pick = (next: Open) => () => {
              closeMenu();
              setOpen(next);
            };
            return (
              <>
                {info?.protected ? (
                  <>
                    <MenuItem onSelect={pick({ type: "password", action: "change" })}>
                      <KeyRound size={16} />
                      Change password
                    </MenuItem>
                    <MenuItem onSelect={pick({ type: "password", action: "remove" })}>
                      <LockOpen size={16} />
                      Remove password
                    </MenuItem>
                  </>
                ) : (
                  <MenuItem onSelect={pick({ type: "password", action: "add" })}>
                    <ShieldPlus size={16} />
                    Add a password
                  </MenuItem>
                )}
                <MenuItem onSelect={pick({ type: "renameDrive" })}>
                  <Pencil size={16} />
                  Rename drive
                </MenuItem>
                <MenuItem danger onSelect={pick({ type: "deleteDrive" })}>
                  <Trash2 size={16} />
                  Delete drive
                </MenuItem>
              </>
            );
          }}
        </Menu>
      </PageHeader>

      <div className="flex">
        <aside className="sticky top-0 hidden h-screen w-64 shrink-0 self-start overflow-y-auto border-r border-line lg:block">
          <Sidebar drive={drive} folder={parent} path={crumbs} />
        </aside>

        <main className="mx-auto min-w-0 max-w-4xl flex-1 px-5 pb-32 pt-6">
          <Link
            to="/"
            className="-ml-1 inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-sm text-muted hover:bg-ink/5 hover:text-ink"
          >
            <ArrowLeft size={16} aria-hidden="true" />
            All drives
          </Link>
          <nav aria-label="Folder path" className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1">
            <Link
              to={driveUrl(drive)}
              className={`rounded px-1 text-3xl font-semibold tracking-tight hover:bg-ink/5 ${crumbs.length ? "text-muted" : ""}`}
            >
              {drive}
            </Link>
            {crumbs.map((c, i) => (
              <span key={c.id} className="flex min-w-0 items-center gap-1">
                <ChevronRight size={20} className="shrink-0 text-muted" aria-hidden="true" />
                <Link
                  to={driveUrl(drive, c.id)}
                  aria-current={i === crumbs.length - 1 ? "page" : undefined}
                  className={`truncate rounded px-1 text-3xl font-semibold tracking-tight hover:bg-ink/5 ${i === crumbs.length - 1 ? "" : "text-muted"}`}
                >
                  {c.name}
                </Link>
              </span>
            ))}
          </nav>

          <div className="mt-6 flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => fileInput.current?.click()}>
              <Upload size={16} />
              Upload files
            </Button>
            <Button onClick={() => folderInput.current?.click()}>
              <FolderUp size={16} />
              Upload folder
            </Button>
            <Button onClick={() => setOpen({ type: "newFolder" })}>
              <FolderPlus size={16} />
              New folder
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                addFiles(pickedFromInput(e.target.files));
                e.target.value = "";
              }}
            />
            <input
              ref={(el) => {
                folderInput.current = el;
                // Not in React's types. The browser then hands over every file inside, each with its path.
                el?.setAttribute("webkitdirectory", "");
              }}
              type="file"
              hidden
              onChange={(e) => {
                addFiles(pickedFromInput(e.target.files));
                e.target.value = "";
              }}
            />
            <label className="relative order-last w-full sm:order-none sm:ml-auto sm:w-64">
              <span className="sr-only">Search {drive}</span>
              <Search
                size={16}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
                aria-hidden="true"
              />
              <input
                ref={searchInput}
                type="search"
                placeholder={`Search ${drive}`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setTyped("");
                    setParams({}, { replace: true });
                    e.currentTarget.blur();
                  }
                }}
                className="w-full rounded-md border border-line bg-surface py-2 pl-9 pr-3 text-sm text-ink placeholder:text-muted focus:border-teal"
              />
            </label>
            <ViewToggle view={view} onChange={changeView} className="ml-auto sm:ml-0" />
          </div>

          {notice && (
            <p className="mt-4 rounded-md border border-brass/50 bg-brass/10 px-3 py-2 text-sm" role="status">
              {notice}
            </p>
          )}

          {selecting && (
            <div
              role="toolbar"
              aria-label="Selection"
              className="sticky top-2 z-10 mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-teal/40 bg-surface px-3 py-2 shadow-md"
            >
              <span className="mr-auto text-sm font-medium" aria-live="polite">
                {chosen.length} selected
              </span>
              {chosen.length === 1 && chosen[0].kind === "file" && (
                <a
                  href={api.fileUrl(drive, chosen[0].id)}
                  download={chosen[0].name}
                  className="inline-flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium hover:bg-ink/5"
                >
                  <Download size={16} />
                  Download
                </a>
              )}
              {chosen.length === 1 && (
                <Button className="py-1.5" onClick={() => setOpen({ type: "rename", entry: chosen[0] })}>
                  <Pencil size={16} />
                  Rename
                </Button>
              )}
              <Button className="py-1.5" onClick={() => setOpen({ type: "move", entries: chosen })}>
                <FolderInput size={16} />
                Move
              </Button>
              <Button variant="danger" className="py-1.5" onClick={() => setOpen({ type: "delete", entries: chosen })}>
                <Trash2 size={16} />
                Delete
              </Button>
              <button type="button" onClick={clearSelection} aria-label="Clear selection" className={ICON_BUTTON}>
                <X size={18} />
              </button>
            </div>
          )}

          <div
            className={`mt-4 rounded-lg border ${dragging ? "border-dashed border-teal bg-teal/5" : "border-transparent"}`}
          >
            {searching && (
              <p className="pb-3 text-sm text-muted" aria-live="polite">
                {search.isPending
                  ? "Searching…"
                  : search.error
                    ? ""
                    : search.data && search.data.total > search.data.results.length
                      ? `Showing the best ${search.data.results.length} of ${search.data.total} matches in ${drive}.`
                      : `${search.data?.total ?? 0} ${search.data?.total === 1 ? "match" : "matches"} in ${drive}.`}
              </p>
            )}
            {searching && search.error && <ErrorNote>{search.error.message}</ErrorNote>}

            {!searching && listing.isPending && <p className="py-10 text-muted">Loading…</p>}

            {!searching && listing.error && !driveLocked && status !== 401 && (
              <div className="space-y-3 py-6">
                <ErrorNote>{status === 404 ? "This folder no longer exists." : listing.error.message}</ErrorNote>
                {status === 404 && (
                  <Link to={driveUrl(drive)} className="text-sm text-teal underline underline-offset-2">
                    Go to the top of {drive}
                  </Link>
                )}
              </div>
            )}

            {searching && search.data && entries.length === 0 && (
              <p className="border-y border-line py-12 text-muted">
                Nothing in {drive} has a name matching “{query}”.
              </p>
            )}

            {!searching && listing.data && entries.length === 0 && (
              <p className="border-y border-line py-12 text-muted">
                {dragging
                  ? "Drop to upload here."
                  : "This folder is empty. Drop files or folders here, or choose Upload files."}
              </p>
            )}

            {entries.length > 0 && view === "list" && (
              <>
                <div className="flex items-center gap-3 border-t border-line px-1 py-2 text-xs font-medium uppercase tracking-wide text-muted">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = selecting && !allSelected;
                    }}
                    onChange={() => (allSelected ? clearSelection() : setSelected(new Set(entries.map((e) => e.id))))}
                    className="h-4 w-4 accent-[var(--teal)]"
                  />
                  <span className="flex-1 pl-[52px]">Name</span>
                  <span className="hidden w-24 text-right sm:block">Size</span>
                  <span className="hidden w-28 text-right md:block">Added</span>
                  <span className="w-[68px]" aria-hidden="true" />
                </div>
                <ul className="divide-y divide-line border-y border-line">
                  {entries.map((entry, i) => (
                    <li
                      key={entry.id}
                      className={`flex items-center gap-3 pl-1 ${selected.has(entry.id) ? "bg-teal/10" : "hover:bg-ink/[0.03]"}`}
                    >
                      {checkbox(entry, i)}
                      <Opener
                        drive={drive}
                        entry={entry}
                        onClick={claimClick(i)}
                        onPreview={() => setOpen({ type: "preview", entry })}
                        className="flex min-w-0 flex-1 items-center gap-3 py-2"
                      >
                        <Thumb drive={drive} entry={entry} />
                        <span className="min-w-0">
                          <span className={`block truncate ${entry.kind === "dir" ? "font-medium" : ""}`}>
                            {entry.name}
                          </span>
                          {locations.has(entry.id) && (
                            <span className="block truncate text-xs text-muted">
                              {where(drive, locations.get(entry.id) ?? [])}
                            </span>
                          )}
                        </span>
                      </Opener>

                      <span className="hidden w-24 shrink-0 text-right text-sm tabular-nums text-muted sm:block">
                        {entry.kind === "file" ? formatSize(entry.size) : ""}
                      </span>
                      <span className="hidden w-28 shrink-0 text-right text-sm text-muted md:block">
                        {formatDate(entry.created_at)}
                      </span>

                      <div className="flex shrink-0 items-center">
                        {entry.kind === "file" ? (
                          <a
                            href={api.fileUrl(drive, entry.id)}
                            download={entry.name}
                            aria-label={`Download ${entry.name}`}
                            title="Download"
                            className={ICON_BUTTON}
                          >
                            <Download size={18} />
                          </a>
                        ) : (
                          <span className="w-[34px]" aria-hidden="true" />
                        )}
                        {itemMenu(entry)}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {entries.length > 0 && view === "grid" && (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {entries.map((entry, i) => {
                  const isSelected = selected.has(entry.id);
                  return (
                    <li
                      key={entry.id}
                      className={`group relative rounded-lg border bg-surface ${isSelected ? "border-teal ring-2 ring-teal" : "border-line hover:border-muted"}`}
                    >
                      <Opener
                        drive={drive}
                        entry={entry}
                        onClick={claimClick(i)}
                        onPreview={() => setOpen({ type: "preview", entry })}
                        className="block w-full"
                      >
                        <Thumb drive={drive} entry={entry} large />
                        <span className="block px-2.5 py-2">
                          <span className={`block truncate text-sm ${entry.kind === "dir" ? "font-medium" : ""}`}>
                            {entry.name}
                          </span>
                          <span className="block truncate text-xs text-muted">
                            {locations.has(entry.id)
                              ? where(drive, locations.get(entry.id) ?? [])
                              : entry.kind === "file"
                                ? formatSize(entry.size)
                                : "Folder"}
                          </span>
                        </span>
                      </Opener>
                      <span
                        className={`absolute left-2 top-2 flex rounded bg-surface/90 p-1 shadow-sm ${selecting || isSelected ? "" : "opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"}`}
                      >
                        {checkbox(entry, i)}
                      </span>
                      <span className="absolute right-1 top-1 rounded-md bg-surface/90 opacity-0 shadow-sm focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                        {itemMenu(entry)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}

            {entries.length > 0 && (
              <p className="mt-3 text-xs text-muted">
                Ctrl/Cmd-click or Shift-click to select several. Ctrl/Cmd+A selects everything, Delete deletes the
                selection, F2 renames, / searches.
              </p>
            )}
          </div>
        </main>
      </div>

      {open?.type === "newFolder" && (
        <NameDialog
          title="New folder"
          label="Folder name"
          action="Create folder"
          busyAction="Creating…"
          onClose={close}
          onSubmit={async (name) => {
            await api.createFolder(drive, parent, name);
            await refresh();
            close();
          }}
        />
      )}
      {open?.type === "rename" && (
        <NameDialog
          title={`Rename ${open.entry.name}`}
          label="New name"
          initial={open.entry.name}
          action="Rename"
          busyAction="Renaming…"
          onClose={close}
          onSubmit={async (name) => {
            await api.rename(drive, open.entry.id, name);
            await refresh();
            close();
          }}
        />
      )}
      {open?.type === "move" && (
        <MoveDialog
          drive={drive}
          entries={open.entries}
          from={searching ? undefined : parent}
          onClose={close}
          onMoved={() => {
            clearSelection();
            void refresh();
            close();
          }}
        />
      )}
      {open?.type === "delete" && (
        <DeleteNodeDialog
          entries={open.entries}
          onClose={close}
          onConfirm={async () => {
            await api.removeMany(
              drive,
              open.entries.map((e) => e.id),
            );
            clearSelection();
            await refresh();
            close();
          }}
        />
      )}
      {open?.type === "preview" && <PreviewDialog drive={drive} entry={open.entry} onClose={close} />}
      {open?.type === "password" && (
        <DrivePasswordDialog
          drive={drive}
          action={open.action}
          onClose={close}
          onDone={(recoveryKey) => {
            void queryClient.invalidateQueries({ queryKey: ["drives"] });
            if (recoveryKey) setOpen({ type: "recoveryKey", recoveryKey });
            else close();
          }}
        />
      )}
      {open?.type === "recoveryKey" && (
        <RecoveryKeyDialog
          title={`Save the recovery key for ${drive}`}
          recoveryKey={open.recoveryKey}
          action="Done"
          onDone={close}
        >
          If you forget this drive's password, this key is the only way back into it.
        </RecoveryKeyDialog>
      )}
      {open?.type === "renameDrive" && (
        <RenameDriveDialog
          drive={drive}
          onClose={close}
          onRenamed={(name) => {
            uploads.renameDrive(drive, name);
            // The list shows the new name straight away; the old name's cache goes once the page has moved.
            queryClient.setQueryData<DriveInfo[]>(["drives"], (list) =>
              list?.map((d) => (d.name === drive ? { ...d, name } : d)),
            );
            renamedFrom.current = drive;
            navigate(`${driveUrl(name, parent)}${location.search}`, { replace: true });
            close();
          }}
        />
      )}
      {open?.type === "deleteDrive" && (
        <DeleteDriveDialog drive={drive} isProtected={info?.protected ?? true} onClose={close} onDeleted={leaveDrive} />
      )}
    </div>
  );
}
