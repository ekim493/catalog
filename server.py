#!/usr/bin/env python3
"""Catalog — a self-hosted tracker for everything you watch, read and listen to.

Python standard library only. Run `python3 server.py [port]`; settings live
in .env (see .env.example). The application code is in catalog/."""
import signal
import sys

from catalog import assets, config, routes, storage  # noqa: F401 (routes registers endpoints)
from catalog.web import Handler, Server


def _stop(signum, frame):
    # As a container's PID 1, Python would otherwise ignore `docker stop`.
    raise KeyboardInterrupt


def main():
    storage.ensure_storage()
    assets.start_restore()
    port = config.port(sys.argv)
    httpd = Server(("0.0.0.0", port), Handler)
    print(f"Catalog v{config.APP_VERSION} on http://localhost:{port}")
    print(f"  Data folder: {config.DATA_DIR}")
    if not config.TMDB_API_KEY:
        print("  Note: TMDB_API_KEY is not set, so Show/Movie search is disabled.")
    signal.signal(signal.SIGTERM, _stop)
    try:
        httpd.serve_forever(poll_interval=5)
    except KeyboardInterrupt:
        print("\nShutting down.")
        httpd.server_close()


if __name__ == "__main__":
    main()
