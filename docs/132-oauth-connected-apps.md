# 132 · Подключение приложений через OAuth (claude.ai, телефон, Claude Code, Codex)

**Зачем.** Шаг 2 к [131](131-agent-time-tools.md): подключить Workloom к claude.ai (веб, Desktop и мобильное приложение) как коннектор. claude.ai не умеет передавать личный токен в заголовке; ему нужен вход через OAuth. Тот же вход работает в Claude Code и Codex без ручного токена.

## Как подключить

- **claude.ai:** Settings → Connectors → Add custom connector → URL `https://<workloom>/mcp`, без client id/secret. Откроется Workloom: войти, нажать "Allow access". Коннектор добавляется только на вебе (или в Desktop) и затем сам появляется в мобильном приложении того же аккаунта.
- **Claude Code:** `claude mcp add --transport http workloom https://<workloom>/mcp`, затем `/mcp` → Authenticate.
- **Codex:** MCP-сервер `streamable_http` с URL `https://<workloom>/mcp`. Если версия Codex умеет OAuth для удаленных серверов (`codex mcp login workloom`), вход такой же; иначе - личный токен (`bearer_token_env_var`). С Codex OAuth-вход не проверялся.
- **Отключить:** Integrations → строка с именем приложения (префикс `wlm_oauth`) → Revoke. Действует сразу для доступа и обновления.

## Как устроено

| Что | Где |
| --- | --- |
| Protected resource metadata (RFC 9728) | `GET /.well-known/oauth-protected-resource` и `/.well-known/oauth-protected-resource/mcp`: `resource = <origin>/mcp`, `authorization_servers = [<origin>]` |
| Authorization server metadata (RFC 8414) | `GET /.well-known/oauth-authorization-server` |
| Ответ `/mcp` без токена | `401` и `WWW-Authenticate: Bearer ..., resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"` |
| Регистрация (RFC 7591) | `POST /oauth/register`, только публичные клиенты (`token_endpoint_auth_method: none`) |
| Авторизация | `GET /oauth/authorize` проверяет клиента и redirect URI и ведет на страницу приложения `/app/connect?...`; там обычный вход и согласие; решение - `POST /api/v1/oauth/authorize` (сессия + проверка Origin) |
| Токены | `POST /oauth/token` (`application/x-www-form-urlencoded`): `authorization_code` с PKCE S256 и `refresh_token` |
| Отзыв (RFC 7009) | `POST /oauth/revoke` |

- **Издатель.** Публичный origin: в hosted - канонический `AUTH_APP_ORIGIN`, локально - `http://127.0.0.1:<port>`. Параметр `resource`, если передан, должен совпадать с `<origin>/mcp`.
- **Разрешенные callback.** `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback` и любой `http` на `localhost`/`127.0.0.1`/`[::1]` (порт не сравнивается, RFC 8252). Остальные адреса регистрация отклоняет (`invalid_redirect_uri`), поэтому чужой сайт не может получить код. Новый адрес - правка `OAUTH_HOSTED_REDIRECT_URIS` в `packages/db/src/automation/oauth.ts`.
- **Грант = строка `api_tokens`** (`oauth_client_id` задан, собственный хеш - от секрета, который нигде не показывается). Поэтому права (scope ∩ текущая роль), ограничение на workspace, отзыв, `last_used_at` и `audit_events.api_token_id` работают как у личных токенов. Повторное подключение того же клиента отзывает его прежний грант; при лимите 50 активных токенов уступает самый старый грант приложения.
- **Токены.** Access `wlm_oat_…` живет 1 час, refresh `wlm_ort_…` - 60 дней и меняется при каждом обновлении; старый refresh после использования не принимается (`invalid_grant`). Грант живет не дольше 365 дней, затем нужно подключиться заново. В базе только SHA-256.
- **Код** одноразовый, живет 5 минут, хранится хешем. Повтор кода отзывает все, что было по нему выдано (RFC 6749 §4.1.2).
- **Scope.** `read` и `tasks:write`; неизвестные значения игнорируются, пустой запрос - оба.
- **Защита.** `/oauth/*` и `/.well-known/*` - серверные вызовы без cookie, исключены из проверки Origin и ограничены по адресу общим лимитером публичного API; регистрация дополнительно 20 в минуту с адреса. Решение о согласии идет только из браузерной сессии с проверкой Origin. Страница согласия показывает хост возврата.

Миграция **0039** (только добавление): колонка `api_tokens.oauth_client_id`, таблицы `oauth_clients`, `oauth_authorization_codes`, `oauth_tokens`, индексы. `DROP` нет.

## Проверки (9 ноября 2026, локально)

- PostgreSQL + настоящий процесс API, `tests/integration/oauth.test.ts` 5/5: метаданные и `401` с `resource_metadata`; регистрация (чужой callback и конфиденциальный клиент отклонены, claude.ai принят); ошибки авторизации возвращаются на callback со `state`, неизвестный клиент - нет; loopback на другом порту; согласие, отказ кросс-сайтового решения, отказ пользователя; обмен кода с PKCE (неверный verifier отклонен), MCP и REST с access-токеном, ротация refresh, чужой клиент не может обновить, повтор кода отзывает грант; грант виден в Integrations, повторное подключение заменяет старый, отзыв там и через `/oauth/revoke` останавливает доступ.
- Web: `ConnectAppPage.test.tsx` 4/4.
- `packages/db/src/migrations.test.ts` 14/14: тест обновлен (список миграций до 0039; 0035 и 0036 с несколькими операциями в одном блоке - исключения, их хеши в проде неизменны).

- Полные прогоны на ветке: unit (contracts/domain/db/api/worker/mcp) 2535/2535; PostgreSQL integration 559 пройдено, 8 упали в 7 файлах; web 3033 пройдено, 19 упали в 9 файлах. Те же 7 интеграционных и 9 веб-файлов на чистом `main` (`12cf659`) падают точно так же (8 и 19): устаревшие ожидания (`/me` без `settings`, upgrade-тест без `avatar_id`), даты в прошлом (демо-неделя, повторения, cutoff) и UI-тесты таблицы/Board/автосохранения. К этому срезу не относятся.
- `npm run predeploy` - зеленый. Страница согласия проверена глазами в Chrome (1280×860).

НЕ ПРОВЕРЕНО до выкладки: настоящий claude.ai и телефон, Claude Code/Codex против развернутого сервера, Cloudflare (WAF/Bot Fight не должен резать адреса Anthropic `160.79.104.0/21` на `/mcp`, `/.well-known/*`, `/oauth/*`).
