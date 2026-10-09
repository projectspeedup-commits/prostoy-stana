import asyncio
from pathlib import Path
import socket
import subprocess
import sys
import unittest

from support import GATEWAY, TempWorkspace
from test_sender import LocalServer
from stan_gateway.queue import EventQueue


CHILD = """
import signal, sys, threading
from stan_gateway.__main__ import main
def stop_from_stdin():
    sys.stdin.readline()
    signal.raise_signal(signal.SIGINT)
threading.Thread(target=stop_from_stdin, daemon=True).start()
sys.exit(main(sys.argv[1:]))
"""


class CliTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = TempWorkspace()
        self.addCleanup(self.temp.close)
        self.config_path = self.temp.path / "config.toml"

    def write_config(self, source="simulator", url="http://127.0.0.1:8080/api/gateway/events", port=4862):
        key_path = self.temp.path / "synthetic.key"
        key_path.write_text("local-unittest-key", encoding="utf-8")
        text = (GATEWAY / "config.example.toml").read_text(encoding="utf-8")
        text = text.replace('source = "simulator"', f'source = "{source}"')
        text = text.replace("http://127.0.0.1:8080/api/gateway/events", url)
        text = text.replace("opc.tcp://127.0.0.1:4862", f"opc.tcp://127.0.0.1:{port}")
        text = text.replace('[server]', '[server]\nkey_file = "synthetic.key"')
        self.config_path.write_text(text, encoding="utf-8")

    async def command(self, name):
        return await asyncio.to_thread(subprocess.run, [sys.executable, "-m", "stan_gateway", name, "--config", str(self.config_path)],
                                       cwd=GATEWAY, capture_output=True, encoding="utf-8", errors="replace", timeout=20,
                                       env=self.child_env())

    @staticmethod
    def child_env():
        import os
        return {**os.environ, "STAN_GATEWAY_KEY": "local-unittest-key", "PYTHONIOENCODING": "utf-8"}

    def child(self, name, *extra):
        process = subprocess.Popen([sys.executable, "-c", CHILD, name, "--config", str(self.config_path), *extra],
                                   cwd=GATEWAY, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   encoding="utf-8", errors="replace", env=self.child_env())

        def cleanup():
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()

        self.addCleanup(cleanup)
        return process

    async def stop_child(self, child):
        child.stdin.write("stop\n")
        child.stdin.flush()
        await asyncio.to_thread(child.wait, timeout=10)
        self.assertEqual(child.returncode, 0, child.stderr.read())

    async def test_check_is_read_only_and_queue_stats(self):
        self.write_config()
        result = await self.command("check")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Качество", result.stdout)
        self.assertIn("Good", result.stdout)
        self.assertFalse((self.temp.path / "data" / "queue.db").exists())
        result = await self.command("queue-stats")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Очередь: 0", result.stdout)
        self.assertIn("rejected): 0", result.stdout)

    async def test_send_test_one_heartbeat_and_rejected_response(self):
        server = LocalServer([200, 400])
        self.addCleanup(server.close)
        self.write_config(url=server.url)
        result = await self.command("send-test")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("HTTP 200", result.stdout)
        result = await self.command("send-test")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("HTTP 400", result.stdout)
        self.assertEqual([len(item[2]["events"]) for item in server.requests], [1, 1])
        self.assertTrue(all(item[2]["events"][0]["type"] == "heartbeat" for item in server.requests))
        with EventQueue(self.temp.path / "data" / "queue.db") as queue:
            self.assertEqual(queue.stats(), {"queue": 0, "rejected": 1})

    async def test_actual_simulate_server_command_and_opcua_check(self):
        with socket.socket() as socket_:
            socket_.bind(("127.0.0.1", 0))
            port = socket_.getsockname()[1]
        self.write_config(source="opcua", port=port)
        child = self.child("simulate-server", "--port", str(port), "--speed", "100")
        line = await asyncio.wait_for(asyncio.to_thread(child.stdout.readline), timeout=20)
        self.assertIn("Имитатор запущен", line, line + child.stderr.read() if not line else line)
        result = await self.command("check")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.count("Good"), 2)
        await self.stop_child(child)

    async def test_actual_run_sigint_saves_queue_and_closes_cleanly(self):
        server = LocalServer([200])
        self.addCleanup(server.close)
        self.write_config(url=server.url)
        child = self.child("run")
        for _ in range(400):
            if server.requests or child.poll() is not None:
                break
            await asyncio.sleep(0.02)
        self.assertTrue(server.requests)
        await self.stop_child(child)
        path = self.temp.path / "data"
        log = (path / "logs" / "gateway.log").read_text(encoding="utf-8")
        self.assertIn("Шлюз остановлен; очередь сохранена", log)
        self.assertNotIn("local-unittest-key", log)
        with EventQueue(path / "queue.db") as queue:
            self.assertEqual(queue.db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            events = queue.batch("test").events
            self.assertTrue(any(value["type"] == "source_state" and value["data"]["connected"] is False for value in events))
