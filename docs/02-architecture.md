# Архитектура Workloom

План реализации от 16 октября 2026 года. Это техническое уточнение [продуктовой спецификации](01-product-spec.md). Состояние на 16 октября 2026 года: локально проверены P0 и ограниченный P1a (рабочее дерево до первого коммита); ранние частичные checkpoints исторические и на своё время не были приняты. Полный P1 сверх критериев P1a, P1b–P6, общий Auth, приватные ACL задач/встреч, worker, календарные connectors, production и обновление старых вкладок — будущие и не проверены. Доказательства — в [11](11-implementation-progress.md). Главный принцип: одна модель команд и правил для таблицы, API, импорта, worker и MCP.

## Подтверждённые решения

| Решение | Основание |
| --- | --- |
| Одна монорепа клиента и сервера | Прямой запрос Павла |
| React и TypeScript для клиента | Прямой запрос Павла |
| Node.js и TypeScript для сервера | Прямой запрос Павла |
| PostgreSQL | Подтверждено Павлом 16 октября |
| Первые версии без входа | Разрешено для первых этапов; общий Auth подключается позже |
| Railway | Предпочтительная площадка; deployment ещё не выполняется |
| 5–7 человек, общая видимость обычных задач | Требования пилота |
| Приватные личные встречи | Явное исключение из общей видимости |

## Предлагаемый стек

| Слой | Выбор | Зачем |
| --- | --- | --- |
| Workspace tooling | npm workspaces, один корневой package-lock.json | Близко к существующим проектам, достаточно для нескольких пакетов |
| Runtime | Node.js 24 LTS, закреплённая patch-версия на P0 | Поддерживаемый runtime; не копировать старый Docker base автоматически |
| Client | React, Vite, TypeScript strict, React Router | SPA с быстрыми табличными операциями |
| Server | Fastify, TypeScript strict, ESM | Знакомый по Thermis сервер и типизированные adapters |
| Contracts | Zod, DTO, generated OpenAPI | Общая проверка входа и явная граница сервера |
| Client data | TanStack Query | Query cache, invalidation, состояния запросов |
| Table | TanStack Table + Virtual, собственные редакторы ячеек | Headless-поведение и нужная плотность интерфейса |
| UI | Tailwind, Radix primitives, Lucide, dnd-kit | Стиль Thermis, доступные компоненты и drag/drop |
| Charts | Recharts | План/факт и распределение времени |
| Dependency graph | React Flow; автоматическая раскладка отдельным adapter | Карточки, связи и сохранение позиций |
| Gantt | Узкий собственный timeline на общих task/date/dependency DTO | Только текущий набор MVP без коммерческого scheduling engine |
| Persistence | PostgreSQL, Drizzle, reviewed SQL migrations | Транзакции, constraints, исторические данные |
| Background work | pg-boss поверх PostgreSQL | Durable jobs без обязательного Redis на старте |
| Tests | Vitest, Testing Library, Playwright, настоящий тестовый PostgreSQL | Проверка логики, UI и гонок записи |

Node.js 24 находится в LTS; официальный проект рекомендует LTS для production. [Node releases](https://nodejs.org/en/about/previous-releases). Возможности headless-таблицы и виртуализации: [TanStack Table](https://tanstack.com/table/latest), [Virtual](https://tanstack.com/virtual/latest/docs/introduction). Для графа выбран [React Flow](https://reactflow.dev/learn). [pg-boss](https://github.com/timgit/pg-boss) работает с PostgreSQL; это выбор очереди, а не гарантия однократности бизнес-эффектов. Миграции: [Drizzle](https://orm.drizzle.team/docs/migrations).

Версии зависимостей не переписывать из Thermis механически. На P0 выбрать совместимые стабильные версии, проверить Node/React/TypeScript и закрепить lockfile. Graph/chart/queue зависимости устанавливаются при реализации соответствующего этапа. PostgreSQL major выбрать из поддерживаемого Railway образа и закрепить одинаково локально, в CI и в staging.

## Что переиспользовать из Thermis

Подтверждены чтением исходников: React 19/Vite/Tailwind 4, Fastify, TypeScript, Drizzle, TanStack Query, Recharts, dnd-kit; Inter и indigo/slate visual tokens. Полезны поведение EntityTable, ColumnChooser, EditableCell, фильтры и ReportBuilder. Новый tracker должен иметь собственные task editors, дерево, baseline и модель прав.

Источники: [package.json](../../hunter-linkedin/package.json), [токены](../../hunter-linkedin/client/src/index.css), [EntityTable](../../hunter-linkedin/client/src/components/crm/EntityTable.tsx), [ReportBuilder](../../hunter-linkedin/client/src/components/crm/ReportBuilder.tsx), [Dockerfile](../../hunter-linkedin/Dockerfile), [Railway config](../../hunter-linkedin/railway.toml).

Не переносить runtime schema sync, локальную password-auth, fallback роли для API key, in-memory EventEmitter как межпродуктовую очередь, CRM-specific метрики и любые секреты. Старый Dockerfile Thermis использует Node 20; новый проект фиксирует поддерживаемый LTS. Runtime-импорты из соседнего checkout исключены: адаптированные UI-компоненты должны жить здесь.

## Структура монорепы

```text
apps/
  web/src/{app,pages,features,shared}/
  api/src/{bootstrap,http,identity,composition}/
  worker/src/{bootstrap,handlers,composition}/
packages/
  contracts/src/{common,tasks,fields,planning,time,reports,integrations}/
  domain/src/{access,tasks,fields,planning,time,meetings,dependencies,reports,ports}/
  db/src/{schema,repositories,transactions,queries}/
  db/migrations/
  ui/src/{components,tokens}/
  config/
infra/{docker,railway}/
scripts/
tests/{fixtures,integration,e2e}/
docs/
```

P0 создаёт только реально нужные package manifests. Пустые feature modules появляются по мере работы, не как десятки заготовок с фиктивными интерфейсами. `apps/worker` становится отдельным запускаемым workspace на P3. CLI для stdio MCP может сначала находиться в `apps/api/src/mcp`, переиспользуя HTTP client/commands; отдельный сервис ему не нужен.

Зависимости направлены так:

- web → contracts + ui; серверные imports запрещены lint boundary;
- api/worker → domain + contracts + db adapters;
- domain → contracts для согласованных value types и собственные ports;
- db → domain ports + contracts; domain не импортирует db;
- ui → React; ui не знает о пользовательских данных, SQL или auth;
- config содержит инструменты сборки, без runtime secrets.

## Модульный backend

| Модуль | Ответственность |
| --- | --- |
| access | Текущий actor, workspace membership, capabilities, task ACL |
| tasks | Проекты, секции, задачи, участники, статусы, иерархия |
| fields | Definitions, options, значения, истории и policy binding |
| planning | Периоды, commitment, baseline, freeze и корректировки |
| time | Worklog, revisions, work_precision=day\|period, атрибуция |
| meetings | Серии, экземпляры, присутствие и начисление участникам |
| dependencies | Directed edges, проверки циклов, видимые контекстные связи |
| reports | Разрешённые метрики, cohorts, query execution, snapshot runs |
| integrations | Asana import, external links, outbox, MCP adapter |

HTTP-handler принимает и валидирует DTO, получает trusted context, вызывает command/query, формирует ответ. Бизнес-правила не дублируются в routes, JSX или worker handlers. Один модульный процесс API и один worker достаточны для пилота; внутренние модули не являются сетевыми микросервисами.

## Вход и ранний режим без авторизации

Целевой интерфейс identity adapter: `resolveActor(request) -> ActorContext`. Контекст включает внутренний user ID, источник, workspace membership и correlation/request ID. Команда принимает `CommandContext { actor, workspaceId, source, requestId, idempotencyKey? }`, а не доверяет user ID в JSON.

До подключения общего входа в P6: `AUTH_MODE=dev`, локальные fixture users и два fixture workspaces. P6 можно выполнить после основного процесса P3 и минимального импорта; P4 и остальная часть P5 могут затем разрабатываться уже с shared identity. В default-режиме actor задаётся серверной конфигурацией. Для проверки UI допускается dev-only переключатель личности: он выбирает только allowlisted fixture actor, выдаёт локальную сессию и не регистрируется при публичной конфигурации окружения. UI показывает «Локальный режим — тестовый пользователь». Это моделирование поведения, не доказательство защищённости реального входа.

Защита режима: API и Vite слушают loopback; проверяются Host/Origin для мутаций, не включается wildcard CORS. Запуск с dev adapter и APP_ENV=staging/production либо обнаруженной Railway environment завершается ошибкой. APP_ENV отделён от NODE_ENV: NODE_ENV=production описывает оптимизированную сборку, но сам по себе не разрешает публичный запуск. Для P0 допустим запуск собранных dist с APP_ENV=local, AUTH_MODE=dev, bind на loopback и отдельной синтетической БД; этот режим нужен для проверки assets/API и запрещён в Railway. Подделанный клиентом actor/header в обычных endpoints не меняет identity. Dev adapter реализует тот же interface и не отключает проверки workspace/task ACL или locks.

P6: `AUTH_MODE=shared`, вход через общий Auth, server BFF session с HttpOnly cookie, serial refresh, CSRF/Origin checks и explicit callback allowlist. Стабильный Auth `sub` связывается с внутренним user ID; memberships остаются в Workloom. Fixture users не сливаются с реальными людьми по display name/email. Тестовую БД не копируем в production; реальные данные входят через проверенный импорт. Контракт общего сервиса: [Auth integration](../../auth/docs/INTEGRATION.md).

## Хранение и транзакции

PostgreSQL — source of truth для задач, часов, snapshot, ACL, audit и outbox. Drizzle описывает schema/query types; сложные constraints и lock statements разрешено писать SQL с тестами. Миграции версионируются, выполняются отдельно и никогда не заменяются schema sync на startup.

Каждая workspace-owned сущность содержит workspace ID; составные FK и уникальности предотвращают cross-tenant ссылки. Application authorization обязателен; RLS не считается автоматически включённым и не откладывает tenant tests. Для пилота достаточно explicit scoped repositories + DB constraints; решение о RLS — отдельный ADR перед расширением доверенных SQL consumers.

Бизнес-мутация сохраняет current state, revision/audit, idempotency result и outbox в одной транзакции. HTTP и worker ждут commit прежде, чем объявлять успех. На старте все короткие мутации workspace используют общий барьер SELECT FOR UPDATE на строке пространства, commit sequence и ordinal события внутри транзакции. Freeze, переносы и изменения ACL следуют этому же протоколу, подробно описанному в [03](03-domain-and-data.md). Это упрощает доказательство корректности для команды 5–7 человек; гранулярность блокировок пересматривается по измерениям. Сеть, отправка webhook и тяжёлая генерация отчёта не выполняются внутри DB transaction.

## Фоновые задачи и время

На P0 worker не нужен. На P2 scheduled freeze проверяется синхронным барьером любой команды изменения плана; фоновый вызов лишь обеспечивает своевременную материализацию/индикацию. На P3 запускается pg-boss worker для recurring instances, cutoff sweeps и внутренних уведомлений. На P5 он также обрабатывает большие imports/reports/outbox.

Outbox row коммитится с доменным изменением. Relay ставит pg-boss job и отмечает передачу; сбой между двумя операциями может дать повтор, поэтому handler проверяет durable event/source key. Side effect идемпотентен на уровне домена. Очередь использует lease/retry/dead-letter, поддерживает graceful shutdown и manual retry конкретного job. Версия job payload проверяется при rolling upgrade.

Все системные timestamps — UTC; календарные периоды, встречи и date-only сроки сохраняют IANA timezone и исходную календарную семантику. `Date` без time zone не преобразуется молча в полночь UTC. Часы хранятся целыми минутами; weekly aggregate явно отличается от daily worklog.

## Чтение UI и согласование изменений

REST queries возвращают DTO и revision, не строки БД целиком. Query key содержит workspace, actor/session scope, view/filter и период. При смене actor/workspace очищаются несовместимые cache entries. Обычное чтение обновляется после mutation и refetch on focus; WebSocket/coediting не условие MVP. Допускается редкий polling активной таблицы при подтверждённой необходимости.

Optimistic UI применим к обратимому изменению ячейки, но не к freeze, attendance posting или закрытию периода до server acknowledgement. Конфликт revision возвращает старое/новое доступное значение и требует повторного выбора. Reports используют permission-filtered query layer до агрегации; cached ReportRun не даёт доступа по устаревшей ACL.

## Сборка и Railway

Production image собирается от корня workspace. Fastify отдаёт `/api/v1/...` и assets SPA из `apps/web/dist`, сохраняя same-origin cookie flow. Отдельный frontend runtime на первом этапе не нужен. Railway app и worker используют один commit/image с разными start commands; PostgreSQL — отдельный сервис. Детали — [08](08-railway-and-operations.md).

## Первые ограничения

- Один основной проект на задачу; несколько saved views не размножают сущность.
- Недельные периоды без перекрытия в одном проекте/календаре; нет произвольных fiscal calendars.
- Введённые вручную часы, без обязательного таймера или автоматического чтения записей звонков.
- Task-level privacy, несколько пресетов ролей; нет универсального ABAC-конструктора.
- Один тип зависимости finish-to-start, без resource levelling и critical path engine.
- Несколько безопасных агрегатов, без пользовательского SQL/JavaScript.
- Нет офлайн-редактирования, CRDT, мобильного приложения, billing и marketplace модулей.

## Подготовка к первой реализации

P0 реализует рабочую сборку, dev identity, подключение PostgreSQL, одну миграцию пользователей/пространств, smoke API и экран оболочки. P1 добавляет задачи/поля, P2 — первые полезные отчёты, P3 — встречи. Затем минимальный импорт и P6 позволяют провести недельный пилот; Gantt/граф P4 и полный builder/MCP P5 развиваются независимо и входят в полный MVP. Разбивка и последовательность находятся в [06](06-implementation-plan.md), самостоятельное задание на P0 — в [09](09-first-implementation-task.md). Фактический статус P0 и текущего P1a ведётся в [11](11-implementation-progress.md).
