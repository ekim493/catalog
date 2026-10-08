"""Settings, paths and constants. Values come from the process environment,
falling back to the git-ignored .env beside server.py."""
import os
import re
import sys

APP_VERSION = "4.3.1"
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_env_file(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except FileNotFoundError:
        return
    except OSError as exc:
        print(f"Warning: could not read {path}: {exc}", file=sys.stderr)
        return
    for number, raw in enumerate(lines, 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        key = key.strip()
        if not sep or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            print(f"Warning: ignoring invalid .env line {number}", file=sys.stderr)
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        os.environ.setdefault(key, value)


_load_env_file(os.path.join(BASE_DIR, ".env"))


def _flag(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _resolve(path):
    return path if os.path.isabs(path) else os.path.join(BASE_DIR, path)


TMDB_API_KEY = os.environ.get("TMDB_API_KEY", "").strip()
ALLOW_CUSTOM_DATE_ADDED = _flag("ALLOW_CUSTOM_DATE_ADDED")
HIDDEN_CATEGORIES = [t.strip() for t in os.environ.get("HIDDEN_CATEGORIES", "").split(",") if t.strip()]

DATA_DIR = _resolve(os.environ.get("CATALOG_DATA_DIR", "").strip() or "data")
ENTRIES_FILE = os.path.join(DATA_DIR, "entries.json")
DETAILS_FILE = os.path.join(DATA_DIR, "details.json")
TRACKING_FILE = os.path.join(DATA_DIR, "tracking.json")
STASH_FILE = os.path.join(DATA_DIR, "stash.json")
POSTER_DIR = os.path.join(DATA_DIR, "posters")
_backup_setting = os.environ.get("CATALOG_BACKUP_DIR", "").strip()
BACKUP_DIR = _resolve(_backup_setting) if _backup_setting else os.path.join(DATA_DIR, "backups")
DAILY_BACKUP_DIR = os.path.join(BACKUP_DIR, "daily")
STATIC_DIR = os.path.join(BASE_DIR, "static")

MAX_BACKUPS = 20
MAX_DAILY_BACKUPS = 14
TRACK_TTL_HOURS = 12
COLLECTION_TTL_HOURS = 12
FETCH_TIMEOUT = 8
MAX_POSTER_BYTES = 5 * 1024 * 1024
USER_AGENT = f"Catalog/{APP_VERSION}"

# Upstream base URLs, overridable for testing.
TMDB_BASE = os.environ.get("CATALOG_TMDB_BASE", "https://api.themoviedb.org")
TMDB_IMAGE_BASE = os.environ.get("CATALOG_TMDB_IMAGE_BASE", "https://image.tmdb.org")
ANILIST_BASE = os.environ.get("CATALOG_ANILIST_BASE", "https://graphql.anilist.co")
OPENLIB_BASE = os.environ.get("CATALOG_OPENLIB_BASE", "https://openlibrary.org")
OPENLIB_COVERS_BASE = os.environ.get("CATALOG_OPENLIB_COVERS_BASE", "https://covers.openlibrary.org")
COMICK_BASE = os.environ.get("CATALOG_COMICK_BASE", "https://api.comick.dev")
AUDIBLE_BASE = os.environ.get("CATALOG_AUDIBLE_BASE", "https://api.audible.com")


def port(argv):
    """A command-line port wins over PORT from the environment or .env."""
    return int(argv[1] if len(argv) > 1 else os.environ.get("PORT") or 8000)
