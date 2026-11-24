import asyncio
import json
import os
import sqlite3
import tempfile
import unittest
from io import BytesIO
from pathlib import Path

from PIL import Image

from app import crypto, db, thumbs
from app.storage import Conflict, NotFound, NoVault, Storage, StorageError
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

    async def test_rename_many_is_all_or_nothing_and_allows_swaps(self):
        s, d = self.store, self.drive
        names = lambda parent=None: sorted(e.name for e in s.list(d, parent))
        a = await s.upload(d, None, "a", gen(b"a"))
        b = await s.upload(d, None, "b", gen(b"b"))
        c = await s.upload(d, None, "c", gen(b"c"))
        folder = s.mkdir(d, None, "f")
        inner = await s.upload(d, folder, "a", gen(b"inner"))
        s.rename_many(d, [(a, "b"), (b, "c"), (c, "a")])                    # a cycle
        self.assertEqual([s.stat(d, n).name for n in (a, b, c)], ["b", "c", "a"])
        s.rename_many(d, [(a, "x"), (inner, "x")])                          # same name, different folders
        self.assertEqual((names(), names(folder)), (["a", "c", "f", "x"], ["x"]))
        with self.assertRaises(Conflict):
            s.rename_many(d, [(a, "y"), (b, "f")])                          # clashes with one left alone
        with self.assertRaises(Conflict):
            s.rename_many(d, [(a, "y"), (b, "y")])                          # clash with each other
        with self.assertRaises(StorageError):
            s.rename_many(d, [(a, "y"), (b, "no/slash")])
        self.assertEqual(names(), ["a", "c", "f", "x"])                     # nothing changed
        s.rename_many(d, [(a, "x"), (b, "c")])                              # unchanged names are fine
        self.assertEqual(names(), ["a", "c", "f", "x"])

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

    def test_describe_reads_size_and_exif(self):
        im = Image.new("RGB", (400, 300))
        exif = Image.Exif()
        exif[0x0112] = 6                                  # rotated a quarter turn
        exif[0x010F], exif[0x0110] = "Canon", "Canon EOS R5"
        exif.get_ifd(0x8769)[0x9003] = "2024:05:01 12:30:00"
        buf = BytesIO()
        im.save(buf, "JPEG", exif=exif)
        self.assertEqual(thumbs.describe(buf.getvalue()), {
            "width": 300, "height": 400, "taken": "2024-05-01 12:30:00", "camera": "Canon EOS R5"})
        self.assertEqual(thumbs.describe(b"<svg/>"), {})

    async def test_details_are_merged_encrypted_and_filled_by_thumbnailing(self):
        s, d = self.store, self.drive
        nid = await s.upload(d, None, "photo.png", gen(image_bytes()))
        self.assertEqual(s.info(d, nid), {})
        self.assertEqual(s.set_info(d, nid, {"modified": 1700000000}), {"modified": 1700000000})
        self.assertNotIn(b"modified", s.conn.execute("SELECT info_enc FROM nodes WHERE id = ?", (nid,)).fetchone()[0])
        await s.thumbnail(d, nid)
        self.assertEqual(s.info(d, nid), {"modified": 1700000000, "width": 1200, "height": 800})

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
        await s.flush_thumbnails()                   # only those in Telegram can be evicted
        one = Path(self.thumb_dir, f"{ids[0]}.thumb").stat().st_size
        await s.thumbnail(d, ids[0])                 # shown again: now the most recent
        s.thumb_cache_bytes = int(one * 4.5)         # room for four, so a fifth evicts
        extra = await s.upload(d, None, "p4.png", gen(image_bytes()))
        await s.thumbnail(d, extra)
        kept = sorted(n.split(".")[0] for n in os.listdir(self.thumb_dir))
        self.assertEqual(kept, sorted([ids[0], ids[2], ids[3], extra]))   # p1 went; p0 was shown again
        self.assertEqual(s._thumb_total, sum(p.stat().st_size for p in Path(self.thumb_dir).iterdir()))
        self.assertTrue(await s.thumbnail(d, ids[1]))                # an evicted image comes back

    async def test_kept_in_telegram_in_packs_of_their_own(self):
        s, d = self.store, self.drive
        ids = [await s.upload(d, None, f"clip{i}.mp4", gen(os.urandom(100))) for i in range(3)]
        files = self.blob_count()
        for nid in ids:
            await s.set_thumbnail(d, nid, image_bytes("PNG", (640, 360)))
        shown = {nid: await s.thumbnail(d, nid) for nid in ids}
        self.assertEqual(self.blob_count(), files)   # waiting, not sent one by one
        await s.flush_thumbnails()
        self.assertEqual(self.blob_count(), files + 1)
        rows = s.conn.execute("SELECT DISTINCT message_id FROM thumbs").fetchall()
        self.assertEqual(len(rows), 1)

        # The cache is lost: the first miss fetches the pack and refills it all.
        for name in os.listdir(self.thumb_dir):
            s._unlink_thumb(os.path.join(self.thumb_dir, name))
        self.assertTrue(s.stat(d, ids[0]).thumb)
        gets = []
        original = s.transport.get

        async def counting(ref):
            gets.append(ref)
            return await original(ref)

        s.transport.get = counting
        self.assertEqual(await asyncio.gather(*(s.thumbnail(d, nid) for nid in ids)), list(shown.values()))
        self.assertEqual(len(gets), 1)
        self.assertEqual(sorted(os.listdir(self.thumb_dir)), sorted(f"{n}.thumb" for n in ids))

        # The pack goes with the last file whose thumbnail is in it.
        await s.delete(d, ids[0])
        await s.delete(d, ids[1])
        self.assertEqual(self.blob_count(), files - 2 + 1)
        await s.delete(d, ids[2])
        self.assertEqual(self.blob_count(), files - 3)

    async def test_replaced_and_removed(self):
        s, d = self.store, self.drive
        nid = await s.upload(d, None, "clip.mp4", gen(os.urandom(100)))
        files = self.blob_count()
        await s.set_thumbnail(d, nid, image_bytes("PNG", (640, 360)))
        await s.flush_thumbnails()
        first = await s.thumbnail(d, nid)
        await s.set_thumbnail(d, nid, image_bytes("PNG", (360, 640)))   # regenerated
        self.assertEqual(self.blob_count(), files)                     # the old pack is gone
        self.assertIsNone(s.conn.execute("SELECT 1 FROM thumbs").fetchone())
        await s.flush_thumbnails()
        second = await s.thumbnail(d, nid)
        self.assertNotEqual(first, second)
        os.remove(Path(self.thumb_dir, f"{nid}.thumb"))
        self.assertEqual(await s.thumbnail(d, nid), second)            # from Telegram

        await s.remove_thumbnail(d, nid)
        self.assertEqual((self.blob_count(), os.listdir(self.thumb_dir)), (files, []))
        self.assertFalse(s.stat(d, nid).thumb)
        self.assertIsNone(await s.thumbnail(d, nid))

    async def test_unsent_thumbnails_are_sent_after_a_restart(self):
        s, d = self.store, self.drive
        nid = await s.upload(d, None, "clip.mp4", gen(os.urandom(100)))
        await s.set_thumbnail(d, nid, image_bytes("PNG", (640, 360)))
        s.conn.close()   # a crash before the pack went out
        self.store = s = Storage(db.connect(self.db_path), LocalTransport(self.blobs),
                                 chunk_size=CHUNK, thumb_dir=self.thumb_dir)
        self.assertEqual(s.sweep_thumbnails(), 0)
        self.assertEqual(s.resume_thumbnails(), 1)
        await s.flush_thumbnails()
        self.assertIsNotNone(s.conn.execute("SELECT 1 FROM thumbs WHERE node_id = ?", (nid,)).fetchone())
        self.assertEqual(s.resume_thumbnails(), 0)

    async def test_unsent_ones_are_not_evicted(self):
        s, d = self.store, self.drive
        ids = [await s.upload(d, None, f"c{i}.mp4", gen(os.urandom(100))) for i in range(3)]
        s.thumb_cache_bytes = 1
        for nid in ids:
            await s.set_thumbnail(d, nid, image_bytes("PNG", (640, 360)))
        self.assertEqual(len(os.listdir(self.thumb_dir)), 3)
        await s.flush_thumbnails()
        s._trim_thumbnails()
        self.assertEqual(os.listdir(self.thumb_dir), [])
        self.assertTrue(await s.thumbnail(d, ids[0]))


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

    async def test_search_one_folder(self):
        s, d = self.store, self.drive
        trips = s.mkdir(d, None, "Beach trips")
        italy = s.mkdir(d, trips, "Italy")
        empty = s.mkdir(d, None, "Empty")
        deep = await s.upload(d, italy, "Rome beach.jpg", gen(b"x"))
        await s.upload(d, trips, "beach.png", gen(b"x"))
        outside = await s.upload(d, None, "beach.jpg", gen(b"x"))

        # Everything below it at any depth, but not the folder itself.
        results, total = s.search(d, "beach", parent_id=trips)
        self.assertEqual(([e.name for e, _ in results], total), (["beach.png", "Rome beach.jpg"], 2))
        # Paths still start at the top of the drive.
        self.assertEqual(results[1][1], [(trips, "Beach trips"), (italy, "Italy")])
        self.assertEqual([(e.id, p) for e, p in s.search(d, "beach", parent_id=italy)[0]],
                         [(deep, [(trips, "Beach trips"), (italy, "Italy")])])
        self.assertEqual(s.search(d, "beach", parent_id=empty), ([], 0))
        self.assertEqual(s.search(d, "beach")[1], 4)

        with self.assertRaises(StorageError):
            s.search(d, "beach", parent_id=outside)
        other, _ = await s.create_drive(self.vault, "other", None)
        with self.assertRaises(NotFound):
            s.search(other, "beach", parent_id=trips)


if __name__ == "__main__":
    unittest.main()
