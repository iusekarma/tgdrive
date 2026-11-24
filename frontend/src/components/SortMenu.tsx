import { ArrowDownWideNarrow, ArrowUpNarrowWide, Check } from "lucide-react";

import { SORT_LABELS, type Sort, type SortKey } from "../sorting";
import { Menu, MENU_ROW, MenuDivider, MenuHeading } from "./menu";

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
  const label = sort
    ? `Sorted by ${SORT_LABELS[sort.key].toLowerCase()}, ${sort.desc ? "descending" : "ascending"}`
    : "Sorted by relevance";
  const Icon = sort?.desc ? ArrowDownWideNarrow : ArrowUpNarrowWide;
  const tick = (on: boolean) => <Check size={15} className={on ? "text-accent" : "invisible"} aria-hidden="true" />;

  return (
    <Menu
      label={label}
      width="w-52"
      buttonClass="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line px-2 text-[13px] text-muted transition-colors hover:text-ink"
      trigger={
        <>
          <Icon size={15} aria-hidden="true" />
          <span className="hidden @2xl:inline">{sort ? SORT_LABELS[sort.key] : "Relevance"}</span>
        </>
      }
    >
      {() => (
        <>
          <MenuHeading>Sort by</MenuHeading>
          {relevance && (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={sort === null}
              className={MENU_ROW}
              onClick={() => onRelevance?.()}
            >
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
              className={MENU_ROW}
              onClick={() => onChange({ ...(sort ?? { desc: false, foldersFirst: true }), key })}
            >
              {tick(sort?.key === key)}
              {SORT_LABELS[key]}
            </button>
          ))}
          {sort && (
            <>
              <MenuDivider />
              {([false, true] as const).map((desc) => (
                <button
                  key={String(desc)}
                  type="button"
                  role="menuitemradio"
                  aria-checked={sort.desc === desc}
                  className={MENU_ROW}
                  onClick={() => onChange({ ...sort, desc })}
                >
                  {tick(sort.desc === desc)}
                  {directionLabel(sort.key, desc)}
                </button>
              ))}
              <MenuDivider />
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={sort.foldersFirst}
                className={MENU_ROW}
                onClick={() => onChange({ ...sort, foldersFirst: !sort.foldersFirst })}
              >
                {tick(sort.foldersFirst)}
                Folders first
              </button>
            </>
          )}
        </>
      )}
    </Menu>
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
