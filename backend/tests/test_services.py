import asyncio
import os
import tempfile
import unittest
from types import SimpleNamespace

from app import crypto, db
from app.backup import BackupScheduler
from app.httprange import RangeNotSatisfiable, parse_range
from app.sessions import LoginThrottle, Sessions
from app.storage import (Conflict, Gone, NoSnapshot, NotFound, Storage, StorageError, TransportUnavailable,
                         restore_database)
from app.transport.base import Wait, report_wait
from app.transport.local import LocalTransport
from app.uploadqueue import UploadQueue

crypto.KDF_PARAMS = {"alg": "argon2id", "t": 1, "m_kib": 64, "p": 1}  # fast, tests only
CHUNK = 1024


async def gen(data: bytes, block: int = 300):
    for i in range(0, len(data), block):
        yield data[i:i + block]


class CountingTransport(LocalTransport):
    gets = 0

    async def get(self, ref):
        self.gets += 1
        return await super().get(ref)


class FlakyTransport(CountingTransport):
    """Reports a retry before every put, and fails the puts listed in `fail_on` (by count, from 1)."""
    puts = 0
    fail_on: set[int] = set()
    seen: list = []
    state = None   # the upload to watch

    async def put(self, data):
        self.puts += 1
        report_wait(Wait("rate_limited", 5, 1, 6))
        if self.state is not None:
            self.seen.append((self.state.phase, self.state.wait))
        if self.puts in self.fail_on:
            raise RuntimeError("telegram is down")
        return await super().put(data)


class StorageApiSurfaceTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.blobs = os.path.join(self.tmp.name, "blobs")
        self.transport = CountingTransport(self.blobs)
        self.store = Storage(db.connect(os.path.join(self.tmp.name, "a.db")), self.transport, chunk_size=CHUNK)
        self.vault, _ = await self.store.setup_vault("master-pw")
        self.drive, _ = await self.store.create_drive(self.vault, "main", "hunter2")

    def tearDown(self):
        self.store.conn.close()
        self.tmp.cleanup()

    async def read(self, nid, start=0, end=None) -> bytes:
        return b"".join([c async for c in self.store.download(self.drive, nid, start, end)])

    async def test_ranges_match_slices(self):
        data = os.urandom(5 * CHUNK + 17)
        nid = await self.store.upload(self.drive, None, "f", gen(data))
        n = len(data)
        cases = [(0, n), (0, 1), (CHUNK - 1, CHUNK + 1), (CHUNK, 2 * CHUNK), (17, 4 * CHUNK + 3),
                 (n - 1, n), (n, n), (5 * CHUNK, n), (300, 300), (0, 0)]
        for start, end in cases:
            self.assertEqual(await self.read(nid, start, end), data[start:end], (start, end))
        for start, end in [(-1, 5), (5, 4), (0, n + 1)]:
            with self.assertRaises(StorageError):
                await self.read(nid, start, end)

    async def test_range_fetches_only_overlapping_chunks(self):
        nid = await self.store.upload(self.drive, None, "f", gen(os.urandom(6 * CHUNK)))
        self.transport.gets = 0
        await self.read(nid, 2 * CHUNK + 5, 3 * CHUNK + 5)
        self.assertEqual(self.transport.gets, 2)
        self.transport.gets = 0
        await self.read(nid, 4 * CHUNK, 5 * CHUNK)
        self.assertEqual(self.transport.gets, 1)

    async def test_rename_move_path(self):
        s, d = self.store, self.drive
        a = s.mkdir(d, None, "a")
        b = s.mkdir(d, a, "b")
        f = await s.upload(d, None, "f.txt", gen(b"hi"))

        s.rename(d, f, "g.txt")
        self.assertEqual(s.stat(d, f).name, "g.txt")
        s.move(d, f, b)
        self.assertEqual([e.name for e in s.path(d, f)], ["a", "b", "g.txt"])
        self.assertEqual(s.list(d, None)[0].name, "a")
        self.assertEqual(await self.read(f), b"hi")

        with self.assertRaises(StorageError):
            s.move(d, a, b)                       # into its own descendant
        with self.assertRaises(StorageError):
            s.move(d, a, a)                       # into itself
        with self.assertRaises(StorageError):
            s.move(d, a, f)                       # into a file
        s.mkdir(d, None, "b")
        with self.assertRaises(Conflict):
            s.move(d, b, None)                    # name taken at the destination
        with self.assertRaises(Conflict):
            s.rename(d, a, "b")
        for bad in ("", "x/y", "..", "n" * 256):
            with self.assertRaises(StorageError):
                s.rename(d, a, bad)
        with self.assertRaises(NotFound):
            s.list(d, "nope")
        with self.assertRaises(StorageError):
            s.list(d, f)
        s.move(d, f, None)
        self.assertEqual(s.path(d, f)[0].name, "g.txt")

    async def test_concurrent_uploads_cannot_share_a_name(self):
        gate = asyncio.Event()

        async def slow():
            yield b"x" * 10
            await gate.wait()

        first = asyncio.create_task(self.store.upload(self.drive, None, "same", slow()))
        await asyncio.sleep(0.01)
        with self.assertRaises(Conflict):
            await self.store.upload(self.drive, None, "same", gen(b"y"))
        gate.set()
        await first
        self.assertEqual(len(self.store.list(self.drive)), 1)

    async def test_cleanup_incomplete(self):
        async def stuck():
            yield os.urandom(3 * CHUNK)
            await asyncio.Event().wait()

        task = asyncio.create_task(self.store.upload(self.drive, None, "x", stuck()))
        await asyncio.sleep(0.05)
        self.assertEqual(len(os.listdir(self.blobs)), 2)   # final chunk still held back
        # Simulate a crash: the task never gets to clean up after itself.
        fresh = Storage(db.connect(os.path.join(self.tmp.name, "a.db")), LocalTransport(self.blobs), chunk_size=CHUNK)
        self.assertEqual(await fresh.cleanup_incomplete(), 1)
        self.assertEqual(os.listdir(self.blobs), [])
        fresh.conn.close()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    async def test_delete_drive(self):
        other, _ = await self.store.create_drive(self.vault, "other", "pw")
        d = self.store.mkdir(self.drive, None, "d")
        await self.store.upload(self.drive, d, "a", gen(os.urandom(2000)))
        keep = await self.store.upload(other, None, "keep", gen(b"keep"))
        await self.store.delete_drive(self.drive)
        self.assertEqual([d.name for d in self.store.list_drives()], ["other"])
        self.assertEqual(len(os.listdir(self.blobs)), 1)
        self.assertEqual(self.store.conn.execute("SELECT COUNT(*) FROM nodes").fetchone()[0], 1)
        self.assertEqual(b"".join([c async for c in self.store.download(other, keep)]), b"keep")
        with self.assertRaises(NotFound):
            await self.store.unlock(self.vault, "main", "hunter2")
        with self.assertRaises(Conflict):
            await self.store.create_drive(self.vault, "other", "pw")

    async def test_restore_without_snapshot_is_distinguishable(self):
        with self.assertRaises(NoSnapshot):
            await restore_database(self.transport, os.path.join(self.tmp.name, "new.db"))


class ResumableUploadTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.transport = FlakyTransport(os.path.join(self.tmp.name, "blobs"))
        self.transport.seen, self.transport.fail_on = [], set()
        self.store = Storage(db.connect(os.path.join(self.tmp.name, "a.db")), self.transport, chunk_size=CHUNK)
        vault, _ = await self.store.setup_vault("master-pw")
        self.drive, _ = await self.store.create_drive(vault, "main", None)

    def tearDown(self):
        self.store.conn.close()
        self.tmp.cleanup()

    async def read(self, nid) -> bytes:
        return b"".join([c async for c in self.store.download(self.drive, nid)])

    async def test_resume_after_a_cut(self):
        data = os.urandom(CHUNK * 3 + 100)
        nid = self.store.start_upload(self.drive, None, "f.bin", len(data))
        with self.assertRaises(Conflict):
            self.store.mkdir(self.drive, None, "f.bin")   # the name is taken while uploading
        # The connection drops partway through the third chunk: two are kept.
        self.assertFalse(await self.store.write_upload(self.drive, nid, 0, gen(data[:CHUNK * 2 + 500])))
        state = self.store.upload_state(self.drive, nid)
        self.assertEqual((state.stored, state.phase), (CHUNK * 2, "idle"))
        with self.assertRaises(Conflict):
            await self.store.write_upload(self.drive, nid, CHUNK * 3, gen(data[CHUNK * 3:]))
        # Resuming from behind what is stored skips what it already has.
        self.assertTrue(await self.store.write_upload(self.drive, nid, CHUNK, gen(data[CHUNK:])))
        self.assertEqual(self.transport.puts, 4)
        self.assertEqual(await self.read(nid), data)
        self.assertEqual(self.store.stat(self.drive, nid).size, len(data))
        with self.assertRaises(NotFound):
            self.store.upload_state(self.drive, nid)

    async def test_empty_and_oversized(self):
        nid = self.store.start_upload(self.drive, None, "empty", 0)
        self.assertTrue(await self.store.write_upload(self.drive, nid, 0, gen(b"")))
        self.assertEqual(await self.read(nid), b"")
        nid = self.store.start_upload(self.drive, None, "small", 10)
        with self.assertRaises(StorageError):
            await self.store.write_upload(self.drive, nid, 0, gen(b"x" * 11))

    async def test_reports_retries_and_keeps_what_was_stored(self):
        data = os.urandom(CHUNK * 2)
        nid = self.store.start_upload(self.drive, None, "f.bin", len(data))
        self.transport.state = self.store.upload_state(self.drive, nid)
        self.transport.fail_on = {2}
        with self.assertRaises(TransportUnavailable):
            await self.store.write_upload(self.drive, nid, 0, gen(data))
        phase, wait = self.transport.seen[0]
        self.assertEqual((phase, wait.reason, wait.seconds), ("waiting", "rate_limited", 5))
        state = self.store.upload_state(self.drive, nid)
        self.assertEqual((state.stored, state.phase, state.wait), (CHUNK, "idle", None))
        self.assertTrue(await self.store.write_upload(self.drive, nid, CHUNK, gen(data[CHUNK:])))
        self.assertEqual(await self.read(nid), data)

    async def test_cancel_and_expire(self):
        nid = self.store.start_upload(self.drive, None, "a", CHUNK * 2)
        await self.store.write_upload(self.drive, nid, 0, gen(os.urandom(CHUNK)))
        await self.store.cancel_upload(self.drive, nid)
        with self.assertRaises(NotFound):
            self.store.upload_state(self.drive, nid)
        self.assertEqual(os.listdir(self.transport.root), [])
        self.assertIsNone(self.store.find(self.drive, None, "a"))

        nid = self.store.start_upload(self.drive, None, "b", 5)
        self.assertEqual(await self.store.expire_uploads(3600), 0)
        self.assertEqual(await self.store.expire_uploads(0), 1)
        with self.assertRaises(NotFound):
            self.store.upload_state(self.drive, nid)

    async def test_write_waiting_on_a_cancelled_upload_stops(self):
        nid = self.store.start_upload(self.drive, None, "a", CHUNK * 2)
        state = self.store.upload_state(self.drive, nid)
        async with state.lock:
            writer = asyncio.create_task(self.store.write_upload(self.drive, nid, 0, gen(os.urandom(CHUNK * 2))))
            await asyncio.sleep(0)
            state.gone = True
        with self.assertRaises(Gone):
            await writer


class SessionsTest(unittest.TestCase):
    def test_idle_expiry_and_touch(self):
        now = [0.0]
        s = Sessions(idle_seconds=100, clock=lambda: now[0])
        token, session = s.create()
        session.drives["a"] = object()
        now[0] = 90
        self.assertIs(s.get(token), session)       # touch
        now[0] = 180
        self.assertIs(s.get(token), session)
        now[0] = 281
        self.assertIsNone(s.get(token))
        self.assertIsNone(s.get(None))
        self.assertIsNone(s.get("bogus"))

    def test_every_device_shares_one_session(self):
        now = [0.0]
        s = Sessions(idle_seconds=100, clock=lambda: now[0])
        t1, a = s.create()
        t2, b = s.create()
        self.assertNotEqual(t1, t2)
        self.assertIs(a, b)
        a.drives["x"] = SimpleNamespace(name="x")
        s.rename_drive("x", "y")
        self.assertEqual((list(b.drives), b.drives["y"].name), (["y"], "y"))
        s.forget_drive("y")
        self.assertEqual(b.drives, {})
        now[0] = 50
        self.assertIs(s.get(t1), a)        # either device keeps it alive
        now[0] = 140
        self.assertIs(s.get(t2), a)
        s.end()
        self.assertIsNone(s.get(t1))
        self.assertIsNone(s.get(t2))
        t3, c = s.create()
        self.assertIsNot(c, a)
        self.assertIsNone(s.get(t1))       # old tokens don't come back

    def test_throttle(self):
        now = [0.0]
        t = LoginThrottle(clock=lambda: now[0])
        k = ("main", "1.2.3.4")
        for _ in range(5):
            self.assertEqual(t.retry_after(k), 0)
            t.failed(k)
        self.assertEqual(t.retry_after(k), 1)
        self.assertEqual(t.retry_after(("main", "other-ip")), 0)
        now[0] = 1
        self.assertEqual(t.retry_after(k), 0)
        t.failed(k)
        self.assertEqual(t.retry_after(k), 2)
        for _ in range(20):
            t.failed(k)
        self.assertEqual(t.retry_after(k), 60)
        t.succeeded(k)
        self.assertEqual(t.retry_after(k), 0)


class RangeTest(unittest.TestCase):
    def test_parse(self):
        self.assertIsNone(parse_range(None, 100))
        self.assertIsNone(parse_range("items=0-5", 100))
        self.assertIsNone(parse_range("bytes=0-5,10-20", 100))
        self.assertIsNone(parse_range("bytes=abc", 100))
        self.assertIsNone(parse_range("bytes=-", 100))
        self.assertIsNone(parse_range("bytes=9-3", 100))
        self.assertEqual(parse_range("bytes=0-", 100), (0, 100))
        self.assertEqual(parse_range("bytes=0-0", 100), (0, 1))
        self.assertEqual(parse_range("bytes=10-19", 100), (10, 20))
        self.assertEqual(parse_range("bytes=90-500", 100), (90, 100))
        self.assertEqual(parse_range("bytes=-10", 100), (90, 100))
        self.assertEqual(parse_range("bytes=-500", 100), (0, 100))
        for bad in ("bytes=100-", "bytes=250-300", "bytes=-0"):
            with self.assertRaises(RangeNotSatisfiable):
                parse_range(bad, 100)
        with self.assertRaises(RangeNotSatisfiable):
            parse_range("bytes=0-", 0)


class BackupSchedulerTest(unittest.IsolatedAsyncioTestCase):
    async def test_debounce_coalesces(self):
        calls = []

        async def backup():
            calls.append(1)

        b = BackupScheduler(backup, debounce=0.05)
        b.start()
        await asyncio.sleep(0.1)
        self.assertEqual(calls, [])                 # nothing changed, nothing uploaded
        for _ in range(10):
            b.mark_dirty()
        await asyncio.sleep(0.15)
        self.assertEqual(len(calls), 1)
        await b.stop()
        self.assertEqual(len(calls), 1)

    async def test_stop_flushes_pending_change(self):
        calls = []

        async def backup():
            calls.append(1)

        b = BackupScheduler(backup, debounce=60)
        b.start()
        b.mark_dirty()
        await asyncio.sleep(0.01)
        await b.stop()
        self.assertEqual(len(calls), 1)

    async def test_failure_is_retried(self):
        calls = []

        async def backup():
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("telegram down")

        b = BackupScheduler(backup, debounce=0.01, retry=0.02)
        b.start()
        b.mark_dirty()
        await asyncio.sleep(0.2)
        self.assertEqual(len(calls), 2)
        await b.stop()
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()


class UploadQueueTest(unittest.TestCase):
    def item(self, id, status="queued", **more):
        return {"id": id, "status": status, "name": f"f{id}", "size": 1, **more}

    def test_order_delta_and_timeout(self):
        now = [0.0]
        q = UploadQueue(idle_seconds=60, clock=lambda: now[0])
        r = q.sync("a", [self.item(1, "uploading"), self.item(2)], [], [], None, 0)
        self.assertTrue(r["resend"])
        epoch = r["epoch"]
        r = q.sync("b", [self.item(1)], [], [], epoch, 0)
        self.assertEqual(r["order"], ["a:1", "a:2", "b:1"])
        since = r["rev"]

        # a's first finishes; a retries it later: it goes to the back.
        r = q.sync("a", [self.item(1, "error")], [], [], epoch, since)
        self.assertEqual(([i["key"] for i in r["items"]], r["order"]), (["a:1"], None))
        r = q.sync("a", [self.item(1)], [], [], epoch, r["rev"])
        self.assertEqual(r["order"], ["a:2", "b:1", "a:1"])
        self.assertFalse(r["resend"])

        # b cancels a:2; a sees it. Finished items can't be cancelled.
        r = q.sync("b", [], [], ["a:2", "nope"], epoch, r["rev"])
        r = q.sync("a", [], [], [], epoch, r["rev"] - 1)
        self.assertEqual([(i["key"], i["cancel"]) for i in r["items"]], [("a:2", True)])

        # a goes quiet: its items leave the line.
        now[0] = 30
        q.sync("b", [], [], [], epoch, 0)
        now[0] = 70
        r = q.sync("b", [], [], [], epoch, 0)
        self.assertEqual(r["order"], ["b:1"])

        # a comes back mid-upload: it is asked to resend, and keeps its turn.
        r = q.sync("a", [], [], [], epoch, 0)
        self.assertTrue(r["resend"])
        r = q.sync("a", [self.item(2, "uploading")], [], [], epoch, 0)
        self.assertEqual(r["order"], ["a:2", "b:1"])
        r = q.sync("a", [], [2], [], epoch, 0)
        self.assertEqual(r["order"], ["b:1"])

    def test_restart_asks_for_everything(self):
        q = UploadQueue()
        r = q.sync("a", [self.item(1)], [], [], "old-epoch", 99)
        self.assertTrue(r["resend"])
        self.assertEqual([i["key"] for i in r["items"]], ["a:1"])
