"""HTTP plumbing: routing, JSON bodies, errors, and static files."""
import json
import os
import re
import sys
import traceback
from email.utils import formatdate, parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import config, model, providers
from .storage import CorruptDataError

MAX_BODY = 1024 * 1024
MAX_IMPORT_BODY = 25 * 1024 * 1024
_ROUTES = []


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Raw:
    """A non-JSON response body (e.g. the export download)."""

    def __init__(self, body, ctype, headers=None):
        self.body, self.ctype, self.headers = body, ctype, headers or {}


def route(method, pattern):
    def register(fn):
        _ROUTES.append((method, re.compile(f"^{pattern}$"), fn))
        return fn
    return register


def _reject_constant(name):
    raise ValueError(f"{name} is not valid JSON")


class Request:
    def __init__(self, handler, method, path, query, params):
        self.handler = handler
        self.method = method
        self.path = path
        self.params = params
        self._query = query

    def arg(self, name, default=""):
        return (self._query.get(name, [default])[0] or default).strip()

    def json(self, expect=dict, limit=MAX_BODY):
        try:
            length = int(self.handler.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0 or length > limit:
            raise ApiError(400, "Request body is missing or too large")
        if length == 0:
            return expect()
        try:
            data = json.loads(self.handler.rfile.read(length).decode("utf-8"), parse_constant=_reject_constant)
        except (UnicodeDecodeError, ValueError):
            raise ApiError(400, "Body was not valid JSON")
        if not isinstance(data, expect):
            raise ApiError(400, f"Body must be a JSON {'array' if expect is list else 'object'}")
        return data


_CTYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
           ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
           ".woff2": "font/woff2", ".webmanifest": "application/manifest+json",
           ".jpg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".json": "application/json"}


class Handler(BaseHTTPRequestHandler):
    server_version = f"Catalog/{config.APP_VERSION}"
    timeout = 30

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # -- dispatch ---------------------------------------------------------

    def _dispatch(self, method):
        parsed = urlparse(self.path)
        path = parsed.path
        if method == "GET" and not path.startswith("/api/"):
            try:
                return self._serve_static(path)
            except (OSError, ValueError):
                return self.send_error(404)
        try:
            if method != "GET":
                self._mutation_guard()
            for route_method, pattern, fn in _ROUTES:
                match = pattern.match(path)
                if match and route_method == method:
                    result = fn(Request(self, method, path, parse_qs(parsed.query), match.groups()))
                    return self._send_result(result)
            raise ApiError(404, "Not found")
        except ApiError as e:
            self._send_json({"error": e.message}, e.status)
        except model.ValidationError as e:
            self._send_json({"error": str(e)}, 400)
        except providers.ProviderError as e:
            self._send_json({"error": str(e)}, 502)
        except CorruptDataError as e:
            self._send_json({"error": e.message}, 500)
        except OSError as e:
            traceback.print_exc()
            self._send_json({"error": f"Could not access the data folder: {e.strerror or e}"}, 500)
        except Exception:
            traceback.print_exc()
            self._send_json({"error": "Unexpected server error."}, 500)

    def _mutation_guard(self):
        """Basic CSRF hardening for a server listening on the LAN: reject a
        foreign (or opaque "null") Origin, and require application/json for
        bodies so a cross-site "simple" form post can't reach a mutation."""
        origin = self.headers.get("Origin")
        if origin is not None:
            try:
                host = urlparse(origin).netloc if origin != "null" else ""
            except ValueError:
                host = ""
            if not host or host != self.headers.get("Host"):
                raise ApiError(403, "Cross-origin request rejected.")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if length > 0 and ctype != "application/json":
            raise ApiError(415, "Mutation requests must use application/json.")

    # -- responses --------------------------------------------------------

    def _send_result(self, result):
        if isinstance(result, Raw):
            return self._send_bytes(result.body, result.ctype, result.headers)
        status, body = result if isinstance(result, tuple) else (200, result)
        self._send_json(body, status)

    def _send_json(self, obj, status=200):
        self._send_bytes(json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                         "application/json; charset=utf-8", status=status)

    def _send_bytes(self, body, ctype, headers=None, status=200):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _serve_file(self, file_path, cache_control):
        try:
            if not os.path.isfile(file_path):
                return self.send_error(404)
            mtime = os.path.getmtime(file_path)
        except (OSError, ValueError):
            return self.send_error(404)
        last_modified = formatdate(mtime, usegmt=True)
        since = self.headers.get("If-Modified-Since")
        if since:
            try:
                if parsedate_to_datetime(since).timestamp() >= int(mtime):
                    self.send_response(304)
                    self.send_header("Cache-Control", cache_control)
                    self.send_header("Last-Modified", last_modified)
                    return self.end_headers()
            except (TypeError, ValueError):
                pass
        with open(file_path, "rb") as f:
            body = f.read()
        ctype = _CTYPES.get(os.path.splitext(file_path)[1].lower(), "application/octet-stream")
        self._send_bytes(body, ctype, {"Cache-Control": cache_control, "Last-Modified": last_modified})

    def _serve_static(self, path):
        if path.startswith("/posters/"):
            # Poster URLs carry a version query, so they can be cached hard.
            name = os.path.basename(path)
            return self._serve_file(os.path.join(config.POSTER_DIR, name), "max-age=604800")
        root = os.path.abspath(config.STATIC_DIR)
        target = os.path.abspath(os.path.join(root, path.lstrip("/") or "index.html"))
        if os.path.commonpath([root, target]) != root:
            return self.send_error(403)
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        # no-cache = always revalidate, so app updates show up immediately.
        self._serve_file(target, "no-cache")


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # Prevent poster burst load from failing
    request_queue_size = 128

    def handle_error(self, request, client_address):
        # A phone locking or a PWA being closed mid-request is routine.
        if sys.exc_info()[0] in (ConnectionResetError, BrokenPipeError, TimeoutError):
            return
        super().handle_error(request, client_address)
