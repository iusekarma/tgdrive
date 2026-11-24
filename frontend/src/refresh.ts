import type { QueryClient } from "@tanstack/react-query";

/** Between refreshes of a drive's listings while its files change one after another. */
const GAP = 1500;

const last = new Map<string, number>();
const due = new Set<string>();

/**
 * Refreshes a drive's listings: at once, or if that was just done, once for
 * everything that changes in the next moment. For runs of small changes (uploads,
 * thumbnails), where fetching a long folder again after each would slow the page down.
 */
export function refreshSoon(queryClient: QueryClient, drive: string) {
  if (due.has(drive)) return;
  const run = () => {
    due.delete(drive);
    last.set(drive, Date.now());
    void queryClient.invalidateQueries({ queryKey: ["nodes", drive] });
  };
  const wait = (last.get(drive) ?? 0) + GAP - Date.now();
  if (wait <= 0) return run();
  due.add(drive);
  setTimeout(run, wait);
}
