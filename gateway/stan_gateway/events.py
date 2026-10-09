"""События и точный размер JSON по CONTRACT.md."""

from datetime import datetime, timedelta, timezone
import json
import math
import re
import uuid

MOSCOW = timezone(timedelta(hours=3))
MAX_EVENTS = 100
MAX_BODY_BYTES = 60 * 1024
MAX_DATA_BYTES = 2 * 1024


def now() -> datetime:
    return datetime.now(MOSCOW)


def timestamp(value: datetime) -> str:
    if value.utcoffset() is None:
        raise ValueError("Время должно содержать смещение UTC")
    return value.isoformat(timespec="milliseconds")


def json_bytes(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _int(value, minimum, maximum=None):
    return type(value) is int and value >= minimum and (maximum is None or value <= maximum)


def _str(value, maximum):
    return isinstance(value, str) and len(value) <= maximum


def validate_event(event: dict):
    if not isinstance(event, dict) or set(event) != {"id", "type", "ts", "data"}:
        raise ValueError("Неверные поля события")
    uuid.UUID(event["id"])
    when = datetime.fromisoformat(event["ts"])
    if when.utcoffset() is None:
        raise ValueError("ts должен содержать смещение UTC")
    kind, data = event["type"], event["data"]
    if not isinstance(data, dict) or len(json_bytes(data)) > MAX_DATA_BYTES:
        raise ValueError("data должен быть объектом не больше 2 КБ")
    required = {
        "heartbeat": {"source", "connected", "uptimeSec", "queue", "version"},
        "signal": {"tag", "value"}, "billet_out": {"count"},
        "mill_state": {"state", "rule"}, "source_state": {"connected"},
    }
    optional = {"signal": {"quality"}, "source_state": {"error"}}
    if kind not in required or not required[kind] <= set(data) or set(data) - required[kind] - optional.get(kind, set()):
        raise ValueError("Неверные поля data")
    valid = True
    if kind == "heartbeat":
        valid = (data["source"] in ("opcua", "s7", "simulator") and type(data["connected"]) is bool
                 and _int(data["uptimeSec"], 0) and _int(data["queue"], 0) and _str(data["version"], 32))
    elif kind == "signal":
        value = data["value"]
        valid = (_str(data["tag"], 128) and type(value) in (bool, int, float)
                 and (type(value) is not float or math.isfinite(value))
                 and ("quality" not in data or _str(data["quality"], 32)))
    elif kind == "billet_out":
        valid = _int(data["count"], 1, 100)
    elif kind == "mill_state":
        valid = data["state"] in ("running", "stopped") and _str(data["rule"], 64)
    elif kind == "source_state":
        valid = type(data["connected"]) is bool and ("error" not in data or _str(data["error"], 500))
    if not valid:
        raise ValueError("Тип или значение события не соответствует CONTRACT.md")


def make_event(kind: str, data: dict, when: datetime | None = None) -> dict:
    event = {"id": str(uuid.uuid4()), "type": kind, "ts": timestamp(when or now()), "data": data}
    validate_event(event)
    return event


def make_body(gateway_id: str, events: list[dict], sent_at: datetime | None = None) -> bytes:
    if not re.fullmatch(r"[a-z0-9_-]{1,32}", gateway_id) or not 1 <= len(events) <= MAX_EVENTS:
        raise ValueError("Неверный gatewayId или размер пачки")
    return json_bytes({"gatewayId": gateway_id, "sentAt": timestamp(sent_at or now()), "events": events})
