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


if __name__ == "__main__":
    unittest.main()
