import asyncio
import os
import tempfile
from pathlib import Path
import unittest

from app import crypto, db
from app.storage import Storage, StorageError, restore_database
from app.transport.local import LocalTransport

crypto.KDF_PARAMS = {"alg": "argon2id", "t": 1, "m_kib": 64, "p": 1}  # fast, tests only
CHUNK = 1024


async def gen(data: bytes, block: int = 300):
    for i in range(0, len(data), block):
        yield data[i:i + block]


async def read(store, drive, node_id) -> bytes:
    return b"".join([c async for c in store.download(drive, node_id)])


class CoreTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.blobs = os.path.join(self.tmp.name, "blobs")
        self.transport = LocalTransport(self.blobs)
        self.store = Storage(db.connect(os.path.join(self.tmp.name, "a.db")), self.transport, chunk_size=CHUNK)
        self.vault, self.vault_recovery = await self.store.setup_vault("master-pw")
        self.drive, self.recovery = await self.store.create_drive(self.vault, "main", "hunter2")

    def tearDown(self):
        self.store.conn.close()
        self.tmp.cleanup()

    def blob_files(self):
        return sorted(f for f in os.listdir(self.blobs) if f.endswith(".bin"))

    async def test_roundtrip_sizes(self):
        for n in (0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK, 5 * CHUNK + 17):
            data = os.urandom(n)
            nid = await self.store.upload(self.drive, None, f"f{n}", gen(data))
            self.assertEqual(await read(self.store, self.drive, nid), data)
            chunks = self.store.conn.execute("SELECT COUNT(*) FROM chunks WHERE node_id = ?", (nid,)).fetchone()[0]
            self.assertEqual(chunks, max(1, -(-n // CHUNK)))

    async def test_nothing_readable_at_rest(self):
        secret = b"TOP-SECRET-MARKER" * 200
        await self.store.upload(self.drive, None, "passwords.txt", gen(secret))
        self.store.conn.commit()
        for f in self.blob_files():
            raw = Path(self.blobs, f).read_bytes()
            self.assertNotIn(b"TOP-SECRET-MARKER", raw)
        dump = "\n".join(self.store.conn.iterdump()).encode()
        self.assertNotIn(b"passwords.txt", dump)
        self.assertNotIn(self.drive.keys.master_key.hex().encode(), dump)

    async def test_wrong_password(self):
        with self.assertRaises(crypto.BadKey):
            await self.store.unlock(self.vault, "main", "hunter3")
        await self.store.unlock(self.vault, "main", "hunter2")

    async def test_recovery_key_resets_password(self):
        data = os.urandom(2500)
        nid = await self.store.upload(self.drive, None, "x", gen(data))
        with self.assertRaises(crypto.BadKey):
            self.store.unlock_with_recovery("main", "AAAA-" + self.recovery[5:])
        d = self.store.unlock_with_recovery("main", self.recovery.lower().replace("-", " "))
        await self.store.set_password(self.vault, d, "new-pass")
        with self.assertRaises(crypto.BadKey):
            await self.store.unlock(self.vault, "main", "hunter2")
        self.assertEqual(await read(self.store, await self.store.unlock(self.vault, "main", "new-pass"), nid), data)

    async def test_drives_are_isolated(self):
        other, _ = await self.store.create_drive(self.vault, "other", "pw2")
        nid = await self.store.upload(self.drive, None, "x", gen(b"hello"))
        self.assertEqual(self.store.list(other), [])
        with self.assertRaises(StorageError):
            await read(self.store, other, nid)

    async def test_tamper_swap_truncate_detected(self):
        nid = await self.store.upload(self.drive, None, "x", gen(os.urandom(3 * CHUNK)))
        a, b, c = [Path(self.blobs, f) for f in self.blob_files()]
        orig = [p.read_bytes() for p in (a, b, c)]

        a.write_bytes(orig[0][:-1] + bytes([orig[0][-1] ^ 1]))             # bit flip
        with self.assertRaises(crypto.BadKey):
            await read(self.store, self.drive, nid)

        a.write_bytes(orig[1]); b.write_bytes(orig[0])                     # swap
        with self.assertRaises(crypto.BadKey):
            await read(self.store, self.drive, nid)
        a.write_bytes(orig[0]); b.write_bytes(orig[1])

        with self.store.conn:                                             # truncate
            self.store.conn.execute("DELETE FROM chunks WHERE node_id = ? AND idx = 2", (nid,))
        with self.assertRaises(StorageError):
            await read(self.store, self.drive, nid)

    async def test_chunk_cache(self):
        self.store.blob_cache_bytes = 2 * (CHUNK + crypto.CHUNK_OVERHEAD)
        gets = []
        real_get = self.transport.get

        async def counting_get(ref):
            gets.append(ref.message_id)
            await asyncio.sleep(0.01)
            return await real_get(ref)

        self.transport.get = counting_get
        data = os.urandom(3 * CHUNK)
        nid = await self.store.upload(self.drive, None, "comic.cbz", gen(data))

        async def part(start, end):
            return b"".join([c async for c in self.store.download(self.drive, nid, start, end)])

        # Many small reads of one chunk, some at once, fetch it once.
        results = await asyncio.gather(*(part(i * 100, i * 100 + 50) for i in range(5)))
        self.assertEqual(results, [data[i * 100:i * 100 + 50] for i in range(5)])
        self.assertEqual(await part(900, 1000), data[900:1000])
        self.assertEqual(len(gets), 1)

        # Only two chunks fit: reading all three evicts the oldest.
        self.assertEqual(await read(self.store, self.drive, nid), data)
        self.assertEqual(len(gets), 3)
        await part(0, 10)
        self.assertEqual(len(gets), 4)

        await self.store.delete(self.drive, nid)
        self.assertEqual((len(self.store._blobs), self.store._blob_total), (0, 0))

    async def test_folders_and_delete(self):
        d = self.store.mkdir(self.drive, None, "docs")
        sub = self.store.mkdir(self.drive, d, "deep")
        await self.store.upload(self.drive, d, "a", gen(os.urandom(2000)))
        await self.store.upload(self.drive, sub, "b", gen(os.urandom(2000)))
        with self.assertRaises(StorageError):
            await self.store.upload(self.drive, d, "a", gen(b"dup"))
        self.assertEqual([e.name for e in self.store.list(self.drive, d)], ["deep", "a"])
        self.assertEqual(len(self.blob_files()), 4)
        await self.store.delete(self.drive, d)
        self.assertEqual(self.blob_files(), [])
        self.assertEqual(self.store.list(self.drive), [])

    async def test_failed_upload_leaves_nothing(self):
        async def broken():
            yield os.urandom(2 * CHUNK)
            raise RuntimeError("connection dropped")
        with self.assertRaises(RuntimeError):
            await self.store.upload(self.drive, None, "x", broken())
        self.assertEqual(self.blob_files(), [])
        self.assertEqual(self.store.conn.execute("SELECT COUNT(*) FROM nodes").fetchone()[0], 0)

    async def test_backup_and_restore_from_transport_only(self):
        for passphrase in (None, "backup-pass"):
            name = f"file-{passphrase}"
            data = os.urandom(2500)
            self.store.backup_passphrase = passphrase
            await self.store.upload(self.drive, None, name, gen(data))
            await self.store.backup()

            new_db = os.path.join(self.tmp.name, f"restored-{passphrase}.db")
            if passphrase:
                with self.assertRaises(crypto.BadKey):
                    await restore_database(self.transport, new_db, "wrong")
            await restore_database(self.transport, new_db, passphrase)
            fresh = Storage(db.connect(new_db), LocalTransport(self.blobs), chunk_size=CHUNK)
            drive = await fresh.unlock(await fresh.unlock_vault("master-pw"), "main", "hunter2")
            self.assertEqual(await read(fresh, drive, fresh.find(drive, None, name).id), data)
            fresh.conn.close()


class PackTest(unittest.IsolatedAsyncioTestCase):
    """Small files share messages (CHUNK is 1 KiB here, so a pack holds about that much)."""

    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.blobs = os.path.join(self.tmp.name, "blobs")
        self.pending = os.path.join(self.tmp.name, "pending")
        self.db_path = os.path.join(self.tmp.name, "a.db")
        self.transport = LocalTransport(self.blobs)
        self.store = self.make_store(db.connect(self.db_path))
        self.vault, _ = await self.store.setup_vault("master-pw")
        self.drive, _ = await self.store.create_drive(self.vault, "main", None)

    def make_store(self, conn, **kw):
        kw = {"pack_dir": self.pending, "pack_max_file": 300, "pack_wait": 60, **kw}
        return Storage(conn, self.transport, chunk_size=CHUNK, **kw)

    async def asyncTearDown(self):
        await self.store.stop_packing()
        self.store.conn.close()
        self.tmp.cleanup()

    def messages(self):
        return sorted(f for f in os.listdir(self.blobs) if f.endswith(".bin"))

    def waiting(self):
        return sorted(os.listdir(self.pending))

    async def put(self, name, data):
        return await self.store.upload(self.drive, None, name, gen(data))

    async def test_small_files_share_a_message(self):
        files = {f"f{i}": os.urandom(n) for i, n in enumerate((0, 1, 200, 300))}
        ids = {name: await self.put(name, data) for name, data in files.items()}
        big = os.urandom(301)
        big_id = await self.put("big", big)
        # Only the file over the limit went out; the rest are on disk and readable.
        self.assertEqual(len(self.messages()), 1)
        self.assertEqual(len(self.waiting()), 4)
        for name, data in files.items():
            self.assertEqual(await read(self.store, self.drive, ids[name]), data)
        part = b"".join([c async for c in self.store.download(self.drive, ids["f2"], 10, 20)])
        self.assertEqual(part, files["f2"][10:20])

        await self.store.flush_packs()
        self.assertEqual((len(self.messages()), self.waiting()), (2, []))
        for name, data in files.items():
            self.assertEqual(await read(self.store, self.drive, ids[name]), data)
        self.assertEqual(await read(self.store, self.drive, big_id), big)

    async def test_full_pack_goes_out_and_timer_sends_the_rest(self):
        self.store.pack_wait = 0.05
        for i in range(4):   # 300 bytes each: three fill a pack
            await self.put(f"f{i}", os.urandom(300))
        self.assertEqual((len(self.messages()), len(self.waiting())), (1, 1))
        await asyncio.sleep(0.2)
        self.assertEqual((len(self.messages()), self.waiting()), (2, []))

    async def test_pack_is_deleted_with_its_last_file(self):
        a = await self.put("a", os.urandom(100))
        b = await self.put("b", os.urandom(100))
        await self.store.flush_packs()
        self.assertEqual(len(self.messages()), 1)
        await self.store.delete(self.drive, a)
        self.assertEqual(len(self.messages()), 1)
        self.assertEqual(len(await read(self.store, self.drive, b)), 100)
        await self.store.delete(self.drive, b)
        self.assertEqual(self.messages(), [])

    async def test_deleted_while_waiting_is_never_sent(self):
        a = await self.put("a", os.urandom(100))
        await self.store.delete(self.drive, a)
        self.assertEqual(self.waiting(), [])
        await self.store.flush_packs()
        self.assertEqual(self.messages(), [])

    async def test_waiting_files_survive_a_restart(self):
        data = os.urandom(100)
        nid = await self.put("a", data)
        self.store.conn.close()   # a crash: nothing sent
        self.store = self.make_store(db.connect(self.db_path), pack_max_file=0)   # and packing turned off
        self.assertEqual(await self.store.cleanup_incomplete(), 0)
        self.assertEqual(await self.store.resume_packs(), 1)
        await self.store.flush_packs()
        self.assertEqual((len(self.messages()), self.waiting()), (1, []))
        self.assertEqual(await read(self.store, self.drive, nid), data)

    async def test_snapshot_leaves_out_unsent_files(self):
        sent = await self.put("sent", os.urandom(100))
        await self.store.flush_packs()
        await self.put("unsent", os.urandom(100))
        restored = os.path.join(self.tmp.name, "restored.db")
        db.restore(restored, db.snapshot(self.store.conn))
        fresh = self.make_store(db.connect(restored), pack_dir=None)
        self.assertEqual(await fresh.cleanup_incomplete(), 1)
        drive = fresh.open_drive(await fresh.unlock_vault("master-pw"), "main")
        self.assertEqual([e.id for e in fresh.list(drive)], [sent])
        fresh.conn.close()

    async def test_backup_sends_waiting_files_first(self):
        await self.put("a", os.urandom(100))
        await self.store.backup()
        self.assertEqual((len(self.messages()), self.waiting()), (1, []))

    async def test_turned_off(self):
        store = self.make_store(self.store.conn, pack_max_file=0)
        await store.upload(self.drive, None, "a", gen(os.urandom(100)))
        await store.upload(self.drive, None, "b", gen(os.urandom(0)))
        self.assertEqual((len(self.messages()), self.waiting()), (2, []))


if __name__ == "__main__":
    unittest.main()
