import asyncio
import logging
import time

from . import __version__
from .events import make_event, now
from .rules import BilletOutRule, NoBilletRule, SignalWatch
from .sender import interruptible_sleep

LOG = logging.getLogger("stan_gateway")


class Gateway:
    def __init__(self, config, source, queue, redactor, *, sender=None, clock=time.monotonic, wall_clock=now, poll_interval=1.0):
        self.config, self.source, self.queue, self.redactor = config, source, queue, redactor
        self.sender, self.clock, self.wall_clock, self.poll_interval = sender, clock, wall_clock, poll_interval
        self.billet = BilletOutRule(config.billet.status_value, config.billet.debounce_ms / 1000)
        self.mill = NoBilletRule(config.mill.minutes)
        self.watch = SignalWatch(config.tags)
        self.connected = None

    def _persist(self, events):
        if events:
            removed = self.queue.add_many(events)
            if any(removed.values()):
                LOG.warning("Лимиты хранения: удалено старых %s, сверх лимита %s", removed["expired"], removed["overflow"])

    def source_state(self, connected, when, error=""):
        if self.connected == connected:
            return
        self.connected = connected
        data = {"connected": connected}
        if error:
            data["error"] = self.redactor.clean(error)[:500]
        self._persist([make_event("source_state", data, when)])
        if connected:
            self.watch.reset()
            self.billet.reset()
            LOG.info("Источник подключён: %s", self.config.source)
        else:
            self.mill.suspend()
            self.billet.reset()
            LOG.warning("Связь с источником потеряна: %s", self.redactor.clean(error))

    def observe(self, readings, clock, when):
        events = self.watch.events(readings, when)
        sensor = readings[self.config.billet.sensor_tag]
        status = readings[self.config.billet.status_tag]
        valid = sensor.good and status.good
        if not valid:
            self.billet.reset()
        billet = self.billet.update(sensor.value, status.value, clock) if valid else False
        if billet:
            events.append(make_event("billet_out", {"count": 1}, when))
        state = self.mill.update(clock, billet, valid)
        if state:
            events.append(make_event("mill_state", {"state": state, "rule": self.mill.name}, when))
        self._persist(events)

    def heartbeat(self, clock, started, when):
        self._persist([make_event("heartbeat", {
            "source": self.config.source, "connected": self.connected is True,
            "uptimeSec": max(0, int(clock - started)), "queue": self.queue.stats()["queue"], "version": __version__,
        }, when)])

    async def _disconnect(self):
        try:
            await self.source.disconnect()
        except Exception as exc:
            LOG.warning("Ошибка закрытия источника: %s", self.redactor.clean(str(exc)))

    async def run(self, stop: asyncio.Event):
        started = self.clock()
        next_read, next_heartbeat, reconnect_delay = started, started, 5
        sender_task = asyncio.create_task(self.sender.run(stop)) if self.sender else None
        try:
            while not stop.is_set():
                if sender_task and sender_task.done():
                    sender_task.result()
                    raise RuntimeError("Цикл отправки неожиданно завершён")
                clock = self.clock()
                if clock >= next_read:
                    try:
                        if self.connected is not True:
                            await self.source.connect()
                        readings = await self.source.read()
                    except Exception as exc:
                        when = self.wall_clock()
                        self.source_state(False, when, str(exc))
                        await self._disconnect()
                        next_read = self.clock() + reconnect_delay
                        LOG.warning("Переподключение к источнику через %s с", reconnect_delay)
                        reconnect_delay = min(60, reconnect_delay * 2)
                    else:
                        # Один момент чтения для всех событий этой выборки, не время на контроллере.
                        when, clock = self.wall_clock(), self.clock()
                        self.source_state(True, when)
                        self.observe(readings, clock, when)
                        reconnect_delay = 5
                        next_read = clock + self.poll_interval
                clock = self.clock()
                if clock >= next_heartbeat:
                    self.heartbeat(clock, started, self.wall_clock())
                    next_heartbeat = clock + 60
                await interruptible_sleep(stop, max(0, min(next_read, next_heartbeat, self.clock() + 1) - self.clock()))
        finally:
            stop.set()
            if self.connected is True:
                self.source_state(False, self.wall_clock(), "Шлюз остановлен")
            await self._disconnect()
            if sender_task:
                await sender_task
            LOG.info("Шлюз остановлен; очередь сохранена")
