/** Reads a video by byte range, keeping only the most recent part in memory. */

const BLOCK = 1024 * 1024;
/** Requests end on these boundaries: the server reads whole chunks of this size from Telegram. */
const ALIGN = 16 * 1024 * 1024;
const FIRST_RUN = 2;
const LONGEST_RUN = ALIGN / BLOCK;
/** Never more than this much of the file is kept. */
const KEEP = 48 * 1024 * 1024;
const ATTEMPTS = 4;

/** The file couldn't be fetched, as opposed to not being playable. */
export class FetchError extends Error {}

export interface Bytes {
  readonly size: number;
  read(start: number, end: number): Promise<Uint8Array<ArrayBuffer>>;
  /** What is still being fetched is no longer wanted, unless someone is waiting for it. */
  abandon(): void;
  close(): void;
}

export class BlobBytes implements Bytes {
  readonly size: number;
  constructor(private blob: Blob) {
    this.size = blob.size;
  }
  async read(start: number, end: number) {
    return new Uint8Array(await this.blob.slice(start, end).arrayBuffer());
  }
  abandon() {}
  close() {}
}

interface Waiting {
  promise: Promise<Uint8Array<ArrayBuffer>>;
  resolve: (data: Uint8Array<ArrayBuffer>) => void;
  reject: (error: unknown) => void;
  waiters: number;
}

interface Run {
  blocks: Set<number>;
  abandoned: boolean;
  controller: AbortController;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpBytes implements Bytes {
  /** Oldest use first. */
  private blocks = new Map<number, Uint8Array<ArrayBuffer>>();
  private loading = new Map<number, Waiting>();
  private runs = new Set<Run>();
  private lastRun = FIRST_RUN;
  private closed = false;

  constructor(
    private url: string,
    readonly size: number,
  ) {}

  async read(start: number, end: number) {
    const out = new Uint8Array(end - start);
    const first = Math.floor(start / BLOCK);
    const last = Math.floor((end - 1) / BLOCK);
    for (let i = first; i <= last; i++) {
      const block = await this.block(i);
      const at = i * BLOCK;
      const from = Math.max(start - at, 0);
      const part = block.subarray(from, Math.min(end - at, block.length));
      out.set(part, at + from - start);
    }
    return out;
  }

  private async block(i: number): Promise<Uint8Array<ArrayBuffer>> {
    const have = this.blocks.get(i);
    if (have) {
      this.blocks.delete(i);
      this.blocks.set(i, have);
      return have;
    }
    if (this.closed) throw new FetchError("closed");
    if (!this.loading.has(i)) this.startRun(i);
    const waiting = this.loading.get(i)!;
    waiting.waiters += 1;
    try {
      return await waiting.promise;
    } finally {
      waiting.waiters -= 1;
      this.trim();
    }
  }

  /** Reading on from what is already here asks for more at once, up to a whole chunk. */
  private startRun(first: number) {
    const sequential = this.blocks.has(first - 1);
    this.lastRun = sequential ? Math.min(this.lastRun * 2, LONGEST_RUN) : FIRST_RUN;
    const total = Math.ceil(this.size / BLOCK);
    const boundary = (Math.floor((first * BLOCK) / ALIGN) + 1) * (ALIGN / BLOCK);
    const end = Math.min(first + this.lastRun, boundary, total);
    const run: Run = { blocks: new Set(), abandoned: false, controller: new AbortController() };
    for (let i = first; i < end && !this.blocks.has(i) && !this.loading.has(i); i++) {
      let resolve!: Waiting["resolve"];
      let reject!: Waiting["reject"];
      const promise = new Promise<Uint8Array<ArrayBuffer>>((res, rej) => ((resolve = res), (reject = rej)));
      promise.catch(() => undefined);
      this.loading.set(i, { promise, resolve, reject, waiters: 0 });
      run.blocks.add(i);
    }
    this.runs.add(run);
    void this.fetchRun(run).catch((e: unknown) => {
      const error = e instanceof FetchError ? e : new FetchError("The video couldn't be loaded.");
      for (const i of run.blocks) {
        this.loading.get(i)?.reject(error);
        this.loading.delete(i);
      }
    }).finally(() => this.runs.delete(run));
  }

  private async fetchRun(run: Run) {
    for (let attempt = 1; run.blocks.size > 0; attempt++) {
      try {
        const before = run.blocks.size;
        await this.fetchOnce(run);
        if (run.blocks.size < before) attempt = 0;
      } catch (e) {
        if (e instanceof FetchError || run.controller.signal.aborted || attempt >= ATTEMPTS) throw e;
      }
      if (run.blocks.size > 0) await sleep(500 * 2 ** attempt);
      if (run.controller.signal.aborted) throw new FetchError("stopped");
    }
  }

  /** Takes in blocks as they arrive, so the first is usable before the last is here. */
  private async fetchOnce(run: Run) {
    let next = Math.min(...run.blocks);
    const start = next * BLOCK;
    const end = Math.min((Math.max(...run.blocks) + 1) * BLOCK, this.size);
    const res = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${end - 1}` },
      signal: run.controller.signal,
    });
    // A locked drive or a deleted file won't come back by asking again.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      throw new FetchError(res.status === 401 ? "The drive is locked." : "The video couldn't be loaded.");
    }
    if (res.status !== 206 || !res.body) throw new Error(`unexpected status ${res.status}`);
    const reader = res.body.getReader();
    let block = new Uint8Array(Math.min(BLOCK, this.size - start));
    let filled = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      for (let used = 0; used < value.length && run.blocks.has(next); ) {
        const take = Math.min(value.length - used, block.length - filled);
        block.set(value.subarray(used, used + take), filled);
        used += take;
        filled += take;
        if (filled < block.length) break;
        this.store(run, next, block);
        next += 1;
        filled = 0;
        block = new Uint8Array(Math.max(0, Math.min(BLOCK, this.size - next * BLOCK)));
      }
    }
  }

  private store(run: Run, i: number, data: Uint8Array<ArrayBuffer>) {
    run.blocks.delete(i);
    this.blocks.set(i, data);
    for (const old of this.blocks.keys()) {
      if (this.blocks.size * BLOCK <= KEEP) break;
      this.blocks.delete(old);
    }
    this.loading.get(i)?.resolve(data);
    this.loading.delete(i);
  }

  abandon() {
    for (const run of this.runs) run.abandoned = true;
    this.trim();
  }

  /** Stops abandoned requests once nobody is waiting for them. */
  private trim() {
    for (const run of this.runs) {
      if (!run.abandoned) continue;
      if ([...run.blocks].some((i) => (this.loading.get(i)?.waiters ?? 0) > 0)) continue;
      for (const i of run.blocks) {
        this.loading.get(i)?.reject(new FetchError("stopped"));
        this.loading.delete(i);
      }
      run.blocks.clear();
      run.controller.abort();
      this.runs.delete(run);
    }
  }

  close() {
    this.closed = true;
    for (const run of this.runs) run.controller.abort();
    this.blocks.clear();
  }
}
