# Документация Workloom

Пакет подготовки реализации от 16 октября 2026 года. Пользователь подтвердил PostgreSQL, React/TypeScript, Node.js/TypeScript, одну монорепу и возможность первых версий без авторизации. Railway — планируемая площадка.

| Документ | Для чего читать |
| --- | --- |
| [01 Продуктовая спецификация](01-product-spec.md) | Пользовательские задачи, исследование рынка, поведение продукта |
| [02 Архитектура](02-architecture.md) | Стек, границы пакетов, режим без входа, технические решения |
| [03 Домен и данные](03-domain-and-data.md) | Сущности, инварианты, схемы хранения, транзакции и расчёты |
| [04 API и интеграции](04-api-and-integrations.md) | HTTP, команды, ошибки, MCP, Auth и Thermis |
| [05 Клиент и UX](05-client-and-ux.md) | Экраны, таблица, редакторы, графы, состояния интерфейса |
| [06 План реализации](06-implementation-plan.md) | Этапы, задачи, зависимости, результаты и критерии завершения |
| [07 Проверки и пилот](07-verification-and-pilot.md) | Контрольные данные, тесты инвариантов, приёмка и перенос команды |
| [08 Railway и эксплуатация](08-railway-and-operations.md) | Сборка, окружения, миграции, очереди, резервирование и выпуск |
| [09 Первая задача реализации](09-first-implementation-task.md) | Задание и критерии приёмки P0; исторический handoff |
| [10 Внешние календари](10-calendar-integration.md) | Будущий дизайн личных подключений Google/Outlook после первого пилота; не входит в P0–P6 |
| [11 Журнал доказательств](11-implementation-progress.md) | Фактические проверки P0, ограниченных P1a/P1b/P2a/P2b/P3a/P3b/P4a/P4b/P5a/P5b, исторические checkpoints и неисполненное |
| [12 Исторический прогон](12-active-run.md) | Прежний ledger со своей датированной provenance; текущий UX-прогон находится в 24/25 |
| [13 Контракт P2a](13-p2a-contract.md) | Замороженный ограниченный каталог недельного планирования, факта, фиксации и отчётов |
| [14 Контракт P2b](14-p2b-contract.md) | Категории внесённых часов и быстрый недельный ввод; принятый bounded scope, evidence в11 |
| [15 Контракт P3a](15-p3a-contract.md) | Разовые shared meetings, explicit personal plan и attendance; bounded local gates, evidence в11 |
| [16 Контракт P3b](16-p3b-contract.md) | Конечные серии, DST, protected calendar census и отдельный worker; bounded local gates в11 |
| [17 Контракт P4a](17-p4-contract.md) | Зависимости, blocking и личный graph layout; bounded local gates в11 |
| [18 Контракт P4b](18-p4b-contract.md) | Date-only start/due, typed/day-shift review/apply и baseline overlay; bounded local gates в11 |
| [19 Контракт P5a](19-p5-import-contract.md) | Ограниченный CSV stage/mapping/preview/apply/reconciliation; точные gates в11 |
| [20 Контракт P5b](20-p5b-mcp-contract.md) | Локальные scoped credentials, семь чтений и две guarded task writes через stdio MCP |
| [21 Передача локального пилота](21-local-pilot-handoff.md) | Запуск, безопасные границы, walkthrough и следующие действия |
| [22 Дизайн cutoff worker](22-next-cutoff-worker.md) | Исходный согласованный дизайн; bounded local acceptance теперь в 25, точный реализованный контракт в 38 |
| [23 English UI and localization](23-localization-and-ux.md) | JSON catalogs, locale discovery and translation workflow |
| [24 Current daily UX run](24-current-ux-run.md) | New eight-hour run, owners and actual phase ledger; historical 12 remains unchanged |
| [25 UX verification](25-ux-verification.md) | New browser, locale, runtime and demo evidence; initial failures retained |
| [26 Safe local runtime](26-local-runtime.md) | Existing durable cluster, opt-in managed worker, doctor health and precise lifecycle limits |
| [27 Clean synthetic workspace](27-synthetic-demo.md) | Workloom Studio entry links, additive setup and exact replay rules |
| [28 My tasks](28-my-tasks.md) | Current-actor cross-project inbox; bounded read and browser proof |
| [29 Daily task editing](29-daily-task-editing.md) | Section quick add, explicit inline status/assignee/due saves and retained command drafts |
| [30 Time context](30-time-context-ux.md) | Week/person navigation, separate report cohort and saved-row task links |
| [31 Task discussion](31-task-comments.md) | Literal ordinary-task comments, trusted authors, lazy activity and exact retry |
| [32 Personal task columns](32-personal-table-columns.md) | Own order/visibility, versioned reset, current-head retry and accepted local0012 proof |
| [33 Task board](33-task-board.md) | Loaded-task status board; исторический overflow 284px исправлен на compiled v4, фактическая геометрия в 25 |
| [34 Single-tag task filter](34-task-tag-filter.md) | One intersecting tag filter: isolated backend and actual paged table/board browser gates |
| [35 Task completion](35-task-completion.md) | Explicit status-only completion/reopen, retained drafts and exact retry; compiled desktop/mobile gate in 25 supersedes original source-only tail |
| [36 Cutoff readiness UI](36-cutoff-readiness-ui.md) | Explicit enable/off/recovery and truthful persisted readiness; compiled controls and real-job observation in 25 |
| [37 My tasks applied lens](37-my-tasks-applied-lens.md) | Current-actor URL filters and separate unsent search; compiled desktop/mobile gate in 25 supersedes original source-only tail |
| [38 Cutoff automation](38-cutoff-automation-contract.md) | Additive0013, current-authority jobs, four queues and bounded real deadline freeze accepted locally; worker now OFF |
| [39 Inline task title](39-inline-task-title.md) | Included in compiled `634aac8`; functional browser/keyboard/geometry gate still in progress |
| [40 Drawer hierarchy](40-task-detail-hierarchy.md) | Included in compiled `634aac8`; parent/child and retarget browser acceptance still pending |
| [41 Old-tab recovery](41-old-tab-recovery.md) | Genuine old import failure retained; explicit refresh to `634aac8` at the same URL passed; updated wording awaits a later build |
| [42 Board time context](42-board-time-context.md) | Included in compiled `634aac8`; retained hours/geometry functional browser acceptance pending |
| [43 Managed local worker](43-managed-local-worker.md) | Actual worker-only start/health/reuse/drain/stop passed; worker OFF; combined full stop/reboot unverified |
| [44 Retained task drafts](44-retained-task-drafts.md) | Included in compiled `634aac8`; owner-level hidden draft protection, actual browser guard gate pending |
| [46 Work-type person lens](46-work-type-person-lens.md) | Source-only saved report display lens; compiled/browser/visual gate pending |
| [47 Compact Board cards](47-compact-board-cards.md) | Source-only wrapping cards and full metadata; compiled narrow-screen/keyboard/geometry gate pending |

Продуктовые требования находятся в 01. Документы 02–08 уточняют реализацию и этапность: весь командный пилот из 01 не должен появиться в первой локальной версии. Если конкретные DTO и физическая схема конфликтуют с продуктовым поведением, согласовать исправление до реализации, а не изменять требования молча.

Состояние на 16 октября 2026 года: локально приняты P0 и ограниченные P1a/P1b/P2a/P2b/P3a/P3b/P4a/P4b/P5a/P5b. Доступны таблица задач и типизированные колонки, недельный план/freeze/факт, pinned отчёты, shared meetings и explicit attendance, конечные серии встреч с DST preview и отдельным materialization worker, current dependency graph с собственной раскладкой, date-only Gantt и атомарным review/apply обычных дат, ограниченный CSV import с исходниками и сверкой, локальный stdio MCP с собственными scoped credentials. Полный P1/P2/P3/P4, MVP и пилот не завершены. Pointer drag, Private ACL/Auth, полный импорт, остальные MCP tools/remote MCP, внешние календари и production остаются будущими.

Предыдущий принятый функциональный checkpoint — `bafc9d6`, с completion `20dd1ff` и My tasks lens `fd0fa07`. В 25 отдельно записаны build/types/lint, 1296 unit cases / 77 suites и 581 web cases / 92 suites, полный 8/8 desktop/mobile gate и реальный job: cutoff 11:09:57.204 UTC, frozenAt 11:09:59.005 UTC, исходная оценка 180 минут / личный план 90 минут. Оба браузера сохранили неотправленный план 2.25 часа и выбранный personal-baseline report. Сохранность 56 старых таблиц / 20,280 строк доказана backup/actual restore и additive0013; четыре новые таблицы были пусты при применении, прежний migration prefix сохранён. Четыре очереди установлены отдельно, старые jobs/receipts сохранены. Worker штатно остановлен в 11:10:20 UTC и OFF; шесть будущих stale jobs остаются. Board overflow 284→0 принят на фактических populated lanes.

Текущая сборка `634aac8` прошла full build/types/lint и 665 web cases / 99 suites; шесть новых функциональных browser cases ещё в работе и не приняты. Настоящая старая вкладка `bafc9d6` сохранила исходную generic import failure, затем явный Refresh tab загрузил `634aac8` с тем же полным URL. Новая update-detection формулировка требует следующего реального перехода между сборками. Managed worker-only lifecycle принят отдельно в 11:23:26–11:26:16 UTC: 59 из 60 таблиц точны, изменился только ожидаемый discovery cursor; все 42 jobs и app identities сохранены. Worker OFF, шесть будущих stale jobs остаются; combined full stop/reboot не проверены. Исторические gates и checkpoints — в [11](11-implementation-progress.md) и [12](12-active-run.md). Текущий отдельный UX-прогон — [24](24-current-ux-run.md), его фактические browser/runtime/data gates, initial failures и известные ограничения — [25](25-ux-verification.md). Quickstart — в корневом [README](../README.md), отдельный запуск worker — в [его README](../apps/worker/README.md). `npm run dev` запускает API+web; worker запускается отдельно после явной queue migration.

Для продолжения читать 02,06,11 и контракт следующего bounded среза. Оставшиеся acceptance tables описывают целевой продукт, а не выполненные проверки. Для командного пилота дополнительно обязательны 07–08.
