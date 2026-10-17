# Shared Auth: локальный вход в Workloom

**Статус: ограниченный локальный shared Auth `be63752` принят и включён на сохранённом Workloom.** После routing checkpoint `9e13b63` ([75](75-hosting-and-auth-setup.md)) прошли check/build, backend **1434/88**, isolated PostgreSQL **11/2** и compiled Chrome **6/6** с fake provider; живой redirect достиг Google. Пользовательский Google login не завершён. Общий web gate отдельно остаётся **RED: 1534 passed / 5 failed, 179 suites**; локальная Auth-приёмка не превращает этот результат в GREEN. Production не включён.

## Какой адрес открывать

Пользователь открывает **`http://127.0.0.1:4310/`** или сразу **`http://127.0.0.1:4310/app`**. На странице входа нажимает **Sign in** и проходит обычный вход в общем Auth. `/app/auth/callback` — внутренний адрес возврата браузера: вручную открывать его, вставлять туда токен или передавать callback вместо базового адреса не нужно.

Пользователь добавил в действующий upstream Auth allowlist два **базовых origin**, без callback path:

```text
https://workloom.pavelignatov.com
http://127.0.0.1:4310
```

Это готовность upstream настройки, а не выпуск Workloom на публичный домен. `https://workloom.pavelignatov.com/` остаётся адресом будущего отдельного production release; текущий Workloom по-прежнему отклоняет staging/production и Railway environment. Origin `4311` не зарегистрирован для этого входа; проверять shared Auth следует на compiled **4310**, не на соседнем Vite origin. Внутренний `/app/auth/callback` допускается этой origin/prefix-настройкой; отдельные полные callback entries пользователь не добавлял. Auth allowlist использует origin и pathname prefix, а не строгое равенство полного callback URL; подробность и независимая analytics registration — в [75](75-hosting-and-auth-setup.md).

## Настройка сервера

В [.env.example](../.env.example) сохранён default **`AUTH_MODE=dev`** для синтетического demo. Для локального shared-режима оператор использует следующие несекретные настройки, а ключ добавляет только в локальное серверное окружение:

```dotenv
APP_ENV=local
AUTH_MODE=shared
AUTH_BASE_URL=https://auth.pavelignatov.com
AUTH_ISSUER=https://auth.pavelignatov.com
AUTH_AUDIENCE=pet-projects
AUTH_APP_ORIGIN=http://127.0.0.1:4310
```

`AUTH_APP_ORIGIN` — **origin без `/app` и callback path**. Сервер сам строит внутренний callback. RS256 подпись проверяется по JWKS общего Auth с точными issuer/audience. Для login не нужны `client_secret`, analytics `pk/sk` или регистрация нового service key.

**`AUTH_SESSION_KEY`** — собственный серверный ключ Workloom: 32 криптографически случайных байта в canonical unpadded base64url, то есть 43 символа. Это ключ AES-256-GCM для зашифрованных session tokens в базе, не секрет общего Auth и не analytics `sk`. Его создают один раз безопасным операторским способом, хранят только на сервере и сохраняют при обычном restart; замена не даёт расшифровать прежние sessions. Не добавлять значение в Git, клиентский JSON/JS, URL или логи и не присылать его в чат. Placeholder из примера не является рабочим ключом.

Для нового локального окружения сначала применяют проверенную additive migration **0014**, затем включают shared-режим и перезапускают API по [локальному runbook](26-local-runtime.md). Для существующей сохранённой базы это отдельное контролируемое действие: не запускать reset/seed ради авторизации и не заменять базу. Общий start/build остаётся описан в [README](../README.md); worker для входа не нужен. На текущем сохранённом окружении эти migration/activation уже выполнены координатором; повторять setup или seed не требуется.

## Что происходит после входа

Первый успешный вход сопоставляет проверенные **issuer + subject** с новым внутренним Workloom UUID, создаёт **собственное пустое workspace** и одну owner membership в одной транзакции. Повторный или параллельный вход возвращает то же сопоставление. Email, имя и похожий fixture ID не объединяют реального пользователя с demo. Новому пользователю не добавляются demo-задачи, fixture memberships, приглашения или доступ к чужому workspace. Пустой первый экран ожидаем; проект создаётся отдельно.

Callback сначала забирает fragment и убирает его из адреса, затем передаёт результат same-origin POST серверу. Приложение использует собственную HttpOnly cookie; база хранит только её hash и зашифрованные серверные access/refresh tokens. Login attempt привязан к браузеру и одноразовому state. Refresh сериализуется row lock между API-процессами, logout отзывает конкретную локальную session; сервер продолжает проверять актуальное членство и роли для обычных команд. Токены не требуют ручного копирования или browser storage.

Граница отказоустойчивости: если Auth уже повернул refresh token, а DB commit не состоялся, API блокирует эту cookie в памяти процесса и отдельно пытается записать revoke. Если недоступная БД не принимает и revoke, блокировка в памяти **не переживает restart API**. Это не гарантия durable quarantine при отказе БД; нельзя вручную повторять прежний refresh token ради восстановления.

При **Check sign-in** проверяется текущая session; **Start sign-in again** начинает новый вход. **Sign out** учитывает сохранённые редакторы/неизвестный исход команды: явное подтверждение потери draft остаётся отдельным действием. Черновики живут в памяти, не превращаются в гарантированное сохранение после reload или ухода во внешний Auth.

Shared Auth не добавляет приглашения, private task/call ACL, remote MCP/OAuth или готовый командный production. Первый общий пилот может использовать явно workspace-visible данные после отдельной проверки доступа и эксплуатации; private ACL нужны до использования приватных задач/созвонов. Следующий пилот и ручной перенос — [74](74-next-team-pilot.md); hosting, backups и release — [08](08-railway-and-operations.md).

## Проверки этого среза

**Уже подтверждено:** root build библиотек PASS; первый actual isolated PostgreSQL store suite **10/10, 2.02s** (`/private/tmp/workloom-shared-auth-private-pg-proof.json`, `/private/tmp/workloom-shared-auth-private-pg.log`). Проверены concurrent provisioning без fixture merge, пустое owner workspace, reload, project creation, row-lock refresh/logout, commit/rollback и one-use browser-bound attempts. Использовалась только собственная временная child DB; private DB list до/после одинаков, private PostgreSQL остановлен, основная база не затронута. Первоначальный global check RED, включая четыре non-null assertions новых тестов сохранён в `/private/tmp/workloom-shared-auth-check.log`; исправленный scoped ESLint и root TypeScript noEmit прошли.

Отдельный первый upgrade-test RED сохранён в `/private/tmp/workloom-shared-auth-upgrade.log`: identity-only seed не создавал задач. Fixture дополнен обычными domain-командами до миграции (проект, section/tag, parent/child tasks, audit/receipts); проверка сохранения всех legacy rows не ослаблена. Итоговый isolated-PG gate прошёл **11 tests / 2 suites, 4.36s**: `/private/tmp/workloom-shared-auth-private-pg-final-proof.json`, `/private/tmp/workloom-shared-auth-private-pg-final.log`. Для populated **0013 → 0014** все прежние строки всех **60 public tables** и старые migration receipts совпали точно; новые Auth tables пусты до provisioning, повторная migration — no-op. Private DB list восстановлен, private PostgreSQL остановлен; основная база не участвовала.

Отдельная живая upstream-проверка в **09:55 UTC**: `GET /auth/login?redirect_uri=<base-origin>` для обоих указанных origins вернул **302 на Google**; CORS-запрос вернул ожидаемый **401 с правильным Access-Control-Allow-Origin**. Это подтверждает allowlist/CORS readiness, а не завершённый пользовательский login, callback или Workloom session.

Compiled actual-Chrome gate прошёл **6/6, 11.9s** (`/private/tmp/workloom-shared-auth-native-final.log`): настоящий изолированный PostgreSQL и реальные JWT/RS256 crypto с **синтетическим Auth provider**; login → одно пустое своё workspace → создание проекта/задачи через UI → reload → logout **204**. Отдельно проверены второй subject с одинаковыми email/именем без смешивания доступа, invalid callback, browser-cookie binding, state replay и потерянный response body с **Check sign-in** при одном POST. Первоначальный RED (`/private/tmp/workloom-shared-auth-native-initial.log`) сохранён: тест искал неверный UI locator; исправлен только тестовый label **No section**. Это browser-приёмка протокола на fake provider, а не завершённый Google login в живом Auth.

Product checkpoint **`be63752`** содержит **55 Auth source files**. Global check/build прошли; финальный root check перед commit завершился **exit0 в10:31:43 UTC** (`/private/tmp/workloom-shared-auth-commit-check.log`). API/web source freeze и19 compiled resources соответствуют проверенному локальному runtime. Авторский focused API gate прошёл **138 tests / 7 suites** (real-RSA HTTP, refresh-commit safety, config и прежние API cases); **22 helper tests** проверены отдельно. Эти focused числа не добавляются к общему backend total. Backend full unit после обновления двух устаревших expectations (список migration tags и допустимый shared authMode) прошёл **1434 tests / 88 suites, 16.42s**; исходный full-unit RED сохранён в `/private/tmp/workloom-shared-auth-full-unit.log`, исправленный focused gate — **32/2**. Полный web run пока **1534 passed / 5 failed, 179 suites, 297.33s**: это текущий RED, причина/исправление требуют отдельного evidence. Изолированный повтор отдельных проходящих cases не заменяет общий gate.

Локальная активация прошла (`/private/tmp/workloom-auth-main-activation-proof.json`): применена **0014**, все прежние **73 tables**, включая очередь, сохранили bytes/counts; прежние **37,949 public rows** сохранены, добавлены **три пустые Auth tables на момент активации**. Собственный session key создан приватно только при отсутствии; analytics secret и DB URL сохранены, значения не публиковались, `.env` имеет mode **0600**. Проверка browser artifacts не нашла секретов. API **41985 → 67468**, PostgreSQL **46630** и Vite **46683** прежние, worker **OFF**. Readiness body и doctor PASS; guest `/api/v1/me` даёт **401**, Auth config сообщает **shared**; actual bytes всех **19 served JS/CSS/HTML resources** совпали.

Живой browser preflight прошёл (`/private/tmp/workloom-auth-main-browser-proof.json`): видимая **Sign in** на **4310** → local **302** → настоящий Auth **302** → `accounts.google.com`; canonical `/app/auth/callback`, state и HttpOnly attempt-cookie присутствуют, **0 JS errors / bad HTTP**. Google login остановлен перед пользовательским входом; токены/пароли вручную не вводились и настоящий Workloom login этим не завершён.

После preflight отдельный read-only proof `/private/tmp/workloom-shared-auth-main-final.json` подтвердил неизменность digest всех **73 legacy tables**. Три новые Auth tables добавлены намеренно; теперь есть **одна ожидаемая login-attempt row** от browser preflight. Утверждение «три пустые tables» выше относится только к моменту активации до этого запроса. Secret/source proof `/private/tmp/workloom-auth-secret-source-proof.json`: в **1053 non-ignored files** не обнаружены проверяемые значения секретов environment, `.env` игнорируется Git; hashes **11 API + 21 web** файлов не изменились. Это ограниченный scan конкретных значений, не общий security audit.

Диагностика общего web RED завершена без изменения постороннего Graph. Meeting/Weekly cases прошли изолированно; Graph group — **10 PASS / 1 RED**. Для совпадающего холодного Graph case временный Vite source oracle восстановил шесть прежних UI modules из `f66d81776952dc22fae227654f46cdfb7a58add6` (тогдашний HEAD) без product/test edits и снова получил **RED, 1038ms** (`/private/tmp/workloom-shared-auth-graph-head-oracle.log`). Конфигурация oracle теперь закреплена за этим SHA, а не за текущим HEAD `be63752`. Это ограниченный source oracle, не полный старый build/native gate и не общее доказательство причины всех пяти исходных failures. Исходный полный **1534/5 RED** сохранён; отдельные повторы его не заменяют.

Локальный Auth принят по собственным crypto/API/PG/browser/activation gates выше. **Пользователю остаётся завершить настоящий Google login**; реальный redirect preflight, fake-provider browser и ручной login различаются. Общий web RED остаётся известным отдельным ограничением. Старые routing/night gates не переименованы в Auth-приёмку. Публичный DNS/HTTPS, Railway deployment, hosted sessions и реальные приглашённые участники этим документом не заявлены.
