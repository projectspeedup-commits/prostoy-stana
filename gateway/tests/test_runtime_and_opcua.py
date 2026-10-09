import asyncio
from dataclasses import replace
from datetime import timedelta
import json
import socket
import unittest
from unittest.mock import patch

from support import TempWorkspace, config
from stan_gateway.config import MillConfig, OpcUaConfig
from stan_gateway.events import now
from stan_gateway.logging_utils import Redactor
from stan_gateway.queue import EventQueue
from stan_gateway.runtime import Gateway
from stan_gateway.simulator import SimulatorServer, SimulatorSource
from stan_gateway.sources import Reading
from stan_gateway.sources.opcua import OpcUaSource


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = TempWorkspace()
        self.addCleanup(self.temp.close)
        self.queue = EventQueue(self.temp.path / "queue.db")
        self.addCleanup(self.queue.close)
        self.config = config(self.temp.path)
        self.redactor = Redactor()

    def readings(self, sensor, status=4, quality="Good"):
        return {self.config.billet.sensor_tag: Reading(sensor, quality), self.config.billet.status_tag: Reading(status, quality)}

    def test_connection_changes_initial_signals_and_bad_quality(self):
        gateway = Gateway(self.config, None, self.queue, self.redactor)
        when = now()
        gateway.source_state(True, when)
        gateway.source_state(True, when)
        gateway.observe(self.readings(False), 0, when)
        gateway.observe(self.readings(True), 1, when)
        gateway.observe(self.readings(False, quality="Bad"), 1000, when)
        gateway.source_state(False, when, "таймаут")
        gateway.source_state(False, when, "таймаут повторно")
        gateway.source_state(True, when)
        gateway.observe(self.readings(True), 2000, when)
        values = self.queue.batch("test").events
        self.assertEqual([value["data"]["connected"] for value in values if value["type"] == "source_state"], [True, False, True])
        self.assertEqual(sum(value["type"] == "billet_out" for value in values), 1)
        self.assertEqual([value["data"]["state"] for value in values if value["type"] == "mill_state"], ["running"])
        self.assertEqual(sum(value["type"] == "signal" for value in values), 5)

    def test_source_errors_are_redacted(self):
        self.redactor.add("synthetic-secret")
        gateway = Gateway(self.config, None, self.queue, self.redactor)
        gateway.source_state(False, now(), "error synthetic-secret")
        self.assertNotIn("synthetic-secret", self.queue.batch("test").events[0]["data"]["error"])

    async def test_reconnect_backoff_5_to_60_seconds_without_real_sleep(self):
        class Offline:
            attempts = 0
            closed = 0

            async def connect(self):
                self.attempts += 1
                raise ConnectionError("нет связи")

            async def disconnect(self):
                self.closed += 1

        clock, stop, attempts_at = [0.0], asyncio.Event(), []
        source = Offline()
        original = source.connect

        async def connect():
            attempts_at.append(clock[0])
            if len(attempts_at) == 7:
                stop.set()
            await original()

        source.connect = connect

        async def sleep(_stop, seconds):
            clock[0] += seconds

        with patch("stan_gateway.runtime.interruptible_sleep", sleep):
            await Gateway(self.config, source, self.queue, self.redactor, clock=lambda: clock[0]).run(stop)
        self.assertEqual([second - first for first, second in zip(attempts_at, attempts_at[1:])], [5, 10, 20, 40, 60, 60])
        values = self.queue.batch("test").events
        self.assertEqual(sum(value["type"] == "source_state" for value in values), 1)
        self.assertEqual(sum(value["type"] == "heartbeat" for value in values), 4)
        self.assertGreaterEqual(source.closed, 7)

    async def test_heartbeat_each_60_seconds_and_shutdown_closes_source(self):
        clock, stop = [0.0], asyncio.Event()
        source = SimulatorSource(self.config, clock=lambda: clock[0])

        async def sleep(_stop, seconds):
            clock[0] += seconds
            if clock[0] >= 121:
                stop.set()

        with patch("stan_gateway.runtime.interruptible_sleep", sleep):
            await Gateway(self.config, source, self.queue, self.redactor, clock=lambda: clock[0]).run(stop)
        values = self.queue.batch("test").events
        self.assertEqual([value["data"]["uptimeSec"] for value in values if value["type"] == "heartbeat"], [0, 60, 120])
        self.assertFalse(source.connected)

    async def test_opcua_simulator_end_to_end_events_and_read_only_nodes(self):
        from asyncua import ua
        asyncio.get_running_loop().set_debug(False)
        with socket.socket() as socket_:
            socket_.bind(("127.0.0.1", 0))
            port = socket_.getsockname()[1]
        loaded = replace(self.config, source="opcua", opcua=OpcUaConfig(url=f"opc.tcp://127.0.0.1:{port}"))
        async with SimulatorServer(loaded, port, speed=100, stop_probability=0):
            source = OpcUaSource(loaded.opcua, loaded.tags, self.redactor)
            await source.connect()
            try:
                readings = await source.read()
                self.assertTrue(all(value.good for value in readings.values()))
                levels = await source.client.read_attributes(source.nodes, ua.AttributeIds.AccessLevel)
                for level in levels:
                    self.assertEqual(level.Value.Value & 3, 1)  # CurrentRead=1, CurrentWrite=2.
            finally:
                await source.disconnect()
            stop = asyncio.Event()

            async def finish():
                await asyncio.sleep(2.1)
                stop.set()

            finish_task = asyncio.create_task(finish())
            await Gateway(loaded, source, self.queue, self.redactor, poll_interval=0.005).run(stop)
            await finish_task
            self.assertIsNone(source.client)
        values = [json.loads(row[0]) for row in self.queue.db.execute("SELECT payload FROM queue ORDER BY seq")]
        self.assertGreaterEqual(sum(value["type"] == "billet_out" for value in values), 2)
        states = [value["data"]["state"] for value in values if value["type"] == "mill_state"]
        self.assertIn("running", states)
        self.assertIn("stopped", states)
        self.assertNotIn("unknown", states)
        self.assertTrue(all(value["ts"].endswith("+03:00") for value in values))
