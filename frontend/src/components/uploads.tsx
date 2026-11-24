import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, ChevronUp, CircleAlert, CirclePause, RotateCw, Upload, WifiOff, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api, ApiError, sendUpload, type Entry, type QueuedUpload, type UploadStatus, type UploadWait } from "../api";
import { formatDuration, formatSize } from "../format";
import { infoKey } from "../fileinfo";
import { refreshSoon } from "../refresh";
import { useSavedFlag } from "../saved";
import { sendDetails } from "../thumbs";
import { Button, Dialog, DialogActions, ICON_BUTTON } from "./ui";

/** "interrupted": left unfinished on the server (e.g. by a closed tab) until its file is chosen again. */
type Status =
  | "queued"
  | "uploading"
  | "finishing"
  | "retrying"
  | "offline"
  | "done"
  | "error"
  | "cancelled"
  | "interrupted";

type Item = {
  id: number;
  name: string;
  size: number;
  /** Bytes the browser has sent, and how many of those are safe in Telegram. */
  sent: number;
  stored: number;
  /** Bytes this session has moved for it, for the overall speed. */
  moved: number;
  /** Average bytes a second since it started (or was last retried); null until known. */
  speed: number | null;
  status: Status;
  /** While "retrying": what went wrong, and when (ms since epoch) the next try is. */
  note?: string;
  until?: number;
  /** The server is waiting to try Telegram again. */
  wait?: UploadWait & { until: number };
  error?: string;
  /** The server's id for it once started. */
  upload?: string;
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
  /** What the server already had when this session first sent to it. */
  base?: number;
  /** When this run started and from which byte, for its average speed. */
  run?: { at: number; from: number };
};

/** Files picked to upload, some of which (`there`) are already in the drive: whether to skip those is being asked. */
type Prompt = {
  id: number;
  drive: string;
  parent: string | null;
  files: Picked[];
  emptyFolders: string[][];
  there: Set<Picked>;
  /** Some of `there` are still in this tab's queue. */
  queued: boolean;
};

/** An upload the server has but this tab has no file for. */
type Leftover = {
  drive: string;
  upload: string;
  parent: string | null;
  name: string;
  size: number;
  stored: number;
  modified: number | null;
};

type Uploads = {
  enqueue: (drive: string, parent: string | null, files: Picked[], emptyFolders?: string[][]) => void;
  /** Points queued uploads at a drive's new name. */
  renameDrive: (from: string, to: string) => void;
  /** Shows the drive's unfinished uploads that this tab isn't already sending. */
  adopt: (drive: string) => void;
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
/** How often to report to the line every device shares: often while anything is going. */
const SYNC_BUSY_MS = 1000;
const SYNC_IDLE_MS = 3000;

/** This tab, in the shared upload line. */
const CLIENT = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
const keyOf = (id: number) => `${CLIENT}:${id}`;

/** The shared line: its order, and the uploads other tabs (on this device or others) are sending. */
type Line = { order: string[]; others: Map<string, QueuedUpload> };
const EMPTY_LINE: Line = { order: [], others: new Map() };

/** The tab's title (as in index.html) when nothing is uploading. */
const PAGE_TITLE = "tgdrive";

/** Whether the panel is folded down to its header, remembered in this browser. */
const MINIMIZED_KEY = "tgdrive.uploadsMinimized";

/** Bytes a second since the run started; null for the first second. */
function average(run: { at: number; from: number } | undefined, bytes: number): number | null {
  if (!run) return null;
  const ms = Date.now() - run.at;
  return ms >= 1000 ? ((bytes - run.from) * 1000) / ms : null;
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

type Folder = { files: Picked[]; folders: Map<string, Folder> };

/** How many folders to list at once while looking for files already uploaded. */
const CHECKS = 4;

/** Which of the files the drive already has where they would go: same folder, name and size.
 * Folders the drive doesn't have aren't looked into, so a new folder costs one request. */
async function alreadyThere(drive: string, parent: string | null, files: Picked[]): Promise<Set<Picked>> {
  const root: Folder = { files: [], folders: new Map() };
  for (const picked of files) {
    let folder = root;
    for (const name of picked.dirs) {
      let next = folder.folders.get(name);
      if (!next) folder.folders.set(name, (next = { files: [], folders: new Map() }));
      folder = next;
    }
    folder.files.push(picked);
  }
  const there = new Set<Picked>();
  let level = [{ id: parent, folder: root }];
  while (level.length > 0) {
    const below: typeof level = [];
    for (let i = 0; i < level.length; i += CHECKS) {
      await Promise.all(
        level.slice(i, i + CHECKS).map(async ({ id, folder }) => {
          const { entries } = await api.list(drive, id);
          const byName = new Map(entries.map((e) => [e.name, e]));
          for (const picked of folder.files) {
            const entry = byName.get(picked.file.name);
            if (entry?.kind === "file" && entry.size === picked.file.size) there.add(picked);
          }
          for (const [name, sub] of folder.folders) {
            const entry = byName.get(name);
            if (entry?.kind === "dir") below.push({ id: entry.id, folder: sub });
          }
        }),
      );
    }
    level = below;
  }
  return there;
}

/** Where a file goes, to tell whether it is in this tab's queue already. */
function destination(drive: string, parent: string | null, { file, dirs }: Picked): string {
  return JSON.stringify([drive, parent, ...dirs, file.name, file.size]);
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
  // Time spent with something to upload, for the overall average speed.
  const [clock, setClock] = useState<{ spent: number; since: number | null }>({ spent: 0, since: null });
  const queue = useRef<Job[]>([]);
  const current = useRef<{ job: Job; abort: () => void } | null>(null);
  /** Uploads that gave up, kept so they can resume from where they stopped. */
  const failed = useRef(new Map<number, Job>());
  /** Unfinished uploads found on the server, waiting for their file to be chosen again. */
  const leftovers = useRef(new Map<number, Leftover>());
  const nextId = useRef(1);
  /** Asked one at a time, oldest first. */
  const [prompts, setPrompts] = useState<Prompt[]>([]);

  const vault = useQuery({ queryKey: ["vault"], queryFn: api.vault, staleTime: Infinity });
  const unlocked = vault.data?.unlocked === true;
  // Every device shares one upload line on the server, and only its front is
  // sent. This tab reports its own rows there and shows everyone else's.
  const [line, setLine] = useState<Line>(EMPTY_LINE);
  const lineRef = useRef<Line>(EMPTY_LINE);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  /** Each row as the server last heard it, to send only what changed. */
  const reported = useRef(new Map<number, Item>());
  /** Other tabs' uploads to ask them to stop. */
  const cancels = useRef(new Set<string>());
  /** Other tabs' finished rows dismissed here. */
  const hidden = useRef(new Set<string>());
  /** What other tabs had already moved when first seen, so the overall speed counts only what moved since. */
  const firstMoved = useRef(new Map<string, number>());
  const syncing = useRef({ epoch: null as string | null, since: 0, busy: false, again: false });
  const pumpRef = useRef(() => {});
  const cancelRef = useRef((_id: number) => {});
  const [syncWanted, setSyncWanted] = useState(0);
  const requestSync = useCallback(() => setSyncWanted((n) => n + 1), []);

  const patch = useCallback((id: number, change: Partial<Item>) => {
    setItems((list) => list.map((item) => (item.id === id ? { ...item, ...change } : item)));
  }, []);

  /** The same file was started again and the server resumed it: its own row takes over. */
  const claim = useCallback((upload: string) => {
    for (const [id, left] of leftovers.current) {
      if (left.upload !== upload) continue;
      leftovers.current.delete(id);
      setItems((list) => list.filter((item) => item.id !== id));
    }
  }, []);

  /** One attempt: sends the file from `offset`, watching the server while it does. */
  const send = useCallback(
    (job: Job, file: File, upload: string, offset: number, signal: AbortSignal): Promise<UploadStatus> => {
      const { id, batch } = job;
      let sent = offset;
      let over = false;
      let lastPatch = 0;
      const progress = () => {
        const bytes = Math.max(sent, job.stored);
        return { moved: Math.max(0, bytes - (job.base ?? 0)), speed: average(job.run, bytes) };
      };

      job.stored = offset;
      patch(id, { status: "uploading", sent, stored: offset, note: undefined, until: undefined, ...progress() });
      const xhr = sendUpload(batch.drive, upload, offset, file.slice(offset), (loaded) => {
        sent = offset + loaded;
        const now = Date.now();
        if (now - lastPatch < 250 && sent < file.size) return;
        lastPatch = now;
        patch(id, { sent, status: sent >= file.size ? "finishing" : "uploading", ...progress() });
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
              wait: status.wait ? { ...status.wait, until: Date.now() + status.wait.retry_in * 1000 } : undefined,
              ...progress(),
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
          let offset = 0;
          if (job.upload) {
            const status = await api.uploadStatus(batch.drive, job.upload);
            if (status.done) return status.entry;
            offset = status.stored;
          } else {
            const started = await api.startUpload(batch.drive, parent, file.name, file.size, file.lastModified);
            job.upload = started.id;
            patch(id, { upload: started.id });
            offset = started.stored;
            if (offset > 0) claim(started.id);
          }
          job.base ??= offset;
          job.run ??= { at: Date.now(), from: offset };
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
            job.base = job.run = undefined;
            patch(id, { upload: undefined });
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
            patch(id, { status: "offline" });
            await untilOnline(signal);
            continue;
          }
          const delay = Math.min(30_000, 1000 * 2 ** failures);
          patch(id, { status: "retrying", note: why, until: Date.now() + delay });
          await sleep(delay, signal);
        }
      }
    },
    [claim, patch, send],
  );

  /** Whether everything ahead of this tab's job in the shared line is finished. */
  const myTurn = useCallback((id: number) => {
    const key = keyOf(id);
    for (const k of lineRef.current.order) {
      if (k === key) return true;
      const other = lineRef.current.others.get(k);
      if (other && ACTIVE.includes(other.status)) return false;
    }
    return false; // the server hasn't heard of it yet
  }, []);

  // One file at a time, across every device: Telegram rate-limits bots, and
  // parallel uploads only trade speed for retries.
  const pump = useCallback(() => {
    if (current.current) return;
    const job = queue.current[0];
    // An empty folder has no row in the line; making it doesn't hold anyone up.
    if (!job || (job.file && !myTurn(job.id))) return;
    queue.current.shift();
    const { id, batch, dirs, file } = job;
    const stop = new AbortController();
    current.current = { job, abort: () => stop.abort() };

    run(job, stop.signal)
      .then(
        (entry) => {
          refreshSoon(queryClient, batch.drive);
          if (!entry || !file) {
            setItems((list) => list.filter((item) => item.id !== id)); // an empty folder that needed a retry
            return;
          }
          patch(id, {
            status: "done",
            sent: file.size,
            stored: file.size,
            moved: file.size - (job.base ?? 0),
            speed: average(job.run, file.size),
          });
          // Made from the local copy, alongside the next upload rather than before it.
          void sendDetails(batch.drive, entry.id, file).then(({ thumb, info }) => {
            if (thumb) refreshSoon(queryClient, batch.drive);
            if (info) queryClient.setQueryData(infoKey(batch.drive, entry.id), info);
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
            const row: Item = { id, name, size: 0, sent: 0, stored: 0, moved: 0, speed: null, status: "error", error };
            setItems((list) => (list.some((item) => item.id === id) ? list : [...list, row]));
            patch(id, { status: "error", error });
          } else patch(id, { status: "error", error, ...quiet });
        },
      )
      .finally(() => {
        current.current = null;
        pump();
        requestSync(); // let the next device know
      });
  }, [myTurn, patch, queryClient, requestSync, run]);
  pumpRef.current = pump;

  /** Reports this tab's changed rows, takes in everyone else's, then starts the next file if it is this tab's turn. */
  const syncNow = useCallback(async (): Promise<void> => {
    const state = syncing.current;
    if (state.busy) {
      state.again = true;
      return;
    }
    state.busy = true;
    try {
      const mine = itemsRef.current.filter((item) => item.status !== "interrupted");
      const changed = mine.filter((item) => reported.current.get(item.id) !== item);
      const ids = new Set(mine.map((item) => item.id));
      const removed = [...reported.current.keys()].filter((id) => !ids.has(id));
      const cancel = [...cancels.current];
      const sentAll = reported.current.size === 0;
      const { epoch, since } = state;
      const r = await api.syncUploads({ client: CLIENT, items: changed, removed, cancel, epoch, since });
      for (const item of changed) reported.current.set(item.id, item);
      for (const id of removed) reported.current.delete(id);
      for (const key of cancel) cancels.current.delete(key);
      if (r.resend && !sentAll) {
        // The server restarted or gave up on this tab: tell it everything again.
        reported.current.clear();
        state.again = true;
      }
      state.epoch = r.epoch;
      state.since = r.rev;

      const others = new Map(lineRef.current.others);
      const stop: number[] = [];
      for (const u of r.items) {
        if (u.client === CLIENT) {
          if (u.cancel) stop.push(u.id);
          continue;
        }
        if (!firstMoved.current.has(u.key)) firstMoved.current.set(u.key, u.moved);
        if (ACTIVE.includes(u.status)) hidden.current.delete(u.key); // retried: show it again
        others.set(u.key, u);
      }
      const order = r.order ?? lineRef.current.order;
      if (r.order) {
        const inLine = new Set(order);
        for (const key of others.keys()) {
          if (inLine.has(key)) continue;
          others.delete(key);
          firstMoved.current.delete(key);
        }
      }
      lineRef.current = { order, others };
      setLine(lineRef.current);
      for (const id of stop) {
        const item = itemsRef.current.find((i) => i.id === id);
        if (item && ACTIVE.includes(item.status)) cancelRef.current(id);
      }
      pumpRef.current();
    } catch {
      // Tried again on the next tick.
    } finally {
      state.busy = false;
      if (state.again) {
        state.again = false;
        void syncNow();
      }
    }
  }, []);

  useEffect(() => {
    if (!unlocked) {
      setPrompts([]); // they show file names
      lineRef.current = EMPTY_LINE;
      setLine(EMPTY_LINE);
      reported.current.clear();
      firstMoved.current.clear();
      syncing.current.epoch = null;
      syncing.current.since = 0;
      return;
    }
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      await syncNow();
      if (stopped) return;
      const going = (s: { status: string }) => ACTIVE.includes(s.status as Status);
      const busy = itemsRef.current.some(going) || [...lineRef.current.others.values()].some(going);
      timer = window.setTimeout(() => void tick(), busy ? SYNC_BUSY_MS : SYNC_IDLE_MS);
    };
    void tick();
    // Closing the tab lets whoever is next go now, not after the server gives up on it.
    const leave = () => void api.leaveUploads(CLIENT);
    window.addEventListener("pagehide", leave);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("pagehide", leave);
    };
  }, [unlocked, syncNow]);

  useEffect(() => {
    if (syncWanted > 0 && unlocked) void syncNow();
  }, [syncWanted, unlocked, syncNow]);

  const add = useCallback(
    (drive: string, parent: string | null, files: Picked[], emptyFolders: string[][]) => {
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
          moved: 0,
          speed: null,
          status: "queued",
        });
      }
      setItems((list) => [...list, ...added]);
      requestSync(); // it starts once the server has it in line
    },
    [requestSync],
  );

  /** Queues the files, first asking whether to skip any that were uploaded before (the server would refuse them). */
  const enqueue = useCallback(
    (drive: string, parent: string | null, files: Picked[], emptyFolders: string[][] = []) => {
      if (files.length === 0) return add(drive, parent, files, emptyFolders);
      // Read before asking the server, so a file that finishes meanwhile is found in one or the other.
      const jobs = current.current ? [current.current.job, ...queue.current] : queue.current;
      const queued = new Set<string>();
      for (const { batch, dirs, file } of jobs) {
        if (file) queued.add(destination(batch.drive, batch.parent, { file, dirs }));
      }
      alreadyThere(drive, parent, files).then(
        (there) => {
          const stored = there.size;
          for (const picked of files) if (queued.has(destination(drive, parent, picked))) there.add(picked);
          if (there.size === 0) return add(drive, parent, files, emptyFolders);
          const prompt: Prompt = { id: nextId.current++, drive, parent, files, emptyFolders, there, queued: there.size > stored };
          setPrompts((list) => [...list, prompt]);
        },
        () => add(drive, parent, files, emptyFolders), // each upload finds out for itself
      );
    },
    [add],
  );

  function answer(prompt: Prompt, upload: boolean) {
    setPrompts((list) => list.filter((p) => p !== prompt));
    if (!upload) return;
    const rest = prompt.files.filter((picked) => !prompt.there.has(picked));
    if (rest.length > 0 || prompt.emptyFolders.length > 0) add(prompt.drive, prompt.parent, rest, prompt.emptyFolders);
  }

  const renameDrive = useCallback((from: string, to: string) => {
    setPrompts((list) => list.map((p) => (p.drive === from ? { ...p, drive: to } : p)));
    const jobs = [...queue.current, ...failed.current.values()];
    if (current.current) jobs.push(current.current.job);
    for (const { batch } of jobs) if (batch.drive === from) batch.drive = to;
    for (const left of leftovers.current.values()) if (left.drive === from) left.drive = to;
  }, []);

  const adopt = useCallback((drive: string) => {
    void api.unfinishedUploads(drive).then(
      (found) => {
        // Read once the answer is in, so an upload started meanwhile isn't shown twice.
        const known = new Set<string>();
        const jobs = [...queue.current, ...failed.current.values()];
        if (current.current) jobs.push(current.current.job);
        for (const job of jobs) if (job.upload) known.add(job.upload);
        for (const u of lineRef.current.others.values()) if (u.upload) known.add(u.upload);
        for (const left of leftovers.current.values()) known.add(left.upload);
        const added: Item[] = [];
        for (const u of found) {
          if (u.active || known.has(u.id)) continue; // being sent, by this tab or another
          const id = nextId.current++;
          leftovers.current.set(id, {
            drive,
            upload: u.id,
            parent: u.path.length > 0 ? u.path[u.path.length - 1].id : null,
            name: u.name,
            size: u.size,
            stored: u.stored,
            modified: u.modified,
          });
          added.push({
            id,
            name: [...u.path.map((c) => c.name), u.name].join("/"),
            size: u.size,
            sent: u.stored,
            stored: u.stored,
            moved: 0,
            speed: null,
            status: "interrupted",
          });
        }
        if (added.length > 0) setItems((list) => [...list, ...added]);
      },
      () => undefined,
    );
  }, []);

  function cancel(id: number) {
    if (current.current?.job.id === id) {
      current.current.abort();
      return;
    }
    const job = queue.current.find((j) => j.id === id);
    queue.current = queue.current.filter((j) => j.id !== id);
    // A queued retry or resumed upload already holds a place on the server.
    if (job?.upload) void api.cancelUpload(job.batch.drive, job.upload).catch(() => undefined);
    patch(id, { status: "cancelled" });
    requestSync();
  }
  cancelRef.current = cancel;

  /** Asks the tab sending it to stop. */
  function cancelOther(key: string) {
    cancels.current.add(key);
    requestSync();
  }

  function cancelAll() {
    for (const job of [...queue.current]) cancel(job.id);
    if (current.current) cancel(current.current.job.id);
    for (const [key, u] of lineRef.current.others) if (ACTIVE.includes(u.status)) cancelOther(key);
  }

  function retry(id: number) {
    const job = failed.current.get(id);
    if (!job) return;
    failed.current.delete(id);
    job.run = undefined; // its average starts over, without the time it sat failed
    queue.current.push(job);
    patch(id, { status: "queued", error: undefined, speed: null });
    requestSync();
  }

  /** Picks up a leftover with its file, chosen again. Returns why not, if it isn't the same file. */
  function resume(id: number, file: File): string | null {
    const left = leftovers.current.get(id);
    if (!left) return null;
    if (file.name !== left.name || file.size !== left.size) {
      return `That's not the same file. Choose ${left.name} (${formatSize(left.size)}).`;
    }
    if (left.modified !== null && file.lastModified !== left.modified) {
      return "That file has changed since the upload started. Discard this one and upload it again.";
    }
    leftovers.current.delete(id);
    const batch: Batch = { drive: left.drive, parent: left.parent, folders: new Map() };
    queue.current.push({ id, batch, dirs: [], file, upload: left.upload, stored: left.stored });
    patch(id, { status: "queued", error: undefined, upload: left.upload });
    requestSync();
    return null;
  }

  /** A failed or interrupted upload still holds its name on the server until discarded. */
  function discard(id: number) {
    const job = failed.current.get(id);
    failed.current.delete(id);
    if (job?.upload) void api.cancelUpload(job.batch.drive, job.upload).catch(() => undefined);
    const left = leftovers.current.get(id);
    leftovers.current.delete(id);
    if (left) void api.cancelUpload(left.drive, left.upload).catch(() => undefined);
    setItems((list) => list.filter((item) => item.id !== id));
  }

  function dismissAll() {
    for (const id of [...failed.current.keys(), ...leftovers.current.keys()]) discard(id);
    for (const [key, u] of lineRef.current.others) if (!ACTIVE.includes(u.status)) hidden.current.add(key);
    setItems([]);
    setClock({ spent: 0, since: null });
  }

  // Rows in line order: this tab's, and other tabs' (on this device or others).
  const rows: { key: string; item: Item; other: boolean }[] = [];
  const placed = new Set<number>();
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const key of line.order) {
    const u = line.others.get(key);
    if (u) {
      const item = fromLine(u, firstMoved.current.get(key) ?? 0);
      if (!hidden.current.has(key)) rows.push({ key, item, other: true });
      continue;
    }
    const item = key.startsWith(`${CLIENT}:`) ? byId.get(Number(key.slice(CLIENT.length + 1))) : undefined;
    if (item) {
      rows.push({ key, item, other: false });
      placed.add(item.id);
    }
  }
  for (const item of items) if (!placed.has(item.id)) rows.push({ key: keyOf(item.id), item, other: false });
  // Finished rows sink below the rest, so what's still going stays in view at the top.
  const finished = (row: (typeof rows)[number]) => row.item.status === "done" || row.item.status === "cancelled";
  rows.sort((a, b) => Number(finished(a)) - Number(finished(b)));
  const shown = rows.map((row) => row.item);
  // Failed rows have a section of their own, folded away, so they don't push the rest out of view.
  const failures = rows.filter((row) => row.item.status === "error");
  const listed = rows.filter((row) => row.item.status !== "error");

  const sending = items.some((item) => ACTIVE.includes(item.status));
  const busy = shown.some((item) => ACTIVE.includes(item.status));

  useEffect(() => {
    const now = Date.now();
    setClock((c) => {
      if (busy) return c.since === null ? { ...c, since: now } : c;
      return c.since === null ? c : { spent: c.spent + now - c.since, since: null };
    });
  }, [busy]);

  // Only this tab has its files: closing it stops them.
  useEffect(() => {
    if (!sending) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [sending]);

  // In the tab's title too, for when another tab is in front. Rounded down: 100% is all of it.
  const uploaded = busy ? Math.floor(percentOf(tally(shown).stored, tally(shown).total)) : null;
  useEffect(() => {
    if (uploaded === null) return;
    document.title = `${uploaded}% uploaded · ${PAGE_TITLE}`;
    return () => {
      document.title = PAGE_TITLE;
    };
  }, [uploaded]);

  const [minimized, setMinimized] = useSavedFlag(MINIMIZED_KEY);

  const rowFor = ({ key, item, other }: (typeof rows)[number]) => (
    <UploadRow
      key={key}
      item={item}
      other={other}
      onCancel={() => (other ? cancelOther(key) : cancel(item.id))}
      onRetry={() => retry(item.id)}
      onResume={(file) => resume(item.id, file)}
      onDiscard={() => discard(item.id)}
    />
  );

  const value = useMemo(() => ({ enqueue, renameDrive, adopt }), [enqueue, renameDrive, adopt]);

  return (
    <Context.Provider value={value}>
      {children}
      {rows.length > 0 && (
        <section
          aria-label="Uploads"
          className="fixed inset-x-3 bottom-[calc(var(--dock,0px)+0.75rem)] z-40 overflow-hidden rounded-2xl border border-line bg-surface shadow-xl shadow-black/25 transition-[bottom] duration-200 sm:left-auto sm:right-6 sm:w-96 sm:bottom-[calc(var(--dock,0px)+1.5rem)]"
        >
          <Summary
            items={shown}
            clock={clock}
            minimized={minimized}
            onToggle={() => setMinimized(!minimized)}
            onCancelAll={cancelAll}
            onDismiss={dismissAll}
          />
          <div id="upload-list" hidden={minimized}>
            {listed.length > 0 && (
              <ul className="max-h-[min(16rem,40dvh)] overflow-y-auto">{listed.map(rowFor)}</ul>
            )}
            {failures.length > 0 && (
              <Failures count={failures.length} divided={listed.length > 0}>
                {failures.map(rowFor)}
              </Failures>
            )}
          </div>
        </section>
      )}
      {prompts.length > 0 && (
        <SkipDialog
          key={prompts[0].id}
          prompt={prompts[0]}
          onCancel={() => answer(prompts[0], false)}
          onSkip={() => answer(prompts[0], true)}
        />
      )}
    </Context.Provider>
  );
}

/** The failed uploads, behind a line saying how many there are. */
function Failures({ count, divided, children }: { count: number; divided: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={divided ? "border-t border-line" : ""}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="failed-uploads"
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] font-medium text-danger hover:bg-ink/4"
      >
        <CircleAlert size={16} className="shrink-0" aria-hidden="true" />
        <span className="flex-1">{count} failed</span>
        <ChevronRight
          size={16}
          className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
      </button>
      <ul
        id="failed-uploads"
        hidden={!open}
        className="max-h-[min(12rem,30dvh)] overflow-y-auto border-t border-line"
      >
        {children}
      </ul>
    </div>
  );
}

/** How many of the files to skip are named in the dialog. */
const NAMED = 100;

/** Asks whether to go on without the files the drive already has. */
function SkipDialog({
  prompt,
  onCancel,
  onSkip,
}: {
  prompt: Prompt;
  onCancel: () => void;
  onSkip: () => void;
}) {
  const { files, there, emptyFolders } = prompt;
  const skipped = there.size;
  const rest = files.length - skipped;
  const all = rest === 0;
  // Empty folders are still made when every file is skipped.
  const nothing = all && emptyFolders.length === 0;
  const one = skipped === 1;
  const names = [...there].slice(0, NAMED).map(({ file, dirs }) => [...dirs, file.name].join("/"));

  const state = prompt.queued ? "already uploaded or in the queue" : "already uploaded";
  let title: string;
  if (all) title = one ? `This file is ${state}` : `All ${skipped} files are ${state}`;
  else title = `${skipped} of ${files.length} files ${one ? "is" : "are"} ${state}`;

  return (
    <Dialog title={title} onClose={onCancel}>
      <p className="text-sm text-muted">
        {one ? "A file" : "Files"} with the same name and size {one ? "is" : "are"} already in the same place
        {prompt.queued ? ", or on the way there." : "."}
        {!all && ` Skip ${one ? "it" : "them"} and upload the other ${rest === 1 ? "file" : `${rest} files`}?`}
      </p>
      <ul className="mt-4 max-h-[min(12rem,30dvh)] overflow-y-auto rounded-lg border border-line px-3 py-2 text-[13px]">
        {names.map((name) => (
          <li key={name} className="truncate py-0.5">
            {name}
          </li>
        ))}
        {skipped > NAMED && <li className="py-0.5 text-muted">and {skipped - NAMED} more</li>}
      </ul>
      <DialogActions>
        {!nothing && <Button onClick={onCancel}>Cancel</Button>}
        <Button variant="primary" data-autofocus onClick={onSkip}>
          {nothing ? "OK" : all ? "Make empty folders" : `Skip ${one ? "it" : skipped} and upload ${rest}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** Another tab's row, as this one shows it. `moved` counts only what moved since it was first seen. */
function fromLine(u: QueuedUpload, movedBefore: number): Item {
  return {
    id: u.id,
    name: u.name,
    size: u.size,
    sent: u.sent,
    stored: u.stored,
    moved: Math.max(0, u.moved - movedBefore),
    speed: u.speed,
    status: u.status,
    note: u.note ?? undefined,
    until: u.until ?? undefined,
    wait: u.wait ?? undefined,
    error: u.error ?? undefined,
    upload: u.upload ?? undefined,
  };
}

const percentOf = (bytes: number, total: number) => (total > 0 ? Math.min(100, (bytes / total) * 100) : 100);

/** How far the whole lot has got: everything uploaded or still going; not what was
 * cancelled, failed or is waiting for its file. */
function tally(items: Item[]) {
  const counted = items.filter((item) => item.status === "done" || ACTIVE.includes(item.status));
  const sum = (bytes: (item: Item) => number) => counted.reduce((n, item) => n + bytes(item), 0);
  return {
    count: counted.length,
    done: counted.filter((item) => item.status === "done").length,
    total: sum((item) => item.size),
    sent: sum((item) => (item.status === "done" ? item.size : item.sent)),
    stored: sum((item) => (item.status === "done" ? item.size : item.stored)),
  };
}

/** The panel's header: how far the whole lot has got, a way to stop it, and to fold the list away. */
function Summary({
  items,
  clock,
  minimized,
  onToggle,
  onCancelAll,
  onDismiss,
}: {
  items: Item[];
  clock: { spent: number; since: number | null };
  /** Only this header shows, with the overall progress even for one file. */
  minimized: boolean;
  onToggle: () => void;
  onCancelAll: () => void;
  onDismiss: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const busy = items.some((item) => ACTIVE.includes(item.status));
  const now = useNow(busy);
  useEffect(() => {
    if (!busy) setConfirming(false);
  }, [busy]);

  const { count, done, total, sent, stored } = tally(items);
  const moved = items.reduce((sum, item) => sum + item.moved, 0);
  const ms = clock.spent + (clock.since === null ? 0 : now - clock.since);
  const speed = ms >= 1000 && moved > 0 ? (moved * 1000) / ms : null;
  const left = speed && busy ? formatDuration((total - stored) / speed) + " left" : null;
  const waiting = items.filter((item) => item.status === "interrupted").length;
  // With the list folded away, these are the rows that would otherwise go unnoticed.
  const failed = items.filter((item) => item.status === "error").length;
  const attention = minimized
    ? [failed > 0 && `${failed} failed`, waiting > 0 && count > 0 && `${waiting} unfinished`]
    : [];

  let title: string;
  if (busy) title = count > 1 ? `Uploaded ${done} of ${count} files` : "Uploading 1 file";
  else if (waiting > 0 && count === 0) title = `${waiting} unfinished ${waiting === 1 ? "upload" : "uploads"}`;
  else title = "Uploads finished";

  return (
    <div className={`px-4 py-2.5 ${minimized ? "" : "border-b border-line"}`}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="truncate text-sm font-medium" aria-live="polite">
          {title}
        </h2>
        <div className="flex items-center gap-1">
          {busy &&
            (confirming ? (
              <div className="flex items-center gap-1 text-xs">
                <span className="text-muted">Cancel all?</span>
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(false);
                    onCancelAll();
                  }}
                  className="rounded-lg px-2 py-1 font-medium text-danger hover:bg-danger/10"
                >
                  Yes
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="rounded-lg px-2 py-1 font-medium text-muted hover:bg-ink/5 hover:text-ink"
                >
                  No
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="rounded-lg px-2 py-1 text-xs font-medium text-muted hover:bg-ink/5 hover:text-ink"
              >
                Cancel all
              </button>
            ))}
          {!busy && (
            <button type="button" onClick={onDismiss} aria-label="Dismiss uploads" className={ICON_BUTTON}>
              <X size={16} />
            </button>
          )}
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!minimized}
            aria-controls="upload-list"
            aria-label={minimized ? "Show uploads" : "Minimize uploads"}
            title={minimized ? "Show uploads" : "Minimize"}
            className={ICON_BUTTON}
          >
            {minimized ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>
      </div>
      {(count > 1 || (minimized && count > 0)) && (
        <>
          <p className="text-xs text-muted">
            {[
              `${formatSize(stored)} of ${formatSize(total)}`,
              speed && `${formatSize(speed)}/s${busy ? "" : " on average"}`,
              left,
              ...attention,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {busy && (
            <Bar
              sent={percentOf(sent, total)}
              stored={percentOf(stored, total)}
              label="Overall upload progress"
              text={`${formatSize(stored)} of ${formatSize(total)} stored`}
            />
          )}
        </>
      )}
    </div>
  );
}

/** Sent, then the part of it already safe in Telegram. */
function Bar({ sent, stored, label, text }: { sent: number; stored: number; label: string; text: string }) {
  return (
    <div
      className="relative mt-1.5 h-1 overflow-hidden rounded-full bg-ink/10"
      role="progressbar"
      aria-valuenow={Math.round(stored)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={text}
      aria-label={label}
    >
      <div className="absolute inset-y-0 left-0 rounded-full bg-accent/35" style={{ width: `${sent}%` }} />
      <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${stored}%` }} />
    </div>
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
  other,
  onCancel,
  onRetry,
  onResume,
  onDiscard,
}: {
  item: Item;
  /** Sent by another tab, maybe on another device: it can be cancelled from here, nothing more. */
  other: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onResume: (file: File) => string | null;
  onDiscard: () => void;
}) {
  const now = useNow(item.until !== undefined || item.wait !== undefined);
  const picker = useRef<HTMLInputElement>(null);
  const [mismatch, setMismatch] = useState<string | null>(null);
  const secondsTo = (until: number) => Math.max(0, Math.ceil((until - now) / 1000));
  const percent = (bytes: number) => percentOf(bytes, item.size);
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
        const left = item.speed ? formatDuration((item.size - item.stored) / item.speed) + " left" : null;
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
      case "interrupted":
        return (
          mismatch ??
          `Stopped at ${formatSize(item.stored)} of ${formatSize(item.size)}. Choose the file again to resume.`
        );
    }
  }

  function picked(files: FileList | null) {
    const file = files?.[0];
    if (picker.current) picker.current.value = "";
    if (file) setMismatch(onResume(file));
  }

  const trouble = item.status === "retrying" || item.status === "offline" || !!item.wait || !!mismatch;
  const showBar = ["uploading", "finishing", "retrying", "offline", "interrupted"].includes(item.status);
  return (
    <li className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px]">{item.name}</p>
          <p
            className={`text-xs ${item.status === "error" ? "text-danger" : trouble ? "text-brass" : "text-muted"}`}
            aria-live={trouble ? "polite" : undefined}
          >
            {detail()}
            {other && <span className="text-muted"> · Another tab or device</span>}
          </p>
        </div>
        {item.status === "done" && <Check size={16} className="shrink-0 text-accent" aria-label="Uploaded" />}
        {item.status === "offline" && <WifiOff size={16} className="shrink-0 text-brass" aria-hidden="true" />}
        {item.status === "error" && (
          <>
            <CircleAlert size={16} className="shrink-0 text-danger" aria-hidden="true" />
            {!other && (
              <button
                type="button"
                onClick={onRetry}
                aria-label={`Retry upload of ${item.name}`}
                title="Retry"
                className={ICON_BUTTON}
              >
                <RotateCw size={16} />
              </button>
            )}
          </>
        )}
        {item.status === "interrupted" && (
          <>
            <CirclePause size={16} className="shrink-0 text-brass" aria-hidden="true" />
            <input ref={picker} type="file" hidden onChange={(e) => picked(e.target.files)} />
            <button
              type="button"
              onClick={() => picker.current?.click()}
              aria-label={`Choose the file to resume ${item.name}`}
              title="Resume"
              className={ICON_BUTTON}
            >
              <Upload size={16} />
            </button>
          </>
        )}
        {!other && (item.status === "error" || item.status === "interrupted") && (
          <button
            type="button"
            onClick={onDiscard}
            aria-label={`Discard upload of ${item.name}`}
            title="Discard"
            className={ICON_BUTTON}
          >
            <X size={16} />
          </button>
        )}
        {running && (
          <button type="button" onClick={onCancel} aria-label={`Cancel upload of ${item.name}`} className={ICON_BUTTON}>
            <X size={16} />
          </button>
        )}
      </div>
      {showBar && (
        <Bar
          sent={percent(item.sent)}
          stored={percent(item.stored)}
          label={`Upload progress for ${item.name}`}
          text={`${formatSize(item.stored)} of ${formatSize(item.size)} stored`}
        />
      )}
    </li>
  );
}
