import ast
from dataclasses import replace
from datetime import datetime
from io import StringIO
import logging
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from support import GATEWAY, TempWorkspace, config, event
from stan_gateway.config import ConfigError, load_config, read_secret
from stan_gateway.events import make_body, make_event, timestamp, validate_event
from stan_gateway.logging_utils import Redactor, SafeFormatter
from stan_gateway.sources import typed_reading


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = TempWorkspace()
        self.addCleanup(self.temp.close)

    def load(self, text):
        path = self.temp.path / "config.toml"
        path.write_text(text, encoding="utf-8")
        return load_config(path)

    def test_example_and_relative_paths(self):
        loaded = self.load((GATEWAY / "config.example.toml").read_text(encoding="utf-8"))
        self.assertEqual(loaded.source, "simulator")
        self.assertEqual(loaded.data_dir, self.temp.path / "data")
        self.assertEqual(loaded.opcua.node_id_template, "ns=1;s=t|{tag}")
        self.assertEqual(loaded.mill.rule_name, "no_billet_8min")

    def test_invalid_configs(self):
        example = (GATEWAY / "config.example.toml").read_text(encoding="utf-8")
        substitutions = (
            ('source = "simulator"', 'source = "wrong"'),
            ('gateway_id = "pc00248"', 'gateway_id = "INVALID!"'),
            ('minutes = 8', 'minutes = 0'),
            ('deadband = 0', 'deadband = -1'),
            ('watch = true', 'watch = "yes"'),
            ('security = "None"', 'security = "Basic256Sha256"'),
            ('ns=1;s=t|{tag}', 'ns=1;s=t|{missing}'),
            ('http://127.0.0.1:8080/api/gateway/events', 'http://example.invalid/api/gateway/events'),
            ('http://127.0.0.1:8080/api/gateway/events', 'https://example.invalid/api/gateway/events?key=test'),
        )
        for old, new in substitutions:
            with self.subTest(change=new), self.assertRaises(ConfigError):
                self.load(example.replace(old, new))

    def test_plaintext_password_and_key_are_rejected_without_echo(self):
        example = (GATEWAY / "config.example.toml").read_text(encoding="utf-8")
        for old, new in (('[opcua]', '[opcua]\npassword = "synthetic-secret"'),
                         ('[server]', '[server]\nkey = "synthetic-secret"')):
            with self.assertRaises(ConfigError) as caught:
                self.load(example.replace(old, new))
            self.assertNotIn("synthetic-secret", str(caught.exception))

    def test_secret_env_precedence_file_and_missing(self):
        path = self.temp.path / "synthetic.key"
        path.write_text("from-file\n", encoding="utf-8")
        with patch.dict(os.environ, {"UNITTEST_SECRET": "from-env"}):
            self.assertEqual(read_secret("UNITTEST_SECRET", path), "from-env")
        with patch.dict(os.environ, {"UNITTEST_SECRET": ""}):
            self.assertEqual(read_secret("UNITTEST_SECRET", path), "from-file")
            with self.assertRaises(ConfigError):
                read_secret("UNITTEST_SECRET", None)
        with patch.dict(os.environ, {"UNITTEST_SECRET": "bad\nheader"}), self.assertRaises(ConfigError):
            read_secret("UNITTEST_SECRET", None)


class ContractAndSafetyTests(unittest.TestCase):
    def test_contract_limits_and_invalid_types(self):
        for kind, data in (("billet_out", {"count": True}), ("billet_out", {"count": 101}),
                           ("signal", {"tag": "t", "value": float("nan")}),
                           ("mill_state", {"state": "unknown", "rule": "no_billet_8min"}),
                           ("source_state", {"connected": 1})):
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                make_event(kind, data)
        with self.assertRaises(ValueError):
            make_body("test", [event()] * 101)

    def test_pc_time_has_explicit_moscow_offset(self):
        self.assertTrue(event()["ts"].endswith("+03:00"))
        with self.assertRaises(ValueError):
            timestamp(datetime(2026, 10, 9))

    def test_source_bad_types_and_nonfinite_values(self):
        self.assertFalse(typed_reading("true", "bool").good)
        self.assertFalse(typed_reading(True, "int").good)
        self.assertFalse(typed_reading(float("nan"), "real").good)
        self.assertFalse(typed_reading(float("inf"), "real").good)
        self.assertFalse(typed_reading(4, "int", "BadNoCommunication").good)

    def test_log_redacts_message_and_exception(self):
        redactor = Redactor()
        redactor.add("synthetic-secret")
        stream = StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(SafeFormatter(redactor))
        logger = logging.Logger("test")
        logger.addHandler(handler)
        try:
            raise ValueError("synthetic-secret")
        except ValueError:
            logger.exception("Секрет: %s", "synthetic-secret")
        self.assertNotIn("synthetic-secret", stream.getvalue())
        self.assertIn("[скрыто]", stream.getvalue())

    def test_gateway_has_no_source_write_or_cpu_control_calls(self):
        forbidden = {"write_value", "set_value", "write_values", "write_attribute", "write_attribute_value", "write_attributes",
                     "db_write", "write_area", "write_multi_vars", "mb_write", "eb_write", "ab_write",
                     "plc_stop", "plc_hot_start", "plc_cold_start", "download", "delete", "call_method", "set_writable"}
        for path in (GATEWAY / "stan_gateway").rglob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            calls = {node.func.attr for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)}
            self.assertFalse(calls & forbidden, path.name)

    def test_escaped_secrets_are_redacted(self):
        redactor = Redactor()
        secret = "synthetic\\пароль"
        redactor.add(secret)
        for form in (secret, repr(secret)[1:-1], json.dumps(secret, ensure_ascii=True)[1:-1]):
            self.assertNotIn(form, redactor.clean("Error: " + form))
