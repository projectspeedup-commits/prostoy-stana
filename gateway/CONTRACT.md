# Контракт «шлюз → сервер» (пилот автоматического учёта)

Шлюз стоит на ПК диспетчерской завода (Windows 10, Python 3.13). Он **только читает** сигналы
контроллеров SA21/SA31 (через OPC UA сервер WinCC или напрямую по S7) и отправляет события на
сервер приложения `https://stan.tmpz-engineering.ru`. События шлюза хранятся на сервере
**отдельно** от ручных отметок мастеров и пока никак не влияют на смены, сводки и отчёты.

## Запрос

`POST /api/gateway/events`

Заголовки:
- `X-Gateway-Key: <секрет шлюза>` — обязателен;
- `Content-Type: application/json`.

Тело:

```json
{
  "gatewayId": "pc00248",
  "sentAt": "2026-10-09T15:00:01.234+03:00",
  "events": [
    { "id": "6f1c0a52-3d1e-4b8e-9a51-0c7f5c2e9b11", "type": "heartbeat",  "ts": "2026-10-09T15:00:00.000+03:00", "data": { "source": "opcua", "connected": true, "uptimeSec": 3600, "queue": 0, "version": "0.1.0" } },
    { "id": "…", "type": "signal",       "ts": "…", "data": { "tag": "1_50_01BFZI01", "value": true } },
    { "id": "…", "type": "billet_out",   "ts": "…", "data": { "count": 1 } },
    { "id": "…", "type": "mill_state",   "ts": "…", "data": { "state": "stopped", "rule": "no_billet_8min" } },
    { "id": "…", "type": "source_state", "ts": "…", "data": { "connected": false, "error": "timeout" } }
  ]
}
```

Правила:
- `gatewayId` — строка `[a-z0-9_-]{1,32}`.
- `id` — UUID события, создаётся шлюзом один раз; повторная отправка того же `id` не создаёт дубль.
- `type` — одно из: `heartbeat`, `signal`, `billet_out`, `mill_state`, `source_state`.
- `ts` — ISO 8601 со смещением; не старше 40 суток и не позже чем через 5 минут от времени сервера.
- `data` — объект, после сериализации не больше 2 КБ:
  - `heartbeat`: `source` (`opcua`|`s7`|`simulator`), `connected` (bool), `uptimeSec` (int ≥ 0), `queue` (int ≥ 0), `version` (строка ≤ 32);
  - `signal`: `tag` (строка ≤ 128), `value` (число или bool), необязательно `quality` (строка ≤ 32);
  - `billet_out`: `count` (int 1..100);
  - `mill_state`: `state` (`running`|`stopped`), `rule` (строка ≤ 64);
  - `source_state`: `connected` (bool), необязательно `error` (строка ≤ 500).
- В одном запросе от 1 до 200 событий; тело не больше 64 КБ.

## Ответы

- `200` `{"accepted": <новых>, "duplicates": <уже были>}` — шлюз удаляет пачку из своей очереди.
- `400` `{"message": "<по-русски, что не так>"}` — пачка битая; шлюз пишет в журнал и **откладывает** пачку (не теряет, но и не шлёт её вечно — см. задание шлюза).
- `401` `{"message": "…"}` — нет ключа или ключ неверный; шлюз ждёт и повторяет.
- `413` — тело больше 64 КБ.
- `429`, `5xx`, сеть недоступна — шлюз повторяет с нарастающей паузой.

## Просмотр (для администратора приложения)

`GET /api/admin/gateway?from=ГГГГ-ММ-ДД&to=ГГГГ-ММ-ДД[&type=…][&gatewayId=…]` — ключ устройства
`X-Device-Key` с правом администратора (как у `/api/admin/settings`). Ответ:

```json
{
  "gateways": [ { "gatewayId": "pc00248", "lastSeen": "…", "lastHeartbeat": { … } } ],
  "events": [ { "id": "…", "gatewayId": "pc00248", "type": "…", "ts": "…", "receivedAt": "…", "data": { … } } ],
  "truncated": false
}
```

Период — по датам МСК, `from` ≤ `to`, не больше 31 суток; событий в ответе не больше 5000
(сортировка по `ts`), при обрезке `truncated: true`.
