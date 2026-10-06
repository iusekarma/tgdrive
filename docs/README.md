# tgdrive internals

These pages explain how tgdrive works inside: what each module does, how
the pieces talk to each other, and why it is built the way it is. They are
for people who want to change the code or check its security. For
installing and using tgdrive, see the [main README](../README.md).

| Page | What it covers |
|---|---|
| [Architecture](architecture.md) | The big picture: components, process model, startup and shutdown, deployment |
| [Encryption and keys](crypto.md) | The key hierarchy, what each password unlocks, and what Telegram and the database can see |
| [Data model](data-model.md) | The SQLite schema, node states, and what lives in memory instead |
| [Backend modules](backend.md) | Every Python module in `backend/app`, one section each |
| [Frontend modules](frontend.md) | Every file in `frontend/src`, one section each |
| [Request flows](flows.md) | Step-by-step sequence diagrams: setup, unlock, upload, resume, download, delete, backup, restore, thumbnails |

The diagrams are written in [Mermaid](https://mermaid.js.org/). GitHub,
GitLab and VS Code (with a Mermaid extension) draw them in place.

## In one paragraph

tgdrive is a FastAPI server and a React web UI in one Docker container. It
splits each uploaded file into 16 MiB chunks, encrypts each chunk with
AES-256-GCM under a key unique to that file, and posts each encrypted chunk
as a document message in a private Telegram channel. A local SQLite
database records which messages make up which file, plus the encrypted file
names and wrapped keys. Every key is derived from or wrapped by the master
password (and optionally a per-drive password), and unlocked keys exist only
in the server's memory. A gzipped copy of the database is pinned in the same
channel, so a new server with an empty disk rebuilds itself from Telegram.

## Source map

```
tgdrive/
├── Dockerfile              two-stage build: Node builds the UI, Python runs the server
├── compose.yaml            one service, /data bind mount, /cache volume
├── backend/
│   ├── app/
│   │   ├── server.py       HTTP API, sessions/cookies, startup & shutdown, serves the UI
│   │   ├── storage.py      the core: vault, drives, folder tree, upload/download pipeline, thumbnails
│   │   ├── crypto.py       key hierarchy and AES-GCM sealing
│   │   ├── db.py           SQLite schema, migration, snapshot/restore
│   │   ├── sessions.py     in-memory sessions and password-guess throttling
│   │   ├── backup.py       debounced database snapshots
│   │   ├── thumbs.py       safe image → 320px WebP
│   │   ├── httprange.py    Range header parsing
│   │   ├── config.py       environment variables → Config
│   │   ├── cli.py          command-line access to storage.py
│   │   └── transport/
│   │       ├── base.py     Transport interface, BlobRef, retry notifications
│   │       ├── telegram.py Telegram Bot API transport
│   │       └── local.py    directory-backed transport for development and tests
│   └── tests/              unittest suites (run with LocalTransport, no Telegram needed)
└── frontend/
    └── src/
        ├── main.tsx, App.tsx       bootstrapping and routes
        ├── api.ts                  typed client for every endpoint
        ├── thumbs.ts               thumbnail loading and in-browser generation
        ├── format.ts               sizes, dates, preview types, validation constants
        ├── pages/                  DrivesPage (drive list), BrowserPage (file browser)
        └── components/             VaultGate, uploads, Sidebar, dialogs, UI primitives
```
