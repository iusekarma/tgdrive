# Architecture

## Components

```mermaid
flowchart LR
    subgraph Browser
        UI["React web UI<br/>(frontend/src)"]
    end

    subgraph Container["Docker container (one process)"]
        direction TB
        API["server.py<br/>FastAPI routes, cookies,<br/>lifespan, static UI"]
        SES["sessions.py<br/>Sessions + LoginThrottle<br/>(unlocked keys live here)"]
        STO["storage.py<br/>Storage"]
        CRY["crypto.py"]
        THB["thumbs.py"]
        BAK["backup.py<br/>BackupScheduler"]
        DBM["db.py"]
        TR["transport/<br/>TelegramTransport | LocalTransport"]
        API --> SES
        API --> STO
        API --> BAK
        STO --> CRY
        STO --> THB
        STO --> DBM
        STO --> TR
        BAK -- "store.backup()" --> STO
    end

    SQL[("SQLite<br/>/data/tgdrive.db")]
    CACHE[("Thumbnail cache<br/>/cache/thumbs")]
    TG[("Private Telegram channel<br/>encrypted chunks +<br/>pinned DB snapshot")]

    UI -- "HTTPS / HTTP<br/>/api/*, cookie" --> API
    DBM --- SQL
    STO --- CACHE
    TR -- "Bot API (httpx)" --> TG

    CLI["cli.py<br/>(docker compose exec)"] --> STO
```

There are three places data lives:

| Where | What | Encrypted? |
|---|---|---|
| Telegram channel | One document message per file chunk, plus one pinned database snapshot | Chunks always. The snapshot only if `TGDRIVE_BACKUP_PASSPHRASE` is set (its keys and names are encrypted either way) |
| SQLite (`/data`) | Vault, drives, folder tree, chunk map | Names and keys yes; sizes, dates, drive names and tree shape no |
| Thumbnail cache (`/cache`) | One 320px WebP per file | Yes, with the file's own key |

And one place keys live: the server's memory, inside a `Session`.

## Layers

The backend is layered so each layer only knows about the one below it:

```mermaid
flowchart TB
    A["HTTP layer — server.py<br/>validation (pydantic), cookies, auth dependencies,<br/>error → status mapping, streaming responses"]
    B["Domain layer — storage.py<br/>vault, drives, nodes, chunking, resumable uploads,<br/>deletion, thumbnails, backup"]
    C["Primitives — crypto.py · db.py · thumbs.py · httprange.py"]
    D["Transport — transport/base.py<br/>put · get · delete · put_snapshot · get_snapshot"]
    E["TelegramTransport (Bot API)   |   LocalTransport (a folder)"]
    A --> B --> C
    B --> D --> E
```

- `server.py` never touches SQL or crypto directly (apart from comparing the
  admin password and catching `BadKey`). It turns HTTP into `Storage` calls.
- `storage.py` never knows about HTTP, cookies or Telegram. It talks to an
  abstract `Transport`, so tests and offline development swap in
  `LocalTransport` with `TGDRIVE_TRANSPORT=local`.
- `cli.py` is a second front end over the same `Storage` class.

## Process model: exactly one worker

The Dockerfile runs `uvicorn --workers 1`, and this is a hard requirement:

- Unlocked vault and drive keys are in `app.state.sessions`, the one
  session every device shares. A second worker would not see them.
- The upload line every device shares (`app.state.uploads`) is in memory.
- In-progress resumable uploads (`Storage._uploads`) are in memory.
- There is one SQLite connection, used only from the event loop thread.

Concurrency inside that one process comes from asyncio. CPU-heavy work is
pushed to worker threads with `asyncio.to_thread`:

| Work | Where it runs | Limit |
|---|---|---|
| Argon2id (password checks) | thread | 2 at once (`_kdf_gate`); each run uses 64 MiB |
| Chunk encrypt/decrypt | thread | one per active upload/download |
| Thumbnail generation (Pillow) | thread | 2 server-made at once (`_thumb_gate`) |
| All SQLite access | event loop thread | — |

## Startup and shutdown

`server.lifespan()` runs once when uvicorn starts and once when it stops.

```mermaid
flowchart TD
    S([uvicorn starts]) --> T["Config.make_transport()"]
    T --> E{"Database file<br/>exists?"}
    E -- no --> R["restore_database():<br/>download pinned snapshot"]
    R -- "no snapshot" --> EMPTY["start with empty DB"]
    R -- "other error" --> FAIL(["abort startup<br/>(never overwrite a good<br/>snapshot with an empty DB)"])
    R -- ok --> OPEN
    EMPTY --> OPEN
    E -- yes --> OPEN["db.connect(): WAL mode,<br/>migrate, create tables"]
    OPEN --> CL["cleanup_incomplete():<br/>purge uploads cut off by the last stop"]
    CL --> SW["sweep_thumbnails():<br/>drop thumbs for deleted files, trim cache"]
    SW --> BK["start BackupScheduler<br/>store.on_change = mark_dirty"]
    BK --> EX["start upload-expiry loop<br/>(every 10 min, drop uploads idle > 1 h)"]
    EX --> RUN([serving requests])
    RUN --> STOP([SIGTERM])
    STOP --> X1["cancel expiry loop"]
    X1 --> X2["await background Telegram deletes"]
    X2 --> X3["BackupScheduler.stop():<br/>final snapshot if anything changed"]
    X3 --> X4["close SQLite and HTTP client"]
```

Because every unlocked key is in memory, **any restart locks everything**.
The Compose file gives the container 60 s (`stop_grace_period`) to upload the
final snapshot.

## Request handling

Each API route declares what it needs with FastAPI dependencies:

```mermaid
flowchart LR
    REQ["request<br/>cookie tgdrive_session"] --> GS["get_session()<br/>Sessions.get(token)<br/>(slides idle timer)"]
    GS --> UV{"unlocked_vault()<br/>session.vault set?"}
    UV -- no --> L1["401 {locked: 'vault'}"]
    UV -- yes --> UD{"unlocked_drive(name)<br/>in session.drives?"}
    UD -- yes --> H["route handler"]
    UD -- "no, drive has no password" --> OD["store.open_drive(vault, name)<br/>cache in session"] --> H
    UD -- "no, drive has a password" --> L2["401 {locked: 'drive'}"]
```

The UI reads the `locked` field to decide whether to show the master
password screen or a drive's unlock dialog.

Exceptions from `storage.py` are mapped to status codes in one place,
`create_app()`:

| Exception | Status | Meaning |
|---|---|---|
| `NotFound` | 404 | No such drive, node or upload |
| `Conflict`, `NoVault` | 409 | Name taken; already set up; not set up; resume offset ahead of what is stored |
| `Gone` | 410 | Upload cancelled or expired while being written |
| `TransportUnavailable` | 503 | Telegram gave up after its retries; what was stored is kept |
| `StorageError`, `BadImage` | 400 | Anything else the caller did wrong |
| `Locked` | 401 | Body says `"locked": "vault"` or `"drive"` |
| `crypto.BadKey` (outside a password check) | 500 | Stored data failed its integrity check |

Password checks go through `_throttled()`, which turns `BadKey` into a 401
and applies the per-client backoff (see [sessions.py](backend.md#sessionspy)).

## Serving the web UI

When `TGDRIVE_STATIC_DIR` is set (it is in the Docker image), `server.py`
also serves the built frontend:

- `/assets/*` (Vite output with content hashes) is cached for a year as
  `immutable`.
- Any other non-`/api` path returns `index.html`, so client-side routes such
  as `/d/Photos/<folder-id>` survive a reload.
- `index.html` is sent with a strict Content-Security-Policy: scripts only
  from the same origin, no inline script, `blob:` allowed only for images
  and media (decrypted thumbnails and previews), `frame-ancestors 'none'`.

In development, Vite serves the UI on port 5173 and proxies `/api` to
FastAPI on 8000, so cookies stay same-origin.

## Deployment

```mermaid
flowchart LR
    subgraph Host
        ENV1[".env (repo root)<br/>TGDRIVE_HOST, TGDRIVE_PORT"] -.->|read by| COMPOSE
        ENV2["backend/.env<br/>bot token, chat id, tuning"] -.->|env_file| C
        COMPOSE["docker compose"] --> C
        DATA["./backend/data"] <-->|"bind mount /data"| C
        VOL["volume tgdrive-cache"] <-->|"/cache"| C
        C["container tgdrive<br/>uid 1000, uvicorn :8000"]
    end
    USER["browser"] -- "TGDRIVE_HOST:TGDRIVE_PORT → 8000" --> C
    C -- "api.telegram.org" --> TG[("Telegram")]
```

The [Dockerfile](../Dockerfile) has two stages: `node:22-alpine` runs
`npm ci && npm run build`, and `python:3.12-slim` installs the backend and
copies the built UI to `/app/static`. The container runs as uid 1000 so the
bind-mounted `backend/data` stays writable from the host. A health check
calls `GET /api/health` every 30 s.
