"""Чтение TOML; все относительные пути считаются от файла конфигурации."""

from dataclasses import dataclass, field
import math
import os
from pathlib import Path
import re
import tomllib
from urllib.parse import urlsplit


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Tag:
    name: str
    type: str = "bool"
    address: str = ""
    watch: bool = True
    deadband: float = 0


@dataclass(frozen=True)
class OpcUaConfig:
    url: str = "opc.tcp://127.0.0.1:4862"
    node_id_template: str = "ns=1;s=t|{tag}"
    security: str = "None"
    certificate: Path | None = None
    private_key: Path | None = None
    server_certificate: Path | None = None
    username: str = ""
    password_env: str = "STAN_OPCUA_PASSWORD"
    password_file: Path | None = None


@dataclass(frozen=True)
class S7Config:
    ip: str = "127.0.0.1"
    rack: int = 0
    slot: int = 2


@dataclass(frozen=True)
class BilletConfig:
    sensor_tag: str = "1_50_01BFZI01"
    status_tag: str = "ROLG_1040101_Status"
    status_value: int = 4
    debounce_ms: float = 200


@dataclass(frozen=True)
class MillConfig:
    rule: str = "no_billet"
    minutes: float = 8

    @property
    def rule_name(self) -> str:
        return f"no_billet_{self.minutes:g}min"


@dataclass(frozen=True)
class ServerConfig:
    url: str = "http://127.0.0.1:8080/api/gateway/events"
    gateway_id: str = "pc00248"
    key_file: Path | None = None


@dataclass(frozen=True)
class Config:
    source: str
    data_dir: Path
    tags: tuple[Tag, ...]
    log_level: str = "INFO"
    opcua: OpcUaConfig = field(default_factory=OpcUaConfig)
    s7: S7Config = field(default_factory=S7Config)
    billet: BilletConfig = field(default_factory=BilletConfig)
    mill: MillConfig = field(default_factory=MillConfig)
    server: ServerConfig = field(default_factory=ServerConfig)
    simulator_seed: int = 21


def _number(value, label: str, minimum: float = 0, *, strictly: bool = False):
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ConfigError(f"{label}: требуется конечное число")
    if value < minimum or (strictly and value == minimum):
        raise ConfigError(f"{label}: число вне допустимого диапазона")
    return value


def _integer(value, label: str, minimum: int = 0, maximum: int = 65535):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ConfigError(f"{label}: требуется целое число {minimum}..{maximum}")
    return value


def _text(value, label: str, maximum: int | None = None):
    if not isinstance(value, str) or not value or (maximum and len(value) > maximum):
        raise ConfigError(f"{label}: неверная строка")
    return value


def _url(value: str, label: str, schemes: tuple[str, ...]):
    _text(value, label)
    try:
        parts = urlsplit(value)
        parts.port  # Проверяет корректность номера порта.
    except ValueError as exc:
        raise ConfigError(f"{label}: неверный адрес") from exc
    if parts.scheme not in schemes or not parts.hostname or parts.username or parts.password:
        raise ConfigError(f"{label}: неверный адрес или учётные данные в URL")
    if parts.query or parts.fragment or any(c.isspace() for c in value):
        raise ConfigError(f"{label}: параметры, фрагмент и пробелы запрещены")
    if parts.scheme == "http" and parts.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ConfigError("server.url: HTTP разрешён только на локальном имитаторе; нужен HTTPS")
    return value


def load_config(path: str | Path) -> Config:
    path = Path(path).resolve()
    with path.open("rb") as stream:
        raw = tomllib.load(stream)
    base = path.parent

    def section(name):
        data = raw.get(name, {})
        if not isinstance(data, dict):
            raise ConfigError(f"{name}: требуется раздел TOML")
        return data

    def local_path(value):
        if value is None or value == "":
            return None
        return (base / _text(value, "путь")).resolve()

    source = raw.get("source", "simulator")
    if source not in ("opcua", "s7", "simulator"):
        raise ConfigError("source: допустимы opcua, s7, simulator")
    level = raw.get("log_level", "INFO")
    if level not in ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"):
        raise ConfigError("log_level: неверный уровень журнала")
    tags = []
    raw_tags = raw.get("tags", [])
    if not isinstance(raw_tags, list):
        raise ConfigError("tags: требуется список [[tags]]")
    for item in raw_tags:
        if not isinstance(item, dict):
            raise ConfigError("tags: требуется список таблиц")
        name = _text(item.get("name"), "tags.name", 128)
        kind = item.get("type", "bool")
        if kind not in ("bool", "int", "real"):
            raise ConfigError("tags.type: допустимы bool, int, real")
        watch = item.get("watch", True)
        if type(watch) is not bool:
            raise ConfigError("tags.watch: требуется bool")
        address = item.get("address", "")
        if not isinstance(address, str):
            raise ConfigError("tags.address: требуется строка")
        tags.append(Tag(name, kind, address, watch, _number(item.get("deadband", 0), "deadband")))
    if not tags or len({tag.name for tag in tags}) != len(tags):
        raise ConfigError("tags: нужен непустой список без повторяющихся имён")
    b = section("billet")
    billet = BilletConfig(
        _text(b.get("sensor_tag", "1_50_01BFZI01"), "billet.sensor_tag", 128),
        _text(b.get("status_tag", "ROLG_1040101_Status"), "billet.status_tag", 128),
        _integer(b.get("status_value", 4), "billet.status_value", -2147483648, 2147483647),
        _number(b.get("debounce_ms", 200), "billet.debounce_ms"),
    )
    by_name = {tag.name: tag for tag in tags}
    if billet.sensor_tag == billet.status_tag or billet.sensor_tag not in by_name or billet.status_tag not in by_name:
        raise ConfigError("billet: два разных тега правила должны быть в tags")
    if by_name[billet.sensor_tag].type != "bool" or by_name[billet.status_tag].type != "int":
        raise ConfigError("billet: датчик должен иметь type=bool, статус — type=int")
    m = section("mill_state")
    if m.get("rule", "no_billet") != "no_billet":
        raise ConfigError("mill_state.rule: пока реализовано только no_billet")
    mill = MillConfig(minutes=_number(m.get("minutes", 8), "mill_state.minutes", strictly=True))
    if len(mill.rule_name) > 64:
        raise ConfigError("mill_state: имя правила длиннее 64 символов")
    o = section("opcua")
    s = section("server")
    if "password" in o or any(name in s for name in ("key", "api_key", "token")):
        raise ConfigError("Секреты запрещены в основном конфиге; используйте переменную окружения или файл")
    security = o.get("security", "None")
    if security not in ("None", "Basic256Sha256"):
        raise ConfigError("opcua.security: допустимы None и Basic256Sha256 (SignAndEncrypt)")
    opcua = OpcUaConfig(
        url=_url(o.get("url", "opc.tcp://127.0.0.1:4862"), "opcua.url", ("opc.tcp",)),
        node_id_template=_text(o.get("node_id_template", "ns=1;s=t|{tag}"), "node_id_template"),
        security=security, certificate=local_path(o.get("certificate")),
        private_key=local_path(o.get("private_key")), server_certificate=local_path(o.get("server_certificate")),
        username=o.get("username", ""), password_env=_text(o.get("password_env", "STAN_OPCUA_PASSWORD"), "password_env"),
        password_file=local_path(o.get("password_file")),
    )
    if not isinstance(opcua.username, str):
        raise ConfigError("opcua.username: требуется строка")
    if opcua.node_id_template.count("{tag}") != 1:
        raise ConfigError("node_id_template: нужен ровно один {tag}")
    try:
        for tag in tags:
            opcua.node_id_template.format(tag=tag.name)
    except (KeyError, ValueError, IndexError) as exc:
        raise ConfigError("node_id_template: неверный шаблон") from exc
    if security != "None" and (not opcua.certificate or not opcua.private_key):
        raise ConfigError("opcua: для SignAndEncrypt нужны certificate и private_key")
    gateway_id = s.get("gateway_id", "pc00248")
    if not isinstance(gateway_id, str) or not re.fullmatch(r"[a-z0-9_-]{1,32}", gateway_id):
        raise ConfigError("server.gateway_id: требуется [a-z0-9_-]{1,32}")
    server = ServerConfig(_url(s.get("url", ServerConfig().url), "server.url", ("http", "https")), gateway_id, local_path(s.get("key_file")))
    p = section("s7")
    s7 = S7Config(_text(p.get("ip", "127.0.0.1"), "s7.ip"), _integer(p.get("rack", 0), "rack", 0, 7), _integer(p.get("slot", 2), "slot", 0, 31))
    if source == "s7":
        from .sources.s7 import parse_address
        for tag in tags:
            parse_address(tag.address, tag.type)
    data_dir = local_path(raw.get("data_dir", "data"))
    if data_dir is None:
        raise ConfigError("data_dir: требуется непустой путь")
    return Config(source, data_dir, tuple(tags), level, opcua, s7, billet, mill, server,
                  _integer(section("simulator").get("seed", 21), "simulator.seed", 0, 2147483647))


def read_secret(env_name: str, file_path: Path | None, *, required: bool = True) -> str:
    value = os.environ.get(env_name, "")
    if not value and file_path:
        try:
            value = file_path.read_text(encoding="utf-8-sig").rstrip("\r\n")
        except OSError:
            raise ConfigError(f"Не удалось прочитать файл секрета для {env_name}") from None
    if not value and required:
        raise ConfigError(f"Не задан секрет: {env_name} или отдельный файл")
    if "\n" in value or "\r" in value:
        raise ConfigError(f"Секрет {env_name} содержит перевод строки")
    return value
