import support  # noqa: F401  (must precede catalog imports)

import unittest

from catalog import model
from catalog.util import is_uuid4, today

COVER = "3c30b87f-46c3-4669-a0be-ebc78efd584c"


def make(**fields):
    return model.create({"title": "T", "type": "Movie", **fields}).entry


def patch(entry, **fields):
    return model.apply_patch(entry, fields).entry


class StatusDates(unittest.TestCase):
    def test_finished_defaults_to_today(self):
        self.assertEqual(make(status="finished")["date_complete"], today())

    def test_finished_explicit_null_is_unknown(self):
        self.assertIsNone(make(status="finished", date_complete=None).get("date_complete"))

    def test_finished_keeps_given_date(self):
        self.assertEqual(make(status="finished", date_complete="2020-01-02")["date_complete"], "2020-01-02")

    def test_dropped_is_always_dated(self):
        self.assertEqual(make(status="dropped", date_complete=None)["date_complete"], today())
        unknown = make(status="finished", date_complete=None)
        self.assertEqual(patch(unknown, status="dropped")["date_complete"], today())

    def test_unknown_date_survives_unrelated_patch_and_resave(self):
        unknown = make(status="finished", date_complete=None)
        self.assertIsNone(patch(unknown, rating=5).get("date_complete"))
        self.assertIsNone(patch(unknown, status="finished", date_complete=None).get("date_complete"))

    def test_leaving_terminal_clears_then_refinish_stamps_today(self):
        started = patch(make(status="finished", date_complete=None), status="started")
        self.assertIsNone(started.get("date_complete"))
        self.assertEqual(patch(started, status="finished")["date_complete"], today())

    def test_terminal_to_terminal_keeps_date(self):
        dropped = make(status="dropped", date_complete="2021-05-05")
        self.assertEqual(patch(dropped, status="finished")["date_complete"], "2021-05-05")

    def test_undo_honours_explicit_date_modified(self):
        done = make(status="finished", date_complete="2020-01-02")
        started = patch(done, status="started", date_modified="2020-01-01T00:00:00Z")
        self.assertEqual(started["date_modified"], "2020-01-01T00:00:00Z")
        undone = patch(started, status="finished", date_complete="2020-01-02", progress=None)
        self.assertEqual(undone["date_complete"], "2020-01-02")
        self.assertNotEqual(patch(done, rating=3, date_modified="not a date")["date_modified"],
                            "not a date")

    def test_invalid_completion_date_rejected(self):
        with self.assertRaises(model.ValidationError):
            make(status="finished", date_complete="2025-13-45")
        with self.assertRaises(model.ValidationError):
            patch(make(status="finished"), date_complete="yesterday")

    def test_invalid_status_rejected(self):
        with self.assertRaises(model.ValidationError):
            make(status="watching")


class TypeChanges(unittest.TestCase):
    def setUp(self):
        self.show = model.create({
            "title": "S", "type": "Show", "status": "started", "progress": "S2E3",
            "previous_watches": ["S1E10"], "episode_group": "650d9fa693db92011bb85cd2",
            "specials_watched": ["s0e1"], "pinned": True}).entry

    def test_show_fields_parsed(self):
        self.assertEqual(self.show["progress"], {"season": 2, "episode": 3})
        self.assertEqual(self.show["previous_watches"], [{"season": 1, "episode": 10}])
        self.assertEqual(self.show["specials_watched"], ["S0E1"])

    def test_show_to_movie_to_show(self):
        movie = patch(self.show, type="Movie")
        self.assertEqual(movie["progress"], {"text": "S2E3"})
        for key in ("previous_watches", "episode_group", "specials_watched", "pinned"):
            self.assertIsNone(movie.get(key), key)
        self.assertEqual(patch(movie, type="Show")["progress"], {"season": 2, "episode": 3})

    def test_show_to_group_clears_member_fields(self):
        group = patch(self.show, type="Group")
        for key in ("status", "progress", "date_complete", "previous_watches", "pinned",
                    "episode_group", "specials_watched"):
            self.assertIsNone(group.get(key), key)

    def test_group_to_book_gets_planned(self):
        book = patch(patch(self.show, type="Group"), type="Book")
        self.assertEqual(book["status"], "planned")

    def test_plain_group_ignores_null_status(self):
        group = model.create({"title": "G", "type": "Group"}).entry
        self.assertIsNone(patch(group, status=None).get("status"))

    def test_non_structural_type_uses_rewatch_count(self):
        movie = make(status="finished", rewatch_count=2, previous_watches=["S1E1"])
        self.assertEqual(movie["rewatch_count"], 2)
        self.assertIsNone(movie.get("previous_watches"))
        self.assertIsNone(patch(movie, type="Show").get("rewatch_count"))


class Collections(unittest.TestCase):
    def test_collection_defaults(self):
        c = model.create({"title": "C", "type": "Group", "collection": True,
                          "link": {"source": "tmdb_collection", "id": "1241"}}).entry
        self.assertEqual((c["status"], c["always_group"], c["date_complete"]),
                         ("finished", True, today()))

    def test_collection_without_link_is_plain_group(self):
        c = model.create({"title": "C", "type": "Group", "collection": True}).entry
        self.assertIsNone(c.get("collection"))
        self.assertIsNone(c.get("status"))

    def test_collection_drops_catalog_id_cover_and_order(self):
        group = model.create({"title": "G", "type": "Group",
                              "link": {"source": "tmdb_collection", "id": "9"}}).entry
        group.update(cover=COVER, member_order=[COVER, "movie:1"], member_sort="manual")
        col = patch(group, collection=True)
        self.assertIsNone(col.get("cover"))
        self.assertEqual(col.get("member_order"), ["movie:1"])

    def test_plain_group_drops_source_refs(self):
        group = model.create({"title": "G", "type": "Group", "cover": "movie:1",
                              "member_order": ["movie:1", COVER]}).entry
        self.assertIsNone(group.get("cover"))
        self.assertEqual(group.get("member_order"), [COVER])


class Links(unittest.TestCase):
    def test_unknown_source_raises(self):
        with self.assertRaises(model.ValidationError):
            patch(make(), link={"source": "tmdb", "id": "1"})

    def test_null_unlinks(self):
        linked = make(link={"source": "tmdb_movie", "id": "5"})
        self.assertEqual(linked["link"], {"source": "tmdb_movie", "id": "5"})
        self.assertIsNone(patch(linked, link=None).get("link"))

    def test_non_group_cannot_take_group_source(self):
        self.assertIsNone(make(link={"source": "tmdb_collection", "id": "1"}).get("link"))

    def test_chapter_source_is_not_a_main_link(self):
        with self.assertRaises(model.ValidationError):
            model.create({"title": "C", "type": "Comic", "link": {"source": "comick", "id": "x"}})


class Comics(unittest.TestCase):
    def test_chapter_parsing(self):
        c = model.create({"title": "C", "type": "Comic", "progress": "12.5", "chapter_override": "40"}).entry
        self.assertEqual(c["progress"], {"chapter": 12.5})
        self.assertEqual(c["chapter_override"], 40)

    def test_episode_text_becomes_chapter(self):
        c = model.create({"title": "C", "type": "Comic", "progress": "Ep 12"}).entry
        self.assertEqual(c["progress"], {"chapter": 12})

    def test_bad_override_rejected(self):
        with self.assertRaises(model.ValidationError):
            model.create({"title": "C", "type": "Comic", "chapter_override": "lots"})

    def test_chapter_link_kept_for_comics_only(self):
        cl = {"source": "comick", "id": "aJr35kOX", "title": "Ichi", "url": "https://comick.io/comic/x"}
        c = model.create({"title": "C", "type": "Comic", "chapter_link": cl, "ignored": True}).entry
        self.assertEqual(c["chapter_link"]["id"], "aJr35kOX")
        self.assertIsNone(c.get("ignored"))
        imported = model.from_import({"title": "C", "type": "Comic", "status": "started", "chapter_link": cl})
        self.assertEqual(imported["chapter_link"]["source"], "comick")
        self.assertIsNone(model.apply_patch(c, {"type": "Show"}).entry.get("chapter_link"))


class Ratings(unittest.TestCase):
    def test_infinite_rating_rejected(self):
        with self.assertRaises(model.ValidationError):
            make(rating=float("inf"))

    def test_out_of_range_rejected(self):
        with self.assertRaises(model.ValidationError):
            make(rating=11)


class Import(unittest.TestCase):
    def test_bad_ids_regenerated(self):
        for bad in ("*", "../x", "3C30B87F-46C3-4669-A0BE-EBC78EFD584C", None, 7):
            imported = model.from_import({"id": bad, "title": "T", "type": "Movie"})
            self.assertTrue(is_uuid4(imported["id"]), bad)
            self.assertNotEqual(imported["id"], bad)

    def test_good_id_and_dates_kept(self):
        raw = {"id": COVER, "title": "T", "type": "Movie", "status": "finished",
               "date_added": "2020-01-01T00:00:00Z", "date_modified": "2020-02-01T00:00:00Z",
               "date_complete": "2020-03-01"}
        imported = model.from_import(raw)
        self.assertEqual(model.ordered(imported), raw)

    def test_dropped_gets_date(self):
        imported = model.from_import({"title": "D", "type": "Movie", "status": "dropped"})
        self.assertEqual(imported["date_complete"], today())

    def test_unusable_rows_skipped(self):
        self.assertIsNone(model.from_import({"type": "Movie"}))
        self.assertIsNone(model.from_import(["not", "a", "dict"]))


if __name__ == "__main__":
    unittest.main()
