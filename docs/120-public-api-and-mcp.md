# Public API, personal access tokens и удалённый MCP

Статус: **реализовано и активно локально** (22 октября 2026): миграция 0030 применена (ledger 30→31, дамп до миграции сохранён вне репозитория), API перезапущен, `/docs`, `/api/public/v1`, `/mcp` отвечают на `http://127.0.0.1:4310`. Проверено: PostgreSQL-интеграция `tests/integration/public-api.test.ts` 12/12 (включая гонку «отзыв до барьера записи»), регресс local MCP/миграций 22/22, unit 1709, web-панель 2/2, lint/typecheck/boundaries/localization. Не проверено: реальный токен реального пользователя, подключение Claude Code/Codex, production. Цель: DevOps и агенты (Claude, Codex, любой MCP-клиент) создают и меняют задачи из терминала, не заходя в админку; права те же, что в интерфейсе.

## Что уже было и что меняем

- Уже есть локальный stdio MCP ([20](20-p5b-mcp-contract.md)): токен на **один** workspace, TTL ≤ 24 ч, клиент сам считает хеш, мост только на loopback, ID-ориентированные схемы. Он остаётся без изменений (legacy-панель на странице Integrations).
- Новое: **персональный токен пользователя** (PAT), **человеко-удобный REST API** и **удалённый MCP (Streamable HTTP)** над одним общим ядром. Все три слоя вызывают одни и те же функции ядра и те же доменные команды (`TaskApplication`), поэтому правила статусов, дат, пакетов работ, cutoff и аудит не дублируются.

## Решения

| Вопрос | Решение |
| --- | --- |
| Кто выдаёт токен | Любой вошедший пользователь на странице Integrations (или сессионные `GET/POST /api/v1/me/api-tokens`, `POST /api/v1/me/api-tokens/:id/revoke`). Секрет генерирует сервер и показывает **один раз**; в БД только SHA-256. |
| Формат | `wlm_pat_<43 символа base64url>` (32 байта CSPRNG). Префикс `wlm_pat_` виден сканерам секретов. |
| Срок жизни | Обязателен: 1–365 дней, по умолчанию 90. Не продлевается. Отзыв мгновенный. |
| Область | `read` (workspaces, проекты, участники, задачи) и `tasks:write` (создать/изменить). Дополнительно токен можно ограничить списком workspace. |
| Права | Эффективные права = **scope токена ∩ ограничение workspace ∩ текущая роль пользователя в workspace** при **каждом** запросе. Роль понизили или участника отозвали — токен сразу теряет права. Токен не даёт больше, чем у пользователя в UI. |
| Гонка с отзывом | Запись проходит через `authorizeInScope` внутри транзакции после барьера workspace (как у local MCP): отзыв, закоммиченный раньше, блокирует запись. Аудит хранит `api_token_id`. |
| Ссылки | Workspace — UUID **или slug**. Проект/секция/статус/тег/исполнитель — UUID **или точное имя** (без учёта регистра); неоднозначное или неизвестное имя → `400 VALIDATION_FAILED` с `error.details = {field, reason: ambiguous|not_found, candidates}`. Исполнитель также `me` и `none`. |
| Формат данных | JSON, camelCase, даты `YYYY-MM-DD`. Ответ — «плоский» `TaskView`: имена и ID проекта/секции/статуса/исполнителя рядом, чтобы не делать лишних запросов. |
| Конкурентность | Для PATCH `ifRevision` необязателен: без него применяется «последняя запись выигрывает» по присланным полям; с ним — `409 REVISION_CONFLICT`. |
| Идемпотентность | Заголовок `Idempotency-Key` (до 128 печатных ASCII). Без него сервер создаёт одноразовый ключ: повтор запроса без ключа не защищён от дубля — это явно описано в документации. MCP-инструменты принимают `operationKey`. |
| Транспорт MCP | Streamable HTTP на `/mcp` того же сервера (без сессий, SDK `createMcpHandler`, legacy и modern эпохи). Claude Code: `--transport http`; Codex: `streamable_http` с `bearer_token_env_var`; stdio-only клиенты (Claude Desktop, Cursor) — через `npx mcp-remote`. |
| Документация | Публичный раздел `/docs` (статический HTML, без входа): Overview/Auth, REST API с `curl`, MCP для Claude/Codex/прочих, ошибки, права. Ссылки с лендинга и страницы Integrations. |

## Ресурсы REST (`/api/public/v1`)

```
GET   /me                                  кто я, scope токена, мои workspaces и роли
GET   /workspaces
GET   /workspaces/{ws}/projects
GET   /workspaces/{ws}/projects/{project}  проект + секции + статусы
GET   /workspaces/{ws}/members
GET   /workspaces/{ws}/tags
GET   /workspaces/{ws}/tasks               фильтры: project, section, status, statusGroup, assignee,
                                           tag, q, dueBefore, dueAfter, open, includeArchived,
                                           sort=updated|due|created, limit, cursor
GET   /workspaces/{ws}/tasks/{taskId}
POST  /workspaces/{ws}/tasks               project обязателен; section/status/assignee/... необязательны
PATCH /workspaces/{ws}/tasks/{taskId}      status, section, assignee, title, dates, tags, ...
GET   /openapi.json
```

Списки: `project`, `section`, `status`, `assignee`, `tag` принимают значения через запятую; `assignee=me` — «мои задачи».

## MCP-инструменты

`whoami`, `list_workspaces`, `list_projects`, `get_project`, `list_members`, `list_tags`, `list_tasks`, `get_task`, `create_task`, `update_task`, `set_task_status`. Схемы входа — те же Zod-схемы, что у REST (общий пакет contracts). Если у пользователя ровно один доступный workspace, параметр `workspace` можно опустить. Каждый вызов заново проверяет токен, scope и роль; `tools/list` показывает только разрешённые инструменты.

## Файлы

- `packages/db/migrations/0030_api_tokens.sql` — таблица `api_tokens`, `audit_events.api_token_id`.
- `packages/contracts/src/automation.ts` — схемы токенов, запросов, `TaskView`.
- `packages/db/src/automation/` — токены, разрешение ссылок, чтение/запись задач (ядро).
- `apps/api/src/http/public-api-routes.ts`, `api-token-routes.ts`, `mcp-http.ts` — транспорты.
- `apps/web/docs.html`, `apps/web/src/features/api-tokens/` — документация и UI.

## Проверка

Юнит-тесты разбора токена и ссылок; PostgreSQL-тесты: выдача/отзыв, scope, роль viewer не пишет, чужой workspace = 404, отзыв блокирует запись, разрешение имён, фильтры, идемпотентный повтор; HTTP-тесты REST и MCP (initialize, tools/list, tools/call); реальный прогон `curl` и `claude mcp add` против локального сервера.

## Вне этого среза

OAuth/динамическая регистрация клиентов MCP, rate limiting на токен (только общий лимит сервера), вебхуки, комментарии/вложения/поля через публичный API, bulk-операции.
