import argparse
import asyncio
from contextlib import contextmanager
import logging
import signal
import sys

from . import __version__
from .config import load_config
from .events import make_event
from .logging_utils import Redactor, setup_logging
from .queue import EventQueue
from .runtime import Gateway
from .sender import Sender
from .simulator import SimulatorServer
from .sources import create_source


@contextmanager
def stop_signals(stop):
    loop = asyncio.get_running_loop()
    previous = {}
    for name in (signal.SIGINT, signal.SIGTERM):
        previous[name] = signal.getsignal(name)
        signal.signal(name, lambda *_: loop.call_soon_threadsafe(stop.set))
    try:
        yield
    finally:
        for name, handler in previous.items():
            signal.signal(name, handler)


async def execute(args, config, redactor):
    if args.command == "check":
        source = create_source(config, redactor)
        try:
            await source.connect()
            readings = await source.read()
            print("Тег\tЗначение\tКачество")
            for tag in config.tags:
                value = readings[tag.name]
                print(f"{tag.name}\t{value.value if value.value is not None else '—'}\t{value.quality}")
            return 0 if all(value.good for value in readings.values()) else 1
        finally:
            await source.disconnect()
    if args.command == "simulate-server":
        stop = asyncio.Event()
        with stop_signals(stop):
            async with SimulatorServer(config, args.port, speed=args.speed):
                text = f"Имитатор запущен: opc.tcp://127.0.0.1:{args.port}; скорость ×{args.speed:g}"
                logging.getLogger("stan_gateway").info(text)
                print(text, flush=True)
                await stop.wait()
        return 0
    with EventQueue(config.data_dir / "queue.db") as queue:
        if args.command == "queue-stats":
            counts = queue.stats()
            print(f"Очередь: {counts['queue']}\nОтклонено (rejected): {counts['rejected']}")
            return 0
        sender = Sender(queue, config.server, redactor)
        if args.command == "send-test":
            event = make_event("heartbeat", {"source": config.source, "connected": False,
                                            "uptimeSec": 0, "queue": queue.stats()["queue"], "version": __version__})
            queue.add(event)
            result = await sender._deliver([event])
            print(f"HTTP {result.status if result.status is not None else 'нет ответа'}\n{result.text}")
            return 0 if result.status == 200 else 1
        stop = asyncio.Event()
        with stop_signals(stop):
            await Gateway(config, create_source(config, redactor), queue, redactor, sender=sender).run(stop)
        return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Простои стана — шлюз только чтения")
    parser.add_argument("--version", action="version", version=__version__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command, help_text in (
        ("run", "Запустить шлюз"), ("check", "Прочитать теги один раз без отправки"),
        ("send-test", "Отправить один heartbeat"), ("simulate-server", "Запустить локальный OPC UA имитатор"),
        ("queue-stats", "Показать очередь и rejected"),
    ):
        subparser = commands.add_parser(command, help=help_text)
        subparser.add_argument("--config", required=True, help="Путь к TOML")
        if command == "simulate-server":
            subparser.add_argument("--port", type=int, default=4862)
            subparser.add_argument("--speed", type=float, default=1.0, help="Ускорение времени имитатора для тестов")
    args = parser.parse_args(argv)
    redactor = Redactor()
    try:
        config = load_config(args.config)
        setup_logging(config.data_dir, config.log_level, redactor)
        return asyncio.run(execute(args, config, redactor))
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        # Ошибка TOML может содержать литерал секрета: только безопасная категория.
        text = "Неверный синтаксис TOML" if type(exc).__name__ == "TOMLDecodeError" else redactor.clean(str(exc))
        logging.getLogger("stan_gateway").error("Ошибка: %s", text)
        print(f"Ошибка: {text}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
