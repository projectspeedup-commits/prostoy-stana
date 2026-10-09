import logging
import json
from logging.handlers import RotatingFileHandler
from pathlib import Path
from threading import RLock


class Redactor:
    def __init__(self):
        self._secrets = set()
        self._lock = RLock()

    def add(self, secret: str):
        if secret:
            with self._lock:
                # Текст исключений/JSON может содержать экранированное представление.
                self._secrets.update((secret, repr(secret)[1:-1], json.dumps(secret, ensure_ascii=True)[1:-1]))

    def clean(self, text) -> str:
        result = str(text)
        with self._lock:
            for secret in sorted(self._secrets, key=len, reverse=True):
                result = result.replace(secret, "[скрыто]")
        return result


class SafeFormatter(logging.Formatter):
    def __init__(self, redactor):
        super().__init__("%(asctime)s %(levelname)s %(message)s")
        self.redactor = redactor

    def format(self, record):
        return self.redactor.clean(super().format(record))


def setup_logging(data_dir: Path, level: str, redactor: Redactor):
    directory = data_dir / "logs"
    directory.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("stan_gateway")
    logger.setLevel(level)
    logger.propagate = False
    for old in logger.handlers[:]:
        logger.removeHandler(old)
        old.close()
    handler = RotatingFileHandler(directory / "gateway.log", maxBytes=5 * 1024 * 1024, backupCount=10, encoding="utf-8")
    handler.setFormatter(SafeFormatter(redactor))
    logger.addHandler(handler)
    # Библиотеки могут вывести URL или пароль в диагностике. В журнал попадают наши сообщения.
    for name in ("asyncua", "snap7"):
        library = logging.getLogger(name)
        library.handlers.clear()
        library.addHandler(logging.NullHandler())
        library.propagate = False
    return logger
