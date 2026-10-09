"""Пакетный OPC UA Read. Записей и подписок на управляющие методы нет."""

import asyncio

from ..config import read_secret
from . import Reading, typed_reading


class OpcUaSource:
    def __init__(self, config, tags, redactor):
        self.config, self.tags, self.redactor = config, tags, redactor
        self.client = None
        self.nodes = []

    async def connect(self):
        from asyncua import Client, ua
        from asyncua.crypto.security_policies import SecurityPolicyBasic256Sha256
        self.client = Client(self.config.url, timeout=15)
        if self.config.security == "Basic256Sha256":
            await self.client.set_security(
                SecurityPolicyBasic256Sha256, str(self.config.certificate), str(self.config.private_key),
                server_certificate=str(self.config.server_certificate) if self.config.server_certificate else None,
                mode=ua.MessageSecurityMode.SignAndEncrypt,
            )
        if self.config.username:
            password = read_secret(self.config.password_env, self.config.password_file)
            self.redactor.add(password)
            self.client.set_user(self.config.username)
            self.client.set_password(password)
        # Ограничен и весь handshake, и каждая операция протокола.
        await asyncio.wait_for(self.client.connect(), timeout=15)
        self.nodes = [self.client.get_node(self.config.node_id_template.format(tag=tag.name)) for tag in self.tags]

    async def read(self):
        from asyncua import ua
        if self.client is None:
            raise ConnectionError("OPC UA: источник не подключён")
        values = await asyncio.wait_for(self.client.read_attributes(self.nodes, ua.AttributeIds.Value), timeout=15)
        if len(values) != len(self.tags):
            raise ConnectionError("OPC UA: неполная пачка чтения")
        result = {}
        for tag, value in zip(self.tags, values):
            quality = "Good" if value.StatusCode.is_good() else value.StatusCode.name[:32]
            result[tag.name] = (typed_reading(value.Value.Value, tag.type, quality)
                                if value.Value is not None else Reading(None, quality if quality != "Good" else "BadNoValue"))
        return result

    async def disconnect(self):
        client, self.client = self.client, None
        self.nodes = []
        if client is not None:
            try:
                await asyncio.wait_for(client.disconnect(), timeout=15)
            except (Exception, asyncio.CancelledError):
                client.disconnect_socket()
