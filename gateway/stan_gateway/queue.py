"""Транзакционная очередь: событие фиксируется на диске до HTTP-запроса."""

from dataclasses import dataclass
from datetime import datetime
import json
import logging
from pathlib import Path
import sqlite3
from threading import RLock

from .events import MAX_BODY_BYTES, MAX_EVENTS, json_bytes, make_body, now, validate_event


@dataclass(frozen=True)
class Batch:
    events: list[dict]
    body: bytes

    @property
    def ids(self):
        return [event["id"] for event in self.events]


class EventQueue:
    def __init__(self, path: Path, *, max_events=200_000, retention_days=30, clock=now):
        if max_events < 1 or retention_days <= 0:
            raise ValueError("Неверные лимиты очереди")
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.max_events, self.retention_days, self.clock = max_events, retention_days, clock
        self.lock = RLock()
        self.db = sqlite3.connect(self.path, timeout=15, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS queue (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, ts REAL NOT NULL, payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS queue_age ON queue(ts);
            CREATE INDEX IF NOT EXISTS queue_priority ON queue(type,ts);
            CREATE TABLE IF NOT EXISTS rejected (
                id TEXT PRIMARY KEY, type TEXT NOT NULL, ts REAL NOT NULL, payload TEXT NOT NULL,
                status INTEGER NOT NULL, response TEXT NOT NULL, rejected_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS rejected_age ON rejected(ts);
        """)
        removed = self.prune()
        if any(removed.values()):
            logging.getLogger("stan_gateway").warning(
                "Лимиты хранения при открытии: удалено старых %s, сверх лимита %s", removed["expired"], removed["overflow"]
            )

    def add(self, event):
        return self.add_many([event])

    def add_many(self, events):
        rows = []
        for event in events:
            validate_event(event)
            rows.append((event["id"], event["type"], datetime.fromisoformat(event["ts"]).timestamp(), json_bytes(event).decode("utf-8")))
        with self.lock, self.db:
            for row in rows:
                # Один UUID не должен вернуться в очередь после переноса в rejected.
                self.db.execute("INSERT OR IGNORE INTO queue(id,type,ts,payload) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM rejected WHERE id=?)", (*row, row[0]))
            return self._prune()

    def stats(self):
        with self.lock:
            return {table: self.db.execute(f"SELECT count(*) FROM {table}").fetchone()[0] for table in ("queue", "rejected")}

    def _prune(self):
        cutoff = self.clock().timestamp() - self.retention_days * 86400
        removed = {"expired": 0, "overflow": 0}
        for table in ("queue", "rejected"):
            removed["expired"] += self.db.execute(f"DELETE FROM {table} WHERE ts < ?", (cutoff,)).rowcount
        counts = self.stats()
        excess = counts["queue"] + counts["rejected"] - self.max_events
        if excess > 0:
            victims = self.db.execute("""
                SELECT origin,id FROM (
                    SELECT 'queue' AS origin,id,type,ts FROM queue
                    UNION ALL SELECT 'rejected' AS origin,id,type,ts FROM rejected
                ) ORDER BY CASE type WHEN 'signal' THEN 0 WHEN 'heartbeat' THEN 1 ELSE 2 END,ts,id
                LIMIT ?
            """, (excess,)).fetchall()
            for origin, event_id in victims:
                self.db.execute(f"DELETE FROM {origin} WHERE id=?", (event_id,))
            removed["overflow"] = len(victims)
        return removed

    def prune(self):
        with self.lock, self.db:
            return self._prune()

    def batch(self, gateway_id, *, max_events=MAX_EVENTS, max_bytes=MAX_BODY_BYTES, sent_at=None):
        if not 1 <= max_events <= MAX_EVENTS or not 1 <= max_bytes <= MAX_BODY_BYTES:
            raise ValueError("Лимиты пачки превышены")
        sent_at = sent_at or self.clock()
        with self.lock:
            rows = self.db.execute("SELECT payload FROM queue ORDER BY seq LIMIT ?", (max_events,)).fetchall()
        selected = []
        body = b""
        for (payload,) in rows:
            candidate = selected + [json.loads(payload)]
            encoded = make_body(gateway_id, candidate, sent_at)
            if len(encoded) > max_bytes:
                if not selected:
                    raise ValueError("Одиночное событие больше лимита пачки")
                break
            selected, body = candidate, encoded
        return Batch(selected, body)

    def acknowledge(self, ids):
        with self.lock, self.db:
            self.db.executemany("DELETE FROM queue WHERE id=?", ((value,) for value in ids))

    def reject(self, event_id, status, response):
        with self.lock, self.db:
            self.db.execute("""
                INSERT OR IGNORE INTO rejected(id,type,ts,payload,status,response,rejected_at)
                SELECT id,type,ts,payload,?,?,? FROM queue WHERE id=?
            """, (status, response, self.clock().isoformat(), event_id))
            self.db.execute("DELETE FROM queue WHERE id=?", (event_id,))

    def close(self):
        with self.lock:
            self.db.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
