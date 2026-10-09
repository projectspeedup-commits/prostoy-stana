import asyncio
from dataclasses import dataclass
import logging
import ssl
from urllib import error, request
from urllib.parse import urlsplit

from .config import ConfigError, read_secret
from .events import MAX_BODY_BYTES, make_body

LOG = logging.getLogger("stan_gateway")


@dataclass(frozen=True)
class HttpResult:
    status: int | None
    text: str

    @property
    def retry(self):
        return self.status not in (200, 400, 413)


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Секрет устройства никогда не отправляется на адрес из HTTP-перенаправления.
        return None


class HttpTransport:
    def __init__(self, config, redactor):
        self.config, self.redactor = config, redactor
        handlers = [request.HTTPSHandler(context=ssl.create_default_context()), NoRedirect()]
        if urlsplit(config.url).hostname in ("localhost", "127.0.0.1", "::1"):
            handlers.append(request.ProxyHandler({}))
        self.opener = request.build_opener(*handlers)

    def post(self, body: bytes) -> HttpResult:
        if len(body) > MAX_BODY_BYTES:
            raise ValueError("Пачка больше 60 КБ")
        try:
            key = read_secret("STAN_GATEWAY_KEY", self.config.key_file)
            self.redactor.add(key)
            try:
                key.encode("latin-1")
            except UnicodeEncodeError:
                raise ConfigError("Ключ нельзя передать в HTTP-заголовке: требуется Latin-1") from None
            if any(ord(char) < 32 or ord(char) == 127 for char in key):
                raise ConfigError("Ключ HTTP содержит управляющие символы")
            req = request.Request(self.config.url, data=body, method="POST",
                                  headers={"X-Gateway-Key": key, "Content-Type": "application/json"})
            try:
                response = self.opener.open(req, timeout=15)
            except error.HTTPError as exc:
                response = exc
            with response:
                text = response.read(64 * 1024).decode("utf-8", errors="replace")
                return HttpResult(response.code, self.redactor.clean(text)[:4096])
        except Exception as exc:
            return HttpResult(None, self.redactor.clean(str(exc))[:4096])


async def interruptible_sleep(stop: asyncio.Event, seconds: float):
    try:
        await asyncio.wait_for(stop.wait(), timeout=seconds)
    except TimeoutError:
        pass


class Sender:
    def __init__(self, queue, config, redactor, *, transport=None, sleep=None):
        self.queue, self.config, self.redactor = queue, config, redactor
        self.transport = transport or HttpTransport(config, redactor)
        self.sleep = sleep
        self.delay = 5

    async def _deliver(self, events, stop=None):
        if stop and stop.is_set():
            return HttpResult(None, "Отправка остановлена")
        result = await asyncio.to_thread(self.transport.post, make_body(self.config.gateway_id, events))
        # Защита остаётся и для подменённого транспорта.
        result = HttpResult(result.status, self.redactor.clean(result.text))
        if result.status == 200:
            self.queue.acknowledge([event["id"] for event in events])
            LOG.info("Отправлено событий: %s", len(events))
        elif result.status in (400, 413):
            if len(events) == 1:
                self.queue.reject(events[0]["id"], result.status, result.text)
                LOG.error("Событие %s отложено в rejected: HTTP %s, %s", events[0]["id"], result.status, result.text)
            else:
                LOG.warning("HTTP %s: делим пачку из %s событий", result.status, len(events))
                middle = len(events) // 2
                left = await self._deliver(events[:middle], stop)
                if left.retry:
                    return left
                return await self._deliver(events[middle:], stop)
        else:
            LOG.warning("Отправка отложена: HTTP %s, %s", result.status or "нет ответа", result.text)
        return result

    async def send_once(self, stop=None):
        removed = self.queue.prune()
        if any(removed.values()):
            LOG.warning("Лимиты хранения: удалено старых %s, сверх лимита %s", removed["expired"], removed["overflow"])
        batch = self.queue.batch(self.config.gateway_id)
        if not batch.events:
            return None
        return await self._deliver(batch.events, stop)

    async def run(self, stop: asyncio.Event):
        while not stop.is_set():
            result = await self.send_once(stop)
            if result is not None and result.retry:
                delay, self.delay = self.delay, min(300, self.delay * 2)
                LOG.warning("Следующая попытка отправки через %s с", delay)
            else:
                self.delay = 5
                delay = 1 if result is None else 0
            if self.sleep:
                await self.sleep(delay)
            else:
                await interruptible_sleep(stop, delay)
