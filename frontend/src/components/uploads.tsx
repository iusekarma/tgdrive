import { useQueryClient } from "@tanstack/react-query";
import { Check, CircleAlert, RotateCw, WifiOff, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api, ApiError, sendUpload, type Entry, type UploadStatus, type UploadWait } from "../api";
import { formatDuration, formatSize } from "../format";
import { sendThumbnail } from "../thumbs";
import { ICON_BUTTON } from "./ui";

type Status = "queued" | "uploading" | "finishing" | "retrying" | "offline" | "done" | "error" | "cancelled";

type Item = {
  id: number;
  name: string;
  size: number;
  /** Bytes the browser has sent, and how many of those are safe in Telegram. */
  sent: number;
  stored: number;
  /** Bytes a second over the last few seconds (the average, once done); null until known. */
  speed: number | null;
  status: Status;
  /** While "retrying": what went wrong, and when (ms since epoch) the next try is. */
  note?: string;
  until?: number;
  /** The server is waiting to try Telegram again. */
  wait?: UploadWait & { until: number };
  error?: string;
};

/** A file to upload, and the folders (top first) to put it in, below the folder it was dropped on. */
export type Picked = { file: File; dirs: string[] };

/** Everything enqueued together. Folders it needs are made once, then reused by later files. */
type Batch = { drive: string; parent: string | null; folders: Map<string, string | null> };

/** `file` is null for an empty folder, which only needs making. `upload` is the
 * server's id for it once started, which is what lets it resume. */
type Job = {
  id: number;
  batch: Batch;
  dirs: string[];
  file: File | null;
  upload?: string;
  stored: number;
  started?: number;
};

type Uploads = {
  enqueue: (drive: string, parent: string | null, files: Picked[], emptyFolders?: string[][]) => void;
  /** Points queued uploads at a drive's new name. */
  renameDrive: (from: string, to: string) => void;
};

const Context = createContext<Uploads | null>(null);

export function useUploads(): Uploads {
  const value = useContext(Context);
  if (!value) throw new Error("useUploads must be used inside UploadsProvider");
  return value;
}

const ACTIVE: Status[] = ["queued", "uploading", "finishing", "retrying", "offline"];
/** Tries in a row without getting any further before giving up (about 3 minutes of backing off). */
const MAX_RETRIES = 8;
const POLL_MS = 1000;
/** Sending is measured often and smoothly. Storing moves a whole chunk (16 MB) at a time, so it needs a longer look. */
const SENT_WINDOW_MS = 5000;
const STORED_WINDOW_MS = 20000;

/** Bytes a second over the last `windowMs`, fed a running total; null until a second has passed. */
function rate(start: number, windowMs: number): (total: number) => number | null {
  const samples: [number, number][] = [[Date.now(), start]];
  return (total) => {
    const now = Date.now();
    samples.push([now, total]);
    while (samples.length > 2 && now - samples[0][0] > windowMs) samples.shift();
    const [t0, b0] = samples[0];
    return now - t0 >= 1000 ? ((total - b0) * 1000) / (now - t0) : null;
  };
}

const cancelled = () => new ApiError(-1, "Upload cancelled.");

/** Waits `ms`, or less if the connection comes back. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    window.addEventListener("online", finish);
    signal.addEventListener("abort", stop);
    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener("online", finish);
      signal.removeEventListener("abort", stop);
    }
    function finish() {
      cleanup();
      resolve();
    }
    function stop() {
      cleanup();
      reject(cancelled());
    }
  });
}

function untilOnline(signal: AbortSignal): Promise<void> {
  if (navigator.onLine) return Promise.resolve();
  return sleep(2 ** 31 - 1, signal);
}

/** Worth trying again: the network, a proxy, or Telegram (503) let us down. */
function retryable(e: ApiError): boolean {
  return e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500;
}

function whatWentWrong(e: ApiError): string {
  if (e.status === 0) return "Connection lost.";
  if (e.status === 503) return "Telegram isn't accepting the upload.";
  return `The server had a problem (${e.status}).`;
}

/** Makes (or finds) each folder on the way down and returns the last one's id. */
async function folderFor(batch: Batch, dirs: string[]): Promise<string | null> {
  let id = batch.parent;
  for (let i = 0; i < dirs.length; i += 1) {
    const key = dirs.slice(0, i + 1).join("/");
    let next = batch.folders.get(key);
    if (next === undefined) {
      next = (await api.createFolder(batch.drive, id, dirs[i], true)).id;
      batch.folders.set(key, next);
    }
    id = next;
  }
  return id;
}

/** Files chosen with a folder picker carry their path inside the chosen folder. */
export function pickedFromInput(files: FileList | null): Picked[] {
  return Array.from(files ?? []).map((file) => ({
    file,
    dirs: file.webkitRelativePath ? file.webkitRelativePath.split("/").slice(0, -1) : [],
  }));
}

function readAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  // readEntries hands back a directory a batch at a time, until an empty batch.
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) return resolve(all);
        all.push(...batch);
        next();
      }, reject);
    next();
  });
}

async function walk(entry: FileSystemEntry, dirs: string[], out: { files: Picked[]; folders: string[][] }) {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.files.push({ file, dirs });
    return;
  }
  if (!entry.isDirectory) return;
  const path = [...dirs, entry.name];
  const children = await readAll((entry as FileSystemDirectoryEntry).createReader());
  if (children.length === 0) out.folders.push(path);
  children.sort((a, b) => a.name.localeCompare(b.name));
  for (const child of children) await walk(child, path, out);
}

/** Files and whole folders dropped on the page. The drop's items must be read
 * before its event handler returns, so call this synchronously from it. */
export function readDropped(data: DataTransfer): Promise<{ files: Picked[]; folders: string[][] }> {
  const items = Array.from(data.items ?? []).filter((i) => i.kind === "file");
  if (items.length === 0) {
    return Promise.resolve({ files: Array.from(data.files).map((file) => ({ file, dirs: [] })), folders: [] });
  }
  const taken = items.map((i) => ({ entry: i.webkitGetAsEntry?.() ?? null, file: i.getAsFile() }));
  return (async () => {
    const out = { files: [] as Picked[], folders: [] as string[][] };
    for (const { entry, file } of taken) {
      if (entry) await walk(entry, [], out);
      else if (file) out.files.push({ file, dirs: [] });
    }
    return out;
  })();
}

export function UploadsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [items, setItems] = useState<Item[]>([]);
  const queue = useRef<Job[]>([]);
  const current = useRef<{ job: Job; abort: () => void } | null>(null);
  /** Uploads that gave up, kept so they can resume from where they stopped. */
  const failed = useRef(new Map<number, Job>());
  const nextId = useRef(1);

  const patch = useCallback((id: number, change: Partial<Item>) => {
    setItems((list) => list.map((item) => (item.id === id ? { ...item, ...change } : item)));
  }, []);

  /** One attempt: sends the file from `offset`, watching the server while it does. */
  const send = useCallback(
    (job: Job, file: File, upload: string, offset: number, signal: AbortSignal): Promise<UploadStatus> => {
      const { id, batch } = job;
      let sent = offset;
      let over = false;
      let lastPatch = 0;
      const sentRate = rate(offset, SENT_WINDOW_MS);
      const storedRate = rate(offset, STORED_WINDOW_MS);
      // Once everything is sent, what is left is the server storing it in Telegram.
      const speed = () => {
        const sending = sentRate(sent);
        const storing = storedRate(job.stored);
        return sent >= file.size ? storing : sending;
      };

      job.stored = offset;
      patch(id, { status: "uploading", sent, stored: offset, speed: null, note: undefined, until: undefined });
      const xhr = sendUpload(batch.drive, upload, offset, file.slice(offset), (loaded) => {
        sent = offset + loaded;
        const now = Date.now();
        if (now - lastPatch < 250 && sent < file.size) return;
        lastPatch = now;
        patch(id, { sent, speed: speed(), status: sent >= file.size ? "finishing" : "uploading" });
      });
      // The browser only knows what it has sent; the server knows what is safe in
      // Telegram, and whether it is waiting out a Telegram hiccup.
      const poll = setInterval(() => {
        void api.uploadStatus(batch.drive, upload).then(
          (status) => {
            if (over || status.done) return;
            job.stored = Math.max(job.stored, status.stored);
            patch(id, {
              stored: job.stored,
              speed: speed(),
              wait: status.wait ? { ...status.wait, until: Date.now() + status.wait.retry_in * 1000 } : undefined,
            });
          },
          () => undefined,
        );
      }, POLL_MS);
      const abort = () => xhr.abort();
      signal.addEventListener("abort", abort);
      return xhr.promise.finally(() => {
        over = true;
        clearInterval(poll);
        signal.removeEventListener("abort", abort);
        patch(id, { wait: undefined });
      });
    },
    [patch],
  );

  /** Uploads the job, resuming from what the server has after anything that can pass. */
  const run = useCallback(
    async (job: Job, signal: AbortSignal): Promise<Entry | null> => {
      const { id, batch, file } = job;
      let failures = 0;
      let progress = job.stored;
      for (;;) {
        if (signal.aborted) throw cancelled();
        try {
          const parent = await folderFor(batch, job.dirs);
          if (!file) return null;
          job.started ??= Date.now();
          let offset = 0;
          if (job.upload) {
            const status = await api.uploadStatus(batch.drive, job.upload);
            if (status.done) return status.entry;
            offset = status.stored;
          } else {
            job.upload = (await api.startUpload(batch.drive, parent, file.name, file.size)).id;
          }
          if (signal.aborted) throw cancelled();
          const result = await send(job, file, job.upload, offset, signal);
          if (result.done) return result.entry;
          throw new ApiError(0, "The connection was lost."); // the body was cut short: resume
        } catch (e) {
          if (signal.aborted || (e instanceof ApiError && e.status === -1)) throw cancelled();
          if (!(e instanceof ApiError)) throw e;
          let why: string;
          if (e.status === 404 && job.upload) {
            // Expired after an hour untouched, or the server restarted.
            job.upload = undefined;
            job.stored = 0;
            why = "The server no longer has the part already sent, so it starts again.";
          } else if (retryable(e) || (e.status === 409 && job.upload)) {
            why = whatWentWrong(e);
          } else {
            throw e;
          }
          if (job.stored > progress) {
            failures = 0; // it got further, so this is a new problem
            progress = job.stored;
          }
          failures += 1;
          if (failures > MAX_RETRIES) throw e;
          if (!navigator.onLine) {
            failures -= 1; // waiting for the network doesn't use up tries
            patch(id, { status: "offline", speed: null });
            await untilOnline(signal);
            continue;
          }
          const delay = Math.min(30_000, 1000 * 2 ** failures);
          patch(id, { status: "retrying", note: why, until: Date.now() + delay, speed: null });
          await sleep(delay, signal);
        }
      }
    },
    [patch, send],
  );

  // One file at a time: Telegram rate-limits bots, and parallel uploads only trade speed for retries.
  const pump = useCallback(() => {
    if (current.current) return;
    const job = queue.current.shift();
    if (!job) return;
    const { id, batch, dirs, file } = job;
    const stop = new AbortController();
    current.current = { job, abort: () => stop.abort() };

    run(job, stop.signal)
      .then(
        (entry) => {
          void queryClient.invalidateQueries({ queryKey: ["nodes", batch.drive] });
          if (!entry || !file) {
            setItems((list) => list.filter((item) => item.id !== id)); // an empty folder that needed a retry
            return;
          }
          const seconds = (Date.now() - (job.started ?? Date.now())) / 1000;
          patch(id, {
            status: "done",
            sent: file.size,
            stored: file.size,
            speed: seconds >= 1 ? file.size / seconds : null,
          });
          // Made from the local copy, alongside the next upload rather than before it.
          void sendThumbnail(batch.drive, entry.id, file).then((sent) => {
            if (sent) void queryClient.invalidateQueries({ queryKey: ["nodes", batch.drive] });
          });
        },
        (e: unknown) => {
          const error = e instanceof Error ? e.message : "Upload failed.";
          const quiet = { note: undefined, until: undefined, wait: undefined, speed: null };
          if (e instanceof ApiError && e.status === -1) {
            patch(id, { status: "cancelled", ...quiet });
            if (job.upload) void api.cancelUpload(batch.drive, job.upload).catch(() => undefined);
            return;
          }
          failed.current.set(id, job);
          if (!file) {
            // Empty folders have no row of their own until something goes wrong.
            const name = dirs.join("/");
            const row: Item = { id, name, size: 0, sent: 0, stored: 0, speed: null, status: "error", error };
            setItems((list) => (list.some((item) => item.id === id) ? list : [...list, row]));
            patch(id, { status: "error", error });
          } else patch(id, { status: "error", error, ...quiet });
        },
      )
      .finally(() => {
        current.current = null;
        pump();
      });
  }, [patch, queryClient, run]);

  const enqueue = useCallback(
    (drive: string, parent: string | null, files: Picked[], emptyFolders: string[][] = []) => {
      const batch: Batch = { drive, parent, folders: new Map() };
      const added: Item[] = [];
      for (const dirs of emptyFolders) {
        queue.current.push({ id: nextId.current++, batch, dirs, file: null, stored: 0 });
      }
      for (const { file, dirs } of files) {
        const id = nextId.current++;
        queue.current.push({ id, batch, dirs, file, stored: 0 });
        added.push({
          id,
          name: [...dirs, file.name].join("/"),
          size: file.size,
          sent: 0,
          stored: 0,
          speed: null,
          status: "queued",
        });
      }
      setItems((list) => [...list, ...added]);
      pump();
    },
    [pump],
  );

  const renameDrive = useCallback((from: string, to: string) => {
    const jobs = [...queue.current, ...failed.current.values()];
    if (current.current) jobs.push(current.current.job);
    for (const { batch } of jobs) if (batch.drive === from) batch.drive = to;
  }, []);

  function cancel(id: number) {
    if (current.current?.job.id === id) {
      current.current.abort();
      return;
    }
    queue.current = queue.current.filter((job) => job.id !== id);
    patch(id, { status: "cancelled" });
  }

  function retry(id: number) {
    const job = failed.current.get(id);
    if (!job) return;
    failed.current.delete(id);
    queue.current.push(job);
    patch(id, { status: "queued", error: undefined });
    pump();
  }

  /** A failed upload still holds its name on the server until discarded. */
  function discard(id: number) {
    const job = failed.current.get(id);
    failed.current.delete(id);
    if (job?.upload) void api.cancelUpload(job.batch.drive, job.upload).catch(() => undefined);
    setItems((list) => list.filter((item) => item.id !== id));
  }

  function dismissAll() {
    for (const id of [...failed.current.keys()]) discard(id);
    setItems([]);
  }

  const active = items.filter((item) => ACTIVE.includes(item.status)).length;

  useEffect(() => {
    if (active === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  const value = useMemo(() => ({ enqueue, renameDrive }), [enqueue, renameDrive]);

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
              <button type="button" onClick={dismissAll} aria-label="Dismiss uploads" className={ICON_BUTTON}>
                <X size={16} />
              </button>
            )}
          </div>
          <ul className="max-h-64 overflow-y-auto">
            {items.map((item) => (
              <UploadRow
                key={item.id}
                item={item}
                onCancel={() => cancel(item.id)}
                onRetry={() => retry(item.id)}
                onDiscard={() => discard(item.id)}
              />
            ))}
          </ul>
        </section>
      )}
    </Context.Provider>
  );
}

/** The current time, ticking each second while `ticking`, for countdowns. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

function waitText(wait: UploadWait, seconds: number): string {
  const when = seconds > 0 ? `in ${seconds} s` : "now";
  if (wait.reason === "rate_limited") return `Telegram asked to slow down. Trying again ${when}.`;
  const what = wait.reason === "unreachable" ? "Can't reach Telegram." : "Telegram had an error.";
  return `${what} Try ${wait.attempt + 1} of ${wait.attempts} ${when}.`;
}

function UploadRow({
  item,
  onCancel,
  onRetry,
  onDiscard,
}: {
  item: Item;
  onCancel: () => void;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const now = useNow(item.until !== undefined || item.wait !== undefined);
  const secondsTo = (until: number) => Math.max(0, Math.ceil((until - now) / 1000));
  const percent = (bytes: number) => (item.size > 0 ? Math.min(100, (bytes / item.size) * 100) : 100);
  const running = ACTIVE.includes(item.status);
  const speed = item.speed ? `${formatSize(item.speed)}/s` : null;

  function detail(): string {
    switch (item.status) {
      case "queued":
        return "Waiting";
      case "uploading":
      case "finishing": {
        if (item.wait) return waitText(item.wait, secondsTo(item.wait.until));
        const finishing = item.status === "finishing";
        const done = finishing ? item.stored : item.sent;
        const left = item.speed ? formatDuration((item.size - done) / item.speed) + " left" : null;
        const amount = `${formatSize(done)} of ${formatSize(item.size)}`;
        return [finishing ? `Storing in Telegram: ${amount}` : amount, speed, left].filter(Boolean).join(" · ");
      }
      case "retrying": {
        const from = item.stored > 0 ? `Resuming from ${formatSize(item.stored)}` : "Trying again";
        const seconds = item.until ? secondsTo(item.until) : 0;
        return `${item.note ?? ""} ${from} ${seconds > 0 ? `in ${seconds} s` : "now"}.`.trim();
      }
      case "offline":
        return "You're offline. The upload resumes when the connection is back.";
      case "done":
        return [formatSize(item.size), speed && `${speed} on average`].filter(Boolean).join(" · ");
      case "error":
        return item.error ?? "Upload failed.";
      case "cancelled":
        return "Cancelled";
    }
  }

  const trouble = item.status === "retrying" || item.status === "offline" || !!item.wait;
  const showBar = ["uploading", "finishing", "retrying", "offline"].includes(item.status);
  return (
    <li className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{item.name}</p>
          <p
            className={`text-xs ${item.status === "error" ? "text-danger" : trouble ? "text-brass" : "text-muted"}`}
            aria-live={trouble ? "polite" : undefined}
          >
            {detail()}
          </p>
        </div>
        {item.status === "done" && <Check size={16} className="shrink-0 text-teal" aria-label="Uploaded" />}
        {item.status === "offline" && <WifiOff size={16} className="shrink-0 text-brass" aria-hidden="true" />}
        {item.status === "error" && (
          <>
            <CircleAlert size={16} className="shrink-0 text-danger" aria-hidden="true" />
            <button
              type="button"
              onClick={onRetry}
              aria-label={`Retry upload of ${item.name}`}
              title="Retry"
              className={ICON_BUTTON}
            >
              <RotateCw size={16} />
            </button>
            <button
              type="button"
              onClick={onDiscard}
              aria-label={`Discard upload of ${item.name}`}
              title="Discard"
              className={ICON_BUTTON}
            >
              <X size={16} />
            </button>
          </>
        )}
        {running && (
          <button type="button" onClick={onCancel} aria-label={`Cancel upload of ${item.name}`} className={ICON_BUTTON}>
            <X size={16} />
          </button>
        )}
      </div>
      {showBar && (
        <div
          className="relative mt-1.5 h-1 overflow-hidden rounded-full bg-ink/10"
          role="progressbar"
          aria-valuenow={Math.round(percent(item.stored))}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={`${formatSize(item.stored)} of ${formatSize(item.size)} stored`}
          aria-label={`Upload progress for ${item.name}`}
        >
          {/* Sent, then the part of it already safe in Telegram. */}
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-teal/35"
            style={{ width: `${percent(item.sent)}%` }}
          />
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-teal"
            style={{ width: `${percent(item.stored)}%` }}
          />
        </div>
      )}
    </li>
  );
}
