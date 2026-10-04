export type VaultStatus = { initialized: boolean; unlocked: boolean; setup_needs_admin: boolean };
export type DriveInfo = { name: string; protected: boolean; unlocked: boolean };
export type Entry = {
  id: string;
  kind: "file" | "dir";
  name: string;
  size: number;
  created_at: number;
  thumb: boolean;
};
export type Crumb = { id: string; name: string };
export type Listing = { path: Crumb[]; entries: Entry[] };
/** `path` is the folders above the match, from the top of the drive. */
export type SearchResult = Entry & { path: Crumb[] };
export type SearchResults = { total: number; results: SearchResult[] };
/** The server is waiting to try Telegram again. */
export type UploadWait = {
  reason: "rate_limited" | "unreachable" | "server_error";
  attempt: number;
  attempts: number;
  retry_in: number;
};
/** `stored` bytes are safe in Telegram; an interrupted upload resumes from there. */
export type UploadStatus =
  | {
      done: false;
      size: number;
      stored: number;
      phase: "idle" | "receiving" | "storing" | "waiting";
      wait: UploadWait | null;
    }
  | { done: true; entry: Entry };

/** status 0 = server unreachable, -1 = cancelled by the user.
 * `locked` says what a 401 wants: the master password or a drive's own. */
export class ApiError extends Error {
  status: number;
  locked: "vault" | "drive" | null;
  constructor(status: number, message: string, locked: "vault" | "drive" | null = null) {
    super(message);
    this.status = status;
    this.locked = locked;
  }
}

function lockedOf(body: unknown): "vault" | "drive" | null {
  if (body && typeof body === "object" && "locked" in body) {
    const locked = (body as { locked: unknown }).locked;
    if (locked === "vault" || locked === "drive") return locked;
  }
  return null;
}

let onVaultLocked = () => {};

/** Called whenever the server says the vault is locked (idle timeout, restart). */
export function setVaultLockedHandler(handler: () => void) {
  onVaultLocked = handler;
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function detailOf(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return sentence(detail);
    if (Array.isArray(detail) && detail.length > 0) {
      const msg = (detail[0] as { msg?: unknown }).msg;
      if (typeof msg === "string") return sentence(msg);
    }
  }
  return fallback;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check that it is running.");
  }
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const locked = lockedOf(data);
    if (locked === "vault") onVaultLocked();
    throw new ApiError(res.status, detailOf(data, `Request failed (${res.status}).`), locked);
  }
  return data as T;
}

const drivePath = (name: string) => `/drives/${encodeURIComponent(name)}`;

type RecoveryResult = { recovery_key: string | null };

export const api = {
  vault: () => request<VaultStatus>("GET", "/vault"),
  setupVault: (password: string, adminPassword: string) =>
    request<{ recovery_key: string }>("POST", "/vault/setup", { password, admin_password: adminPassword || null }),
  unlockVault: (password: string) => request<unknown>("POST", "/vault/unlock", { password }),
  recoverVault: (recoveryKey: string, newPassword: string) =>
    request<unknown>("POST", "/vault/recover", { recovery_key: recoveryKey, new_password: newPassword }),
  changeVaultPassword: (currentPassword: string, newPassword: string) =>
    request<void>("POST", "/vault/password", { current_password: currentPassword, new_password: newPassword }),

  drives: () => request<DriveInfo[]>("GET", "/drives"),
  /** Without a password the drive opens with the master password. */
  createDrive: (name: string, password: string | null) =>
    request<{ name: string; protected: boolean } & RecoveryResult>("POST", "/drives", { name, password }),
  unlock: (drive: string, password: string) => request<unknown>("POST", `${drivePath(drive)}/unlock`, { password }),
  lock: (drive: string) => request<void>("POST", `${drivePath(drive)}/lock`),
  recover: (drive: string, recoveryKey: string, newPassword: string) =>
    request<unknown>("POST", `${drivePath(drive)}/recover`, { recovery_key: recoveryKey, new_password: newPassword }),
  /** Add (no current), change, or remove (no new) a drive's own password. */
  setDrivePassword: (drive: string, currentPassword: string | null, newPassword: string | null) =>
    request<{ protected: boolean } & RecoveryResult>("POST", `${drivePath(drive)}/password`, {
      current_password: currentPassword,
      new_password: newPassword,
    }),
  renameDrive: (drive: string, name: string) =>
    request<{ name: string }>("POST", `${drivePath(drive)}/rename`, { name }),
  deleteDrive: (drive: string, password: string) => request<void>("POST", `${drivePath(drive)}/delete`, { password }),
  logout: () => request<void>("POST", "/logout"),

  list: (drive: string, parent: string | null) =>
    request<Listing>("GET", `${drivePath(drive)}/nodes${parent ? `?parent=${encodeURIComponent(parent)}` : ""}`),
  search: (drive: string, q: string) =>
    request<SearchResults>("GET", `${drivePath(drive)}/search?${new URLSearchParams({ q }).toString()}`),
  /** With `existOk`, a folder already of that name is returned instead of an error. */
  createFolder: (drive: string, parent: string | null, name: string, existOk = false) =>
    request<Entry>("POST", `${drivePath(drive)}/folders`, { name, parent_id: parent, exist_ok: existOk }),
  rename: (drive: string, id: string, name: string) =>
    request<Entry>("PATCH", `${drivePath(drive)}/nodes/${id}`, { name }),
  move: (drive: string, id: string, parent: string | null) =>
    request<Entry>("PATCH", `${drivePath(drive)}/nodes/${id}`, { parent_id: parent }),
  moveMany: (drive: string, ids: string[], parent: string | null) =>
    request<void>("POST", `${drivePath(drive)}/nodes/move`, { ids, parent_id: parent }),
  startUpload: (drive: string, parent: string | null, filename: string, size: number) =>
    request<{ id: string; chunk_size: number }>("POST", `${drivePath(drive)}/uploads`, {
      filename,
      parent_id: parent,
      size,
    }),
  uploadStatus: (drive: string, id: string) => request<UploadStatus>("GET", `${drivePath(drive)}/uploads/${id}`),
  cancelUpload: (drive: string, id: string) => request<void>("DELETE", `${drivePath(drive)}/uploads/${id}`),
  removeMany: (drive: string, ids: string[]) => request<void>("POST", `${drivePath(drive)}/nodes/delete`, { ids }),

  fileUrl: (drive: string, id: string, inline = false) =>
    `/api${drivePath(drive)}/files/${id}${inline ? "?inline=true" : ""}`,
  thumbnailUrl: (drive: string, id: string) => `/api${drivePath(drive)}/files/${id}/thumbnail`,
  putThumbnail: async (drive: string, id: string, image: Blob) => {
    const res = await fetch(`/api${drivePath(drive)}/files/${id}/thumbnail`, { method: "PUT", body: image });
    if (!res.ok) throw new ApiError(res.status, `Thumbnail upload failed (${res.status}).`);
  },
};

/** Sends `body`, the file from `offset` on, to an upload made with api.startUpload.
 * fetch() cannot report upload progress, so this uses XMLHttpRequest. */
export function sendUpload(
  drive: string,
  id: string,
  offset: number,
  body: Blob,
  onProgress: (loaded: number) => void,
): { promise: Promise<UploadStatus>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  xhr.open("PUT", `/api${drivePath(drive)}/uploads/${id}?offset=${offset}`);
  xhr.setRequestHeader("Content-Type", "application/octet-stream");
  xhr.upload.onprogress = (e) => onProgress(e.loaded);
  const promise = new Promise<UploadStatus>((resolve, reject) => {
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error body */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as UploadStatus);
      else reject(new ApiError(xhr.status, detailOf(data, `Upload failed (${xhr.status}).`), lockedOf(data)));
    };
    xhr.onerror = () => reject(new ApiError(0, "The connection was lost."));
    xhr.onabort = () => reject(new ApiError(-1, "Upload cancelled."));
  });
  xhr.send(body);
  return { promise, abort: () => xhr.abort() };
}
