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
| [12 Активный прогон](12-active-run.md) | Ledger текущего прогона: сроки, политика моделей, владельцы и текущий срез; доказательства — только в 11 |
| [13 Контракт P2a](13-p2a-contract.md) | Замороженный ограниченный каталог недельного планирования, факта, фиксации и отчётов |
| [14 Контракт P2b](14-p2b-contract.md) | Категории внесённых часов и быстрый недельный ввод; принятый bounded scope, evidence в11 |
| [15 Контракт P3a](15-p3a-contract.md) | Разовые shared meetings, explicit personal plan и attendance; bounded local gates, evidence в11 |
| [16 Контракт P3b](16-p3b-contract.md) | Конечные серии, DST, protected calendar census и отдельный worker; bounded local gates в11 |
| [17 Контракт P4a](17-p4-contract.md) | Зависимости, blocking и личный graph layout; bounded local gates в11 |
| [18 Контракт P4b](18-p4b-contract.md) | Date-only start/due, typed/day-shift review/apply и baseline overlay; bounded local gates в11 |
| [19 Контракт P5a](19-p5-import-contract.md) | Ограниченный CSV stage/mapping/preview/apply/reconciliation; точные gates в11 |
| [20 Контракт P5b](20-p5b-mcp-contract.md) | Локальные scoped credentials, семь чтений и две guarded task writes через stdio MCP |
| [21 Передача локального пилота](21-local-pilot-handoff.md) | Запуск, безопасные границы, walkthrough и следующие действия |
| [22 Следующий срез: cutoff worker](22-next-cutoff-worker.md) | PLANNED / не реализован: будущая автоматическая фиксация по cutoff и объяснение overdue state |
| [23 English UI and localization](23-localization-and-ux.md) | JSON catalogs, locale discovery and translation workflow |
| [24 Current daily UX run](24-current-ux-run.md) | New eight-hour run, owners and actual phase ledger; historical 12 remains unchanged |
| [25 UX verification](25-ux-verification.md) | New browser, locale, runtime and demo evidence; initial failures retained |
| [26 Safe local runtime](26-local-runtime.md) | Existing durable cluster doctor/start/stop, identity guards and recovery limits |
| [27 Clean synthetic workspace](27-synthetic-demo.md) | Workloom Studio entry links, additive setup and exact replay rules |

Продуктовые требования находятся в 01. Документы 02–08 уточняют реализацию и этапность: весь командный пилот из 01 не должен появиться в первой локальной версии. Если конкретные DTO и физическая схема конфликтуют с продуктовым поведением, согласовать исправление до реализации, а не изменять требования молча.

Состояние на 16 октября 2026 года: локально приняты P0 и ограниченные P1a/P1b/P2a/P2b/P3a/P3b/P4a/P4b/P5a/P5b. Доступны таблица задач и типизированные колонки, недельный план/freeze/факт, pinned отчёты, shared meetings и explicit attendance, конечные серии встреч с DST preview и отдельным materialization worker, current dependency graph с собственной раскладкой, date-only Gantt и атомарным review/apply обычных дат, ограниченный CSV import с исходниками и сверкой, локальный stdio MCP с собственными scoped credentials. Полный P1/P2/P3/P4, MVP и пилот не завершены. Pointer drag, Private ACL/Auth, полный импорт, остальные MCP tools/remote MCP, внешние календари и production остаются будущими.

Точные раздельные gates, initial failures, исправления и checkpoints — в [11](11-implementation-progress.md); срок и политика моделей продолжающегося прогона — в [12](12-active-run.md). Quickstart — в корневом [README](../README.md), отдельный запуск worker — в [его README](../apps/worker/README.md). `npm run dev` запускает API+web; worker запускается отдельно после явной queue migration.

Для продолжения читать 02,06,11 и контракт следующего bounded среза. Оставшиеся acceptance tables описывают целевой продукт, а не выполненные проверки. Для командного пилота дополнительно обязательны 07–08.
