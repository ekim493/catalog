# Catalog

> **Disclaimer:** This project was vibe coded, built largely with AI
> assistance, and is provided as is. Use it at your own discretion.

A small, self-hosted tracker for shows, movies, books, manga, comics,
audiobooks, and anything else you want to log. There are no accounts,
databases, frameworks, build steps, or dependencies beyond Python 3. Your
catalog is a human-readable JSON file that you own.

Optional title sources supply search results, artwork, release details, and
tracking data; entries never require a link.

- **Backend:** `server.py` and `catalog/` — Python standard library only.
- **Frontend:** `static/` — plain HTML, CSS, and JavaScript modules.
- **Catalog:** `data/entries.json` — backed up automatically before every change.

Catalog has four views: **Ledger** (the whole catalog), **Tracker**
(followed Shows and Comics and an upcoming schedule), **Stash** (titles to
remember for later), and **Stats**.

---

## Quick start

From the project folder:

```bash
python3 server.py
```

Open `http://localhost:8000`. Optional settings, including the TMDb API key,
live in the git-ignored `.env` file (copy `.env.example`). To use another
port, pass it as an argument (`python3 server.py 9000`) or set `PORT`; the
argument wins.

### Phone

The server listens on all interfaces, so any device that can reach the
machine (same LAN, Tailscale, WireGuard, …) can open
`http://<machine-ip>:8000`. On iPhone, Safari's **Add to Home Screen** installs
Catalog as a standalone app.

### Keep it running on a Mac

`mac-autostart/com.catalog.server.plist` is an optional `launchd` job. Replace
its example paths, then:

```bash
cp mac-autostart/com.catalog.server.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.catalog.server.plist
```

### Run it with Docker

`Dockerfile` and `docker-compose.yml` run the same app, on a NAS for
example, with `./data` mounted from the host:

```bash
docker compose up -d --build
```

To move an existing installation, copy its `data/` folder beside
`docker-compose.yml` before the first launch. The stack also runs
`cloudflared` for remote access (see below); remove that service if you
don't use Cloudflare Tunnel. The Compose file sets public DNS resolvers
because some NAS Docker DNS forwarders stall each lookup; replace them under
`dns` if your network requires specific resolvers.

### Remote access and security

Catalog has no login. Keep it off the open Internet and reach it remotely
through a VPN or an authenticating proxy that covers the whole hostname,
including the API and exports.

The Compose stack includes a `cloudflared` service for Cloudflare Tunnel.
Create a tunnel, put its token in `CLOUDFLARE_TUNNEL_TOKEN`, and point the
public hostname at `http://catalog:<PORT>` (`http://catalog:8000` by
default). Protect that hostname with a Cloudflare Access policy limited to
your own account, ideally with MFA, and enable the tunnel's **Protect with
Access** setting so `cloudflared` validates the Access token too.

---

## Features worth knowing

- **Hidden entries:** **Hide entry** in the Edit form keeps an entry out of
  the normal Ledger, Tracker, and Stats. Types listed in `HIDDEN_CATEGORIES`
  in `.env` (comma-separated) are hidden the same way. This is organization,
  not access control.
- **Tracking:** Shows linked to **TMDb (TV)** or **AniList** and Comics
  linked to **AniList** appear on the Tracker. A Comic can add a **Comick**
  chapter source for a more current latest chapter and an estimated next
  release.
- **Stash:** a place for titles you've noticed but haven't committed to yet.
  **Add to catalog** turns an item into a Planned entry and removes it from
  the Stash.
- **Groups:** a Group is one Ledger row for a collection or series. A
  **manual Group** holds entries from your catalog; **Act as a collection**
  instead lists every title a linked **TMDb (Collections)**, **Audible
  (Series)**, or **OpenLibrary (Series)** source reports, with its own status.
- **Backfilling:** with `ALLOW_CUSTOM_DATE_ADDED=True`, the Add form accepts a
  historical date added.
- **Keyboard:** on desktop, `/` focuses search, `n` adds an entry, and
  ⌘/Ctrl+Enter saves a Stash note.

---

## Title sources

| Source | Use | Key |
|---|---|---|
| TMDb (TV / Movies / All) | Shows, movies | Yes |
| AniList (Anime / Manga / All) | Anime, manga, manhwa, webtoons | No |
| OpenLibrary (Books) | Books | No |
| Audible (Audiobooks) | Audiobooks | No |
| Comick | Secondary comic chapter source | No |
| TMDb Collections, Audible Series, OpenLibrary Series | Groups only | TMDb key for Collections |

### Set up TMDb

1. Create a free account at [themoviedb.org](https://www.themoviedb.org) and
   request an API key in its settings.
2. Put the v3 key or v4 read token after `TMDB_API_KEY=` in `.env`.
3. Restart Catalog.

This product uses the TMDB API but is not endorsed or certified by TMDB.

---

## Configuration

`.env` holds `TMDB_API_KEY`, `PORT`, `CATALOG_BACKUP_DIR`,
`ALLOW_CUSTOM_DATE_ADDED`, and `HIDDEN_CATEGORIES`. Environment values
override the file. Docker Compose also reads `CLOUDFLARE_TUNNEL_TOKEN` for
the tunnel.

### Add a media category

A category that behaves like **Other** needs no schema change:

1. Add it to `TYPES` in `static/js/core/format.js`, and its plural to
   `TYPE_PLURALS` if it isn't just "+s".
2. Optionally give it a default search source in `TYPE_DEFAULT_SOURCE` in
   `catalog/providers/__init__.py`.
3. Restart Catalog.

It gets statuses, ratings, notes, free-text progress, and a repeat counter.
Tracker support or a new title source needs application code.

---

## Data safety

- `data/entries.json` holds only your own data, as a plain JSON array;
  `data/stash.json` holds the Stash the same way.
- Saves are atomic: a complete temporary file replaces the old one.
- Every change first copies the file into `data/backups/` (newest 20 of
  each), and `data/backups/daily/` keeps one snapshot a day for about two
  weeks. `CATALOG_BACKUP_DIR` moves both.
- An unreadable `entries.json` or `stash.json` is refused, never overwritten.
- Details, tracking data, and artwork are caches rebuilt from `entries.json`
  and the title sources.

**Export backup** in Settings downloads a copy identical to `entries.json`;
the Stash is not included. A fresh, empty installation offers **Load a
backup** to import one; details and artwork rebuild afterward.

---

## License

Catalog is released under the [MIT License](LICENSE). The bundled IBM Plex
and Courier Prime fonts are distributed under the SIL Open Font License 1.1
([static/fonts/OFL.txt](static/fonts/OFL.txt)).
