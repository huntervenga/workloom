# P3b: повторяющиеся встречи и bounded worker — проект контракта

Статус: **draft для ревью, 16 октября 2026 года**. P3a-кандидат проходит QA; этот файл не утверждает готовность P3a и не разрешает P3b source/dependency/worker changes. Координатор поручил подготовить следующее ограниченное решение. Автор — Codex gpt-6.1-sol high в согласованном fallback после фактического лимита Claude; новых Claude-запросов нет. Владение этим новым draft — API lane, другие исходники не менялись.

Основания: [recurrence identity и DST](03-domain-and-data.md), [P3 acceptance](06-implementation-plan.md), [worker/operations](08-railway-and-operations.md), [P3a meetings/attendance](15-p3a-contract.md). Публичные имена/лимиты ниже — предложение к совместному freeze, не существующие exports.

## 1. Результат и граница

Одна серия daily/weekly создаёт отдельные P3a Meeting/Task/WorkPackage по номинальным локальным датам. Пользователь задаёт IANA timezone, local time, weekdays, start/end либо count и явно выбранные planning periods. Worker заранее materialize ограниченный горизонт; freeze синхронно проверяет/достраивает выбранный период тем же in-transaction domain path. Retry/restart не создаёт вторых экземпляров и не начисляет часы.

Создание серии/экземпляра создаёт **только предложения** персонального плана, как P3a. Нет автоматических commitments или attendance. Plan preview/apply и присутствие используют прежние явные authorized commands. Нельзя тихо восстановить модель «час × список участников» как автоматическую запись чужого плана/факта.

Объём: daily и weekly с выбранными weekdays; конец по дате либо count; skip/restore/move одного экземпляра; preview/apply «эта и будущие»; pause/resume генерации; bounded generation/outbox relay/health и restart proof. Произвольный RRULE, monthly, несколько номинальных вхождений серии в день, перенос записанного факта между периодами, private ACL/Auth, remote calendar OAuth, внешние уведомления/рассылки, import/export jobs и hosting/deployment отложены. Все встречи остаются workspace-visible. Cross-period move P3a всё ещё отклоняется; P3b не прячет transfer/correction внутри exception.

## 2. Модель и долговечная identity

| Сущность | Предложенные поля и invariants |
| --- | --- |
| RecurrenceSeries | id/workspaceId/projectId, revision, state active/paused, currentVersionId, generationAuthorizationId/revision, createdAt/updatedAt |
| RecurrenceSeriesVersion | id/seriesId/revision, effectiveFromNominalDate, immutable schedule/template, actor/source/time/changeSeq |
| RecurrencePeriodBinding | id/workspaceId/projectId/seriesId/periodId, revision, server-approved candidate ownership manifest; explicit period association |
| RecurrenceInstance | id/workspaceId/projectId/seriesId, occurrenceKey=originalLocalDate, periodBindingId, meetingId/taskId/workPackageId, sourceVersionId, resolvedStartAt/offset, resolutionPolicyVersion, revision/state |
| RecurrenceExceptionVersion | id/instanceId, revision, kind skip/move/restore/reset, intended/override inputs, reason, actor/source/time/changeSeq; immutable, current head separately |
| RecurrenceGeneration | id/bindingId, bounded requested range, source manifest hash, afterKey/throughKey, status/result counters; durable retry cursor, not accounting |
| RecurrenceGenerationAuthorization | id/seriesId, revision, authorizing user/membership, explicit enabled state; worker resolves current identity from DB |

Unique `(workspaceId,seriesId,occurrenceKey)` живёт дольше queue retention. Key — **первоначальная номинальная локальная дата**, не UTC start, не новый день после move/DST и не series version. Stable instance/meeting/task/package IDs не меняются при edit/cancel/restore/regeneration. Каждому instance соответствует одна Meeting и одна Task; серия сама не Task/package и не получает часов. Scoped FK связывают весь граф; JSON не заменяет source identity constraints.

Recurrence fields добавляются в fresh Meeting/task read locator как explicit metadata, а в старые stored DTO/snapshots — optional/no-default. Старые single-meeting IDs, worklog keys/heads, input hashes и report JSON не переписываются. Attendance source остаётся attendanceId, не occurrence date; исправление расписания не создаёт другой источник времени.

## 3. Schedule DTO и правила

`RecurrenceScheduleInput = {startDate,localTime,timezone,frequency,weekdays?,plannedDurationMinutes,end}`:

- startDate — calendar YYYY-MM-DD; localTime — HH:mm; timezone — IANA, не browser zone;
- frequency daily: каждый nominal date, weekdays отсутствует; weekly: weekdays —1–7 unique ISO weekday IDs;
- duration1–1440 elapsed minutes;
- end — `{kind:'on_date',endDate}` inclusive либо `{kind:'after_count',count:1..366}`; no unbounded series;
- on_date максимум366 nominal-calendar дней от startDate; вычисление after_count просматривает максимум3660 дней, превышение — явный422, без truncation;
- template: title/statusId/sectionId/organizerMembershipId/attendeeMembershipIds/joinUrl по P3a bounds/HTTP(S); recordings/summary/actual details не входят в шаблон.

Не больше одного nominal candidate серии в день. Count — **полный nominal budget серии при создании, не число оставшихся встреч**. Для after_count первоначальные startDate/frequency/weekdays/count определяют неизменную упорядоченную последовательность N nominal dates. Их редактирование и смена end kind в P3b отложены; explicit follow-up series — отдельное действие, не скрытое продление. Можно версионировать template/localTime/timezone/duration для будущих первоначальных dates, с прежними period/protection checks. Preview показывает consumedNominalCount (позиции до effective date), remainingNominalCount, skipped/cancelled counts; skip всё равно consumes свою позицию и не добавляет встречу в конце. Move сохраняет ту же позицию/key.

Для on_date cadence/weekdays/endDate можно менять только на будущих effective-date segments; startDate остаётся immutable. Preview явно перечисляет новые и исключённые future dates. Исторические отменённые rows прежней версии остаются как history; возвращение даты требует explicit restore того же ID. Нельзя задним числом пересчитать прошедший count или трактовать новый count как remaining future count.

`RecurrenceSeriesDto` возвращает current version, state, authorization readiness и число **явно связанных** периодов, а не обещание бесконечной генерации. `RecurrenceInstanceDto` возвращает nominal key, plannedPeriodId, sourceVersionId, current meeting locator, exception head и resolution warning. Calendar показывает intended local date/time и resolved local time/offset отдельно при сдвиге.

## 4. Явная связь с planning periods

Существующие periods могут перекрываться; timezone периода может отличаться от timezone серии. Поэтому series create принимает **explicit targetPeriodIds:UUID[1..52]**, все принадлежат project. Позднее отдельная команда добавляет выбранные period IDs. Worker не выбирает «первый подходящий period», не создаёт новые недели и не начисляет один instance в несколько периодов.

Binding preview перечисляет nominal candidates, resolved instants и выбранный period для каждого. При выбранных перекрывающихся periods, претендующих на один series/key, ответ422 требует снять неоднозначность. Уже назначенный series/key не перепривязывается к другому period даже после отмены; добавление конфликтующего binding —409. Assignment сохраняется независимо от worker order. **Любое** изменение timezone/localTime/rule/exception, которое переносит resolved instant уже назначенного nominal key за границу его immutable period, отклоняет весь edit409/422 до user writes. Нельзя обойти запрет через cancel старого instance и создание replacement в соседнем period. Даты серии без явно связанного period не materialize, UI показывает «Период не выбран», а не подставляет текущую неделю.

Candidate принадлежит периоду по **resolved instant**, проверенному в timezone периода. Nominal key может быть другой локальной датой в timezone серии. При DST gap/skipped date resolved instant может перейти в другой день; preview показывает это до apply. Нельзя спрятать cross-period transfer изменением zone/exception; move обязан оставаться внутри назначенного period.

Bindings не являются плановыми commitments. Их candidate ownership/census нужен для однозначного generation и freeze, включая cancelled/uncommitted occurrences. Выбор/добавление periods — явное изменение revision/source manifest и инвалидация старого preview.

## 5. Предложенный HTTP каталог

Все пути под `/api/v1/workspaces/:workspaceId`. Strict query/body, canonical UUID, trusted ctx, current task access. Mutations keyed; POST preview read-only/keyless с Origin. Все list pages1–100/default50, signed cursor actor/workspace/permission epoch/filter-bound.

| Метод и путь | Вход / ответ / порт RecurrenceApplication |
| --- | --- |
| GET `/projects/:projectId/recurrence-series` | query state/limit/cursor → SeriesDto page; listSeries(ctx,projectId,query) |
| POST `/projects/:projectId/recurrence-preview` | CreateRecurrenceSeriesInput → proposed candidates/warnings/period ownership/previewHash; previewCreate(ctx,projectId,input) |
| POST `/projects/:projectId/recurrence-series` | CreateRecurrenceSeriesInput + previewHash → SeriesDto,201; createSeries(ctx,projectId,input) |
| GET `/recurrence-series/:seriesId` | SeriesDto; getSeries(ctx,seriesId) |
| POST `/recurrence-series/:seriesId/edit-preview` | expectedRevision,effectiveFromNominalDate,desired schedule/template → full affected-instance plan/hash; previewEdit(ctx,seriesId,input) |
| POST `/recurrence-series/:seriesId/edit` | same input + previewHash → SeriesDto/result,200; editSeries(ctx,seriesId,input) |
| PATCH `/recurrence-series/:seriesId/state` | expectedRevision,state active/paused → SeriesDto; setState(ctx,seriesId,input) |
| POST `/recurrence-series/:seriesId/period-preview` | expectedRevision,periodIds → candidate ownership/hash; previewPeriods(ctx,seriesId,input) |
| POST `/recurrence-series/:seriesId/periods` | same input + previewHash → bindings/SeriesDto; addPeriods(ctx,seriesId,input) |
| POST `/recurrence-series/:seriesId/generation-authorization` | expectedRevision,expectedAuthorizationRevision → current actor authorization; authorizeGeneration(ctx,seriesId,input) |
| GET `/recurrence-series/:seriesId/instances` | periodId required,includeCancelled,limit/cursor → InstanceDto page; listInstances(ctx,seriesId,query) |
| POST `/recurrence-series/:seriesId/instances/:occurrenceKey/exception-preview` | expectedSeriesRevision,expectedInstanceRevision,desired skip/move/restore/reset + reason → old/new schedule/protected impacts/hash; previewException(ctx,seriesId,key,input) |
| POST `/recurrence-series/:seriesId/instances/:occurrenceKey/exception` | same input + previewHash → InstanceDto; setException(ctx,seriesId,key,input) |
| POST `/periods/:periodId/materialize-meetings` | bounded limit1–100,afterKey?/sourceManifestHash? → MaterializationResultDto; materializePeriod(ctx,periodId,input) |
| GET `/periods/:periodId/recurrence-readiness` | ReadinessDto pending/blocked/complete + bounded IDs available to actor; getReadiness(ctx,periodId) |

Это каталог proposals, не разрешение расширять P3a в текущем gate. Root может разделить management/exception UX на следующий checkpoint, но без stable identity, DST, freeze materialization и retry proof worker не выпускается. Поля actor/source/job capability/server time не принимаются ни одним input.

## 6. Pure resolution и DST policy

Одна domain-функция `enumerateNominalCandidates(scheduleSegments,range)` работает с calendar dates; `.add({days:1})`/weekday, не UTC +24h. `resolveOccurrence(nominalDate,localTime,ianaZone,policyVersion)` возвращает intended date/time, resolved instant/local date/time/offset, warning и runtime timezone-data provenance. Resolver общий для preview, materialization и worker.

Versioned policy `first_valid_gap_earlier_overlap_v1`:

1. Валидный local time → exact instant.
2. Autumn overlap → более ранний instant, warning ambiguous_earlier.
3. Spring gap → **первая допустимая граница после gap**, не compatible-сдвиг на размер gap:02:30 →03:00 при gap02:00–03:00.
4. Полностью пропущенная локальная дата → первая допустимая граница после skipped date; original key не меняется, warning skipped_local_date. Может совпасть с другим nominal candidate — preview показывает два разных instances, не merge/copy часов.
5. End = resolved instant + duration elapsed minutes. Calendar/IANA timezone пространства не переинтерпретирует existing resolved snapshots.

Temporal умеет различать gap/overlap, а `getTimeZoneTransition` даёт boundary нового offset. Предложенный resolver сравнивает earlier/later round-trip: обе совпали с intended wall time — overlap/обычный; ни одна не совпала — gap, берётся соответствующая transition boundary и проверяется, что она действительно закрывает этот gap. Не использовать startOfDay вместо arbitrary-gap boundary или бесконечный минутный поиск.

Проверки минимум: Asia/Nicosia spring02:30/03:30 вокруг реального перехода и autumn repeated hour; America/New_York02:30→03:00/earlier01:30; Australia/Lord_Howe30-minute gap/overlap; Pacific/Apia — 2011-12-30 skipped date; timezone UTC без transitions. Точные даты/локальные часы фиксируются по IANA runtime в fixtures; не предполагать, что переход каждого региона происходит в02:00. Pin Node/runtime image и записывать tz/ICU version, resolver/policy version; timezone-data upgrade не переписывает materialized старые instances автоматически.

Read-only probe существующей установленной Temporal implementation на Node24.19.0 / tz2026b / ICU78.3 подтвердил следующие expected values. Это проверка примеров draft, **не** тест ещё несуществующего P3b resolver/worker; install/source/runtime mutations не выполнялись.

| Zone / intended local | First-valid / earlier-overlap result |
| --- | --- |
| Asia/Nicosia — 2026-03-29 03:30 | 2026-03-29 04:00+03:00 |
| Asia/Nicosia — 2026-10-25 03:30 | 2026-10-25 03:30+03:00 (раньше +02:00) |
| America/New_York — 2026-03-08 02:30 | 2026-03-08 03:00-04:00 |
| America/New_York — 2026-11-01 01:30 | 2026-11-01 01:30-04:00 |
| Australia/Lord_Howe — 2026-10-04 02:15 | 2026-10-04 02:30+11:00 |
| Australia/Lord_Howe — 2026-04-05 01:45 | 2026-04-05 01:45+11:00 |
| Pacific/Apia — 2011-12-30 09:00 | 2011-12-31 00:00+14:00, key остаётся2011-12-30 |
| UTC — 2026-03-29 03:30 | Без сдвига, +00:00 |

## 7. Версии, exceptions и protected occurrences

«Эта и будущие» создаёт immutable SeriesVersion с inclusive effectiveFromNominalDate, не меняет старую строку. Effective segments не перекрываются. Preview показывает update/create/cancel/retained IDs, clashes, count/end consequences и hash полной source census (series/versions/bindings/instances/exceptions/meeting/task/roster/package revisions, period/locks, current authorization/memberships/permission epoch). Apply пересчитывает под barrier; stale409 до proposed writes.

Pause/resume означает **только фоновую подготовку worker**, не отмену расписания. Уже registered bindings/candidates остаются обязательными для sync ensure/freeze при active и paused. UI label — «Приостановить фоновую подготовку». Pause не удаляет original census, не снимает lock и не превращает blocked grant в complete; для остановки будущего календарного расписания нужен отдельный previewed version edit до его защиты. После cutoff нельзя скрыть исходные candidates посредством pause.

Bounded policy: version edit, затрагивающий уже прошедший, Done, ever-posted или schedule-frozen instance, целиком отклоняется с перечнем доступных actor protected targets; UI предлагает более позднюю effective date. Нет скрытого частичного редактирования будущего и нет переписывания baseline. Новые post-freeze occurrences/packages получают существующую added/unplanned classification, не становятся original задним числом.

«Только эта» — immutable exception version. Move сохраняет key/IDs и допускается только в прежнем period и по P3a schedule/roster locks. Skip/cancel не удаляет Task/Attendance/commitment/history и не void факты; опубликованный факт требует отдельной явной P3a correction. Restore переиспользует старый instance ID, не создаёт ещё один nominal source. Manual exception имеет приоритет над regeneration/новой series version, пока явный reset с expected revisions/reason/hash не отменит override.

Удалённый правилом ещё незащищённый future nominal occurrence остаётся cancelled; если дата возвращается, нужен явный restore того же ID через preview/apply. Worker не оживляет cancelled row автоматически. Recurrence edits не меняют actualStart/duration, recording/summary, attendance status, категории прошлого факта или personal plans.

## 8. Общий transaction primitive и freeze

Foundation подтвердил reusable boundary: извлечь persistence/orchestration P3a create handler в `createSingleMeetingInScope(scope,normalizedInput,stableOccurrenceIdentity,tools)`. Он получает **уже открытый MeetingWriteScope**, не вызывает public createMeeting, writer.run, runWorkspaceWrite, PlanningApplication либо shared planning guard повторно. Никакой DB lock не удерживается во время внешнего HTTP/queue ожидания.

Предлагаемый следующий internal port: `ensurePeriodOccurrencesInScope(scope:PlanningWriteScope,periodId,options:{maxCreates,reason:'worker'|'explicit'|'freeze'}):Promise<MaterializationOutcome>`. Реальная DB composition даёт bound repositories/helper на **том же tx** и scope.recordChange; freeze/task/field/planning/category/meeting factories получают обязательный materializer. Нет optional no-op production bypass и нет новой transaction при входе из performFreeze. Конкретный тип адаптера между PlanningWriteScope и MeetingWriteScope утверждает foundation до source.

Порядок под workspace barrier: current triggering principal/target access + existing replay → affected-project/source footprint новой операции → отдельно validated persisted generation authorizer только affected scope → due period/source discovery → shared internal ensure для периода → полный snapshot/locks/исходный baseline → proposed user mutation либо tagged controlled rejection → idempotency/audit/outbox → единый commit. Existing idempotent replay проверяется после current ACL и до новой materialization; replay не переписывает исходный stored outcome.

Pure enumeration/resolution сообщает число missing candidates до proposed inserts. Одна transaction создаёт максимум100 occurrences. Если freeze требует больше, он **не фиксирует частичный baseline**: controlled MATERIALIZATION_REQUIRED просит explicit/worker chunks. Explicit materialize commits bounded chunk и возвращает sourceManifestHash/nextCursor/complete; следующая chunk под barrier revalidates manifest/version/ownership, changed sources →409/restart enumeration, unique keys сохраняют уже созданные IDs.

Read-only planning/series previews не создают экземпляры. Если обязательные occurrences отсутствуют, freeze-preview возвращает controlled409 MATERIALIZATION_REQUIRED с разрешёнными target IDs/counts и действием materialize, затем пользователь получает новый настоящий preview. Не строить виртуальные random-ID/createdAt snapshots: они дают вечный PREVIEW_STALE при превращении в настоящие строки.

Если ранее валидный manual freeze preview сталкивается с новой recurrence/materialization, pre-handler может commit **только** необходимую materialization и вернуть tagged committed PREVIEW_STALE для refresh; старый preview не создаёт baseline. Нужные cutoff freeze/materialization эффекты не откатываются бесконечным stale-preview loop. Решение typed/scoped to target period принимается до arbitrary handler writes, не catch после частичных user writes. Lazy cutoff performFreeze materialize и snapshot выполняются атомарно; другие protected command families используют тот же путь. Missing/blocked authorization или generation failure не маркируются complete и не дают baseline с потерянными встречами.

Обязательное scope refinement к текущему workspace-wide due loop: `resolveAffectedProjects(intent,repo)` до materialization определяет реальные source projects операции. Task/field/project/period/report mutations замораживают свои affected projects; workspace-tag change включает все projects, чьи source snapshots реально используют tag. Если blocked grant находится только в несвязанном project A, write project B не пытается завершить A и не становится навсегда unwritable. Readiness/worker backlog A остаётся явно blocked, baseline A не заявляется готовым. Broad source mutation, действительно затрагивающая A+B, fail-closed до recovery A; неизвестный footprint не угадывается. Для scope mapping нужен exhaustive typed intent matrix и real-PG A/B regression до GO. Это не разрешение игнорировать blocked series внутри затронутого периода.

Freeze snapshot получает optional/no-default recurrence manifest: series version/policy/binding IDs, candidate census/instance keys/IDs, resolved start/exception versions. Включается calendar census **всех registered candidates выбранного периода, active и paused**, даже если пользователь ещё не применил персональные proposals. Calendar-only lock защищает именно original schedule/roster provenance; он не создаёт личный commitment, plannedMinutes, package budget baseline или новый minute cohort. Отчёт с отсутствующим персональным планом сохраняет missing/unplanned semantics P2a. Skipped/cancelled nominal candidates остаются в census с явным состоянием, не исчезают из неё. Это **не** превращает proposals в commitments и не заявляет известный персональный план; P2a minute cohort остаётся по настоящим commitments. Какие meeting fields блокирует такой calendar-only snapshot, фиксируется отдельно: минимально original schedule/roster с текущим policy, без изобретённых часов.

## 9. Worker, grants, queue и restart

Будущий отдельный apps/worker использует тот же commit/runtime, Node24/Postgres17, серверные packages и loopback/synthetic DB guard локального режима. Никаких HTTP public endpoints, Shared Auth fallback, Railway provisioning или deployment. Предложенные runtime dependencies после отдельного GO: pg-boss и уже принятый Temporal implementation; runtime dependencies не dev-only.

Pg-boss — транспорт **at least once**. Business uniqueness/idempotency durable в domain/DB; job singleton или «exactly once» маркетинговое описание не заменяют unique series/key и immutable attendance sources. Worker startup регистрирует bounded queues; отдельный единственный migration command управляет pg-boss schema lifecycle, а не гонка всех replicas. Закреплённая версия и populated upgrade/rollback compatibility проверяются до запуска.

Queues первого среза: recurrence.materialize и internal outbox relay. Worker horizon28дней только по explicit bindings, job максимум один period/series либо100creates; global concurrency2, per-workspace1, runtime/statement timeout с измерением, bounded retries5/backoff, lease/heartbeat и terminal blocked reason. Это стартовые bounds для local test, не SLA. Cutoff correctness обеспечивает shared sync path; отдельный широкополномочный cutoff sweep/notifications/import queue не добавляется скрыто.

Job payload содержит только workspaceId/seriesId/bindingId/sourceManifestHash/authorizationRevision и request correlation. Actor/capabilities/time не доверяются payload. В bounded варианте worker разрешает actor из persisted explicit generation authorization, затем проверяет его действующее membership/task.edit под barrier; source=job, server requestId. Нет impersonation по organizer, автоматической подстановки owner или безграничного system bypass. При revoke/deactivation job блокируется, не materialize; действующий уполномоченный member/admin может явно переавторизовать серию собой. Sync freeze не пропускает blocked series затронутого периода молча: предлагает explicit reauthorize, без старых прав из snapshot. Pause останавливает только background generation и **не** восстанавливает grant/не удаляет обязательную census; это не обход blocked freeze. Более общий service principal — отдельное Auth/operations решение.

Validator отдельно проверяет persisted authorizer user/membership/task.edit и authorization revision **под тем же barrier**, даже если triggering command вызвал viewer с reports.read или участник с time.write_self. Triggering ctx actor/source не заменяются authorizer и не получают его общих прав. Internal helper получает `ValidatedGenerationAuthority`, построенный сервером в этом tx, плюс исходный scope; это разрешение только на approved occurrences. Audit хранит trigger actor/source и generationAuthorizerUserId/membershipId/authorizationId/revision раздельно. Workers также не принимают actor из payload.

Recovery command generation-authorization — узкое metadata replacement: после проверки current actor task.edit и expected revisions, под тем же barrier оно **может выполниться до prerequisite, требующего отозванный старый grant**. Иначе reauthorize сам deadlock-ится на старой authority. Команда не меняет schedule/binding/attendance/baseline, записывает actor/grant audit и idempotent outcome; следующий ensure валидирует уже новый grant. Нет произвольного catch/commit handler failures, owner impersonation или публичного system bypass.

Outbox relay имеет explicit known recurrence subscription (предложение: recurrence.series_created, recurrence.series_edited, recurrence.period_bound, recurrence.generation_authorized, recurrence.generation_state_changed; exact labels/schema versions утверждаются freeze). Существующие unrelated P0–P3a pending outbox rows не выбираются, не acknowledged и не помечаются dispatched этим worker. Unknown version **подписанного** event fail-closed/dead-letter; неподписанный event не является ошибкой этого consumer. Health oldest-pending/backlog и retry counters считают тот же subscribed набор, не всю историческую outbox. Materialization meeting.created events не подписаны, чтобы не создать relay loop.

Outbox relay: SELECT bounded **subscribed** pending rows FOR UPDATE SKIP LOCKED; enqueue с deterministic event ID и отметка dispatchedAt в **одной** SQL transaction через approved pg-boss Drizzle adapter. Crash до commit откатывает оба; crash после commit не повторяет relay. Handler открывает один workspace UOW и выполняет internal primitive; crash после domain commit до queue acknowledgement безопасен благодаря durable occurrence IDs/source-manifest checks. Не включать pg-boss transactional worker вокруг handler, который затем открывает второй независимый domain transaction. Lease loss/retry не должно дать вторую встречу.

SIGTERM прекращает приём jobs, завершает короткие active transactions либо отдаёт retry lease; лимит graceful shutdown не бесконечен. Health — heartbeat + queue lag + oldest pending outbox + missing occurrences/freeze lag, без фиктивного HTTP200. Логи — IDs/type/result/timing, без названий встреч/URL/tokens/частных payloads. Restore БД — consumers остановлены, watermarks сверены до включения; никакой автоматической внешней доставки.

## 10. Приёмка и переход

1. Пять weekdays одной серии → пять stable meetings/tasks/packages, proposals only, без commitments/attendance; retry одного/двух workers и crash commit→ack не меняют counts/IDs.
2. Natural key остаётся original date после move/DST/version edit; skip consumes count; reset/restore не создают копии, исключение не затирается regeneration.
3. Все DST fixtures секции6: first-valid boundary, earlier overlap,30-minute shift, skipped day, elapsed duration; collision двух nominal keys показан, не merge.
4. Explicit overlapping period selection отклоняет ambiguity; worker order не назначает period. No binding → явная неподготовленность, не автонеделя. Cross-period moves не обходят P3a ограничения.
5. Worker остановлен перед неделей: explicit/sync materialize создаёт полную необходимую census до freeze; readonly preview ничего не пишет; cap требует chunks, частичный baseline невозможен. Никаких nested UOW/reentrant guards/deadlock.
6. Preview→concurrent edit/grant revoke/DSTpolicy change/materialization → контролируемый stale/block без частичных user writes или rollback-loop обязательного cutoff. Old baseline/JSON/inputhash/replay unchanged.
7. Generation не пишет чужие планы/attendance. Revoke actor блокирует job и sync prerequisite его affected period до explicit reauthorization; pause не удаляет census. Отдельный metadata recovery может заменить grant до blocked prerequisite, затем ensure проходит; unrelated project B остаётся writable, global mutation реально затрагивающая A блокируется. Owner не подставляется; trigger и authorizer audit различимы. Foreign workspace/task/binding IDs404; current rights проверяются перед replay.
8. Outbox enqueue+mark atomic; unrelated historical P0–P3a rows остаются untouched и не портят recurrence backlog. Unknown subscribed event schema fail-closed/dead-letter; retry/restart/source edit не меняют fact sums. Pool/barrier wait bounded, SIGTERM recoverable.
9. Browser: preview/create series → выбрать периоды → materialize выбранную неделю → apply только явно выбранные личные планы → attendance/report прежними P3a командами. Failed/uncertain command сохраняет original scope/key/draft при навигации; denied refetch скрывает cache.

Порядок: P3a checkpoint → review/решения по этому draft (особенно explicit period bindings, calendar-only freeze census, grant и cap) → точный DTO/port freeze → одна migration/domain/helper lane → тонкий API и worker/UI → реальные PostgreSQL, crash/retry и browser gates. Этот draft не разрешает install, worker launch, внешние сообщения или production действия.

## Официальные источники для будущей dependency freeze

- [pg-boss repository/requirements](https://github.com/timgit/pg-boss): проверенный кандидат12.38.0, MIT, Node>=22.12/PostgreSQL>=13; совместим с целевыми24/17. [Transaction adapters](https://github.com/timgit/pg-boss/blob/master/docs/api/adapters.md) описывают fromDrizzle(tx,sql) для postgres-js; [scheduling](https://github.com/timgit/pg-boss/blob/master/docs/api/scheduling.md) не заменяет domain catch-up после downtime.
- [temporal-polyfill implementation](https://github.com/fullcalendar/temporal-polyfill/blob/main/polyfill/README.md): проверенный кандидат1.0.6, MIT, ESM/Node24 CI. Использовать выбранный общий implementation и policy, не две несовпадающие библиотеки для preview/worker.
- [Temporal ambiguity](https://tc39.es/proposal-temporal/docs/timezone.html) и [transition boundary](https://tc39.es/proposal-temporal/docs/zoneddatetime.html#zonedDateTime.getTimeZoneTransition) объясняют разницу compatible-gap shift и нужной первой допустимой границы. Перед install фиксируются фактические package versions/license/lock и повторяются целевые runtime tests.
