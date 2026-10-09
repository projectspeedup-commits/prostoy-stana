"""Чтение S7 по объединённым диапазонам областей; порядок байтов big endian."""

import asyncio
from dataclasses import dataclass
import re
import struct

from . import typed_reading


@dataclass(frozen=True)
class Address:
    area: str
    db: int
    offset: int
    size: int
    bit: int | None = None


def parse_address(text: str, kind: str | None = None) -> Address:
    match = re.fullmatch(r"DB(\d+),DB([XBWD])(\d+)(?:\.([0-7]))?", text)
    if match:
        db, form, offset, bit = match.groups()
        size = {"X": 1, "B": 1, "W": 2, "D": 4}[form]
        if (form == "X") != (bit is not None) or not 1 <= int(db) <= 65535:
            raise ValueError(f"Неверный адрес S7: {text}")
        address = Address("DB", int(db), int(offset), size, int(bit) if bit else None)
    else:
        match = re.fullmatch(r"([MIQ])(\d+)\.([0-7])", text)
        if not match:
            raise ValueError(f"Неверный адрес S7: {text}")
        area, offset, bit = match.groups()
        address = Address({"M": "MK", "I": "PE", "Q": "PA"}[area], 0, int(offset), 1, int(bit))
    if address.offset + address.size > 2 ** 21:
        raise ValueError("Адрес S7 превышает диапазон протокола")
    if kind is not None:
        if kind not in ("bool", "int", "real") or (kind == "bool") != (address.bit is not None):
            raise ValueError(f"Тип не соответствует адресу S7: {text}")
        if kind == "real" and address.size != 4:
            raise ValueError(f"REAL требует DBD: {text}")
    return address


@dataclass
class ReadBlock:
    area: str
    db: int
    start: int
    end: int
    tags: list


def plan_reads(tags, *, max_gap=16, max_bytes=222):
    # Не читать пустое пространство от M0 до M100000. Близкие биты/слова объединяются.
    items = [(tag, parse_address(tag.address, tag.type)) for tag in tags]
    items.sort(key=lambda item: (item[1].area, item[1].db, item[1].offset))
    blocks = []
    for tag, address in items:
        end = address.offset + address.size
        previous = blocks[-1] if blocks else None
        if (previous and (previous.area, previous.db) == (address.area, address.db)
                and address.offset <= previous.end + max_gap and end - previous.start <= max_bytes):
            previous.end = max(previous.end, end)
            previous.tags.append((tag, address))
        else:
            blocks.append(ReadBlock(address.area, address.db, address.offset, end, [(tag, address)]))
    return blocks


def decode(raw, address: Address, kind: str):
    if len(raw) != address.size:
        raise ValueError("S7: неполное значение")
    if address.bit is not None:
        return bool(raw[0] & (1 << address.bit))
    if kind == "real":
        return struct.unpack(">f", raw)[0]
    return int.from_bytes(raw, "big", signed=True)


class S7Source:
    def __init__(self, config, tags):
        self.config = config
        self.blocks = plan_reads(tags)
        self.client = None

    def _connect(self):
        from snap7.client import Client
        from snap7.type import Parameter
        self.client = Client()
        # Локальные параметры клиента, не значения в контроллере.
        self.client.set_param(Parameter.PingTimeout, 15000)
        self.client.set_param(Parameter.SendTimeout, 15000)
        self.client.set_param(Parameter.RecvTimeout, 15000)
        self.client.connect(self.config.ip, self.config.rack, self.config.slot)

    async def connect(self):
        await asyncio.to_thread(self._connect)

    def _read(self):
        from snap7.type import Area
        if self.client is None:
            raise ConnectionError("S7: источник не подключён")
        result = {}
        for block in self.blocks:
            data = self.client.read_area(getattr(Area, block.area), block.db, block.start, block.end - block.start)
            if len(data) != block.end - block.start:
                raise ConnectionError("S7: неполная пачка чтения")
            for tag, address in block.tags:
                relative = address.offset - block.start
                value = decode(data[relative:relative + address.size], address, tag.type)
                result[tag.name] = typed_reading(value, tag.type)
        return result

    async def read(self):
        return await asyncio.to_thread(self._read)

    def _disconnect(self):
        client, self.client = self.client, None
        if client is not None:
            try:
                client.disconnect()
            finally:
                client.destroy()

    async def disconnect(self):
        await asyncio.to_thread(self._disconnect)
