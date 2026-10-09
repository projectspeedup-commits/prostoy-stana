import unittest

from support import event
from stan_gateway.config import Tag
from stan_gateway.events import now
from stan_gateway.rules import BilletOutRule, NoBilletRule, SignalWatch
from stan_gateway.sources import Reading


class BilletTests(unittest.TestCase):
    def test_one_event_per_rising_edge(self):
        rule = BilletOutRule()
        self.assertFalse(rule.update(False, 4, 0))
        self.assertTrue(rule.update(True, 4, 1))
        self.assertFalse(rule.update(True, 4, 2))
        self.assertFalse(rule.update(False, 4, 3))
        self.assertTrue(rule.update(True, 4, 4))

    def test_status_changes_without_sensor(self):
        rule = BilletOutRule()
        for index, status in enumerate((0, 4, 5, 4)):
            self.assertFalse(rule.update(False, status, index))

    def test_status_edge_with_sensor(self):
        rule = BilletOutRule()
        rule.update(True, 0, 0)
        self.assertTrue(rule.update(True, 4, 1))

    def test_bounce_on_rising_and_falling_edges(self):
        rule = BilletOutRule(debounce_seconds=0.2)
        rule.update(False, 4, 0)
        self.assertFalse(rule.update(True, 4, 1))
        self.assertFalse(rule.update(False, 4, 1.1))
        self.assertFalse(rule.update(True, 4, 2))
        self.assertTrue(rule.update(True, 4, 2.3))
        self.assertFalse(rule.update(False, 4, 3))
        self.assertFalse(rule.update(True, 4, 3.1))
        self.assertFalse(rule.update(True, 4, 4))
        rule.update(False, 4, 5)
        rule.update(False, 4, 5.3)
        rule.update(True, 4, 6)
        self.assertTrue(rule.update(True, 4, 6.3))

    def test_active_initial_sample_and_reconnect_are_baselines(self):
        rule = BilletOutRule()
        self.assertFalse(rule.update(True, 4, 0))
        rule.reset()
        self.assertFalse(rule.update(True, 4, 10))

    def test_configured_status(self):
        rule = BilletOutRule(status_value=7)
        rule.update(False, 0, 0)
        self.assertFalse(rule.update(True, 4, 1))
        self.assertTrue(rule.update(True, 7, 2))


class MillTests(unittest.TestCase):
    def test_unknown_after_start_and_restart(self):
        rule = NoBilletRule()
        self.assertEqual(rule.state, "unknown")
        self.assertIsNone(rule.update(100))
        rule.update(101, billet=True)
        self.assertEqual(NoBilletRule().state, "unknown")

    def test_timeout_exactly_n_minutes_and_transitions(self):
        rule = NoBilletRule(minutes=8)
        self.assertEqual(rule.update(100, billet=True), "running")
        self.assertIsNone(rule.update(579.99))
        self.assertEqual(rule.update(580), "stopped")
        self.assertIsNone(rule.update(900))
        self.assertEqual(rule.update(901, billet=True), "running")
        self.assertIsNone(rule.update(902, billet=True))
        self.assertIsNone(rule.update(1381))
        self.assertEqual(rule.update(1382), "stopped")

    def test_no_billet_since_first_valid_sample(self):
        rule = NoBilletRule(minutes=1)
        self.assertIsNone(rule.update(10))
        self.assertEqual(rule.update(70), "stopped")

    def test_disconnect_and_bad_quality_suspend_timer(self):
        rule = NoBilletRule(minutes=1)
        rule.update(0, billet=True)
        self.assertIsNone(rule.update(1000, valid=False))
        self.assertIsNone(rule.update(2000))
        self.assertIsNone(rule.update(2059))
        self.assertEqual(rule.update(2060), "stopped")


class WatchTests(unittest.TestCase):
    def test_initial_boolean_and_reconnect(self):
        watch = SignalWatch((Tag("b"),))
        readings = {"b": Reading(False)}
        self.assertEqual(len(watch.events(readings, now())), 1)
        self.assertEqual(watch.events(readings, now()), [])
        self.assertEqual(len(watch.events({"b": Reading(True)}, now())), 1)
        watch.reset()
        self.assertEqual(len(watch.events(readings, now())), 1)

    def test_deadband_uses_last_emitted_value_and_strict_threshold(self):
        watch = SignalWatch((Tag("n", "real", deadband=2),))
        self.assertEqual(len(watch.events({"n": Reading(10.0)}, now())), 1)
        for value in (11.0, 12.0):
            self.assertEqual(watch.events({"n": Reading(value)}, now()), [])
        self.assertEqual(len(watch.events({"n": Reading(12.1)}, now())), 1)

    def test_bad_quality_and_watch_false(self):
        watch = SignalWatch((Tag("b"), Tag("hidden", watch=False)))
        self.assertEqual(len(watch.events({"b": Reading(False), "hidden": Reading(True)}, now())), 1)
        self.assertEqual(watch.events({"b": Reading(True, "Bad"), "hidden": Reading(True)}, now()), [])
        self.assertEqual(len(watch.events({"b": Reading(False), "hidden": Reading(True)}, now())), 1)
