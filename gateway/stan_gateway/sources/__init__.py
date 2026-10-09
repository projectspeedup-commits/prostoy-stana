from dataclasses import dataclass
import math


@dataclass(frozen=True)
class Reading:
    value: bool | int | float | None
    quality: str = "Good"

    @property
    def good(self):
        return self.quality == "Good" and self.value is not None


def typed_reading(value, kind: str, quality: str = "Good") -> Reading:
    valid = (type(value) is bool if kind == "bool" else
             type(value) is int if kind == "int" else
             type(value) in (int, float) and math.isfinite(value))
    if not valid:
        return Reading(None, "BadType")
    return Reading(float(value) if kind == "real" else value, quality[:32])


def create_source(config, redactor):
    if config.source == "opcua":
        from .opcua import OpcUaSource
        return OpcUaSource(config.opcua, config.tags, redactor)
    if config.source == "s7":
        from .s7 import S7Source
        return S7Source(config.s7, config.tags)
    from ..simulator import SimulatorSource
    return SimulatorSource(config)
