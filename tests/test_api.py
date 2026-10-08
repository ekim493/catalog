import support

import http.client
import json
import os
import shutil
import socket
import threading
import unittest
from unittest import mock

from catalog import config, providers, routes  # noqa: F401 (routes registers endpoints)
from catalog.web import Handler, Server


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        Handler.log_message = lambda self, fmt, *args: None
        cls.httpd = Server(("127.0.0.1", 0), Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def setUp(self):
        support.reset()

    def request(self, method, path, body=None, headers=None):
        """-> (status, raw body bytes). A dict/list body is sent as JSON."""
        headers = dict(headers or {})
        if body is not None and not isinstance(body, bytes):
            body = json.dumps(body).encode()
            headers.setdefault("Content-Type", "application/json")
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request(method, path, body=body, headers=headers)
            resp = conn.getresponse()
            return resp.status, resp.read()
        finally:
            conn.close()

    def call(self, method, path, body=None, headers=None):
        status, raw = self.request(method, path, body, headers)
        return status, json.loads(raw) if raw else None

    def raw_get(self, path):
        """Status of a GET sent byte-for-byte, bypassing client-side URL checks."""
        with socket.create_connection(("127.0.0.1", self.port), timeout=10) as sock:
            sock.sendall(b"GET " + path + b" HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            data = b""
            while chunk := sock.recv(65536):
                data += chunk
        return int(data.split(b" ", 2)[1]), data

    def on_disk(self):
        with open(config.ENTRIES_FILE, "rb") as f:
            return f.read()

    def test_create_patch_delete(self):
        status, body = self.call("POST", "/api/entries", {"title": "Dune", "type": "Book", "status": "finished"})
        self.assertEqual(status, 201)
        entry = body["entry"]
        self.assertEqual((entry["title"], entry["status"]), ("Dune", "finished"))

        status, dup = self.call("POST", "/api/entries", {"title": "Dune", "type": "Book", "status": "finished"})
        self.assertEqual((status, dup["entry"]["id"]), (200, entry["id"]))

        path = f"/api/entries/{entry['id']}"
        status, body = self.call("PATCH", path, {"rating": 8, "date_modified": "2020-01-01T00:00:00Z"})
        self.assertEqual(status, 200)
        self.assertEqual(body["entry"]["rating"], 8)
        self.assertEqual(body["entry"]["date_modified"], "2020-01-01T00:00:00Z")
        self.assertEqual(json.loads(self.on_disk())[0]["rating"], 8)

        self.assertEqual(self.call("PATCH", path, {"rating": 11})[0], 400)
        self.assertEqual(self.call("DELETE", path), (200, {"deleted": entry["id"]}))
        self.assertEqual(self.call("GET", "/api/entries"), (200, []))
        self.assertEqual(self.call("PATCH", path, {"rating": 1})[0], 404)
        self.assertEqual(self.call("PATCH", "/api/entries/not-a-uuid", {})[0], 404)

    def test_stash_create_edit_delete_and_restore(self):
        status, body = self.call("POST", "/api/stash", {"text": "  Frieren\nsaw it on a forum ", "type": "Show"})
        self.assertEqual(status, 201)
        first = body["item"]
        self.assertEqual((first["text"], first["type"]), ("Frieren\nsaw it on a forum", "Show"))
        self.assertEqual(self.call("POST", "/api/stash", {"text": "   "})[0], 400)

        _, body = self.call("POST", "/api/stash", {"text": "Some book", "type": ""})
        second = body["item"]
        self.assertNotIn("type", second)
        # Newest first, on disk as well as over the API.
        second_older = dict(second, date_added="2020-01-01T00:00:00Z")
        with open(config.STASH_FILE, encoding="utf-8") as f:
            self.assertEqual([i["id"] for i in json.load(f)], [second["id"], first["id"]])

        path = f"/api/stash/{first['id']}"
        status, body = self.call("PATCH", path, {"text": "Frieren", "type": None})
        self.assertEqual(status, 200)
        self.assertEqual(body["item"]["text"], "Frieren")
        self.assertNotIn("type", body["item"])
        self.assertEqual(self.call("PATCH", path, {"text": ""})[0], 400)

        status, body = self.call("DELETE", f"/api/stash/{second['id']}")
        self.assertEqual((status, body["item"]["id"]), (200, second["id"]))
        self.assertEqual(self.call("DELETE", f"/api/stash/{second['id']}")[0], 404)
        self.assertEqual(self.call("PATCH", f"/api/stash/{second['id']}", {"text": "x"})[0], 404)
        self.assertEqual(self.call("DELETE", "/api/stash/not-a-uuid-not-a-uuid-not-a-uuid-xxxx")[0], 404)

        # Undo puts the same item back where its date says it belongs.
        status, body = self.call("POST", "/api/stash", second_older)
        self.assertEqual((status, body["item"]["id"], body["item"]["date_added"]),
                         (201, second["id"], "2020-01-01T00:00:00Z"))
        self.assertEqual(self.call("POST", "/api/stash", second_older)[0], 400)
        _, body = self.call("GET", "/api/stash")
        self.assertEqual([i["id"] for i in body["items"]], [first["id"], second["id"]])
        self.assertTrue(any(n.startswith("stash-") for n in os.listdir(config.BACKUP_DIR)))

    def test_corrupt_stash_file_is_refused(self):
        with open(config.STASH_FILE, "w", encoding="utf-8") as f:
            f.write("{not json")
        status, body = self.call("GET", "/api/stash")
        self.assertEqual(status, 500)
        self.assertIn("stash.json", body["error"])
        self.assertEqual(self.call("POST", "/api/stash", {"text": "x"})[0], 500)
        with open(config.STASH_FILE, encoding="utf-8") as f:
            self.assertEqual(f.read(), "{not json")

    def test_burst_of_parallel_requests_is_served(self):
        # Many simultaneous connections must all be served.
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(100) as pool:
            statuses = list(pool.map(lambda _: self.request("GET", "/icon.svg")[0], range(100)))
        self.assertEqual(statuses, [200] * 100)

    def test_import_only_into_empty_catalog(self):
        rows = [support.entry(title="A", status="finished", date_complete="2020-01-01"),
                support.entry(title="B", type="Show", status="started", progress={"season": 1, "episode": 2})]
        self.assertEqual(self.call("POST", "/api/import", rows), (200, {"imported": 2}))
        self.assertEqual(json.loads(self.on_disk()), rows)
        self.assertEqual(self.call("POST", "/api/import", rows)[0], 409)
        self.assertEqual(json.loads(self.on_disk()), rows)

    def test_import_rejects_non_list_and_empty(self):
        self.assertEqual(self.call("POST", "/api/import", {"title": "A"})[0], 400)
        self.assertEqual(self.call("POST", "/api/import", [{"nope": 1}])[0], 400)
        self.assertEqual(json.loads(self.on_disk()), [])

    def test_export_is_byte_identical(self):
        for title in ("Alpha", "Beta"):
            self.call("POST", "/api/entries", {"title": title, "type": "Movie", "notes": "ünïcode"})
        status, raw = self.request("GET", "/api/export")
        self.assertEqual(status, 200)
        self.assertEqual(raw, self.on_disk())

    def test_static_traversal_and_nul_are_refused(self):
        with open(os.path.join(support.ROOT, "server.py"), "rb") as f:
            secret = f.read()[:60]
        for path in (b"/../server.py", b"/js/../../server.py", b"/posters/../entries.json",
                     b"/%2e%2e/server.py", b"/index.html\x00.png", b"/posters/x\x00"):
            status, data = self.raw_get(path)
            self.assertIn(status, (403, 404), path)
            self.assertNotIn(secret, data, path)
        self.assertEqual(self.raw_get(b"/")[0], 200)

    def test_foreign_origin_rejected(self):
        body = {"title": "X", "type": "Movie"}
        self.assertEqual(self.call("POST", "/api/entries", body, {"Origin": "http://evil.example"})[0], 403)
        self.assertEqual(self.call("POST", "/api/entries", body, {"Origin": "null"})[0], 403)
        same = {"Origin": f"http://127.0.0.1:{self.port}"}
        self.assertEqual(self.call("POST", "/api/entries", body, same)[0], 201)

    def test_non_json_content_type_rejected(self):
        status, _ = self.call("POST", "/api/entries", b'{"title": "X", "type": "Movie"}',
                              {"Content-Type": "text/plain"})
        self.assertTrue(400 <= status < 500, status)
        self.assertEqual(json.loads(self.on_disk()), [])

    def test_nan_body_rejected(self):
        for raw in (b'{"title": "X", "type": "Movie", "rating": NaN}', b'{"rating": Infinity}'):
            status, _ = self.call("POST", "/api/entries", raw, {"Content-Type": "application/json"})
            self.assertEqual(status, 400, raw)
        self.assertEqual(self.call("POST", "/api/entries", b"\xff\xfe", {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.call("POST", "/api/entries", [1, 2])[0], 400)

    def test_stats_hidden_toggle(self):
        support.reset([support.entry(title="Seen", status="finished"),
                       support.entry(title="Secret", status="finished", hidden=True)])
        self.assertEqual(self.call("GET", "/api/stats")[1]["total"], 1)
        _, with_hidden = self.call("GET", "/api/stats?hidden=1")
        self.assertEqual(with_hidden["total"], 2)
        self.assertEqual(with_hidden["consumed"]["movies"], 2)

    def test_stats_ignore_a_record_from_another_link(self):
        e = support.entry(title="Show", type="Show", status="started", progress={"season": 2, "episode": 1},
                          link={"source": "tmdb_tv", "id": "2"})
        support.reset([e], tracking={e["id"]: {"identity": "tmdb_tv|tmdb_tv:1|", "kind": "tmdb_tv",
                                               "seasons": [1, 2], "episode_counts": {"1": 100, "2": 10}}})
        self.assertEqual(self.call("GET", "/api/stats")[1]["consumed"]["episodes"], 1)

    def test_group_turned_collection_fetches_members(self):
        g = support.entry(title="Saga", type="Group", link={"source": "tmdb_collection", "id": "5"})
        g.pop("status", None)
        support.reset([g])
        members = [{"ref": "tmdb_movie:1", "kind": "movie", "title": "One"}]
        with mock.patch.object(providers, "collection_members", lambda *a, **k: members):
            status, _ = self.call("PATCH", f"/api/entries/{g['id']}", {"collection": True, "status": "finished"})
        self.assertEqual(status, 200)
        self.assertEqual(self.call("GET", "/api/stats")[1]["total"], 1)

    def test_save_recreates_a_missing_backup_folder(self):
        e = support.entry()
        support.reset([e])
        shutil.rmtree(config.BACKUP_DIR)
        self.assertEqual(self.call("PATCH", f"/api/entries/{e['id']}", {"notes": "x"})[0], 200)
        self.assertTrue(any(n.startswith("entries-") for n in os.listdir(config.BACKUP_DIR)))

    def test_collection_lookup_failure_is_502(self):
        with mock.patch.object(providers, "collection_members", lambda *a, **k: None):
            status, body = self.call("GET", "/api/collection?source=tmdb_collection&id=1241&title=X")
        self.assertEqual(status, 502)
        self.assertIn("error", body)


if __name__ == "__main__":
    unittest.main()
