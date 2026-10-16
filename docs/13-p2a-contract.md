# P2a: контракт ограниченного недельного цикла

Статус: контракт зафиксирован 16 октября 2026 года после checkpoint P1b `dee59bae06be4505b4a60e0bf469d31c8816aeda`. Реализация и проверки P2a ещё выполняются; этот документ не является доказательством готовности. Авторинг текущего прохода — Codex gpt-6.1-sol high после реального отказа Claude Opus по пятчасовому лимиту; возврат к Claude согласуется отдельно после reset.

Источники: [модель и cutoff](03-domain-and-data.md), [API](04-api-and-integrations.md), [интерфейс](05-client-and-ux.md), [журнал](11-implementation-progress.md). Точные схемы экспортируются из `packages/contracts/src/planning.ts`; публичный порт — `packages/domain/src/planning/application.ts`.

## Граница

P2a реализует недельный период, персональные commitments и allocations, личную/проектную фиксацию, первую известную полную оценку пакета с provenance, ручной факт с точностью «период», неизменяемый weekly plan/fact report run и детализацию. Недельный план не заменяет общую оценку пакета.

Отложены: закрытие факта и исправления закрытого периода, принятие поздней неизвестной общей оценки, полная точность завершённого пакета, split/replace/transfer/carryover-команды, дневной факт, произвольные политики, recurrence, MCP transport и deployment. Текущий встроенный приоритет остаётся enum P1a.

## HTTP и порт

Все пути имеют prefix `/api/v1/workspaces/:workspaceId`. Успех — прежний `{data,meta:{requestId,nextCursor?}}`; списки возвращают массив в data и реальный nullable nextCursor. Все записи требуют `Idempotency-Key`; preview — согласованное чтение без ключа. UUID нормализуются общей схемой. Контекст actor/workspace/source всегда серверный.

| Метод и путь | Input/query schema | Result schema / метод PlanningApplication |
| --- | --- | --- |
| GET `/periods` | `planningPeriodListQuerySchema` | `planningPeriodListResponseSchema` / listPeriods(ctx,query) |
| POST `/periods` (201) | `createPlanningPeriodInputSchema` | `planningPeriodResponseSchema` / createPeriod(ctx,input) |
| GET `/periods/:periodId` | — | `planningPeriodResponseSchema` / getPeriod(ctx,periodId) |
| PATCH `/periods/:periodId` | `updatePlanningPeriodInputSchema` | `planningPeriodResponseSchema` / updatePeriod(ctx,periodId,input) |
| GET `/planning-packages` | `planningPackageListQuerySchema` | `planningPackageListResponseSchema` / listPackages(ctx,query) |
| GET `/periods/:periodId/commitments` | `periodCommitmentListQuerySchema` | `periodCommitmentListResponseSchema` / listCommitments(ctx,periodId,query) |
| POST `/periods/:periodId/commitments` (201) | `createPeriodCommitmentInputSchema` | `periodCommitmentResponseSchema` / createCommitment(ctx,periodId,input) |
| PUT `/periods/:periodId/commitments/:commitmentId` | `updatePeriodCommitmentInputSchema` | `periodCommitmentResponseSchema` / updateCommitment(ctx,periodId,commitmentId,input) |
| POST `/periods/:periodId/freeze-preview` | `freezePreviewInputSchema` | `freezePreviewResponseSchema` / previewFreeze(ctx,periodId,input) |
| POST `/periods/:periodId/freeze` | `freezePlanInputSchema` | `planBaselineResponseSchema` / freezePlan(ctx,periodId,input) |
| GET `/periods/:periodId/baselines` | `planningPageQuerySchema` | `planBaselineListResponseSchema` / listBaselines(ctx,periodId,query) |
| GET `/baselines/:baselineId` | — | `planBaselineResponseSchema` / getBaseline(ctx,baselineId) |
| GET `/package-baselines/:baselineId` | — | `packageBaselineResponseSchema` / getPackageBaseline(ctx,baselineId) |
| GET `/worklogs` | `workLogListQuerySchema` | `manualPeriodWorkLogListResponseSchema` / listWorkLogs(ctx,query) |
| PUT `/tasks/:taskId/manual-period-work/:periodId/:membershipId` | `setManualPeriodWorkInputSchema` | `manualPeriodWorkLogResponseSchema` / setManualPeriodWork(ctx,taskId,periodId,membershipId,input) |
| GET `/report-runs` | `reportRunListQuerySchema` | `weeklyPlanFactReportRunListResponseSchema` / listReportRuns(ctx,query) |
| POST `/report-runs` (201) | `createWeeklyPlanFactReportInputSchema` | `weeklyPlanFactReportRunResponseSchema` / createReportRun(ctx,input) |
| GET `/report-runs/:runId` | — | `weeklyPlanFactReportRunResponseSchema` / getReportRun(ctx,runId) |
| GET `/report-runs/:runId/rows` | `planningPageQuerySchema` | `weeklyPlanFactRowListResponseSchema` / listReportRows(ctx,runId,query) |

Каждый list-метод порта возвращает `PlanningPage<T> {items,nextCursor}`. Queries содержат limit 1–100 (по умолчанию 50), cursor; periods/packages требуют projectId, worklogs/report-runs — periodId, commitments допускают membershipId, worklogs также taskId/membershipId. Никаких молча усечённых страниц. Курсоры подписаны, связаны с actor/workspace/permission epoch/фильтрами; restart API требует повторной загрузки первой страницы.

Composition: `@workloom/db createPlanningApplication(databaseOrExecutor, options?) : PlanningApplication`, options включают существующие transaction timeouts и необязательный cursorSecret для тестов. Реальные factories задач и полей обязательно подключают один planning guard: убрать guard в отдельном transport нельзя.

## Период и план

`PlanningPeriodDto`: id/workspaceId/projectId/name, localStart, вычисленный localEndExclusive через семь календарных дней, IANA timezone, cutoffAt UTC, state planning|frozen, revision, protectedFieldIds, protectEstimate, projectBaselineId, timestamps. Интерфейс ввода cutoff использует локальные дату/время браузера и показывает его IANA zone; timezone самого периода задаёт календарные границы недели отдельно. Невалидная дата/DST gap отклоняются round-trip проверкой; повторяющееся осеннее wall time пока разрешается выбором browser Date (явный IANA overlap chooser отложен). Create задаёт start/timezone/cutoff/protection; изменение start/timezone существующего периода не поддерживается. Owner/admin создаёт/настраивает период; после любой фиксации его политика неизменна в P2a.

`PeriodCommitmentDto`: стабильные period/package/member, nullable plannedMinutes, allocations `{taskId,minutes}`, nullable unallocatedMinutes, state active|removed, revision, classification planned|added, baselineIds. POST требует `expectedAbsent:true`; существующая тройка конфликтует, включая removed. PUT требует actual expectedRevision и задаёт полный план/allocations/state. Null — неизвестно, не ноль. Сумма allocations не больше известного персонального плана; для null допустимы только нулевые allocations. Остаток явно нераспределён. Нельзя одновременно распределить минуты на ancestor и descendant одного дерева: rollup родителя не ещё один бюджет. Related IDs проверяются по workspace/project/package; foreign/missing — 404, видимая несовместимость — 422.

`plan.write_self`: member/owner/admin для своего membership; `plan.write_others`: owner/admin. Freeze_self и freeze_project отдельны. Viewer читает, но не пишет. Чужой actor/header никогда не меняет исполнителя.

При объединении личных снимков общие package/task/field-definition/value берутся из наиболее раннего источника по numeric changeSeq, затем frozenAt/ID; сохраняются все sourcePersonalBaselineIds. Собственное имя человека берётся из его личного снимка. Личная фиксация защищает исходные commitments человека; проектная включает личные снимки как источники и фиксирует оставшихся. Новые commitments после личной фиксации остаются added даже до общей. После cutoff новая работа и факт разрешены: сервер выводит added/unplanned относительно immutable baseline. Клиент не передаёт classification. Detail child делит исходный package; added_scope создаёт другой package. Новая строка не превращается в исходный commitment скрытым upsert.

## Preview, immutable snapshot и locks

`previewFreeze` принимает `{scope:self|project}`. Ответ `FreezePreviewDto` содержит periodId/scope/membershipId, previewHash SHA256, полный snapshot и existingBaselineId. `freezePlan` принимает тот же scope и previewHash. Hash вычисляется по каноническому полному source manifest: period/policy, все выбранные commitments/allocations, task/participant/package revisions и значения, custom definitions/options/values, membership/source personal baselines, active membership census, actor/current permission epoch и census всех существующих project packages. Freeze пересчитывает под workspace barrier; изменившийся источник — 409 PREVIEW_STALE до пользовательских записей. Period revision сам по себе не достаточен.

`PlanBaselineDto` хранит scope/member/mode manual|cutoff, requestedCutoffAt, actual frozenAt после barrier, actor/source/changeSeq и immutable snapshot schemaVersion1. Snapshot включает ID и значения tasks/memberships/fields/options, исходные commitments, packages, все существовавшие projectPackageIds и sourcePersonalBaselineIds. Никаких mutable joins для восстановления исходных имён/оценок. Immutable package_freeze_observations сохраняет первую связанную фиксацию пакета даже при null и protectEstimate:false. PackageBaseline создаётся только если оценка уже известна в эту первую связанную фиксацию (включая 0), с source revision и `first_known_plan_freeze`; null остаётся null в snapshot и provenance навсегда. Позднее известное значение после неизвестной первой фиксации не создаёт такой baseline, даже в другом периоде. Позднее заполнение не выдаётся за исходную оценку.

Выбранное отсутствующее значение хранится `{taskId,fieldId,value:null}`; присутствующее typed-null — полноценный value DTO. Lock связан с task/field ID даже без value-row. Estimate lock связан с WorkPackage ID, включая неизвестный estimate. Снятие участника/reparent не снимают lock. Обычная поздняя правка этих значений отклоняется; явное принятие/коррекция поздней оценки отложено. Прочие текущие поля могут меняться, не переписывая snapshot. Архив задачи сохраняет прежние allocations и snapshots; новые allocations на архивную задачу запрещены. Reparent проверяет, что текущий commitment не получает одновременно ancestor/descendant. Пакетная оценка через любого detail child защищена тем же ID.

Каждый новый task/field/planning write после ACL и idempotent replay выполняет ensureDuePeriodsFrozen под общим workspace barrier. Typed exhaustive intent проверяется ДО вызова handler; неизвестной permissive ветви нет. Наступивший cutoff фиксирует старое состояние. При запрете предлагаемый handler не вызывается, в той же транзакции сохраняется tagged idempotent rejection, транзакция коммитится; только затем наружу выходит 409 FIELD_LOCKED с `details:{committed:true,baselineIds:[...]}`. Повтор возвращает тот же отказ без новых snapshots/events. Неожиданная ошибка откатывает freeze и все изменения. Запрещено ловить позднюю ошибку вокруг уже писавшего handler и коммитить его частичные записи. Старые plain DTO idempotent results P1a/P1b остаются совместимы.

## Факт и отчёт

ManualPeriodWorkLogDto имеет неизменные task/package/member/period/sourceKind/sourceKey, latest revision/revisionId, minutes/state/reason/actor/time/changeSeq. Источник — строго manual_period, precision period, без выдуманной даты. PUT требует `expectedRevision:null` только при отсутствии source; существующая даже void запись требует actual revision. `minutes:0,state:active` — явный факт; void не является заполнением. Первая обычная запись не требует причины (omitted/null). Реальная коррекция существующей записи и void требуют непустую reason; одинаковый no-op причины не требует. Каждая реальная правка создаёт immutable revision; no-op не дублирует факт. Изменение исполнителя/задачи/периода под тем же ID не допускается. time.write_self/others проверяются по worker, audit — по actor. Close пока отсутствует, поэтому обычный ввод текущего факта и исправление с причиной разрешены.

POST report-runs принимает baselineId, optional membershipIds и явно названный knownEstimatesOnly. Сервер под barrier сохраняет immutable run, формулу `weekly_plan_fact_v1`, baseline и source worklog revision IDs, factCutoff/changeSeq, rows и aggregate. Дальнейшая правка факта не меняет run; новый run считает новые revisions. GET и rows повторно проверяют текущий доступ. Авторитетные числа/labels приходят с сервера, а не из загруженной части таблицы задач. Пустой membershipIds для self baseline означает только его человека, для project — всех разрешённых людей. Другой explicit membership у self baseline — 422. Run возвращает effective membershipIds, чтобы личный отчёт не включал коллег как unplanned.

Run.byPerson содержит авторитетные pinned summaries по membershipId и snapshot memberName с той же coverage-aware формулой (максимум 1000 людей в одном run; больший состав явно отклоняется, не усекается). График использует этот массив и общий summary, а не сумму загруженной страницы rows. Rows группируются по baseline commitment/package/member и отдельно по added_scope/unplanned. Старый package без исходного commitment — unplanned, действительно новый post-freeze package — added_scope; новый человек на старом package не становится исходной сопоставимой строкой. Открытые и завершённые задачи остаются исходным cohort. Detail child факты суммируются в исходный package; parent rollup, participants, tags и allocations не размножают log IDs.

Summary knownPlannedMinutes/actualMinutes относится к выбранному исходному cohort; addedActualMinutes/unplannedActualMinutes показаны отдельно, totalActualMinutes — все активные внесённые минуты. baselineCompleteness и factCoverage включают counts/ratio/complete; отсутствие/void не заменяются нулём. При любом пропуске totalVarianceMinutes/Percent = null, при нулевом плане процент null. Недельный план360/факт300 даёт −60 независимо от общей оценки1200. knownEstimatesOnly — отдельный явно помеченный subset с selectedItemCount/originalItemCount, не точность всей недели. Для нулевого cohort ratio=null, complete=false. row.packageEstimateMinutes — immutable исходная PackageBaseline estimate (если известна), а не текущая общая оценка. Drilldown содержит именно pinned worklog revisions.

## Миграция и приёмка

Новая миграция 0003; применённые 0000–0002 не редактируются. Journal strictly increasing даже если генератор выдаёт более ранний wall-clock timestamp. Composite scope FKs, immutable rows UPDATE/DELETE/TRUNCATE guards, стабильная source uniqueness и atomic audit/outbox обязательны.

Приёмка включает populated P1b upgrade с whole-row hashes, реальную гонку cutoff под PG barrier, snapshot commit + rejected edit, replay без дубликатов, unexpected fault rollback, stale preview sources, missing/null identity locks через существующие task/field endpoints, self/others ACL, frozen original vs added work, period-only fact, null/0/void coverage, pinned rerun и root/detail/tag/participant dedup. Подробные реальные результаты появятся только в журнале 11.
