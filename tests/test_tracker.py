import support

import contextlib
import io
import unittest
from unittest import mock

from catalog import config, tracker
from catalog.storage import catalog, details, tracking


def show(link_id="1", **fields):
    return support.entry(**{"title": "Show", "type": "Show", "status": "started",
                            "progress": {"season": 1, "episode": 2},
                            "link": {"source": "tmdb_tv", "id": link_id}, **fields})


def comic(link_id="10", **fields):
    return support.entry(title="Comic", type="Comic", status="started", progress={"chapter": 5},
                         link={"source": "anilist", "id": link_id}, **fields)


def tmdb_record(status="Returning Series"):
    return {"show_status": status, "seasons": [1], "episode_counts": {"1": 10},
            "last_aired": {"season": 1, "episode": 4}, "details": {"status": status}}


def comic_record(status):
    return {"kind": "comic", "source_status": status, "total_chapters": None,
            "details": {"status": status}}


def relink(entry_id, link_id):
    with catalog.edit() as entries:
        for e in entries:
            if e["id"] == entry_id:
                e["link"] = dict(e["link"], id=link_id)


class RefreshTests(unittest.TestCase):
    def setUp(self):
        patches = [mock.patch.object(config, "TMDB_API_KEY", "test"),
                   mock.patch.object(tracker, "_fetch_tmdb", self._no_fetch),
                   mock.patch.object(tracker, "_fetch_anilist", self._no_fetch),
                   mock.patch.object(tracker, "_fetch_chapter_feeds", lambda pairs, results: None)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    @staticmethod
    def _no_fetch(pairs):
        if pairs:
            raise AssertionError("unexpected fetch")
        return {}

    def refresh(self, **patches):
        with contextlib.ExitStack() as stack:
            for name, fn in patches.items():
                stack.enter_context(mock.patch.object(tracker, name, fn))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            return tracker.refresh(force=True)

    def test_normal_refresh_stamps_identity_and_merges_details(self):
        e = show()
        support.reset([e], details={e["id"]: {"link": "tmdb_tv:1", "details": {"title": "Show"}}})
        self.refresh(_fetch_tmdb=lambda pairs: {p[0]["id"]: dict(tmdb_record(), kind="tmdb_tv")
                                                 for p in pairs})
        rec = tracking.get(e["id"])
        self.assertEqual(rec["identity"], tracker.identity(e, "tmdb_tv"))
        self.assertIn("fetched_at", rec)
        self.assertNotIn("details", rec)
        self.assertEqual(details.get(e["id"])["details"], {"title": "Show", "status": "Returning Series"})
        self.assertEqual(tracker.item_for(catalog.find(e["id"]))["next_quick"], {"season": 1, "episode": 3})

    def test_relinked_mid_fetch_gets_nothing(self):
        e = show()
        old = {"identity": tracker.identity(e, "tmdb_tv"), "kind": "tmdb_tv",
               "fetched_at": "2024-01-01T00:00:00Z", "show_status": "Ended"}
        support.reset([e], details={e["id"]: {"link": "tmdb_tv:1", "details": {"title": "Show"}}},
                      tracking={e["id"]: old})

        def fetch(pairs):
            relink(e["id"], "2")
            with details.edit() as records:
                records[e["id"]] = {"link": "tmdb_tv:2", "details": {"title": "Other"}}
            return {e["id"]: dict(tmdb_record("Canceled"), kind="tmdb_tv")}

        self.refresh(_fetch_tmdb=fetch)
        self.assertEqual(tracking.get(e["id"]), old)
        self.assertEqual(details.get(e["id"])["details"], {"title": "Other"})
        self.assertEqual(tracker.item_for(catalog.find(e["id"]))["fetched_at"], None)

    def test_deleted_mid_fetch_leaves_no_record(self):
        e, other = show(), show("3")
        support.reset([e, other], tracking={e["id"]: {"identity": "x", "kind": "tmdb_tv"}})

        def fetch(pairs):
            with catalog.edit() as entries:
                entries[:] = [x for x in entries if x["id"] != e["id"]]
            return {p[0]["id"]: dict(tmdb_record(), kind="tmdb_tv") for p in pairs}

        records = self.refresh(_fetch_tmdb=fetch)
        self.assertNotIn(e["id"], records)
        self.assertNotIn(e["id"], tracking.load())
        self.assertIn(other["id"], tracking.load())

    def test_untracked_status_mid_fetch_keeps_record_off_the_tracker(self):
        e = show()
        support.reset([e])

        def fetch(pairs):
            with catalog.edit() as entries:
                entries[0]["status"] = "planned"
            return {e["id"]: dict(tmdb_record(), kind="tmdb_tv")}

        self.refresh(_fetch_tmdb=fetch)
        self.assertEqual(tracking.get(e["id"])["episode_counts"], {"1": 10})
        self.assertIsNone(tracker.item_for(catalog.find(e["id"])))

    def test_dropped_show_keeps_its_record_and_is_fetched_once(self):
        kept, missing = show(status="dropped"), show("2", status="dropped")
        rec = dict(tmdb_record(), kind="tmdb_tv", identity=tracker.identity(kept, "tmdb_tv"),
                   fetched_at="2020-01-01T00:00:00Z")
        support.reset([kept, missing], tracking={kept["id"]: rec})
        fetched = []

        def fetch(pairs):
            fetched.extend(p[0]["id"] for p in pairs)
            return {p[0]["id"]: dict(tmdb_record(), kind="tmdb_tv") for p in pairs}

        with mock.patch.object(tracker, "_fetch_tmdb", fetch), contextlib.redirect_stdout(io.StringIO()):
            tracker.refresh()
            tracker.refresh()
        self.assertEqual(fetched, [missing["id"]])
        self.assertEqual(tracking.get(kept["id"]), rec)
        self.assertIn("episode_counts", tracking.get(missing["id"]))

    def test_comic_back_from_hiatus_is_sticky(self):
        e = comic()
        ident = tracker.identity(e, "comic")
        support.reset([e], tracking={e["id"]: {"identity": ident, "kind": "comic",
                                               "fetched_at": "2024-01-01T00:00:00Z",
                                               "source_status": "Hiatus"}})
        self.refresh(_fetch_anilist=lambda pairs: {e["id"]: comic_record("Releasing")})
        rec = tracking.get(e["id"])
        self.assertTrue(rec["returned_at"])
        self.assertIs(rec["acknowledged"], False)
        self.assertTrue(tracker.item_for(catalog.find(e["id"]))["returned"])

        # Still flagged on the next refresh until acknowledged.
        self.refresh(_fetch_anilist=lambda pairs: {e["id"]: comic_record("Releasing")})
        self.assertEqual(tracking.get(e["id"])["returned_at"], rec["returned_at"])
        self.assertTrue(tracker.acknowledge(e["id"], True))
        self.assertFalse(tracker.item_for(catalog.find(e["id"]))["returned"])

    def test_comic_relink_does_not_carry_returned_state(self):
        e = comic()
        old = {"identity": tracker.identity(e, "comic"), "kind": "comic",
               "fetched_at": "2024-01-01T00:00:00Z", "source_status": "Hiatus",
               "returned_at": "2024-01-01T00:00:00Z", "acknowledged": False}
        e["link"] = {"source": "anilist", "id": "11"}
        support.reset([e], tracking={e["id"]: old})
        self.assertFalse(tracker.item_for(catalog.find(e["id"]))["returned"])
        self.refresh(_fetch_anilist=lambda pairs: {e["id"]: comic_record("Releasing")})
        rec = tracking.get(e["id"])
        self.assertEqual(rec["identity"], tracker.identity(e, "comic"))
        self.assertNotIn("returned_at", rec)
        self.assertFalse(tracker.item_for(catalog.find(e["id"]))["returned"])


if __name__ == "__main__":
    unittest.main()
