import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleHelp,
  Download,
  Folder,
  FolderInput,
  HardDrive,
  Images,
  Info,
  KeyRound,
  Lock,
  LockOpen,
  Network,
  PanelRight,
  Pencil,
  RefreshCw,
  SearchX,
  ShieldPlus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { api, ApiError, type Crumb, type DriveInfo, type Entry } from "../api";
import {
  DeleteDriveDialog,
  DrivePasswordDialog,
  RecoveryKeyDialog,
  RenameDriveDialog,
  WebDavDialog,
  type PasswordAction,
} from "../components/driveDialogs";
import { AddCards, AddMenu, Breadcrumbs, FilterTabs, SearchBox, SelectionBar, ShortcutsDialog } from "../components/browserBars";
import { DetailsDialog, DetailsPanel } from "../components/details";
import { BulkRenameDialog, type Renamed } from "../components/BulkRenameDialog";
import { DeleteNodeDialog, MoveDialog, NameDialog } from "../components/fileDialogs";
import { GridView, ListingSkeleton, ListView, type ListingHandle, type ListingProps } from "../components/listing";
import { Menu, MENU_ROW, MenuDivider, MenuItem } from "../components/menu";
import { Dock, Page, scrollToTop, Toast, Topbar } from "../components/shell";
import { SortMenu } from "../components/SortMenu";
import { Viewer } from "../components/viewer";
import { Button, ErrorNote, ICON_BUTTON, useSavedView, ViewToggle } from "../components/ui";
import { pickedFromInput, readDropped, useUploads, type Picked } from "../components/uploads";
import { category, countCategories, type Category } from "../filters";
import { refreshSoon } from "../refresh";
import type { RenameItem } from "../rename";
import { useSavedFlag } from "../saved";
import { DEFAULT_SORT, sortByColumn, sortEntries, useSavedSort, type Sort } from "../sorting";
import { driveUrl, formatSize, previewKind } from "../format";
import { forgetThumbnails, hasNoCover, makeThumbnail, MAKE_PARALLEL, regenerateThumbnail } from "../thumbs";

type Open =
  | { type: "newFolder" }
  | { type: "rename"; entry: Entry }
  | { type: "bulkRename"; items: RenameItem[]; others: Map<string | null, Set<string>> }
  | { type: "move"; entries: Entry[] }
  | { type: "delete"; entries: Entry[] }
  | { type: "preview"; entry: Entry }
  | { type: "details"; entry: Entry }
  | { type: "password"; action: PasswordAction }
  | { type: "recoveryKey"; recoveryKey: string }
  | { type: "renameDrive" }
  | { type: "deleteDrive" }
  | { type: "webdav" }
  | { type: "shortcuts" }
  | null;

/** Where a search result lives, e.g. "Photos › Trips › Italy". */
function where(drive: string, path: Crumb[]): string {
  return [drive, ...path.map((c) => c.name)].join(" › ");
}

/** The search as the URL has it. Clearing it forgets that it was widened to the whole drive. */
function searchParams(typed: string, wide: boolean): Record<string, string> {
  const q = typed.trim();
  if (!q) return {};
  return wide ? { q, in: "drive" } : { q };
}

/** "6 folders, 14 files, 8.1 MB". */
function summarize(entries: Entry[]): string {
  const files = entries.filter((e) => e.kind === "file");
  const folders = entries.length - files.length;
  const parts = [];
  if (folders) parts.push(`${folders.toLocaleString()} ${folders === 1 ? "folder" : "folders"}`);
  if (files.length) {
    parts.push(`${files.length.toLocaleString()} ${files.length === 1 ? "file" : "files"}`);
    parts.push(formatSize(files.reduce((sum, e) => sum + e.size, 0)));
  }
  return parts.join(", ") || "Empty";
}

/** In place of a listing there is nothing in. */
function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-4 py-20 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-ink/6 text-muted">{icon}</span>
      <p className="mt-4 max-w-full break-words text-sm font-medium">{title}</p>
      {children && <p className="mt-1 max-w-sm text-pretty text-sm text-muted">{children}</p>}
    </div>
  );
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
  /** The last bulk rename, until something else happens, so it can be undone. */
  const [undoable, setUndoable] = useState<Renamed[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [filter, setFilter] = useState<Category | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  /** The cards for adding files are in view, so the top bar needn't offer it too. */
  const [cardsInView, setCardsInView] = useState(true);
  const [view, changeView] = useSavedView("tgdrive.view");
  const [folderSort, setFolderSort] = useSavedSort();
  /** Search results come ranked by relevance (null) unless a sort is picked; that choice lasts the search. */
  const [searchSort, setSearchSort] = useState<Sort | null>(null);
  const [showDetails, setShowDetails] = useSavedFlag("tgdrive.details");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const anchor = useRef<number | null>(null);
  /** The item the keyboard is on (highlighted, not necessarily selected). */
  const [cursor, setCursor] = useState<string | null>(null);
  /** Set when the cursor moves by keyboard, so the item scrolls into view. */
  const reveal = useRef(false);
  const listingHandle = useRef<ListingHandle>(null);
  /** Type-ahead: letters typed in quick succession jump to a name starting with them. */
  const typeahead = useRef({ text: "", at: 0 });
  /** The folder just left, to land on it when its parent opens. */
  const lastFolder = useRef<string | null>(null);
  const returnTo = useRef<string | null>(null);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  // The search lives in the URL, so Back returns to the results after opening one.
  const [params, setParams] = useSearchParams();
  const query = (params.get("q") ?? "").trim();
  /** The folder a search stays inside, at any depth; null for the whole drive, which `?in=drive` widens it to. */
  const wide = params.get("in") === "drive";
  const scope = wide ? null : parent;
  const [typed, setTyped] = useState(query);
  // Follow the URL (Back, opening a folder) without undoing a space typed between words.
  useEffect(() => setTyped((t) => (t.trim() === query ? t : query)), [query]);
  useEffect(() => {
    if (typed.trim() === query) return;
    const timer = setTimeout(() => setParams(searchParams(typed, wide), { replace: true }), 250);
    return () => clearTimeout(timer);
  }, [typed, query, wide, setParams]);
  const searching = query !== "";
  useEffect(() => {
    if (!searching) setSearchSort(null);
  }, [searching]);
  const sort = searching ? searchSort : folderSort;
  const changeSort = (next: Sort) => (searching ? setSearchSort(next) : setFolderSort(next));

  const listing = useQuery({ queryKey: ["nodes", drive, parent], queryFn: () => api.list(drive, parent) });
  // Under "nodes", so every change that refreshes the folder refreshes the results too.
  const search = useQuery({
    queryKey: ["nodes", drive, "search", query, scope],
    queryFn: () => api.search(drive, query, scope),
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

  // Uploads left unfinished (a closed tab, a reload) show up once the drive opens, to resume or discard.
  const opened = listing.isSuccess;
  const { adopt } = uploads;
  useEffect(() => {
    if (opened) adopt(drive);
  }, [opened, drive, adopt]);

  // Navigation is a transition: dropping the old name's cache any sooner would refetch it under that name.
  const renamedFrom = useRef<string | null>(null);
  useEffect(() => {
    const old = renamedFrom.current;
    if (old === null || old === drive) return;
    renamedFrom.current = null;
    queryClient.removeQueries({ queryKey: ["nodes", old] });
    forgetThumbnails(old);
  }, [drive, queryClient]);

  // Making a folder's thumbnails, one file at a time. Leaving the folder stops it.
  const [making, setMaking] = useState<{ done: number; total: number } | null>(null);
  const makingRun = useRef<AbortController | null>(null);

  useEffect(() => {
    setNotice(null);
    setUndoable(null);
    setSelected(new Set());
    setCursor(null);
    setFilter(null);
    scrollToTop();
    anchor.current = null;
    returnTo.current = lastFolder.current;
    lastFolder.current = parent;
    return () => {
      makingRun.current?.abort();
      makingRun.current = null;
      setMaking(null);
    };
  }, [drive, parent, query, scope]);

  // While searching, results stand in for the folder: selection and actions work the same.
  const results = useMemo(() => (searching ? (search.data?.results ?? []) : []), [searching, search.data]);
  const locations = new Map<string, Crumb[]>(results.map((r) => [r.id, r.path]));
  /** All of the folder, or of the results. `entries` is what the tabs leave of it. */
  const everything: Entry[] = useMemo(() => {
    const raw = searching ? results : (listing.data?.entries ?? []);
    return sort ? sortEntries(raw, sort) : raw;
  }, [searching, results, listing.data, sort]);
  const counts = useMemo(() => countCategories(everything), [everything]);
  // The last of its kind may have been deleted, or moved.
  const shownFilter = counts.some(([c]) => c === filter) ? filter : null;
  const entries = useMemo(
    () => (shownFilter ? everything.filter((e) => category(e) === shownFilter) : everything),
    [everything, shownFilter],
  );
  const summary = useMemo(() => summarize(everything), [everything]);
  const crumbs = listing.data?.path ?? [];
  const chosen = entries.filter((e) => selected.has(e.id));
  const locationOf = (entry: Entry) => where(drive, locations.get(entry.id) ?? crumbs);
  const selecting = chosen.length > 0;

  const cursorIndex = cursor === null ? -1 : entries.findIndex((e) => e.id === cursor);
  const cursorEntry = cursorIndex >= 0 ? entries[cursorIndex] : null;
  /** What an action applies to: the selection, or else the highlighted item. */
  const targets = selecting ? chosen : cursorEntry ? [cursorEntry] : [];

  // Back in a folder's parent: highlight the folder just left, as file managers do.
  useEffect(() => {
    const id = returnTo.current;
    if (id === null || searching || !entries.some((e) => e.id === id)) return;
    returnTo.current = null;
    reveal.current = true;
    setCursor(id);
  }, [entries, searching]);

  useEffect(() => {
    if (!reveal.current || cursor === null) return;
    reveal.current = false;
    if (cursorIndex >= 0) listingHandle.current?.reveal(cursorIndex);
  }, [cursor, cursorIndex]);

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
    setCursor(entries[index].id);
    if (selecting || e.ctrlKey || e.metaKey || e.shiftKey) {
      e.preventDefault();
      toggle(index, e.shiftKey);
    }
  };

  /** What clicking it does, without the click: folders open, files preview or download. */
  function openEntry(entry: Entry) {
    if (entry.kind === "dir") navigate(driveUrl(drive, entry.id));
    else if (previewKind(entry.name, entry.size)) setOpen({ type: "preview", entry });
    else {
      const link = document.createElement("a");
      link.href = api.fileUrl(drive, entry.id);
      link.download = entry.name;
      link.click();
    }
  }

  function goUp() {
    if (searching || parent === null) return;
    navigate(driveUrl(drive, crumbs.length > 1 ? crumbs[crumbs.length - 2].id : null));
  }

  function rowsAway(dir: 1 | -1, rows: number): number {
    let at = cursorIndex;
    for (let n = 0; n < rows; n += 1) at = listingHandle.current?.rowAway(dir, at) ?? at;
    return at;
  }

  /** Moves the highlight; with Shift, the selection stretches from where it started to here. */
  function moveCursor(to: number, extend: boolean) {
    if (entries.length === 0) return;
    const index = Math.min(Math.max(to, 0), entries.length - 1);
    if (extend) {
      const from = anchor.current ?? (cursorIndex >= 0 ? cursorIndex : index);
      anchor.current = from;
      const [a, b] = from < index ? [from, index] : [index, from];
      setSelected(new Set(entries.slice(a, b + 1).map((x) => x.id)));
    }
    reveal.current = true;
    setCursor(entries[index].id);
  }

  function jumpToTyped(key: string) {
    const now = Date.now();
    const t = typeahead.current;
    t.text = now - t.at < 800 ? t.text + key.toLocaleLowerCase() : key.toLocaleLowerCase();
    t.at = now;
    // A repeated single letter steps through the names starting with it.
    const cycling = t.text.length > 1 && [...t.text].every((c) => c === t.text[0]);
    const prefix = cycling ? t.text[0] : t.text;
    const start = cursorIndex < 0 ? 0 : cycling || t.text.length === 1 ? cursorIndex + 1 : cursorIndex;
    for (let k = 0; k < entries.length; k += 1) {
      const i = (start + k) % entries.length;
      if (entries[i].name.toLocaleLowerCase().startsWith(prefix)) return moveCursor(i, false);
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (open || typingIn(e.target) || document.querySelector("dialog[open]")) return;
      const mod = e.ctrlKey || e.metaKey;
      // Enter and Space on a focused button or link belong to it.
      const onControl =
        e.target instanceof HTMLElement && e.target !== document.body && e.target.closest("a, button, summary, input, [role=menu]");
      const page = view === "grid" ? 3 : 10;
      const here = cursorIndex;
      // The first arrow press lands on the first item (or the last, going up) rather than skipping it.
      const step = (by: number) => (here < 0 ? (by > 0 ? 0 : entries.length - 1) : here + by);
      const stepRows = (dir: 1 | -1, rows: number) => (here < 0 ? step(dir) : rowsAway(dir, rows));
      if (e.key === "/") {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchInput.current?.focus());
      } else if (e.key === "?") {
        e.preventDefault();
        setOpen({ type: "shortcuts" });
      } else if (mod && e.key.toLowerCase() === "a" && entries.length > 0) {
        e.preventDefault();
        setSelected(new Set(entries.map((x) => x.id)));
      } else if (e.key === "Escape" && (selecting || cursor !== null)) {
        if (selecting) clearSelection();
        else setCursor(null);
      } else if (e.key === "ArrowUp" && e.altKey) {
        e.preventDefault();
        goUp();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        moveCursor(stepRows(e.key === "ArrowDown" ? 1 : -1, 1), e.shiftKey);
      } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && view === "grid" && !e.altKey) {
        e.preventDefault();
        moveCursor(step(e.key === "ArrowRight" ? 1 : -1), e.shiftKey);
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        moveCursor(e.key === "Home" ? 0 : entries.length - 1, e.shiftKey);
      } else if (e.key === "PageDown" || e.key === "PageUp") {
        e.preventDefault();
        moveCursor(stepRows(e.key === "PageDown" ? 1 : -1, page), e.shiftKey);
      } else if (e.key === "Enter" && cursorEntry && !onControl) {
        e.preventDefault();
        openEntry(cursorEntry);
      } else if (e.key === " " && cursorEntry && !onControl) {
        e.preventDefault();
        toggle(cursorIndex, e.shiftKey);
      } else if ((e.key === "Delete" || (e.key === "Backspace" && selecting)) && targets.length > 0) {
        e.preventDefault();
        setOpen({ type: "delete", entries: targets });
      } else if (e.key === "Backspace") {
        e.preventDefault();
        goUp();
      } else if (e.key === "F2" && targets.length > 0) {
        e.preventDefault();
        setOpen(targets.length === 1 ? { type: "rename", entry: targets[0] } : { type: "bulkRename", ...renameItems(targets) });
      } else if (e.key.length === 1 && !mod && !e.altKey && e.key !== " " && entries.length > 0) {
        jumpToTyped(e.key);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  function addFiles(files: Picked[], emptyFolders: string[][] = []) {
    if (files.length > 0 || emptyFolders.length > 0) uploads.enqueue(drive, parent, files, emptyFolders);
  }

  // Dropped anywhere in the window, the sidebar included: a miss would make the browser open the file.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    function onEnter(e: DragEvent) {
      if (!hasFiles(e)) return;
      dragDepth.current += 1;
      setDragging(true);
    }
    function onLeave(e: DragEvent) {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    }
    function onOver(e: DragEvent) {
      if (hasFiles(e)) e.preventDefault();
    }
    function onDrop(e: DragEvent) {
      if (!e.dataTransfer || !hasFiles(e)) return;
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
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  });

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

  /** Folders and multiple items arrive as one zip, named after a lone folder or the folder they are in. */
  async function downloadZip(items: Entry[]) {
    setNotice(null);
    try {
      const { url } = await api.createZip(
        drive,
        items.map((e) => e.id),
        crumbs.length ? crumbs[crumbs.length - 1].name : drive,
      );
      const link = document.createElement("a");
      link.href = url;
      link.click();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : "The zip couldn't be started.");
    }
  }

  /** Puts back the names a bulk rename replaced, if nothing has taken them since. */
  async function undoRename(renamed: Renamed[]) {
    setNotice(null);
    try {
      await api.renameMany(
        drive,
        renamed.map((r) => ({ id: r.id, name: r.from })),
      );
      setUndoable(null);
    } catch (err) {
      setNotice(err instanceof ApiError ? `Couldn't undo: ${err.message}` : "Couldn't undo the rename.");
    }
    await refresh();
  }

  /** What the bulk rename dialog needs: each item's folder, and the names there it mustn't take. */
  function renameItems(items: Entry[]) {
    const ids = new Set(items.map((e) => e.id));
    const list = items.map((entry) => {
      const path = searching ? (locations.get(entry.id) ?? []) : crumbs;
      const last = path[path.length - 1];
      return { entry, parent: searching ? (last?.id ?? null) : parent, parentName: last?.name ?? drive };
    });
    // Only the folder on screen is known in full; for search results the server checks.
    const others = new Map<string | null, Set<string>>();
    if (!searching) others.set(parent, new Set(everything.filter((e) => !ids.has(e.id)).map((e) => e.name)));
    return { items: list, others };
  }

  /** Images, videos, comics, PDFs and audio (its cover art); others have nothing to draw one from. */
  const canThumbnail = (entry: Entry) =>
    entry.kind === "file" && ["image", "video", "comic", "pdf", "audio"].includes(previewKind(entry.name, entry.size) ?? "");

  const missingThumbnails = searching ? [] : everything.filter((e) => canThumbnail(e) && !e.thumb && !hasNoCover(drive, e.id));

  /** A few files at a time, so Telegram and the browser's connections stay free for browsing. */
  async function makeThumbnails() {
    const todo = missingThumbnails;
    if (makingRun.current || todo.length === 0) return;
    const run = new AbortController();
    makingRun.current = run;
    setNotice(null);
    setMaking({ done: 0, total: todo.length });
    let done = 0;
    let failed = 0;
    let bare = 0;
    const rest = todo.values();   // shared: each worker takes the next file
    async function work() {
      for (const entry of rest) {
        if (run.signal.aborted) return;
        const made = await makeThumbnail(drive, entry, run.signal);
        if (run.signal.aborted) return;
        if (made) refreshSoon(queryClient, drive);
        else if (hasNoCover(drive, entry.id)) bare += 1;
        else failed += 1;
        done += 1;
        setMaking({ done, total: todo.length });
      }
    }
    await Promise.all(Array.from({ length: MAKE_PARALLEL }, work));
    if (run.signal.aborted) return;
    makingRun.current = null;
    setMaking(null);
    const notes = [];
    if (failed) notes.push(`${failed} of ${todo.length} files couldn't get a thumbnail.`);
    if (bare) notes.push(`${bare} audio ${bare === 1 ? "file has" : "files have"} no cover art.`);
    if (notes.length) setNotice(notes.join(" "));
  }

  function stopMakingThumbnails() {
    makingRun.current?.abort();
    makingRun.current = null;
    setMaking(null);
  }

  async function remakeThumbnail(entry: Entry) {
    setNotice(null);
    const made = await regenerateThumbnail(drive, entry);
    void refresh();
    if (made) return;
    setNotice(
      hasNoCover(drive, entry.id)
        ? `${entry.name} has no cover art.`
        : `A thumbnail couldn't be made for ${entry.name}.`,
    );
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
                  className={`${MENU_ROW} text-ink [&>svg]:text-muted`}
                >
                  <Download size={16} />
                  Download
                </a>
              )}
              {entry.kind === "dir" && (
                <MenuItem
                  onSelect={() => {
                    closeMenu();
                    void downloadZip([entry]);
                  }}
                >
                  <Download size={16} />
                  Download as zip
                </MenuItem>
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
              <MenuItem onSelect={pick({ type: "details", entry })}>
                <Info size={16} />
                Details
              </MenuItem>
              {canThumbnail(entry) && (
                <MenuItem
                  onSelect={() => {
                    closeMenu();
                    void remakeThumbnail(entry);
                  }}
                >
                  <RefreshCw size={16} />
                  Regenerate thumbnail
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
              <MenuDivider />
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

  const allSelected = entries.length > 0 && chosen.length === entries.length;
  const selectAll = () => setSelected(new Set(entries.map((e) => e.id)));
  const here = crumbs.length ? crumbs[crumbs.length - 1].name : drive;
  /** What a search looks through, by name. */
  const searched = scope === null ? drive : crumbs.length ? here : "this folder";
  // Results of the last search stay up while the next one runs; what's said about them would be wrong.
  const stale = search.isPending || search.isPlaceholderData;
  const trouble = !searching && listing.error && !driveLocked && status !== 401 ? listing.error : null;
  const adds = {
    onUpload: () => fileInput.current?.click(),
    onUploadFolder: () => folderInput.current?.click(),
    onNewFolder: () => setOpen({ type: "newFolder" }),
  };
  const listingProps: ListingProps = {
    handle: listingHandle,
    drive,
    entries,
    selected,
    cursor,
    claimClick,
    onToggle: toggle,
    onPreview: (entry) => setOpen({ type: "preview", entry }),
    locationOf: (entry) => (locations.has(entry.id) ? where(drive, locations.get(entry.id) ?? []) : null),
    menu: itemMenu,
  };

  function clearSearch() {
    setTyped("");
    setParams({}, { replace: true });
  }

  function driveMenu() {
    return (
      <Menu label="Drive settings">
        {(closeMenu) => {
          const pick = (next: Open) => () => {
            closeMenu();
            setOpen(next);
          };
          return (
            <>
              {info?.protected && (
                <MenuItem
                  onSelect={() => {
                    closeMenu();
                    void lockDrive();
                  }}
                >
                  <Lock size={16} />
                  Lock drive
                </MenuItem>
              )}
              <MenuItem onSelect={pick({ type: "renameDrive" })}>
                <Pencil size={16} />
                Rename drive
              </MenuItem>
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
              <MenuItem onSelect={pick({ type: "webdav" })}>
                <Network size={16} />
                WebDAV access
              </MenuItem>
              <MenuItem onSelect={pick({ type: "shortcuts" })}>
                <CircleHelp size={16} />
                Keyboard shortcuts
              </MenuItem>
              <MenuDivider />
              <MenuItem danger onSelect={pick({ type: "deleteDrive" })}>
                <Trash2 size={16} />
                Delete drive
              </MenuItem>
            </>
          );
        }}
      </Menu>
    );
  }

  return (
    <>
      <Page>
        <Topbar>
          <div className={`flex min-w-0 flex-1 ${searchOpen || typed ? "@max-2xl:hidden" : ""}`}>
            <Breadcrumbs drive={drive} path={crumbs} />
          </div>
          <SearchBox
            label={`Search ${searched}`}
            value={typed}
            onChange={setTyped}
            onClear={clearSearch}
            expanded={searchOpen || typed !== ""}
            onExpand={setSearchOpen}
            inputRef={searchInput}
          />
          {!cardsInView && !searching && !trouble && (
            <span className="hidden @2xl:block">
              <AddMenu {...adds} />
            </span>
          )}
          {info?.protected && (
            <button
              type="button"
              onClick={() => void lockDrive()}
              aria-label="Lock drive"
              title="Lock drive"
              className={`${ICON_BUTTON} @max-2xl:hidden`}
            >
              <Lock size={17} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            aria-pressed={showDetails}
            aria-label="Details panel"
            title={showDetails ? "Hide details" : "Show details"}
            onClick={() => setShowDetails(!showDetails)}
            className={`${ICON_BUTTON} !hidden xl:!inline-flex ${showDetails ? "bg-ink/9 !text-ink" : ""}`}
          >
            <PanelRight size={17} aria-hidden="true" />
          </button>
          {driveMenu()}
        </Topbar>

        <main className="shrink-0 px-4 pb-32 pt-6 @3xl:px-8">
          {!trouble && (
            <>
              <h1 className="truncate text-2xl font-semibold tracking-tight" title={searching ? undefined : here}>
                {searching ? `Results for “${query}”` : here}
              </h1>
              {/* One line of a fixed height: the thumbnails button comes and goes without moving anything. */}
              <div className="mt-1 flex h-7 items-center gap-3 text-sm text-muted">
                <p className="truncate" aria-live="polite">
                  {searching
                    ? stale
                      ? "Searching…"
                      : search.error
                        ? ""
                        : search.data && search.data.total > search.data.results.length
                          ? `The best ${search.data.results.length} of ${search.data.total} matches in ${searched}`
                          : `${search.data?.total ?? 0} ${search.data?.total === 1 ? "match" : "matches"} in ${searched}`
                    : listing.data
                      ? summary
                      : "Loading…"}
                </p>
                {searching && parent !== null && (
                  <button
                    type="button"
                    onClick={() => setParams(searchParams(typed, !wide), { replace: true })}
                    className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-ink/6 px-2.5 text-[13px] text-ink transition-colors hover:bg-ink/10"
                  >
                    {wide ? <Folder size={14} aria-hidden="true" /> : <HardDrive size={14} aria-hidden="true" />}
                    {wide ? "Search this folder only" : "Search whole drive"}
                  </button>
                )}
                {!making && missingThumbnails.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void makeThumbnails()}
                    title={`${missingThumbnails.length} images, videos, comics, PDFs and audio files here have no thumbnail`}
                    className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-ink/6 px-2.5 text-[13px] text-ink transition-colors hover:bg-ink/10"
                  >
                    <Images size={14} aria-hidden="true" />
                    Make {missingThumbnails.length.toLocaleString()}{" "}
                    {missingThumbnails.length === 1 ? "thumbnail" : "thumbnails"}
                  </button>
                )}
              </div>
            </>
          )}

          {!searching && !trouble && <AddCards {...adds} onVisible={setCardsInView} />}
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

          {searching && search.error && <ErrorNote>{search.error.message}</ErrorNote>}

          {trouble && (
            <div className="max-w-lg space-y-3">
              <ErrorNote>{status === 404 ? "This folder no longer exists." : trouble.message}</ErrorNote>
              {status === 404 && (
                <Link to={driveUrl(drive)} className="text-sm text-accent underline underline-offset-2">
                  Go to the top of {drive}
                </Link>
              )}
            </div>
          )}

          {(searching ? search.isPending : listing.isPending) && <ListingSkeleton />}

          {everything.length > 0 && (
            <div className="sticky top-14 z-20 -mx-4 mt-3 flex h-12 items-center gap-2 bg-paper px-4 @3xl:-mx-8 @3xl:px-8">
              <FilterTabs
                counts={counts}
                total={everything.length}
                value={shownFilter}
                onChange={(next) => {
                  setFilter(next);
                  clearSelection();
                  setCursor(null);
                }}
              />
              <SortMenu sort={sort} onChange={changeSort} relevance={searching} onRelevance={() => setSearchSort(null)} />
              <ViewToggle view={view} onChange={changeView} />
            </div>
          )}

          {searching && search.data && !stale && entries.length === 0 && (
            <Empty icon={<SearchX size={20} aria-hidden="true" />} title="No matches">
              Nothing in {searched} has a name matching “{query}”.
            </Empty>
          )}

          {!searching && listing.data && entries.length === 0 && (
            <Empty icon={<Upload size={20} aria-hidden="true" />} title="This folder is empty">
              Drop files or folders anywhere on this page, or add some.
            </Empty>
          )}

          {entries.length > 0 && view === "list" && (
            <ListView
              {...listingProps}
              sort={sort}
              onSort={(key) => changeSort(sortByColumn(sort ?? { ...DEFAULT_SORT, key: "type" }, key))}
              onSelectAll={() => (allSelected ? clearSelection() : selectAll())}
              onDownloadZip={(entry) => void downloadZip([entry])}
            />
          )}

          {entries.length > 0 && view === "grid" && <GridView {...listingProps} />}
        </main>

        <Dock>
          {notice && (
            <Toast>
              <span className="min-w-0">{notice}</span>
              <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className={ICON_BUTTON}>
                <X size={16} />
              </button>
            </Toast>
          )}
          {undoable && (
            <Toast>
              <span className="min-w-0 truncate">
                Renamed {undoable.length} {undoable.length === 1 ? "item" : "items"}
              </span>
              <span className="flex items-center">
                <Button size="sm" onClick={() => void undoRename(undoable)}>
                  Undo
                </Button>
                <button type="button" onClick={() => setUndoable(null)} aria-label="Dismiss" className={`${ICON_BUTTON} ml-1`}>
                  <X size={16} />
                </button>
              </span>
            </Toast>
          )}
          {making && (
            <Toast>
              <Images size={16} className="shrink-0 text-muted" aria-hidden="true" />
              <span className="min-w-0 truncate tabular-nums">
                Making thumbnails, {making.done} of {making.total}
              </span>
              <span
                className="hidden h-1 w-28 shrink-0 overflow-hidden rounded-full bg-ink/10 @lg:block"
                aria-hidden="true"
              >
                <span
                  className="block h-full rounded-full bg-accent transition-[width]"
                  style={{ width: `${(making.done / making.total) * 100}%` }}
                />
              </span>
              <Button size="sm" onClick={stopMakingThumbnails}>
                Stop
              </Button>
            </Toast>
          )}
          {selecting ? (
            <SelectionBar
              drive={drive}
              chosen={chosen}
              allSelected={allSelected}
              onSelectAll={selectAll}
              onInvert={() => {
                setSelected((prev) => new Set(entries.filter((x) => !prev.has(x.id)).map((x) => x.id)));
                anchor.current = null;
              }}
              onClear={clearSelection}
              onDownloadZip={() => void downloadZip(chosen)}
              onRename={() => setOpen({ type: "rename", entry: chosen[0] })}
              onBulkRename={() => setOpen({ type: "bulkRename", ...renameItems(chosen) })}
              onMove={() => setOpen({ type: "move", entries: chosen })}
              onDelete={() => setOpen({ type: "delete", entries: chosen })}
            />
          ) : (
            !searching &&
            !trouble && (
              <span className="self-end @2xl:hidden">
                <AddMenu floating {...adds} />
              </span>
            )
          )}
        </Dock>
      </Page>

      {showDetails && (
        <DetailsPanel
          drive={drive}
          chosen={chosen}
          here={searching ? `Matches for “${query}”` : here}
          entries={entries}
          locationOf={locationOf}
          onClose={() => setShowDetails(false)}
        />
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-paper/85 lg:absolute lg:inset-0">
          <div className="max-w-full px-6 text-center">
            <Upload size={28} className="mx-auto text-accent" aria-hidden="true" />
            <p className="mt-3 truncate text-lg font-semibold">Drop to upload to {here}</p>
            <p className="mt-1 text-sm text-muted">Files, or whole folders.</p>
          </div>
        </div>
      )}

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
      {open?.type === "bulkRename" && (
        <BulkRenameDialog
          drive={drive}
          items={open.items}
          others={open.others}
          onClose={close}
          onRenamed={(renamed) => {
            setUndoable(renamed);
            void refresh();
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
      {open?.type === "preview" && (
        <Viewer
          drive={drive}
          entries={entries}
          nearby={everything}
          start={open.entry}
          locationOf={locationOf}
          onClose={close}
        />
      )}
      {open?.type === "details" && (
        <DetailsDialog drive={drive} entry={open.entry} location={locationOf(open.entry)} onClose={close} />
      )}
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
      {open?.type === "webdav" && (
        <WebDavDialog
          drive={drive}
          isProtected={info?.protected ?? true}
          onClose={close}
          onChanged={() => void queryClient.invalidateQueries({ queryKey: ["drives"] })}
        />
      )}
      {open?.type === "deleteDrive" && (
        <DeleteDriveDialog drive={drive} isProtected={info?.protected ?? true} onClose={close} onDeleted={leaveDrive} />
      )}
      {open?.type === "shortcuts" && <ShortcutsDialog onClose={close} />}
    </>
  );
}
