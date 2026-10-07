# Frontend modules

React 19 + TypeScript, built with Vite and styled with Tailwind CSS 4.
Source in [frontend/src](../frontend/src).

| Library | Used for |
|---|---|
| `@tanstack/react-query` | All server data: fetching, caching, invalidation |
| `react-router-dom` | Routes `/`, `/d/:drive`, `/d/:drive/:folderId` |
| `lucide-react` | Icons |
| `@fontsource-variable/bricolage-grotesque` | The UI font, bundled (the CSP allows no third-party origins) |
| `mpegts.js` | Plays `.ts`/`.m2ts` video through Media Source; loaded only when one is opened |

The browser never holds a key. It sends passwords to the server, gets a
session cookie back, and from then on sees only decrypted names and file
bytes that the server streams to it.

## Component tree

```mermaid
flowchart TD
    main["main.tsx<br/>QueryClient · BrowserRouter"] --> App["App.tsx"]
    App --> UP["UploadsProvider<br/>(components/uploads.tsx)<br/>upload queue + panel"]
    UP --> VG["VaultGate<br/>setup / login screens"]
    VG -->|"/"| DP["DrivesPage"]
    VG -->|"/d/:drive[/:folderId]"| BP["BrowserPage"]
    DP --> DD["driveDialogs.tsx<br/>Unlock · Create · Rename · Password ·<br/>MasterPassword · Delete · RecoveryKey"]
    BP --> SB["Sidebar<br/>drives + folder tree"]
    BP --> FD["fileDialogs.tsx<br/>Name · Delete · Move"]
    BP --> VW["viewer.tsx<br/>full-window viewer"]
    BP --> TH["thumbs.ts"]
    UP --> TH
    DP & BP & SB & FD & VW & DD & VG & UP --> API["api.ts"]
    DP & BP & FD & DD & VG --> UI["ui.tsx primitives"]
```

`UploadsProvider` sits **above** `VaultGate` and the router, so uploads keep
running while you move between folders and drives.

## React Query keys

Every server read goes through React Query. Keys are arranged so one
invalidation refreshes everything affected:

| Key | Data | Invalidated / removed when |
|---|---|---|
| `["vault"]` | `GET /vault` (set up? unlocked?) | Login, logout, and any response saying `locked: "vault"` |
| `["drives"]` | `GET /drives` | Drives created, renamed, deleted, locked, password changed |
| `["nodes", drive, parent]` | One folder listing | Any change in that drive (`["nodes", drive]` prefix) |
| `["nodes", drive, "search", q]` | Search results | Same prefix, so results refresh with the folder |
| `["info", drive, id]` | A file's details | Never refetched (`staleTime: Infinity`); updated in place by whatever learns more |
| `["zip", drive, id]` | A zip's entry list | Never refetched; dropped with everything else when the vault locks |
| `["comicPage", drive, id, path]` | One decompressed comic page | Garbage-collected 30 s after it leaves the screen |

Queries do not retry 4xx answers (a locked drive won't unlock itself) and
are fresh for 5 s.

When the vault is locked (logout, idle timeout, server restart), every
query except `["vault"]` is removed, so nothing decrypted stays in memory.
Locking or leaving one drive removes `["nodes", drive]` and its thumbnails.

---

## main.tsx and App.tsx

`main.tsx` creates the `QueryClient`, registers the vault-locked handler
(`setVaultLockedHandler` → invalidate `["vault"]`), and renders. `App.tsx`
declares the routes; unknown paths redirect to `/`.

## api.ts

The typed client. `request()` wraps `fetch` for JSON calls and turns every
failure into an `ApiError` with:

- `status`: the HTTP status, `0` for "can't reach the server", `-1` for
  "cancelled by the user".
- `locked`: `"vault"`, `"drive"` or `null`, from the 401 body.
- `message`: the server's `detail`, capitalised, or a fallback.

Any response with `locked: "vault"` also fires the vault-locked handler, so
an expired session anywhere sends the app back to the login screen.

`api` has one method per endpoint. `fileUrl` and `thumbnailUrl` build URLs
for `<a href>`, `<img>`, `<video>` and `fetch`, which carry the cookie
automatically.

`sendUpload()` uses `XMLHttpRequest` rather than `fetch`, because only XHR
reports upload progress. It returns the promise and an `abort()` function.

## components/VaultGate.tsx

Nothing below it renders until the vault is unlocked. It reads `["vault"]`
and shows one of:

- **SetupScreen** (not initialized): choose the master password, plus the
  admin password if the server requires one. Then shows the recovery key
  once in `RecoveryKeyDialog`.
- **LoginScreen** (locked): master password, or switch to "Forgot the
  master password?" to reset it with the recovery key.
- the app (unlocked).

`useLockEverything()` logs out, drops decrypted thumbnails, removes all
cached queries and refetches the vault status.

## components/uploads.tsx

The upload queue, its retry logic, and the floating progress panel. The
most involved part of the frontend.

**Input.** `pickedFromInput()` handles the file and folder pickers (folder
paths come from `webkitRelativePath`). `readDropped()` walks dropped
folders with the File System Entries API (`webkitGetAsEntry`,
`readEntries` in batches) and returns files with their folder path, plus
empty folders.

**Queue.** `enqueue(drive, parent, files, emptyFolders)` adds one `Job` per
file or empty folder. All jobs from one drop share a `Batch`, whose
`folders` map caches the id of each folder created, so a 1,000-file drop
creates each folder once (`createFolder(..., exist_ok=true)`).

**One file at a time, across devices.** Telegram rate-limits bots per chat,
so parallel uploads would trade speed for retries. Every tab reports its
rows to the server's shared upload line (`POST /uploads/sync`, see
[uploadqueue.py](backend.md#uploadqueuepy)) once a second while anything is
going (every 3 s otherwise), sending only rows whose object changed since
the last sync. The answer carries other tabs' rows, which the panel shows
in line order with a "Another tab or device" note; they can be cancelled
from here (the owning tab sees `cancel` and stops) but not retried. `pump()`
runs the next job only when none is running here and nothing ahead of it
in the line is still going, so a new upload queues behind whatever another
device is sending. Enqueuing, retrying and finishing a job sync at once
rather than waiting for the next tick; closing the tab sends
`/uploads/leave` with `sendBeacon` so the next device need not wait for the
server to time this one out.

**Resume and retry.** `run(job)` loops:

```mermaid
flowchart TD
    A["make folders for job.dirs"] --> B{"job.upload set?"}
    B -- no --> C["POST /uploads → id"] --> S
    B -- yes --> D["GET /uploads/id"]
    D -- done --> OK([finished])
    D -- "stored = N" --> S["send(file.slice(N), offset=N)<br/>poll status every 1 s"]
    S -- "201 done" --> OK
    S -- "200, body cut short" --> ERR
    S -- error --> ERR{"what failed?"}
    ERR -- "404 on resume<br/>(expired / server restarted)" --> RS["forget upload id, start over"] --> W
    ERR -- "0, 408, 429, 5xx, 503,<br/>or 409 offset mismatch" --> W{"offline?"}
    ERR -- "other 4xx" --> FAIL([error: show Retry / Discard])
    W -- yes --> OFF["status 'offline'<br/>wait for the 'online' event<br/>(doesn't use up a try)"] --> B
    W -- no --> BO["status 'retrying'<br/>wait 2, 4, 8 … 30 s"] --> B
    BO -.->|"more than 8 failures<br/>without progress"| FAIL
```

The failure counter resets whenever `stored` has moved forward, so a long
upload over a flaky connection keeps going as long as it makes progress.

**Progress.** The bar shows two layers: bytes the browser has **sent**
(light) and bytes **stored** in Telegram (solid), from polling
`GET /uploads/{id}` once a second. Speed is a moving average: 5 s while
sending, 20 s while the server is storing (it moves 16 MiB at a time).
When the server reports a `wait`, the row says why ("Telegram asked to slow
down. Trying again in 12 s.").

**After an upload**, `sendDetails()` makes a thumbnail and reads the
file's details from the local copy in the background while the next file
starts.

The chevron in the panel's header folds the list away, leaving the header
with the overall progress (even for one file) and a count of failed or
unfinished rows; the choice is remembered in `localStorage`.

While this tab is sending anything, a `beforeunload` handler asks before
the tab is closed. Failed jobs are kept so **Retry** resumes from where they stopped;
**Discard** cancels the upload on the server, freeing its name.

## thumbs.ts

**Loading.** `loadThumbnail(drive, id)` fetches
`/files/{id}/thumbnail`, turns it into an object URL, and caches it in a
`Map` for this tab only (the server sends `no-store`, so decrypted
thumbnails never reach the disk cache). At most 3 requests run at once,
leaving browser connections free for navigation. A 404 is remembered as
"no thumbnail"; other failures are retried later. `forgetThumbnails(drive?)`
revokes the URLs.

`hasThumbnail(entry)` says whether asking can succeed: the server says it
has one, or it is an image of 50 MB or less (which the server can make on
demand).

**Making.** After an upload, `sendDetails()` draws an image, or a video
frame about 10% in (at most 30 s), onto a canvas scaled to 320 px and
`PUT`s it as WebP (PNG where WebP encoding is unsupported). The server
re-encodes whatever it receives. This means Telegram is never asked for a
file just to thumbnail it. `sendFrame()` does the same from a video being
watched, for videos uploaded before thumbnails existed.

The same decode yields the file's details (dimensions, length, EXIF date
and camera, last-modified time), sent with one `PUT /files/{id}/info`.

## fileinfo.ts

File details are only ever gathered for free: from the local copy while
uploading, from a preview already on screen, or by the server while making
an image thumbnail. Nothing downloads a file just to describe it.

`useFileInfo(drive, entry)` reads `GET /files/{id}/info` (database only).
`useLearn(drive, id)` returns a function that previews call with what the
media element found (`naturalWidth`, `videoWidth`, `duration`); it sends
only fields that differ from what is cached. `readExif(file)` parses the
date taken and camera from the first 256 KB of a local JPEG.

## format.ts

Formatting and shared constants: `formatSize`, `formatDate`,
`formatDuration`, `formatLength` (media length), `formatDateTime`,
`typeName(name, size)` ("JPEG image"), `previewKind(name, size)` (image, video, audio, pdf, text,
archive, comic or none, by extension; `.ts` over 1 MiB counts as video, smaller as TypeScript),
`isTransportStream(name)`,  `PASSWORD_MIN = 8`, `DRIVE_NAME` (same pattern as the
server), and `driveUrl(drive, folderId)`.

## pages/DrivesPage.tsx

The home page: every drive as a list or grid, with a lock dial showing
whether it is unlocked. Opening a locked drive shows `UnlockDialog`.
A drive's menu offers lock, rename, add/change/remove password, and delete.
The page header offers create drive, change master password and lock
everything.

If `BrowserPage` finds its drive locked (session idle, locked elsewhere), it
navigates here with `state: { unlock, from }`. The page opens the unlock
dialog straight away and returns to the folder afterwards.

## pages/BrowserPage.tsx

The file browser for one drive and folder.

- **Listing**: `["nodes", drive, parent]`, as a list or grid (remembered in
  `localStorage`), with thumbnails, breadcrumbs, and the `Sidebar`.
- **Search**: the query lives in the URL (`?q=`), debounced by 250 ms, so
  Back returns to the results. Results replace the folder listing and show
  each match's folder path. `/` focuses the box.
- **Selection**: click with Ctrl/Cmd to toggle, Shift for a range; once
  anything is selected, plain clicks select too. Ctrl/Cmd+A selects all,
  Esc clears, Delete/Backspace deletes, F2 renames.
- **Actions**: new folder, upload files, upload folder, rename, move (one or
  many), delete (one or many), download, preview, lock drive.
- **Drag and drop**: files and folders dropped anywhere on the page go to
  `uploads.enqueue` for the current folder.
- **Opening**: folders navigate; previewable files open the `Viewer`;
  others download.
- **Details**: each item's menu has **Details**, which opens
  `DetailsDialog`. On wide screens the panel button beside the view toggle
  shows `DetailsPanel` (remembered in `localStorage`): the one selected item,
  totals for several, or the folder when nothing is selected.

## components/Sidebar.tsx

Lists every drive, with the folder tree of unlocked drives. Folders load
lazily (`["nodes", drive, id]`, only when expanded), sharing the cache with
the main listing. It expands itself down to the folder being viewed.
Clicking a locked drive goes to the drives page to unlock it.

## components/driveDialogs.tsx

| Component | Does |
|---|---|
| `NewPasswordFields`, `checkNewPassword` | Password + repeat, minimum length |
| `UnlockDialog` | Drive password, or reset with the drive's recovery key |
| `CreateDriveDialog` | Name, and optionally a password |
| `RenameDriveDialog` | Renames the drive; the page that opened it then re-points queued uploads with `uploads.renameDrive` |
| `RecoveryKeyDialog` | Shows a recovery key once, with copy, and requires confirming it was saved |
| `DrivePasswordDialog` | Add, change or remove a drive password |
| `MasterPasswordDialog` | Change the master password |
| `DeleteDriveDialog` | Type the drive's password (or the master password) to delete it |

## components/fileDialogs.tsx

| Component | Does |
|---|---|
| `NameDialog` | New folder / rename |
| `DeleteNodeDialog` | Confirms deleting one or many entries |
| `MoveDialog` | Folder picker to move entries into |

## components/viewer.tsx

`Viewer` is a full-window `<dialog>` that steps through the previewable files
of the listing (or search results) it was opened from.

- **Header**: name, size, "3 of 12", Details toggle (`i`; the panel is
  `EntryDetails`, remembered in `localStorage`), Download, Close (Esc).
- **Stepping**: ← / → buttons and keys, and a horizontal swipe on touch
  screens for images and audio. Keys are left alone while a media element
  has focus, so its own seeking keys still work.
- **What it shows**: images, video, audio and PDF (iframe) through
  `?inline=true`, which the server honours only for safe types. Text fetches
  the first 512 KB with a `Range` request. MPEG-TS video (`.ts`, `.m2ts`,
  `.mts`) is repackaged in the browser by mpegts.js, which reads the file
  with range requests. Files the browser can't decode say so and offer the
  download.
- **Zips** (`zip`, `jar`, `apk`): `listZip()` in `zip.ts` reads the
  last 64 KiB (the end record and usually the whole central directory), and
  the directory itself if it starts earlier; ZIP64 adds at most one more
  read. So listing costs the server one or two chunk fetches from Telegram,
  however large the archive. Entries are shown as folders you can step
  into, with sizes, dates and a lock on encrypted entries.
- **Comics** (`cbz`): the same index gives the page images (sorted by name,
  skipping `__MACOSX` and dot files). `readZipEntry()` fetches one page with
  one range request and inflates it with the browser's
  `DecompressionStream("deflate-raw")`, so the file is never downloaded
  whole. Two pages are read ahead once the current one is in. Arrow keys,
  swipes and tapping either half of the page turn pages, and only move to
  the next file past the last page. A slider jumps anywhere. The page
  reached is remembered per file in `localStorage`. Page images are cached
  as `["comicPage", drive, id, path]` for 30 s after they leave the screen.

## components/ui.tsx and LockDial.tsx

Small shared pieces: `Button`, `Field`, `ErrorNote`, `Dialog` (native
`<dialog>`), `Menu`/`MenuItem`, `PageHeader`, `ViewToggle` and
`useSavedView`, and `useSubmit()` (busy and error state for a form action).
`LockDial` is the combination-lock icon whose knob turns when a drive is
unlocked.

## index.css

Tailwind entry point plus the colour tokens (`--paper`, `--surface`,
`--ink`, `--muted`, `--line`, `--teal`, `--brass`, `--danger`) used across
the components, with a second set for dark mode.
