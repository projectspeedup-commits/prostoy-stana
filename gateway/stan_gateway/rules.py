"""Правила используют монотонные часы: перевод часов ПК не меняет таймауты."""

from .config import Tag
from .events import make_event


class BilletOutRule:
    def __init__(self, status_value: int = 4, debounce_seconds: float = 0):
        self.status_value = status_value
        self.debounce = debounce_seconds
        self.reset()

    def reset(self):
        self.stable = None
        self.candidate = None
        self.since = 0.0

    def update(self, sensor: bool, status: int, clock: float) -> bool:
        active = sensor is True and status == self.status_value
        # Первая достоверная выборка — база. Активный датчик после обрыва не дублирует заготовку.
        if self.stable is None:
            self.stable = active
            return False
        if active == self.stable:
            self.candidate = None
            return False
        if self.candidate != active:
            self.candidate, self.since = active, clock
        if clock - self.since < self.debounce:
            return False
        self.stable, self.candidate = active, None
        return active


class NoBilletRule:
    def __init__(self, minutes: float = 8):
        self.timeout = minutes * 60
        self.name = f"no_billet_{minutes:g}min"
        self.state = "unknown"
        self.anchor = None

    def suspend(self):
        # Отсутствие связи/хорошего качества не является доказательством простоя.
        self.anchor = None

    def update(self, clock: float, billet: bool = False, valid: bool = True) -> str | None:
        if not valid:
            self.suspend()
            return None
        if self.anchor is None or billet:
            self.anchor = clock
        state = "running" if billet else "stopped" if clock - self.anchor >= self.timeout else None
        if state and state != self.state:
            self.state = state
            return state
        return None


class SignalWatch:
    def __init__(self, tags: tuple[Tag, ...]):
        self.tags = tags
        self.previous = {}

    def reset(self):
        self.previous.clear()

    def events(self, readings, when):
        events = []
        for tag in self.tags:
            if not tag.watch:
                continue
            reading = readings[tag.name]
            if not reading.good:
                self.previous.pop(tag.name, None)
                continue
            value = reading.value
            changed = tag.name not in self.previous
            if not changed:
                old = self.previous[tag.name]
                changed = value != old if tag.type == "bool" else abs(value - old) > tag.deadband
            if changed:
                events.append(make_event("signal", {"tag": tag.name, "value": value, "quality": reading.quality[:32]}, when))
                self.previous[tag.name] = value
        return events
