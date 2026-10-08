"""Outbound JSON requests, TMDb auth, and the ProviderError boundary."""
import functools
import http.client
import json
import urllib.error
import urllib.parse
import urllib.request

from ..config import FETCH_TIMEOUT, TMDB_API_KEY, TMDB_BASE, USER_AGENT

NO_KEY_MSG = "TMDb API key missing. Set TMDB_API_KEY in .env and restart the server."
BAD_KEY_MSG = "The search service rejected the API key — double-check TMDB_API_KEY in .env."
UNREACHABLE_MSG = "Couldn't reach the search service. Check the server's internet connection."
BAD_RESPONSE_MSG = "The search service sent an unexpected response. Try again shortly."


class ProviderError(Exception):
    """An upstream failure carrying a short, user-facing message.
    `http_status` is the upstream HTTP code when there was one."""

    def __init__(self, message, http_status=None):
        super().__init__(message)
        self.message = message
        self.http_status = http_status


def pathq(value):
    """Quote a value used as a URL PATH component. safe="" escapes '/' too, so
    a crafted stored id can't alter the request path."""
    return urllib.parse.quote(str(value), safe="")


def _request(url, method="GET", body=None, headers=None):
    req_headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    req_headers.update(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        exc.close()
        raise ProviderError(f"Search service error (HTTP {exc.code}). Try again shortly.",
                            exc.code) from None
    # URLError and timeouts are OSErrors; ValueError covers a malformed URL.
    except (OSError, http.client.HTTPException, ValueError):
        raise ProviderError(UNREACHABLE_MSG) from None
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError:  # JSONDecodeError and UnicodeDecodeError
        raise ProviderError(BAD_RESPONSE_MSG) from None


def get_json(url, headers=None):
    return _request(url, headers=headers)


def post_json(url, body, headers=None):
    return _request(url, method="POST", body=body, headers=headers)


def tmdb_get(path, params=None):
    """GET {TMDB_BASE}/3/{path}. Callers must pathq() any id inside `path`."""
    if not TMDB_API_KEY:
        raise ProviderError(NO_KEY_MSG)
    params = dict(params or {})
    headers = {}
    # TMDb accepts a short v3 key (query param) or a long v4 read token
    # (bearer header); detect which one was pasted.
    if TMDB_API_KEY.startswith("ey") and len(TMDB_API_KEY) > 60:
        headers["Authorization"] = f"Bearer {TMDB_API_KEY}"
    else:
        params["api_key"] = TMDB_API_KEY
    url = f"{TMDB_BASE}/3/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    try:
        return get_json(url, headers)
    except ProviderError as exc:
        if exc.http_status == 401:
            raise ProviderError(BAD_KEY_MSG, 401) from None
        raise


def guarded(func):
    """Public-boundary wrapper: an upstream payload of an unexpected shape
    surfaces as a ProviderError instead of an AttributeError/TypeError."""
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except ProviderError:
            raise
        except (AttributeError, TypeError, KeyError, IndexError) as exc:
            raise ProviderError(BAD_RESPONSE_MSG) from exc
    return wrapper
