import { ArrowDownWideNarrow, ArrowUpNarrowWide, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { SORT_LABELS, type Sort, type SortKey } from "../sorting";

const ROW = "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-ink hover:bg-ink/5";

/**
 * The sort as a menu: what to sort by, which way, and whether folders come first.
 * `sort` null means the server's own order (search results by relevance), offered
 * only when `relevance` is set.
 */
export function SortMenu({
  sort,
  onChange,
  relevance = false,
  onRelevance,
}: {
  sort: Sort | null;
  onChange: (sort: Sort) => void;
  relevance?: boolean;
  onRelevance?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label = sort ? `Sorted by ${SORT_LABELS[sort.key].toLowerCase()}, ${sort.desc ? "descending" : "ascending"}` : "Sorted by relevance";
  const Icon = sort?.desc ? ArrowDownWideNarrow : ArrowUpNarrowWide;
  const tick = (on: boolean) => <Check size={15} className={on ? "text-teal" : "invisible"} aria-hidden="true" />;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-2 text-sm text-muted hover:text-ink"
      >
        <Icon size={16} aria-hidden="true" />
        <span className="hidden sm:inline">{sort ? SORT_LABELS[sort.key] : "Relevance"}</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1 w-52 rounded-md border border-line bg-surface py-1 shadow-lg">
          <p className="px-3 pb-1 pt-1.5 text-xs font-medium uppercase tracking-wide text-muted">Sort by</p>
          {relevance && (
            <button type="button" role="menuitemradio" aria-checked={sort === null} className={ROW} onClick={() => onRelevance?.()}>
              {tick(sort === null)}
              Relevance
            </button>
          )}
          {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
            <button
              key={key}
              type="button"
              role="menuitemradio"
              aria-checked={sort?.key === key}
              className={ROW}
              onClick={() => onChange({ ...(sort ?? { desc: false, foldersFirst: true }), key })}
            >
              {tick(sort?.key === key)}
              {SORT_LABELS[key]}
            </button>
          ))}
          {sort && (
            <>
              <div className="my-1 border-t border-line" />
              {([false, true] as const).map((desc) => (
                <button
                  key={String(desc)}
                  type="button"
                  role="menuitemradio"
                  aria-checked={sort.desc === desc}
                  className={ROW}
                  onClick={() => onChange({ ...sort, desc })}
                >
                  {tick(sort.desc === desc)}
                  {directionLabel(sort.key, desc)}
                </button>
              ))}
              <div className="my-1 border-t border-line" />
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={sort.foldersFirst}
                className={ROW}
                onClick={() => onChange({ ...sort, foldersFirst: !sort.foldersFirst })}
              >
                {tick(sort.foldersFirst)}
                Folders first
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function directionLabel(key: SortKey, desc: boolean): string {
  switch (key) {
    case "name":
    case "type":
      return desc ? "Z to A" : "A to Z";
    case "size":
      return desc ? "Largest first" : "Smallest first";
    case "created":
      return desc ? "Newest first" : "Oldest first";
  }
}
