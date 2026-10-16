# План реализации Workloom

Версия от 16 октября 2026 года. Локально приняты P0 и ограниченные P1a/P1b/P2a/P2b/P3a/P3b/P4a/P4b/P5a; P3b добавил конечные серии встреч, protected calendar census и отдельный recurrence worker. Точные gates, initial failures, исправления и source checkpoints — в [11](11-implementation-progress.md). Полный P1/P2/P3/P4/P5, P6, MVP и пилот не завершены. Приёмка ниже сохраняет будущие требования. Стек — [02](02-architecture.md), данные — [03](03-domain-and-data.md), API — [04](04-api-and-integrations.md), клиент — [05](05-client-and-ux.md).

## Порядок работы

Сначала рабочий локальный продукт без входа и основной недельный процесс; затем минимальный импорт, подключение реальных пользователей и Railway для раннего пилота. Gantt/граф и полный конструктор отчётов с MCP завершают полный MVP, но не задерживают проверку основной работы командой. Каждый этап заканчивается demonstrable vertical slice: данные проходят от UI через API и правила в PostgreSQL. Готовая картинка с mock state не заменяет этот результат.

| Этап | Результат для пользователя | Зависит от | Вход |
| --- | --- | --- | --- |
| P0 | Приложение запускается локально, виден workspace и тестовые участники | Подготовленная монорепа | Dev actor |
| P1 | Можно вести таблицу задач с полями и участниками | P0 | Dev actor |
| P2 | Можно спланировать/зафиксировать/закрыть неделю и получить отчёт | P1 | Dev actor |
| P3 | Общие созвоны создаются по расписанию и начисляют личное время | P2 | Dev actor |
| P4 | Зависимости видны в графе и Gantt | P1, P2 для baseline дат | Dev actor или Shared Auth после P6 |
| P5 | Отчёты, импорт Asana и локальный MCP; это независимые подзадачи | P2, P3 для встреч; P4 только для импорта dependency edges | Dev actor или Shared Auth после P6; scoped MCP credential |
| P6 | Настоящая команда входит, работает на Railway и проходит недельный пилот | P0–P3 + минимальный импорт P5.4/P5.6 | Shared Auth |

Идентификаторы P0–P6 обозначают функциональные блоки, а не обязательную хронологию всех работ. Рекомендуемый путь первого командного пилота: P0 → P1 → P2 → P3 → P5.4/P5.6 → P6. P5.5 добавляется до переноса, только если выбранные данные нельзя надёжно перенести без Asana API. Gantt/граф P4, расширенные отчёты, MCP и остальная P5 идут параллельно либо после этой недели. Полный MVP завершается после P4/P5. P4 допускает параллельную реализацию с P3 после стабилизации contracts. Клиент и сервер одной функции можно разрабатывать параллельно только после согласования DTO. Schema migration, freeze/accounting и permission boundaries должны иметь одного владельца изменения.

## Общие правила завершения задачи

- Согласованы scope, affected modules и критерий поведения.
- Domain command работает независимо от HTTP route и компонента.
- Изменение DTO обновляет schemas, ошибку/пустое состояние UI и contract tests.
- Миграция проверена на пустой базе и на предыдущей схеме с контрольными данными.
- Пройдены проверки соответствующего инварианта; blocked/skipped явно отделены от pass.
- PR/commit или локальный отчёт перечисляет изменённые файлы, результат, команды проверки и ограничения.
- Документация описывает итоговую реализацию, а не оставляет несовместимое обещание рядом с кодом.

Результат одного этапа не означает автоматическое разрешение deployment или приглашения команды. Локальная проверка P0 не включает deployment, приглашения и внешние сообщения; они не выполнялись.

## P0 Каркас и локальный запуск

Цель: первый сквозной запуск React → Fastify → PostgreSQL без экрана логина.

| ID | Работа | Владение | Приёмка |
| --- | --- | --- | --- |
| P0.1 | npm workspaces, Node 24, strict TS, shared configs, root scripts | root, packages/config | Один lockfile; чистая установка и build |
| P0.2 | Vite React shell, Router, токены Thermis, sidebar/project area | apps/web, packages/ui | Работает desktop shell; нет копирования CRM flows |
| P0.3 | Fastify app factory, config validation, error envelope, request ID | apps/api, packages/contracts | Health endpoint, typed error, корректный shutdown |
| P0.4 | Drizzle connection, migrations runner, users/workspaces/memberships seed | packages/db | Пустая БД создаётся миграциями; повтор seed не дублирует fixtures |
| P0.5 | IdentityAdapter/dev actor, trusted CommandContext, policy skeleton | api/identity, domain/access | Workspace denial работает даже без логина |
| P0.6 | Workspace list endpoint + Query client + actor indicator | contracts, API, web | Видно workspace из БД, второй fixture workspace недоступен чужому actor |
| P0.7 | Local compose Postgres, .env.example, CI/typecheck/unit smoke | infra, scripts, tests | Документированный запуск из чистого checkout |

Минимальные fixtures: 6 участников команды, второй workspace с чужим пользователем, стабильные IDs и заведомо синтетические имена. Права должны быть server-owned. Переключение fixture actor — dev-only функция с allowlist, не универсальный header в production.

Корневые команды P0 (актуальный список и quickstart — в корневом [README](../README.md), результаты прогонов — в [11](11-implementation-progress.md)): `npm run dev`, `dev:api`, `dev:web`, `build`, `typecheck`, `lint`, `test:unit`, `test:integration`, `test:e2e`, `db:generate`, `db:migrate`, `db:seed:demo`. P0 реализует применимые команды; test:e2e может ограничиться одним smoke. Для текущего worker доступны workspace scripts `npm run dev --workspace @workloom/worker` и `npm run start --workspace @workloom/worker`, явная queue migration — `npm run db:queue:migrate`; для P5 — `mcp:stdio`. Не создавать пустые зелёные тест-команды.

Демонстрация: локально открыть страницу без логина, увидеть пространство из PostgreSQL, сменить тестового actor и получить корректную выборку. Перезапуск сохраняет workspace. Публичная APP_ENV=staging/production или Railway environment с AUTH_MODE=dev отклоняется. Отдельно проверяется локальная оптимизированная dist-сборка: APP_ENV=local, NODE_ENV=production, loopback и синтетическая БД.

Самодостаточное задание: [09](09-first-implementation-task.md). Статус: локальный checkpoint P0 проверен 16 октября 2026 года в рабочем дереве без коммита; Docker-путь запуска PostgreSQL на этом хосте не исполнялся, см. [11](11-implementation-progress.md).

## P1 Таблица задач и дополнительные поля

Цель: воспроизвести повседневную таблицу со скриншота без ручного дублирования общей задачи.

Статус: локально проверены и приняты координатором ограниченные P1a и P1b. P1a — проекты, секции, статусы, tags, задачи workspace, участники с собственной ревизией, общая оценка WorkPackage и added scope, идемпотентность, ревизии, tenant safety, pagination, архив; UI таблицы, карточки, дочерней задачи и фильтров по участнику и поиску. Ранний частичный checkpoint API/DB исторический и на своё время не был принят. P1b добавил 9 типов custom fields, shared project columns, independent value revisions, selective immutable history и custom locks. Это ограниченная реализация P1.4/P1.5; полная история built-in fields, сохранённые представления и private ACL задач (P1.8), массовые правки (P1.9) и полный командный пилот ещё не завершены. Приёмка ниже не изменена, доказательства — в [11](11-implementation-progress.md).

| ID | Работа | Владение | Приёмка |
| --- | --- | --- | --- |
| P1.1 | Projects, sections, tasks, statuses, participants, initial WorkPackage | domain/tasks, db | Одна задача, стабильные IDs, несколько участников, archived вместо потери истории |
| P1.2 | Task create/update/archive/reorder и revision preconditions | contracts, domain, API | Две параллельные правки не теряют данные молча |
| P1.3 | Parent/subtask hierarchy и проверки cycles | tasks, db | Перенос не создаёт цикл и не меняет происхождение работы |
| P1.4 | Typed fields/options/values, registry editors | fields, web | Переименование/перестановка не ломает значения и фильтры |
| P1.5 | Column history toggle, policy change audit | fields, audit | История есть с момента включения; отключение не удаляет записанное |
| P1.6 | Table columns, grouping, sorting, sums, selection, inline edit | web/table | Enter/Tab, разворот подзадач и видимые групповые суммы |
| P1.7 | Task drawer, description, comments, links, mention model | tasks, web | Карточка открывается без потери контекста таблицы |
| P1.8 | Saved personal/shared views и basic task ACL | views, access, web | Private row не появляется у чужого fixture actor в таблице/поиске |
| P1.9 | Bulk edit/paste и virtualization | web, API | Preview, ошибки по ячейкам; atomic scope явно указан |

Типы полей: text, number, duration, date, single/multi-select, person, boolean, URL. Дополнительный select «Тип работы» аддитивен; произвольные Tags допускают пересечение. Priority настраивается через single-select.

На первом проходе P1 hours estimate отображает текущее duration value. В P2 он связывается с period commitment. Перед этим нельзя называть его immutable baseline. Генерация DTO и data migration должна сохранить уже введённые значения с происхождением, не выдать их за исторически согласованный план.

Для совместной задачи список участников не означает автоматическое умножение оценки. Для обычной работы бюджет распределяется явно. До ввода встреч базовая модель участника уже поддерживает личные часы.

Демонстрация: ввести 20 задач и подзадачи, добавить custom column, поменять тип/опции безопасным доступным способом, отфильтровать человека, отредактировать и открыть историю. Попытка несовместимого изменения типа поля должна требовать отдельной migration/нового поля, а не терять значения.

## P2 Недельный план факт и первые отчёты

Цель: автоматизировать ваш основной сценарий раньше Gantt и полного report builder.

| ID | Работа | Владение | Приёмка |
| --- | --- | --- | --- |
| P2.1 | PlanningPeriod, commitments, allocation, current remaining forecast | planning, db | Whole-task estimate не смешивается с недельным планом |
| P2.2 | Worklog и revisions, work_precision=day\|period, quick Hours Fact | time, web | Missing и confirmed zero различаются; weekly value не рисуется как daily |
| P2.3 | Workspace write barrier, cutoff, atomic snapshot/audit | domain transactions, db | Изменение после cutoff не меняет исходный snapshot даже при отставшем worker |
| P2.4 | Личная/общая фиксация, field policy editor, read-only UI | planning, fields, web | Смена исполнителя не снимает личную фиксацию |
| P2.5 | Корректировки, закрытие факта и ReportRun cutoff | planning, reports | Исходный и исправленный отчёт воспроизводимы |
| P2.6 | Split, replace, added scope, carryover | tasks/planning, web | Родитель/дети не удваивают budget/fact, новая неделя не сбрасывает исходную оценку |
| P2.7 | Три шаблона: план/факт, добавленный объём, тип работы | reports, web | Серверные суммы совпадают с fixtures, drilldown объясняет число |
| P2.8 | Required fact on Done, missing data widget | policies, web | Ноль подтверждается; отсутствие оценки не превращается в 0% ошибки |

Упорядочение реализации: сначала точная семантика чисел и test fixtures, затем транзакции, затем UI фиксации. Историю и snapshot нельзя добавлять в конце поверх mutable counters.

Минимальный конструктор правил этого этапа — фиксированные triggers/actions: ручная фиксация, scheduled cutoff, требование факта перед Done, закрытие периода. Условия — простые фильтры AND. Правило не исполняет пользовательский JavaScript. Доступ к source records проверяется до агрегации.

Демонстрация: оценка 8 часов → фиксация → split на 3 и 7 часов факта → отчёт +2 часа/+25%; добавленная работа отдельно. Другая задача 20 часов с недельным планом 6 сравнивается с недельным фактом, а полная точность — после завершения пакета. Повторное открытие закрытого отчёта даёт те же исходные цифры.

## P3 Общие встречи и повторения

Статус: ограниченные P3a/P3b локально приняты. Разовые/повторяющиеся shared meetings, explicit personal plan/attendance, DST preview, exceptions/version edits, полный bounded census перед freeze и отдельный worker реализованы по [15](15-p3a-contract.md)/[16](16-p3b-contract.md). Это не полный P3: private grant list, полная My Tasks projection, внешние календари и production не проверены. Последовательность actual gates и найденные исправления — в [11](11-implementation-progress.md).

Цель: пять общих задач вместо пяти личных копий на каждого сотрудника.

| ID | Работа | Владение | Приёмка |
| --- | --- | --- | --- |
| P3.1 | RecurrenceSeries, schedule version, occurrence key, exceptions | meetings, db | Daily/weekly с weekday, timezone, end/count |
| P3.2 | pg-boss worker, outbox relay, generation horizon | worker, db | Restart/retry не дублирует экземпляры |
| P3.3 | Materialize week before freeze, recurrence edit scope | meetings/planning | Отставший worker не теряет плановые встречи в baseline |
| P3.4 | Participant attendance и индивидуальные план/факт | meetings/time | Неявившийся не получает часы; unconfirmed отличается от absent |
| P3.5 | One-click attendance posting, adjustment/revoke | domain, web | 1 час × 5 участников = 5 человеко-часов один раз |
| P3.6 | Pinned meetings section, My Tasks projections | web | Одна сущность видна в нескольких местах без двойного счёта |
| P3.7 | Recording/summary links per occurrence, private grant list | tasks/access, web | Ссылки вчера не копируются в завтра, метаданные приватной встречи защищены во всех каналах |
| P3.8 | Cancel/move occurrence, this-and-future, time zone tests | meetings, tests | ID не меняется при переносе; зафиксированное прошлое не переписывается |

Workloom защищает запись и URL внутри продукта. Доступ к самому видео/summary регулирует внешний провайдер; уже увиденную ссылку нельзя отозвать изменением Workloom ACL. Для личных встреч используются ссылки с ограничением доступа у провайдера.

Отсутствие человека не удаляет его исходный недельный план. Удаление из серии, отметка отсутствия и отзыв доступа — разные операции. При отмене уже проведённого созвона система требует явную корректировку факта, а не стирает начисления.

Демонстрация: серия пяти часовых созвонов, шесть участников; один отсутствовал в среду, другой был полчаса в четверг. В недельных отчётах правильные часы каждого. Повторный save/MCP retry не меняет сумму; личная встреча недоступна с другой fixture identity.

## P4 Зависимости Gantt и граф

Статус: ограниченный P4a локально принят — finish-to-start dependencies/cycles, authoritative warn/enforce blocking, current graph выбранного набора и собственный full-set layout по [17](17-p4-contract.md). Ограниченный P4b также принят по [18](18-p4b-contract.md): date-only start/due, bounded Gantt window, typed/day-shift edit через readonly review/atomic apply, immutable baseline date overlay. Pointer drag, auto cascade и остальной P4 остаются будущими. Acceptance tables ниже сохраняют будущие требования; точные gates/failures/fixes — в [11](11-implementation-progress.md).

| ID | Работа | Владение | Приёмка |
| --- | --- | --- | --- |
| P4.1 | Dependency model + add/remove commands | dependencies, db | Нет self/cross-workspace/cycle, включая concurrent opposite edges |
| P4.2 | Blocking policy и task card indicator | domain, web | Невыполненный blocker предупреждает/блокирует по выбранной политике |
| P4.3 | Gantt rows, date ranges, drag edits, baseline overlay | web | Целочисленные часы не выдаются за календарную длительность |
| P4.4 | React Flow nodes/edges, auto layout, saved positions | web | Перемещение узла не меняет задачу или дату |
| P4.5 | Person/project filters и external blockers | queries, web | Filter-hidden blocker виден как контекст; ACL-hidden детали не раскрываются |
| P4.6 | Keyboard alternatives и loading/error states | web/tests | Связь можно создать без drag/drop |

В MVP finish-to-start, ручное изменение дат с preview затрагиваемых полей, без автоизменения всей цепочки. Нет critical path, ресурсов, расчёта рабочих смен и всех четырёх типов зависимостей. Gantt/graph читают одни edges и commands.

Демонстрация: A блокирует B, B блокирует C. Видно в карточке, графе и Gantt. Попытка C → A отклоняется. Фильтр по человеку не превращает заблокированную задачу в визуально свободную.

## P5 Отчёты импорт и MCP

Статус: ограниченный P5a по [19](19-p5-import-contract.md) реализует CSV до50 строк задач, явное сопоставление пяти скалярных типов, readonly preview, atomic create/skip и полную сверку исходника. Это не полный Asana import, перенос приватных ACL, report builder или MCP. Точные текущие gates и границы — в [11](11-implementation-progress.md); acceptance table ниже сохраняет будущие требования.

| ID | Работа | Владение | Приёмка |
| --- | --- | --- | --- |
| P5.1 | ReportDefinition safe query schema, metrics registry | reports/contracts | Source, metric, group, filter, period и basis валидируются |
| P5.2 | Builder + bar/stacked/line/table + saved reports | web | Из шаблона можно получить отчёт по custom field без SQL |
| P5.3 | Export и pinned ReportRun/late corrections | reports, worker | Export и UI совпадают; history не обходится старой ACL |
| P5.4 | CSV/JSON import staging, preview/mapping/reconciliation | import, worker, web | Повтор import не создаёт копии; несовпадения перечислены |
| P5.5 | Asana API enrichment для subtasks/links/comments | import | Pagination/retry соблюдены; недоступные вложения явно отмечены |
| P5.6 | Source provenance, unknown actors/dates, baseline restrictions | import/planning | Текущая импортированная оценка не выдаётся за исходную |
| P5.7 | Scoped local credentials, stdio MCP adapter | API/access/MCP | Тот же command policy; token не заменяет membership |
| P5.8 | MCP task/search/report/meeting actions и replay tests | MCP/tests | Встречи/мутации идемпотентны, приватные записи скрыты |
| P5.9 | Comment mentions/in-app inbox, file upload if needed | tasks/web/storage | Уведомления и signed download не раскрывают приватное содержимое |

Файлы: ссылки достаточно для записей встреч. Если пилоту нужны загруженные файлы, включить object storage adapter, auth download, size/type checks и backup/ref integrity до P6. Не хранить значимые файлы в ephemeral container. Если команда подтверждает, что ссылок достаточно, actual upload можно отложить, явно сохранив ограничение импорта.

Минимальный импорт для пилота — P5.4/P5.6 на выбранном объёме, с P5.5 при необходимости обогащения. На этом пути можно пока не создавать полный report builder, exports всех типов и MCP: достаточно трёх отчётов P2, сверки импорта и возможности сохранить новые данные для возврата. Зависимости из источника не теряются молча: либо реализовать P4 до переноса требуемых edges, либо явно исключить такие задачи из ограниченного пилота и сохранить mapping для последующего импорта.

MCP OAuth remote и интеграция с Thermis не блокируют пилот. На P5 реализуется локальный stdio и внутренний API contract. Credential хранится hash+scopes+workspace binding+expiry, без чтения общей Auth access token клиентом.

Демонстрация: импорт одной тестовой недели повторён дважды; counts и суммы не изменились. Builder показывает время по человеку/типу, drilldown и export совпадают. MCP создаёт задачу и запрашивает тот же отчёт, но не видит приватную встречу другого actor.

## P6 Auth Railway и первая неделя команды

Этот release-блок запускается после P3 и минимального импорта, не ожидая всех P4/P5. Трёх отчётов P2 достаточно для первого недельного цикла. После подключения Shared Auth следующие модули используют настоящие сессии; dev fixtures остаются только локальными тестами. Миграции именуются в фактическом порядке выполнения, а не сортируются по P-номеру.

| ID | Работа | Владение | Приёмка |
| --- | --- | --- | --- |
| P6.1 | Shared Auth adapter + BFF, session revoke, refresh serialization | identity/API | Несколько вкладок не роняют сессию, callback allowlist и CSRF проверены |
| P6.2 | Real workspace create/invite/accept/member revoke | access/web | Приглашение связано с доверенной identity, не только строкой email |
| P6.3 | Demo isolation, migration of test fixtures avoided | DB/import | Реальная база создаётся чисто, перенос только через mapping/import |
| P6.4 | Production image app/worker, Railway configs, migration job | infra | Same image revision, health/readiness, no dev actor routes |
| P6.5 | Staging test run, upgrade/old tabs and rollback rehearsal | QA/ops | Старая вкладка получает контролируемое обновление с сохранением несохранённого ввода |
| P6.6 | Backup/restore, monitoring, jobs recovery | ops | Восстановленные задачи, snapshot и часы совпадают с контролем |
| P6.7 | Asana dry run + signed-off cutover manifest | import/owner | Число задач/связей/часов проверено, ограничения названы |
| P6.8 | Недельный пилот 5–7 человек | product/owner | Команда ведёт выбранный объём в одном источнике, итоговый отчёт совпадает с контрольной выборкой |

На этом этапе нужны реальные browser tests: вход, приглашение, private meeting, revoked user, refresh, общий отчёт и старый tab после обновления. Проверка anonymous root HTTP недостаточна. Успех dev actor тестов не означает проверку Auth.

Railway provisioning/deployment и отправка приглашений выполняются после конкретного разрешения Павла на подготовленный выпуск. Само наличие этого плана ничего не разворачивает.

## Требования и место реализации

| Требование | Этап | Основная проверка |
| --- | --- | --- |
| Таблица как в текущем процессе | P1 | CRUD, клавиатура, sums, сохранённые виды |
| Логи выбранных колонок | P1, P2 | Before/after, policy changes, сохранение истории |
| Неизменная исходная оценка | P2 | Freeze/split/replace/carryover race fixtures |
| Несколько исполнителей | P1, P2 | Общий budget не умножается автоматически |
| Повторяющиеся созвоны | P3 | Occurrence stability, attendance, dedup, DST |
| Частные встречи | P1→P6 | ACL across channels; реальная identity в P6 |
| Gantt/граф | P4 | Одна модель edges, cycle prevention |
| Настраиваемые отчёты | P2→P5 | Правильные знаменатели/cohorts/privacy |
| Импорт Asana | P5→P6 | Idempotency, provenance, mapping, reconciliation |
| MCP | P5 | Ограниченные credentials и общие commands |
| Общий Auth | P6 | BFF, multi-tab, tenant revoke |
| Railway | P6 | Build/migrate/health/restore/old tabs |

## После пилота

Завершить оставшиеся P4/P5, если они не выполнены параллельно пилоту. Следующие расширения выбирать по результатам недели: полноценный remote OAuth MCP, Thermis webhook, Kanban/Calendar, advanced role editor, formula fields, timer, capacity, авто-перепланирование с preview и другие recurrence patterns. Эти функции не должны появляться скрытыми обязательствами P0.

Подключение личных внешних календарей рассматривается только после первого пилота P6. Это не зависимость P0–P6 и не часть P3. Дизайн и будущая матрица приёмки находятся в [10](10-calendar-integration.md); calendar view Workloom от него не зависит.

## Организация реализации

План задаёт порядок, но не обещает календарную дату. После P0–P1 оценить реальные затраты на table UX, миграции и tests, затем прогнозировать P2–P6. Для параллельной работы фиксировать file ownership, не делить одну миграцию между несколькими авторами. Новые команды сначала получают fixture/test of invariant, затем API/UI.

Каждый milestone возвращает: сценарий демонстрации, изменения схемы, что прошло/не прошло, текущие ограничения, следующий bounded task. Начинать с [первого задания](09-first-implementation-task.md), не с реализации всей спецификации сразу.
