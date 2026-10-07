"""WebDAV at /dav/<drive>/, end to end through FastAPI's TestClient."""
import os
import tempfile
import unittest
import xml.etree.ElementTree as ET

try:
    from fastapi.testclient import TestClient
except ImportError:
    raise unittest.SkipTest("fastapi is not installed")

from app import crypto
from app.config import Config
from app.server import create_app

crypto.KDF_PARAMS = {"alg": "argon2id", "t": 1, "m_kib": 64, "p": 1}  # fast, tests only

DAV = "/dav/main"


def names(response) -> list[str]:
    tree = ET.fromstring(response.content)
    return [e.text for e in tree.iter("{DAV:}displayname")]


class WebDavTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        cfg = Config(
            db_path=os.path.join(self.tmp.name, "db", "t.db"), transport="local",
            bot_token=None, chat_id=None, local_dir=os.path.join(self.tmp.name, "blobs"),
            backup_passphrase=None, chunk_size=1024, backup_debounce=0.05,
        )
        self._client = TestClient(create_app(cfg))
        self.c = self._client.__enter__()
        self.c.post("/api/vault/setup", json={"password": "master-pw"})
        self.c.post("/api/drives", json={"name": "main", "password": "password1"})

    def tearDown(self):
        self._client.__exit__(None, None, None)
        self.tmp.cleanup()

    def enable(self, read_only=False) -> tuple[str, str]:
        r = self.c.post("/api/drives/main/webdav", json={"password": "password1", "read_only": read_only})
        self.assertEqual(r.status_code, 200, r.text)
        return ("anyone", r.json()["password"])

    def dav(self, method, path="/", auth=None, **kw):
        return self.c.request(method, DAV + path, auth=auth, **kw)

    def test_turning_it_on_and_off(self):
        c = self.c
        self.assertEqual(c.get("/api/drives/main/webdav").json(),
                         {"enabled": False, "read_only": False, "created_at": None, "path": "/dav/main/"})
        r = c.post("/api/drives/main/webdav", json={"password": "wrong-password"})
        self.assertEqual(r.status_code, 401)
        old = self.enable()
        self.assertTrue(c.get("/api/drives").json()[0]["webdav"])
        self.assertEqual(self.dav("PROPFIND", auth=old, headers={"Depth": "0"}).status_code, 207)

        new = self.enable()   # a new password replaces the old one
        self.assertEqual(self.dav("PROPFIND", auth=old).status_code, 401)
        self.assertEqual(self.dav("PROPFIND", auth=new).status_code, 207)

        self.assertEqual(c.delete("/api/drives/main/webdav").status_code, 204)
        self.assertEqual(self.dav("PROPFIND", auth=new).status_code, 401)
        self.assertFalse(c.get("/api/drives").json()[0]["webdav"])

    def test_sign_in(self):
        auth = self.enable()
        r = self.dav("PROPFIND")
        self.assertEqual(r.status_code, 401)
        self.assertIn("Basic", r.headers["www-authenticate"])
        self.assertEqual(self.dav("PROPFIND", auth=("x", "AAAA-BBBB")).status_code, 401)
        self.assertEqual(self.c.request("PROPFIND", "/dav/nope/", auth=auth).status_code, 401)
        self.assertIn("2", self.dav("OPTIONS").headers["dav"])   # no password needed to probe
        # Works with the web UI locked: the password opens the drive by itself.
        self.c.post("/api/logout")
        self.assertEqual(self.dav("PROPFIND", auth=auth).status_code, 207)

    def test_files_and_folders(self):
        auth = self.enable()
        self.assertEqual(self.dav("MKCOL", "/docs", auth).status_code, 201)
        self.assertEqual(self.dav("MKCOL", "/docs", auth).status_code, 405)
        self.assertEqual(self.dav("MKCOL", "/no/such", auth).status_code, 409)

        data = os.urandom(3000)
        self.assertEqual(self.dav("PUT", "/docs/a.bin", auth, content=data).status_code, 201)
        self.assertEqual(self.dav("GET", "/docs/a.bin", auth).content, data)
        r = self.dav("GET", "/docs/a.bin", auth, headers={"Range": "bytes=1000-1999"})
        self.assertEqual((r.status_code, r.content), (206, data[1000:2000]))
        self.assertIn("attachment", r.headers["content-disposition"])
        self.assertEqual(self.dav("HEAD", "/docs/a.bin", auth).headers["content-length"], "3000")

        # Overwriting keeps one file of that name.
        self.assertEqual(self.dav("PUT", "/docs/a.bin", auth, content=b"new").status_code, 204)
        self.assertEqual(self.dav("GET", "/docs/a.bin", auth).content, b"new")
        r = self.dav("PROPFIND", "/docs/", auth, headers={"Depth": "1"})
        self.assertEqual(names(r), ["docs", "a.bin"])

        self.assertEqual(self.dav("COPY", "/docs/a.bin", auth,
                                  headers={"Destination": "http://testserver/dav/main/b.bin"}).status_code, 201)
        self.assertEqual(self.dav("MOVE", "/b.bin", auth,
                                  headers={"Destination": "/dav/main/docs/c%20d.bin"}).status_code, 201)
        self.assertEqual(self.dav("GET", "/docs/c d.bin", auth).content, b"new")
        r = self.dav("MOVE", "/docs/c d.bin", auth, headers={"Destination": "/dav/main/docs/a.bin", "Overwrite": "F"})
        self.assertEqual(r.status_code, 412)
        r = self.dav("MOVE", "/docs/c d.bin", auth, headers={"Destination": "/dav/main/docs/a.bin"})
        self.assertEqual(r.status_code, 204)
        self.assertEqual(names(self.dav("PROPFIND", "/docs", auth, headers={"Depth": "1"})), ["docs", "a.bin"])

        self.assertEqual(self.dav("COPY", "/docs", auth, headers={"Destination": "/dav/main/copy"}).status_code, 201)
        self.assertEqual(self.dav("GET", "/copy/a.bin", auth).content, b"new")
        self.assertEqual(self.dav("MOVE", "/docs", auth, headers={"Destination": "/dav/main/docs/in"}).status_code, 403)
        self.assertEqual(self.dav("MOVE", "/docs", auth, headers={"Destination": "/dav/other/x"}).status_code, 502)

        self.assertEqual(self.dav("DELETE", "/docs", auth).status_code, 204)
        self.assertEqual(self.dav("GET", "/docs/a.bin", auth).status_code, 404)
        self.assertEqual(self.dav("DELETE", "/", auth).status_code, 403)
        # And the web UI sees the same files.
        listing = self.c.get("/api/drives/main/nodes").json()["entries"]
        self.assertEqual([e["name"] for e in listing], ["copy"])

    def test_locks_and_proppatch(self):
        auth = self.enable()
        lock = b'<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' \
               b'<D:locktype><D:write/></D:locktype></D:lockinfo>'
        r = self.dav("LOCK", "/new.txt", auth, content=lock)
        self.assertEqual(r.status_code, 201)   # locking a new name makes an empty file
        token = r.headers["lock-token"]
        self.assertEqual(self.dav("GET", "/new.txt", auth).content, b"")
        r = self.dav("LOCK", "/new.txt", auth, headers={"If": f"({token})"})
        self.assertEqual((r.status_code, r.headers["lock-token"]), (200, token))
        self.assertEqual(self.dav("UNLOCK", "/new.txt", auth, headers={"Lock-Token": token}).status_code, 204)
        patch = b'<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:">' \
                b'<D:set><D:prop><Z:Win32LastModifiedTime>x</Z:Win32LastModifiedTime></D:prop></D:set>' \
                b'</D:propertyupdate>'
        r = self.dav("PROPPATCH", "/new.txt", auth, content=patch)
        self.assertEqual(r.status_code, 207)
        self.assertIn(b"Win32LastModifiedTime", r.content)
        self.assertEqual(self.dav("PROPPATCH", "/new.txt", auth, content=b"<oops").status_code, 400)

    def test_read_only(self):
        rw = self.enable()
        self.dav("PUT", "/a.txt", rw, content=b"hello")
        ro = self.enable(read_only=True)
        self.assertEqual(self.dav("GET", "/a.txt", ro).content, b"hello")
        for method in ("PUT", "DELETE", "MKCOL", "LOCK", "PROPPATCH"):
            self.assertEqual(self.dav(method, "/a.txt", ro).status_code, 403, method)
        # The access level is bound into the key: changing it in the database breaks the password.
        self._client.app.state.store.conn.execute("UPDATE webdav SET read_only = 0")
        self.assertEqual(self.dav("GET", "/a.txt", ro).status_code, 401)


if __name__ == "__main__":
    unittest.main()
