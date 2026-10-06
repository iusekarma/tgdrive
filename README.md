# tgdrive

**Self-hosted, encrypted cloud drive that stores your files in a private Telegram channel.**

Files are split into chunks, encrypted on your server, and uploaded to a
Telegram channel that only you control. You get a web UI to browse, upload,
preview and search them, all behind one master password. Each drive can also
have a password of its own.

- End-to-end encrypted: Telegram only ever sees encrypted chunks
- Web UI with folders (upload whole folders), uploads that resume after a dropped connection, search, image and video thumbnails, previews, and range downloads (video seeking)
- Several drives, each optionally protected by its own password
- Recovery keys for every password
- The database is backed up to the channel automatically, so a lost server is not a lost drive
- One Docker container; a CLI and an HTTP API are included

---

## Contents

- [Quick start (Docker)](#quick-start-docker)
- [Step 1: Set up Telegram](#step-1-set-up-telegram)
- [Step 2: Configure and start](#step-2-configure-and-start)
- [Step 3: First login](#step-3-first-login)
- [Changing the host and port](#changing-the-host-and-port)
- [Accessing it from other devices](#accessing-it-from-other-devices)
- [Starting and stopping](#starting-and-stopping)
- [What you must not lose](#what-you-must-not-lose)
- [Updating](#updating)
- [Command-line interface](#command-line-interface)
- [Running without Docker](#running-without-docker)
- [Settings](#settings)
- [How it works](#how-it-works)
- [HTTP API](#http-api)
- [Development and tests](#development-and-tests)

---

## Quick start (Docker)

You need [Docker](https://docs.docker.com/get-docker/) with Docker Compose,
and a Telegram account.

```bash
git clone https://github.com/<your-user>/tgdrive.git
cd tgdrive
cp backend/.env.example backend/.env    # then fill in TG_BOT_TOKEN and TG_CHAT_ID (see below)
docker compose up -d --build
```

Open **http://localhost:8000** and set your master password.

The steps below explain each part.

## Step 1: Set up Telegram

tgdrive needs a bot and a private channel where the bot can post.

1. **Create a bot.** In Telegram, open [@BotFather](https://t.me/BotFather),
   send `/newbot` and follow the prompts. Copy the **token** it gives you
   (it looks like `123456789:AAH...`).
2. **Create a private channel.** Any name works. Keep it private.
3. **Add the bot as an admin** of the channel with these rights:
   - Post messages
   - Edit messages (needed to pin the database backup)
   - Delete messages
4. **Find the channel ID.** It is a negative number like `-1001234567890`.
   One way to get it:
   - Post any message in the channel.
   - Open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser.
   - Look for `"chat":{"id":-100...` in the `channel_post` entry.

   Alternatively, open the channel in [Telegram Web](https://web.telegram.org/a/):
   the URL ends in `#-1234567890`; put `-100` in front of the digits
   (`-1001234567890`).

## Step 2: Configure and start

Copy the example settings and fill in the two required values:

```bash
cp backend/.env.example backend/.env
```

```ini
# backend/.env
TG_BOT_TOKEN=123456789:AAH...
TG_CHAT_ID=-1001234567890
```

Everything else is optional; see [Settings](#settings). Two worth
considering now:

- `TGDRIVE_BACKUP_PASSPHRASE`: encrypts the database backup in the channel
  so drive names, sizes and dates are hidden too. If you set it, store it
  safely: you need it to restore.
- `TGDRIVE_ADMIN_PASSWORD`: required for first-time setup in the web UI.
  Set it if anyone other than you can reach the server before you finish setup.

Then build and start:

```bash
docker compose up -d --build
docker compose logs -f        # Ctrl+C to stop following the logs
```

## Step 3: First login

1. Open **http://localhost:8000**.
2. Choose a **master password**.
3. tgdrive shows a **recovery key once**. Save it in a password manager now.
   If you forget the master password and lose this key, every drive is gone.
4. Create a drive. Give it its own password if you want an extra lock;
   that also shows a recovery key once.
5. Upload files or whole folders by dragging them into the window.

Restarting the server locks everything; you just enter the master password again.

## Changing the host and port

By default tgdrive is published on `127.0.0.1:8000`, so only the machine
running it can open it. Set these two variables to change that:

| Variable | Default | Meaning |
|---|---|---|
| `TGDRIVE_HOST` | `127.0.0.1` | Host address to listen on. `0.0.0.0` means all network interfaces |
| `TGDRIVE_PORT` | `8000` | Port on your machine |

Put them in a `.env` file **in the repository root**, next to
[compose.yaml](compose.yaml). This is a different file from `backend/.env`:
Compose reads the root `.env` to fill in `compose.yaml`, while `backend/.env`
holds the app's settings.

```ini
# .env (repository root)
TGDRIVE_PORT=9000
```

Then apply the change; Compose recreates the container:

```bash
docker compose up -d
```

tgdrive is now at http://localhost:9000.

You can also set them for a single run without a file:

```bash
TGDRIVE_PORT=9000 docker compose up -d
```

Inside the container the server always listens on port 8000; these
variables only change which host address and port it is published on.

If you use plain `docker run` instead of Compose, set them in `-p`:

```bash
docker run -d -p 127.0.0.1:9000:8000 --env-file backend/.env \
  -v ./backend/data:/data tgdrive:latest
```

## Accessing it from other devices

To reach tgdrive from your phone or other computers:

- **Recommended:** put a reverse proxy with HTTPS in front (Caddy, nginx,
  Traefik, or a Cloudflare/Tailscale tunnel), then set in `backend/.env`:

  ```ini
  TGDRIVE_COOKIE_SECURE=true
  ```

  and uncomment `FORWARDED_ALLOW_IPS` in [compose.yaml](compose.yaml) so
  password-guessing protection sees real client IPs. If the proxy runs on
  the same machine, keep `TGDRIVE_HOST` at `127.0.0.1`.

- **Trusted home network only:** set `TGDRIVE_HOST=0.0.0.0` in the root
  `.env` to listen on all interfaces over plain HTTP, then open
  `http://<server-ip>:8000`. Your passwords then travel unencrypted over the
  network, so don't do this on networks you don't trust.

## Starting and stopping

```bash
docker compose up -d       # start, or apply changes to compose.yaml / .env files
docker compose stop        # stop; `docker compose start` brings it back
docker compose down        # stop and remove the container
docker compose logs -f     # follow the logs
```

Your data is kept in all cases: the database is in `backend/data/` and your
files are in Telegram. Running `docker compose up -d` again leaves a running
container alone unless its configuration or image changed; if it did, the
container is recreated. Any stop or restart locks all drives, so you enter
the master password again. On stop, the server uploads a last database
backup to the channel.

## What you must not lose

| Thing | Where it lives | If lost |
|---|---|---|
| Master password | Your head / password manager | Use the master recovery key ("Forgot the master password?" in the UI) |
| Master recovery key | Shown once at setup | Fine while you still know the master password. With neither, **every drive is gone** |
| Drive password (if the drive has one) | Your head / password manager | Use that drive's recovery key |
| Drive recovery key | Shown once when a drive gets a password | Fine while you still know the drive password. With neither, that drive is gone |
| The Telegram channel | Your Telegram account | **Everything is gone**; there is no second copy of your files |
| `TGDRIVE_BACKUP_PASSPHRASE` (if set) | `backend/.env` | Needed to restore the database from the channel |
| `TG_BOT_TOKEN` | `backend/.env` | Create a new bot and add it to the channel; files are still readable |
| Database | `backend/data/`, plus a backup pinned in the channel | Rebuilt automatically from the channel backup |
| Thumbnail cache | `tgdrive-cache` Docker volume | Nothing; thumbnails are rebuilt |

### Moving to a new server

Your files and the database backup are in the channel, so you only need to
bring `backend/.env`:

1. Clone the repository on the new machine and copy `backend/.env` over.
2. Run `docker compose up -d --build` with an empty `backend/data/` folder.
3. tgdrive restores the database from the channel on first start. Log in with
   your existing master password.

Don't run two servers against the same channel at the same time.

## Updating

```bash
git pull
docker compose up -d --build
```

Your data in `backend/data/` and the channel is kept.

## Command-line interface

The CLI runs inside the container:

```bash
docker compose exec tgdrive python -m app.cli drives
```

It asks for the master password, or reads it from `TGDRIVE_MASTER_PASSWORD`.

| Command | What it does |
|---|---|
| `init` | Set the master password (prints its recovery key once) |
| `drives` | List drives |
| `create-drive NAME [--no-password]` | Create a drive, with or without its own password |
| `rename-drive DRIVE NEW_NAME` | Rename a drive (its keys and files are unchanged) |
| `rm-drive DRIVE` | Delete a drive and all its files |
| `put DRIVE FILE [--as NAME]` | Upload a file, optionally under another name |
| `ls DRIVE` | List files |
| `get DRIVE NAME OUT` | Download a file |
| `rm DRIVE NAME` | Delete a file |
| `change-master-password` | Change the master password |
| `reset-master-password` | Set a new master password using the recovery key |
| `drive-password DRIVE [--remove]` | Add, change or remove a drive's password |
| `reset-password DRIVE` | Set a new drive password using its recovery key |
| `backup` | Upload a database backup to the channel now |
| `restore [--overwrite]` | Rebuild the database from the channel backup |

## Running without Docker

Requires Python 3.12+ and Node.js 22+.

```bash
# Web UI
cd frontend
npm ci
npm run build                 # outputs frontend/dist

# Server
cd ../backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # fill in TG_BOT_TOKEN and TG_CHAT_ID
TGDRIVE_STATIC_DIR=../frontend/dist \
  uvicorn app.server:app --host 127.0.0.1 --port 8000
```

Use `--port` to pick a different port. Keep it to one worker: unlocked keys
and sessions live in that one process.

Don't run Docker and a local server against the same database at once.

## Settings

All settings go in `backend/.env` (see [backend/.env.example](backend/.env.example)).

| Variable | Default | Meaning |
|---|---|---|
| `TG_BOT_TOKEN` | — | **Required.** Bot token from @BotFather |
| `TG_CHAT_ID` | — | **Required.** Channel ID, like `-1001234567890` |
| `TGDRIVE_BACKUP_PASSPHRASE` | unset | Encrypts the database backup in the channel. Needed to restore it |
| `TGDRIVE_ADMIN_PASSWORD` | unset | If set, required for first-time setup in the web UI |
| `TGDRIVE_COOKIE_SECURE` | `false` | Set to `true` when serving over HTTPS |
| `TGDRIVE_SESSION_IDLE_MINUTES` | `30` | Idle time before a session's drives lock |
| `TGDRIVE_THUMB_CACHE_MB` | `512` | Size limit of the thumbnail cache; `0` for no limit |
| `TGDRIVE_BACKUP_DEBOUNCE_SECONDS` | `30` | Delay between a change and its backup |
| `TGDRIVE_CHUNK_SIZE` | `16777216` | Chunk size in bytes (16 MB) |
| `TGDRIVE_TRANSPORT` | `telegram` | `local` stores chunks on disk instead, for trying tgdrive without Telegram |
| `TGDRIVE_LOCAL_DIR` | `./data/blobs` | Where chunks go with `TGDRIVE_TRANSPORT=local` |
| `TGDRIVE_DB` | `./data/tgdrive.db` | Database path (fixed to `/data` in Docker) |
| `TGDRIVE_CACHE_DIR` | `./cache` | Thumbnail cache folder (fixed to `/cache` in Docker) |
| `TGDRIVE_STATIC_DIR` | unset | Built web UI to serve at `/` (set in the Docker image) |

## How it works

A summary follows. For diagrams and a walkthrough of every module, see
[docs/](docs/README.md).

**Storage.** Every file is split into chunks, each encrypted with a key
unique to that file, and sent to the channel as a document message. The
local SQLite database records which messages make up which file, along with
the encrypted file names and wrapped keys.

**Passwords.** Nothing opens until the master password is entered. Drives
without a password then open straight away. Drives with a password also need
that password; it is cryptographically bound to the master password, so
neither one alone opens the drive, even for someone holding a copy of the
database. Changing a password re-wraps a single 32-byte key, so it is instant
regardless of how much the drive holds.

**Sessions.** Unlocked keys live only in server memory. There is one
session, shared by every device you log in from: a drive unlocked on your
laptop is unlocked on your phone too, and logging out (or the idle timeout)
locks all of them. Each device still needs the master password once, and
gets its own HttpOnly, SameSite=Strict cookie. Restarting the server locks
everything.

**Backups.** Within 30 seconds of any change, the server uploads a snapshot
of the database to the channel and pins it, and it uploads a final one on
shutdown. If the database file is missing on startup, it is restored from
that snapshot. The snapshot contains only wrapped keys and encrypted names,
but drive names, sizes and timestamps are readable unless you set
`TGDRIVE_BACKUP_PASSPHRASE`.

**Uploads.** The web UI sends one file at a time, across all your devices:
every device shows the same upload list, with progress, and files chosen
on one device wait behind those another device is already sending. (The
bytes still come from the device that has the file, so keep that tab open
until its files are done.) It shows each file's speed, what
is already stored in Telegram, and when the server is waiting out a Telegram
rate limit or error. If the connection drops, or Telegram gives up for a
while, the upload resumes from the last stored chunk (16 MB), trying again
for a few minutes, and waits while your device is offline. An unfinished
upload is discarded after an hour without progress, or when the server
restarts.

**Thumbnails.** Your browser makes thumbnails of images and videos right
after uploading them. Images uploaded other ways get one made on the server
when first shown (up to 50 MB). Thumbnails are encrypted and cached on the
server, not in Telegram, to stay within Telegram's rate limits; lost ones are
rebuilt.

**Search.** The search box (shortcut `/`) matches file and folder names
across the whole drive; every word you type must appear in the name. Names
are decrypted in memory for each search, about half a second per 100,000
items.

**Deleting** removes entries at once; the Telegram messages are deleted in
the background.

## HTTP API

Interactive docs are served at **http://localhost:8000/api/docs**.

<details>
<summary>Endpoint list</summary>

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/vault` | Whether tgdrive is set up and whether this session has it unlocked |
| POST | `/api/vault/setup` | First run only: set the master password; returns its recovery key once |
| POST | `/api/vault/unlock` · `/recover` · `/password` | Unlock / reset with the recovery key / change the master password |
| POST | `/api/logout` | Lock everything and end the session, on every device |
| GET | `/api/drives` | List drives, whether each has a password, and whether it is unlocked |
| POST | `/api/drives` | Create a drive, with or without a password |
| POST | `/api/drives/{name}/unlock` · `/lock` | Unlock a drive that has a password / lock it again |
| POST | `/api/drives/{name}/recover` | Set a new drive password using the drive's recovery key |
| POST | `/api/drives/{name}/password` | Add, change or remove the drive's password |
| POST | `/api/drives/{name}/rename` | Rename the drive (`{"name": ...}`); a drive with a password must be unlocked |
| POST | `/api/drives/{name}/delete` | Delete the drive and all its files |
| GET | `/api/drives/{name}/nodes?parent=ID` | List a folder (with breadcrumb path) |
| GET | `/api/drives/{name}/search?q=X` | Search names across the whole drive |
| POST | `/api/drives/{name}/folders` | Create a folder (`"exist_ok": true` returns one already there) |
| PATCH | `/api/drives/{name}/nodes/{id}` | Rename and/or move |
| DELETE | `/api/drives/{name}/nodes/{id}` | Delete a file or folder |
| POST | `/api/drives/{name}/nodes/move` · `/nodes/delete` | Move or delete many at once (`{"ids": [...]}`) |
| PUT | `/api/drives/{name}/files?filename=X&parent=ID` | Upload in one request; the body is the raw file |
| POST | `/api/drives/{name}/uploads` | Start a resumable upload (`{"filename", "parent_id", "size"}`) |
| PUT | `/api/drives/{name}/uploads/{id}?offset=N` | Send the file from byte N; 201 when complete, 503 if Telegram gave up (resume later) |
| GET · DELETE | `/api/drives/{name}/uploads/{id}` | How much is stored and what the server is doing / cancel |
| POST | `/api/uploads/sync` | The upload line every device shares: report this tab's uploads, get everyone's |
| POST | `/api/uploads/leave` | A closing tab leaves the upload line |
| GET | `/api/drives/{name}/files/{id}` | Download; supports `Range` and `?inline=true` |
| GET · PUT | `/api/drives/{name}/files/{id}/thumbnail` | Get or upload a 320px WebP thumbnail |

Drive routes answer 401 with `"locked": "vault"` or `"locked": "drive"` to
say which password is needed.

</details>

## Development and tests

Run the server as in [Running without Docker](#running-without-docker), then
start the UI dev server, which proxies `/api` to port 8000:

```bash
cd frontend
npm run dev                   # http://localhost:5173
```

To develop without Telegram, set `TGDRIVE_TRANSPORT=local` in `backend/.env`.

Tests:

```bash
cd backend
python -m unittest discover -s tests -t . -v
```
