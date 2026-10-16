# P3b: конечные серии встреч и worker

Статус на 16 октября 2026 года: **принятый ограниченный P3b**. Функциональные проверки, реальная миграция заполненной базы и старые replay/report fixtures, текущие desktop/mobile workflows и локальный compiled worker приняты. Точная хронология широких и последующих targeted проверок, первоначальные сбои и исправления записаны в [журнале](11-implementation-progress.md). Это не означает завершение всего P3, production worker hosting или old-tab upgrade certification.

Основания: [продукт](01-product-spec.md), [архитектура](02-architecture.md), [domain](03-domain-and-data.md), [API](04-api-and-integrations.md), [этапы](06-implementation-plan.md), [планирование](13-p2a-contract.md), [категории](14-p2b-contract.md), [одиночные встречи](15-p3a-contract.md). P4 описан отдельно в [planned-контракте](17-p4-contract.md).

## 0. Зафиксированный срез

1. Конечные daily/weekly серии с выбранными weekdays, local time и IANA zone. Только явно связанные существующие периоды: до 52 периодов и 366 nominal candidates на серию. Нет фонового 28-дневного горизонта или бесконечного календаря.
2. Стабильный reserved header каждой occurrence; настоящий meeting/task/package появляется при materialization. Natural key — workspace + series + **исходная nominal local date**, а не UTC instant, новая дата после move или номер версии.
3. Общий resolver и policy `first_valid_gap_earlier_overlap_v1` для preview, синхронного ensure и worker. Записанный resolved instant и provenance не пересчитываются при обновлении tzdata.
4. Полный calendar census перед freeze; личный и проектный snapshots, самостоятельные календарные locks, включая cancelled header без созданной встречи. Календарь сам не создаёт личные commitments, факты или PackageBaseline.
5. Typed materialization recovery с максимумом 100 **реальных** compositions за transaction, signed cursor и независимым продвижением двух overdue периодов. Cancelled header без locator не считается missing и не расходует create cap.
6. Единственная outbox-подписка — `recurrence.materialization_requested`, schemaVersion 1. Worker continuation и актуальный запрос после stale job записываются в том же UOW. Manual materialize продолжает работу через возвращённый cursor и не обязан создавать дополнительный continuation event.
7. Worker использует stored generation authorization, проверенную под workspace barrier; входной job не содержит actor. Durable receipt не позволяет повторной доставке повторить stale/continuation effects, в том числе после смены authorizer.
8. UI использует существующую карточку P3a для actuals, attendance и reports. Создание серии и materialization предлагают планы, но не записывают их автоматически.

P3b не добавляет calendar invitations, внешнюю доставку, arbitrary RRULE, monthly/yearly rules, cross-period moves, service principal, shared Auth/private ACL, production hosting или old-tab upgrade certification. P4/Gantt и оставшиеся части P2 остаются отдельными этапами.

## 1. Доступ и совместимость

Чтение использует current `task.read`; preview и изменения серии — current `task.edit`. Actor/workspace/source/requestId задаёт доверенный adapter. Все изменения keyed, Origin/Host guards действуют и для POST-preview. Scope по-прежнему workspace-visible; будущие private task ACL здесь не реализованы.

Публичные previews — repeatable-read, read-only: не reservе headers, не создают entity IDs и не вызывают materializer. Hash покрывает relevant immutable versions, bindings, headers/exceptions, текущие meeting/task/roster/package revisions, periods/locks и actor/access/permission epoch. Apply пересчитывает его под barrier. `PREVIEW_STALE` требует нового preview; key и payload не подменяются после uncertain response.

Добавления `MeetingDto.recurrence` и `PlanningSnapshotDto.recurrence` optional и **без defaults**. Старые task/meeting/manual-work command inputs, hashes, cached outcomes и pinned reports не переписываются. Fresh reads дают актуальные locators; отсутствие optional поля в старом stored outcome не доказывает, что задача обычная. Старые браузерные bundles — отдельная проверка P6.

## 2. Модель и постоянные identities

Новые таблицы миграции `0006_recurrence_materialization`:

- `recurrence_series`: mutable head/state, текущая версия и generation grant.
- `recurrence_series_versions`: immutable schedule/template versions и inclusive effective boundary.
- `recurrence_period_bindings`: явная immutable принадлежность series/period, revision и source manifest hash.
- `recurrence_instances`: reserved headers, original key/sequence, calendar state, pinned resolution, exception head и nullable locators.
- `recurrence_exception_versions`: immutable skip/move/restore/reset с reason и actor/source/changeSeq.
- `recurrence_generation_authorizations`: immutable grants с authorizer user/membership и actor provenance.
- `recurrence_calendar_locks`: immutable baseline/instance locks независимо от наличия Meeting.

Scoped composite FKs удерживают workspace/project/period identity. `meeting_id/task_id/work_package_id` все null либо все заполнены; locator attaches once и не заменяется. Header key, nominal sequence и period binding не меняются после skip/move/restore. History/head consistency и append-only guards находятся в SQL; malformed JSON не проходит через SQL UNKNOWN.

`RecurrenceSeriesDto` содержит currentVersion, generation state, `boundPeriodIds`/согласованный boundPeriodCount и nominalCandidateCount. Reload не требует опрашивать каждую неделю, чтобы узнать исходный выбор. `RecurrenceInstanceDto` содержит calendarState, immutable occurrenceKey/nominalSequence, resolution, nullable meeting/task/package IDs, current meetingRevision и exception head.

## 3. Schedule, template и пределы

| Параметр | Контракт |
| --- | --- |
| Даты recurrence | Валидные ISO calendar dates от 2000-01-01 до 2100-12-31 включительно |
| Время | HH:mm; IANA zone, без произвольного numeric zone |
| Частота | daily либо weekly с уникальными ISO weekdays 1–7 |
| Завершение | on_date с inclusive span до 366 дней либо after_count 1–366 |
| after_count scan | Не более 3660 calendar days; превышение — ошибка, не truncation |
| Кандидаты | До 366 на серию, до 52 явно связанных периодов |
| Duration/roster | 1–1440 elapsed minutes; 1–100 уникальных attendee membership IDs |
| Materialization | 1–100 реальных meeting/task/package compositions за UOW |
| Списки | Signed pagination; bounded readiness/materialization bindings до 100 с явным `truncated` |

Template содержит title, statusId, optional sectionId, organizerMembershipId, attendeeMembershipIds и optional HTTP(S) joinUrl. Новые occurrences создаются тем же single-meeting primitive P3a: отдельный Task/WorkPackage, nominal budget = duration × roster count, unknown attendance и предложения личных планов. Budget не является фактом или автоматически распределённым личным планом.

## 4. Явные periods и source manifest

Series привязана только к явно выбранным periods того же проекта. Periods могут перекрываться; если candidate разрешается одновременно в нескольких выбранных periods, команда отклоняется целиком. Нет «выбрать первый». Назначенный original key никогда не перебиндивается, даже после cancel; конфликт — `REVISION_CONFLICT`409. Move должен остаться в исходном периоде по resolved instant в timezone этого периода.

Не связанные candidates остаются видимыми как «Период не выбран», не получают скрытых task IDs и не обещают будущую автоматическую генерацию. Add-periods проходит отдельный preview/apply; суммарный boundPeriodIds остаётся не более 52.

`sourceManifestHash` включает generation **inputs**: immutable version IDs/revisions/effective boundaries, semantic exception heads, series/binding/period ownership, immutable local period bounds и authorization revision. Он исключает generated entity/header IDs, materialization progress, attach revisions, changed timestamps и period revision, изменённую freeze. Поэтому собственный успешный chunk не инвалидирует следующий cursor. Полный previewHash отдельно включает output state и access sources.

## 5. Публичные exports и HTTP — 15 операций

Schemas/types находятся в `packages/contracts/src/recurrence.ts` и standalone `common/recurrence.ts`; domain port — `RecurrenceApplication`. Все методы ctx-first Promise. Реальная factory — `@workloom/db.createRecurrenceApplication(source, {cursorSecret?, ...WorkspaceWriteOptions})`, без второго pool.

Все пути ниже под `/api/v1/workspaces/:workspaceId`; `{S}` означает `/recurrence-series/:seriesId`, `{I}` — `{S}/instances/:occurrenceKey`. Occurrence key проходит `recurrenceCalendarDateSchema`, а не UUID parser.

| Метод/путь | Domain method → результат |
| --- | --- |
| GET `/projects/:projectId/recurrence-series` | listSeries → page SeriesDto |
| POST `/projects/:projectId/recurrence-preview` | previewCreate → CreatePreviewDto |
| POST `/projects/:projectId/recurrence-series` | createSeries → SeriesDto, 201 |
| GET `{S}` | getSeries → SeriesDto |
| POST `{S}/edit-preview` | previewEdit → EditPreviewDto |
| POST `{S}/edit` | editSeries → SeriesDto |
| PATCH `{S}/state` | setState → SeriesDto |
| POST `{S}/period-preview` | previewPeriods → PeriodPreviewDto |
| POST `{S}/periods` | addPeriods → `{series,bindings}` |
| POST `{S}/generation-authorization` | authorizeGeneration → SeriesDto |
| GET `{S}/instances` | listInstances → page InstanceDto; periodId обязателен |
| POST `{I}/exception-preview` | previewException → ExceptionPreviewDto |
| POST `{I}/exception` | setException → InstanceDto |
| POST `/periods/:periodId/materialize-meetings` | materializePeriod → MaterializationResultDto |
| GET `/periods/:periodId/recurrence-readiness` | getReadiness → ReadinessDto |

Остальные успехи — 200 с общим envelope/meta.requestId/meta.nextCursor. Create/edit/template-bearing previews имеют scoped body cap 64 KiB; legacy global cap не расширяется. Wire includeCancelled допускает точные true/false, не truthiness строки `'false'`.

Inputs/export names: recurrenceCreatePreviewInputSchema/createRecurrenceSeriesInputSchema; recurrenceEditPreviewInputSchema/editRecurrenceSeriesInputSchema; setRecurrenceSeriesStateInputSchema; recurrencePeriodPreviewInputSchema/addRecurrencePeriodsInputSchema; authorizeRecurrenceGenerationInputSchema; recurrenceExceptionPreviewInputSchema/setRecurrenceExceptionInputSchema; materializePeriodInputSchema. DTOs/response schemas именованы по соответствующим create/edit/period/exception preview и result, не по прежнему draft-каталогу.

Materialization result содержит periodId/status, global createdCount/remainingCount, nextCursor, bounded bindings, **required truncated**, frozenBaselineIds. Readiness содержит periodRevision/state, global missingCount/blockedCount, bounded bindings и truncated. `truncated=true` означает subset списка bindings; totals не суммируются из показанной части. UI восстанавливается через readiness, а не произвольные error details.

## 6. Единая политика DST

Domain resolver использует pinned `temporal-polyfill`1.0.6 и calendar-date arithmetic; не прибавляет UTC 24 часа для получения следующей nominal date. Resolution сохраняет intended local date/time, resolved start/end/local date/time/offset, policy version, warning и implementation/tzdata/ICU provenance. DB composition передаёт реальные Node tz/ICU versions. Непредставимые second-level offsets/transitions отклоняются, не округляются.

`first_valid_gap_earlier_overlap_v1`: обычное время разрешается точно; overlap выбирает ранний instant; gap выбирает первую допустимую **границу**, а не compatible-сдвиг с сохранением минут; полностью пропущенная дата переходит на первую допустимую границу следующей даты. End = start + elapsed duration. Два nominal keys с одним resolved instant остаются разными occurrences; preview показывает collision.

| Zone / intended local | Resolution |
| --- | --- |
| Asia/Nicosia 2026-03-29 03:30 | 04:00 +03:00, gap_first_valid |
| Asia/Nicosia 2026-10-25 03:30 | 03:30 +03:00, ambiguous_earlier |
| America/New_York 2026-03-08 02:30 | 03:00 -04:00, gap_first_valid |
| America/New_York 2026-11-01 01:30 | 01:30 -04:00, ambiguous_earlier |
| Australia/Lord_Howe 2026-10-04 02:15 | 02:30 +11:00, gap_first_valid |
| Australia/Lord_Howe 2026-04-05 01:45 | 01:45 +11:00, ambiguous_earlier |
| Pacific/Apia 2011-12-30 09:00 | 2011-12-31 00:00 +14:00, skipped_local_date; key остаётся 2011-12-30 |
| UTC 2026-03-29 03:30 | Без сдвига, +00:00 |

Это executable reference vectors кандидата, а не замена итоговой приёмки. Фактические pure/HTTP проверки и версии runtime указываются в журнале.

## 7. Версии, exceptions и direct-edit boundary

«Эта и будущие» добавляет immutable SeriesVersion. Для каждой nominal date выигрывает **наибольшая numeric revision** среди версий с effectiveFrom <= date. Повторные edits с одной boundary разрешены. Более поздняя запись с ранней boundary также заменяет запланированные будущие segments старых versions; старая версия не «возвращается» позже. Все immutable версии остаются в истории/manifest.

Start date и end kind immutable. У after_count также immutable исходные cadence/weekdays/count: skips расходуют позиции, новые даты не дописываются после N. On_date future edits ограничены общим cap. Новые либо уже существующие occurrences нельзя редактированием перенести в прошлое; completed/ever-posted/frozen/cross-period targets защищены. Preview показывает фактически затронутые protected IDs, apply отклоняет весь edit с `DOMAIN_VALIDATION_FAILED`422. Это не скрытый частичный update.

Exceptions skip/move/restore/reset имеют независимую immutable историю, reason и expected series/instance revisions. Original key, nominal sequence, период и реальные entity IDs сохраняются. Fresh ExceptionPreviewDto дополнительно содержит required nonnull beforePlannedCalendar/afterPlannedCalendar: timezone, plannedDurationMinutes, organizerMembershipId и attendeeMembershipIds. Reset/restore наследуют effective planned calendar/roster, skip/move сохраняют исходный planned context; оба контекста входят в preview hash. Calendar-only sync не переписывает обычные title/status/section/join/materials, actuals и историю. Manual skip/move не стирается regeneration. Cancelled manual-skip header с неизменными resolution/sourceVersion — retain при template-only edit; он не обязан попасть в protectedTargets такого edit. Его restore/reset/реальное изменение всё равно проверяет calendar lock по instance identity, даже при null locators.

Direct P3a `meeting.update` для recurrence-owned meeting отклоняет значимые planned time/timezone/duration/organizer/roster/state изменения422: используются series/exception commands. Same effective planned inputs допустимы как no-op и проверяют revisions. Actual start/duration, join/recording/summary links и attendance остаются доступны по правилам P3a; старые manual-work endpoints не становятся attendance bypass.

## 8. Census, previews, materialization и freeze

Every real task/field/planning/category/meeting/recurrence composition несёт обязательный same-TX census. Exhaustive source-footprint guard ограничивает affected projects: revoked grant проекта A не делает несвязанный B недоступным. Broad workspace mutations честно затрагивают все свои проекты.

Readonly freeze preview требует complete census, включает её в полный source hash и ничего не reservе/materialize. Missing/blocked census → `MATERIALIZATION_REQUIRED`409; UI показывает readiness и предлагает подготовить выбранный период. Нормальная mutation может выполнить bounded lazy-cutoff prerequisite: до её proposed writes создать до 100 отсутствующих occurrences и complete freeze атомарно. Если после этого census incomplete/blocked, **весь** UOW откатывается; user write и partial baseline не фиксируются. Это и означает fail closed.

Typed materializePeriod recovery обходит все full due-freeze loops, проверяет current actor/stored authorities и создаёт только approved census целевого периода. MaxCreates считает реальные compositions; reserved/cancelled header-only rows не расходуют cap. Signed cursor связан с actor/workspace/permission epoch/period/input manifest; source change требует restart, собственный progress hash не меняет. Manual pending chunk продолжается следующим keyed вызовом с cursor; дополнительный outbox continuation ему не обязателен.

Финальный complete chunk overdue периода в том же UOW замораживает **только этот** target period. Два периода по >100 продвигаются независимо без A-requires-B/B-requires-A loop. Уже complete период может быть lazy-cutoff prerequisite обычной команды; неизменность другого unfinished периода после explicit final chunk проверяется отдельно от такого обычного write.

Project freeze включает весь зарегистрированный active/paused calendar census. Self freeze требует той же глобальной completeness, но snapshot/locks включают только entries данного membership по фактическому roster материализованной встречи; для header без locator используется roster его source version. Чужой календарь личный freeze не блокирует. Project merge сохраняет earliest personal original по numeric changeSeq и все sourcePersonalBaselineIds. Optional recurrence section отсутствует у периода без релевантного calendar census; old snapshots не backfill-ятся текущими данными.

Calendar-only snapshot не добавляет commitments/minutes/PackageBaseline. Cancelled никогда не materialized header остаётся оригинальным census и lock-ится по instance ID. Новые после freeze packages/occurrences не переписывают old census: их факты относятся к added scope независимо от наличия нового личного commitment. Existing detail/package lineage и отчётные denominators P2a/P2b сохраняются.

Internal `createSingleMeetingInScope` работает на уже открытом scope, без public createMeeting/нового runner/guard. Recurrence composer требует reserved occurrence identity и validated generation authority; same-TX attach связывает header с реальными entity IDs. Необязательная identity допускается только на обычном single-create helper path.

## 9. Stored grants, outbox, очередь и worker

Generation grant хранит explicit authorizer user/membership/revision. Под barrier проверяются его current active membership и task.edit. Triggering ctx actor/source не заменяется authorizer; audit записывает обе provenance. Нет organizer/owner fallback или общего system bypass. Отозванный grant возвращает controlled blocked; явный authorizeGeneration с expected revisions — узкое metadata recovery до prerequisite старого grant, без смены schedule/binding/fact/baseline.

Paused означает «Приостановить фоновую подготовку»: worker возвращает paused без hot retry; sync census и freeze по-прежнему учитывают серию. Resume создаёт новый запрос по affected binding. Нет скрытого удаления исходных candidates через pause.

Подписка ровно на `recurrence.materialization_requested` v1; create/edit/addPeriods/authorize/resume записывают один запрос на affected binding. Relay выбирает bounded valid v1 rows с FOR UPDATE SKIP LOCKED; enqueue callback получает тот же Drizzle transaction, и только эти rows помечаются dispatched. Ошибка откатывает enqueue и receipt. Malformed/unsupported subscribed rows удерживаются и видны как blocked health, не лишают valid v1 продвижения; unrelated historical outbox не выбирается и не считается этим consumer.

`createRecurrenceWorkerFacade(...).materializeBinding(job)` принимает workspaceId/seriesId/bindingId/sourceManifestHash/authorizationRevision/requestId без actor. Worker pending chunk записывает continuation в том же UOW до acknowledgement; stale job аналогично durably запрашивает текущий source. Normal progress не расходует failure retry budget.

Durable receipt использует внутренний namespace `recurrence.job.materialize` существующей command cache. Request ID digest ищется по workspace/namespace **через authorizers** под workspace barrier. Payload hash проверяет все source targets/manifest/grant revision; changed payload409. Current persisted grant проверяется **до replay**. Exact delivery replay возвращает сохранённый original outcome, включая original createdCount: это не число повторно созданных rows. Ack-loss не создаёт новый stale/continuation outbox event; unexpected handler failures откатывают source/receipt/events целиком.

Pinned dependencies: pg-boss12.38.0, обязательный peer @opentelemetry/api1.9.0 без SDK, temporal-polyfill1.0.6. Только `npm run db:queue:migrate` устанавливает/обновляет `workloom_queue` schema46 официальными plans и проверяет схему/настройки. Сначала регистрируется `workloom.recurrence.dead_letter.v1`, затем `workloom.recurrence.materialize.v1` с deadLetter link. Runtime worker не create/update/migrate очереди и fail-closed при отсутствии/drift.

Materialization queue: standard/nonpartitioned, retryLimit5, retryDelay5s, exponential backoff с max300s, expire300s, retention/deleteAfter7days. DLQ: standard/nonpartitioned, retryLimit0, expire300s, retention/deleteAfter7days; терминальные jobs наблюдаемы. Concurrency максимум2 **на процесс**; DB barrier сериализует workspace между replicas, не обещает global2.

Health/initial grant resolution имеют finite SQL lock/statement budgets. Health/logs различают unavailable и zero, operational queue/delivery counts и accounting totals, отражают subscribed lag/unsupported rows/DLQ. SIGTERM прекращает intake/timers, завершает bounded in-flight work и закрывает owned pools. Нет production crash flag, automatic DLQ replay или repair UI. Операционные команды и тестовый ack boundary описаны в [worker README](../apps/worker/README.md).

## 10. Приёмка и переход

Gate включает pure DST/calendar/version tests; real HTTP/PG identities, protected edits, readonly preview, independent >100 overdue recovery, actual source grants и SQL append-only/FK checks; atomic relay/queue crash/retry/receipts; upgrade populated P3a с exact old raw inputs/hashes/cached outcomes/pinned JSON; current browser/keyboard/mobile/uncertain-command и visual review. Skipped/blocked проверка не является pass; итоговая хронология — только в журнале.

Application migration0006 добавляет семь таблиц к40; queue schema развивается отдельно и не подменяет application migration. Применённые0000–0005 и journal prefix сохраняются. Реальная проверка fresh install/repeat/drift queue не объявляется проверкой upgrade от старой установленной версии pg-boss, если такого fixture не было.

Принятый gate включает широкие 919 core/API/worker unit tests, 206 web tests и 147 real HTTP/PG tests; отдельное сохранение всех 40 старых таблиц при `0006` и exact replay семи старых команд/отчётов. Browser initial 17/18 и последующие исправленные targeted 2/2 отражаются раздельно в журнале; root принял текущие desktop/mobile visuals. Отдельный compiled worker smoke создал три встречи без автоматических планов/фактов, подтвердил health и SIGTERM exit 0. Итоговая проверка served assets и local source checkpoint оформляются coordinator отдельно. Полный P3/MVP, Auth, hosting и old-tab coverage из этого не следуют. До отдельного GO следующий P4 остаётся planned.

## 11. Первичные технические источники

- [pg-boss repository](https://github.com/timgit/pg-boss), [Drizzle transaction adapters](https://github.com/timgit/pg-boss/blob/master/docs/api/adapters.md): используемые schema plans и same-TX enqueue; runtime version закреплена lockfile.
- [temporal-polyfill](https://github.com/fullcalendar/temporal-polyfill/blob/main/polyfill/README.md), [Temporal ambiguity](https://tc39.es/proposal-temporal/docs/timezone.html), [transition boundaries](https://tc39.es/proposal-temporal/docs/zoneddatetime.html#zonedDateTime.getTimeZoneTransition): distinction между compatible gap shift и выбранной first-valid boundary policy.
