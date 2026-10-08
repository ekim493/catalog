import re
from datetime import date, datetime, timezone

UUID4_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def is_uuid4(value):
    return isinstance(value, str) and bool(UUID4_RE.match(value))


def utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def today():
    """The server's local calendar date. Clients send their own local date
    for completions; this is only the fallback."""
    return date.today().isoformat()


def parse_iso(value):
    """Timestamp or bare date -> timezone-aware datetime (bare dates are UTC),
    or None. Never returns a naive datetime, so arithmetic against now() is safe."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def age_seconds(value):
    dt = parse_iso(value)
    return None if dt is None else (datetime.now(timezone.utc) - dt).total_seconds()
