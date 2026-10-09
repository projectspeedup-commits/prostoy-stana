from datetime import timedelta
import json
import unittest

from support import TempWorkspace, event
from stan_gateway.events import now
from stan_gateway.queue import EventQueue


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = TempWorkspace()
        self.addCleanup(self.temp.close)
        self.queue = EventQueue(self.temp.path / "queue.db")
        self.addCleanup(lambda: self.queue.close() if self.queue else None)

    def test_wal_and_survives_restart(self):
        saved = event()
        self.queue.add(saved)
        self.assertEqual(self.queue.db.execute("PRAGMA journal_mode").fetchone()[0], "wal")
        self.queue.close()
        self.queue = EventQueue(self.temp.path / "queue.db")
        self.assertEqual(self.queue.batch("test").events, [saved])

    def test_uuid_is_stable_and_duplicate_insert_is_ignored(self):
        saved = event()
        self.queue.add(saved)
        self.queue.add(saved)
        self.assertEqual(self.queue.stats()["queue"], 1)
        self.assertEqual(self.queue.batch("test").events[0]["id"], saved["id"])

    def test_batch_count_and_acknowledge(self):
        self.queue.add_many([event() for _ in range(105)])
        batch = self.queue.batch("test")
        self.assertEqual(len(batch.events), 100)
        self.queue.acknowledge(batch.ids)
        self.assertEqual(self.queue.stats()["queue"], 5)

    def test_batch_bytes_include_envelope_and_utf8(self):
        self.queue.add_many([event(tag="🙂" * 128, quality="🙂" * 32) for _ in range(100)])
        batch = self.queue.batch("test")
        self.assertLess(len(batch.events), 100)
        self.assertLessEqual(len(batch.body), 60 * 1024)
        self.assertEqual(json.loads(batch.body)["events"], batch.events)
        exact = self.queue.batch("test", max_events=1).body
        self.assertEqual(len(self.queue.batch("test", max_bytes=len(exact)).events), 1)

    def test_rejected_is_atomic_and_survives_restart(self):
        saved = event()
        self.queue.add(saved)
        self.queue.reject(saved["id"], 400, "Плохое событие")
        self.queue.add(saved)
        self.queue.close()
        self.queue = EventQueue(self.temp.path / "queue.db")
        self.assertEqual(self.queue.stats(), {"queue": 0, "rejected": 1})
        row = self.queue.db.execute("SELECT payload,status,response FROM rejected").fetchone()
        self.assertEqual(json.loads(row[0]), saved)
        self.assertEqual(row[1:], (400, "Плохое событие"))

    def test_overflow_drops_signals_then_heartbeats_then_critical(self):
        self.queue.max_events = 3
        when = now()
        critical = [event("billet_out", when - timedelta(minutes=10)), event("mill_state", when - timedelta(minutes=9)),
                    event("source_state", when - timedelta(minutes=8))]
        self.queue.add_many(critical + [event("heartbeat", when - timedelta(minutes=7)), event(when=when)])
        self.assertEqual({value["id"] for value in self.queue.batch("test").events}, {value["id"] for value in critical})
        latest = event("billet_out", when)
        self.queue.add(latest)
        remaining = self.queue.batch("test").ids
        self.assertNotIn(critical[0]["id"], remaining)
        self.assertIn(latest["id"], remaining)

    def test_oldest_signal_is_evicted_first(self):
        self.queue.max_events = 2
        old, recent = event(when=now() - timedelta(minutes=1)), event()
        self.queue.add_many([old, recent, event("billet_out")])
        self.assertNotIn(old["id"], self.queue.batch("test").ids)
        self.assertIn(recent["id"], self.queue.batch("test").ids)

    def test_retention_includes_rejected_and_critical(self):
        when = now()
        old = event("billet_out", when - timedelta(days=29))
        self.queue.add(old)
        self.queue.reject(old["id"], 400, "Тест")
        self.queue.add(event("source_state", when - timedelta(days=31)))
        self.assertEqual(self.queue.stats(), {"queue": 0, "rejected": 1})
        self.queue.clock = lambda: when + timedelta(days=2)
        self.queue.prune()
        self.assertEqual(self.queue.stats(), {"queue": 0, "rejected": 0})

    def test_rejected_counts_toward_size_limit(self):
        self.queue.max_events = 2
        saved = event()
        self.queue.add(saved)
        self.queue.reject(saved["id"], 400, "Тест")
        self.queue.add_many([event("billet_out"), event("mill_state")])
        self.assertEqual(self.queue.stats(), {"queue": 2, "rejected": 0})

    def test_invalid_event_never_partially_inserts_batch(self):
        invalid = event()
        invalid["data"]["value"] = float("nan")
        with self.assertRaises(ValueError):
            self.queue.add_many([event(), invalid])
        self.assertEqual(self.queue.stats()["queue"], 0)
