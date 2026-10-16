# API, команды и интеграции

Статус: **первоначальный целевой каталог полного контракта**,16октября2026года. Примеры/маршруты ниже не заменяют более новые фактические bounded contracts: [P2a13](13-p2a-contract.md), [P2b14](14-p2b-contract.md), [P3a15](15-p3a-contract.md), [P3b16](16-p3b-contract.md), [P4a17](17-p4-contract.md), [P4b18](18-p4b-contract.md), [P5a19](19-p5-import-contract.md), [P5b20](20-p5b-mcp-contract.md) и actual Zod/application exports в packages/contracts/domain. Локально приняты P0–boundedP5b; CSV-only create/skip import и локальные девять scoped MCP tools имеют отдельные accepted bounded контракты19/20. Это не полная реализация всех операций P1–P6 или external MCP. Исторический P0/P1a subset перечислен ниже для контекста.

P0:

- `GET /healthz/live`, `GET /healthz/ready`;
- `GET /api/v1/me`, `GET /api/v1/workspaces`, `GET /api/v1/workspaces/:workspaceId`, `GET /api/v1/workspaces/:workspaceId/memberships`;
- только для локального режима: `GET /api/v1/dev/actors`, `POST /api/v1/dev/session`.

P1a, относительно `/api/v1/workspaces/:workspaceId`:

- `GET` и `POST /projects`, `GET` и `PATCH /projects/:projectId`;
- `GET` и `POST /projects/:projectId/sections`, `PATCH /sections/:sectionId`, `GET /projects/:projectId/statuses`;
- `GET` и `POST /tags`, `PATCH /tags/:tagId`;
- `GET` и `POST /tasks`, `GET` и `PATCH /tasks/:taskId`, `POST /tasks/:taskId/archive`, `POST /tasks/:taskId/restore`.

Для них обязательны `APP_ENV=local` и `AUTH_MODE=dev`. `NODE_ENV=production` означает лишь оптимизированную локальную сборку, а не настоящую аутентификацию или deployment: в этом режиме backend намеренно оставляет dev-маршруты зарегистрированными, а селектор actor исключён из оптимизированного бандла клиента. Запуск в hosted/нелокальном окружении отклоняется. Новые bounded каталоги выше добавили typed custom fields/history/locks, weekly accounting/reports, meetings/recurrence/local worker, dependencies и schedule preview/apply. Полный P1 (private ACL, saved views, bulk edits и полная built-in history), shared Auth, остальные незафиксированные planned endpoints и production не заявляются; исторические DTO/примеры ниже не означают реализацию полного каталога. Доказательства — в [11](11-implementation-progress.md).

Основа: [продуктовая спецификация](01-product-spec.md), [архитектура](02-architecture.md), [модель данных](03-domain-and-data.md). Сценарии интерфейса — в [05](05-client-and-ux.md), последовательность P0–P6 — в [06](06-implementation-plan.md), проверки — в [07](07-verification-and-pilot.md), эксплуатация — в [08](08-railway-and-operations.md). Павел подтвердил PostgreSQL; persistence реализуется через Drizzle и версионированные миграции. Публичный контракт остаётся независимым от схемы хранения.

## 1. Одна прикладная операция для всех каналов

HTTP-слой на Node.js/TypeScript/Fastify проверяет транспорт, разрешает контекст и вызывает команду из `packages/domain`. Контроллеры не вычисляют baseline, часы или доступ самостоятельно. `apps/web`, MCP, импорт и worker используют те же команды и запросы; прямых записей адаптеров в таблицы домена нет.

`packages/contracts` содержит Zod-схемы входов/выходов, ошибки, типы фильтров, значения перечислений и схему событий. В клиент не экспортируются ORM-модели, секреты, функции проверки JWT или типы внутреннего хранения. Версии библиотек закрепляются при P0, DTO не привязываются к версии ORM.

`CommandContext = { actor, workspaceId, source, requestId, idempotencyKey? }` разрешается доверенным серверным адаптером. `actor` содержит идентичность и ссылку на действующее членство; авторизация проверяется при каждом выполнении. `source` принимает `web | api | mcp | job | import`. Пользователь не может передать чужого actor, capabilities, источник или системное время через body/заголовок.

Общий путь записи:

1. Адаптер валидирует DTO, размер запроса и формат ключей, разрешает credential/actor и workspace.
2. Команда проверяет действующее членство, capability, ACL объектов и все связанные IDs в этом workspace.
3. Проверяет ревизии, политику периода и серверный cutoff; наступившая фиксация сериализуется с изменением.
4. Валидирует предметные инварианты, атомарно записывает состояние, audit, outbox и результат идемпотентной операции.
5. Возвращает разрешённую пользователю проекцию и новые ревизии; адаптер преобразует доменные ошибки в HTTP/MCP.

Повтор команды с успешно применённым ключом возвращает прежний результат только после новой проверки доступа к нему. Отозванное членство не восстанавливается через кеш идемпотентности. Отказ можно записать в технический security log без скрытых названий/значений; доменный audit означает совершённое изменение.

Внутрипроцессные jobs могут вызывать команды напрямую с ограниченным системным actor. Такой actor имеет список допустимых действий и workspace, а не универсальный режим обхода ACL. Действия от имени интеграции сохраняют и интеграцию, и делегировавшего человека.

## 2. Этап без входа и последующее подключение Auth

До подключения P6 локальная разработка использует `DevelopmentIdentityAdapter`: сервер выбирает заранее заведённого synthetic actor из конфигурации. Профили нескольких людей нужны для тестирования приватности; переключение профиля допускается только через отдельный dev-инструмент на loopback. Query/body `userId`, клиентский заголовок или localStorage не задают полномочия.

Dev-режим не создаёт общего production superuser. Все workspace/participant/ACL-проверки работают с первой версии. Приложение должно отказываться запускать dev identity в production-конфигурации или на публичном интерфейсе. До подключения защищённого режима P6 работают синтетические данные и локальные процессы; размещение без входа не является способом открыть сервис всей команде.

P6 (Auth, Railway и недельный пилот) начинается после P3 и минимального импорта P5.4/P5.6; enrichment P5.5 нужен только при выявленных пробелах обязательных данных. P4 и оставшиеся части P5, включая конструктор отчётов и stdio MCP, не блокируют пилот и могут выполняться позже с уже подключённым shared Auth.

В P6 HTTP-адаптер заменяется BFF-сессией через существующий Auth: проверка подписи/issuer/audience/сроков токена, серверное хранение сессии, Secure/HttpOnly cookie, проверка Origin и CSRF для изменений. Access/refresh token не выдаётся произвольному JS в браузере. Конкретный обмен согласуется с действующим контрактом Auth до реализации.

Стабильный внешний user ID связывается с локальным пользователем Workloom. Workspace, membership, приглашения, роли и ACL остаются собственностью Workloom. Совпадение email не создаёт membership автоматически. После отзыва доступа уже открытая вкладка, API credential и MCP больше не получают данные; создание новой сессии не возвращает членство.

## 3. Общие правила HTTP

Базовый префикс — `/api/v1`; рабочие сущности доступны по `/workspaces/:workspaceId`. JSON в UTF-8. Все mutating-вызовы используют единый слой команд. GET не выполняет скрытых бизнес-изменений; материализация встреч и отчётов — явные команды либо jobs.

- Идентификатор — непрозрачная строка UUID; примерные IDs в документации не являются секретами.
- Продолжительность — целое число минут `minutes >= 0`; часы с дробью преобразуются клиентом по явному правилу округления. `null` означает отсутствие оценки, `0` — введённый ноль.
- Момент — ISO 8601 UTC; календарная дата — `YYYY-MM-DD`; зона — IANA, например `Asia/Nicosia`. Интервал периода хранит границы и зону. Дата дедлайна не превращается в UTC-полночь без нужды.
- Поле PATCH отсутствует — не менять; `null` — очистить только если nullable. Для custom fields очищение является явной операцией. Неизвестные write-поля отклоняются, чтобы опечатка не считалась сохранённой настройкой.
- Новая сущность: `201`; изменение/команда: `200`; принятая фоновая операция: `202` с `operationId`. Архивирование возвращает новую ревизию; физического DELETE исторических задач в пользовательском API нет.
- Списки используют cursor pagination, стабильную сортировку с ID, лимит по умолчанию 50, максимум 200 как начальный ограничитель. Cursor подписан/проверен и связан с запросом, workspace и доступом.
- `include`, сортировка, фильтры и группировки выбираются из схемы разрешённых значений. Пользовательский SQL, JavaScript и произвольные пути к БД отсутствуют.
- Ответ содержит `requestId`; маршруты чтения возвращают только видимые поля. Секреты интеграций никогда не возвращаются повторно в обычном GET.
- DTO-изменения внутри v1 преимущественно добавочные; новое значение enum требует согласованного клиента. Разрушительное изменение — новая версия. Старую вкладку обновляем после понятного сообщения о несовместимом контракте.

Вне workspace API доступны `/healthz/live` и `/healthz/ready`: live подтверждает ответ процесса, ready — доступ к PostgreSQL и достаточную schema version. Неготовность возвращает 503; ответ не раскрывает credentials, workspace или приватные данные. Worker проверяется heartbeat/queue lag, а не этим HTTP endpoint.

Обычный ответ: `{ "data": { ... }, "meta": { "requestId": "req_..." } }`. Список дополнительно имеет `meta.nextCursor`. Для публичных API публикуется OpenAPI из тех же схем; CI проверяет согласованность схем, обработчиков и клиентского SDK.

## 4. Конкурентные правки и повтор запросов

Каждый изменяемый агрегат возвращает `revision`. Команды изменения требуют `expectedRevision`; схема не допускает его пропуск там, где возможна потеря правки. Ревизия задачи, участия, worklog, периода и series независимы: изменение комментария не должно создавать ложный конфликт часов. Команда нескольких агрегатов явно перечисляет проверяемые ревизии.

При конфликте возвращается `409 REVISION_CONFLICT` с текущей разрешённой ревизией, без автоматического повторного применения пользовательской правки. UI сохраняет введённое и предлагает перечитать/сопоставить. Перетаскивание в Gantt требует той же ревизии, что редактирование даты в таблице.

Все POST-команды с побочным эффектом и retry-friendly PATCH передают `Idempotency-Key`. Область ключа: workspace + credential/actor + command; тело канонизируется и хешируется. Тот же ключ и другое тело → `409 IDEMPOTENCY_KEY_REUSED`. После неопределённого ответа повторяется прежний ключ, а не создаётся новый.

Дедупликация создания, импорта, baseline и начисления времени сохраняется постоянно через operation/source identity; конечный TTL транспортного кеша не разрешает повторно начислить часы. Повторы, пока первый запрос ещё выполняется, получают тот же operation либо `409 OPERATION_IN_PROGRESS` с инструкцией повторить чтение. Сбой с rollback не оставляет запись об успешном эффекте. Ожидаемый отказ после committed auto-freeze хранится как отдельный типизированный outcome с ID созданного baseline; повтор не создаёт второй снимок.

Для обычной массовой правки до 100 строк используется `batchMode: "atomic"`: либо все допустимые операции, либо ни одной. Ответ сообщает ошибки по доступным строкам. Режим `partial` допустим только на специально документированных командах импорта, с явным результатом каждой строки и возможностью продолжить. Нельзя молча менять atomic на partial из-за размера.

Снимок плана, закрытие факта, split/replace и подтверждение времени встречи всегда атомарны в своей бизнес-области. Долгие операции могут исполняться фоном, но `202` означает лишь принятие; успех читается через status. UI не показывает «Готово» до состояния `succeeded`.

## 5. Ошибки и проверяемые причины

```json
{
  "error": {
    "code": "FIELD_LOCKED",
    "message": "План зафиксирован; создайте корректировку.",
    "details": { "fieldId": "...", "periodId": "...", "canAmend": true },
    "retryable": false
  },
  "meta": { "requestId": "req_..." }
}
```

| HTTP / код | Значение и реакция клиента |
| --- | --- |
| 400 `VALIDATION_FAILED` | Синтаксис/тип DTO; пути неверных полей, без отражения секретного ввода |
| 401 `UNAUTHENTICATED` | Нет действующего credential/сессии; dev-режим не активируется как fallback |
| 403 `CAPABILITY_REQUIRED` | Объект видим, операция недоступна; не раскрывать скрытые политики |
| 404 `NOT_FOUND` | Отсутствующий либо невидимый объект; одинаковый внешний ответ |
| 409 `REVISION_CONFLICT` / `FIELD_LOCKED` / `PERIOD_CLOSED` | Перечитать или создать разрешённую корректировку |
| 409 `DEPENDENCY_CYCLE` / `SOURCE_ALREADY_ACCOUNTED` | Не выполнен предметный инвариант; нужны изменения команды |
| 409 `PREVIEW_STALE` | План массовой операции устарел; заново получить preview |
| 422 `DOMAIN_VALIDATION_FAILED` / `PLAN_VALUE_UNRESOLVED` | Типы верны, сочетание значений невозможно; например фактические минуты без периода/дня или transfer из/в неизвестный план |
| 429 `RATE_LIMITED` | Возвращается Retry-After; применять ограниченный backoff |
| 503 `TEMPORARILY_UNAVAILABLE` | Повтор с прежним ключом; не предполагать отсутствие эффекта |

Скрытый blocker не появляется в `details` с названием/ID. Для видимой задачи допустим нейтральный признак недоступной зависимости, согласованный в модели прав. Stack traces, SQL и токены не возвращаются клиенту.

## 6. Каталог маршрутов и команд

Пути таблицы относительны к `/api/v1/workspaces/:workspaceId`, если явно не указано другое. Это целевой каталог P1–P6; конкретный этап указан в [плане реализации](06-implementation-plan.md).

| Метод и путь | Команда/запрос и существенная семантика |
| --- | --- |
| `GET /api/v1/me`, `GET /api/v1/workspaces` | Идентичность, доступные memberships; dev-источник помечен явно |
| `POST /api/v1/workspaces` | `CreateWorkspace`; будущая реальная идентичность, в dev создаёт тестовый набор |
| `GET/PATCH /settings` | Зона, defaults, политика; смена зоны не меняет прошлые периоды |
| `GET /memberships`, `POST /invitations`, `PATCH /memberships/:id` | P6: приглашение/роль/отзыв; владелец не выдаёт capabilities вне разрешённого набора |
| `GET/POST /projects`, `GET/PATCH /projects/:id` | Проекты и настройки; новые поля не копируют бизнес-логику backend |
| `POST /projects/:id/sections`, `PATCH /sections/:id` | Порядок, имя, pinned; секция не отменяет ACL задач |
| `GET/POST /tasks`, `GET/PATCH /tasks/:taskId` | Фильтры, создание, типизированный patch; `Hours Fact` не является записываемым полем Task |
| `POST /tasks/batch` | `BatchUpdateTasks`; атомарный ограниченный набор, ревизия каждой строки |
| `POST /tasks/:id/archive`, `POST /tasks/:id/restore` | Сохраняют baseline, lineage, worklogs и source IDs |
| `POST /tasks/:id/split`, `POST /tasks/:id/replace` | Явный состав/бюджет/происхождение, без копирования исходной оценки каждому потомку |
| `GET/POST /tasks/:id/participants`, `PATCH /tasks/:id/participants/:personId` | Роль и участие; удаление — снятие участия, исторические начисления не стираются |
| `GET/PUT /tasks/:id/access` | `SetTaskAccess`; явная видимость/список, expectedRevision; отдельно от присутствия |
| `GET/POST /tasks/:id/comments`, `POST /tasks/:id/links` | Комментарии и ссылки записи/summary; наследуют ACL, metadata URL не загружается автоматически |
| `GET/POST /fields`, `PATCH /fields/:fieldId` | Определения, типы, options, scope и политика; изменение типа существующих значений требует отдельной миграции |
| `PUT /tasks/:id/field-values/:fieldId` | Typed value + revision; сервер определяет task/period scope, lock и audit policy |
| `GET/POST /views`, `PATCH /views/:id` | Общая/личная конфигурация; AST фильтров и columns с stable IDs |
| `GET/POST /periods`, `GET/PATCH /periods/:id` | Границы, зона, cutoff, state; нельзя сдвинуть закрытый период обычным patch |
| `PUT /periods/:id/commitments/:commitmentId` | WorkPackage/человек/недельный план + allocations по задачам; отдельно от исходной оценки всей работы |
| `POST /periods/:id/commitments/:commitmentId/transfer` | `TransferAssignment`; явная сумма, обе expected revisions, reuse commitment получателя + immutable CommitmentTransfer |
| `POST /periods/:id/commitments/:commitmentId/carry-over` | Новое обязательство следующего периода с прежним task ID и явным остатком |
| `POST /periods/:id/freeze` | `FreezePlan`; scope `self` либо `project`, включает незапланированные к материализации встречи до снимка |
| `POST /periods/:id/close` | `CloseActuals`; проверка пропусков, фиксирует cutoff/revisions/параметры отчёта |
| `GET /periods/:id/baselines`, `GET /baselines/:id` | Исходный снимок и следующие версии, с текущей авторизацией читателя |
| `POST /baselines/:id/amendments` | `AmendBaseline`; причина обязательна, ссылка на исправляемую версию, оригинал неизменяем |
| `GET/POST /worklogs`, `POST /worklogs/:id/revisions` | День либо неделя, человек/категория/minutes/source; исправление создаёт новую ревизию |
| `PUT /tasks/:id/manual-period-work/:periodId/:personId` | `SetManualPeriodWork`; стабильный ручной недельный источник, отдельно от всех прочих записей |
| `GET/POST /recurrence-series`, `PATCH /recurrence-series/:id` | Частота, weekdays, local time, zone, duration; bounded horizon, ревизия серии |
| `POST /recurrence-series/:id/materialize` | Создаёт недостающие экземпляры в диапазоне, идемпотентно по occurrence key |
| `POST /tasks/:id/reschedule`, `POST /tasks/:id/cancel-occurrence` | Только экземпляр либо граница будущего сегмента серии; сохраняет ID и историю |
| `POST /tasks/:id/attendance/confirm` | `ConfirmAttendance`; участники + минутный факт атомарно, наличие прав на чужой факт |
| `GET/POST /dependencies`, `POST /dependencies/:id/remove` | Finish-to-start, no self/cycle; изменение/удаление с revision и audit |
| `GET/PUT /views/:id/graph-layout` | Ручные позиции видимых узлов; layout не создаёт/изменяет зависимости |
| `GET/POST /report-definitions`, `POST /report-runs` | Типизированная метрика/фильтр/группировки; execute → immutable run definition |
| `GET /report-runs/:id`, `GET /report-runs/:id/rows` | Агрегаты и paginated drill-down с одинаковыми ACL/выборкой/версиями |
| `POST /report-runs/:id/export` | Экспорт только разрешённого набора; download повторно проверяет доступ |
| `GET/POST /field-policies`, `GET/POST /automation-rules` | Ограниченные triggers/AND/actions, версия политики, без произвольного кода |
| `GET /audit-events` | Только события видимых объектов и допустимых полей, pagination и фильтры |
| `POST /imports/preview`, `POST /imports/:id/apply`, `GET /imports/:id` | Mapping и сверка до записи; версии input/mapping/targets, явный частичный результат |
| `POST /external-links`, `GET /tasks/:id/external-links` | Provider/source ID/deep link, проверка workspace-связи, без общей БД |
| `GET /operations/:id` | Состояние фоновой операции только её разрешённым читателям |

ACL Workloom защищает metadata, URL записи и summary внутри нашего приложения; доступ к самому видео/файлу по внешней ссылке регулирует сервис записи. Скрытие ссылки в Workloom не отзывает ранее полученный внешний доступ.

Создание приглашений в P6 означает изменение состояния и доставку письма только после подключения одобренного канала. В ранней версии development fixtures не отправляют сообщения. Права на приглашения, членство, правила, чужое время и исправление закрытой недели различаются.

## 7. Примеры точных операций

Создание обычной задачи недели: `POST /tasks`, `Idempotency-Key: task-draft-<uuid>`. UUID ниже иллюстративные; реальные DTO проверяют формат и доступность связанных объектов.

```json
{
  "projectId": "00000000-0000-4000-8000-000000000001", "periodId": "00000000-0000-4000-8000-000000000002",
  "title": "Исправить загрузку профиля", "kind": "task",
  "participants": [{ "personId": "00000000-0000-4000-8000-000000000003", "role": "assignee", "plannedMinutes": 240 }],
  "estimate": { "initialTotalMinutes": 240 },
  "visibility": { "mode": "workspace" },
  "fieldValues": [{ "fieldId": "00000000-0000-4000-8000-000000000004", "value": { "type": "single_select", "optionId": "00000000-0000-4000-8000-000000000005" } }]
}
```

Создание после cutoff не задним числом добавляет запись в baseline. Ответ содержит новый task, commitment, `scopeClassification: "added_after_baseline"` и текущие ревизии. Сервер не превращает absence of estimate в ноль.

Подтверждение встречи: `POST /tasks/:id/attendance/confirm`, `Idempotency-Key: attendance-<uuid>`.

```json
{
  "expectedTaskRevision": 8,
  "occurredAt": "2026-10-16T07:00:00Z", "durationMinutes": 60,
  "participants": [
    { "personId": "00000000-0000-4000-8000-000000000006", "expectedParticipationRevision": 2, "expectedWorkLogRevision": null, "attendance": "present", "actualMinutes": 60 },
    { "personId": "00000000-0000-4000-8000-000000000007", "expectedParticipationRevision": 2, "expectedWorkLogRevision": null, "attendance": "partial", "actualMinutes": 30 },
    { "personId": "00000000-0000-4000-8000-000000000008", "expectedParticipationRevision": 1, "expectedWorkLogRevision": null, "attendance": "absent", "actualMinutes": 0 }
  ]
}
```

`null` в ожидаемой ревизии worklog означает «записи этого источника ещё нет». В ответе возвращаются ID/revision каждой записи, elapsedMinutes 60 и teamActualMinutes 90. Отсутствие — подтверждённое нулевое участие; неподтверждённый человек не входит в команду подтверждения и остаётся unknown. Watcher не получает часы.

Повтор с другим HTTP-ключом всё равно не создаёт второй worklog: источник уникален по participation/occurrence/person. Если участник уже исправил начисленные часы, устаревшее групповое подтверждение конфликтует; оно не перезаписывает личную корректировку. Подготовка к встрече — отдельный manual worklog с отличающимся source, а не увеличение длительности созвона.

`SetManualPeriodWork` принимает `{ expectedRevision, minutes, categoryId }` и обновляет только стабильную ручную недельную запись этого человека. Если Hours Fact объединяет несколько источников/людей, UI открывает breakdown. Endpoint не принимает «заменить общую сумму» и не стирает дневные, импортированные или автоматически начисленные записи. После close требуется correction с причиной.

Для SplitTask/ReplaceTask тело включает ожидаемые ревизии задачи, WorkPackage и затронутых PeriodCommitment, список потомков и распределение текущих CommitmentAllocation. WorkPackage сохраняет исходную оценку; commitment уникален по period/package/person, allocations распределяют его между задачами без превышения общего бюджета. Split переносит текущие allocations с родителя на детей, baseline allocations не меняются. Структурный rollup родителя не прибавляет бюджет повторно. Добавленный объём создаёт отдельный package с явной связью added_scope, а reparent не меняет происхождение. Replace сохраняет ссылку происхождения и старые worklogs.

TransferAssignment действует между разными людьми в одном period/package. Тело содержит `targetPersonId`, `minutes`, `expectedSourceRevision`, `expectedTargetRevision`, `reason`. `minutes` — явное целое > 0, не больше известного source planned; implicit «перенести всё» не используется. Если source planned или planned уже существующего target равен null, возвращается `422 PLAN_VALUE_UNRESOLVED`: сначала требуется явная оценка/разрешённая поправка, null не превращается в ноль. Если target отсутствует, `expectedTargetRevision: null` означает create-if-absent с planned=minutes; если существует — сохраняется его ID и planned увеличивается на minutes после проверки ожидаемой ревизии. Source planned уменьшается на minutes; при полном переносе остаётся commitment с подтверждённым нулём. Изменения allocations проверяются атомарно. Снятие участия — отдельная операция. Immutable CommitmentTransfer хранит from/to commitments, minutes, reason и before/after revisions; он различает повторные и обратные переносы без повторного подсчёта добавленного объёма. Исходный baseline и ранее внесённый факт не перемещаются.

## 8. Повторения, cutoff и операции фона

RecurrenceSeries хранит локальное правило и timezone. Occurrence identity определяется исходным слотом серии, а не текущим временем перенесённой встречи. Повторная материализация ищет этот identity, поэтому перенос не создаёт второй экземпляр. Исключение отмены также занимает исходный slot.

Правило P3: ежедневное/еженедельное повторение, weekdays, время, длительность, ограничение until/count. Клиент не передаёт произвольную executable cron-строку. Для DST политика определена явно и покрыта fixture: несуществующее локальное время переносится на ближайшее допустимое после разрыва, неоднозначное — раннее вхождение; выбранный offset сохраняется в экземпляре. Переходы не меняют назначенную длительность в минутах.

«Эта и будущие» создаёт новую версию/сегмент правила с границей по исходным slots. Уже проведённые экземпляры сохраняются. Изменение зафиксированных будущих обязательств отражается через обычные корректировки. Не завершившаяся вчерашняя задача не задерживает создание сегодняшней.

FreezePlan, включая личную фиксацию, обязан материализовать ожидаемые встречи соответствующего состава периода до снятия snapshot. В MVP все writers сериализуются через workspace write barrier (`SELECT ... FOR UPDATE`); подробный протокол — в [03](03-domain-and-data.md). Каждая затрагивающая план команда, включая правку серии, сначала выполняет `ensureDuePeriodsFrozen`, затем собственное изменение. Поздний worker выполняет тот же переход; изменение расписания после cutoff не может удалить ожидаемые встречи из исходного плана.

Если cutoff зафиксирован этой транзакцией, а обычная пользовательская правка запрещена новым замком, транзакция коммитит служебную фиксацию и возвращает типизированный отказ `FIELD_LOCKED` с committed baseline ID. Пользовательская правка не применяется. Это ожидаемый outcome команды, не исключение с rollback всего снимка. Неожиданная ошибка откатывает всё; следующий writer повторит freeze. Внутри одного commit auto-freeze и subsequent edit различаются ordinal события и точными ревизиями manifest.

Operation имеет `queued | running | succeeded | failed | cancelled`, прогресс и ошибки безопасного формата. Worker получает lease и heartbeat; повтор после падения безопасен благодаря command/source idempotency. Предлагаемый persistence — PostgreSQL; кандидат для jobs — pg-boss в отдельном worker. Domain state/audit/outbox фиксируются одной транзакцией через Drizzle; relay ставит работу в очередь повторяемо, принимая доставку как минимум один раз. Внешняя Redis-очередь не является требованием API.

## 9. Отчёты, приватность и воспроизводимость

`ReportQuery` содержит source, metricId/version, period IDs, groupBy, typed filter AST, baselineId/revision и data cutoff. Разрешены только заранее определённые агрегаты/формулы. Пустой факт, ноль и неизвестное происхождение входят в отдельные показатели качества; деление на ноль возвращает `null`, не бесконечность.

Ответ план/факт содержит `knownPlannedMinutes`, `missingEstimateCount`, `baselineCompleteness: { knownItemCount, totalItemCount, ratio, complete }` и `factCoverage: { recordedItemCount, totalItemCount, ratio, complete }`. Состав items определяется выбранной метрикой и доступным сопоставимым набором; counts и drill-down согласованы. Подтверждённый ноль считается known/recorded, отсутствующее либо void значение — нет; ratio=null при totalItemCount=0. Fact coverage означает наличие внесённых данных, а не доказательство отсутствия незаписанной работы.

При неполном плане или факте сопоставимого состава итоговое отклонение `totalVarianceMinutes` и `totalVariancePercent` возвращается null: известная часть плана не подменяет весь план. Отдельный показатель отклонения допустим для явно обозначенной complete comparable-known-estimate cohort с собственными coverage/counts. Пример: план 120/null минут, факт 120/60 → knownPlannedMinutes=120, actualMinutes=180, missingEstimateCount=1, baselineCompleteness=1/2, factCoverage=2/2, итоговое отклонение=null. Подмножество с известной оценкой имеет 1 из 2 строк и показывается отдельно.

Сначала определяется доступный читателю набор task/worklog/baseline rows, затем выполняется агрегация. Приватные часы нельзя добавить в итог, скрыв лишь drill-down: разность итогов раскрывает скрытую встречу. Общие отчёты показывают только доступный набор и описывают область «Доступные вам записи», без количества скрытых объектов.

Факт принадлежит выполнившему работу человеку, не actor ввода и не единственному owner задачи. Пять присутствовавших по 60 минут дают 300 минут при elapsed 60. Повтор задачи в нескольких группах таблицы не повторяет source worklog в итогах; report engine дедуплицирует по worklog identity/revision.

Дневной отчёт не распределяет weekly-precision worklog по дням: показывает отдельно «Без распределения по дням». Отчёт завершённых пакетов сравнивает сопоставимый исходный объём; недельная загрузка сравнивает period commitments. Категории исходного плана и факта доступны как разные измерения.

ReportRun закрепляет метрики, baseline, фильтр, cutoff и использованные версии, но не выдаёт вечного разрешения на сохранённые данные. Чтение/экспорт проверяют текущие ACL; при отзыве доступа старый кеш/файл становится недоступным или формируется новая ограниченная проекция. Для разрешённого неизменившегося набора исходный run воспроизводим после корректировок; новая версия считается отдельным run.

Ключ кеша включает workspace, reader/access fingerprint, запрос, data revisions и metric version. Шареный кеш без ACL-ключа запрещён. Согласованность агрегата и drill-down обеспечивается одним cutoff и набором версий; live view помечается как изменяемый.

## 10. Импорт Asana и выход из системы

Минимальный импорт P5.4/P5.6 переносится перед P6 и включает локальный JSON/CSV export, preview, apply и сверку; enrichment P5.5 подключается при необходимости. Остальные задачи P5 могут выполняться после недельного пилота. API-коннектор Asana добавляется при подтверждённой необходимости; pagination, rate limits и Retry-After обязательны. Содержимое задач/комментариев/файлов — данные, никогда не инструкции агенту или серверу.

Preview сохраняет hash исходного файла, версию parser, mapping и предупреждения. Таблицы mapping: пользователи → memberships, проекты/недельные таблицы → project/period, section, custom field/options, status, tags, тип работы, даты и зависимости. Несопоставленный человек/поле остаётся unresolved, не получает произвольное значение по умолчанию.

Внешний ключ включает connection/source workspace + Asana task GID. Один GID из нескольких недель — одна локальная Task: недельные Asana-проекты сопоставляются периодам одного канонического проекта Workloom. Multi-homing между разными каноническими проектами попадает в unresolved до явного выбора основного проекта; MVP не создаёт второй Task и не добавляет неподдерживаемое владение несколькими проектами. Разные GID не объединяются по похожему названию. Source URL, оригинальные IDs и provenance сохраняются.

Hours Est из текущего export — `imported_current_estimate`, не доказанная первоначальная оценка. Hours Fact без проверенного дня/периода и человека — `imported_unknown`, а не точные часы недели импорта. Наличие Task в недельном Asana-проекте само по себе не доказывает дату выполнения или границы накопленной суммы. Global total с неоднозначным периодом остаётся unresolved и не входит в точный недельный факт до явного разрешения. Снимок создаётся только после просмотра и явной фиксации; источник/полнота истории видны в отчётах.

У импортированного факта постоянный source key: source connection/workspace + исходный time-record ID, а для текущего custom Hours Fact — source connection/workspace + task GID + field GID. Строка проекта, import batch и сопоставленный период не входят в идентичность источника. Один GID в двух недельных проектах не создаёт два начисления. Изменённое значение того же источника создаёт ревизию прежней импортированной записи (при конфликтах — решение через preview), а не новую независимую сумму. Переназначение подтверждённого периода также исправляет атрибуцию того же источника по правилам закрытой недели, сохраняя прежнюю версию.

Apply требует previewId, mappingRevision и inputHash; изменения источника/целей → `PREVIEW_STALE`. Каждый импортируемый task bundle (task + доступные связи/поля/первичные часы) применяется транзакционно, весь файл может иметь документированный `partial` результат. Сначала entities, затем relations; неразрешённая связь остаётся в сверке. Удалённые/недоступные отношения нельзя молча считать восстановленными.

Повтор import идентифицирует source records и не перетирает локальные изменения автоматически: строки получают unchanged/update/conflict. Неизменённый source hash пропускается; конфликт local/source решается явным mapping/решением пользователя. Импорт закрытого периода не обходит lock, а создаёт разрешённую корректировку либо исключение для разбора.

Сверка: задачи/подзадачи/участники, строки каждого поля, суммы по человеку/периоду, links/comments, unresolved и omitted. Исходный export сохраняется с ограниченным доступом; его наличие не доказывает переноса attachments. Выходной экспорт Workloom включает IDs, версии, исходные снимки, worklogs, provenance и схему формата; CSV безопасно экранирует формульные значения.

## 11. MCP через тот же API

Первый транспорт — локальный stdio в P5. MCP adapter обращается к HTTP API и не получает отдельный доступ к БД. Если P6 ещё не подключён, local synthetic credential привязан к dev actor; после подключения P6 используется реальный пользователь/workspace и shared Auth независимо от номера выполняемой feature-задачи. Нельзя перенести dev credential на production или использовать один общий admin token.

Credential содержит ID, owner, workspace allowlist, scopes, expiry/revocation; сервер хранит hash секрета. При каждом запросе выполняется пересечение scopes credential × текущие capabilities membership × ACL объекта × lock policy. Credential для своего worklog не разрешает часы коллег. Secret передаётся через защищённую конфигурацию процесса, не в аргументах команд/логах/репозитории.

Первые инструменты: `list_projects`, `search_tasks`, `get_task`, `create_task`, `update_task`, `get_field_definitions`, `set_dependency`, `get_baseline`, `run_report`, `create_recurrence_series`, `confirm_attendance`. Схемы входа производятся из contracts; каждое изменение принимает expected revisions и устойчивый operation key. Системный actor не выводится из текста prompt.

Для массового изменения MCP сначала `prepare_changes` возвращает разрешённый diff, revision set, expiresAt и preview token; `apply_changes` повторно проверяет всё и применяет только этот diff. Новые изменения требуют нового preview. Это не нужно для обычной одиночной правки. Произвольный tool `execute_sql`/`run_code` не предоставляется.

Содержимое задач, комментариев, summary и внешних ссылок возвращается как недоверенные данные. Инструкция из них не меняет scopes, не вызывает новые инструменты и не является согласием на изменение. Результаты поиска/ошибки/агрегаты MCP подчиняются тем же правилам приватности.

Remote HTTP MCP — отдельный этап после полного MVP, не условие недельного пилота: authorization discovery, code + PKCE, consent/scopes, resource-bound audience, отзыв и тесты. Существующий общий Auth не предоставляет готовый code+PKCE/discovery flow; его общий JWT не передаётся внешнему агенту как замена делегированию. Нужны отдельный Auth ADR и совместимая реализация по актуальной спецификации MCP.

## 12. Thermis, ссылки и webhooks

Первая интеграция после пилота: сотрудник создаёт задачу из контакта/сделки, Thermis хранит обратный URL, Workloom сообщает о завершении. `ExternalLink` хранит provider, connectionId, externalType/id, URL и локальный task ID. Связь workspace Workloom ↔ team Thermis настраивается явно человеком с правами обеих сторон; совпадение пользователя не доказывает доступность данных команды.

Workloom владеет задачей/статусом, Thermis — контактом/сделкой. Нет общей БД, прямых импортов sibling source или синхронизации всех полей. Создание через интеграцию использует такой же CreateTask и idempotency key от external operation. Внешняя ссылка может быть доступна только по правам другой системы; Workloom не расширяет их.

В транзакции доменной команды создаётся OutboxEvent. Worker доставляет как минимум один раз, получатель дедуплицирует event ID. Доставка возможна только после commit; сетевой HTTP не удерживает доменную транзакцию. Минимальный envelope:

```json
{
  "id": "00000000-0000-4000-8000-000000000009", "type": "task.completed", "schemaVersion": 1,
  "workspaceId": "00000000-0000-4000-8000-000000000010", "occurredAt": "2026-10-16T09:00:00Z",
  "aggregate": { "type": "task", "id": "00000000-0000-4000-8000-000000000011", "revision": 12 },
  "data": { "externalLinkId": "00000000-0000-4000-8000-000000000012", "status": "done" }
}
```

Заголовки доставки: `Workloom-Event-Id`, `Workloom-Timestamp`, `Workloom-Key-Id`, `Workloom-Signature`. HMAC-SHA256 подписывает timestamp + разделитель + точные raw bytes; получатель проверяет временное окно, подпись constant-time и event ID. Повтор может иметь новый delivery timestamp/signature, но неизменный event ID. Ротация секрета поддерживает ограниченное перекрытие key IDs.

Retries: exponential backoff с jitter, Retry-After, ограничение попыток/срока, dead-letter и ручной replay; replay не меняет event ID. Out-of-order revision не должна откатывать статус CRM; при сомнении получатель читает текущее состояние доступной задачи. Доставка 2xx означает приём, не бизнес-успех второго продукта.

Webhook endpoint проверяется при настройке: HTTPS, разрешённый host, запрет внутренних/loopback/metadata IP и повторная проверка после DNS/redirect. Credentials не попадают в URL. Минимальный payload не содержит запись созвона, summary или персональные часы. Перед доставкой повторно проверяются connection access/отзыв; приватная задача не уходит в общую CRM по ранее созданной подписке.

Журнал доставок хранит event ID, получателя, попытки, HTTP outcome и безопасную ошибку; секреты/body личных встреч не логируются. Входящие webhooks также проходят подпись, deduplication, tenant mapping и общий command layer. Защита от циклов — origin/correlation IDs и один владелец каждого изменяемого поля.

## 13. Условия готовности API

Для недельного пилота проверяется реализованный набор P3 + минимальный импорт P5.4/P5.6 + P6 согласно [07](07-verification-and-pilot.md). Тесты подтверждают одинаковое поведение доступных UI/HTTP/import/job для cutoff, ACL, revisions и времени. MCP, P4 и остальные расширения P5 получают те же контрактные проверки при добавлении; их отсутствие в раннем пилоте не считается пройденным тестом и не задерживает пилот. Обязательны негативные проверки двух workspace, отзыва membership, приватного report cache/export, повторного attendance, retry после потерянного ответа, stale batch preview и остановки worker между commit и delivery.

OpenAPI и MCP schemas строятся из общих DTO; примеры проверяются как fixtures; каждый endpoint имеет capability, границу транзакции, идемпотентность и правило приватности. До подключения защищённого входа P6 используются только локальные synthetic actors; последующая работа над P4/P5 может использовать shared Auth в защищённой среде. Наличие описанного маршрута не означает, что он реализован, протестирован или доступен в Railway.
