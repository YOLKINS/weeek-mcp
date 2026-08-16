# weeek-mcp

Локальный read-only-по-умолчанию MCP-сервер для [Weeek](https://weeek.net/) — с опциональными write-тулами.

[![npm version](https://img.shields.io/npm/v/weeek-mcp.svg)](https://www.npmjs.com/package/weeek-mcp)
[![npm downloads](https://img.shields.io/npm/dm/weeek-mcp.svg)](https://www.npmjs.com/package/weeek-mcp)
[![CI](https://github.com/YOLKINS/weeek-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/YOLKINS/weeek-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-2025--06--18-blue.svg)](https://modelcontextprotocol.io/)

[English README](README.md)

`weeek-mcp` подключает AI-клиентов (Claude Desktop, Claude Code, Cursor, MCP
Inspector) к вашему воркспейсу Weeek по stdio. Он **read-only по умолчанию** —
установка по умолчанию видит проекты, задачи, доски, участников и теги, но ничего
не меняет — и открывает пять write-тулов, только когда вы явно выставите
`READ_ONLY=false`. Работает на Node ≥ 20; ставится через `npx`, без клонирования
и сборки.

## Зачем этот

- **В npm.** `npx -y weeek-mcp` работает уже сейчас — без клонирования, сборки и
  абсолютных путей.
- **Read-only по умолчанию, композирующиеся гейты.** Write-тулы просто не
  регистрируются, пока вы не включите их явно; `ENABLED_TOOLS` сужает набор до
  whitelist, а `MAX_RESPONSE_CHARS` режет каждый payload. Серверная защита, а не
  клиентская конвенция.
- **Двуязычная документация.** Полный паритет EN ↔ RU.
- **Гранулярная модель ошибок.** Девять различных кодов с агент-читаемыми
  сообщениями — модель понимает, когда ретраить, а когда сдаться, без парсинга
  текста.

## Quickstart

Рекомендуемый путь установки — через `npx`: ни клонирования, ни сборки.
Скопируйте [examples/claude_desktop.mcp.json](examples/claude_desktop.mcp.json) в
конфиг MCP-клиента, замените `YOUR_WEEEK_TOKEN_HERE` на реальный токен из
<https://app.weeek.net/ws/_/settings/apps/api> и перезапустите клиент:

```json
{
  "mcpServers": {
    "weeek": {
      "command": "npx",
      "args": ["-y", "weeek-mcp"],
      "env": {
        "WEEEK_ACCESS_TOKEN": "YOUR_WEEEK_TOKEN_HERE"
      }
    }
  }
}
```

`npx` скачивает `weeek-mcp` при первом запуске и кеширует. Cursor и Cline
используют тот же `mcpServers` shape — см.
[examples/cursor.mcp.json](examples/cursor.mcp.json) и
[examples/cline.mcp.json](examples/cline.mcp.json). У остальных переменных
окружения есть безопасные значения по умолчанию; задавайте только нужное (см.
[Конфигурация](#конфигурация)). Если `npx` не находит `node` (типично с `nvm`),
см. [Troubleshooting](#troubleshooting); smoke-тест без MCP-клиента —
[docs/smoke.md](docs/smoke.md) (на английском).

> `examples/` живёт только на GitHub — в npm-tarball попадают `dist/` +
> `README.md` + `README.ru.md` + `LICENSE`.

## Инструменты

Десять **read**-тулов открыты по умолчанию. Все пятнадцать появляются только при
`READ_ONLY=false` (см. [Включение write-тулов](#включение-write-тулов)).

| Read-тул | Отдаёт |
|---|---|
| `ping` | `pong: <msg>` — health-check транспорта, без API-запроса и без токена |
| `weeek_get_me` | текущего пользователя (`id`, `email`, `name`) — проверяет токен |
| `weeek_list_projects` | все проекты, видимые токену |
| `weeek_get_project` | один проект по id, вместе с `description` |
| `weeek_list_tasks` | одну страницу задач (фильтры + offset/`per_page`-пагинация) |
| `weeek_get_task` | одну задачу по id, с полями исполнителей |
| `weeek_list_members` | всех участников воркспейса |
| `weeek_list_tags` | все теги |
| `weeek_list_boards` | все доски проекта |
| `weeek_list_board_columns` | все колонки доски, в порядке сортировки |

| Write-тул (`READ_ONLY=false`) | Что делает |
|---|---|
| `weeek_complete_task` | переключает флаг завершённости; `completed: false` переоткрывает |
| `weeek_move_task` | двигает задачу в колонку доски (колонка *и есть* статус) |
| `weeek_create_task` | заводит новую задачу и возвращает её с новым id |
| `weeek_update_task` | правит title / priority / type / due date |
| `weeek_set_task_mr_link` | записывает URL merge/pull request в кастомное поле |

Полный справочник по полям (входы, выходы, edge cases, truncation,
multi-assignee) → [docs/tools.md](docs/tools.md) (на английском).

## Включение write-тулов

**Установка по умолчанию не может изменить в вашем воркспейсе ничего.** Все пять
mutating-тулов скрыты гейтом `READ_ONLY` (по умолчанию `true`) — не
регистрируются, поэтому не появляются в `tools/list`. `READ_ONLY=false` поднимает
`tools/list` с десяти тулов до пятнадцати и даёт агенту право **создавать,
править, перемещать и завершать задачи в том воркспейсе, до которого дотягивается
токен**. Шага подтверждения на стороне сервера нет — `annotations` для клиента
подсказка, которую он вправе проигнорировать. Направляйте токен на воркспейс,
содержимое которого готовы увидеть изменённым.

```json
"env": {
  "WEEEK_ACCESS_TOKEN": "YOUR_WEEEK_TOKEN_HERE",
  "READ_ONLY": "false"
}
```

**Начните с одного тула, а не с пяти.** `READ_ONLY=false` в пересечении с
`ENABLED_TOOLS` даёт writes включёнными, но открытым — только тот тул, который вы
назвали:

```json
"env": {
  "WEEEK_ACCESS_TOKEN": "YOUR_WEEEK_TOKEN_HERE",
  "READ_ONLY": "false",
  "ENABLED_TOOLS": "weeek_complete_task"
}
```

`READ_ONLY` — **внешний** гейт: имя write-тула в `ENABLED_TOOLS` само по себе
writes не включает. Allowlist не аддитивен, поэтому перечислите рядом нужные
read-тулы — [examples/claude_desktop.write.mcp.json](examples/claude_desktop.write.mcp.json)
готовый к правке конфиг ровно с таким набором.

### Что каждый write-тул может, а чего не может

| Тул | Меняет | Отменяется | `destructiveHint` | `idempotentHint` |
|---|---|---|---|---|
| `weeek_complete_task` | один флаг завершённости | повторным вызовом с `completed: false` | `false` | `true` |
| `weeek_set_task_mr_link` | значение одного кастомного поля | повторной записью | `false` | `true` |
| `weeek_move_task` | колонку (и доску) задачи | обратным переносом — если знаете, откуда | `true` | `false` |
| `weeek_update_task` | title / priority / type / due date | повторной записью каждого поля — если знаете прежнее значение | `true` | `false` |
| `weeek_create_task` | заводит **новую** задачу | удалением, которого этот сервер не умеет | `true` | `false` |

Три строки `true` помечены «стоит подтвердить человеком», потому что **агент не
видел прежнего значения** и не может его вернуть; `weeek_create_task` — тот, за
которым надо следить: его эффект через этот сервер вообще не отменить, а повторный
вызов заводит **вторую** задачу. `weeek_set_task_mr_link` резолвит кастомное поле
по имени, если не передать `custom_field_id` / `custom_field_name` — совпадающие
имена и правила разрешения неоднозначности в
[docs/tools.md](docs/tools.md#the-mr-link-field-naming-convention).

## Конфигурация

Читается из окружения на старте и валидируется через zod; невалидные значения
прерывают старт сообщением в stderr и ненулевым exit-code. Сервер **не** читает
`.env`-файл сам — пробрасывайте переменные через `env`-блок MCP-клиента или свой
shell.

| Переменная | Обязательная | По умолчанию | Назначение |
|---|---|---|---|
| `WEEEK_ACCESS_TOKEN` | да | — | Персональный API-токен Weeek (≥ 20 символов; плейсхолдеры и значения с пробелами отклоняются). |
| `WEEEK_BASE_URL` | нет | `https://api.weeek.net/public/v1` | Базовый URL Weeek HTTP-клиента. Меняйте под self-hosted прокси. |
| `WEEEK_TIMEOUT_MS` | нет | `30000` | Per-request таймаут (мс). Положительное целое. |
| `READ_ONLY` | нет | `true` | Скрывает write-тулы. При `true` любой тул с `readOnlyHint !== true` не регистрируется. Принимает `true`/`false`/`1`/`0`. |
| `ENABLED_TOOLS` | нет | (не задана = все) | Allowlist имён тулов через запятую, пересекается с `READ_ONLY`. Неизвестные имена дают WARN; пустой результат прерывает старт. |
| `MAX_RESPONSE_CHARS` | нет | `65536` | Байт-бюджет на ответ; превышающие payload обрезаются и помечаются `truncated: true`. Минимум `1024`, максимум `1000000`. |
| `LOG_LEVEL` | нет | `info` | Порог логгера: `debug`, `info`, `warn`, `error`. Неизвестные значения откатываются на `info`. |

Оба гейта работают **на стороне сервера**: скрытый тул не регистрируется, и агент
не может его вызвать. `READ_ONLY` — несущий: не меняйте значение по умолчанию,
если не собираетесь дать агенту право менять ваш воркспейс. См.
[.env.example](.env.example) — копипастабельный шаблон.

## Troubleshooting

| Симптом | Вероятная причина | Решение |
|---|---|---|
| Сервер не появляется в клиенте | `command` указывает на `node`, который клиент не находит, или `dist/index.js` отсутствует / без exec-bit | Запустите `npm run build`; убедитесь, что `ls -la dist/index.js` показывает `0755`. Используйте абсолютный путь из `which node` (см. заметку про NVM ниже). |
| `MCP server failed to start` сразу при запуске | То же, плюс отсутствует `node_modules` | `npm install && npm run build` из корня репозитория. |
| `invalid env: WEEEK_ACCESS_TOKEN: ...` в stderr | Токен содержит пробелы / control-символы или совпадает с плейсхолдером | Сгенерируйте реальный токен на <https://app.weeek.net/ws/_/settings/apps/api> и вставьте без обрамляющих пробелов / переводов строки. |
| `invalid env: WEEEK_BASE_URL: ...` | URL с не-`http(s)`-схемой или содержит `user:pass@` | Используйте обычный `https://api.weeek.net/public/v1`; креды — через `WEEEK_ACCESS_TOKEN`. |
| `EACCES` при запуске `dist/index.js` | `postbuild`-chmod не отработал | `chmod +x dist/index.js`. |
| `npm start` работает, но клиент не запускается | Клиент стартует под другим `PATH`, чем ваш shell | См. workaround для NVM ниже. |

<details>
<summary><b>Workaround для NVM</b> — <code>spawn npx ENOENT</code> / <code>spawn node ENOENT</code></summary>

Claude Desktop и Cursor стартуют свой MCP-subprocess в неинтерактивном shell,
который **не** делает source `~/.nvm/nvm.sh`, поэтому голый `"command": "npx"`
молча валится, если Node стоит через nvm. Либо зашейте абсолютный путь — запустите
`which npx` и вставьте результат в `command` (обновляйте при смене nvm-версии);
пакет всё равно скачается и закешируется при первом запуске:

```json
{ "command": "/Users/<you>/.nvm/versions/node/v20.18.0/bin/npx", "args": ["-y", "weeek-mcp"] }
```

— либо укажите `command` на маленький wrapper-скрипт, делающий source
`~/.nvm/nvm.sh` перед `exec npx "$@"`, — он переживёт смену nvm-версий.

</details>

## Ошибки

Каждый Weeek-тул падает одинаково: `isError: true` с однострочным
`<tool> failed (<weeek_code>): <одно предложение на английском>`. Токен
`weeek_<code>` — стабильный, machine-greppable контракт; предложение подсказывает
путь self-correction. Девять кодов покрывают unauthorized / forbidden / not-found
/ validation / rate-limit / server / network / timeout / invalid-response, у
каждого есть retry-рекомендация.

```
weeek_get_task failed (weeek_not_found): Weeek returned 404 for this resource. Verify the id exists in the configured workspace and was not deleted.
weeek_list_tasks failed (weeek_rate_limited): Weeek rate-limited the request (HTTP 429). Retry after a brief delay or reduce the call frequency.
```

Полная таблица с retry-семантикой → [docs/errors.md](docs/errors.md) (на
английском).

## Контрибьютинг · Безопасность · Лицензия

- **Контрибьютинг** — issues и feature requests приветствуются; **pull request —
  по предварительной договорённости** (репозиторий ведётся строго линейными
  инкрементами). См. [CONTRIBUTING.md](CONTRIBUTING.md).
- **Безопасность** — нашли способ утечь токен или байт на stdout? Не открывайте
  публичный issue; в [SECURITY.md](SECURITY.md) — приватный канал и threat model.
- **Лицензия** — [MIT](LICENSE).
- **Для AI-кодинг-агентов** — контракт точки входа (инварианты, запинованные
  зависимости, pre-merge чеклист) живёт в [CLAUDE.md](CLAUDE.md).

`CONTRIBUTING.md`, `SECURITY.md` и `CLAUDE.md` живут только на GitHub — как и
`examples/`, в npm-тарбол они не попадают. Все на английском. Исключение —
`LICENSE`: он едет внутри пакета.
