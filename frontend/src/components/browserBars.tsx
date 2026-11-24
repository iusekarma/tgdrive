import {
  ChevronRight,
  Download,
  FolderInput,
  FolderPlus,
  FolderUp,
  Pencil,
  PencilRuler,
  Plus,
  Search,
  SquareCheck,
  SquareDashed,
  Trash2,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api, type Crumb, type Entry } from "../api";
import { CATEGORY_LABELS, type Category } from "../filters";
import { driveUrl } from "../format";
import { Menu, MenuItem } from "./menu";
import { Dialog, ICON_BUTTON } from "./ui";

/** The way to this folder, on one line: the folders in the middle fold into a menu. */
export function Breadcrumbs({ drive, path }: { drive: string; path: Crumb[] }) {
  const navigate = useNavigate();
  const all: { id: string | null; name: string }[] = [{ id: null, name: drive }, ...path];
  const hidden = all.length > 3 ? all.slice(1, -2) : [];
  const shown = hidden.length ? [all[0], ...all.slice(-2)] : all;
  return (
    <nav aria-label="Folder path" className="flex min-w-0 items-center text-sm">
      {shown.map((c, i) => {
        const last = i === shown.length - 1;
        return (
          <span
            key={c.id ?? ""}
            // On a narrow bar only where you are, and what it's in.
            className={`flex items-center ${last ? "min-w-12" : i < shown.length - 2 ? "max-w-40 shrink-0 @max-xl:hidden" : `@max-md:hidden ${i === 0 ? "max-w-40 shrink-0" : "min-w-16 shrink-2"}`}`}
          >
            {i > 0 && (
              <ChevronRight
                size={15}
                className={`shrink-0 text-muted/70 ${i === shown.length - 1 ? "@max-md:hidden" : "@max-xl:hidden"}`}
                aria-hidden="true"
              />
            )}
            <Link
              to={driveUrl(drive, c.id)}
              aria-current={last ? "page" : undefined}
              title={c.name}
              className={`truncate rounded-md px-1.5 py-1 transition-colors hover:bg-ink/6 ${last ? "" : "text-muted hover:text-ink"}`}
            >
              {c.name}
            </Link>
            {i === 0 && hidden.length > 0 && (
              <span className="flex items-center @max-xl:hidden">
                <ChevronRight size={15} className="shrink-0 text-muted/70" aria-hidden="true" />
                <Menu
                  label="Folders in between"
                  align="start"
                  trigger="…"
                  buttonClass="rounded-md px-1.5 py-1 text-muted hover:bg-ink/6 hover:text-ink"
                >
                  {(close) =>
                    hidden.map((h) => (
                      <MenuItem
                        key={h.id}
                        onSelect={() => {
                          close();
                          navigate(driveUrl(drive, h.id));
                        }}
                      >
                        <span className="truncate">{h.name}</span>
                      </MenuItem>
                    ))
                  }
                </Menu>
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/** The search box. On a narrow bar it is a button, until pressed or in use; then it takes the bar over (`expanded`). */
export function SearchBox({
  label,
  value,
  onChange,
  onClear,
  expanded,
  onExpand,
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  return (
    <>
      {!expanded && (
        <button
          type="button"
          aria-label={label}
          title={`${label} (/)`}
          onClick={() => {
            onExpand(true);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
          className={`${ICON_BUTTON} @2xl:hidden`}
        >
          <Search size={17} aria-hidden="true" />
        </button>
      )}
      <label
        className={`group relative @2xl:block @2xl:w-52 @2xl:flex-none @4xl:w-72 ${expanded ? "block min-w-0 flex-1" : "hidden"}`}
      >
        <span className="sr-only">{label}</span>
        <Search
          size={15}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          type="text"
          role="searchbox"
          placeholder={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => value === "" && onExpand(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              onClear();
              e.currentTarget.blur();
            }
          }}
          className="h-9 w-full rounded-lg border border-line bg-transparent pl-8 pr-8 text-base text-ink placeholder:text-muted hover:border-ink/25 focus:border-accent sm:text-sm"
        />
        {value ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              onClear();
              onExpand(false);
            }}
            className="absolute right-1 top-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:text-ink"
          >
            <X size={14} />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-line px-1.5 font-sans text-[11px] leading-4 text-muted group-focus-within:hidden @4xl:block">
            /
          </kbd>
        )}
      </label>
    </>
  );
}

type Adds = { onUpload: () => void; onUploadFolder: () => void; onNewFolder: () => void };

const ADDS: { key: keyof Adds; label: string; hint: string; Icon: LucideIcon }[] = [
  { key: "onUpload", label: "Upload files", hint: "or drop them anywhere", Icon: Upload },
  { key: "onUploadFolder", label: "Upload folder", hint: "with everything inside", Icon: FolderUp },
  { key: "onNewFolder", label: "New folder", hint: "in this folder", Icon: FolderPlus },
];

/** The ways to add something, at the top of a folder. Says when it scrolls away, so the top bar can stand in. */
export function AddCards({ onVisible, ...adds }: Adds & { onVisible: (visible: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const report = useRef(onVisible);
  report.current = onVisible;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Out of sight once it's behind the top bar. Also when hidden, on narrow pages.
    const observer = new IntersectionObserver(([e]) => report.current(e.isIntersecting), { rootMargin: "-72px 0px 0px" });
    observer.observe(el);
    return () => {
      observer.disconnect();
      report.current(false);
    };
  }, []);
  return (
    <div ref={ref} className="mt-5 hidden grid-cols-3 gap-3 @2xl:grid">
      {ADDS.map(({ key, label, hint, Icon }) => (
        <button
          key={key}
          type="button"
          onClick={adds[key]}
          className="group flex min-w-0 items-center gap-3 rounded-xl border border-line p-3 text-left transition-colors hover:border-ink/25 hover:bg-surface"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-ink/6 text-ink/80">
            <Icon size={18} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{label}</span>
            <span className="block truncate text-xs text-muted">{hint}</span>
          </span>
          <Plus size={16} className="shrink-0 self-start text-muted group-hover:text-ink" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

/** The same, behind one button: in the top bar once the cards are out of sight, and floating on narrow pages. */
export function AddMenu({ floating = false, ...adds }: Adds & { floating?: boolean }) {
  return (
    <Menu
      label="Add to this folder"
      width="w-48"
      trigger={
        <>
          <Plus size={floating ? 22 : 16} aria-hidden="true" />
          {!floating && "Add"}
        </>
      }
      buttonClass={
        floating
          ? "inline-flex h-13 w-13 items-center justify-center rounded-2xl !bg-ink !text-paper shadow-xl shadow-black/30"
          : "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg !bg-ink pl-2.5 pr-3.5 text-sm font-medium !text-paper transition-opacity hover:opacity-85"
      }
    >
      {(close) =>
        ADDS.map(({ key, label, Icon }) => (
          <MenuItem
            key={key}
            onSelect={() => {
              close();
              adds[key]();
            }}
          >
            <Icon size={16} />
            {label}
          </MenuItem>
        ))
      }
    </Menu>
  );
}

/** One tab per sort of thing in the listing. Scrolls sideways rather than wrapping. */
export function FilterTabs({
  counts,
  total,
  value,
  onChange,
}: {
  counts: [Category, number][];
  total: number;
  value: Category | null;
  onChange: (value: Category | null) => void;
}) {
  const tabs: [Category | null, string, number][] = [
    [null, "All", total],
    ...counts.map(([c, n]) => [c, CATEGORY_LABELS[c], n] as [Category, string, number]),
  ];
  return (
    <div role="group" aria-label="Show" className="no-scrollbar -my-1 flex min-w-0 flex-1 gap-0.5 overflow-x-auto py-1">
      {tabs.map(([c, label, n]) => (
        <button
          key={label}
          type="button"
          aria-pressed={value === c}
          onClick={() => onChange(c)}
          className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] transition-colors -outline-offset-2 ${value === c ? "bg-ink/9 text-ink" : "text-muted hover:text-ink"}`}
        >
          {label}
          <span className="text-xs tabular-nums text-muted">{n.toLocaleString()}</span>
        </button>
      ))}
    </div>
  );
}

const BAR_BUTTON =
  "inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-2.5 text-sm transition-colors hover:bg-ink/7 @max-sm:px-1.5";

function BarLabel({ children }: { children: ReactNode }) {
  return <span className="hidden @2xl:inline">{children}</span>;
}

/** What can be done with the selection. Its labels go when there's no room for them, and it never wraps. */
export function SelectionBar({
  drive,
  chosen,
  allSelected,
  onSelectAll,
  onInvert,
  onClear,
  onDownloadZip,
  onRename,
  onBulkRename,
  onMove,
  onDelete,
}: {
  drive: string;
  chosen: Entry[];
  allSelected: boolean;
  onSelectAll: () => void;
  onInvert: () => void;
  onClear: () => void;
  onDownloadZip: () => void;
  onRename: () => void;
  onBulkRename: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  const one = chosen.length === 1 ? chosen[0] : null;
  return (
    <div
      role="toolbar"
      aria-label="Selection"
      className="flex max-w-full items-center rounded-2xl border border-line bg-surface p-1.5 shadow-xl shadow-black/25"
    >
      <button type="button" onClick={onClear} aria-label="Clear selection" title="Clear selection (Esc)" className={`${ICON_BUTTON} !h-9 !w-9`}>
        <X size={17} />
      </button>
      <span className="whitespace-nowrap pl-1 pr-3 text-sm tabular-nums @max-sm:pl-0 @max-sm:pr-2" aria-live="polite">
        {chosen.length.toLocaleString()}
        <span className="@max-md:sr-only"> selected</span>
      </span>
      <span className="mr-1 h-5 w-px shrink-0 bg-line" aria-hidden="true" />
      {one?.kind === "file" ? (
        <a href={api.fileUrl(drive, one.id)} download={one.name} aria-label="Download" title="Download" className={BAR_BUTTON}>
          <Download size={16} aria-hidden="true" />
          <BarLabel>Download</BarLabel>
        </a>
      ) : (
        <button type="button" onClick={onDownloadZip} aria-label="Download zip" title="Download as one zip" className={BAR_BUTTON}>
          <Download size={16} aria-hidden="true" />
          <BarLabel>Download zip</BarLabel>
        </button>
      )}
      <button
        type="button"
        onClick={one ? onRename : onBulkRename}
        aria-label={one ? "Rename" : "Rename all"}
        title={one ? "Rename (F2)" : "Rename them all at once: find and replace, numbering, patterns (F2)"}
        className={BAR_BUTTON}
      >
        <Pencil size={16} aria-hidden="true" />
        <BarLabel>{one ? "Rename" : "Rename all"}</BarLabel>
      </button>
      <button type="button" onClick={onMove} aria-label="Move" title="Move" className={BAR_BUTTON}>
        <FolderInput size={16} aria-hidden="true" />
        <BarLabel>Move</BarLabel>
      </button>
      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete"
        title="Delete (Del)"
        className={`${BAR_BUTTON} text-danger hover:bg-danger/12`}
      >
        <Trash2 size={16} aria-hidden="true" />
        <BarLabel>Delete</BarLabel>
      </button>
      <Menu label="More for the selection" buttonClass={`${ICON_BUTTON} !h-9 !w-9`}>
        {(close) => {
          const pick = (action: () => void) => () => {
            close();
            action();
          };
          return (
            <>
              {!allSelected && (
                <MenuItem onSelect={pick(onSelectAll)}>
                  <SquareCheck size={16} />
                  Select all
                </MenuItem>
              )}
              <MenuItem onSelect={pick(onInvert)}>
                <SquareDashed size={16} />
                Invert selection
              </MenuItem>
              {one && (
                <MenuItem onSelect={pick(onBulkRename)}>
                  <PencilRuler size={16} />
                  Advanced rename
                </MenuItem>
              )}
            </>
          );
        }}
      </Menu>
    </div>
  );
}

const SHORTCUTS: [string[], string][] = [
  [["↑", "↓", "←", "→"], "Move the highlight"],
  [["Shift", "arrows"], "Select a range"],
  [["Enter"], "Open"],
  [["Space"], "Select"],
  [["Ctrl", "A"], "Select everything"],
  [["Ctrl", "click"], "Select several"],
  [["Esc"], "Clear the selection"],
  [["Backspace"], "Go up a folder"],
  [["F2"], "Rename, one or several"],
  [["Delete"], "Delete"],
  [["/"], "Search"],
  [["A–Z"], "Jump to a name"],
  [["?"], "Show these shortcuts"],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose}>
      <dl className="divide-y divide-line text-sm">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={what} className="flex items-center justify-between gap-4 py-2">
            <dt className="text-muted">{what}</dt>
            <dd className="flex gap-1">
              {keys.map((k) => (
                <kbd key={k} className="rounded-md border border-line bg-paper px-1.5 py-0.5 font-sans text-xs">
                  {k}
                </kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-muted">On a Mac, use ⌘ instead of Ctrl.</p>
    </Dialog>
  );
}
