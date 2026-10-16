# Журнал доказательств реализации

Снимок от 16 октября 2026 года. Локально приняты P0 и ограниченные P1a/P1b/P2a/P2b/P3a/P3b/P4a/P4b/P5a/P5b. Последний P5b добавил local scoped credentials, семь чтений и keyed task create/update через stdio MCP; source checkpoint `058aeeb4a6301d83c6cea6bddba109b5e5959a27` создан root, дерево после commit чистое. Полный P1/P2/P3/P4/P5, MVP и командный пилот не завершены; private ACL/Auth, полный Asana import, remote MCP/OAuth, внешние календари, production и old-tab upgrade не заявлены. Исторические failures и targeted reruns ниже сохраняются отдельно. Этапы — [06](06-implementation-plan.md), проверки — [07](07-verification-and-pilot.md), handoff — [21](21-local-pilot-handoff.md).

## Происхождение

- Проверки исторических разделов P0 и P1a выполнялись на рабочем дереве ветки `codex/bootstrap-plan` до первого локального checkpoint-коммита. На момент проверок HEAD не существовал (`git rev-parse --verify HEAD` завершался ошибкой), поэтому commit hash у результатов нет. После проверок по разрешению координатора создан первый локальный checkpoint-коммит A: `cf586b324a22dd2f77336c2fd6657f87b94c3f1f` («Bootstrap verified local P0 and bounded P1a», tree `a7802c3c588010c548d61b8054690b1ef67376f8`). Он фиксирует 227 файлов замороженного проверенного рабочего дерева без изменений исходников: перед коммитом staged-содержимое сверено с итоговыми файлами (точное совпадение), игнорируемые `.env`, `node_modules`, `dist`, отчёты и результаты тестов не включены; push не выполнялся. Ради коммита проверки не перезапускались: их точные области описаны ниже — широкий gate (интеграция и root unit), затем targeted gate после визуальной правки трёх файлов web (web unit и browser). Эта последующая правка журнала только записывает hash A.
- Новый код реализации и тестов P0 и P1a, скрипты demo/capture и документация написаны через Claude CLI `--model opus --effort high`; фактическая модель — `claude-opus-5-5`. Команды проверок запускали агенты-оркестраторы (координатор, foundation, владельцы API и web, QA) разрешёнными инструментами; для каждой строки ниже указано, кто сообщил результат. Исходные планировочные документы, инструкции пользователя и ранее записанное происхождение этой пометкой не переатрибутируются.
- Историческую редакцию журнала P0/P1a составил агент Claude (`claude-opus-5-5`) по сводке координирующего агента; при составлении команды не запускались. Добавления P1b и active-run ledger после фактического quota rejection ведёт QA через разрешённый Codex fallback; точное авторство ниже.
- Документ [10](10-calendar-integration.md): создан и исправлен через Claude CLI `--model opus --effort high` (логи `/tmp/workloom-calendar-claude.jsonl`, `/tmp/workloom-calendar-fix-claude.jsonl`). Первоисточники Google и Microsoft Graph открыл в браузере координирующий агент, CLI работал по проверенной постановке (раздел 11 документа 10). K01–K11 не выполнялись.

## Checkpoint P0 — 16 октября 2026

Исторический раздел: результаты относятся к рабочему дереву на момент прогона P0.

### Среда

- Node 24.19.0, macOS arm64.
- Реальный PostgreSQL 17.5 (Homebrew), изолированный кластер задачи `/var/folders/2f/bq9gfd357m922mw2yws511_00000gn/T/workloom-pg17-2sy_qf65`, только `127.0.0.1:55432`. Метаданные подключения — `/tmp/workloom-pg17-connection.json`; учётные данные синтетические и здесь не приводятся.
- `workloom_dev` заполнена синтетическим демо-набором; `workloom_test` — база для одноразовых тестовых баз. Каждый интеграционный файл создаёт отдельную тестовую базу и удаляет её; SQL-проверка после прогона показала только `workloom_dev` и `workloom_test`.
- Docker на хосте недоступен. Проверки базы выполнены на реальном PostgreSQL, не mock и не skip. Путь `npm run db:up` (Docker Compose) на этом хосте не исполнялся.
- Инцидент ENOSPC вызвал реальное аварийное завершение изолированного кластера на checkpoint. После переноса кеша задачи и освобождения места обычный crash recovery через `pg_ctl` восстановил его. Это восстановление инфраструктуры, а не проверка backup/restore или восстановления worker.
- Другие экземпляры и порты PostgreSQL не опрашивались и не изменялись.
- Запущенные процессы на момент checkpoint P0: оптимизированный локальный API владельца backend на `127.0.0.1:4310`; Vite QA на `127.0.0.1:4311` с proxy на API (лог `/tmp/workloom-qa-vite.log`). PostgreSQL работает независимо от них. Последнее состояние процессов — в разделах P1a.
- Deployment, платные ресурсы, внешние сообщения и приглашения не выполнялись.
- Схема checkpoint P0 — проверенная миграция `0000_p0_identity_workspaces` из журнала миграций `packages/db/migrations/meta/_journal.json`. Каталог синтетических fixtures — стабильный `packages/db/src/fixtures.ts`: шесть участников команды и outsider, два workspace. Последующее применение миграции P1a `0001` к dev-БД описано в разделе P1a.

### Результаты

| Проверка | Источник | Команда | Результат |
| --- | --- | --- | --- |
| Чистая установка зависимостей | foundation | `npm ci` с обычным lifecycle, включая postinstall, в `/tmp/workloom-ci-clean-4gkeqa_9`; там были только корневые `package.json`, `package-lock.json` и manifests apps/packages, без исходного кода | pass: 428 пакетов установлено, 436 проверено audit, 0 уязвимостей. Это проба установки зависимостей, а не чистая копия исходников со сборкой |
| Build, typecheck, lint, unit | foundation | Из корня рабочего репозитория `/Volumes/PavelData/ai/workloom`: `npm run build`, `npm run typecheck`, `npm run lint` и unit-проверка | pass; проверка границ браузерного кода охватила 48 файлов. Во временной копии исходники не собирались. Эти отдельные отчёты foundation QA не повторял; корневой `npm run build` QA выполнил в составе `npm run test:integration` |
| Сборка библиотек | QA | `npm run build:libs` | pass |
| Интеграция с PostgreSQL | QA | `npm run test:integration`: `npm run build` (все 6 workspaces и оптимизированный SPA), затем Vitest 5.0.5 | pass: 5 файлов, 50 тестов, 12,29 с, локальное время 00:56:51. Заменяет ранний частичный прогон 2 файлов / 8 тестов |
| Unit API | владелец API | 4 файла unit-тестов и typecheck API | pass: 56 тестов, typecheck pass, после исправления: неверный `Content-Length` → 400 `BAD_REQUEST` (415 для media type сохранён) |
| Component web | владелец web | Component-тесты, typecheck, lint и production build `@workloom/web` | pass: 15 тестов; typecheck, lint, build pass |
| Строгие проверки тестов QA | QA | `tsc -p tsconfig.json`, `eslint tests --max-warnings=0` | pass для файлов тестов QA; полный корневой typecheck — по отчёту foundation |
| Установка браузера | QA | `npm run test:e2e:install` с `PLAYWRIGHT_BROWSERS_PATH` во внешнем каталоге задачи | pass: Chromium 1248 / Chrome for Testing 156.0.8078.4. Первый запуск `test:e2e` упал до UI: на хосте был только build 1228 |
| Browser | QA | `npm run test:e2e` с тем же окружением | pass: 6 тестов Chromium, 14,3 с |
| Root CUA browser | координатор | — | blocked: ошибка sandbox/symlink writable root в среде инструмента, не ошибка приложения. Доказательства UI — из Playwright |
| Ссылки в `docs/` | координатор | Локальная проверка относительных Markdown-ссылок | Для редакции checkpoint P0: 12 документов, 0 битых. Более поздние проверки — в разделе P1a |

Каталог браузеров Playwright: `/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-playwright`.

**Интеграция, 50 тестов.** Охват: повторные пустые миграции, стабильные схема и журнал Drizzle; повторный seed со стабильными IDs и counts; обязательная явная тестовая БД; транзакция записи workspace с rollback audit/outbox и отозванным membership; изоляция tenant и попытки подмены actor через реальный HTTP; same-origin переключение dev cookie, allowlist, Host/Origin; live/ready, включая отказ ready на пустой схеме; собранный HTML и реальные ссылки на JS/CSS; fallback клиентских маршрутов; JSON 404 для неизвестного API и отсутствующих assets даже при `Accept: text/html`. 20 из 50 — unit-подобные проверки защиты без открытия БД; остальные наборы работают с реальным PostgreSQL. 50 тестов не означают 50 обращений к базе.

**Защита тестовой цели.** Read-only review показал на изолированных синтетических базах, что параметр postgres.js `?database=workloom_dev` переопределяет путь URL `workloom_test`. Конфигурация backend и тестовый harness теперь отклоняют переопределение цели и identity, включая порт. 20 случаев защиты прошли и входят в 50 выше.

**Последующая находка (после checkpoint) — исправлена.** Более поздний read-only review показал: валидный UUID workspace в верхнем регистре возвращал 0 участников, в нижнем — 6. Исправлено канонизацией в общем `idSchema` и прямым сравнением в domain. Новый HTTP-регрессионный тест прошёл в фокусном прогоне 16 октября 2026 (раздел P1a): верхний регистр возвращает тех же 6 участников. Этот случай не входит в 50 тестов checkpoint P0.

**Unit API.** Исправление `Content-Length` подтверждено только unit-тестами. Запись о том, что процесс на 4310 запущен до исправления, историческая: позднее API перезапускался из новых сборок (раздел P1a). Неверный `Content-Length` в браузере не проверялся.

**Web.** Тесты покрывают удаление содержимого прежнего membership после отказа при обновлении, немедленное скрытие и очистку кеша при смене actor, состояния loading/error/retry/empty. Владелец web проверил, что в оптимизированном бандле нет селектора actor и dev endpoints.

**Browser.** Реальные workspace, actor и участники проходят API → PostgreSQL; маршрут чужого workspace отклоняется; на мобильной ширине 390 px нет горизонтального переполнения. Задержанный реальный ответ (loading), mock 503 с последующим реальным retry и mock пустого списка — проверки состояний UI, а не отказа базы. Все тесты используют локальную синтетическую identity, не общий Auth, приватные встречи или старые вкладки.

**Screenshots Playwright** (долговременное хранилище задачи вне репозитория). Координирующий агент открыл через `view_image` только `p0-desktop-members.png` и `p0-mobile-overview.png` и блокирующих проблем вёрстки не нашёл. Это визуальный просмотр координатором, а не человеком; остальные три screenshots сняты, но координатором не просмотрены.

- [p0-desktop-overview.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p0-desktop-overview.png) — координатором не просмотрен
- [p0-desktop-dev-selector.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p0-desktop-dev-selector.png) — меню открыто; координатором не просмотрен
- [p0-desktop-members.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p0-desktop-members.png) — просмотрен координатором
- [p0-mobile-overview.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p0-mobile-overview.png) — просмотрен координатором
- [p0-mobile-members.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p0-mobile-members.png) — координатором не просмотрен

### Статус по областям на момент P0

`вне P0` — более поздний этап, на момент P0 не реализован и не является pass. Текущий статус — в конце раздела P1a.

| Область | Статус | Примечание |
| --- | --- | --- |
| Тела ответов HTTP/API | pass (локально, dev identity) | Интеграция и unit API: workspace, memberships, live/ready, ошибки, изоляция tenant |
| Assets JS/CSS из оптимизированного dist | pass | Собранный HTML и ссылки JS/CSS; неизвестный API и отсутствующие assets дают JSON 404 |
| Browser UI | pass (локально, синтетическая identity) | 6 тестов Playwright; координатор просмотрел 2 из 5 screenshots без блокирующих проблем, остальные 3 координатором не просмотрены; просмотр человеком не выполнялся |
| Docker Compose PostgreSQL | не исполнялся | Docker недоступен на хосте |
| Авторизованные сценарии (общий Auth) | вне P0 | Не реализовано |
| Приватные встречи и ACL задач | вне P0 | Не реализовано |
| Старая вкладка / обновление | вне P0 | Не реализовано |
| Worker и фоновые jobs | вне P0 | Не реализовано |
| Backup / restore | вне P0 | Восстановление кластера после ENOSPC сюда не относится |
| Внешние календари K01–K11 | не реализовано | После пилота P6, см. [10](10-calendar-integration.md) |
| Deployment / production | не выполнялось | `NODE_ENV=production` проверен только как локальная оптимизированная сборка с `APP_ENV=local`, `AUTH_MODE=dev` |

## P1a — ограниченный объём

Объём P1a: проекты, секции, статусы, tags, задачи, видимые всему workspace; явные строки участников с собственной ревизией; общая оценка WorkPackage и added scope; идемпотентность; ревизии; tenant safety, pagination и архив; UI таблицы задач проекта, карточки (drawer), создания дочерней задачи и фильтров по участнику и поиску. Contracts расширены аддитивно. Приватные ACL, typed custom columns, UI истории, сохранённые представления и массовые правки в P1a не входят и не реализованы.

Ниже сначала исторический частичный checkpoint (на тот момент P1a не был принят), затем широкий gate до визуальной правки, визуальная проверка (fail → исправление → pass) и последний targeted gate. Counts разных прогонов не суммируются.

### Частичный checkpoint API/DB — 16 октября 2026 (исторический)

На момент этого checkpoint 17 HTTP-случаев P0 повторно прошли в фокусном прогоне 01:18:36 — до последнего тогдашнего исправления domain; частичные 14 P1a и 17 P0 не были общим gate. P1a тогда не был принят.

| Проверка | Источник | Команда | Результат |
| --- | --- | --- | --- |
| Сборка пакетов | QA | `npm run build --workspace @workloom/<package>` для contracts, domain, db, api в порядке зависимостей | pass: 4 из 4. Web (TSX) в этом проходе не собирался |
| Фокусная интеграция с PostgreSQL | QA | `vitest run --project integration tests/integration/p1a-tasks.test.ts tests/integration/http-workspaces.test.ts`; явный синтетический `TEST_DATABASE_URL`, отличный от dev-БД; `APP_ENV=local`, `AUTH_MODE=dev` | pass: 2 файла, 29 тестов (12 сценариев P1a + 17 HTTP-случаев P0), 14,72 с, локальное время 01:18:36. Лог `/tmp/workloom-p1a-focused.log` (без credentials). Прогон до последнего исправления domain |
| Пересборка после исправления удержания ссылок в domain | QA | `npm run build:libs`, затем сборка API | pass. Web не собирался |
| P1a на PostgreSQL, первый прогон | QA | `vitest run --project integration tests/integration/p1a-tasks.test.ts`, то же окружение | fail: 13 из 14, старт 01:26:53, 23,63 с. Все проверки продукта прошли; упало финальное сравнение восстановленной фикстуры: `updated_at` терял микросекунды (до миллисекунд) при сериализации `Date` в параметр, который postgres.js выводил как `timestamptz`. Исправлена только фикстура QA — привязка через `::text::timestamptz` сохраняет точное равенство; исправления продукта нет и не заявляется |
| P1a на PostgreSQL, повтор | QA | Та же команда | pass: 1 файл, 14 сценариев, старт 01:28:02, 8,86 с. Лог `/tmp/workloom-p1a-retained-focused-final.log`. HTTP-случаи P0 в этом прогоне не запускались |
| Строгие проверки тестов QA | QA | `eslint tests --max-warnings=0`, `tsc -p tsconfig.json` | pass после пересборки и тогдашнего последнего исправления domain |
| Unit транспорта P1a | владелец backend | Unit-тесты транспорта, lint, typecheck API против заново собранных db и domain | pass: 5 файлов, 123 теста; lint и typecheck API pass. Без PostgreSQL — не доказательство работы с БД; отдельно от прогонов выше |
| Фокусные unit исходников | foundation | Unit-тесты contracts, domain, task service, UUID в access, журнала и cursor db; фокусный ESLint core | pass: 96 из 96, ESLint pass. QA не повторял. Ранее ложное падение cursor из-за фикстуры с UUID только из цифр (`.toUpperCase()` его не менял) исправлено в фикстуре, ошибки продукта не было |
| Обновление заполненной БД P0 до `0001` | foundation | Migrator на dev-БД | fail, затем pass после исправления журнала (ниже). Лог `/tmp/workloom-upgrade-preservation.log` (без credentials) |
| Ссылки в `docs/` | QA | Python-проверка: regex по Markdown-ссылкам с разрешением локальных путей | Для редакции документации перед частичным checkpoint: 12 документов, 120 локальных ссылок, 0 битых |

**Сценарии P1a, 12.** Сохранение проекта, секции и задачи с чтением через второй процесс API; ревизии. Общая детализация WorkPackage: дочерние задачи и added scope с дедупликацией оценок. Строки участников: мягкое удаление и повторное добавление со стабильным `created_at` и ревизией, подтверждено SQL. Задача из другого проекта → 422, чужой workspace → 404. Отклонение циклов. Viewer → 403; отозванный membership блокирует replay из кеша идемпотентности. Точный replay без изменения состояния; тот же ключ с другим телом PATCH или другой целью → 409; replay с устаревшим телом для той же цели валиден. Archive/restore. Полная pagination без дублей и пропусков, фильтры. Для отклонённых записей и replay сравнивались digest целых строк, counts и `change_seq` по таблицам domain, audit, outbox и idempotency. Без in-memory mocks и skip; отдельные одноразовые базы удалены.

**Новые сценарии P1a, 2 (всего 14).** Архивный tag: правка только title и явное сохранение tag разрешены; новая задача или новое прикрепление с ним → 422 без изменений состояния, audit и outbox. Отозванный участник, оставшийся ответственным и активным участником: правки только title и с явно неизменными значениями проходят; удаление оставляет его неактивную строку; повторная активация, назначение новым ответственным или новым участником → 404; snapshot при отклонённой записи стабилен. Membership в snapshot в конце точно восстановлен.

**Обновление заполненной БД P0.** По отчёту foundation, QA не повторял. На dev-БД с 7 пользователями, 2 workspace и 7 memberships миграция `0001` сначала упала: сгенерированный неприменённый `when` в журнале был раньше будущей метки `0000`. Migrator оставил строки и схему P0 без изменений; это записано как fail. С одобрения координатора изменён только `when` неприменённой `0001` на `when` `0000` + 1; SQL, snapshot и запись журнала `0000` сохранены. Добавлен регрессионный тест строгой монотонности журнала. Повторный запуск применил `0001_p1a_tasks`, состояние current; целые строки 7 users, 2 workspaces, 7 memberships не изменились, SHA-256 до и после — `acd00782b131c6cc02d2a5ca546c689f04f329da643e5a60e6883538b6f89439`. Ещё один запуск: `appliedNow=[]`. Схема dev-БД — 2 миграции, `0000` и `0001`.

**Runtime на момент частичного checkpoint.** Владелец backend перезапустил скомпилированный API P1a на `127.0.0.1:4310`: `node apps/api/dist/main.js`, `APP_ENV=local`, `NODE_ENV=production`. Readiness зелёный, 2 миграции; `GET` команды и проектов возвращал реальные пустые данные. Этот процесс был загружен раньше тогдашнего последнего исправления domain; позднее заменён (широкий gate ниже).

**Не было пройдено на тот момент:** UI редактора задач и фильтров, полный корневой build, полный unit, lint и browser gate P1. Эти пункты закрыты последующими gates ниже в пределах объёма P1a.

### Широкий gate ограниченного P1a до визуальной правки — 16 октября 2026

После исправлений исходников и их заморозки, до визуальной правки трёх файлов web (следующий раздел). Команды запускал QA; runtime проверил владелец backend; визуальный просмотр выполнял координатор (следующий раздел). Рабочее дерево до первого коммита, без commit hash. Версии: Node 24.19.0, npm 10.9.2, PostgreSQL 17.5, Vitest 5.0.5, Vite 7.3.7, Playwright 1.64.1, Chrome for Testing 156.0.8078.4.

| # | Проверка | Источник | Команда | Результат |
| --- | --- | --- | --- | --- |
| 1 | Полная сборка и интеграция | QA | `npm run test:integration` | pass: сборка всех 6 workspaces и оптимизированного SPA, затем 6 файлов, 65 тестов, 19,01 с, старт 01:51:19. Лог `/tmp/workloom-final-integration.log` |
| 2 | Lint | QA | `npm run lint` | pass; проверка границ браузерного кода — 88 файлов, нарушений нет. Лог `/tmp/workloom-final-lint.log` |
| 3 | Typecheck | QA | `npm run typecheck` | pass: все workspaces и корневой QA. Лог `/tmp/workloom-final-typecheck.log` |
| 4 | Unit | QA | `npm run test:unit` | pass: core/API — 17 файлов, 271 тест, 1,20 с, старт 01:52:41; отдельно web — 9 файлов, 75 тестов, 2,58 с, старт 01:52:43. Лог `/tmp/workloom-final-unit.log` |
| 5 | Строгие проверки тестов после правки e2e | QA | `eslint tests`, корневой `tsc` | pass |
| 6 | Runtime | владелец backend | Перезапуск скомпилированного API | pass, детали ниже. QA эту проверку не дублировал |
| 7 | Browser после перезапуска | QA | `npm run test:e2e` | pass: 8 из 8, Chromium, 18,6 с. Лог `/tmp/workloom-final-e2e.log` |

Counts широкого gate (65, 271, 75, 8) не суммируются между собой, с последним targeted gate и с ранними 50, 56, 15, 29, 14, 123 и 96.

**Интеграция, 65 тестов.** Включает фактические наборы P0 и P1a. 20 случаев защиты URL тестовой БД выполняются без открытия БД; остальные — на реальном PostgreSQL в изолированных одноразовых базах. Сборка вывела нефатальную upstream-аннотацию Rollup и предупреждение о размере chunk: 694,96 КБ JS, 214,68 КБ gzip. Это не ошибка; бюджет производительности не заявляется и не проверялся.

**Правка после полного gate.** После строк 1–4 изменён только файл e2e-теста: по запросу координатора добавлено ограниченное создание дочерней задачи через реальный UI карточки. Повторно прошли `eslint tests` и корневой `tsc` (строка 5). Исходники продукта и dist после полного gate не менялись до визуальной правки ниже.

**Runtime.** Прежний API (сессия 55637, PID 83666) завершился штатно по SIGTERM. Новый скомпилированный процесс: сессия 9394, PID 2266, Node 24.19.0, `127.0.0.1:4310`, те же `APP_ENV=local`, `AUTH_MODE=dev`, `NODE_ENV=production`; PostgreSQL и его данные сохранены. Readiness: база и схема в порядке, 2 миграции. Контракты `me`, workspaces и projects отвечают. HTML совпадает со свежим dist; `index-CrlZaw_j.js` и `index-tWwdNWwO.css` отдаются с кодом 200 и корректными типами; неизвестный API даёт JSON 404 даже при `Accept: text/html`. Эта проверка HTML и assets относится к сборке до визуальной правки; текущие assets проверены позже (следующий раздел).

**Browser, 8 тестов.**

- P0: шесть исторических тестов снова прошли. Три из них — проверки состояний UI с явной маркировкой: задержанный реальный ответ, mock 503 с реальным retry, mock пустого списка.
- P1a, desktop: проект и задача с двумя участниками созданы через реальный UI; PATCH заголовка, оценки и участников с точными ревизиями. Дочерняя задача создана из карточки: по умолчанию детализация, оценка только для чтения 2:00, свойство оценки в запрос не отправляется, после перезагрузки тот же пакет со 120 мин. Фильтры по участнику и поиску дают реальные запросы к серверу; для них используется отдельная синтетическая задача, созданная через API.
- P1a, mobile 390×844: проект и задача, созданные через реальный API, только просмотр без редактирования; поля проверены в таблице и в карточке; горизонтального переполнения `document.body` нет.
- Не проверялись: общий Auth и старые вкладки.

**Находки review.** Это unit/component-проверки, а не доказательства общего Auth или отказа БД.

- Тесты архивного tag и отозванного участника: 14 pass после исправления только фикстуры (микросекунды, см. частичный checkpoint).
- Отложенный вызов B того же hook при ожидающем A воспроизведён (12 pass, 1 fail); после исправления продукта (single-flight) — 13 из 13 pass.
- Ожидающие NameForm и TagForm показывают отправленный snapshot; очистка при смене actor offline; сохранённые недоступные участники; предупреждения при смене pathname, unload и смене actor. Проверены в составе 75 web-тестов.
- Ожидание фикстуры навигации «Назад» исправлено: «Назад» только по query разрешён, «Назад» со сменой пути показывает предупреждение. Строгая типизация исправлена до заморозки.
- Foundation после исправлений повторно прочитал ограниченный объём и других блокеров не нашёл.

**Demo-данные и capture.** Созданы после browser gate через API: отдельный проект «Запуск команды Workloom», секция «Первая неделя», 4 задачи с понятными русскими названиями, 2 участника. Оценки: общий пакет корневой и дочерней задачи — 180 мин, независимая задача — 120 мин, added scope — 60 мин; уникально 360 мин в 3 пакетах. Другие данные не изменялись; demo оставлены для просмотра.

- Проект: <http://127.0.0.1:4311/w/5eed0000-0000-4000-8000-000000000201/projects/f92c4652-8bbb-4ccd-9982-c5e7dff1fc79>, корневая задача — query `?task=82e8c29e-2275-496e-9a4a-01ae6d0211df`. Метаданные — `/tmp/workloom-demo-preview.json`, без credentials.
- Скрипт `/tmp/workloom-demo-preview.mjs` написан Claude (`claude-opus-5-5`). Запись CLI в `/tmp` была запрещена правами, поэтому координатор сохранил точное содержимое, написанное Claude. Первый capture упал из-за scoped-локатора `has` в самом скрипте, ошибки продукта не было; Opus исправил локатор, повторный прогон только с GET — pass. Лог `/tmp/workloom-final-demo-capture-repeat.log`.
- Capture проверяет реальные DTO, 3 ч в таблице и 6 ч уникальной оценки, двух участников, отсутствие переполнения страницы на mobile, отсутствие необработанных ошибок страницы и API. В counts тестов не входит.

### Визуальная проверка: fail → исправление → pass

**Fail.** Координатор просмотрел ровно 3 исходных demo-изображения: `p1a-demo-desktop-table.png`, `p1a-demo-desktop-drawer.png`, `p1a-demo-mobile-drawer.png`. Найдены 2 проблемы: на desktop 1440 колонка оценки, её заголовок и агрегат 6 ч уходили за пределы видимой области; на mobile плавающие sticky-действия перекрывали поле даты, и под ними просвечивали следующие подписи. Приёмка и коммит были приостановлены.

**Исправление.** Frontend (Claude CLI, `claude-opus-5-5`) изменил только `TaskTable.tsx`, `TaskDrawer.tsx` и `DialogShell.tsx`: оценка, её заголовок и агрегат закреплены справа на непрозрачном фоне; внутреннее тело карточки обрезается и прокручивается, а действия вынесены в отдельную закреплённую непрозрачную панель. API, domain и БД не менялись. Кроме этих трёх файлов, изменён только файл e2e-теста (проверки геометрии).

**Архив.** Все 9 изображений P1a, снятых до правки, сохранены в подкаталоге `p1a-before-visual-fix/` того же каталога evidence. До правки координатор просмотрел только 3 названных выше; остальные 6 координатором не просматривались.

### Последний targeted gate после визуальной правки — 16 октября 2026

Рабочее дерево до первого коммита, без commit hash.

| # | Проверка | Источник | Команда | Результат |
| --- | --- | --- | --- | --- |
| 1 | Фокусные проверки изменённых файлов | владелец frontend | Тесты `TaskTable`, строгий typecheck web, lint трёх файлов | pass: `TaskTable` — 11 тестов; typecheck и lint pass |
| 2 | Сборка web | QA | `npm run build --workspace @workloom/web` (строгий tsc web + Vite 7.3.7) | pass. JS `index-yutsbqYd.js` — 695,32 КБ, 214,89 КБ gzip; CSS `index-CeTzM8yJ.css` — 48,77 КБ. Те же нефатальные upstream-аннотация и предупреждение о размере chunk. Лог `/tmp/workloom-visual-fix-web-build.log` |
| 3 | Весь набор web | QA | `npm run test --workspace @workloom/web` (по запросу координатора, так как изменён `DialogShell`) | pass: 9 файлов, 75 тестов, 3,00 с, старт 02:01:44. Лог `/tmp/workloom-visual-fix-web-tests.log` |
| 4 | Строгие проверки тестов | QA | `eslint tests --max-warnings=0`, `tsc -p tsconfig.json` | pass после добавления проверок геометрии (изменён только файл теста) |
| 5 | Browser | QA | `npm run test:e2e` | pass: 8 из 8, 13,3 с. Лог `/tmp/workloom-visual-fix-e2e.log` |
| 6 | Повторный capture demo | QA | Скрипт demo только с GET, Chromium 156.0.8078.4 | pass; те же demo IDs и данные, без изменений. Лог `/tmp/workloom-visual-fix-demo-capture.log` |
| 7 | Отдача новой сборки на `4310` | QA, затем владелец backend | Read-only HTTP smoke после сборки web, без перезапуска API | pass, детали ниже. Лог QA `/tmp/workloom-visual-fix-served-assets.log` |
| 8 | Визуальный просмотр | координатор | Просмотр 4 текущих изображений | pass, детали ниже |
| 9 | Очистка тестовых БД | QA | SQL-проверка после интеграции | pass: остались только `workloom_dev` и `workloom_test`, одноразовые базы удалены; demo-данные P1a целы |
| 10 | Ссылки в `docs/` после предыдущей редакции журнала | QA | Локальная проверка Markdown-ссылок | pass: 12 документов, 126 локальных ссылок, 0 битых. Эта правка ссылок не добавляет; финальный повтор — за QA |

**Что не перезапускалось.** Интеграция 65, core/API unit 271, корневые `npm run lint` (88 файлов) и `npm run typecheck`, а также полная сборка всех 6 workspaces выполнены в широком gate до правки трёх файлов web и после неё не повторялись. Повтор не требовался: API, domain и БД не менялись. Изменённые файлы покрыты строгим typecheck web, фокусным lint, сборкой web, набором web 75 и browser 8 из этого раздела. Утверждения о последней полной сборке всех 6 workspaces нет.

**Browser, 8 тестов.** Те же 6 тестов P0 и 2 теста P1a; все прежние проверки функций, дочерней задачи, фильтров, перезагрузки и P0 сохранены. Добавлены проверки геометрии:

- desktop 1440: заголовок задачи, заголовок оценки, ячейка корневой задачи и агрегат находятся внутри обрезанной области таблицы при `scrollLeft = 0`;
- mobile 390: поля даты, оценки, участников и tags вместе с подписями находятся во внутреннем прокручиваемом теле над закреплённой непрозрачной панелью, без просвечивания и перекрытия; кнопка Save видима, активна и достижима; горизонтального переполнения страницы нет.

**Отдача сборки.** Сначала read-only smoke выполнил QA (лог выше). Затем координатор снова подключил владельца backend, и тот независимо, тоже read-only, подтвердил тот же SHA-256 index, коды 200, типы и размеры новых JS и CSS, а также побайтовое совпадение тел обоих assets с текущим dist. Перезапуска, сборки, изменений кода и PostgreSQL при этом не было; новых тестов эти проверки не добавляют. API не перезапускался: тот же скомпилированный процесс (сессия 9394, PID 2266) отдаёт новый dist через wildcard и `sendFile`. Отданный index точно совпадает с `apps/web/dist/index.html`, SHA-256 `960f37d1880314d8efd3a48ce6d78ceb0da692e406d36dca15b05eec4b27f8cd`. `index-yutsbqYd.js` — 200, `application/javascript`, 695 319 байт; `index-CeTzM8yJ.css` — 200, `text/css`, 48 769 байт. Ready — 200, база и схема в порядке.

**Визуальный просмотр, pass.** Координатор просмотрел ровно 4 текущих изображения: оценка, её заголовок и 6 ч видны; закреплённая непрозрачная панель без просвечивания содержимого; участники и tags доступны над панелью; других блокеров нет. Просмотр всех текущих изображений не заявляется, просмотр человеком не выполнялся. 3 изображения, просмотренные до правки, учитываются отдельно; статус P0 (координатор просмотрел 2 из 5) не изменился.

- [p1a-demo-desktop-table.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p1a-demo-desktop-table.png)
- [p1a-demo-mobile-drawer.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p1a-demo-mobile-drawer.png)
- [p1a-demo-mobile-drawer-participants.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p1a-demo-mobile-drawer-participants.png)
- [p1a-mobile-task-drawer-bottom.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p1a-mobile-task-drawer-bottom.png) — новое изображение из browser gate: низ карточки на mobile

Остальные текущие изображения P1a лежат под прежними именами в каталоге `/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/` и после правки координатором не просматривались.

## P1b — частичный checkpoint API/DB, 16 октября 2026 (исторический)

На момент частичного checkpoint: рабочее дерево после source A `cf586b324a22dd2f77336c2fd6657f87b94c3f1f` и docs-only B `5a398228648e314b7cde5825253a0b1e264dcfc1`, нового коммита ещё нет; срез тогда в работе, **не принят**: web/browser, screenshots и визуальный просмотр ещё не выполнялись. До согласованного gate процесс `4310` сохраняет прежние загруженные модули P1a; новые API-проверки используют отдельные реальные процессы и одноразовые базы. Параметры непрерывного прогона и фактический переход модели — в [12](12-active-run.md).

**Происхождение.** HTTP acceptance (`p1b-fields.test.ts`, helper `support/p1b.ts`) записал Claude Code `--model opus --effort high`, resolved `claude-opus-5-5`, session `d6fcb3e9-e3fa-4fb3-97c2-98f74c4506b3`; следующий запрос получил фактический quota rejection. Policy-сессия `193b2f21-1f53-4de6-be13-4fa3be70a65f` исчерпала квоту до записи файла. После подтверждённого root fallback QA через Codex `gpt-6.1-sol` high написал `p1b-field-policy.test.ts`, browser-сценарии (пока не запускались), исправил ESLint import types и JSON-привязку SQL-фикстуры. Авторство не переатрибутируется Claude. Проверки запускал QA; отдельные owner-результаты явно помечены.

| Проверка | Кто / команда | Фактический результат |
| --- | --- | --- |
| Core exports/build | foundation: contracts → domain → db | pass, настоящие domain service и `createTaskFieldApplication`, без stub; отдельная сборка API QA — pass (`/tmp/workloom-p1b-api-build.log`) |
| Обновление заполненной dev-БД P1a → P1b | foundation: фактический migrator, затем повтор | pass: применена `0002_p1b_fields`, current/3 migrations; counts и SHA-256 целых JSON-строк всех 14 прежних таблиц неизменны (включая 21 audit/outbox/idempotency, 12 tasks, 9 packages, 13 participants). Повтор `applied=[]`; SQL/snapshots и первые 2 записи журнала 0000/0001 не изменены. Proof `/tmp/workloom-p1b-upgrade-preservation.json` содержит только counts/hashes |
| Фокусная HTTP-интеграция | QA: `vitest run --project integration tests/integration/p1b-fields.test.ts` | pass: 15/15, 5,41 с, local02:40:41; 5 процессов API и реальные отдельные пулы PostgreSQL. `/tmp/workloom-p1b-http-gate.log` |
| Shared policy / реальные SQL constraints и rollback | QA: `vitest run --project integration tests/integration/p1b-field-policy.test.ts` | pass: 3/3, 2,10 с, local02:39:43; после добавления позднего SQL fault на INSERT idempotency result — targeted pass 3/3, 1,97 с, local02:45:44. `/tmp/workloom-p1b-policy-gate.log` |
| Все корневые integration на актуальных core/API | QA: `vitest run --project integration` без повторной сборки web, явная тестовая БД | pass: 83 теста / 8 файлов, 21,65 с, local02:43:39; включает 18 фокусных выше, counts не суммировать. `/tmp/workloom-p1b-integration-gate.log`. Скомпилированный SPA в этом прогоне прежний P1a, это не приёмка P1b UI |
| Root/core/API unit | QA: `vitest run --project unit` | fail: 422 pass / 1 fail из 423, 21 файл, local02:41:28; старое ожидание списка миграций содержало только 0000/0001. Foundation исправил только owned test-каталог на фактическую 0002; affected suite13/13 pass. Тогда широкий unit ещё не повторялся; последующий полный pass423 приведён ниже. `/tmp/workloom-p1b-core-api-unit.log` |
| Unit API | backend: строгий API typecheck и unit | pass: 227/6 файлов против актуальных compiled core; это transport unit, не DB proof |
| QA type/lint | QA: `tsc --noEmit -p tsconfig.json`; ESLint четырёх новых acceptance/helper-файлов | pass; `/tmp/workloom-p1b-qa-typecheck.log`, `/tmp/workloom-p1b-qa-lint.log`. Полные корневые web lint/build/typecheck ждут source freeze |

**Инварианты HTTP.** Все 9 типов сохраняются и читаются вторым процессом; missing row, typed null, `0`, `false`, `[]` и пустой текст различаются. Значения не меняют revision задачи, package или участников. Shared columns, archive/restore, immutable type, стабильные option IDs, сохранение архивных options и отозванных person references до явного удаления. Новая неподходящая ссылка отклоняется. Отключение истории сохраняет прежние записи, включение не backfill; значения-sentinels отсутствуют во всём JSON всех generic audit/outbox строк при обоих режимах, сами dedicated history entries содержат разрешённые значения и immutable definition snapshot. Идентичная новая команда меняет только idempotency result row; точный replay не меняет ничего; тот же ключ с иной целью →409. Lock, актуальные права при replay, stale value/definition, viewer/member capabilities, foreign tenant/project и подписанные task/field/actor-bound cursors. Две реальные API/pool записи одной revision дают ровно 200/409.

**SQL и shared domain.** Lock проверен для `web/api/mcp/job/import` через общую application, без заявления об implemented MCP/import/job transports. Реальные BEFORE INSERT triggers дали ранний fault outbox и поздний fault idempotency result (после записи value/history/audit/outbox): current value, dedicated history, audit, outbox, workspace sequence и idempotency полностью откатились; после удаления синтетического fault тот же ключ успешен ровно один раз. Malformed JSON (missing type/value, неизвестный и известный неправильный discriminator), missing snapshot identity и неправильный definitionVersionId отклоняются SQLSTATE23514 без изменения whole-table digests. Перед генерацией 0002 backend нашёл SQL CHECK NULL loophole, foundation добавил `IS TRUE`, обязательные ключи и SQL-only immutable snapshot/type guards; именно исправленная миграция проверена. Первый запуск SQL-теста дал22023 из-за сериализации JSON-параметра фикстуры: привязка через `::text::jsonb` исправила тест, ошибки продукта в этом падении не было.

**Product authoring P1b, подтверждено владельцами по фактическим Write/Edit.** Claude CLI `--model opus --effort high`, resolved `claude-opus-5-5`: core contracts/public port `3f8d6577-1244-46cb-ad03-2e3a7e189597`, internal ports `ff9c50f1-4396-486e-a102-9d0890139a3b`, schema/client/SQL NULL fix/manual0002 guards+journal `9d6b74d6-2e07-4643-937c-e1ff557fb6d2`, service/tests/index `e754d51e-15fe-4eac-ae72-6845de81d08a`, repository/history codec/tests `c06115ce-8275-4787-bcd7-eec5b0350ac5`; последние две сессии quota-rejected после записи, файлы сохранены. SQL/snapshot 0002 сначала создал настоящий Drizzle generator, затем Claude добавил SQL-only guards. Core Codex fallback изменил только DB factory/composition exports и ожидание каталога миграций в тесте. API handlers/transport tests — Claude session `8d830e84-40c2-4a0e-9d05-c4d144f63e5a`.

Web Claude passes: data `163997aa-7d33-4fb8-8045-d03299cd0cec`, editors `4a4b6ae5-46af-46a1-9400-76a4f97b534c`, manager `0474225e-0f83-4ae1-b13f-750b23ed2a75`, value/history `a16e23c9-37f9-4ef5-839d-c5d9b9415e34` (успел записать 3 файла), integration `3d8f76b4-79e2-4622-86d1-ef53a69bb856`. Rejected-before-write lifecycle test запуск не приписывается Claude: Codex fallback завершил его, numeric/denial/draft/recovery fixes, fixtures и 7 regressions. Последующие 3 визуальные правки также делает Codex fallback. Все команды проверки запускали агенты, не CLI.

### P1b — широкий gate до визуальной правки (исторический)

После трёх ограниченных frontend review-исправлений (неотправленный value draft при переключении задачи, cached manager metadata после403/404, восстановление held update скрытой/архивной колонки) frontend объявил source freeze; backend независимо перечитал эти области и получил7/7 фокусных regressions pass. Дальнейшие результаты относятся к одному замороженному кандидату без изменений product source после сборки.

| Проверка | Кто / команда | Результат |
| --- | --- | --- |
| Полная сборка | QA: `npm run build` | pass: все 6 workspaces и оптимизированный P1b SPA. `/tmp/workloom-p1b-final-build.log`; JS 775,80 KB / gzip 235,90 KB, нефатальный chunk warning, отдельный performance budget не проверялся |
| Полный lint | QA: `npm run lint` | pass, 109 browser source boundaries, 0 нарушений; `/tmp/workloom-p1b-final-lint.log` |
| Полный typecheck | QA: `npm run typecheck` | pass, 6 workspaces и корневые QA/config types; `/tmp/workloom-p1b-final-typecheck.log` |
| Корневые unit, current | QA: `npm run test:unit` (core/API часть) | pass: 423 теста / 21 файл, 1,33 с, local02:48:10; старый migration catalog test исправлен, текущий полный gate зелёный. `/tmp/workloom-p1b-final-unit.log` |
| Web component unit, current | QA: web часть той же команды | pass: 102 теста / 14 файлов, 3,79 с, local02:48:11; отдельная область, с 423 не суммировать |
| Browser | QA: `npm run test:e2e`, Chromium/реальныйAPI/PG | pass: 10/10, 20,7 с; 6 P0 + 2 P1a + 2 P1b, `/tmp/workloom-p1b-final-e2e.log`. Прежние P0 mock UI-state tests остаются отдельно описанными; новые P1b без route mocks |
| Интеграция | QA | Ранее 83 теста / 8 файлов на неизменном core/API; позднее targeted 3/3 после усиления rollback assertions. Ради web freeze 83 повторно не запускались; counts прогонов не суммировать |
| Runtime | backend | Старый session 9394 / PID 2266 остановлен корректно; новый compiled API session 55735 / PID 27474, Node 24, та же безопасная local dev identity. Ready 200 database/schemaOK; actual demo fields 200 и columns 200 / revision 1 schema-valid. NativePG и прежний demo сохранены. финальная GET-only проверка нового dist приведена ниже |
| Визуальная проверка | координатор | fail после просмотра всех 8: при скролле теряется название задачи, нужна лучшая раскладка History/Close и overlay вложенного диалога должен затемнять drawer. На тот момент web-правки и приёмка ожидались; последующий pass ниже |

**Реальные P1b browser действия.** Desktop 1440: через UI созданы текстовая, числовая и boolean колонки; запись/изменение значений, `0` и `false`, reload и 2 записи истории; общий manager показывает history/lock controls. Второй UI page включает lock, старый открытый editor отправляет PUT и получает 409 `FIELD_LOCKED`; сохранённое прежнее значение проверено API и не изменилось. Все 3 custom headers видны при горизонтальном скролле таблицы, pinned estimate и aggregate остаются в её viewport. Mobile 390: API setup отдельного проекта/полей явно указан в названии теста; UI сохраняет число 7, reload и history; поля доступны над прежним anchored opaque footer без page overflow. Предыдущие8browser случаев сохраняют создание detail child со shared estimate, фильтр участников и прежнюю геометрию.

Новый читаемый preview проекта с 3 полями: `http://127.0.0.1:4311/w/5eed0000-0000-4000-8000-000000000201/projects/c14bdd8a-ff4e-4468-a4e8-e95f4453c1fb`; задача `4795798e-31d7-4e97-b329-81ec8e633b85`. Старый demo «Запуск команды Workloom» не изменялся. Все 8 screenshots просмотрел координатор, найдены 3 визуальные проблемы выше. Исходные изображения сохранены в `p1b-before-visual-fix/`; это модельный просмотр координатором, не человеком:

- [p1b-desktop-custom-table.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p1b-before-visual-fix/p1b-desktop-custom-table.png)
- [p1b-desktop-column-manager.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p1b-before-visual-fix/p1b-desktop-column-manager.png)
- [p1b-desktop-value-editor.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p1b-before-visual-fix/p1b-desktop-value-editor.png)
- [p1b-desktop-value-history.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p1b-before-visual-fix/p1b-desktop-value-history.png)
- [p1b-desktop-lock-refusal.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p1b-before-visual-fix/p1b-desktop-lock-refusal.png)
- [p1b-mobile-column-manager.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p1b-before-visual-fix/p1b-mobile-column-manager.png)
- [p1b-mobile-task-fields.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p1b-before-visual-fix/p1b-mobile-task-fields.png)
- [p1b-mobile-value-history.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p1b-before-visual-fix/p1b-mobile-value-history.png)

### P1b — targeted gate после визуальных исправлений

После просмотра 8 previsual images root запросил ровно 3 ограниченные правки. Codex fallback изменил только `TaskTable.tsx`, `FieldValueForm.tsx`, `DialogShell.tsx`: desktop task name закреплено слева рядом с прежней правой оценкой; primary/secondary действия значения разнесены; вложенные overlay/content получают корректный порядок слоёв, backdrop затемняет underlying drawer. API/domain/schema после широкого gate не менялись.

| Проверка | Кто / команда | Результат |
| --- | --- | --- |
| Web source checks | frontend: полный web suite, strict typecheck, scoped lint 3 файлов | pass: 102 теста / 14 файлов; types/lint pass после общей DialogShell layering правки. Это текущий owner-прогон, отдельно от previsual QA 102 |
| Web build | QA: `npm run build --workspace @workloom/web` | pass; `/tmp/workloom-p1b-visual-web-build.log`. JS 776,96 KB / gzip 236,48 KB, CSS 50,40 KB; nonfatal chunk warning, performance budget pass не заявляется |
| QA types/lint | QA: корневой QA `tsc --noEmit -p tsconfig.json`, ESLint изменённого browser test | pass; `/tmp/workloom-p1b-visual-qa-typecheck.log`, `/tmp/workloom-p1b-visual-qa-lint.log` |
| Browser current | QA: `npm run test:e2e` | pass: 10/10, 19,7 с; `/tmp/workloom-p1b-visual-e2e.log`. Те же функции + новые геометрические assertions ниже |
| Optimized current dist | backend: GET-only actual bodies на 4310 и побайтовое сравнение с диском | pass: ready 200 `{status:'ok',checks:{database:'ok',schema:'ok'}}`; HTML 200 text/html exactdist SHA-256 `e327dc51984a07731897432ed04a4cc527d7edddbd16ba7f4505622ee8767e88`; JS `index-BxiyJYRS.js`776959 байт, 200 application/javascript, CSS `index-BbIm4CQs.css`50396 байт, 200 text/css, оба byte-identical dist. Тот же API session 55735 / PID 27474, без restart/build/data writes при smoke |
| Root visual | координатор | pass: просмотрены ровно 4 текущих изображения (desktop table/editor/history и mobile history); все 3 findings устранены, bounded P1b принят. Остальные 4 текущих изображения не просмотрены; исторические 8 fail отдельно сохранены |

**Геометрия.** При горизонтальном конце таблицы title задачи и правый estimate находятся внутри видимой области. History/Close bounds не пересекаются при переносе. Точка снаружи верхнего editor/history, но поверх underlying drawer, попадает в viewport-covering backdrop, а не в control нижнего диалога (desktop и mobile history). Прежние pinned estimate/aggregate, opaque footer, reachable late fields и no page overflow сохранены. Это наблюдаемое поведение браузера, без assertions на CSS class names.

**Что не повторялось.** Core/API 423 и integration 83 после трёх визуальных файлов не повторялись — соответствующий source не менялся. Последняя полная сборка 6 workspaces и полные root lint/typecheck относятся к previsual gate; текущий web покрыт новым build, owner 102/types/lint и browser 10. Counts не суммируются; полное P1/MVP не заявляется.

**Визуальная приёмка.** Root просмотрел `p1b-desktop-custom-table.png`, `p1b-desktop-value-editor.png`, `p1b-desktop-value-history.png`, `p1b-mobile-value-history.png`: title и estimate видны при скролле, footer читаем, backdrop затемняет drawer. Это просмотр модели-координатора, не человеком. Другие 4 текущих кадра сняты, но повторно root не просматривал.

Текущий новый preview: `http://127.0.0.1:4311/w/5eed0000-0000-4000-8000-000000000201/projects/5e48f22b-0d32-490a-96be-0acf817425c6`, task `0e80f751-bdd0-4b8a-b0ae-4ea77a740682`. Это новый синтетический UI-набор, прежние demo не изменены. Все 8 frames пересняты после правок, долговременные текущие файлы:

- [p1b-desktop-custom-table.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p1b-desktop-custom-table.png)
- [p1b-desktop-column-manager.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p1b-desktop-column-manager.png)
- [p1b-desktop-value-editor.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p1b-desktop-value-editor.png)
- [p1b-desktop-value-history.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p1b-desktop-value-history.png)
- [p1b-desktop-lock-refusal.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p1b-desktop-lock-refusal.png)
- [p1b-mobile-column-manager.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p1b-mobile-column-manager.png)
- [p1b-mobile-task-fields.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p1b-mobile-task-fields.png)
- [p1b-mobile-value-history.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p1b-mobile-value-history.png)

**Source checkpoint P1b.** После принятия root создал локальный source commit `dee59bae06be4505b4a60e0bf469d31c8816aeda`; рабочее дерево сразу после коммита чистое. Он фиксирует принятый P1b, без повторного запуска тестов ради commit hash. Результаты выше относятся к замороженному рабочему дереву до этого checkpoint; точные области широкого и postvisual targeted gate сохраняются. Эта последующая правка только записывает provenance, исходники/runtime/данные не меняет; push не выполнялся.

### Текущий статус по областям

| Область | Статус | Примечание |
| --- | --- | --- |
| P0: workspace, участники, health, dev identity | pass (локально, синтетическая identity) | Исторический checkpoint; текущие регрессии integration120; prior14 cases passed в initial P3a browser16, новые2 прошли targeted после QA corrections |
| P1a: API и PostgreSQL | pass (локально, dev identity) | Исторический gate P1a; текущие регрессии integration120 и core/API unit643 |
| P1a: web и browser UI | pass (локально, синтетическая identity) | Исторический gate; прежние14 browser cases прошли initial P3a16; P3a targeted2 отдельно. Web161 до final plan-only cleanup, affected components30 после него; отдельно от PostgreSQL |
| Оптимизированный dist и runtime | pass (локально) | Current compiled P3a `4310` session32694 / PID65721, ready database/schemaOK; definitive current HTML/JS/CSS parity ниже. `NODE_ENV=production` при `APP_ENV=local`, `AUTH_MODE=dev` |
| Docker Compose PostgreSQL | не исполнялся | Docker недоступен на хосте |
| P1b: typed custom columns, значения, выборочная история, custom lock | pass, локально принят координатором | Integration 83 и core/API 423 до 3 visual files; current owner web 102, browser 10, root visual 4. Полный P1 не заявляется |
| P2a: недельный план, freeze, manual fact, pinned report | pass, локально принят координатором | Core/API509, realPG96, current web119/browser12; подробности ниже. Полный P2 не заявляется |
| P2b: категории работы, all-fact report, table quick entry | pass, локально принят координатором | Integration105, core/API566, web126; initial browser14=13pass/1fixturefail, corrected targeted2 pass; root visual7. Полный P2 не заявляется |
| P3a: разовые shared meetings, explicit plan и attendance | pass, bounded scope принят координатором | Core/API643, realPG120, populated0005/raw3replay; web161 и affected30 после final plan cleanup; initial16=14pass/2QA locatorfail, финальный targeted2 pass9,3с. Root просмотрел8 pre-cleanup и4 current surfaces. Source checkpoint `9443e063aba5b15eedb41b4ed6f4f43c68cf4baf` |
| Полный P1: приватные ACL, сохранённые представления, массовые правки | не реализовано | Будущее, приёмка P1 в [06](06-implementation-plan.md) не изменена |
| Полный P2, P3–P6, полный MVP, пилот | не завершено | Ограниченные P2a/P2b/P3a описаны ниже; split/transfer/carryover/close, daily work logs, recurrence/worker остаются будущими |
| Общий Auth, приватные встречи | не реализовано | — |
| Старая вкладка / обновление | не реализовано | — |
| Worker и фоновые jobs | не реализовано | — |
| Backup / restore | не проверялось | Восстановление кластера после ENOSPC сюда не относится |
| Внешние календари K01–K11 | не реализовано | После пилота P6, см. [10](10-calendar-integration.md) |
| Deployment / production | не выполнялось | — |

## Как обновлять

1. Менять статус только после реального запуска команды из корня репозитория как явного рабочего каталога.
2. Для каждой записи указывать дату, команду, commit hash или «рабочее дерево без коммита», результат, кто выполнил и путь к логу.
3. Падение записывать как `fail` с сутью вывода; недоступную среду — как `blocked` с причиной. In-memory замена PostgreSQL не считается pass.
4. Не публиковать пароли, tokens и строки подключения с credentials.
5. Сохранять фактическое происхождение: кто выполнил проверку, какая модель и с какими параметрами.
6. Объявлять этап принятым только после pass всех его проверок; строки будущих этапов при этом не меняются.
7. После первого коммита записать его hash и перепроверить затронутые строки.


## P2a — текущий gate, 16 октября 2026

Кандидат после принятого P1b source `dee59bae06be4505b4a60e0bf469d31c8816aeda` и docs-only `67ca7d47ca8ca456300c5d85550d2b5a01efa47d`; последующий принятый source checkpoint P2a — `fd69f3748a8538ad45e9480c0cfecd70ad7e2c9c`. Точный ограниченный каталог — [13](13-p2a-contract.md). Реализованы недельные периоды, личные commitments/allocations, source-fresh self/project freeze, identity locks, ревизии ручного недельного факта и закреплённые отчёты. Ограниченный P2a принят координатором после targeted timezone correction и просмотра4 текущих кадров ниже. Полный P2 и P2b не приняты.

**Авторство.** Весь новый P2a код core/API/web, acceptance и документация написаны разрешённым Codex `gpt-6.1-sol` high fallback после фактического Claude quota rejection. Новых Claude-сессий или проб не было. SQL/snapshot0003 создал установленный Drizzle generator; immutable/identity guards добавлены в SQL под тем же fallback. Команды запускали владельцы и QA, происхождение P0/P1a/P1b не переатрибутируется.

| Проверка | Кто / команда | Фактический результат |
| --- | --- | --- |
| Первый focused HTTP/PG | QA: два новых integration файла | fail: 9 pass / 4 fail из 13, 15,55 с, local03:18:35; `/tmp/workloom-p2a-focused.log`. Три настоящих500 на correction/void: BEFORE INSERT revision1 guard срабатывал до ON CONFLICT UPDATE. Foundation заменил upsert на INSERT только первой revision и scoped UPDATE существующей, сохранив строгий trigger. Четвёртое падение — слишком строгое QA ожидание: 3 новых locked команды должны сохранить 3 tagged idempotent rejection rows, остальные таблицы неизменны |
| Focused HTTP/PG после исправления | QA: те же 2 файла | pass: 13/13, 14,16 с, local03:20:48; `/tmp/workloom-p2a-focused-fixed.log`. Оба cutoff случая были зелёными уже в первом прогоне; exact constraint message у500 не сохранён, выдуманное диагностическое сообщение не приводится |
| Полная сборка кандидата | QA: `npm run build` | pass: 6 workspaces и SPA; `/tmp/workloom-p2a-final-build.log`. Это сборка до bounded week-selector UI correction; окончательная web сборка ниже после неё. Nonfatal large chunk warning не является performance budget pass |
| Полный lint / typecheck | QA: `npm run lint`, `npm run typecheck` | pass: 126 browser boundaries, 6 workspace types + QA/config; `/tmp/workloom-p2a-final-lint.log`, `/tmp/workloom-p2a-final-typecheck.log`. До week-selector correction; новый P2 browser файл отдельно прошёл ESLint и root QA `tsc -p tsconfig.json` |
| Корневые core/API unit | QA: `vitest run --project unit` | pass: 509 тестов / 24 файла, 2,13 с, local03:29:12; `/tmp/workloom-p2a-final-unit.log`. Web suite отдельно, counts не суммировать |
| Полная реальная интеграция | QA: `vitest run --project integration`, явная test БД | pass: 96 тестов / 10 файлов, 34,69 с, local03:29:31; `/tmp/workloom-p2a-final-integration.log`. Включает focused13 выше, counts не суммировать. Отдельные реальные API процессы и одноразовые PostgreSQL БД |
| Заполненная dev-БД P1b → P2a | foundation: quiet window, migrator и повтор | pass: whole-row SHA256/counts всех21 прежних таблиц неизменны; применена только0003, current4; повтор[];6 старых SQL/snapshot файлов0000–0002 и первые3 journal entries неизменны. `/tmp/workloom-p2a-upgrade-preservation.json` без credentials. Drizzle32 tables/no schema changes pass в изолированной копии |
| Runtime | QA после quiet release | Прежний P1b API55735/PID27474 остановлен корректно; новый compiled API13923/PID39599, Node24.19.0, loopback4310, та же synthetic local identity. Actual readiness200 database/schemaok; actual periods[] и planning-packages3 schema-valid в сохранённом прежнем demo. Оптимизированные assets после окончательной web сборки проверяются отдельно |

**Реальные инварианты.** 480 недельного плана и180+420 факта root/detail дают600, +120/+25%; общая оценка detail package и tags/participants не умножают строки. Новый объём240 отдельно, старый пакет без исходного обязательства — unplanned. Общая оценка1200 / недельный план360 / факт300 дают−60; исходная package estimate не подменяет недельную. Missing/typed null/zero/void различаются. Report сохраняет source revisions и полные серверные totals при pagination; correction текущего факта не меняет старый run. Self default строго self, чужой explicit member422, актуальные ACL проверены при replay/чтении и tenant404 не раскрывает данные.

Source freshness проверена при title, selected field, составе packages и отзыве неacting member. Locks действуют на отсутствующую строку значения/unknown estimate и переживают удаление участника. Первый unknown original остаётся unknown при protectEstimate:false и позднем заполнении/следующей неделе. Две реальные записи одной fact revision дают200/409. Prospective reparent allocated siblings в ancestor/child отклонён422 без частичных изменений; retained archived allocations разрешены без нового/увеличенного назначения. Removed-before-freeze commitment восстанавливается тем же ID как server-derived added и виден до факта. Legacy P1b plain-DTO idempotency rows воспроизведены в реальном PG и успешно replay после freeze без повторной мутации.

**Cutoff и rollback.** Независимая SQL transaction держит workspace barrier; реальный HTTP write ждёт, PostgreSQL clock пересекает cutoff, после release сохраняется старый self/project snapshot и committed409 с уникальными resolvable baseline IDs. Точный retry возвращает то же тело без новых событий. Late synthetic SQL fault на сохранении idempotency result после freeze откатывает все public tables и change_seq; после удаления fault тот же ключ сохраняет ровно один rejection. Это настоящая транзакция/часы PostgreSQL, не mocked clock.


### P2a — окончательный web/browser gate

Перед browser координатор нашёл ограниченный UX-дефект: список периодов из API упорядочен по UUID, а default UI выбирал первый. Frontend изменил только helper выбора/сортировки, его тест и два места WeeklyPage: явный `?period` сохраняется, default выбирает текущую неделю в её IANA zone, затем ближайшую будущую/последнюю прошлую, варианты упорядочены детерминированно по дате. Owner focused10, typecheck, scoped lint/build pass. Core/API не изменены; 509/96 ради этой web-правки не повторялись.

| Проверка | Кто / команда | Фактический результат |
| --- | --- | --- |
| Текущий полный web unit | QA: `npm run test --workspace @workloom/web` | pass: 117 тестов / 20 файлов, 5,14 с, local03:31:08; `/tmp/workloom-p2a-final-web-unit.log`. Это фактический count после helper, не предварительное ожидание113 |
| Текущий web build | QA: `npm run build --workspace @workloom/web` | pass: `/tmp/workloom-p2a-current-web-build.log`; JS845,39 KB/gzip253,23 KB, CSS51,40 KB/gzip9,59 KB. Nonfatal chunk warning; performance budget не проверялся |
| Текущий browser | QA: `npm run test:e2e` | pass: 12/12, 26,8 с; `/tmp/workloom-p2a-final-e2e.log`. Сохраняет6 P0 +2 P1a +2 P1b и добавляет2 P2a. Прежние mocked UI-state P0 случаи остаются отдельно обозначенными в именах; новые P2a без route mocks |
| Optimized runtime | backend: только GET, actual bodies и exact disk parity | pass: ready200 database/schemaok; HTML551 байт text/html, SHA256 `06822da18b22e12d0ccd240107157ff3eada8b65e93a2dfc06fab002119b4c32`; JS `index-B36_VMQV.js`845385 байт200 application/javascript; CSS `index-BpOzwoWg.css`51403 байт200 text/css. Все3 тела byte-identical текущему dist, без restart/source/data writes при smoke |
| Первый визуальный просмотр | координатор | просмотрены все6 кадров: layout приемлем, но period card показывал deadline в browser zone рядом с period zone без обозначения. Запрошена bounded zone/label correction; final pass пока нет. FullPage fixed-header artifact исправляется только способом capture, не продуктом |

**Реальный browser.** Desktop1440: API setup только project/root/detail tasks; UI создаёт период с отдельным часовым поясом недели, план480 и allocation480, свежий server freeze-preview и project freeze, факты180 root/420 detail и report600/+120/+25%. Невозможное browser-local время Europe/Berlin `2027-03-28T02:30` отклонено до любого POST periods (observer настоящих request). Затем валидное время сохраняется. После API correction текущего root факта old pinned run после hard reload неизменен; новый UI report660, dropdown возвращает старый600. Mobile390: API setup периода/плана/freeze явно обозначен; UI вводит300 факта против360 недельного плана при1200 whole estimate, получает−60, показывает chart и после reload тот же сохранённый run. Desktop/mobile без page-level overflow; локальный table overflow допустим. Прежние pinned task name/estimate, nested backdrop, spacing и opaque action panel assertions P1a/P1b сохранены.

Preview: `http://127.0.0.1:4311/w/5eed0000-0000-4000-8000-000000000201/projects/225ea5a2-1cce-45aa-879c-a34c60eadaf8/week?period=dbd3e2bc-fde9-440a-9c12-a4618b93573d&view=report&run=82d7a39b-558b-4bca-8c85-391bc1b74c78`. Старые P1a/P1b demo сохранены. Первые6 screenshots просмотрены координатором и сохранены в `p2a-before-zone-fix/`. Ссылки ниже — исторические кадры до правки; это модельный просмотр координатором, не человеком:

- [p2a-desktop-week-plan.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p2a-before-zone-fix/p2a-desktop-week-plan.png)
- [p2a-desktop-freeze-preview.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p2a-before-zone-fix/p2a-desktop-freeze-preview.png)
- [p2a-desktop-fact-dialog.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p2a-before-zone-fix/p2a-desktop-fact-dialog.png)
- [p2a-desktop-week-report.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p2a-before-zone-fix/p2a-desktop-week-report.png)
- [p2a-mobile-week-plan.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p2a-before-zone-fix/p2a-mobile-week-plan.png)
- [p2a-mobile-week-report.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p2a-before-zone-fix/p2a-mobile-week-report.png)

Поздний P2: split/replace/transfer/carryover/close, full-package completion accuracy, explicit late estimate acceptance и daily sources не исполнялись и не заявляются как pass. Общий Auth, worker, календари, production и старые вкладки остаются вне текущей проверки.


### P2a — targeted gate после timezone finding

Frontend изменил только formatter/его тест, WeeklyPage и route test: period card явно показывает `Срок фиксации (Asia/Nicosia)` и форматирует deadline в указанной period timezone. Browser-local input сохраняет прежнюю отдельную label. Owner focused9, strict web typecheck/scoped lint/build pass. Core/API/schema не менялись; 509 unit и96 integration не повторялись.

| Проверка | Кто / команда | Фактический результат |
| --- | --- | --- |
| Текущий web unit | QA: web suite | pass:119 тестов /20 файлов,3,80 с, local03:34:47; `/tmp/workloom-p2a-zone-web-unit.log` |
| Текущий web build / QA | QA: web build, ESLint P2 browser, root QA types | pass; `/tmp/workloom-p2a-zone-web-build.log`, `/tmp/workloom-p2a-zone-qa-types.log`; owner проверил product types/lint, QA проверил новый acceptance файл |
| Browser current | QA: `npm run test:e2e` | pass:12/12,23,2 с; `/tmp/workloom-p2a-zone-e2e.log`. Дополнительно видимая period-zone label при browser Europe/Berlin. Те же функции и прежние геометрические assertions |
| Optimized current dist | backend: GET-only readiness и exact body parity | pass: ready200 database/schemaok; HTML551 байт text/html SHA256 `bde362bbf5f63808b3aebb144a90a9786d693b179885bb1b22310daf15942f16`; JS `index-Dm_xfSoO.js`845551 байт application/javascript и CSS `index-BpOzwoWg.css`51403 байт text/css, все200 и byte-identical current dist; без writes/restart/build |
| Root visual current | координатор | pass: просмотрены ровно4 обновлённых кадра — desktop period card/report и mobile report summary/chart. Deadline zone обозначен верно, summary/chart читаемы, capture artifact устранён. Остальные3 обновлённых кадра root не просматривал; все6 исторических до zone fix были просмотрены |

Шесть прежних кадров сохранены исторически выше. Текущие report screenshots — настоящие viewport, контент прокручен под fixed header; отдельный mobile chart кадр нужен для читаемости на390px. Перенос fixed header в середину прежнего fullPage report — capture artifact, отдельной продуктовой layout-правки по нему не было.

Новый preview: `http://127.0.0.1:4311/w/5eed0000-0000-4000-8000-000000000201/projects/dc10c51e-7cac-450e-93b0-9b565b533c8e/week?period=aa53be06-b303-4854-a32d-5a129c93392b&view=report&run=8dd63756-b5cb-4fa4-8ba9-276aba3a1c2a`.

- [p2a-desktop-week-plan.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p2a-desktop-week-plan.png)
- [p2a-desktop-freeze-preview.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p2a-desktop-freeze-preview.png)
- [p2a-desktop-fact-dialog.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p2a-desktop-fact-dialog.png)
- [p2a-desktop-week-report.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p2a-desktop-week-report.png)
- [p2a-mobile-week-plan.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p2a-mobile-week-plan.png)
- [p2a-mobile-week-report.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p2a-mobile-week-report.png)
- [p2a-mobile-week-report-chart.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p2a-mobile-week-report-chart.png)


**Приёмка P2a.** Координатор принял ограниченный срез после просмотра ровно `p2a-desktop-week-plan.png`, `p2a-desktop-week-report.png`, `p2a-mobile-week-report.png`, `p2a-mobile-week-report-chart.png`. Текущие freeze-preview/fact-dialog/mobile-plan сняты, но root повторно не просмотрены. Исторические6 до timezone correction были просмотрены и сохранены отдельно. Это модельный визуальный просмотр координатором, не человеком. После приёмки root создал source checkpoint `fd69f3748a8538ad45e9480c0cfecd70ad7e2c9c` (64 файла); дерево сразу после commit чистое. Проверки относятся к замороженному рабочему дереву перед commit, ради hash не повторялись. Эта последующая правка записывает только provenance, без source/runtime/data изменений. Полный P2, P2b, MVP и пилот не достигнуты.


## P2b — текущий gate категорий и быстрого ввода

После принятого source P2a `fd69f3748a8538ad45e9480c0cfecd70ad7e2c9c` и docs-only `5f5e984715767d0435591b99a470ef764341215d`; точный каталог — [14](14-p2b-contract.md). Scope: привязка существующего single_select как типа работы, immutable category snapshot в WorkLogRevision, явная reasoned recategorization, отдельный pinned отчёт всех внесённых часов, read projection видимых task IDs и table quick entry с явной неделей/worker. Полный P2, later split/transfer/close и P3 не заявляются. Авторство новых product/tests/docs — текущий Codex `gpt-6.1-sol` high fallback; Claude не запускался, reset02:50UTC остаётся под управлением root.

| Проверка | Кто / команда | Фактический результат |
| --- | --- | --- |
| Фокусный реальный HTTP/PG | QA: `vitest run --project integration tests/integration/p2b-categories.test.ts` после API-only build | pass: 9/9, 5,74 с, local03:51:49; `/tmp/workloom-p2b-focused.log`, build `/tmp/workloom-p2b-focused-api-build.log`. Первая реальная попытка зелёная; ранние QA types выявили неверные аргументы helper и использование PATCH archive вместо существующего archive endpoint, исправлены до исполнения |
| Полная реальная интеграция | QA: `vitest run --project integration` | pass: 105 тестов / 11 файлов, 36,20 с, local03:52:24; `/tmp/workloom-p2b-integration.log`. Включает focused9, counts не суммировать. Compiled SPA в этой части ещё P2a; это не browser приёмка P2b |
| Core candidate | foundation: contracts/domain/db builds, strict types/lint; focused units | pass: factory `createWorkCategoryApplication` реально экспортирован; new8 + migration13 =21/21. Полный root unit ниже отдельно; overlap не суммировать |
| Populated P2a → P2b | foundation: quiet dev window, old-column projections, migrator и повтор | pass: все32 прежних таблицы по старым колонкам сохранили counts/hashes; старая work.set cache/hash/result, revision и pinned JSON совпадают с genuine fixture; все9 прежних work revisions имеют NULL category, без backfill. Применена только0004, current5, повтор[];8 прежних SQL/snapshot файлов0000–0003 и старые journal entries неизменны. `/tmp/workloom-p2b-upgrade-preservation.json`. Isolated Drizzle35 tables/no schema changes pass |
| Настоящая upgrade compatibility | QA: pre0004 HTTP fixture, post0004 exact raw replay + SQL/HTTP comparisons | pass: `/tmp/workloom-p2b-compat-proof.json`; детали ниже. Это фактически старый сохранённый raw запрос и результат через прежний P2a runtime, не синтетическое переписывание cache |
| Runtime | QA после quiet release | Прежний P2a session13923/PID39599 завершён SIGTERM/exit0; свежий P2b session38835/PID50268 на loopback4310, Node24.19.0 и та же local synthetic identity. Actual ready200 database/schemaok. Финальный fresh-build/runtime и JS/CSS parity — ниже после web freeze |

**Реальные инварианты.** До любого baseline 60/30/30 минут дают120 и доли50/25/25; «Без категории» входит в общий и personal denominators. Done/open/archived/detail, несколько tags/participants не умножают source. Active zero считается recorded, absent не создаёт строку, void есть в pinned diagnostic manifest с excluded=true и без часов/доли. Report по page limit1 сохраняет полный authoritative summary/manifest. Исторический source label не меняется при rename или обычном исправлении часов; bucket выбирает максимальную включённую optionRevision, поэтому поздняя коррекция старого source не возвращает старую label поверх новой. Pinned прежние run/rows неизменны.

Привязка читается без записи virtual revision, требует current fields.manage; другой тип/проект и tenant отклоняются. Retained archived option допускается в первом source, новый archived assignment запрещён; clear/rebind/archive не переписывают старые sources. Recategorization сохраняет log identity/minutes, увеличивает revision ровно раз; no-op добавляет только idempotency result, replay не меняет ничего, другой target под ключом409, stale revisions409, права worker и текущий actor ACL проверены. Два реальных API/pool writes одной revision дают200/409. Поздний synthetic fault на сохранении idempotency result полностью откатывает revision/head/audit/outbox/change_seq.

Положительный настоящий HTTP CSV query проходит обе границы wire→normalized domain, uppercase IDs canonicalized. Проекция одной root task возвращает полный package total с незагруженным detail: subject90/team105, source counts2/3; две task IDs не дублируют package. Выбор worker сохраняет actor. Absent allocation/null, allocation60, void head и active0 различаются. Duplicate/nonCSV/empty query400; несовместимый project422, foreign reference404 всего запроса без частичных данных. Malformed category SQL INSERT отклонён23514, append-only UPDATE/DELETE/TRUNCATE — фактическим42501; whole-table digests неизменны.

**Genuine upgrade proof.** До0004 QA создал отдельный synthetic project через принятый P2a runtime и сохранил `/tmp/workloom-p2a-compat-fixture.json` (0600, без credentials): raw body `{expectedRevision:null,minutes:90}`, key, category-absent response DTO, SQL cached result и payload hash `a7d0e6219b7e3e0f9dcf757b5940b9306202b5c8a8547524579b379c37ca47e9`, старую revision и pinned weekly report JSON. Source anchor действительно P2a `fd69f37`, не текущая категория. После migration первый replay вернул точно старый DTO без category. Добавление текущей taxonomy/значения задачи не backfill старые90 минут: новый type report записал90 legacy/uncategorized. Явная correction120 сохранила legacy и тот же source; второй replay исходного ключа по-прежнему вернул прежние90/revision1 без category, текущая head2 не изменилась. Ровно2 revisions, прежние cache/hash/result/old-column projection/report JSON неизменны; новый pinned type run остаётся90 после correction. Root прочитал и принял этот proof. Старые unrelated demo сохранены.


### P2b — полный source gate и ограниченный browser rerun

Frontend source заморожен после root finding: create-plan A и B одной недели ошибочно совпадали только по period/base-null. Held identity теперь включает package/member; focused deferred regression доказал A pending/lost → B сохраняет draft и blocked → exact A retry → B draft остаётся. Других product изменений после source freeze нет. Первоначальный старый actor-switch timing test у frontend прошёл isolated и повторный full suite без product edit; отдельной product bug ему не приписывается.

| Проверка | Кто / команда | Фактический результат |
| --- | --- | --- |
| Полная свежая сборка | QA: `npm run build` | pass:6 workspaces и P2b SPA; `/tmp/workloom-p2b-final-build.log`; nonfatal chunk warning, performance budget не проверялся |
| Полный lint / typecheck | QA: `npm run lint`, `npm run typecheck` | pass:145 browser source boundaries; all workspace + root QA/config types; `/tmp/workloom-p2b-final-lint.log`, `/tmp/workloom-p2b-final-typecheck.log` |
| Root core/API unit | QA: `npm run test:unit` (core/API часть) | pass:566 тестов /27 файлов,1,75 с, local03:59:24; `/tmp/workloom-p2b-final-unit.log` |
| Web component unit | QA: web часть той же команды | pass:126 тестов /24 файлов,4,30 с, local03:59:27; отдельная область, counts не суммировать |
| Первый полный browser14 | QA: `npm run test:e2e` | fail:13 pass /1 fail. Старые12 и P2b desktop прошли; mobile timeout на выборе externally-created periodB, отсутствующего в cached list (QA fixture создал его после initial fetch). Snapshot подтверждает исходный periodA и correct uncertain fact notice. `/tmp/workloom-p2b-final-e2e.log`; полный14 pass не заявляется |
| Targeted current browser | QA: `playwright test tests/e2e/p2b-work-types.spec.ts` после переноса periodB setup до navigation | pass:2/2,10,1 с; `/tmp/workloom-p2b-browser-fixture-fix.log`. Только test fixture изменён, product/API/schema/dist неизменны. Отдельные QA ESLint/types pass; эти2 пересекаются с первоначальными14, counts не суммировать |
| Fresh compiled runtime | QA | Перед browser прежний38835/PID50268 завершён exit0, после полного build запущен82234/PID52278, Node24.19.0; actualready200 database/schemaok, PG/demo сохранены |
| Optimized current bodies | backend: GET-only exact disk parity | pass: HTML551 байт text/html SHA256 `de435b019d20fc925489c879317f5a68e6edc45be47e8f5c7787c6afa5ac5501`; JS `index-N1vmd6bV.js`893497 байт application/javascript и CSS `index-ChcSxkh8.css`51634 байт text/css, все200/byte-identical current dist. Без writes/build/restart при smoke |
| Root visual | координатор | pass: просмотрены все7 текущих кадров ниже; layout/labels/denominators читаемы, blocking findings нет. Предыдущее validation message после ввода причины в mobile fact — nonblocking polish, успешный submit проверен |

**Browser действия.** Desktop1440 через UI связывает существующее single_select, явно выбирает неделю и собственный worker lens. Сохранён draftB3ч; реальный POST A2ч фактически commit в PG, после чего test route abort теряет только ответ. B показывает собственные3ч и blocked; recovery A возвращает исходные package/person/payload/key, replay не дублирует commitment; затем B3ч успешно сохраняется. Три table fact записи60/30/30 создаются настоящим Enter submit; до baseline UI report120/50/25/25. Вторая страница явно recategorizes60 с причиной без изменения часов; старый run после reload неизменен, новый показывает90/75% поддержки. Исторические labels/rows сохранены.

Mobile390: явная неделя, blank hours отклонены, реальный zero POST/commit с потерянным ответом. После выбора другой недели recovery возвращает исходную неделю, worker, task и тот же payload/key; исходная revision1/0 возвращена, в другой неделе источника нет. Reload показывает0, correction90 требует причину и сохраняет тот же log/revision2. Type report и chart читаются после reload, без page overflow; горизонтальный table scroll локальный. Прежние12 функций прошли исходный полный run, включая pinned estimate/title и dialog/footer geometry.

**Инфраструктура.** Read-only shell polling задержался; автоматический approval reviewer завершился timeout и прямо разрешил один retry. Разрешённый retry вернул лог; root наблюдал ту же dispatch latency. В browser log mobile duration17,4min при30s timeout и всего18min — наблюдение wall-clock gap, не доказательство product performance. Фактическая mobile fixture ошибка отдельно исправлена выше. Отказ приложения или blanket browser pass из инфраструктурного задержания не выводится. Дедлайн07:18:10UTC и Claude reset02:50UTC не сдвигались, новых Claude probes не было.

Preview: `http://127.0.0.1:4311/w/5eed0000-0000-4000-8000-000000000201/projects/4311a3ee-d3d3-41fc-9299-02197b6ddeb5/week?period=a9da2ba3-9084-4d87-9964-96cd888ff211&view=work-types&typeRun=3469d14f-dd25-4d7d-a44c-527eeb3422c7`. Все7 текущих кадров просмотрены координатором, bounded P2b принят. Это модельный просмотр, не человеком:

- [p2b-desktop-category-binding.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p2b-desktop-category-binding.png)
- [p2b-desktop-quick-table.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p2b-desktop-quick-table.png)
- [p2b-desktop-category-report.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p2b-desktop-category-report.png)
- [p2b-desktop-recategorization.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p2b-desktop-recategorization.png)
- [p2b-mobile-quick-fact.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p2b-mobile-quick-fact.png)
- [p2b-mobile-category-report.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p2b-mobile-category-report.png)
- [p2b-mobile-category-chart.png](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p2b-mobile-category-chart.png)

**Приёмка P2b.** Root принял ограниченный срез после просмотра всех7 текущих кадров. После приёмки root создал source checkpoint `5e46a8e4a50d747bd01a810dcc37a0506bc95e7c`; QA подтвердил чистое дерево перед этой узкой provenance-правкой. Проверки относятся к замороженному рабочему дереву перед commit, ради hash не повторялись. Эта правка только записывает provenance, source/runtime/данные не меняет. Формулировка browser evidence сохраняет первоначальный13/14 pass с QA fixture failure и отдельный corrected targeted2 pass, без заявления одного полного зелёного14. P3a — только проект [15](15-p3a-contract.md), полный P2/MVP и командный пилот не достигнуты.


## P3a — частичный focused gate (исторический)

Рабочее дерево после принятого P2b source `5e46a8e4a50d747bd01a810dcc37a0506bc95e7c` и docs-only provenance `4777aefc98eaa233b75a3a42f6588a62d6f50aef`. Точный публичный каталог зафиксирован в [15](15-p3a-contract.md): разовые workspace-visible встречи, plan preview/apply, attendance и общий recorded-work union. Recurrence/worker/private ACL/внешние календари не входят. Код product и QA пока пишет Codex `gpt-6.1-sol` high fallback; Claude до root reset-подтверждения не запускался. Runtime/dev-БД сохраняют принятый P2b;0005 исполняется только в одноразовой test БД.

| Проверка | Кто / команда | Фактический результат |
| --- | --- | --- |
| Public contract и core candidate | foundation | Реальные exports/factory и40-table0005 candidate готовы;218 units/21 файл, strict core types/lint pass; dev migration не применялась |
| Focused libs/API build | QA: `npm run build:libs`, API build | pass; `/tmp/workloom-p3a-focused-libs.log`, `/tmp/workloom-p3a-focused-api.log`. Web не собирался; свой exclusive dist window |
| QA static | QA: ESLint новых helper/test и корневой QA TypeScript | pass после исправления узкого literal parameter type и неверного QA helper-call; `/tmp/workloom-p3a-qa-types.log` |
| Первый реальный HTTP/PG | QA: `vitest run --project integration tests/integration/p3a-meetings.test.ts` | fail:13 pass/2 fail из15,7,32 с, local05:09:24; `/tmp/workloom-p3a-focused.log`. Пять реальных API процессов/пулов и disposable PG |

Первое настоящее product failure: same-roster PATCH после ever-posted source вернул409 `FIELD_LOCKED`, details `{committed:true,baselineIds:[]}`, вместо семантического no-op200. Guard классифицировал наличие защищённых ключей до сравнения предлагаемых значений. Foundation исправляет сравнение под тем же barrier; новый pass ещё не заявлен. Второе падение — QA fixture: две недели с одинаковыми project/localStart правильно получили409 `REVISION_CONFLICT`; B сдвинут на следующий день, сохранив реальное перекрытие, domain uniqueness не меняется.

Зелёные13 включают one task/package/nominal budget300 при5×60 без автоматических commitments/facts; scoped plan rights/atomic preview freshness; три60+partial30+absent0=210 и оба pinned report readers/projection по source union; unknown/absent/void, planned_absence без выдуманного actual; same-source corrections и независимую recategorization/head/history; current ACL/tenant; generic bypass; earliest personal schedule + all project commitment IDs; два реальных cutoff outcomes (`FIELD_LOCKED` с прежними rows и committed `PREVIEW_STALE` без прежних commitments, fresh preview/newkey → added); поздний SQL rollback, concurrent exact key и immutable SQL history; void после metadata A60→B30 сохраняет старые attribution/minutes/confirmed revision, явный restore принимает новые детали. Это фокусные checks, не окончательный полный P3 gate.

Genuine pre0005 fixture подготовлена через старый P2b runtime: `/tmp/workloom-p2b-compat-fixture.json` mode0600 без credentials. Содержит raw task.create response без будущего meeting marker, work.set/categoryA/revision1 и work.recategorize/categoryB/revision2 keys/body/result/hash, оба pinned report types и прежние SQL revision rows. Будущий old-column migration/replay proof ещё не выполнялся; существование файла не считается pass upgrade.


**Focused retry P3a.** Foundation исправил mandatory guard: под тем же barrier сравниваются предлагаемые planned instant/timezone/duration/organizer и sorted active roster; присутствие ключа само не означает изменение. Настоящие изменения после ever-posted остаются locked, same-roster проходит revision checks и handler no-op. Domain/DB builds и affected guard units8 pass, migration0005 не менялась. QA исправил только overlap fixture date и повторил API build + тот же focused файл: **15/15 pass,7,42 с, local05:11:46**, `/tmp/workloom-p3a-focused-fixed.log`. ESLint/QA TypeScript pass; no-op меняет только idempotency cache, весь change_seq/history/source неизменен. Предыдущее13/15 падение сохранено исторически. Полный root/integration/web/browser/upgrade gate ещё не выполнен, dev/runtime прежний P2b.


### P3a — stable core/API regression перед UI и upgrade

После semantic guard correction root запросил отдельный настоящий HTTP no-op для planned и actual UTC `Z` против `.000Z`. Аffected case `keeps posted attribution snapshots` прошёл:1 selected pass/14 намеренно skipped,3,34 с, local05:13:25; `/tmp/workloom-p3a-equivalent-instant.log`. PATCH вернул прежний DTO, revisions/history/events/change_seq неизменны, добавлен только idempotency result; последующее reasonless reconfirm тоже no-op. Source fix уже входил в тот же candidate, новых product edits не было.

| Проверка | Фактический результат |
| --- | --- |
| Полный stable core/API unit: `vitest run --project unit` | pass:643 теста/30 файлов,1,78 с, local05:13:28; `/tmp/workloom-p3a-core-unit.log` |
| Полный real HTTP/PostgreSQL regression: `vitest run --project integration` | pass:120 тестов/12 файлов,42,05 с, local05:13:31; `/tmp/workloom-p3a-integration.log`. Включает focused P3a15 и прежние105; counts не суммировать |

Это gates core/API и throwaway PostgreSQL. UI ещё проходит отдельную review correction для colleague lens: переход к attendance обязан сохранять выбранного worker. Accepted P2b API82234/PID52278 и dev DB0004 не менялись. Populated0005 migration, genuine raw replay, полный текущий web/browser и визуальная приёмка ещё не выполнены; P3a не принят.


### P3a — populated0005 upgrade и genuine compatibility

По отдельному разрешению root QA остановил только прежний accepted P2b API82234/PID52278, SIGTERM/exit0, и передал foundation quiet dev window. Foundation proof `/tmp/workloom-p3a-upgrade-preservation.json`: все35 прежних таблиц по исходным колонкам сохранили counts/digests;3 cached command full rows/hashes/results,2 work revisions и pinned plan-fact/type SQL JSON неизменны. Все27 прежних work revisions сохранили SQL NULL occurrence columns; backfill не делался. Применена только0005, current6, повтор[];10 старых SQL/snapshot файлов0000–0004 и прежние journal entries неизменны. Старые demo сохранены.

После quiet release QA запустил compiled P3a API session32694/PID65721 на4310, Node24.19.0, прежняя local synthetic identity; actual `/healthz/ready`200, database/schemaok. Static web ещё исторический P2b до отдельной текущей web сборки.

Настоящий HTTP upgrade replay выполнен в02:19:24UTC, `/tmp/workloom-p3a-compat-proof.json`: exact raw `task.create`, `work.set`, `work.recategorize` вернули прежние DTO и hashes/cache без изменения. Cached task create по-прежнему не содержит meetingId; свежий GET task имеет канонический meetingId:null. Старые revisions и оба pinned report types HTTP/SQL JSON неизменны. Unified recorded-work прочитал ровно1 manual source90/categoryB/currentrevision2; новые plan-fact и type reports тоже90, всего2 work revisions. Источник fixture действительно accepted P2b `5e46a8e4a50d747bd01a810dcc37a0506bc95e7c`; новые nullable marker/occurrence поля не обогащают старые cached responses. Это upgrade/replay gate, не browser и не приёмка P3a.


### P3a — frozen web candidate gate

После colleague-lens, explicit original-period interlock, safe task-fields и controlled team attendance review fixes frontend заморозил source. Batch component держит drafts/selected IDs и protected command выше drawer; team mode не входит в HTTP body/hash. Backend focused component13 и frontend own18 checks — отдельные subsets, не суммируются с полным web ниже. Все P3a изменения этого среза авторства authorized Codex `gpt-6.1-sol` high fallback; Claude probes до root reset-сигнала не запускались.

| Проверка | Фактический результат |
| --- | --- |
| `npm run build` | pass:6 workspaces и текущий P3a SPA; `/tmp/workloom-p3a-final-build.log`. Nonfatal chunk warning; performance budget не проверялся |
| `npm run lint` | pass:165 browser source boundaries; `/tmp/workloom-p3a-final-lint.log` |
| `npm run typecheck` | pass:все workspace + root QA/config types; `/tmp/workloom-p3a-final-typecheck.log` |
| `npm run test --workspace @workloom/web` | pass:157 тестов/29 файлов,8,30 с, local05:30:42; `/tmp/workloom-p3a-final-web.log` |

Browser16 выполняется отдельным gate, результата ещё нет. Статус P3a pending до реального browser и координаторского визуального просмотра. Core/API643, PG120 и upgrade/replay выше не повторялись из-за только UI изменений.


**Первый browser P3a.** Полный16 дал14 pass/2 QA locator failures: новые desktop/mobile остановились до meeting POST на wrapped-label exact `getByLabel` для видимого period select. Semantic combobox role исправлен только в tests. Второй targeted2 дошёл до настоящего batch210 и personal correction15, но упал на QA assumptions: response содержит весь состав5, а не только changed1; reload возвращает URL tab Plan, локальное переключение не обещано сохранять в URL. Test теперь проверяет1 submitted row и нужный DTO во всём response и явно открывает Attendance после reload. Третий targeted2 **pass2/2,10,3 с**, `/tmp/workloom-p3a-browser-assumption-fix.log`; initial `/tmp/workloom-p3a-final-e2e.log`, locator retry `/tmp/workloom-p3a-browser-locator-fix.log`, traces сохранены в `/tmp/workloom-p3a-initial-browser-results` и `/tmp/workloom-p3a-locator-browser-results`. Одного полного зелёного16 не заявляется.

Root затем выявил реальный UI blocker из наблюдения full5 response: callbacks удаляли drafts всех возвращённых attendance, включая неотправленных людей. Visual/source acceptance приостановлена; frontend/backend исправляют очистку по исходным submitted IDs. QA добавил реальный browser regression: owner unsent partial45/reason draft должен пережить colleague single30→15; другие stored sources неизменны. Новый regression и fix ещё не прошли финальный gate. Предыдущий targeted2 не считается доказательством этого случая. Core/API/PG/upgrade не менялись.

**Оптимизированные тела до cleanup fix.** Backend GET-only ready200 JSON database/schemaok; HTML551bytes SHA256 `f535a96488fc663d3a5ffdc396964ab669ea198bf11932292446b81de4762155`; JS `index-D_J_PC5L.js`1036125bytes application/javascript и CSS `index-ChcSxkh8.css`51634bytes text/css, все200/exact current dist. Следующий UI build потребует новую asset parity; это исторический pre-fix smoke.


### P3a — attendance cleanup и visual targeted gate

Page-owned attendance success получает immutable original variables и удаляет drafts/selection только `variables.input.rows` IDs; callback действует также для global notice retry при закрытом drawer. Batch callback использует те же submitted IDs, full response cache может по-прежнему содержать всех людей. Полная history копируется и сортируется revision DESC; отдельное sticky действие теперь «Подтвердить выбранного участника», batch сохраняет собственное имя.

После этого UI-only correction QA: fresh webbuild/types, QA lint/types pass; полный web **161 тест/29 файлов,7,18 с**, local05:39:26 (`/tmp/workloom-p3a-cleanup-web.log`); targeted browser **2/2,8,7 с**, `/tmp/workloom-p3a-cleanup-browser.log`. Desktop реально сохранил owner unsent partial45/reason при colleague single30→15, все другие stored DTOs неизменны; затем explicit reset. Полный batch — ровно1 POST rows5 с60/60/60/30/0 и response5, pinned300→210/−90/−30%, colleague correction даёт195 и не переписывает прежний run. Source breakdown edit сохраняет colleague target. Mobile реальный zero commit с потерянным ответом и exact body/key retry даёт1 occurrence source/revision1 без actual timing; DST gap не посылает POST, autumn overlap требует explicit later01:30Z. Newest-first history проверена browser обоих размеров.

Root просмотрел все8 pre-cleanup frames в `workloom-evidence/p3a-before-cleanup/`, затем ровно4 текущие изменённые surfaces: desktop batch-review/attendance-history и mobile planned-absence/attendance-history. Визуально pass: single label помещается390px в2-row footer, latest revision первая, material overflow нет. Это модельный просмотр координатором, не человеком. Остальные4 refreshed frames сняты, но повторный просмотр им не приписывается.

После этого root обнаружил соседний plan cleanup: person-scoped submit очищал весь plan map. Frontend перенёс cleanup в page-owned callback по исходным submitted membership IDs, включая global closed-drawer retry; source refrozen после focused MeetingFlow16 и scoped lint pass. QA добавил реальный unsent owner2h→single colleague60→owner2h retained case; final relevant build/types/components/targeted2 выполняется. До его результата P3a всё ещё pending. Server/core/PG не менялись.


### P3a — final plan cleanup targeted gate

Page-owned plan callback очищает только immutable sent membership IDs; actor/colleague drafts вне отправки сохраняются при initial success и closed-drawer global retry. QA fresh web build/types, root QA/config types и test ESLint pass; affected MeetingFlow+Batch **30/2 pass,5,75 с**, local05:41:58, `/tmp/workloom-p3a-plan-cleanup-components.log`. Полный web161 выше относится к предыдущему attendance/history candidate; после state-only plan fix он целиком не повторялся.

Первый новый plan browser run: mobile pass, desktop QA race до plan POST — test изменял underlying native selects сразу после Close, до router/modal transition. Добавлено явное `drawer count0` перед следующими действиями; product не менялся. Финальный targeted P3a browser **2/2 pass,9,3 с**, `/tmp/workloom-p3a-plan-browser-close-sync.log`; prior run `/tmp/workloom-p3a-plan-cleanup-browser.log`. Desktop доказал owner unsent2h → colleague-only60 preview/apply → owner2h retained, затем explicit1h и все5 plans300. Дополнительная attendance draft45 защита, one-submit rows5/210, correct colleague/source lens, exact recovery, report pin и newest-first history остаются в том же pass. Initial full16 и subsequent subsets не складываются и не выдаются за один pristine16 pass. Core/API643/PG120/upgrade не повторялись, server source неизменен.

Root visual pass для4 current attendance/history surfaces сохраняется: последняя plan cleanup только state, layout не менялся. Все8 refreshed frames сняты после attendance/history build; root повторно просмотрел ровно4, указанные выше. После последней state-only plan cleanup они не переснимались, visual pass root сохранил явно. Полный P3, recurrence/worker, Auth/private ACL, внешние календари, production и old-tab upgrade остаются будущими.


**Окончательный optimized smoke P3a после plan fix.** Backend GET-only: actual ready200 JSON database/schemaok; HTML551bytes text/html SHA256 `14c9704d1cb79381dee19f25d9e3782d02217303479f9081e34b0b618511903d`; JS `index-B95BHm_Q.js`1036078bytes application/javascript и CSS `index-ChcSxkh8.css`51634bytes text/css, все200/exact current dist bytes. Runtime32694/PID65721 не перезапускался ради UI-only сборок; API читает текущий index/assets. Smoke не писал source/data.

**Приёмка P3a.** Root принял bounded functional и visual gates. После принятия root создал source checkpoint `9443e063aba5b15eedb41b4ed6f4f43c68cf4baf` (90 файлов); дерево сразу после commit чистое. Все результаты относятся к замороженному рабочему дереву до checkpoint; tests ради hash не повторялись. Эта узкая последующая правка только записывает provenance, source/runtime/data не меняет. Planned docs16/17 включены как будущие, не реализованные срезы. Root отдельно просмотрел все8 pre-cleanup кадров и ровно4 refreshed attendance/history surfaces; layout сохраняется после последней state-only plan правки. Это модельная проверка, не человек. Текущий readable synthetic preview: `http://127.0.0.1:4311/w/5eed0000-0000-4000-8000-000000000201/projects/c479c464-7096-4ab4-a37d-059e1eec7d38/week?period=9df582b1-b4aa-4565-9670-2b8a3cfcc9af&view=report&run=66c528a7-2d36-4ff8-ad3a-4455b2c1b0a3`. Browser fixture после correction имеет текущий195, прежний pinned run210 намеренно не меняется; прежние unrelated demo сохранены.

Durable frames после attendance/history correction, до последней state-only plan cleanup (root повторно просмотрел отмеченные4; остальные4 только сняты). Root сохранил этот visual pass после финальной правки состояния, layout не менялся:

- [desktop plan preview](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p3a-desktop-plan-preview.png) — refreshed, повторно не просмотрен
- [desktop batch review](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p3a-desktop-batch-review.png) — root reviewed
- [desktop attendance](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p3a-desktop-attendance.png) — refreshed, повторно не просмотрен
- [desktop pinned report](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p3a-desktop-week-report.png) — refreshed, повторно не просмотрен
- [desktop attendance history](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p3a-desktop-attendance-history.png) — root reviewed
- [mobile DST choice](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p3a-mobile-dst-choice.png) — refreshed, повторно не просмотрен
- [mobile planned absence](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p3a-mobile-planned-absence.png) — root reviewed
- [mobile attendance history](/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/p3a-mobile-attendance-history.png) — root reviewed

Финальные documentation-only checks:20 Markdown файлов (root README/AGENTS и docs01–17),246 локальных file links,0 broken; `git diff --check` pass. Product tests ради этих prose изменений не повторялись.


## P3b — genuine pre0006 P3a fixture (частично)

Историческое снятие fixture до0006: на тот момент migration/replay ещё не выполнялись. Итоговые upgrade и raw replay подтверждены в финальном разделе P3b ниже.

**Происхождение.** Скрипт написан Claude prep session `9968…` (`--model opus --effort high`). Временный внешний доступ инструментов к `/tmp` сначала был отклонён; скрипт написан в игнорируемый project path `test-results/qa-prep/workloom-create-p3a-compat.mjs`, Codex проверил `node --check`, скопировал в `/tmp/workloom-create-p3a-compat.mjs` и выполнил Node24 `--env-file=.env`, exit0. Bypass flags не использовались.

**Факты снятия** (через принятый P3a API4310, source `9443e063aba5b15eedb41b4ed6f4f43c68cf4baf`): `/tmp/workloom-p3a-compat-fixture.json` mode0600, SHA256 `a9ef2ef54627c216d83f1554f1ee69f1465ad48a6feb68e3dfad416793e9aef5`; readable копия в `test-results/qa-prep/`. Synthetic project `fd0202d9-d80b-4313-82a2-5bebcb750fa6`, period `e336dca1-3811-4284-9e81-ee8efcee412e`, meeting `56a03f84-c16d-435a-a276-68e5b93d0af5`, task `7f189d56-dc1e-452f-a5e6-80b7b3f54378`. Budget180, plan180, attendance90 (60+30+planned_absence0),3 occurrence sources; оба pinned report types90/count3. Сохранены20 scoped SQL old-column наборов:2 meeting revisions,6 attendance history,3 work revisions; 4 текущих meeting cache rows, все `cacheMatchesHttp` true. Перед снятием прежние manual3 exact raw replays и их cache rows неизменны; legacy source `5e46a8e4a50d747bd01a810dcc37a0506bc95e7c` сохранён вложенным.

Верификатор `test-results/qa-prep/workloom-verify-p3b-compat.mjs` подготовлен, не выполнялся; запуск только после согласованного quiet0006 и свежего P3b API. Claude Opus high подготовил16 HTTP/PG cases (session `9d65cc18-6469-4f18-a688-45920f23443c`) и7 worker cases (`2540dfc7-6478-4f41-bc7b-5d6c05400098`); они ещё не выполнялись. Exact-file ESLint всех3 QA-файлов прошёл у Codex. Root QA no-emit прошёл до появления worker-файла, поэтому worker type pass не заявлен.


### P3b — lifecycle очереди pg-boss (частично)

Проверка подготовлена Claude session `f8db4ef4-f910-4e36-a1fc-e3c81966731c` (Opus high), выполнена Codex. Proof `/tmp/workloom-p3b-queue-final-proof.json` (Claude CLI Read не имел доступа к `/tmp`; Codex прочитал proof и выполнил проверку). Время `2026-10-16T03:26:04.644Z`; Node24.19.0, PostgreSQL17.5, pg-boss12.38.0, schema46.

- Собственная изолированная throwaway DB: только принятые0000–0005, pending0006 **не применялась**; принятые dev DB/runtime не затронуты.
- Официальный `migrateWorkloomQueue`: install, затем повтор на current. Сначала DLQ; обе очереди через native `getQueue` со strict проверкой всех options, включая terminal `deadLetter:null`.
- Native PgBoss `migrate:false/createSchema:false` start сохранил тот же queue DDL.
- Три контролируемых drift (main `retryDelay`5→6, main DLQ→null, DLQ `retryLimit`0→1) строго отклонены без auto-repair; каждый явно восстановлен, затем снова current.
- Все40 принятых public tables и3 посторонних outbox rows неизменны в14 full-row digest проверках. Свой client остановлен, DB удалена, temp folder удалён.

Это совместимость library/schema/config lifecycle, **не** полный worker bootstrap, applicationReadiness, handler, relay или ack-loss coverage. Core0006/API/web остаются candidate; P3b не принят, новых product gate claims нет.


### P3b — первый focused HTTP/worker gate, ещё candidate

QA собрал libraries/API/worker; root QA no-emit и scoped lint прошли. Actual `vitest --project integration` двух новых файлов: **23 tests:16 pass/7 fail**,53,05с (`/tmp/workloom-p3b-focused.log`). Раздельно worker **7/7 pass**, HTTP **9/16 pass**. Это первый кандидат, не принятие P3b.

Worker real PostgreSQL/PgBoss: actual transactional enqueue+receipt rollback, valid v1 за8 malformed/unknown subscribed rows при limit1, untouched unrelated outbox, native post-domain-commit/pre-ACK throw и retry новым клиентом. Durable receipt возвращает исходный результат createdCount5; полный public snapshot после retry неизменен. Current authorization проверяется до completed receipt; fresh facade повторяет stale outcome без второго refresh. Также pause/sync recovery, stored-authorizer reauthorization и retained DLQ + real runtime health. Terminal failure использует per-job retryLimit0 в изолированной БД; длительная последовательность production retries не проверялась. Pending worker chunk>100 одним binding не возникал; manual multi-binding recovery проверяется отдельно.

Все7 HTTP failures классифицированы после подтверждения root/foundation как QA fixtures/assumptions: duplicate DST period sameproject/date; snapshot до собственной revocation; guessed protected409 вместо разрешённого422; guessed rebind code вместо409 REVISION_CONFLICT; обе late packages server-added75, а не30added/45unplanned; и неверное требование новой outbox continuation от **manual** chunk. Контракт уточнён: manual chunk отдаёт cursor для следующего клика; worker pending continuation остаётся same-UOW передACK. Поведение сохранения state/replay/census не ослаблено. Исправленный HTTP rerun18 начат после отдельных root review fixes template propagation и desired-past; результат пока не заявлен.

Первичные HTTP16/worker7 authored Claude Opus high sessions `9d65cc18-6469-4f18-a688-45920f23443c` / `2540dfc7-6478-4f41-bc7b-5d6c05400098`. После actual quota rejection (follow-ups exit1 до записи, reset07:50UTC) Codex high добавил8 malformed poison rows внутри прежнего worker test, full snapshot/current-grant/durable-stale assertions, исправил QA assumptions и добавил2 HTTP regressions и2 browser cases. Browser tests пока не выполнялись; accepted dev/runtime не затронуты.


После approved corrections HTTP18:16 pass/2 QA semantic failures (56,76с, `/tmp/workloom-p3b-http-corrected.log`). Root уточнил bounded lazy cutoff: ordinary write при≤100 missing может в том же UOW materialize+freeze, затем создать proposed work; >100/blocked fail closed. Cancelled manual skip с неизменным resolution/sourceVersion — retain при title-only series edit; restore по-прежнему protected. Targeted3 после этих уточнений **3 pass/16 intentional skips**,50,35с (`/tmp/workloom-p3b-http-targeted3.log`): две112 недели продвигаются A100/B100/A12/B12 независимо, readonly B preview не подготавливает её; отдельный ordinary≤100 baseline исключает созданный после freeze task.

Root review обнаружил реальный reset-after-version bug. Первый QA repro остановился на корректной защите nonnull actualStart (fixture), затем corrected real HTTP repro **1 fail/19 intentional skips**,3,27с (`/tmp/workloom-p3b-reset-repro2.log`): после move→series duration/zone/roster edit→reset header60/Berlin/new version, а materialized Meeting всё ещё30/Nicosia/old organizer. ActualDuration20/material notes сохранены. Finding исправлен planned-calendar-only reset/restore sync и required before/after preview contexts; результат отдельного green и последующего broad gate ниже.


### P3b — итоговые core, PostgreSQL, upgrade и browser gates

Reset-after-version green: **1 pass/19 intentional skips**,3,09с (`/tmp/workloom-p3b-reset-green.log`). Before/after context и materialized Meeting согласованы по instant/zone/duration/organizer/roster; stable IDs, ordinary title/status/section/join, actualDuration20/materials и прежняя immutable history сохранены. Self census использует текущий состав materialized occurrence. Это реальный red→green, не замена проверки mock.

| Gate | Результат и область |
| --- | --- |
| `npm run test:integration` | Все7 workspaces собраны, включая worker; **147 tests/14 files pass**,113,50с. Реальный PG17.5 и PgBoss; `/tmp/workloom-p3b-full-integration.log` |
| `npm run lint` | pass;188 browser boundaries, `/tmp/workloom-p3b-root-lint.log` |
| `npm run typecheck` | pass, все workspaces и root QA; `/tmp/workloom-p3b-root-types.log` |
| `npm run test:unit` | core/API/worker **919/46 pass**,3,03с; отдельно web **206/35 pass**,7,50с; `/tmp/workloom-p3b-root-unit-web.log` |
| Первый полный browser18 | **17 pass/1 product CSS failure**,44,0с: mobile document828 при viewport390; `/tmp/workloom-p3b-browser.log` |
| После узкой CSS-правки | fresh web build, root QA types/exact test lint pass; targeted recurrence browser **2/2 pass**,7,0с (`/tmp/workloom-p3b-browser-targeted2.log`). Прежние16 проходили в исходном18; одного полностью зелёного18 не заявляем |

Counts пересекающихся focused suites не суммируются с147/919/206. После единственной responsive class-правки неизменные core/DB gates не повторялись. CSS failure вызвал absolute sr-only header за пределами static scroll wrapper; `relative` ограничил его локальным scroller. GET-only probe до и после открытия drawer: document390=viewport390. Горизонтальный scroll таблицы остаётся локальным.

**Quiet upgrade0006** выполнен foundation после подтверждённого stop только принятого API, worker был OFF: все40 прежних таблиц по исходным колонкам имеют прежние counts/hashes; genuine command cache rows и оба pinned report JSON точные. Только0006 applied,current7,repeat[];12 прежних SQL/snapshot файлов0000–0005 и journal prefix неизменны. Proof `/tmp/workloom-p3b-upgrade-preservation.json`. Queue DDL отдельно, не скрыто в application migration.

**Genuine raw compatibility**: `/tmp/workloom-p3b-compat-proof.json`, verified04:07:43.900UTC:7 exact raw HTTP replays,7 cached hashes/results без изменений;20 scoped old-column projections неизменны; оба старых pinned report types точные. Старые single Meeting/baseline JSON не получают recurrence keys;3 occurrence work sources/revisions не дублированы. Новые расчёты plan180/fact90 и type90/count3. Это проверка server compatibility, не запуск старого browser bundle.

**Browser действия:** desktop1440 создаёт weekday series, видит reserved null locators, явно prepares5, проверяет skip/restore/move, this-and-future version и reset planned-context45→60/roster3→2 с прежними identities. Mobile390 показывает настоящий server DST gap03:30→04:00, теряет ответ после реального create commit, exact same-key/body retry не дублирует header; prepares1 и открывает shared MeetingDrawer. Автоматического personal plan/fact нет. Восемь текущих PNG — во внешнем каталоге `workloom-evidence/p3b-*.png`; pre-fix8 сохранены в `p3b-before-overflow/`. Root просмотрел четыре desktop frames и corrected mobile overflow/DST/instance surfaces, принял layout; полную приёмку всех восьми кадров не заявляем. Хронологическая UI сортировка полной страницы — nonblocking follow-up после checkpoint.

**Фактический compiled worker entrypoint:** после controlled browser явно `db:queue:migrate` установил schema46/DLQ+main, повтор current. `/tmp/workloom-p3b-worker-entry-proof.json` verified04:17:45.665UTC: Node24.19.0 child PID8535 автоматически подготовил3 reserved headers в3 уникальных Meeting/Task/Package, IDs сохранены;0 commitments/0 worklogs. Реальные immediate `worker.started`, `worker.health` statusok и `worker.health_queue` обеих очередей в `/tmp/workloom-p3b-worker-entry.log`. SIGTERM exit0, worker после smoke OFF. Background обработал только подписанные recurrence requests; unrelated outbox invariant доказан отдельным real-PG тестом. Это локальная эксплуатационная проба, не deploy и не многодневный soak.

Принятый до upgrade API65721 завершился clean; новый compiled API session56168/PID6837 на4310, dev current7. Native PG и исходные demo/compat projects сохранены. `npm run dev` по-прежнему запускает только API+web; автоматическая подготовка требует отдельного worker процесса. Полный P3/private ACL/Auth/внешние календари/production остаются будущими.

**Авторство:** начальные HTTP/worker тесты и queue probe — Claude Opus high sessions выше; последующие corrections, четыре дополнительных HTTP invariants, browser2, reset red→green, operator smoke и текущие docs — разрешённый Codex gpt-6.1-sol high после фактического quota rejection. Foundation initial Opus и последующие Codex fixes перечислены в `/tmp/workloom-p3b-foundation-provenance.json`; reset07:50UTC позже deadline07:18:10, повторных probes нет. Команды выполняли агенты, не Claude. Принятый source checkpoint `7441251470e32b47272a2031cdcf76e70c668a31` создан root после этих gates, дерево сразу после commit чистое. Эта узкая provenance-правка не меняет source и не вызывает reruns.


**Финальная оптимизированная SPA:** root independently GET-only подтвердил200 и byte parity HTML+referencedJS+CSS с текущим dist. HTML551 bytes SHA256 `d8a68521a2f440df837877b5ef82e24ed2eae60c7af738e6b496176ef3484371`; JS `index-DRYS-aeR.js`1157900 bytes SHA256 `1ac41fc9296435dc505ed4f072ca57465347e1edca612898eff78b471e7296bc`; CSS `index-CLlfV33S.css`52501 bytes SHA256 `f62de4c64562e7af292e1faf298ae6e87834a47a6f46509b8fba9503de018a31`. Root принял все bounded functional/visual gates. Проверки не повторяются ради будущего hash.


Documentation-only freeze:21 Markdown files (root README/AGENTS, docs01–17, worker README),206 local file links checked,0 broken; `git diff --check` pass. Новых product reruns ради prose/hash нет.

## P4a — начальный real HTTP/PostgreSQL gate (кандидат)

Root выпустил bounded dependencies/blocking/personal-layout по [17](17-p4-contract.md) после P3b source `7441251470e32b47272a2031cdcf76e70c668a31` и docs-only `a9963af6bec9c2910a9ba35cd92a8dba62b3b86c`. Все новые QA helper/tests и fixture/verifier authored разрешённым Codex gpt-6.1-sol high; Claude reset07:50UTC позже deadline, probes не было.

**Первый focused gate:** API-only build pass, `vitest --project integration tests/integration/p4a-dependencies.test.ts` — **16/16 pass**,13,34с, `/tmp/workloom-p4a-focused.log`. Реальный throwaway PostgreSQL, actual HTTP/API/domain; root QA types и точный lint pass. Concurrent opposite edges дают ровно один commit; cross-project/restore cycles, self и tenant isolation; natural identity/revision/no-op/key replay; warn/enforce/archived/cancelled/done и recurrence composer отказ без частичного series/task изменения. Полный snapshot проверяет late SQL fault rollback и current ACL до replay. Graph CSV→normalized domain, context labels, paged blockers/source400 и hidden authoritative counts. Layout свой/viewer/full-set/revision/no-op и настоящий early bypass: complete и incomplete overdue calendars не изменяются.

**Размеры на настоящем PG:** FK-valid bulk fixture в одноразовой базе (не функциональный CRUD proof) позволяет проверить реальные projections:500 nodes success/501422,1000 induced edges success/1001422,whole response без partial data; uncapped cycle и hidden blocker проверки продолжают работать.100 CSV roots success/101400.500 layout positions (>16KiB) сохраняются/читаются через approved больший body limit;501400. Functional edge commands остальных случаев идут по HTTP.

**Genuine pre0007 fixture** снята через принятый compiled P3b API: `/tmp/workloom-p3b-compat-fixture.json`0600, SHA256 `3dad9b700ddb95d614ca193a37a4497805d5c72f9eebacc6fc6a5c3e1a56982e`. Synthetic project `a1bae2df-dfc7-49d2-b9eb-79e26dc7b351`,3 stable materialized headers,move exception,project calendar baseline,6 cached recurrence/freeze/report commands и nested7 прежних exact raw replays;13 cached rows,32 project-scoped old-column projections. Оба новых pinned reports0: автоматического плана/факта нет; nested prior fixture сохраняет180plan/90fact и старый manual/recat history. Verifier `/tmp/workloom-verify-p4a-compat.mjs` syntax pass, post0007 пока НЕ исполнялся. Dev API56168/PID6837/current7 и workerOFF сохранены; quiet migration требует отдельного согласованного окна.

Исторический статус начала focused gate: UI browser2 тогда ещё не исполнялись; результаты последующих broad/targeted gates и fixes ниже. Silent roots `.slice(0,100)` заменён явным narrow validation до первого broad gate.


### P4a — широкая проверка, UI red→green и итоговая приёмка

| Gate | Фактический результат |
| --- | --- |
| Initial `test:integration` | Полный build7 workspaces; realHTTP/PG **163/15 pass**,129,68с; `/tmp/workloom-p4a-full-integration.log` |
| Initial root lint/typecheck | pass;203 browser boundaries, все workspaces/root QA; `/tmp/workloom-p4a-root-{lint,types}.log` |
| Initial root unit | core/API/worker **998/49 pass**,4,75с; отдельно web **228/38 pass**,8,13с; `/tmp/workloom-p4a-root-unit-web.log` |
| После reset-intent fix | All-web **230/39 pass**,8,02с; web+QA types/scoped lint/build pass; `/tmp/workloom-p4a-final-web.log` |
| Первый browser20 | **18 pass/2 QA locator failures**,3,7мин; оба новых сценария остановились до edge write на exact wrapping-label select; `/tmp/workloom-p4a-browser.log` |
| После auto500 correction и role selectors | **17 focused/3 files pass**,types/lint/build pass; targeted browser2: **mobile1 pass/desktop1 product race fail**,7,3с; `/tmp/workloom-p4a-browser-targeted2.log` |
| После arrange race fix | **18 focused/4 files pass**,1,62с; web+QA types/scoped lint/fresh web build pass. Targeted desktop **1/1 pass**,4,5с (flow3,6с); `/tmp/workloom-p4a-browser-final-desktop.log` |

Это пересекающиеся gates, counts не суммируются. Последний all-web230 предшествует чистому automatic-layout helper и arrange-state guard; последняя проверка затронутого кода —18focused и targeted desktop. Не заявляется один полный зелёный browser20. После UI-only fixes неизменные core998/PG163 не повторялись.

**Review fixes:** silent >100 roots заменены явной проверкой; first keyboard move теперь использует те же автоматические позиции, что Canvas, с source guard; read/write403/404 скрывает cached graph/card до успешной явной recovery. Reset→move/arrange→успешный nonempty save первоначально оставлял reset intent, потенциально очищая следующую отправку: component2RED→2GREEN и actual browser проверяют clean state. Root numeric500-chain probe нашёл197 автоматически рассчитанных координат вне±100000; только generated coordinates нормализуются, saved/user coordinates не меняются. Пять helper/controller regressions подтверждают все500 сохранённых в input позиций и детерминизм.

Последний реальный browser finding: Save был активен во время async arrange. Trace подтвердил PUTexpectedRevision1/positions2, затем после reset и слишком раннего Save PUTexpectedRevision2/positions0. Guard отключает Save и обработчик, reset/discard/movement/rebase до расчёта; deferred actual GraphView/controller/fetch regression не допускает ранний PUT, затем сохраняет3 позиции. QA ждёт свежий graph response и окончание arrange; финальный browser сохраняет3 nonempty positions/rev3, Save disabled, reload exact. Это product race, не скрытый locator fix.

**Quiet0007:** foundation после stop только API6837/session56168(exit0,portclosed,workerOFF) подтвердил47 old-table original-column digests/counts,13 cached full rows/hashes/results и4 nested pinned report SQL rows. Применён только0007_dependencies_graph,current8,repeat[];14 прежних SQL/snapshot файлов0000–0006 и journal prefix неизменны. `/tmp/workloom-p4a-upgrade-preservation.json`. Изолированные fresh51-table/repeat и Drizzle no-diff — отдельные проверки foundation, не upgrade старой очереди.

**Genuine raw13 replay:** `/tmp/workloom-p4a-compat-proof.json`, verified04:49:50.490UTC:13 exact raw replays,13 cached rows,32 project-scoped old-column projections и3 stable recurrence headers неизменны;5 HTTP pinned documents (4 reports+baseline) exact. Новых commands/reports/facts verifier не создавал. Старые Task/meeting/manual/recategorize outcomes не получают новые dependency defaults. Свежий compiled API session89940/PID15941, readiness200 DB/schemaok; real shared-schema GET proof принимает uppercase CSV roots→canonical2nodes, default policy/layout revision0 без записи (`/tmp/workloom-p4a-runtime-route-proof.json`). WorkerOFF, старые demo/compat projects сохранены.

**Browser/UI:** desktop клавиатурными формами создаёт cross-project dependencies, снимает/восстанавливает stable edgeID/revision3; скрытый table filter predecessor продолжает блокировать. Graph depth0 показывает полные outside counts; depth1 показывает3 узла с корректным project/status context. Сохранение полного личного layout удерживает скрытые позиции; explicit reset→arrange→save сохраняет3 позиции, диаграмма действительно загружает lazy GraphCanvas. Mobile390: cross-project form, текущие blockers, реальный PUT commit с потерянным ответом, смена depth и exact original key/body retry без второй revision; reload сохраняет hidden position. Формы/own-layout controls доступны без page overflow; Canvas fit на390 мелкий, доступны zoom и читаемый list.

Шесть durable PNG `workloom-evidence/p4a-*.png`: desktop blockers/graph, mobile edge-form/blockers/graph/layout. Mobile4 и первоначальный desktop blockers root просмотрел и принял; mobile после state-only arrange guard не переснимались, pass сохранён координатором. Initial locator traces сохранены в `p4a-initial-browser-failures/`, actual arrange-race traces — в `p4a-arrange-race/`. Root также просмотрел исходный Canvas frame с сохранённым zoom; GET/UI-only FitView recapture на optimized4310 показал все3 nodes внутри canvas и no page overflow. `p4a-desktop-graph-fit.png` и `/tmp/workloom-p4a-fit-proof.json` приняты root; это viewport adjustment, не product fix или новый functional rerun.

**Авторство:** весь P4a product/QA и текущие docs — Codex gpt-6.1-sol high после фактического Claude quota;0 новых Claude calls/probes, reset07:50UTC позже deadline07:18:10. Foundation provenance `/tmp/workloom-p4a-foundation-provenance.json`. Approved exact frontend deps `@xyflow/react12.12.0`/`@dagrejs/dagre3.1.1` MIT; foundation сообщил official metadata/install22/audit485/0 vulnerabilities, не QA clean reinstall. Source checkpoint `12f5dbd8c9d5af8c01070e0278ec1ec8fe499fe2` создан root05:06UTC, дерево сразу после commit чистое; эта узкая provenance-правка не вызывает product reruns. Gantt/startDate/date batch/privateACL/Auth/old-tab/production вне этого gate.


**Финальный served build/приёмка:** root принял P4a05:05UTC. Backend GET-only proof `/tmp/workloom-p4a-final-asset-parity.json`05:04:46UTC: ready200 DB/schemaok; HTML551B SHA256 `bd6e47e730596fb28ad9e3ad9e295a6383206c674a7cb75a891b50cc3038aa40`, root JS `index-DrQeeN66.js`1198212B SHA256 `35251b52a0d9cbee748190ee95179f3f4de774c1e5b31fc199dacabe169d9627`, CSS `index-CHt3jnH1.css`52804B; также lazy GraphCanvas JS183086B/CSS15869B и layout JS49379B — все6 объектов200/correct MIME/точное byte+SHA совпадение с текущим dist. Vite4311 transformed GraphView отдельно содержит точный Save arranging guard (`/tmp/workloom-p4a-vite-guard-proof.json`). Browser flows идут через4311; final FitView действительно выполнен через compiled4310. Документационный freeze:22 Markdown файла/225 local file links,0 broken; whitespace diffcheck pass. Новых tests ради prose/hash нет.

## P4b — начальный real HTTP/PostgreSQL gate (кандидат)

Root дал GO после принятого P4a source `12f5dbd8c9d5af8c01070e0278ec1ec8fe499fe2` и docs-only `48b138f298631000942683160366176441c3c8a3`. Авторство новых QA tests/fixtures/docs — Codex gpt-6.1-sol high; по новому указанию пользователя Claude автоматически не возвращать, probes нет. Это candidate, UI/broad acceptance ещё впереди.

API-only build pass. Первый focused real HTTP/throwaway PG: **8 pass/3 QA fixture failures из11**,21,02с (`/tmp/workloom-p4b-focused.log`): два bulk-fixture inserts не задали обязательные timestamps dependency, а error replay сравнивал новый requestId. После исправления только оснастки и добавления cross-project census сценария affected run **5/5 pass,7 skipped**,20,96с (`/tmp/workloom-p4b-focused-corrected.log`). Итого покрыты12 различных сценариев; это не один полный зелёный12 run. QA types/exact lint pass.

Проверены SQL-compatible0001/leap2000/9999, отказ0000/не-leap и effective partial pair; readonly preview и atomic two-task date apply без изменения estimate/participants; canonical order/idempotency и current tenant ACL; inclusive predecessorDue/successorStart, оба desired endpoints, внешний project context/source freshness; unrelated layout/project freeze не меняют previewHash. Baseline overlay отличает not_selected/not_in_baseline/not_set/set и остаётся immutable после date edit. Meeting calendar имеет unknown priority и protected dates; archived batch отвергнут.100 selected rows/101 отказ и1000 comparisons/1001 отказ — реальные FK-valid bulk fixtures, whole error без partial output. Старый exact receipt исполняется даже после1001 новых edges, но revoked membership отвергает replay. Полный authoritative blocker count остаётся1001.

Cutoff probe использует реальный PG clock с8с margin: late SQL fault полностью откатывает freeze+dates+key; retry commits только due freeze и tagged PREVIEW_STALE; exact replay не создаёт второй baseline. Новый preview разрешает ordinary dates при сохранении baseline. Read-only recovery показывает missing и complete-but-unfrozen overdue periods без materialize/freeze. Cross-project dependency endpoint census участвует и в review recovery, и в guarded apply: внешний календарь подготавливается/фиксируется до tagged stale, proposed dates неизменны.

**Genuine pre0008**: `/tmp/workloom-p4a-compat-fixture.json`0600, SHA256 `18a8909c01c38dbee75b3694c40de738ccee60178a39f7bd2cdd0546dd0385e3`, source12f5dbd. Ordinary create/update/fresh Task и personal/project baseline не содержат startDate; dueDate2027-01-16 сохранена.1200whole/360weekly/300fact/−60; оба report types pinned.8 новых raw commands +13 nested прежних =21 cached full rows;34 project-scoped old-column sets. Начальная setup-попытка manual expectedRevision0 получила400; correctednull соответствует контракту, отдельная fixture успешна. Старый partial synthetic setup сохранён, чужие данные не удалялись. Post0008 compatibility пока не заявляется; verifier подготовлен отдельно от product source.

**Quiet0008 и genuine raw21:** после отдельного root GO API15941/session89940 остановлен SIGTERMexit0,4310closed,workerOFF. Foundation `/tmp/workloom-p4b-upgrade-preservation.json`:51 прежняя таблица по original columns неизменна,21 cached full row/hash/result exact,6 baseline SQL JSON и6 pinned report SQL rows exact; только0008/current9/repeat[],16 applied SQL/snapshot файлов и journal prefix неизменны. Все старые tasks получили лишь nullable start_date=NULL, без backfill.

Свежий compiled API session40855/PID23140 на4310 готов DB/schemaok. `/tmp/workloom-p4b-compat-proof.json` verified05:19:13.880UTC подтверждает21 exact raw replay/cache,34 scoped old-column sets и4 HTTP pinned documents без создания новых commands/reports. Genuine personal/project baseline overlay показывает startDate `{state:'not_captured'}`, dueDate `{state:'set',value:'2027-01-16'}`; свежая Task имеет startDate:null, прежние cached Task outcomes всё ещё без startDate property. Это server compatibility, старый browser bundle не запускался. Static web тогда ещё исторический P4a до финального web build.

### P4b — широкий gate и браузерный кандидат

| Gate | Фактический результат |
| --- | --- |
| `npm run test:integration` | Полный build7 workspaces; real HTTP/PostgreSQL **175/16 pass**,158,47с; `/tmp/workloom-p4b-full-integration.log` |
| Root lint/typecheck | pass;222 browser boundaries и все workspace/root QA types; `/tmp/workloom-p4b-root-{lint,types}.log` |
| Core/API/worker unit | **1059/53 pass**,3,36с; `/tmp/workloom-p4b-root-unit.log` |
| All web | **252/46 pass**,8,90с; `/tmp/workloom-p4b-web.log` |
| Полный browser | **22/22 pass**,55,2с; `/tmp/workloom-p4b-browser.log` |

Counts разных suites не складываются. Широкий PG gate впервые целиком подтвердил текущие12 P4b сценариев, включая receipt replay после архивирования target. Full browser включает20 прежних и2 новых: desktop2,0с — реальные два date edits одним apply/reload, immutable baseline overlay и28→366 calendar days через Berlin DST; mobile1,7с — реальный commit с потерей ответа, закрытие drawer/смена окна и exact original key/body retry, revision только+1. Browser UI работает через Vite4311 и настоящий compiled API/PG; отдельные исходные P0 error/empty mocks явно названы в test report, не DB proof.

Перед gate root/core review исправил freshness/capability replay seam: current target access проверяется до receipt, а новый1001 graph bound после; shared guard получает доверенные affected endpoint projects. UI имеет retained drafts, original-only cleanup, monotonic comparisons и denial latch для всех chunks/open drawer/выбранного overlay; recovery period сначала читается и открывается по реальному projectId. Optional generic TaskDrawer startDate сохраняет прежний omitted input shape, если поле не меняли. Calendar axis использует PlainDate; дальние0001–9999 даты не расширяют окно. Pointer drag, auto date cascading/critical path и historical graph topology не реализованы; доступно typed/day-shift редактирование с review.

Финальный GET-only `/tmp/workloom-p4b-final-asset-parity.json` verified05:29:14.943UTC: ready200 DB/schemaok, все6 HTML/rootJS/CSS/lazyGraphCanvasJS+CSS/layout объектов200/correct MIME/exact bytes+SHA к dist. HTML551B SHA256 `2812f7ae8b18170a9a621400c9cce083891e880f930ae09fbbf54aa0c2b327b3`; root JS `index-BPFfZHw_.js`1236261B SHA256 `17a8b63ed578625a8e73fde470b34e5b2752b4f44a668c2826b2852d6fd34a80`; CSS `index-CEbfyfnB.css`53325B. Vite Gantt source отдельно200/calendar axis present; никакой restart/data mutation при smoke.

Шесть durable frames — `workloom-evidence/p4b-{desktop,mobile}-{date-review,gantt,old-baseline}.png`. Последние2 сняты через optimized4310 GET/UI-only: настоящий старый personal/project baseline с not_captured start и set due. Первые Gantt viewport кадры обрезали rows ниже controls; это capture framing, не product failure. Они сохранены в `p4b-initial-framing/`, replacement GET/UI-scroll-only optimized captures направлены на actual axis+3rows. Root просмотрел все6 текущих кадров и принял boundedP4b. Никаких дополнительных product reruns ради framing нет.


**Итог P4b:** root functional/visual acceptance после всех текущих gates; source checkpoint `2d885a9f3c6834dff796779a74b739d31d73cd38` создан root, дерево сразу после commit чистое; узкая provenance-правка не меняет source и не запускает tests. Все product/QA source и документы P4b authored Codex gpt-6.1-sol high,0 Claude calls/probes; текущее явное указание пользователя — только Codex, исторические Opus attribution не меняются. Foundation provenance `/tmp/workloom-p4b-foundation-provenance.json`. Runtime23140/session40855 и исходные demo сохранены, nativePG17.5 current9, workerOFF. FullP4/MVP/Auth/privateACL/import/MCP/production/old-tab не заявлены.

Documentation freeze:23 Markdown files/root README+AGENTS+workerREADME/docs01–19,289 local file links checked,0 broken; `git diff --check` pass. Новых product tests ради prose/hash нет.

## P5a — подготовка actual CSV acceptance (исторический кандидат)

Root дал source GO05:34UTC после source `2d885a9f3c6834dff796779a74b739d31d73cd38` и docs-only `0fcb7bd`. Actual public imports schemas/five-method port compiled; на исходном этапе core/factory ещё не были released,12 новых HTTP/PG scenarios написаны и проходят QA types/lint, но PASS реализации пока не заявляется. Root сообщил shared safe primitives05:37UTC и31 прежнюю public task/field regression; это отдельный gate, не import transaction proof. Авторство — только Codex gpt-6.1-sol high по текущему указанию пользователя.

**Genuine pre0009:** `/tmp/workloom-p4b-compat-fixture.json`0600, SHA256 `9f09d7b3f741054b780096a91d0eb6f2decf11f11a5bb787b21afba490a5bd0d`, source2d885a9, снята через принятый P4b API23140/session40855 до build/runtime swap.9 новых raw/cache commands (Task.create startnull,Task.update setdates, personal/project freeze,task.schedule.apply после baseline,weeklyplan/fact/reports) +21 exact nested старых replays =30cachedfullrows;34 project-scoped old-column sets. Оба baseline сохраняют2027-01-11→16, текущая Task2027-01-12→18.1200whole/360plan/300fact/−60; оба pinned report types сохранены. Версия startDate/null и точный schedule receipt входят в будущий post0009 verifier. Никаких SQL writes/runtime restart/worker включения при capture; исходные demo/fixtures сохранены. На момент исходного capture post0009 proof ещё не выполнялся; последующий результат ниже.

### P5a — focused actual PostgreSQL gate

Core/factory/0009 candidate released05:48UTC, actual API-only build pass. Первый implementation run `tests/integration/p5a-import.test.ts` — **15/15 pass**,32,01с (`/tmp/workloom-p5a-focused.log`), disposable real PostgreSQL и actual HTTP; QA types/exact lint pass. Это ещё не полный broad/web acceptance.

- BOM/quoted commas/newlines/leading-zero и >2^53 string IDs сохраняются; readonly preview/reconciliation не создают задач. Duplicate headers и пробелы externalID остаются исходными; required relationships нельзя скрыть preserve-only acknowledgment.
- Фактическое apply50 задач и отказ51DATArows; structural malformed/NUL/surrogates/cell/column/реальный UTF8 byte bound без partial stage. Legal1MiB source с JSON escaping >5MiB проходит approved scoped8MiB route. Это лимиты Workloom, не объявленный лимит Asana.
- Parent DAG/отдельные null-estimate packages, current members/status/section/tags и6 scalar fields всех5 поддерживаемых типов.1,5 исходных часа→90мин без округления,0/false сохраняются. History `source:'import'` с настоящим actor owner; sourceMeaning/sourceUnit сохраняются в reconciliation. WorkLogs/Commitments/PackageBaselines/report runs не создаются.
- Новый файл с перестановкой **строк и headers** и remapped column indices делает skip по тем же stable IDs, без новых tasks/packages/values/history. Source change, локальная независимая value revision и missing-value ownershipF1→F2 дают конфликт, а не overwrite/ложный skip.
- Два разных staged artifacts с одним namespace/IDs и отдельными keys/preview одновременно: ровно один created success, второй PREVIEW_STALE; refreshed loser skip-only apply сохраняет те же IDs и нулевое приращение task/package/value/history.
- Privacy: известный Private=true блокирует, даже если колонка preserve-only или mapping выбрал другой false flag; без shareable scope confirmation apply недоступен. Owner/admin-only raw artifacts; foreign refs404/no disclosure/current access до replay. Archived/locked/stale fields, invalid dates, title/typed value bounds и parent depth>20 отвергаются до proposed writes.
- Поздний final receipt SQL fault откатывает весь import/task/package/value/history/mapping/audit/outbox; exact same-key retry применяет один набор, новый повтор не меняет state. Inert stage и readonly preview не подготавливают missing overdue census; apply сначала commits preparation/freeze и taggedPREVIEW_STALE, imported rows остаются staged до нового review.

Раннее read-only review обнаружило scalar bound mismatch (>1e12 number/10001 text), privacy mapping bypass и missing-field semantic ownership. Владелец исправил до этого первого PG run, поэтому PG red→green для них не заявляется. Own type/lint authoring corrections также сделаны до runtime gate. Пользовательский Asana export не предоставлен и не импортировался; OAuth/URL fetch/live sync/permissions migration не проверялись.

**Quiet0009 и raw30:** по отдельному root GO принятого API23140/session40855 остановили SIGTERMexit0;4310closed/workerOFF. Foundation `/tmp/workloom-p5a-upgrade-preservation.json`:51 прежняя таблица по всем old columns exact,30 cached full rows/hash/outcomes,12 baseline SQL JSON и8 pinned report SQL rows exact; только0009_project_imports/current10/repeat[].18 старых SQL/snapshot artifacts и journal prefix неизменны. Новых seed/queue/worker операций не было.

Свежий compiled API session36256/PID30886 на4310, readiness200 DB/schemaok. `/tmp/workloom-p5a-compat-proof.json` verified05:52:16.242UTC:30 exact raw HTTP/cache replays,34 project old-column sets и4 pinned HTTP documents exact. Старые Task.create startnull, update setdates и P4b scheduleapply receipt сохранены; baseline2027-01-11→16 против текущих12→18 без подстановки. Verifier новых commands/reports не создавал. Static SPA в этот момент ещё P4b, P5a web/browser и финальный parity не заявляются.

### P5a — широкий gate и визуальная правка

После source freeze05:57UTC QA выполнил один широкий gate на стабильном кандидате. Counts разных suites не суммируются:

| Проверка | Фактический результат | Лог |
| --- | --- | --- |
| Build + actualHTTP/PostgreSQL | все7 workspaces;190 тестов /17 файлов pass,194,65с | `/tmp/workloom-p5a-full-integration.log` |
| Корневой lint | pass,239 browser boundaries | `/tmp/workloom-p5a-root-lint.log` |
| Корневой typecheck | pass, все workspaces и QA | `/tmp/workloom-p5a-root-types.log` |
| Core/API/worker unit |1119 /56 файлов pass,5,08с | `/tmp/workloom-p5a-root-unit.log` |
| Web components |265 /51 файлов pass,12,63с | `/tmp/workloom-p5a-web.log` |
| Полный browser |24/24 pass,1,0мин | `/tmp/workloom-p5a-browser.log` |

Новые2 browser cases выполняют реальную загрузку BOM CSV, явное сопоставление stringIDs/parent/существующего duration поля/current_estimate/hours, preview90мин, apply, API-проверку двух различных null-estimate packages и reload сохранённого mapping/units. Mobile реально теряет ответ уже committed apply, затем сохраняет другой несохранённый upload при exact original key/body retry; дублей нет. URL и literal HTML/formula не исполняются. Прежние P0 error-state mocks явно названы и не считаются PG proof.

Первый визуальный просмотр root всех6 кадров выявил сжатый текст строки mobile reconciliation рядом с длинной кнопкой; остальные5 кадров приняты. Исправление только responsive classes `ImportResults.tsx`: на узком экране кнопка ниже текста. Первые6 кадров сохраняются отдельно; server/PG suite для CSS не повторяется. Финальные фактические результаты ниже.

Финальный responsive gate: owner strict full-web noEmit/scoped lint pass; QA fresh web build pass (`/tmp/workloom-p5a-visual-build.log`), targeted2/2 browser pass6,4с (`/tmp/workloom-p5a-visual-browser.log`). Это отдельный rerun после24/24, а не новый полный26-suite. Содержание/API/core не менялись.

Durable screenshots: `/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/`:

- `p5a-desktop-mapping.png`, `p5a-desktop-preview.png`, `p5a-desktop-reconciliation.png`;
- `p5a-mobile-mapping.png`, `p5a-mobile-preview.png`, `p5a-mobile-reconciliation.png`.

Первые6 сохранены в `p5a-previsual/`. Root просмотрел все6 исходных кадров, затем ровно2 replacement reconciliation и принял исправление06:09UTC;4 остальных исходных состояния уже прошли просмотр. Это модельное визуальное ревью координатором, не человеком. Новый desktop preview: `http://127.0.0.1:4310/w/5eed0000-0000-4000-8000-000000000201/projects/96a70fdf-0e0c-43fb-9e28-d7670a96ab90?view=import&import=86d4ba59-63ce-4cff-8078-9c6396763fbd`.

Final optimized parity06:09:03UTC: `/tmp/workloom-p5a-final-asset-parity.json` pass. Ready200 actualbody database/schemaok; HTML551B SHA256 `5ba468cbd73510939ec16a1d68a44a82eddd047152c676c61a7aa2dbd465f920`; JS `index-CBqS6ivt.js`1289315B SHA256 `e8263264e2250f3c4e5190922a3c3feb0ef1fdf7c838114046143e191eaf4862`; CSS `index-D8ogH813.css`54199B SHA256 `37b9b1815f3944bcccd407a5c9d61c98b856a5f2b6dd6211aacd49b280415739`. Все6 HTML/JS/CSS/lazy assets200/correctMIME/byte-equal текущему dist, Vite ImportView200 actualsource. GET-only, без restart/source/data writes. Runtime36256/PID30886, Node24.19.0/nativePG17.5/current10, workerOFF.

**Итог P5a:** root принял bounded functional/visual slice; source checkpoint `0fcb2cd7533520d47dc3e48541107cc006cdb2ed` создан root06:11UTC; в commit не вошёл planned docs20. Проверки относятся к замороженному рабочему дереву до commit, ради hash не повторялись. Авторство всех новых product/QA/docs P5a — Codex gpt-6.1-sol high,0 Claude calls/probes. Импорт настоящего user export, Asana OAuth/API/live sync, source relationships/attachments/private ACL, fullMVP/Auth/deploy и MCP этим gate не доказаны. Planned docs20 не входят в P5a source checkpoint. Проверки ради будущего hash не повторять.

## P5b — локальный MCP: focused candidate

Source GO после P5a source `0fcb2cd7533520d47dc3e48541107cc006cdb2ed` и docs `8f3151915be32b1259de907b8f1cc0bc936dded6`. Точный контракт — [20](20-p5b-mcp-contract.md). Авторство Codex gpt-6.1-sol high,0 Claude calls/probes. Pinned server/client SDK2.3.1; реальный compiled stdio process соединяется только с loopback HTTP API, child env не содержит DATABASE_URL, argv не содержит token. Public A сначала read-only; B включён root только после настоящего revoke-vs-barrier proof.

**Genuine pre0010:** `/tmp/workloom-p5a-compat-fixture.json`0600 SHA256 `f494ab5d7e2d33ff1a35b40b47559d0158d675bbb05792d1147d420a5e8d341e`, source0fcb2cd.5 новых project/field/stage/apply/privateStage receipts +30 nested =35cache;53 originaltable column/count/digests,36 scopedsets. Synthetic two-row CSV, exact stringIDs, current_estimate/hours1,5→90 и0, normalized fullmapping/reconciliation. Knownprivate строка blocked, member/viewer source+recon4×403. Секретов MCP в fixture нет.

Initial focused16:11pass/5fail15,22с (`/tmp/workloom-p5b-focused.log`). Actual modern/legacy subprocess2/2pass; A9/10pass. Ошибки QA: bulk scopes переданы JSON string вместо array; короткий cursorSecret в B не позволил дойти до writer, ожидание второго lock waiter истекло и оставило unhandled revoke timeout. Исправлены тестовые fixtures, product code не менялся. Следующий14-case run13pass/1fail7,03с: manual role downgrade восстанавливался старым state-only helper без role, поэтому следующий setup403; исправлен точный role restore. Следующий15-case run14pass/1fail7,68с: ошибочно ожидалось отсутствие idempotency receipt у controlled FIELD_LOCKED; существующий shared guard именно commits rejection metadata. Уточнено: task/package/plans/facts/audit/outbox неизменны, ровно1 rejection receipt с hash/error, exact retry полностью inert. Один промежуточный parse failure после QA edit не собрал tests; исправлена лишняя скобка.

A11/11pass включили global credential UUID collision в другом доступном workspace→controlled409 и100-record bound с сохранением old receipt/list/revoke. B final4/4pass3,90с (`/tmp/workloom-p5b-B-proof-final.log`): actual task create/update+credential audit/source, exact receipt; реальный workspace rowlock — queued revoke первым, writer вторым, оба waiters подтверждены PG, release→revoke commit→writer UNAUTHENTICATED без proposed state; old successful receipt после revoke denied; role downgrade/stale revision denied; FIELD_LOCKED commits только один rejection receipt, retry unchanged. Это реальные factories с enableTaskWrites:true в disposable DB, не mock и не отдельный nested writer.

Root read review исправил project cap: archived projects не входят в500active bound. Actual regression501archived+малое active множество успешно возвращает полный результат;501active даёт controlled422 без truncation. После B source freeze06:28UTC focused20:19pass/1fail9,95с (`/tmp/workloom-p5b-B-full-focused.log`). A13/13 и B4/4pass; escaped valid~123KiB write проходит, read16KiB cap и read-only token403. Третий SDK case прошёл create→realcommit lostreply→exactretry/update, но сравнил request-specific `_meta.requestId` при replay. Исправлена QA assertion: exact structuredContent/content и wholeDB unchanged, requestId остаётся новым. Targeted actual SDK3/3pass3,50с (`/tmp/workloom-p5b-SDK-B-corrected.log`): modern2026-07-28, legacy2025, writes through actual modern subprocess, unknown outcome retains operationKey, один task/package, cached key denied after revoke, EOF/SIGTERM terminates, stdout JSON-only. Ни token/secret, ни active-secret screenshots/traces не сохраняются.

**Quiet0010:** owned API30886/session36256 остановлен SIGTERM,4310closed/workerOFF. Foundation `/tmp/workloom-p5b-upgrade-preservation.json` pass:53 oldcolumn tables,35cache,12baselineJSON,8pinnedreportSQL,20oldmigration artifacts+journalprefix exact; только0010_local_mcp_credentials/current11/repeat[]. Новых seed/queue/worker/credentials при proof нет. Fresh A API40642/session64831, verifier `/tmp/workloom-p5b-compat-proof.json`06:24:24UTC pass35raw/cache,53originalcolumn globaldigests,20nested SQL records/12HTTPpinneddocs exact; oldstage receipt revision, applied normalizedmapping/source/units/privacy exact. QA verifier сначала ошибочно использовал исторический fullproject rowset до позднейших легальных report additions; затем использовал настоящий pre0010 global snapshot. Ни старые данные, ни reports не менялись verifier. После root BGO owned A runtime остановлен; current B API42513/session55946 на4310, readiness проверяется финальным gate.

Широкий stable candidate gate после всех source freezes завершён; точные результаты ниже. Общий Auth/private ACL/remote MCP/OAuth/deploy/old-tab этим локальным срезом не доказаны.

### P5b — полный gate и приёмка

| Проверка | Фактический результат | Лог |
| --- | --- | --- |
| Build + actualHTTP/PostgreSQL |8workspaces,210/20files pass201,93с | `/tmp/workloom-p5b-full-integration.log` |
| Lint |pass247 browser boundaries | `/tmp/workloom-p5b-root-lint.log` |
| Types |pass все8workspaces и QA | `/tmp/workloom-p5b-root-types.log` |
| Core/API/worker/MCP unit |1210/62files pass4,57с | `/tmp/workloom-p5b-root-unit.log` |
| Web components |269/53files pass9,63с | `/tmp/workloom-p5b-web.log` |
| Полный browser |26/26 pass1,1мин | `/tmp/workloom-p5b-browser.log` |

Initial root lint остановился на QA-only no-control-regex в Unicode-escape fixture; заменён эквивалентным non-ASCII range, initial log сохранён `/tmp/workloom-p5b-root-lint-initial.log`. Продолжены lint/types/unit/web, PG не повторялся для regex. Counts suites не суммируются. Broad210 впервые целиком включает все20 новых A13/B4/SDK3 сценариев после исправлений; первоначальные failures выше не переименованы в pass.

Новые browser2cases используют реальную browser WebCrypto выдачу, server hash-only receipt и live HTTP bridge. Desktop выпускает read-scoped credential, читает catalog/projects, закрывает one-time secret, отзывает и видит401. Mobile теряет реальные committed issue/revoke responses и повторяет точные исходные body/key; после reload секрет не восстанавливается. Browsertrace/video/failure screenshots отключены для этих cases; active token только в памяти, SQL/log secret scans возвращают boolean. Никаких host MCP config edits или real-user credentials не было.

Четыре durable safe frames в `/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/`: `p5b-desktop-credentials.png`, `p5b-desktop-revoked.png`, `p5b-mobile-credentials.png`, `p5b-mobile-revoked.png`. До снимков секреты закрыты, credentials отозваны. Mobile form переснят GET/UI-only сверху для читаемого framing, без product rerun. Root просмотрел ровно все4 и принял bounded A+B06:38UTC; это модельное координаторское ревью, не человек.

`/tmp/workloom-p5b-final-asset-parity.json`06:37:07UTC: readiness200 `{status:'ok',checks:{database:'ok',schema:'ok'}}`;6 HTML/JS/CSS/lazy assets200/MIME/exact currentdist и current Vite CredentialPanel200. HTML551B SHA256 `c86f33b29a46aed20eea19fd24a9cc17cdfe541c1e860cd28c4081753b6b5337`; JS `index-DjsTVew4.js`1306633B SHA256 `d253d2119664f85032a0e6a34e7ed3dddd4928f57dcfd6489119cc883134b25e`; CSS `index-D-OmAi2N.css`54272B SHA256 `4d20e736b877eec2bdd60d1fbf41f047ae1c7a1a591c23dba8f181a40ab39761`. Node24.19.0/nativePG17.5/current11, compiled B API42513/session55946, workerOFF. GET-only parity не менял source/runtime/data.

**Итог P5b:** root принял ограниченный local A+B functional/visual slice06:38UTC; source checkpoint `058aeeb4a6301d83c6cea6bddba109b5e5959a27` создан root; дерево после commit чистое. Проверки относятся к замороженному рабочему дереву до commit и ради hash не повторялись. Все source/QA/docs authored Codex gpt-6.1-sol high,0 Claude calls/probes. Remote MCP/OAuth, Shared Auth, private ACL, real-user pilot, production и old-tab не проверены. Полный P5/MVP не заявлен; дальнейшие действия — [21](21-local-pilot-handoff.md).

## Финальное разделение загрузки страниц и синтетическая демонстрация

После accepted P5b source `058aeeb4a6301d83c6cea6bddba109b5e5959a27` root отдельно разрешил lazy ProjectPage/WeeklyPage/IntegrationsPage с Suspense/error boundary; domain/API/PG не менялись. Handoff с действительными URLs сохранён отдельным docs checkpoint `963d7c04f3b07b933c837bb8dc0576a7ccda4453`. Авторство Codex gpt-6.1-sol high, Claude не вызывался.

Final web build pass (`/tmp/workloom-lazy-web-build.log`); strict web types/scoped lint pass (`/tmp/workloom-lazy-web-types.log`, `/tmp/workloom-lazy-web-lint.log`); full web **271/54 pass14,88с** (`/tmp/workloom-lazy-web-unit-final.log`); full browser **26/26 pass1,6мин** (`/tmp/workloom-lazy-browser.log`). Первый web run270pass/1fail ожидал старый meeting-specific departure copy; test-only assertion обновлён на фактическое общее предупреждение. Второй270pass/1fail App rejected-actor-switch проверял detached DOM node после асинхронного rerender; test-only atomic wait теперь читает текущий DOM и подтверждённый server actor. Отдельные repeat probes владельца и final full suite прошли; product/session behavior не менялось. Оба initial logs сохранены `/tmp/workloom-lazy-web-unit-initial.log`, `...-second.log`. Один QA scoped lint command содержал несуществующий путь App.test; исправлен путь, source не менялся. Core1210 и PG210 ради test-only/lazy правок не повторялись.

Measured initial JS graph: `/tmp/workloom-lazy-after.json` использует настоящий Rollup AST parse, HTML modulepreloads и рекурсивные STATIC imports. До split HTML имел единственный entry1 306 633B/gzip376 059B. После — `index-Bgy-eE74.js`626 279B/gzip197 236B, static imports и modulepreloads отсутствуют. Полный initial JS graph уменьшился на52,07%, gzip47,55%; dynamic route chunks исключены именно из initial graph, не скрыты из общего build. Latency/Core Web Vitals этим не измерялись, budget pass не заявлен.

`/tmp/workloom-final-demo-capture-proof.json`: три независимых cold optimized contexts Project/Week/Integrations загрузили каждый свой route chunk200 без двух остальных; общий shared chunk допускается. Реальная заблокированная ProjectPage загрузка показала error boundary, явный reload после снятия network failure восстановил страницу. Capture script сначала ошибся role=button вместо реального tab и exact label для Gantt select; это QA locators, не product failure. Исправленный GET/UI-only capture завершён без POST/PATCH/PUT/DELETE и global overflow1440/390.

Final optimized parity06:47:20UTC `/tmp/workloom-lazy-final-asset-parity.json`: readiness DB/schemaok, все12 HTML/JS/CSS/route/shared/lazy objects200/correctMIME/exact currentdist. HTML SHA256 `8fefa058b3c35550f1f2e049b5ceab8ee45aafc2bd4df32a09a8ba67ea86de19`; entry SHA256 `faa14f24ad37a98451ff3972826e8d9f82c58c53e6fea220e76f5ee248a71a60`. API42513/session55946 остаётся прежним, workerOFF; restart для static assets не потребовался.

**Синтетический preview:** разрешённый `/tmp/workloom-final-demo.mjs --execute --app http://127.0.0.1:4310` завершён06:39:05UTC. Private manifest `/tmp/workloom-final-demo-state-v1.json`0600 и durable `workloom-evidence/final-demo-manifest.json`0600 записывают исходные command keys/body до отправок. Только новый проект и существующие5writer+viewer fixtures:8tasks, whole2850мин, weeklyplan2460мин, actual2445мин, variance−15мин, meeting210мин. Server pinned category totals1470/720/255. Реальные user data/старые demo/credentials не менялись. Это demo setup через API, отдельно от UI acceptance.

Durable8 viewport frames в ранее указанном `workloom-evidence/`: `final-demo-desktop-{table,report,categories,meeting,graph,gantt}.png`, `final-demo-mobile-{table,report}.png`. Gantt UI window установлен на2026-10-12 и выбран настоящий project baseline; task dates не менялись. Root просмотрел все8 и принял lazy/capture slice06:50UTC после271/26/cold/parity evidence; это модельное визуальное ревью. Source checkpoint этой узкой frontend правки `962247ba30d0bd0a5da91ff97408917b1057de34` создан root; проверки относятся к рабочему дереву до commit, ради hash не повторялись. Main preview и7 URLs находятся в [21](21-local-pilot-handoff.md); основной проект `f477730b-57dc-418f-a46b-0eeab30f8212`.
