import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

// A folder can hold thousands of items, and drawing them all makes every click
// wait for the browser. Only the rows in or near view are drawn; padding on the
// list stands in for the others, so the scrollbar and the page's height are as
// if they were there.

/** How far past the edges of the window rows are drawn, for scrolling to find them there. */
const MARGIN = 500;
/** Drawn before anything has been measured (replaced before it is painted). */
const FIRST = 20;

/** What the sticky bars above the rows, and the dock below them, cover: in rem, as they are. */
const COVERED_ABOVE = 10;
const COVERED_BELOW = 6;

export type Range = { from: number; to: number };

/**
 * The rows of `list` to draw, `to` excluded: never none of them. `stride` is
 * from the top of one row to the top of the next, `inset` how far down the first starts.
 */
export function useVisibleRows(list: RefObject<HTMLElement | null>, rows: number, stride: number, inset = 0): Range {
  const [range, setRange] = useState<Range>({ from: 0, to: FIRST });

  function measure() {
    const el = list.current;
    if (!el || stride <= 0) return;
    // Whichever of the panel and the window scrolls, the panel is never larger than the window.
    const top = el.getBoundingClientRect().top + inset;
    const clamp = (row: number) => Math.min(Math.max(row, 0), rows);
    const from = Math.min(clamp(Math.floor((-MARGIN - top) / stride)), Math.max(rows - 1, 0));
    const to = Math.max(clamp(Math.ceil((window.innerHeight + MARGIN - top) / stride)), from + 1);
    setRange((old) => (old.from === from && old.to === to ? old : { from, to }));
  }

  // After every render: something above the list may have moved it.
  useLayoutEffect(measure);

  useEffect(() => {
    // Captured: scrolling an element doesn't bubble.
    window.addEventListener("scroll", measure, { capture: true, passive: true });
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, { capture: true });
      window.removeEventListener("resize", measure);
    };
  });

  // The list may just have become shorter than what was last measured.
  const from = Math.min(range.from, Math.max(rows - 1, 0));
  return { from, to: Math.min(Math.max(range.to, from + 1), rows) };
}

/** Scrolls as little as it takes for a row of `list`, drawn or not, to be clear of the bars. */
export function scrollToRow(list: HTMLElement, offset: number, height: number) {
  const panel = list.closest("[data-scroller]");
  const scroller = panel && getComputedStyle(panel).overflowY !== "visible" ? panel : null;
  const view = scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const top = list.getBoundingClientRect().top + offset;
  const above = view.top + COVERED_ABOVE * rem - top;
  const below = top + height - (view.bottom - COVERED_BELOW * rem);
  const by = above > 0 ? -above : below > 0 ? below : 0;
  if (by) (scroller ?? window).scrollBy({ top: by, behavior: "instant" });
}
