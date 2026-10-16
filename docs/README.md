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
| [39 Inline task title](39-inline-task-title.md) | Compiled `634aac8` desktop/mobile title and exact-retry gate accepted; physical IME remains untested |
| [40 Drawer hierarchy](40-task-detail-hierarchy.md) | Compiled `634aac8` parent/detail/added-work and retained-draft gate accepted, including separate real native Stay checks |
| [41 Old-tab recovery](41-old-tab-recovery.md) | Genuine `634aac8` lazy-chunk 404 → updated-app guidance → explicit same-full-URL refresh to `3caa48f` passed; no automatic reload |
| [42 Board time context](42-board-time-context.md) | Compiled `634aac8` original-hours exact retry, retained context and populated Board geometry accepted |
| [43 Managed local worker](43-managed-local-worker.md) | Actual worker-only start/health/reuse/drain/stop passed; worker OFF; combined lifecycle with an active worker and OS reboot unverified |
| [44 Retained task drafts](44-retained-task-drafts.md) | Owner-level hidden ordinary task protection included in accepted `634aac8` title/hierarchy flows; in-memory drafts only |
| [45 Task section collapse](45-task-section-collapse.md) | Compiled `3caa48f` native section disclosure and retained editor recovery accepted in the six-case gate; exact attempts in 25 |
| [46 Work-type person lens](46-work-type-person-lens.md) | Compiled `3caa48f` immutable saved-report person lens accepted, including active-zero/no-entry people and zero selector requests; evidence in 25 |
| [47 Compact Board cards](47-compact-board-cards.md) | Full wrapping cards and metadata; original `3caa48f` focus RED corrected by the accepted `223b708` desktop/mobile gate in 25 |
| [48 Retained hours drafts](48-retained-hours-drafts.md) | Compiled `3caa48f` semantic hours protection accepted; optimized UI actor-switch remains source-covered only |
| [49 Retained field drafts](49-retained-field-drafts.md) | Compiled `3caa48f` raw-field protection and exact held retry accepted; evidence and native guard limits in 25 |
| [50 Assignee grouping](50-assignee-grouping.md) | Loaded-scope own-assignee grouping and retained editors; compiled `223b708` desktop/mobile gate accepted in 25 |
| [51 Active filter summaries](51-active-filter-summaries.md) | Literal individual filter chips, native clearing/focus and mobile wrapping; compiled `223b708` gate accepted in 25 |
| [52 Completion focus recovery](52-completion-focus-recovery.md) | Actual Board lane remount focus and exact retry/focus leases; prior RED → `223b708` GREEN in 25 |
| [53 Graph blocker inspector](53-graph-blocker-inspector.md) | Selected-only blockers, policy and guarded navigation; `6ff13df` desktop/mobile gate accepted in 25 |
| [54 Inline Team estimate](54-inline-team-estimate.md) | Shared-package inline editing, unknown/zero, original retry and real FIELD_LOCKED; `6ff13df` desktop/mobile gate accepted in 25 |
| [55 Localized field display](55-custom-field-localized-display.md) | Exact decimal digits and date-only display; source locale/time-zone regressions and normal build, separate browser locale gate not claimed |
| [56 Measured Graph geometry](56-measured-graph-geometry.md) | Explicit automatic layout uses real full-content dimensions; `6ff13df` generated-node browser geometry passed, saved positions may overlap |
| [57 Server task due sort](57-server-task-due-sort.md) | Backend due_asc/manual cursor contract with actual PostgreSQL and live API pagination/filter evidence; accepted frontend control is in 58 |
| [58 Project task due sorting](58-project-task-sorting.md) | `444346d` desktop/mobile gate accepted: real pagination/cursors, canonical hierarchy, retained context and held-ACK editing; 2 cases in 11.2 seconds |
| [59 Contextual project toolbar](59-contextual-project-toolbar.md) | `d97041c` desktop/mobile view-control matrix and original column/hour recovery accepted; 2 cases in 8.9 seconds |
| [60 Personal Graph dragging](60-graph-dragging.md) | Native mouse drag, explicit full-set save/reopen/discard/navigation and exact retry accepted on `d97041c`; 2 cases in 34.1 seconds; physical touch untested |
| [61 Readable table titles](61-readable-table-titles.md) | Source/browser preparation pending its own compiled and actual browser gate; no title-readability acceptance claimed |
| [62 Inline task Priority](62-inline-task-priority.md) | Source integration and prepared browser coverage; compiled/browser acceptance pending |
| [63 Table guidance](63-table-guidance.md) | Source work on conditional help and loaded-budget clarity; compiled/browser acceptance pending |

Продуктовые требования находятся в 01. Документы 02–08 уточняют реализацию и этапность: весь командный пилот из 01 не должен появиться в первой локальной версии. Если конкретные DTO и физическая схема конфликтуют с продуктовым поведением, согласовать исправление до реализации, а не изменять требования молча.

Состояние на 16 октября 2026 года: локально приняты P0 и ограниченные P1a/P1b/P2a/P2b/P3a/P3b/P4a/P4b/P5a/P5b. Доступны таблица задач и типизированные колонки, недельный план/freeze/факт, pinned отчёты, shared meetings и explicit attendance, конечные серии встреч с DST preview и отдельным materialization worker, current dependency graph с собственной раскладкой, date-only Gantt и атомарным review/apply обычных дат, ограниченный CSV import с исходниками и сверкой, локальный stdio MCP с собственными scoped credentials. Полный P1/P2/P3/P4, MVP и пилот не завершены. Gantt date pointer drag/resize, Private ACL/Auth, полный импорт, остальные MCP tools/remote MCP, внешние календари и production остаются будущими.

Последний проверенный собранный checkpoint — `d97041c`: normal web build, workspace/root types и lint прошли, 883 web-теста в 120 наборах — за 141,17 секунды. Его contextual toolbar gate принял два desktop/mobile сценария за 8,9 секунды. Отдельный native personal Graph mouse-dragging gate принял два сценария за 34,1 секунды: explicit full-set save/reopen, discard, navigation guard и точный retry. Это mouse input при mobile width, без приёмки физического touch. Предыдущий `444346d` принял два browser-сценария server-backed due sorting за 11,2 секунды. Backend результаты `6ff13df` — 1307 тестов в 77 наборах и 45 isolated PostgreSQL-тестов в пяти наборах — сохранены отдельно и не повторялись для этих frontend gates. Точные проверки и исходные неудачные попытки — в [25](25-ux-verification.md). Graph dragging меняет личные координаты, а Gantt date pointer drag/resize остаётся будущим. Сохранённые Graph-позиции могут пересекаться; физический touch и отдельная смена locale в браузере не проверены. Docs61–63 описывают source/preparation work, ожидающую собственного compiled/browser gate. Черновики живут в памяти до подтверждённого ухода/reload; текущий прогон продолжается.

Результаты source, compiled browser, PostgreSQL, runtime и old-tab записываются независимо в [25](25-ux-verification.md), текущий phase ledger — [24](24-current-ux-run.md); [11](11-implementation-progress.md) и [12](12-active-run.md) сохраняют историю. Реальный cutoff job и worker-only lifecycle приняты отдельно; worker OFF, шесть stale jobs сохранены. Контролируемый helper stop/start PostgreSQL, API и web прошёл в 13:08 UTC с сохранением cluster/database identity, всех 60 public tables и 24 113 строк снимка того gate, schema/catalog, queue data с 42 jobs и четырьмя очередями, 14 served assets и собранного backend. Этот исторический row count предшествует последующим additive QA fixtures и не является текущей инвентаризацией; OS reboot не заявлен. Настоящий old-tab `634aac8`→`3caa48f` сохранил lazy-chunk 404 и прошёл только явный same-full-URL Refresh tab без automatic reload; для текущего checkpoint его не повторяли. Auth/private ACL, authenticated flows, physical IME, полный импорт/MCP/пилот и production остаются отдельными этапами. Quickstart — в корневом [README](../README.md), lifecycle — в [26](26-local-runtime.md), worker — в [его README](../apps/worker/README.md). `npm run dev` запускает API+web; worker запускается отдельно после явной queue migration.

Для продолжения читать 02,06,11 и контракт следующего bounded среза. Оставшиеся acceptance tables описывают целевой продукт, а не выполненные проверки. Для командного пилота дополнительно обязательны 07–08.
