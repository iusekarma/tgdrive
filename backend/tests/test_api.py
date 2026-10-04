"""End-to-end API tests through FastAPI's TestClient, on the local transport."""
import os
import tempfile
import unittest
from io import BytesIO

from PIL import Image

try:
    from fastapi.testclient import TestClient
except ImportError:
    raise unittest.SkipTest("fastapi is not installed")

from app import crypto
from app.config import Config
from app.server import COOKIE, create_app

crypto.KDF_PARAMS = {"alg": "argon2id", "t": 1, "m_kib": 64, "p": 1}  # fast, tests only


class ApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        cfg = Config(
            db_path=os.path.join(self.tmp.name, "db", "t.db"), transport="local",
            bot_token=None, chat_id=None, local_dir=os.path.join(self.tmp.name, "blobs"),
            backup_passphrase=None, chunk_size=1024, backup_debounce=0.05,
            thumb_dir=os.path.join(self.tmp.name, "thumbs"),
        )
        self._client = TestClient(create_app(cfg))
        self.c = self._client.__enter__()          # runs startup
        r = self.c.post("/api/vault/setup", json={"password": "master-pw"})
        self.assertEqual(r.status_code, 201, r.text)
        self.master_recovery = r.json()["recovery_key"]
        r = self.c.post("/api/drives", json={"name": "main", "password": "password1"})
        self.assertEqual(r.status_code, 201, r.text)
        self.recovery = r.json()["recovery_key"]

    def tearDown(self):
        self._client.__exit__(None, None, None)    # runs shutdown
        self.tmp.cleanup()

    def test_files_and_folders(self):
        c = self.c
        self.assertEqual(c.get("/api/drives").json(), [{"name": "main", "protected": True, "unlocked": True}])

        folder = c.post("/api/drives/main/folders", json={"name": "docs"}).json()
        data = os.urandom(5000)
        r = c.put("/api/drives/main/files", params={"filename": "a.pdf", "parent": folder["id"]}, content=data)
        self.assertEqual(r.status_code, 201, r.text)
        node = r.json()
        self.assertEqual((node["name"], node["size"]), ("a.pdf", 5000))

        listing = c.get("/api/drives/main/nodes", params={"parent": folder["id"]}).json()
        self.assertEqual([p["name"] for p in listing["path"]], ["docs"])
        self.assertEqual([e["id"] for e in listing["entries"]], [node["id"]])

        url = f"/api/drives/main/files/{node['id']}"
        r = c.get(url)
        self.assertEqual((r.status_code, r.content), (200, data))
        self.assertTrue(r.headers["content-disposition"].startswith("attachment"))
        r = c.get(url, headers={"Range": "bytes=1000-2999"})
        self.assertEqual((r.status_code, r.content), (206, data[1000:3000]))
        self.assertEqual(r.headers["content-range"], "bytes 1000-2999/5000")
        self.assertEqual(c.get(url, headers={"Range": "bytes=9999-"}).status_code, 416)
        self.assertTrue(c.get(url, params={"inline": "true"}).headers["content-disposition"].startswith("inline"))

        r = c.put("/api/drives/main/files", params={"filename": "a.pdf", "parent": folder["id"]}, content=b"x")
        self.assertEqual(r.status_code, 409)

        r = c.patch(f"/api/drives/main/nodes/{node['id']}", json={"name": "b.pdf", "parent_id": None})
        self.assertEqual((r.status_code, r.json()["name"]), (200, "b.pdf"))
        self.assertEqual([e["name"] for e in c.get("/api/drives/main/nodes").json()["entries"]], ["docs", "b.pdf"])

        self.assertEqual(c.delete(f"/api/drives/main/nodes/{folder['id']}").status_code, 204)
        self.assertEqual(c.get("/api/drives/main/nodes", params={"parent": folder["id"]}).status_code, 404)

    def test_locking_and_passwords(self):
        c = self.c
        self.assertEqual(c.post("/api/drives/main/lock").status_code, 204)
        self.assertEqual(c.get("/api/drives/main/nodes").status_code, 401)
        self.assertEqual(c.post("/api/drives/main/unlock", json={"password": "wrong-one"}).status_code, 401)
        self.assertEqual(c.post("/api/drives/main/unlock", json={"password": "password1"}).status_code, 200)
        self.assertEqual(c.get("/api/drives/main/nodes").status_code, 200)

        r = c.post("/api/drives/main/password", json={"current_password": "password1", "new_password": "password2"})
        self.assertEqual(r.json(), {"protected": True, "recovery_key": None})
        r = c.post("/api/drives/main/recover", json={"recovery_key": self.recovery, "new_password": "password3"})
        self.assertEqual(r.status_code, 200)

        self.assertEqual(c.post("/api/logout").status_code, 204)
        self.assertEqual(c.get("/api/drives/main/nodes").json()["locked"], "vault")
        self.assertEqual(c.post("/api/vault/unlock", json={"password": "master-pw"}).status_code, 200)
        self.assertEqual(c.get("/api/drives/main/nodes").json()["locked"], "drive")
        self.assertEqual(c.post("/api/drives/main/unlock", json={"password": "password2"}).status_code, 401)
        self.assertEqual(c.post("/api/drives/main/unlock", json={"password": "password3"}).status_code, 200)

        self.assertEqual(c.post("/api/drives/main/delete", json={"password": "password3"}).status_code, 204)
        self.assertEqual(c.get("/api/drives").json(), [])

    def test_session_cookie_and_errors(self):
        c = self.c
        self.assertIn(COOKIE, c.cookies)
        c.cookies.clear()
        self.assertEqual(c.get("/api/vault").json(),
                         {"initialized": True, "unlocked": False, "setup_needs_admin": False})
        r = c.get("/api/drives")
        self.assertEqual((r.status_code, r.json()["locked"]), (401, "vault"))
        self.assertEqual(c.post("/api/drives", json={"name": "x"}).status_code, 401)
        self.assertEqual(c.post("/api/vault/setup", json={"password": "another-pw"}).status_code, 409)
        self.assertEqual(c.post("/api/vault/unlock", json={"password": "master-pw"}).status_code, 200)
        self.assertEqual(c.get("/api/drives").json(), [{"name": "main", "protected": True, "unlocked": False}])
        self.assertEqual(c.get("/api/drives/main/nodes").status_code, 401)
        self.assertEqual(c.post("/api/drives", json={"name": "main", "password": "password1"}).status_code, 409)
        self.assertEqual(c.post("/api/drives", json={"name": "two", "password": "short"}).status_code, 422)
        self.assertEqual(c.post("/api/drives", json={"name": "bad/name", "password": "password1"}).status_code, 422)
        self.assertEqual(c.post("/api/drives/nope/unlock", json={"password": "password1"}).status_code, 404)


    def test_open_drives_and_drive_passwords(self):
        c = self.c
        r = c.post("/api/drives", json={"name": "open"})
        self.assertEqual(r.json(), {"name": "open", "protected": False, "recovery_key": None})
        c.post("/api/logout")
        c.post("/api/vault/unlock", json={"password": "master-pw"})
        self.assertEqual(c.get("/api/drives/open/nodes").status_code, 200)   # no second password

        r = c.post("/api/drives/open/password", json={"new_password": "drive-pw1"})
        recovery = r.json()["recovery_key"]
        self.assertTrue(recovery)
        self.assertEqual(c.post("/api/drives/open/lock").status_code, 204)
        self.assertEqual(c.get("/api/drives/open/nodes").json()["locked"], "drive")
        r = c.post("/api/drives/open/password", json={"current_password": "wrong-pw", "new_password": None})
        self.assertEqual(r.status_code, 401)
        r = c.post("/api/drives/open/password", json={"current_password": "drive-pw1", "new_password": None})
        self.assertEqual(r.json(), {"protected": False, "recovery_key": None})
        self.assertEqual(c.get("/api/drives/open/nodes").status_code, 200)

        self.assertEqual(c.post("/api/drives/open/delete", json={"password": "drive-pw1"}).status_code, 401)
        self.assertEqual(c.post("/api/drives/open/delete", json={"password": "master-pw"}).status_code, 204)
        self.assertEqual([d["name"] for d in c.get("/api/drives").json()], ["main"])

    def test_rename_drive(self):
        c = self.c
        data = os.urandom(3000)
        node = c.put("/api/drives/main/files", params={"filename": "a.bin"}, content=data).json()
        c.post("/api/drives", json={"name": "other"})

        self.assertEqual(c.post("/api/drives/main/rename", json={"name": "other"}).status_code, 409)
        self.assertEqual(c.post("/api/drives/main/rename", json={"name": "bad/name"}).status_code, 422)
        r = c.post("/api/drives/main/rename", json={"name": "renamed"})
        self.assertEqual(r.json(), {"name": "renamed"})
        self.assertEqual([d["name"] for d in c.get("/api/drives").json()], ["other", "renamed"])
        self.assertEqual(c.get("/api/drives/main/nodes").status_code, 404)
        # Still unlocked under the new name, and the files still decrypt.
        self.assertEqual(c.get(f"/api/drives/renamed/files/{node['id']}").content, data)

        # A drive with a password must be unlocked to be renamed; the password still works after.
        c.post("/api/drives/renamed/lock")
        self.assertEqual(c.post("/api/drives/renamed/rename", json={"name": "x"}).json()["locked"], "drive")
        self.assertEqual(c.post("/api/drives/renamed/unlock", json={"password": "password1"}).status_code, 200)
        self.assertEqual(c.post("/api/drives/other/rename", json={"name": "open one"}).status_code, 200)

    def test_resumable_upload(self):
        c = self.c
        data = os.urandom(1024 * 3 + 7)   # chunk_size is 1024 here
        r = c.post("/api/drives/main/uploads", json={"filename": "big.bin", "size": len(data)})
        self.assertEqual(r.status_code, 201, r.text)
        url = f"/api/drives/main/uploads/{r.json()['id']}"

        # The body ends early, as a dropped connection would: whole chunks are kept.
        r = c.put(url, content=data[:1500])
        self.assertEqual(r.json(), {"done": False, "size": len(data), "stored": 1024, "phase": "idle", "wait": None})
        self.assertEqual(c.get(url).json()["stored"], 1024)
        self.assertEqual(c.put(url, params={"offset": 2048}, content=data[2048:]).status_code, 409)

        r = c.put(url, params={"offset": 1024}, content=data[1024:])
        self.assertEqual(r.status_code, 201, r.text)
        entry = r.json()["entry"]
        self.assertEqual((entry["name"], entry["size"]), ("big.bin", len(data)))
        self.assertEqual(c.get(url).json(), {"done": True, "entry": entry})
        self.assertEqual(c.get(f"/api/drives/main/files/{entry['id']}").content, data)

        r = c.post("/api/drives/main/uploads", json={"filename": "big.bin", "size": 1})
        self.assertEqual(r.status_code, 409)
        nid = c.post("/api/drives/main/uploads", json={"filename": "other", "size": 5000}).json()["id"]
        self.assertEqual(c.delete(f"/api/drives/main/uploads/{nid}").status_code, 204)
        self.assertEqual(c.get(f"/api/drives/main/uploads/{nid}").status_code, 404)

    def test_create_folder_exist_ok(self):
        c = self.c
        first = c.post("/api/drives/main/folders", json={"name": "docs"}).json()
        self.assertEqual(c.post("/api/drives/main/folders", json={"name": "docs"}).status_code, 409)
        again = c.post("/api/drives/main/folders", json={"name": "docs", "exist_ok": True})
        self.assertEqual((again.status_code, again.json()["id"]), (201, first["id"]))
        c.put("/api/drives/main/files", params={"filename": "f"}, content=b"x")
        r = c.post("/api/drives/main/folders", json={"name": "f", "exist_ok": True})
        self.assertEqual(r.status_code, 409)

    def test_master_password_change_and_recovery(self):
        c = self.c
        r = c.post("/api/vault/password", json={"current_password": "master-pw", "new_password": "master-pw2"})
        self.assertEqual(r.status_code, 204)
        c.post("/api/logout")
        self.assertEqual(c.post("/api/vault/unlock", json={"password": "master-pw"}).status_code, 401)
        r = c.post("/api/vault/recover", json={"recovery_key": "AAAA", "new_password": "master-pw3"})
        self.assertEqual(r.status_code, 401)
        r = c.post("/api/vault/recover", json={"recovery_key": self.master_recovery, "new_password": "master-pw3"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(c.post("/api/drives/main/unlock", json={"password": "password1"}).status_code, 200)

    def test_bulk_move_and_delete(self):
        c = self.c
        dest = c.post("/api/drives/main/folders", json={"name": "dest"}).json()["id"]
        ids = [c.put("/api/drives/main/files", params={"filename": f"f{i}"}, content=b"x" * 3000).json()["id"]
               for i in range(3)]
        r = c.post("/api/drives/main/nodes/move", json={"ids": ids[:2], "parent_id": dest})
        self.assertEqual(r.status_code, 204)
        names = lambda parent=None: [e["name"] for e in c.get(
            "/api/drives/main/nodes", params={"parent": parent} if parent else {}).json()["entries"]]
        self.assertEqual(names(dest), ["f0", "f1"])
        r = c.post("/api/drives/main/nodes/move", json={"ids": [dest], "parent_id": dest})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(c.post("/api/drives/main/nodes/delete", json={"ids": [dest, ids[2]]}).status_code, 204)
        self.assertEqual(names(), [])
        self.assertEqual(c.post("/api/drives/main/nodes/delete", json={"ids": []}).status_code, 422)

    def test_thumbnails(self):
        c = self.c
        buf = BytesIO()
        Image.new("RGB", (900, 600), (10, 120, 90)).save(buf, "JPEG")
        photo = c.put("/api/drives/main/files", params={"filename": "p.jpg"}, content=buf.getvalue()).json()
        self.assertFalse(photo["thumb"])
        r = c.get(f"/api/drives/main/files/{photo['id']}/thumbnail")
        self.assertEqual((r.status_code, r.headers["content-type"]), (200, "image/webp"))
        self.assertTrue(c.get("/api/drives/main/nodes").json()["entries"][0]["thumb"])

        video = c.put("/api/drives/main/files", params={"filename": "v.mp4"}, content=b"\0" * 2000).json()
        url = f"/api/drives/main/files/{video['id']}/thumbnail"
        self.assertEqual(c.get(url).status_code, 404)
        self.assertEqual(c.put(url, content=b"<svg/>").status_code, 400)
        self.assertEqual(c.put(url, content=buf.getvalue()).status_code, 204)
        self.assertEqual(c.get(url).status_code, 200)
        self.assertEqual(c.put(url, content=b"x" * (4 * 1024 * 1024 + 1)).status_code, 413)

    def test_search(self):
        c = self.c
        folder = c.post("/api/drives/main/folders", json={"name": "Trips"}).json()["id"]
        c.put("/api/drives/main/files", params={"filename": "beach.jpg", "parent": folder}, content=b"x")
        r = c.get("/api/drives/main/search", params={"q": "BEA"}).json()
        self.assertEqual(r["total"], 1)
        self.assertEqual((r["results"][0]["name"], r["results"][0]["path"]), ("beach.jpg", [{"id": folder, "name": "Trips"}]))
        self.assertEqual(c.get("/api/drives/main/search", params={"q": "x" * 201}).status_code, 422)
        c.post("/api/drives/main/lock")
        self.assertEqual(c.get("/api/drives/main/search", params={"q": "b"}).status_code, 401)


class SetupTest(unittest.TestCase):
    def test_first_run_needs_the_admin_password_when_set(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Config(
                db_path=os.path.join(tmp, "t.db"), transport="local", bot_token=None, chat_id=None,
                local_dir=os.path.join(tmp, "blobs"), backup_passphrase=None, chunk_size=1024,
                backup_debounce=0.05, admin_password="admin-secret", thumb_dir=os.path.join(tmp, "thumbs"),
            )
            with TestClient(create_app(cfg)) as c:
                self.assertEqual(c.get("/api/vault").json(),
                                 {"initialized": False, "unlocked": False, "setup_needs_admin": True})
                self.assertEqual(c.post("/api/vault/unlock", json={"password": "x"}).status_code, 409)
                self.assertEqual(c.post("/api/vault/setup", json={"password": "master-pw"}).status_code, 403)
                r = c.post("/api/vault/setup", json={"password": "master-pw", "admin_password": "admin-secret"})
                self.assertEqual(r.status_code, 201)
                self.assertEqual(c.get("/api/drives").json(), [])


class StaticUiTest(unittest.TestCase):
    def test_serves_the_ui_and_falls_back_to_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            ui = os.path.join(tmp, "ui")
            os.makedirs(os.path.join(ui, "assets"))
            for name, body in (("index.html", "<html>app</html>"), ("favicon.svg", "<svg/>"),
                               ("assets/index-abc.js", "js")):
                with open(os.path.join(ui, name), "w") as f:
                    f.write(body)
            with open(os.path.join(tmp, "secret.txt"), "w") as f:
                f.write("secret")
            cfg = Config(
                db_path=os.path.join(tmp, "t.db"), transport="local", bot_token=None, chat_id=None,
                local_dir=os.path.join(tmp, "blobs"), backup_passphrase=None, chunk_size=1024,
                thumb_dir=os.path.join(tmp, "thumbs"), static_dir=ui,
            )
            with TestClient(create_app(cfg)) as c:
                r = c.get("/")
                self.assertEqual(r.text, "<html>app</html>")
                self.assertIn("frame-ancestors 'none'", r.headers["content-security-policy"])
                self.assertEqual(c.get("/d/Photos/abc123").text, "<html>app</html>")
                self.assertEqual(c.head("/d/Photos/abc123").status_code, 200)
                r = c.get("/assets/index-abc.js")
                self.assertEqual((r.text, r.headers["cache-control"]), ("js", "public, max-age=31536000, immutable"))
                self.assertEqual(c.get("/favicon.svg").text, "<svg/>")
                self.assertEqual(c.get("/%2e%2e/secret.txt").text, "<html>app</html>")
                self.assertEqual(c.get("/api/health").json(), {"ok": True})
                r = c.get("/api/nope")
                self.assertEqual((r.status_code, r.json()), (404, {"detail": "not found"}))


if __name__ == "__main__":
    unittest.main()
