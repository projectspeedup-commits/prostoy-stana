"""Имитатор: значения вычисляются в памяти, OPC UA предоставляет только чтение."""

import asyncio
import math
import random
import time

from .events import now
from .sources import Reading


class Cycle:
    def __init__(self, config, *, speed=1.0, clock=time.monotonic, stop_probability=0.08):
        if not math.isfinite(speed) or speed <= 0:
            raise ValueError("Скорость имитатора должна быть положительной")
        self.config, self.speed, self.clock = config, speed, clock
        self.rng = random.Random(config.simulator_seed)
        self.stop_probability = stop_probability
        self.origin = clock()
        self.next_start = self.rng.uniform(40, 90)
        self.active_until = 0.0
        self.total = 0
        self.values = {}
        self.refresh()

    def refresh(self):
        elapsed = max(0, (self.clock() - self.origin) * self.speed)
        if elapsed >= self.next_start:
            if self.rng.random() < self.stop_probability:
                self.next_start = elapsed + self.rng.uniform(180, 900)
                self.active_until = elapsed
            else:
                self.active_until = elapsed + self.rng.uniform(3, 6)
                self.next_start = elapsed + self.rng.uniform(40, 90)
                self.total += 1
        active = elapsed < self.active_until
        for tag in self.config.tags:
            if tag.name == self.config.billet.sensor_tag:
                value = active
            elif tag.name == self.config.billet.status_tag:
                value = self.config.billet.status_value if active else 0
            elif tag.type == "bool":
                value = bool(int(elapsed / 30) % 2)
            elif tag.type == "int":
                value = self.total if "CNT" in tag.name.upper() else int(elapsed / 10) % 100
            else:
                value = round(20 + 5 * math.sin(elapsed / 20), 2)
            self.values[tag.name] = value
        return self.values


class SimulatorSource:
    def __init__(self, config, *, speed=1, clock=time.monotonic):
        self.cycle = Cycle(config, speed=speed, clock=clock)
        self.connected = False

    async def connect(self):
        self.connected = True

    async def read(self):
        if not self.connected:
            raise ConnectionError("Имитатор: источник не подключён")
        return {name: Reading(value) for name, value in self.cycle.refresh().items()}

    async def disconnect(self):
        self.connected = False


class SimulatorServer:
    def __init__(self, config, port=4862, *, speed=1, stop_probability=0.08):
        if not 1 <= port <= 65535:
            raise ValueError("Порт должен быть в диапазоне 1..65535")
        self.config, self.port, self.speed = config, port, speed
        self.cycle = Cycle(config, speed=speed, stop_probability=stop_probability)
        self.server = None
        self.task = None
        self.stop_event = asyncio.Event()

    async def start(self):
        from asyncua import Server, ua
        self.server = Server()
        await self.server.init()
        # Имитатор слушает только ПК, на котором запущен; подключений к WinCC нет.
        self.server.set_endpoint(f"opc.tcp://127.0.0.1:{self.port}")
        self.server.set_server_name("Простои стана — имитатор WinCC")
        self.server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
        nodes = [ua.NodeId.from_string(self.config.opcua.node_id_template.format(tag=tag.name)) for tag in self.config.tags]
        namespaces = await self.server.get_namespace_array()
        for index in range(len(namespaces), max(node.NamespaceIndex for node in nodes) + 1):
            await self.server.register_namespace(f"urn:stan:simulator:{index}")
        group = await self.server.nodes.objects.add_object(ua.NodeId("stan_simulator", 1), "Стан")
        types = {"bool": ua.VariantType.Boolean, "int": ua.VariantType.Int32, "real": ua.VariantType.Double}
        for tag, node_id in zip(self.config.tags, nodes):
            node = await group.add_variable(node_id, ua.QualifiedName(tag.name, node_id.NamespaceIndex),
                                            self.cycle.values[tag.name], varianttype=types[tag.type])

            def read_value(_node_id, _attribute, name=tag.name, variant_type=types[tag.type]):
                return ua.DataValue(ua.Variant(self.cycle.values[name], variant_type), SourceTimestamp=now())

            # Read callback вычисляет значение; ни одной операции записи клиентом источника.
            self.server.set_attribute_value_callback(node.nodeid, read_value)
        # Счёт времени начинается после подготовки адресного пространства.
        self.cycle.origin = self.cycle.clock()
        await self.server.start()
        self.task = asyncio.create_task(self._cycle_loop())

    async def _cycle_loop(self):
        while not self.stop_event.is_set():
            self.cycle.refresh()
            try:
                await asyncio.wait_for(self.stop_event.wait(), timeout=min(0.1, 0.5 / self.speed))
            except TimeoutError:
                pass

    async def close(self):
        self.stop_event.set()
        if self.task:
            await self.task
        if self.server:
            await self.server.stop()
            self.server = None

    async def __aenter__(self):
        try:
            await self.start()
        except BaseException:
            await self.close()
            raise
        return self

    async def __aexit__(self, *_):
        await self.close()
