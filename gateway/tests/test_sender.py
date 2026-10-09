import asyncio
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import ssl
from threading import Thread
import unittest
from unittest.mock import patch

from support import TempWorkspace, event
from stan_gateway.config import ServerConfig
from stan_gateway.logging_utils import Redactor
from stan_gateway.queue import EventQueue
from stan_gateway.sender import HttpResult, HttpTransport, Sender


class LocalServer:
    def __init__(self, statuses, response=None):
        self.statuses = deque(statuses)
        self.requests = []
        self.response = response
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                owner.requests.append((self.path, dict(self.headers), json.loads(body)))
                status = owner.statuses.popleft() if owner.statuses else 200
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                if status == 302:
                    self.send_header("Location", f"http://127.0.0.1:{self.server.server_port}/another")
                self.end_headers()
                response = owner.response or (b'{"accepted":1,"duplicates":0}' if status == 200 else b'{"message":"test failure"}')
                self.wfile.write(response)

            def log_message(self, *_):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/api/gateway/events"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class SenderTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = TempWorkspace()
        self.addCleanup(self.temp.close)
        self.queue = EventQueue(self.temp.path / "queue.db")
        self.addCleanup(self.queue.close)
        self.key_patch = patch.dict(os.environ, {"STAN_GATEWAY_KEY": "local-unittest-key"})
        self.key_patch.start()
        self.addCleanup(self.key_patch.stop)
        self.redactor = Redactor()

    def sender(self, statuses, **kwargs):
        server = LocalServer(statuses, kwargs.pop("response", None))
        self.addCleanup(server.close)
        return Sender(self.queue, ServerConfig(server.url, "test"), self.redactor, **kwargs), server

    async def test_http_200_deletes_only_acknowledged_batch(self):
        self.queue.add_many([event() for _ in range(101)])
        sender, server = self.sender([200])
        result = await sender.send_once()
        self.assertEqual(result.status, 200)
        self.assertEqual(self.queue.stats()["queue"], 1)
        path, headers, body = server.requests[0]
        self.assertEqual(path, "/api/gateway/events")
        self.assertEqual(headers["X-Gateway-Key"], "local-unittest-key")
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(body["gatewayId"], "test")
        self.assertEqual(len(body["events"]), 100)

    async def test_400_splits_and_preserves_singleton_in_rejected(self):
        saved = [event() for _ in range(3)]
        self.queue.add_many(saved)
        sender, server = self.sender([400, 200, 400, 400, 200])
        await sender.send_once()
        self.assertEqual([len(item[2]["events"]) for item in server.requests], [3, 1, 2, 1, 1])
        self.assertEqual(self.queue.stats(), {"queue": 0, "rejected": 1})
        row = self.queue.db.execute("SELECT id,status,response FROM rejected").fetchone()
        self.assertEqual(row[:2], (saved[1]["id"], 400))
        self.assertIn("test failure", row[2])
        self.assertIsNone(await sender.send_once())

    async def test_413_splits_and_rejects_singleton(self):
        self.queue.add_many([event(), event()])
        sender, server = self.sender([413, 200, 413])
        await sender.send_once()
        self.assertEqual([len(item[2]["events"]) for item in server.requests], [2, 1, 1])
        self.assertEqual(self.queue.stats(), {"queue": 0, "rejected": 1})
        self.assertEqual(self.queue.db.execute("SELECT status FROM rejected").fetchone()[0], 413)

    async def test_401_then_500_then_200_retries_with_same_uuid_and_pauses(self):
        saved = event()
        self.queue.add(saved)
        stop, pauses = asyncio.Event(), []

        async def sleep(seconds):
            pauses.append(seconds)
            if len(pauses) == 3:
                stop.set()

        sender, server = self.sender([401, 500, 200], sleep=sleep)
        await sender.run(stop)
        self.assertEqual(pauses, [5, 10, 0])
        self.assertEqual([item[2]["events"][0]["id"] for item in server.requests], [saved["id"]] * 3)
        self.assertEqual(self.queue.stats()["queue"], 0)
        self.assertEqual(sender.delay, 5)

    async def test_retry_backoff_capped_at_five_minutes(self):
        self.queue.add(event())
        stop, pauses = asyncio.Event(), []

        async def sleep(seconds):
            pauses.append(seconds)
            if len(pauses) == 8:
                stop.set()

        sender, _ = self.sender([500] * 8, sleep=sleep)
        await sender.run(stop)
        self.assertEqual(pauses, [5, 10, 20, 40, 80, 160, 300, 300])
        self.assertEqual(self.queue.stats()["queue"], 1)

    async def test_429_preserves_queue(self):
        self.queue.add(event())
        sender, _ = self.sender([429])
        self.assertTrue((await sender.send_once()).retry)
        self.assertEqual(self.queue.stats()["queue"], 1)

    async def test_network_error_is_retryable(self):
        class Offline:
            def post(self, body):
                return HttpResult(None, "сеть недоступна")

        self.queue.add(event())
        sender = Sender(self.queue, ServerConfig(), self.redactor, transport=Offline())
        self.assertTrue((await sender.send_once()).retry)
        self.assertEqual(self.queue.stats()["queue"], 1)

    async def test_retry_during_split_keeps_only_unacknowledged_events(self):
        saved = [event(), event()]
        self.queue.add_many(saved)
        sender, _ = self.sender([400, 200, 401, 200])
        self.assertTrue((await sender.send_once()).retry)
        self.assertEqual(self.queue.batch("test").ids, [saved[1]["id"]])
        await sender.send_once()
        self.assertEqual(self.queue.stats()["queue"], 0)

    async def test_server_echo_cannot_expose_key_in_rejected(self):
        self.queue.add(event())
        sender, _ = self.sender([400], response=b'{"message":"local-unittest-key"}')
        await sender.send_once()
        response = self.queue.db.execute("SELECT response FROM rejected").fetchone()[0]
        self.assertNotIn("local-unittest-key", response)
        self.assertIn("[скрыто]", response)

    async def test_redirect_is_not_followed(self):
        self.queue.add(event())
        sender, server = self.sender([302, 200])
        result = await sender.send_once()
        self.assertEqual(result.status, 302)
        self.assertEqual(len(server.requests), 1)
        self.assertEqual(self.queue.stats()["queue"], 1)

    async def test_missing_key_does_not_send_or_drop_event(self):
        self.queue.add(event())
        sender, server = self.sender([200])
        with patch.dict(os.environ, {"STAN_GATEWAY_KEY": ""}):
            self.assertIsNone((await sender.send_once()).status)
        self.assertEqual(server.requests, [])
        self.assertEqual(self.queue.stats()["queue"], 1)

    async def test_malformed_header_key_cannot_leak_in_error(self):
        self.queue.add(event())
        sender, server = self.sender([200])
        key_file = self.temp.path / "malformed.key"
        sender.transport.config = ServerConfig(server.url, "test", key_file)
        for value in ("synthetic\x00key", "synthetic非key"):
            key_file.write_text(value, encoding="utf-8")
            with patch.dict(os.environ, {"STAN_GATEWAY_KEY": ""}):
                result = await sender.send_once()
            self.assertIsNone(result.status)
            self.assertNotIn(value, result.text)
            self.assertNotIn(repr(value)[1:-1], result.text)
        self.assertEqual(server.requests, [])
        self.assertEqual(self.queue.stats()["queue"], 1)

    def test_https_uses_certificate_verification(self):
        transport = HttpTransport(ServerConfig(), self.redactor)
        handler = next(item for item in transport.opener.handlers if isinstance(item, __import__("urllib.request", fromlist=["HTTPSHandler"]).HTTPSHandler))
        self.assertTrue(handler._context.check_hostname)
        self.assertEqual(handler._context.verify_mode, ssl.CERT_REQUIRED)
