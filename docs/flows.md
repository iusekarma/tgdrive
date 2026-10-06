# Request flows

Step by step, what happens for each main operation. "UI" is the browser,
"API" is `server.py`, "Storage" is `storage.py`, "TG" is the transport
(Telegram in production).

- [First-run setup](#first-run-setup)
- [Unlocking the vault and a drive](#unlocking-the-vault-and-a-drive)
- [Resumable upload](#resumable-upload)
- [Resuming after a dropped connection](#resuming-after-a-dropped-connection)
- [Telegram rate limits during an upload](#telegram-rate-limits-during-an-upload)
- [Download and video seeking](#download-and-video-seeking)
- [Deleting](#deleting)
- [Changing a password](#changing-a-password)
- [Thumbnails](#thumbnails)
- [Backup](#backup)
- [Restoring onto a new server](#restoring-onto-a-new-server)

---

## First-run setup

```mermaid
sequenceDiagram
    participant UI
    participant API
    participant St as Storage
    participant B as BackupScheduler
    UI->>API: GET /api/vault
    API-->>UI: {initialized: false, setup_needs_admin}
    UI->>API: POST /api/vault/setup {password, admin_password}
    API->>API: compare admin password (constant time), if configured
    API->>St: setup_vault(password)
    St->>St: random vault key<br/>Argon2id(password) wraps it<br/>random recovery key wraps it
    St->>St: INSERT INTO vault
    St-->>API: VaultKeys, recovery key
    API->>API: create session, set cookie<br/>session.vault = VaultKeys
    API->>B: mark_dirty()
    API-->>UI: 201 {recovery_key}
    UI->>UI: RecoveryKeyDialog (shown once)
```

The recovery key is returned once and never stored. Only the wrapped vault
key is in the database.

## Unlocking the vault and a drive

```mermaid
sequenceDiagram
    participant UI
    participant API
    participant T as LoginThrottle
    participant St as Storage
    participant S as Session
    UI->>API: POST /api/vault/unlock {password}
    API->>T: retry_after(("vault", ip))
    alt too many recent failures
        API-->>UI: 429, Retry-After
    end
    API->>St: unlock_vault(password)
    St->>St: Argon2id in a thread (max 2 at once)<br/>unwrap vault key
    alt wrong password
        St-->>API: BadKey
        API->>T: failed()
        API-->>UI: 401 wrong password
    end
    API->>T: succeeded()
    API->>S: session.vault = VaultKeys (cookie set if new)
    API-->>UI: {unlocked: true}

    UI->>API: GET /api/drives/Photos/nodes
    alt Photos has no password
        API->>St: open_drive(vault, "Photos")
        API->>S: cache in session.drives
        API-->>UI: listing
    else Photos has a password, not unlocked
        API-->>UI: 401 {locked: "drive"}
        UI->>API: POST /api/drives/Photos/unlock {password}
        API->>St: unlock(vault, "Photos", password)
        Note over St: KEK = HKDF(Argon2id(pw), salt = vault binding key)
        API->>S: session.drives["Photos"] = Drive
        API-->>UI: {unlocked: true}
    end
```

Every device that unlocks joins the same session, so they all see the same
unlocked drives. After 30 idle minutes (`TGDRIVE_SESSION_IDLE_MINUTES`)
without a request from any device the session is forgotten; the next request gets `401 {locked: "vault"}` and the UI returns
to the login screen.

## Resumable upload

The web UI always uses resumable uploads. A file of 40 MiB with 16 MiB
chunks becomes three chunks: 16 + 16 + 8.

```mermaid
sequenceDiagram
    participant UI as UI (uploads.tsx)
    participant API
    participant St as Storage
    participant TG as Telegram
    UI->>API: POST /uploads {filename, parent_id, size: 40 MiB}
    API->>St: start_upload()
    St->>St: check name is free<br/>new file key (wrapped)<br/>INSERT node state='uploading'<br/>UploadState(chunks=3) in memory
    API-->>UI: {id, chunk_size, stored: 0}

    UI->>API: PUT /uploads/{id}?offset=0 (body: whole file, XHR)
    par client keeps sending
        UI-->>API: bytes...
    and UI polls once a second
        UI->>API: GET /uploads/{id}
        API-->>UI: {stored, phase, wait}
    end
    loop each time 16 MiB has arrived (and the short last chunk)
        St->>St: encrypt chunk i (AAD: node, i, final?)
        St->>TG: sendDocument(random name .bin)
        TG-->>St: message_id, file_id
        St->>St: INSERT INTO chunks, stored += size
    end
    St->>St: state='ready', size set
    API-->>UI: 201 {done: true, entry}
    UI->>API: PUT /files/{id}/thumbnail (made from the local file)
```

## Resuming after a dropped connection

```mermaid
sequenceDiagram
    participant UI
    participant API
    participant St as Storage
    UI->>API: PUT /uploads/{id}?offset=0
    Note over UI,API: 24 MiB sent, then the Wi-Fi drops
    Note over St: chunk 0 (16 MiB) is stored<br/>8 MiB of chunk 1 in the buffer is dropped
    UI->>UI: status 'offline' — wait for the 'online' event
    UI->>API: GET /uploads/{id}
    API-->>UI: {stored: 16 MiB}
    UI->>API: PUT /uploads/{id}?offset=16 MiB (file.slice(16 MiB))
    Note over St: waits on the upload's lock if the old<br/>request is still finishing a chunk
    St->>St: continue from chunk 1
    API-->>UI: 201 done
```

What happens in other cases:

| Situation | Server answer | UI does |
|---|---|---|
| Offset ahead of what is stored | 409 | Asks for status, resumes from `stored` |
| Offset behind what is stored | accepted | Server skips bytes it already has |
| Telegram gave up after 6 tries | 503 | Backs off (2 s … 30 s), resumes |
| Upload idle for an hour, or server restarted | 404 on status | Starts that file again from 0 |
| User cancels | — | Aborts XHR, `DELETE /uploads/{id}`; server purges stored chunks |
| More than 8 tries in a row without progress | — | Shows the error with Retry and Discard |
| Tab closed or reloaded mid-upload | `GET /uploads` lists it when the drive is next opened | Shows it as unfinished: choose the file again to resume, or discard it |
| The same file is uploaded again into the same folder | `POST /uploads` returns the unfinished upload's id and `stored` | Resumes from `stored` instead of failing with "already exists" |

## Telegram rate limits during an upload

Telegram limits how fast a bot can post to one chat. When it answers 429,
the transport waits and the UI explains why:

```mermaid
sequenceDiagram
    participant UI
    participant API
    participant St as Storage.write_upload
    participant TG as TelegramTransport._call
    St->>St: on_wait.set(state.waiting)
    St->>TG: put(chunk)
    TG->>TG: sendDocument → 429, retry_after 12
    TG->>St: report_wait(Wait("rate_limited", 12.5, 1, 6))<br/>(via the context variable)
    St->>St: phase = 'waiting', wait_until = now + 12.5
    UI->>API: GET /uploads/{id}
    API-->>UI: {phase: "waiting", wait: {reason: "rate_limited", retry_in: 11.9}}
    UI->>UI: "Telegram asked to slow down. Trying again in 12 s."
    TG->>TG: sleep, then sendDocument → ok
```

## Download and video seeking

```mermaid
sequenceDiagram
    participant V as UI video player
    participant API
    participant St as Storage
    participant TG as Telegram
    V->>API: GET /files/{id}?inline=true<br/>Range: bytes=3500000000-
    API->>API: parse_range → (3.5 GB, size)<br/>inline only for safe types
    API->>St: download(drive, id, start, end)
    St->>St: check chunk map is complete<br/>first = start // chunk_size
    St->>TG: getFile + download chunk 208 only
    St->>St: decrypt (AAD checks node, index, final)
    St-->>API: first slice
    Note over API: first piece pulled before the status line,<br/>so a broken chunk becomes a real error
    API-->>V: 206 Partial Content, Content-Range
    loop remaining chunks in range
        St->>TG: download next chunk
        St-->>V: decrypted slice
    end
```

Only chunks overlapping the requested range are fetched from Telegram.

## Deleting

```mermaid
sequenceDiagram
    participant UI
    participant API
    participant St as Storage
    participant BG as background task
    participant TG as Telegram
    UI->>API: POST /nodes/delete {ids: [folder]}
    API->>St: delete_nodes(drive, ids)
    St->>St: one transaction:<br/>recursive CTE collects every chunk ref under the folder<br/>DELETE node (children cascade)
    St->>St: remove thumbnails, mark in-flight uploads gone
    St-->>API: [BlobRef, ...]
    API->>BG: discard(refs)
    API->>API: mark_dirty()
    API-->>UI: 204 (right away)
    BG->>TG: deleteMessages (100 per call)
```

## Changing a password

Changing either password re-wraps one 32-byte key. No file in Telegram is
touched.

```mermaid
flowchart LR
    subgraph MP["Master password change"]
        A1["unlock with current password<br/>(throttled)"] --> A2["vault key (already in session)"] --> A3["Argon2id(new password) wraps it"] --> A4["UPDATE vault"]
    end
    subgraph DP["Drive password change"]
        B1["unlock drive with current password<br/>(throttled)"] --> B2["drive master key"] --> B3["bound KEK from new password wraps it"] --> B4["UPDATE drives"] --> B5["forget the drive in<br/>every other session"]
    end
```

Removing a drive's password re-wraps its master key with the open-drive key
and deletes its recovery key. Adding one creates a new recovery key, shown
once.

## Thumbnails

```mermaid
flowchart TD
    subgraph BR["Made in the browser (normal path)"]
        U1["upload finishes"] --> U2["draw image / video frame<br/>onto a 320px canvas"] --> U3["PUT /files/{id}/thumbnail"]
    end
    subgraph SV["Made on the server (fallback for images)"]
        G1["GET /files/{id}/thumbnail"] --> G2{"cached?"}
        G2 -- no --> G3{"image ext,<br/>≤ 50 MB,<br/>not failed before?"}
        G3 -- no --> G404["404 → UI shows an icon"]
        G3 -- yes --> G4["download & decrypt the file"]
    end
    U3 --> M
    G4 --> M["thumbs.make():<br/>re-encode to 320px WebP"]
    M --> E["seal with the file key"] --> W["write /cache/thumbs/&lt;id&gt;.thumb<br/>trim cache if over limit"]
    G2 -- yes --> D["decrypt, update mtime"] --> OUT["200 image/webp, no-store"]
    W --> OUT
```

## Backup

```mermaid
sequenceDiagram
    participant R as any change
    participant B as BackupScheduler
    participant St as Storage
    participant TG as Telegram
    R->>B: mark_dirty()
    B->>B: sleep 30 s (more changes merge in)
    B->>St: backup()
    St->>St: VACUUM INTO temp file, gzip
    St->>St: TGD1 + data, or TGD2 + salt + AES-GCM(Argon2id(passphrase))
    St->>TG: sendDocument(caption "tgdrive-snapshot")
    St->>TG: pinChatMessage(new)
    St->>TG: deleteMessage(previous snapshot)
```

On shutdown, `BackupScheduler.stop()` uploads one final snapshot if
anything changed since the last one.

## Restoring onto a new server

```mermaid
sequenceDiagram
    participant L as lifespan()
    participant TG as Telegram
    participant FS as /data
    L->>FS: tgdrive.db exists?
    FS-->>L: no
    L->>TG: getChat → pinned message
    alt pinned message is a tgdrive snapshot
        L->>TG: download it
        L->>L: open_snapshot (needs TGDRIVE_BACKUP_PASSPHRASE for TGD2)
        L->>FS: write tgdrive.db
    else no snapshot
        L->>L: start with an empty database
    else any other error (network, wrong passphrase)
        L->>L: refuse to start
    end
    L->>L: connect, cleanup_incomplete, sweep_thumbnails
    Note over L: the user logs in with the same master password
```

Startup refuses to continue on an unexpected restore error on purpose: a
server that started empty would, 30 seconds after its first change, pin an
empty snapshot over the good one.
