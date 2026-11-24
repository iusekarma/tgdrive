import { formatSize } from "../format";

/** A spinner, with how far along it is when the size is known. */
export function Loading({ label = "Loading…", loaded, total }: { label?: string; loaded?: number; total?: number }) {
  const pct = loaded !== undefined && total ? Math.min(100, Math.floor((loaded / total) * 100)) : null;
  return (
    <div role="status" className="flex w-56 max-w-full flex-col items-center gap-3 text-sm text-white/75">
      <span
        aria-hidden="true"
        className="size-9 animate-spin rounded-full border-[3px] border-white/15 border-t-white/80"
      />
      <span>
        {label}
        {pct !== null && <span className="ml-1.5 tabular-nums text-white">{pct}%</span>}
      </span>
      {pct !== null && (
        <>
          <span className="h-1 w-full overflow-hidden rounded-full bg-white/10">
            <span className="block h-full rounded-full bg-[var(--accent)] transition-[width]" style={{ width: `${pct}%` }} />
          </span>
          <span className="text-xs tabular-nums text-white/50">
            {formatSize(loaded!)} of {formatSize(total!)}
          </span>
        </>
      )}
    </div>
  );
}
