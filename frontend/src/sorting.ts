import { useState } from "react";

import type { Entry } from "./api";

// How a folder's items are ordered. Done here rather than by the server, so a
// change is instant, and everything that follows the listing's order (the
// viewer's stepping, keyboard moves, numbering in bulk rename) follows it too.

export type SortKey = "name" | "type" | "size" | "created";
export type Sort = { key: SortKey; desc: boolean; foldersFirst: boolean };

export const SORT_LABELS: Record<SortKey, string> = {
  name: "Name",
  type: "Type",
  size: "Size",
  created: "Date added",
};

/** Name A→Z, size and date newest/largest first: what people usually want on first click. */
export const FIRST_DESC: Record<SortKey, boolean> = { name: false, type: false, size: true, created: true };

export const DEFAULT_SORT: Sort = { key: "name", desc: false, foldersFirst: true };

// Natural order: "2.jpg" before "10.jpg", case and accents ignored.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const extension = (e: Entry) => {
  const dot = e.name.lastIndexOf(".");
  return e.kind === "dir" || dot <= 0 ? "" : e.name.slice(dot + 1).toLowerCase();
};

function compareBy(key: SortKey, a: Entry, b: Entry): number {
  switch (key) {
    case "name":
      return 0;   // the tie-break below
    case "type":
      return collator.compare(extension(a), extension(b));
    case "size":
      return a.size - b.size;
    case "created":
      return a.created_at - b.created_at;
  }
}

/** A sorted copy. Ties fall back to the name, then to the exact name, so the order is stable. */
export function sortEntries(entries: Entry[], sort: Sort): Entry[] {
  const dir = sort.desc ? -1 : 1;
  return [...entries].sort((a, b) => {
    if (sort.foldersFirst && a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    const byKey = compareBy(sort.key, a, b) * dir;
    if (byKey) return byKey;
    const byName = collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return sort.key === "name" ? byName * dir : byName;
  });
}

const KEY = "tgdrive.sort";

/** The sort, remembered in this browser for every folder. */
export function useSavedSort(): [Sort, (sort: Sort) => void] {
  const [sort, setSort] = useState<Sort>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Sort> | null;
      if (saved && saved.key && saved.key in SORT_LABELS) return { ...DEFAULT_SORT, ...saved };
    } catch {
      /* unreadable: the default */
    }
    return DEFAULT_SORT;
  });
  function change(next: Sort) {
    setSort(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* private mode: just not remembered */
    }
  }
  return [sort, change];
}

/** Clicking a column: the same one again flips the direction, another starts in its usual one. */
export function sortByColumn(sort: Sort, key: SortKey): Sort {
  return sort.key === key ? { ...sort, desc: !sort.desc } : { ...sort, key, desc: FIRST_DESC[key] };
}
