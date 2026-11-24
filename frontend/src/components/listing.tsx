import { ArrowDown, ArrowUp, BookOpen, Download, FileText, Music, Play } from "lucide-react";
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { Link } from "react-router-dom";

import { api, type Entry } from "../api";
import { driveUrl, formatDate, formatSize, previewKind, typeName } from "../format";
import type { Sort, SortKey } from "../sorting";
import { cachedThumbnail, hasThumbnail, loadThumbnail, useThumbnailVersion } from "../thumbs";
import { KindIcon } from "./details";
import { scrollToRow, useVisibleRows } from "./rows";
import { ICON_BUTTON } from "./ui";

/** A row scrolled straight past doesn't ask for its thumbnail. */
const THUMB_DELAY = 100;

/** Fetched once it has been in view for a moment, a few at a time; an icon until then or if there is none. */
function Thumb({ drive, entry, large = false }: { drive: string; entry: Entry; large?: boolean }) {
  const wanted = hasThumbnail(entry);
  const [url, setUrl] = useState<string | null | undefined>(() => (wanted ? cachedThumbnail(drive, entry.id) : null));
  const version = useThumbnailVersion(drive, entry.id);

  useEffect(() => {
    if (!wanted) return setUrl(null);
    const cached = cachedThumbnail(drive, entry.id);
    if (cached !== undefined) return setUrl(cached);
    let live = true;
    const timer = setTimeout(() => {
      void loadThumbnail(drive, entry.id).then((u) => live && setUrl(u));
    }, THUMB_DELAY);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [drive, entry.id, entry.thumb, wanted, version]);

  const box = large ? "aspect-[4/3] w-full rounded-t-[11px] bg-ink/4" : "h-9 w-9 rounded-lg bg-ink/5";
  return (
    <span className={`relative flex shrink-0 items-center justify-center overflow-hidden ${box}`}>
      {url ? (
        <>
          <img src={url} alt="" className="h-full w-full object-contain" draggable={false} />
          <KindBadge entry={entry} large={large} />
        </>
      ) : (
        <KindIcon entry={entry} size={large ? 38 : 17} className="shrink-0" />
      )}
    </span>
  );
}

const BADGES = {
  video: { Icon: Play, label: "Video" },
  comic: { Icon: BookOpen, label: "Comic" },
  audio: { Icon: Music, label: "Audio" },
  pdf: { Icon: FileText, label: "PDF" },
} as const;

/** On a thumbnail, says it isn't simply a picture: a video, the cover of a comic or album, or a PDF's first page. */
function KindBadge({ entry, large }: { entry: Entry; large: boolean }) {
  const kind = previewKind(entry.name, entry.size);
  if (kind !== "video" && kind !== "comic" && kind !== "audio" && kind !== "pdf") return null;
  const { Icon, label } = BADGES[kind];
  return (
    <span
      title={label}
      className={`absolute flex items-center rounded bg-black/65 text-white ${large ? "bottom-1.5 left-1.5 gap-1 px-1.5 py-0.5 text-xs" : "bottom-0.5 left-0.5 p-0.5"}`}
    >
      <Icon size={large ? 12 : 9} className={kind === "video" ? "fill-current" : ""} aria-hidden="true" />
      {large ? label : <span className="sr-only">{label}</span>}
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
  if (previewKind(entry.name, entry.size)) {
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

/** What the page asks of a listing, whose items may not all be drawn. */
export type ListingHandle = {
  /** Scrolls an item into view. */
  reveal: (index: number) => void;
  /** The item a row up or down from another; on the first or last row, the first or last item. */
  rowAway: (dir: 1 | -1, from: number) => number;
};

/** What the list and the grid both need from the page. */
export type ListingProps = {
  handle: Ref<ListingHandle>;
  drive: string;
  entries: Entry[];
  selected: Set<string>;
  /** The item the keyboard is on. */
  cursor: string | null;
  claimClick: (index: number) => (e: MouseEvent) => void;
  onToggle: (index: number, range: boolean) => void;
  onPreview: (entry: Entry) => void;
  /** Where a search result lives; null in a folder. */
  locationOf: (entry: Entry) => string | null;
  menu: (entry: Entry) => ReactNode;
};

function SelectBox({ entry, checked, onToggle }: { entry: Entry; checked: boolean; onToggle: (range: boolean) => void }) {
  return (
    <input
      type="checkbox"
      aria-label={`Select ${entry.name}`}
      checked={checked}
      // A checkbox's change event is a click, so it carries the Shift key.
      onChange={(e) => onToggle((e.nativeEvent as unknown as globalThis.MouseEvent).shiftKey)}
    />
  );
}

/** Shown on hover or keyboard focus; always where there is no hover. */
const ON_HOVER =
  "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100";

/** Below these widths a column's contents move under the name, or go. */
const TYPE_COLUMN = "hidden w-40 shrink-0 truncate @4xl:block";
const SIZE_COLUMN = "hidden w-20 shrink-0 text-right @xl:block";
const ADDED_COLUMN = "hidden w-28 shrink-0 text-right @3xl:block";

/** A list row's height, and the space above the first. */
const ROW = 52;
const LIST_TOP = 4;

export function ListView({
  handle,
  drive,
  entries,
  selected,
  cursor,
  claimClick,
  onToggle,
  onPreview,
  locationOf,
  menu,
  sort,
  onSort,
  onSelectAll,
  onDownloadZip,
}: ListingProps & {
  sort: Sort | null;
  onSort: (key: SortKey) => void;
  onSelectAll: () => void;
  onDownloadZip: (entry: Entry) => void;
}) {
  const count = entries.reduce((n, e) => n + Number(selected.has(e.id)), 0);
  const all = count === entries.length;
  const list = useRef<HTMLUListElement>(null);
  const { from, to } = useVisibleRows(list, entries.length, ROW, LIST_TOP);

  useImperativeHandle(
    handle,
    () => ({
      reveal: (index) => list.current && scrollToRow(list.current, LIST_TOP + index * ROW, ROW),
      rowAway: (dir, at) => Math.min(Math.max(at + dir, 0), entries.length - 1),
    }),
    [entries.length],
  );

  /** A header that sorts by its column; clicking it again flips the direction. */
  function column(key: SortKey, label: string) {
    const active = sort?.key === key;
    const Arrow = sort?.desc ? ArrowDown : ArrowUp;
    return (
      <button
        type="button"
        onClick={() => onSort(key)}
        aria-label={active ? `${label}, sorted ${sort?.desc ? "descending" : "ascending"}` : `Sort by ${label.toLowerCase()}`}
        title={`Sort by ${label.toLowerCase()}`}
        className={`inline-flex h-6 items-center gap-1 rounded hover:text-ink ${active ? "text-ink" : ""}`}
      >
        {label}
        {active && <Arrow size={12} aria-hidden="true" />}
      </button>
    );
  }

  return (
    <>
      <div className="sticky top-[6.5rem] z-10 -mx-2 flex h-9 items-center gap-3 border-b border-line bg-paper px-2 text-xs text-muted">
        <input
          type="checkbox"
          aria-label="Select all"
          checked={all}
          ref={(el) => {
            if (el) el.indeterminate = count > 0 && !all;
          }}
          onChange={onSelectAll}
        />
        <span className="min-w-0 flex-1 pl-12">{column("name", "Name")}</span>
        <span className={TYPE_COLUMN}>{column("type", "Type")}</span>
        <span className={SIZE_COLUMN}>{column("size", "Size")}</span>
        <span className={ADDED_COLUMN}>{column("created", "Added")}</span>
        <span className="w-8 shrink-0 @2xl:w-[68px]" aria-hidden="true" />
      </div>
      <ul
        ref={list}
        className="-mx-2 [overflow-anchor:none]"
        style={{ paddingTop: LIST_TOP + from * ROW, paddingBottom: (entries.length - to) * ROW }}
      >
        {entries.slice(from, to).map((entry, n) => {
          const i = from + n;
          const place = locationOf(entry);
          const size = entry.kind === "file" ? formatSize(entry.size) : null;
          return (
            <li
              key={entry.id}
              data-entry={entry.id}
              aria-current={cursor === entry.id || undefined}
              aria-setsize={entries.length}
              aria-posinset={i + 1}
              className={`group relative flex h-[52px] select-none items-center gap-3 rounded-lg px-2 ${selected.has(entry.id) ? "bg-accent/12" : "hover:bg-ink/4"} ${cursor === entry.id ? "outline-2 -outline-offset-2 outline-accent/70" : ""}`}
            >
              <span className="relative z-[1] flex">
                <SelectBox entry={entry} checked={selected.has(entry.id)} onToggle={(range) => onToggle(i, range)} />
              </span>
              {/* Its ::after covers the row, so anywhere on it opens the item. */}
              <Opener
                drive={drive}
                entry={entry}
                onClick={claimClick(i)}
                onPreview={() => onPreview(entry)}
                className="flex min-w-0 flex-1 items-center gap-3 outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
              >
                <Thumb drive={drive} entry={entry} />
                <span className="min-w-0">
                  <span className="block truncate text-sm">{entry.name}</span>
                  {place ? (
                    <span className="block truncate text-xs text-muted">{place}</span>
                  ) : (
                    <span className="block truncate text-xs text-muted @xl:hidden">
                      {[size, formatDate(entry.created_at)].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </span>
              </Opener>

              <span className={`${TYPE_COLUMN} text-[13px] text-muted`}>
                {entry.kind === "dir" ? "Folder" : typeName(entry.name, entry.size)}
              </span>
              <span className={`${SIZE_COLUMN} text-[13px] tabular-nums text-muted`}>{size}</span>
              <span className={`${ADDED_COLUMN} text-[13px] tabular-nums text-muted`}>{formatDate(entry.created_at)}</span>

              <span className="relative z-[1] flex shrink-0 items-center gap-1">
                {entry.kind === "file" ? (
                  <a
                    href={api.fileUrl(drive, entry.id)}
                    download={entry.name}
                    aria-label={`Download ${entry.name}`}
                    title="Download"
                    className={`${ICON_BUTTON} ${ON_HOVER} @max-2xl:hidden`}
                  >
                    <Download size={16} />
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={() => onDownloadZip(entry)}
                    aria-label={`Download ${entry.name} as zip`}
                    title="Download as zip"
                    className={`${ICON_BUTTON} ${ON_HOVER} @max-2xl:hidden`}
                  >
                    <Download size={16} />
                  </button>
                )}
                {menu(entry)}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Both grids share their columns, so folders line up with the files below them. */
const GRID =
  "grid grid-cols-[repeat(auto-fill,minmax(8.75rem,1fr))] gap-3 @3xl:grid-cols-[repeat(auto-fill,minmax(12.5rem,1fr))]";

/** How a grid is laid out now: its columns, how tall a tile is (they all are the
 * same), and from the top of one row to the top of the next. */
function gridShape(grid: HTMLElement): { columns: number; height: number; stride: number } {
  const style = getComputedStyle(grid);
  const height = grid.firstElementChild?.getBoundingClientRect().height ?? 0;
  return {
    columns: style.gridTemplateColumns.split(" ").length,
    height,
    stride: height && height + parseFloat(style.rowGap),
  };
}

/** A grid of which only the rows in or near view are drawn. */
function Grid({
  grid,
  count,
  children,
}: {
  grid: RefObject<HTMLUListElement | null>;
  count: number;
  children: (from: number, to: number) => ReactNode;
}) {
  const [{ columns, stride }, setShape] = useState({ columns: 6, stride: 0 });

  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    const measure = () => {
      const next = gridShape(el);
      setShape((old) => (old.columns === next.columns && old.stride === next.stride ? old : next));
    };
    measure();
    // The columns follow the width, and the tiles' height follows theirs.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [grid]);

  const rows = Math.ceil(count / columns);
  const { from, to } = useVisibleRows(grid, rows, stride);
  return (
    <ul
      ref={grid}
      className={`${GRID} [overflow-anchor:none]`}
      style={{ paddingTop: from * stride, paddingBottom: (rows - to) * stride }}
    >
      {children(from * columns, Math.min(to * columns, count))}
    </ul>
  );
}

/** Leading folders are small tiles, a name each; everything after them gets a picture. */
export function GridView(props: ListingProps) {
  const { handle, entries, selected } = props;
  const firstOther = entries.findIndex((e) => e.kind !== "dir");
  const folders = firstOther < 0 ? entries.length : firstOther;
  const selecting = entries.some((e) => selected.has(e.id));
  const folderGrid = useRef<HTMLUListElement>(null);
  const fileGrid = useRef<HTMLUListElement>(null);

  useImperativeHandle(handle, () => {
    /** The grid an item is in, and which of the items are in it (`end` excluded). */
    const gridOf = (index: number) =>
      index < folders
        ? { el: folderGrid.current, start: 0, end: folders }
        : { el: fileGrid.current, start: folders, end: entries.length };
    return {
      reveal(index) {
        const { el, start } = gridOf(index);
        if (!el) return;
        const { columns, height, stride } = gridShape(el);
        scrollToRow(el, Math.floor((index - start) / columns) * stride, height);
      },
      rowAway(dir, at) {
        const { el, start, end } = gridOf(at);
        if (!el) return at;
        const { columns } = gridShape(el);
        const column = (at - start) % columns;
        // The row's first item. Both grids have the same columns, so a column carries over.
        const row = at - column + dir * columns;
        if (row >= start && row < end) return Math.min(row + column, end - 1);
        if (dir > 0) return end < entries.length ? Math.min(end + column, entries.length - 1) : entries.length - 1;
        if (start === 0) return 0;
        return Math.min(Math.floor((start - 1) / columns) * columns + column, start - 1);
      },
    };
  }, [folders, entries.length]);

  return (
    <div className="space-y-5 pt-3">
      {folders > 0 && (
        <Grid key="folders" grid={folderGrid} count={folders}>
          {(from, to) =>
            entries
              .slice(from, to)
              .map((entry, n) => (
                <FolderTile key={entry.id} {...props} entry={entry} index={from + n} selecting={selecting} />
              ))
          }
        </Grid>
      )}
      {folders < entries.length && (
        <Grid key="files" grid={fileGrid} count={entries.length - folders}>
          {(from, to) =>
            entries
              .slice(folders + from, folders + to)
              .map((entry, n) => (
                <Tile key={entry.id} {...props} entry={entry} index={folders + from + n} selecting={selecting} />
              ))
          }
        </Grid>
      )}
    </div>
  );
}

type TileProps = ListingProps & { entry: Entry; index: number; selecting: boolean };

const tile = (selected: boolean, cursor: boolean) =>
  `group relative select-none rounded-xl border transition-colors ${selected ? "border-accent bg-accent/12 ring-1 ring-accent" : "border-line bg-surface hover:border-ink/30"} ${cursor ? "outline-2 outline-offset-2 outline-accent/70" : ""}`;

function FolderTile({ drive, entries, entry, index, selecting, selected, cursor, claimClick, onToggle, onPreview, locationOf, menu }: TileProps) {
  const isSelected = selected.has(entry.id);
  const place = locationOf(entry);
  return (
    <li
      data-entry={entry.id}
      aria-current={cursor === entry.id || undefined}
      aria-setsize={entries.length}
      aria-posinset={index + 1}
      className={`${tile(isSelected, cursor === entry.id)} flex h-14 items-center pr-1.5`}
    >
      <Opener
        drive={drive}
        entry={entry}
        onClick={claimClick(index)}
        onPreview={() => onPreview(entry)}
        className="flex h-full min-w-0 flex-1 items-center gap-3 rounded-xl pl-3.5 outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:outline-2 focus-visible:after:outline-accent"
      >
        <KindIcon
          entry={entry}
          size={20}
          className={`shrink-0 ${selecting ? "invisible" : "group-focus-within:invisible group-hover:invisible [@media(hover:none)]:visible!"}`}
        />
        <span className="min-w-0">
          <span className="block truncate text-[13px]">{entry.name}</span>
          {place && <span className="block truncate text-xs text-muted">{place}</span>}
        </span>
      </Opener>
      {/* Takes the icon's place. */}
      <span
        className={`absolute left-4 top-1/2 z-[1] flex -translate-y-1/2 ${selecting ? "" : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:hidden"}`}
      >
        <SelectBox entry={entry} checked={isSelected} onToggle={(range) => onToggle(index, range)} />
      </span>
      <span className="relative z-[1]">{menu(entry)}</span>
    </li>
  );
}

function Tile({ drive, entries, entry, index, selecting, selected, cursor, claimClick, onToggle, onPreview, locationOf, menu }: TileProps) {
  const isSelected = selected.has(entry.id);
  return (
    <li
      data-entry={entry.id}
      aria-current={cursor === entry.id || undefined}
      aria-setsize={entries.length}
      aria-posinset={index + 1}
      className={tile(isSelected, cursor === entry.id)}
    >
      <Opener
        drive={drive}
        entry={entry}
        onClick={claimClick(index)}
        onPreview={() => onPreview(entry)}
        className="block w-full rounded-xl"
      >
        <Thumb drive={drive} entry={entry} large />
        <span className="block py-2 pl-3 pr-10">
          <span className="block truncate text-[13px]">{entry.name}</span>
          <span className="block truncate text-xs text-muted">
            {locationOf(entry) ?? (entry.kind === "file" ? formatSize(entry.size) : "Folder")}
          </span>
        </span>
      </Opener>
      <span className={`absolute left-2 top-2 flex rounded-md bg-surface/90 p-1 shadow-sm ${selecting ? "" : ON_HOVER}`}>
        <SelectBox entry={entry} checked={isSelected} onToggle={(range) => onToggle(index, range)} />
      </span>
      <span className="absolute bottom-2.5 right-1.5">{menu(entry)}</span>
    </li>
  );
}

/** Rows to look at while a folder loads. */
export function ListingSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="animate-pulse pt-10">
      {[46, 30, 58, 38, 50, 26].map((width) => (
        <div key={width} className="flex h-[52px] items-center gap-3">
          <span className="h-9 w-9 rounded-lg bg-ink/6" />
          <span className="h-3 rounded bg-ink/6" style={{ width: `${width}%` }} />
        </div>
      ))}
    </div>
  );
}
