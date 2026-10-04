import json
import os
import sqlite3
import tempfile
import unittest
from io import BytesIO
from pathlib import Path

from PIL import Image

from app import crypto, db, thumbs
from app.storage import Conflict, NoVault, Storage, StorageError
from app.transport.base import BlobRef
from app.transport.local import LocalTransport
from app.transport.telegram import TelegramTransport

crypto.KDF_PARAMS = {"alg": "argon2id", "t": 1, "m_kib": 64, "p": 1}  # fast, tests only
CHUNK = 1024


async def gen(data: bytes, block: int = 300):
    for i in range(0, len(data), block):
        yield data[i:i + block]


async def read(store, drive, node_id) -> bytes:
    return b"".join([c async for c in store.download(drive, node_id)])


def image_bytes(fmt: str = "PNG", size=(1200, 800)) -> bytes:
    buf = BytesIO()
    Image.new("RGB", size, (200, 40, 40)).save(buf, fmt)
    return buf.getvalue()


class Base(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.blobs = os.path.join(self.tmp.name, "blobs")
        self.thumb_dir = os.path.join(self.tmp.name, "thumbs")
        self.db_path = os.path.join(self.tmp.name, "a.db")
        self.store = Storage(db.connect(self.db_path), LocalTransport(self.blobs),
                             chunk_size=CHUNK, thumb_dir=self.thumb_dir)

    def tearDown(self):
        self.store.conn.close()
        self.tmp.cleanup()

    def blob_count(self) -> int:
        return len([f for f in os.listdir(self.blobs) if f.endswith(".bin")])


class VaultTest(Base):
    async def test_setup_once_and_unlock(self):
        with self.assertRaises(NoVault):
            await self.store.unlock_vault("master-pw")
        self.assertFalse(self.store.vault_exists())
        vault, recovery = await self.store.setup_vault("master-pw")
        with self.assertRaises(Conflict):
            await self.store.setup_vault("another")
        with self.assertRaises(crypto.BadKey):
            await self.store.unlock_vault("wrong")
        again = await self.store.unlock_vault("master-pw")
        self.assertEqual(again.vault_key, vault.vault_key)

        await self.store.set_vault_password(vault, "changed-pw")
        with self.assertRaises(crypto.BadKey):
            await self.store.unlock_vault("master-pw")
        restored = self.store.unlock_vault_with_recovery(recovery)
        self.assertEqual(restored.vault_key, vault.vault_key)

    async def test_open_drive_needs_only_the_vault(self):
        vault, _ = await self.store.setup_vault("master-pw")
        drive, recovery = await self.store.create_drive(vault, "photos", None)
        self.assertIsNone(recovery)
        self.assertFalse(drive.protected)
        nid = await self.store.upload(drive, None, "a.txt", gen(b"hello"))

        opened = self.store.open_drive(await self.store.unlock_vault("master-pw"), "photos")
        self.assertEqual(await read(self.store, opened, nid), b"hello")
        with self.assertRaises(StorageError):
            await self.store.unlock(vault, "photos", "anything")
        with self.assertRaises(StorageError):
            self.store.unlock_with_recovery("photos", "AAAA")

        other = Storage(db.connect(os.path.join(self.tmp.name, "b.db")), LocalTransport(self.blobs), chunk_size=CHUNK)
        stranger, _ = await other.setup_vault("master-pw")   # same password, different vault
        with self.assertRaises(crypto.BadKey):
            self.store.open_drive(stranger, "photos")
        other.conn.close()

    async def test_drive_password_is_bound_to_the_vault(self):
        vault, _ = await self.store.setup_vault("master-pw")
        await self.store.create_drive(vault, "private", "drive-pw")
        other = Storage(db.connect(os.path.join(self.tmp.name, "b.db")), LocalTransport(self.blobs), chunk_size=CHUNK)
        stranger, _ = await other.setup_vault("master-pw")
        with self.assertRaises(crypto.BadKey):
            await self.store.unlock(stranger, "private", "drive-pw")
        other.conn.close()
        await self.store.unlock(vault, "private", "drive-pw")

    async def test_add_and_remove_a_password_without_touching_files(self):
        vault, _ = await self.store.setup_vault("master-pw")
        drive, _ = await self.store.create_drive(vault, "d", None)
        nid = await self.store.upload(drive, None, "f", gen(os.urandom(3000)))
        blobs = sorted(os.listdir(self.blobs))

        recovery = await self.store.set_password(vault, drive, "drive-pw")
        self.assertTrue(recovery)
        self.assertTrue(self.store.drive_info("d").protected)
        with self.assertRaises(StorageError):
            self.store.open_drive(vault, "d")
        unlocked = await self.store.unlock(vault, "d", "drive-pw")
        self.assertEqual(len(await read(self.store, unlocked, nid)), 3000)
        self.assertIsNone(await self.store.set_password(vault, unlocked, "other-pw"))  # keeps its recovery key
        self.store.unlock_with_recovery("d", recovery)

        self.assertIsNone(await self.store.set_password(vault, unlocked, None))
        self.assertFalse(self.store.drive_info("d").protected)
        self.assertEqual(len(await read(self.store, self.store.open_drive(vault, "d"), nid)), 3000)
        with self.assertRaises(StorageError):
            self.store.unlock_with_recovery("d", recovery)
        self.assertEqual(sorted(os.listdir(self.blobs)), blobs)


class LegacyTest(Base):
    async def test_legacy_drive_is_bound_on_first_unlock(self):
        drive_id, master = "legacy-id", crypto.new_master_key()
        salt, params, wrapped = crypto.wrap_with_password(drive_id, master, "old-pw")
        _, recovery_wrapped = crypto.wrap_with_recovery(drive_id, master)
        with self.store.conn:
            self.store.conn.execute(
                "INSERT INTO drives VALUES (?, 'old', 'legacy', ?, ?, ?, ?, 0)",
                (drive_id, salt, json.dumps(params), wrapped, recovery_wrapped))
        vault, _ = await self.store.setup_vault("master-pw")
        changes = []
        self.store.on_change = lambda: changes.append(1)

        drive = await self.store.unlock(vault, "old", "old-pw")
        self.assertEqual(drive.keys.master_key, master)
        self.assertEqual(changes, [1])
        mode = self.store.conn.execute("SELECT mode FROM drives WHERE id = ?", (drive_id,)).fetchone()[0]
        self.assertEqual(mode, "password")
        await self.store.unlock(vault, "old", "old-pw")
        self.assertEqual(changes, [1])

    def test_old_database_is_migrated(self):
        path = os.path.join(self.tmp.name, "old.db")
        conn = sqlite3.connect(path)
        conn.executescript("""
            CREATE TABLE drives (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kdf_salt BLOB NOT NULL,
                kdf_params TEXT NOT NULL, wrapped_key BLOB NOT NULL, recovery_wrapped_key BLOB NOT NULL,
                created_at INTEGER NOT NULL);
            CREATE TABLE nodes (id TEXT PRIMARY KEY,
                drive_id TEXT NOT NULL REFERENCES drives(id) ON DELETE CASCADE,
                parent_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
                kind TEXT NOT NULL, name_enc BLOB NOT NULL, wrapped_key BLOB, size INTEGER NOT NULL DEFAULT 0,
                chunk_size INTEGER, state TEXT NOT NULL DEFAULT 'ready', created_at INTEGER NOT NULL);
            INSERT INTO drives VALUES ('d1', 'old', x'00', '{}', x'00', x'00', 0);
            INSERT INTO nodes (id, drive_id, kind, name_enc, created_at) VALUES ('n1', 'd1', 'dir', x'00', 0);
        """)
        conn.commit()
        conn.close()
        conn = db.connect(path)
        self.assertEqual(tuple(conn.execute("SELECT name, mode FROM drives").fetchone()), ("old", "legacy"))
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM nodes").fetchone()[0], 1)
        conn.execute("DELETE FROM drives")
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM nodes").fetchone()[0], 0)   # cascade still works
        conn.close()


class BulkTest(Base):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.vault, _ = await self.store.setup_vault("master-pw")
        self.drive, _ = await self.store.create_drive(self.vault, "main", None)

    async def test_move_many_is_all_or_nothing(self):
        s, d = self.store, self.drive
        dest = s.mkdir(d, None, "dest")
        a = await s.upload(d, None, "a", gen(b"a"))
        b = await s.upload(d, None, "b", gen(b"b"))
        await s.upload(d, dest, "b", gen(b"taken"))
        with self.assertRaises(Conflict):
            s.move_many(d, [a, b], dest)
        self.assertEqual(sorted(e.name for e in s.list(d)), ["a", "b", "dest"])   # nothing moved
        with self.assertRaises(StorageError):
            s.move_many(d, [a, dest], dest)                                      # a folder into itself
        s.move_many(d, [a, a], dest)
        self.assertEqual(sorted(e.name for e in s.list(d, dest)), ["a", "b"])

    async def test_delete_many_with_nested_selection(self):
        s, d = self.store, self.drive
        folder = s.mkdir(d, None, "f")
        inner = await s.upload(d, folder, "inner", gen(os.urandom(2500)))
        loose = await s.upload(d, None, "loose", gen(os.urandom(100)))
        keep = await s.upload(d, None, "keep", gen(b"keep"))
        self.assertEqual(self.blob_count(), 5)
        refs = s.delete_nodes(d, [folder, inner, loose])
        self.assertEqual(len(refs), 4)
        self.assertEqual([e.id for e in s.list(d)], [keep])
        await s.discard(refs)
        self.assertEqual(self.blob_count(), 1)


class FakeTelegram(TelegramTransport):
    def __init__(self):
        super().__init__("token", "-100")
        self.calls = []

    async def _call(self, method, data=None, files=None):
        self.calls.append((method, data))
        return True


class TelegramBatchTest(unittest.IsolatedAsyncioTestCase):
    async def test_deletes_are_batched_per_chat(self):
        t = FakeTelegram()
        refs = [BlobRef("-100", i, "f") for i in range(250)] + [BlobRef("-200", 1, "f")]
        await t.delete_many(refs)
        await t.close()
        self.assertEqual([m for m, _ in t.calls], ["deleteMessages"] * 4)
        self.assertEqual([len(json.loads(d["message_ids"])) for _, d in t.calls], [100, 100, 50, 1])


class ThumbnailTest(Base):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.vault, _ = await self.store.setup_vault("master-pw")
        self.drive, _ = await self.store.create_drive(self.vault, "main", None)

    def test_make_reencodes_and_rejects(self):
        out = thumbs.make(image_bytes("JPEG", (2000, 1000)))
        with Image.open(BytesIO(out)) as im:
            self.assertEqual((im.format, im.size), ("WEBP", (320, 160)))
        for bad in (b"", b"<svg onload=alert(1)>", b"GIF89a broken"):
            with self.assertRaises(thumbs.BadImage):
                thumbs.make(bad)

    async def test_generated_on_demand_and_encrypted_at_rest(self):
        s, d = self.store, self.drive
        nid = await s.upload(d, None, "photo.png", gen(image_bytes()))
        self.assertFalse(s.stat(d, nid).thumb)
        webp = await s.thumbnail(d, nid)
        self.assertTrue(webp.startswith(b"RIFF"))
        self.assertTrue(s.stat(d, nid).thumb)
        stored = Path(self.thumb_dir, f"{nid}.thumb").read_bytes()
        self.assertNotIn(b"RIFF", stored)
        self.assertEqual(await s.thumbnail(d, nid), webp)

        await s.delete(d, nid)
        self.assertEqual(os.listdir(self.thumb_dir), [])

    async def test_uploaded_thumbnail_for_a_video(self):
        s, d = self.store, self.drive
        nid = await s.upload(d, None, "clip.mp4", gen(os.urandom(3000)))
        self.assertIsNone(await s.thumbnail(d, nid))
        await s.set_thumbnail(d, nid, image_bytes("PNG", (640, 360)))
        self.assertTrue((await s.thumbnail(d, nid)).startswith(b"RIFF"))
        with self.assertRaises(thumbs.BadImage):
            await s.set_thumbnail(d, nid, b"not an image")

    async def test_unreadable_image_is_not_retried(self):
        s, d = self.store, self.drive
        nid = await s.upload(d, None, "broken.jpg", gen(b"definitely not a jpeg"))
        transport_gets = []
        original = s.transport.get

        async def counting(ref):
            transport_gets.append(ref)
            return await original(ref)

        s.transport.get = counting
        self.assertIsNone(await s.thumbnail(d, nid))
        self.assertIsNone(await s.thumbnail(d, nid))
        self.assertEqual(len(transport_gets), 1)

    async def test_sweep_removes_orphans(self):
        s, d = self.store, self.drive
        nid = await s.upload(d, None, "photo.png", gen(image_bytes()))
        await s.thumbnail(d, nid)
        Path(self.thumb_dir, "gone.thumb").write_bytes(b"x")
        self.assertEqual(s.sweep_thumbnails(), 1)
        self.assertEqual(os.listdir(self.thumb_dir), [f"{nid}.thumb"])


    async def test_cache_limit_evicts_least_recently_shown(self):
        s, d = self.store, self.drive
        ids = [await s.upload(d, None, f"p{i}.png", gen(image_bytes())) for i in range(4)]
        for i, nid in enumerate(ids):
            await s.thumbnail(d, nid)
            os.utime(Path(self.thumb_dir, f"{nid}.thumb"), (1000 + i, 1000 + i))
        one = Path(self.thumb_dir, f"{ids[0]}.thumb").stat().st_size
        await s.thumbnail(d, ids[0])                 # shown again: now the most recent
        s.thumb_cache_bytes = int(one * 4.5)         # room for four, so a fifth evicts
        extra = await s.upload(d, None, "p4.png", gen(image_bytes()))
        await s.thumbnail(d, extra)
        kept = sorted(n.split(".")[0] for n in os.listdir(self.thumb_dir))
        self.assertEqual(kept, sorted([ids[0], ids[2], ids[3], extra]))   # p1 went; p0 was shown again
        self.assertEqual(s._thumb_total, sum(p.stat().st_size for p in Path(self.thumb_dir).iterdir()))
        self.assertTrue(await s.thumbnail(d, ids[1]))                # an evicted image comes back


class SearchTest(Base):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.vault, _ = await self.store.setup_vault("master-pw")
        self.drive, _ = await self.store.create_drive(self.vault, "main", None)

    async def test_search_whole_drive_with_paths(self):
        s, d = self.store, self.drive
        trips = s.mkdir(d, None, "Trips")
        italy = s.mkdir(d, trips, "Italy 2024")
        await s.upload(d, italy, "Rome Beach.jpg", gen(b"x"))
        await s.upload(d, None, "beach.png", gen(b"x"))
        await s.upload(d, None, "notes.txt", gen(b"x"))
        s.mkdir(d, None, "Beach")

        results, total = s.search(d, "BEACH")
        self.assertEqual(total, 3)
        self.assertEqual([e.name for e, _ in results], ["Beach", "beach.png", "Rome Beach.jpg"])
        self.assertEqual(results[2][1], [(trips, "Trips"), (italy, "Italy 2024")])
        self.assertEqual([e.name for e, _ in s.search(d, "rome beach")[0]], ["Rome Beach.jpg"])
        self.assertEqual([e.name for e, _ in s.search(d, "italy")[0]], ["Italy 2024"])
        self.assertEqual(s.search(d, "   "), ([], 0))
        self.assertEqual(len(s.search(d, "a", limit=2)[0]), 2)

        other, _ = await s.create_drive(self.vault, "other", None)
        self.assertEqual(s.search(other, "beach"), ([], 0))


if __name__ == "__main__":
    unittest.main()
