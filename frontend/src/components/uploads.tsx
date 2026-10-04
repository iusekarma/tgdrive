import { useQueryClient } from "@tanstack/react-query";
import { Check, CircleAlert, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ApiError, uploadFile } from "../api";
import { formatSize } from "../format";
import { sendThumbnail } from "../thumbs";
import { ICON_BUTTON } from "./ui";

type Status = "queued" | "uploading" | "finishing" | "done" | "error" | "cancelled";

type Item = { id: number; name: string; size: number; loaded: number; status: Status; error?: string };

type Job = { id: number; drive: string; parent: string | null; file: File };

type Uploads = { enqueue: (drive: string, parent: string | null, files: File[]) => void };

const Context = createContext<Uploads | null>(null);

export function useUploads(): Uploads {
  const value = useContext(Context);
  if (!value) throw new Error("useUploads must be used inside UploadsProvider");
  return value;
}

const ACTIVE: Status[] = ["queued", "uploading", "finishing"];

/** Lives above the router, so uploads keep going while you move between folders and drives. */
export function UploadsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [items, setItems] = useState<Item[]>([]);
  const queue = useRef<Job[]>([]);
  const current = useRef<{ id: number; abort: () => void } | null>(null);
  const nextId = useRef(1);

  const patch = useCallback((id: number, change: Partial<Item>) => {
    setItems((list) => list.map((item) => (item.id === id ? { ...item, ...change } : item)));
  }, []);

  // One file at a time: Telegram rate-limits bots, and parallel uploads only trade speed for retries.
  const pump = useCallback(() => {
    if (current.current) return;
    const job = queue.current.shift();
    if (!job) return;
    patch(job.id, { status: "uploading" });
    const { promise, abort } = uploadFile(job.drive, job.parent, job.file, (loaded, total) => {
      patch(job.id, { loaded, status: loaded >= total ? "finishing" : "uploading" });
    });
    current.current = { id: job.id, abort };
    promise
      .then(
        (entry) => {
          patch(job.id, { status: "done", loaded: job.file.size });
          void queryClient.invalidateQueries({ queryKey: ["nodes", job.drive] });
          // Made from the local copy, alongside the next upload rather than before it.
          void sendThumbnail(job.drive, entry.id, job.file).then((sent) => {
            if (sent) void queryClient.invalidateQueries({ queryKey: ["nodes", job.drive] });
          });
        },
        (e: unknown) => {
          if (e instanceof ApiError && e.status === -1) patch(job.id, { status: "cancelled" });
          else patch(job.id, { status: "error", error: e instanceof Error ? e.message : "Upload failed." });
        },
      )
      .finally(() => {
        current.current = null;
        pump();
      });
  }, [patch, queryClient]);

  const enqueue = useCallback(
    (drive: string, parent: string | null, files: File[]) => {
      const added: Item[] = [];
      for (const file of files) {
        const id = nextId.current++;
        queue.current.push({ id, drive, parent, file });
        added.push({ id, name: file.name, size: file.size, loaded: 0, status: "queued" });
      }
      setItems((list) => [...list, ...added]);
      pump();
    },
    [pump],
  );

  function cancel(id: number) {
    if (current.current?.id === id) {
      current.current.abort();
      return;
    }
    queue.current = queue.current.filter((job) => job.id !== id);
    patch(id, { status: "cancelled" });
  }

  const active = items.filter((item) => ACTIVE.includes(item.status)).length;

  useEffect(() => {
    if (active === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  const value = useMemo(() => ({ enqueue }), [enqueue]);

  return (
    <Context.Provider value={value}>
      {children}
      {items.length > 0 && (
        <section
          aria-label="Uploads"
          className="fixed inset-x-3 bottom-3 z-30 rounded-xl border border-line bg-surface shadow-xl sm:left-auto sm:right-5 sm:w-96"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <h2 className="text-sm font-semibold" aria-live="polite">
              {active > 0 ? `Uploading ${active} ${active === 1 ? "file" : "files"}` : "Uploads finished"}
            </h2>
            {active === 0 && (
              <button type="button" onClick={() => setItems([])} aria-label="Dismiss uploads" className={ICON_BUTTON}>
                <X size={16} />
              </button>
            )}
          </div>
          <ul className="max-h-64 overflow-y-auto">
            {items.map((item) => (
              <UploadRow key={item.id} item={item} onCancel={() => cancel(item.id)} />
            ))}
          </ul>
        </section>
      )}
    </Context.Provider>
  );
}

function UploadRow({ item, onCancel }: { item: Item; onCancel: () => void }) {
  const percent = item.size > 0 ? Math.min(100, Math.round((item.loaded / item.size) * 100)) : 100;
  const running = ACTIVE.includes(item.status);
  const detail: Record<Status, string> = {
    queued: "Waiting",
    uploading: `${formatSize(item.loaded)} of ${formatSize(item.size)}`,
    finishing: "Sending the last part to Telegram",
    done: formatSize(item.size),
    error: item.error ?? "Upload failed.",
    cancelled: "Cancelled",
  };
  return (
    <li className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{item.name}</p>
          <p className={`truncate text-xs ${item.status === "error" ? "text-danger" : "text-muted"}`}>
            {detail[item.status]}
          </p>
        </div>
        {item.status === "done" && <Check size={16} className="shrink-0 text-teal" aria-label="Uploaded" />}
        {item.status === "error" && <CircleAlert size={16} className="shrink-0 text-danger" aria-hidden="true" />}
        {running && (
          <button type="button" onClick={onCancel} aria-label={`Cancel upload of ${item.name}`} className={ICON_BUTTON}>
            <X size={16} />
          </button>
        )}
      </div>
      {(item.status === "uploading" || item.status === "finishing") && (
        <div
          className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink/10"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Upload progress for ${item.name}`}
        >
          <div className="h-full rounded-full bg-teal" style={{ width: `${percent}%` }} />
        </div>
      )}
    </li>
  );
}
