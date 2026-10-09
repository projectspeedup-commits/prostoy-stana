import logging
from pathlib import Path
import shutil
import sys
import uuid

GATEWAY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(GATEWAY))

from stan_gateway.config import BilletConfig, Config, MillConfig, Tag
from stan_gateway.events import make_event

for name in ("stan_gateway", "asyncua", "snap7"):
    logger = logging.getLogger(name)
    logger.addHandler(logging.NullHandler())
    logger.propagate = False


class TempWorkspace:
    # mkdir с обычными ACL: Windows restricted token не может открыть mkdtemp(mode=0700).
    def __init__(self):
        self.path = GATEWAY / ".test-tmp" / str(uuid.uuid4())
        self.path.mkdir(parents=True)

    def close(self):
        shutil.rmtree(self.path)


def config(path, **kwargs):
    defaults = dict(source="simulator", data_dir=path, tags=(
        Tag("1_50_01BFZI01", "bool", "M500.6"),
        Tag("ROLG_1040101_Status", "int", "DB404,DBW124"),
    ), billet=BilletConfig(debounce_ms=0), mill=MillConfig(minutes=0.002))
    defaults.update(kwargs)
    return Config(**defaults)


def event(kind="signal", when=None, **data):
    defaults = {
        "signal": {"tag": "test", "value": True},
        "heartbeat": {"source": "simulator", "connected": True, "uptimeSec": 0, "queue": 0, "version": "0.1.0"},
        "billet_out": {"count": 1}, "mill_state": {"state": "stopped", "rule": "no_billet_8min"},
        "source_state": {"connected": False, "error": "локальная проверка"},
    }[kind]
    defaults.update(data)
    return make_event(kind, defaults, when)
