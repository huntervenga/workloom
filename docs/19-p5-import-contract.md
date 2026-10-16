# P5a: ограниченный импорт файла Asana — planned draft

Статус: **предложение, 16 октября 2026 года; implementation catalog approved; source GO ожидает checkpoint P4b, нет разрешения на импорт реальных пользовательских данных**. P4b имеет приоритет до acceptance. Автор: Codex gpt-6.1-sol high, по текущему выбору пользователя; Claude не вызывался. Источники требований: [implementation P5.4/P5.6](06-implementation-plan.md), [domain](03-domain-and-data.md), [task/date contracts](18-p4b-contract.md), [custom fields](14-p2b-contract.md), [baseline integrity](13-p2a-contract.md).

## 1. Проверенная внешняя граница

Проверено по официальным первичным страницам 16 октября 2026 года:

- Asana поддерживает project export в CSV и JSON. Это file workflow; Workloom не получает токен/Asana account и не скачивает URL. [Project import/export](https://help.asana.com/s/article/project-importing-and-exporting?language=en_US).
- JSON export открывается защищённой правами ссылкой; CSV скачивается, а большой export может готовиться асинхронно. Здесь пользователь позднее сохраняет файл сам и выбирает локальный файл. Нет автоматического обхода Asana ACL. [Export project data](https://help.asana.com/s/article/privacy-and-security?language=en_US).
- Текущая официальная project-export справка **не фиксирует полный CSV header contract и численный предел строк project CSV**. Нельзя объявить известный лимит Asana или считать отсутствие строки доказательством удаления. Историческая официальная статья перечисляет Task ID, Creation Date, Completion Date, Last Modified Date, Name, Assignee, Due Date, Tags, Notes, Project Name, Parent Task, но это статья 2014 года, а не обещание текущего export. Настоящие headers инспектируются на staging. [Историческое описание CSV](https://asana.com/inside-asana/export-to-csv).
- Современная справка CSV importer описывает Name/Description/Section/Assignee/Collaborators/Start Date/Due Date/Type/Dependents/Parent Task, но это **импорт В Asana**, не доказательство точного export format. Workloom может предложить эти названия как mappings, не объявлять файл валидным только по ним. [Preparing data for CSV import](https://help.asana.com/s/article/preparing-data-for-csv-import?language=en_US).
- Asana API определяет task gid как **string**, отдельно различает due_on/start_on и timestamps due_at/start_at; task содержит references к parent, memberships/section, tags и custom fields. API schema полезна как источник известных JSON keys, однако project JSON export не объявляется байтово идентичным API response. [Get task](https://developers.asana.com/reference/gettask).
- Enum field и каждая option имеют разные stable gids; disabled option может остаться в прежнем value. Не сопоставлять option только по label. [Custom fields guide](https://developers.asana.com/docs/custom-fields-guide).

Поле/record, отсутствующее в файле, не равно null, false, completed, zero или deleted. JSON compact resource с одним gid не равен полной задаче. Реальный user export ещё не предоставлен; совместимость с ним будет отдельным gate, не результатом synthetic fixtures.

## 2. Рекомендуемый первый срез на 60 минут

Полезный вертикальный результат: владелец 5–7 человек загружает **один проект, до 50 обычных задач**, видит исходные столбцы и полный reconciliation, явно связывает существующих людей/sections/tags/custom fields, подтверждает один атомарный create-only импорт и открывает получившиеся задачи. Повтор того же source не создаёт дубликатов. Этот объём — **лимит Workloom данного среза**, не лимит Asana.

Включить:

1. Только UTF-8 CSV с BOM/quoted commas/newlines; JSON adapter отложен, несмотря на исследование его формата; max **1 MiB decoded UTF-8**, 50 уникальных task IDs, 100 столбцов, 20 000 символов на cell, max parent depth 20. Превышение — явный отказ целому файлу, не первые N строк.
2. Persisted staging без task writes: file digest, format, original headers, normalized records, warnings и revision. Табличный preview исходных/целевых значений; raw extras сохраняются в staging и доступны в reconciliation.
3. Explicit mapping на существующий path project, current active memberships, current project statuses/sections, workspace tags и project custom fields/options. Без автоматического создания людей/ролей/приглашений.
4. Core task fields: title, plain description, date-only start/due, explicit status map, responsible person/participants только по подтверждённому смыслу mapping, parent hierarchy. Без meeting/recurrence inference по title/link.
5. Рекомендуемое applied подмножество на 60 минут: existing text/number/duration/date/boolean при однозначном mapping; URL/single-select/multi-select/person оставить preserve-only до отдельного verified adapter gate. Никакой автоматической смены типа definition; unsupported/formula/reference/rich-text значения — blocking issue либо explicit preserve-only acknowledgment. Не объявлять полный nine-type custom-field import по наличию shared schemas. Если безопасная extraction и все пять adapters не укладываются, stage/preview checkpoint честнее неподтверждённого apply.
6. Create-only + exact unchanged skip. Изменившийся ранее импортированный source или вручную изменённый target даёт explicit conflict. Update/merge/delete существующих targets — следующий срез, без скрытого overwrite.

На 60 минут **не включать** создание/миграцию definitions/options, Asana live sync/OAuth, attachments/comments/stories downloads, CSV XLSX conversion, multi-project task identity, permissions/private ACL migration, meetings/recurrence, imported time facts/plans/baselines, actual history reconstruction, arbitrary dependency import или массовое исправление существующих задач. Dependencies/links сохраняются как unsupported relationship issues с исходными IDs и counts, не исчезают. Если такие edges необходимы выбранной работе, связанные задачи исключаются из ограниченного пилота до реализации edge import, как требует P5.4/P6; один preserve-only acknowledgment не превращает потерянную зависимость в перенесённую.

## 3. Идентичность и повторные файлы

Требуется stable source namespace (например пользовательский набор Asana workspace/project IDs) и **source task ID как исходная строка**, без JavaScript number conversion. CSV mapping должен явно выбрать ID column; отсутствие ID не заменяется row number/title/hash title. Preview доступен, apply заблокирован, пока identity не определена. Названия одинаковых задач не создают identity conflict.

Mapping identity: unique `(workspaceId,sourceNamespace,entityKind,externalId)` → stable Workloom ID + target project + last imported canonical source digest + imported owned-field revision vector/fingerprint. Namespace нельзя незаметно менять при retry. Все foreign IDs остаются отдельными external strings; никогда не подставлять их прямо в Workloom UUID columns.

- Тот же ID и тот же normalized source digest → skip existing после current target ACL. Тот же uploaded byte digest не обязателен: reordered rows/headers не создают duplicates.
- Owned-field vector включает task revision для core/tags/parent, participantsRevision при mapped participants, WorkPackage revision и отдельно value revision для каждого mapped custom field (а не только task.revision). Mapping связывает definition/option IDs и их текущие revisions для review. Непереносимые/непринадлежащие importer поля не становятся скрытой write ownership.
- Тот же ID с новым source digest или локально изменённым target по owned-field vector → conflict; не перезаписывать target и не создавать вторую задачу.
- Несколько строк с одним ID и различными значениями → blocking duplicate. Идентичные дубли видны как duplicates; пользователь подтверждает dedup, preview counts сохраняют original rows.
- Отсутствующий ID в новом файле не удаляет/не архивирует target. Это неполный export, не authoritative deletion manifest.
- Отсутствующая parent reference — unresolved issue. Parent name не разрешается эвристикой при дубликатах; required explicit external parent ID mapping или explicit root conversion acknowledgment. Cycles и cross-project parents reject under barrier.

Asana subtask не доказывает shared WorkPackage. Первый срез создаёт каждому imported task отдельный package с estimate **null**; parent relation не превращает отдельные бюджеты в shared detail. Предложенный mapping — explicit `added_scope` для imported children. Если пользователь позже хочет detail/shared package, это отдельное осмысленное изменение, не догадка importer.

## 4. Null, units, люди и данные без аналога

| Источник | Правило первого среза |
| --- | --- |
| date-only | Explicit format mapping ISO или MM/DD/YYYY; неоднозначные locale dates не угадывать. final start<=due, years0001..9999; timestamps не обрезать до даты без явной timezone/conversion decision |
| assignee/user gid/email | Manual map к current active membership ID; display name не identity; unmapped assignee blocking или explicit unassigned decision |
| collaborators/followers | Не автоматически assignees. Preserve-only либо отдельный подтверждённый participant mapping |
| section/tag labels | Existing IDs выбираются явно; одинаковые labels требуют resolution; отсутствующее значение не очищает target при повторе |
| enum/multi-enum | External field/option IDs → stable existing IDs; CSV label-only ambiguities blocking; delimiter выбирается явно, обычная запятая в label не магически splitter |
| disabled option | Retain provenance in staging; не вновь назначать archived Workloom option в обход обычного field policy |
| estimate/current custom estimate | Не original baseline. По умолчанию WorkPackage estimate null. Число можно сохранить как выбранное current custom value с явной unit, а не историческую первоначальную оценку |
| actual_time_minutes / completion timestamps | Preserve-only source metadata, не WorkLog/weekly fact/accuracy. Нет source period/worker/revision provenance для корректного факта |
| dependencies / URLs / html_notes / attachment refs | Original data + unresolved relationship counts в reconciliation; no fetch/eval/HTML injection. Plain notes mapped отдельно |
| unknown keys/columns | Полный список с count/nonempty examples, explicit preserve-only acknowledgment или mapping; не молчаливое drop |

URL fields проходят существующую политику соответствующего типа; source URLs никогда не инициируют запрос сервером. CSV text/formula остаётся literal text; file preview использует обычный escaped render. Если в будущем появляется downloadable reconciliation CSV, его отдельный serializer должен учитывать spreadsheet formula execution.

Current Workloom task visibility — workspace-only. Source private=true blocks applied import до отдельного private-ACL gate. Отсутствующий privacy flag в CSV/JSON — unknown, не public: staging показывает его, apply требует явно утверждённый пользователем manifest выбранного shareable pilot scope; без такого решения остаётся preview-only. Никаких автоматических public tasks из неизвестной/private source visibility. Raw staging доступен только выбранной import capability и не включается в репозиторий/внешнюю телеметрию.

## 5. Предложенный пятиоперационный каталог, ещё не frozen exports

Все пути под `/api/v1/workspaces/:workspaceId/projects/:projectId`:

| Путь | Смысл |
| --- | --- |
| POST `/imports` | keyed staging file, raw UTF-8 content+declared format+source namespace; **не task write** |
| GET `/imports/:importId` | current authorized staged source, mapping revision, parse issues and counts |
| POST `/imports/:importId/preview` | keyless read-only normalized mapping+expectedImportRevision → full source-fresh previewHash/reconciliation |
| POST `/imports/:importId/apply` | keyed mapping+expectedImportRevision+previewHash; one atomic bounded create/skip command |
| GET `/imports/:importId/reconciliation` | full bounded source→target IDs, created/skipped/conflicted/unsupported decisions, commit provenance |

Названия DTO/application будут frozen только при GO. Предполагаемая одна `ProjectImportApplication` с пятью ctx-first methods и @db factory на текущем pool. Предложенная отдельная owner/admin capability `imports.manage`; stage/read содержит исходный экспорт и не должен случайно открывать его любому viewer. Final ACL choice — координатор при freeze, не broad permission UI.

Для persisted staging нужен новый typed guard intent, допускающий только inert file metadata без изменения tasks/plans/census. Apply имеет полный affected project footprint и обычные mandatory cutoff/field/status/tenant rules. Row count/cell limits и scoped request body cap проверяются до полного parse; разбивка одного файла на неявные частично применённые chunks запрещена.

## 6. Одна transaction, общие primitives

Не вызывать public TaskApplication/FieldApplication по строкам с nested writer.run. Извлечь минимальные **in-scope** create/field-value primitives из текущих domain commands; публичные команды продолжают использовать их. Import сначала под barrier current ACL и exact receipt replay, затем валидирует mapping/source hash/target revisions, complete parent DAG, tags/sections/statuses, all custom values и unsupported acknowledgments. Только после полной preflight — необходимые task/package/participant/field writes + external mapping + reconciliation + audit/outbox в одной transaction.

Unexpected late trigger/outbox failure откатывает весь bounded import и mapping, повтор с тем же key создаёт ровно один набор. Existing due-freeze controlled outcome сохраняется только по current pre-handler protocol ДО proposed import writes. Ни stage, ни preview не материализуют calendar и не фиксируют baseline. Первый импорт никогда не создаёт PackageBaseline/первоначальную оценку, commitments или worklogs.

Preview manifest: staged file digest/revision, normalized mapping/decisions, source namespace+external IDs, current target project/access epoch, chosen membership/field/option/section/tag/status revisions, existing external mappings/target revisions, relevant cutoff/census/locks. Изменение справочников после preview требует review, а не silently choose another matching name. Current ACL rechecked before replay; historical exact outcomes не переписываются.

## 7. Минимальные gates и стоп-условия

1. Synthetic multiline/BOM/quoted UTF-8 CSV и string external IDs >2^53/с leading zeros; unknown column preserved; malformed/oversized input rejected without task writes.
2. Source50 bound /51 explicit refusal, duplicate IDs, ambiguous parent labels, parent cycle, unmapped person/option, invalid date/unit: full reconciliation, no partial applied rows.
3. Реальный импорт parent+children+section+tags+typed existing values, stable IDs; repeat reordered source/file=new key yields no duplicate task/package/value/history; changed existing source conflicts.
4. Failure after final row rolls back all tasks/packages/mapping/audit/outbox; same-key retry creates exactly one result. Current capability/revocation/foreign refs and field locks hold through shared primitives.
5. No imported estimate becomes original baseline; no source actual totals become invented personal weekly facts. All unsupported links/raw source counts reconcile.
6. Desktop/mobile file→mapping→preview→explicit apply→task list, lost response exact retry without duplicate; source data not sent to external services.
7. Applied existing migrations/old-column digests/cached commands/pinned reports preserved. Реальный пользовательский export later проверяется отдельно с явным учетом его фактических headers/JSON shape; synthetic test не объявляется реальным migration.

**Time-box decision:** через10 минут после GO должны быть compiled exports+mapping rules; через35 — один реальный HTTP/PG import/repeat/rollback gate; через50 — UI gate и compatibility; последние10 — фиксация или честный останов на verified staging/preview checkpoint. Если нет безопасного общего in-scope primitive к25-й минуте, ограничить срез stage/preview/reconciliation и прямо не заявлять applied import. Никакого «почти импортировано» с задачами вне atomic gate.

Read-only feasibility review backend lane: TaskApplication.createTask и TaskFieldApplication.setTaskValue пока closures; extraction общего in-scope primitive обязательна, без production fake UOW/nested public commands. Applied plan на60 минут имеет риск; после25-й минуты без verified primitive — только stage/preview/reconciliation checkpoint. Imported current HoursEst/HoursFact при явной unit могут сохраняться как existing custom values с подписью «текущий снимок Asana, не original estimate / не weekly fact»; WorkPackage estimate остаётся null, WorkLogs не создаются.

## 8. Exact planned public freeze для быстрого GO

Этот exact каталог implementation-approved координатором; shared exports появятся ТОЛЬКО после source GO после checkpoint P4b. CSV-only, без JSON adapter. Пять операций/путь/статусы:

| Метод | Domain ProjectImportApplication | Result schema/status |
| --- | --- | --- |
| POST `/imports` | `stageCsv(ctx,projectId,StageCsvImportInput)` | `projectImportResponseSchema`,201 |
| GET `/imports/:importId` | `getImport(ctx,projectId,importId)` | `projectImportResponseSchema`,200 |
| POST `/imports/:importId/preview` | `previewImport(ctx,projectId,importId,PreviewProjectImportInput)` | `projectImportPreviewResponseSchema`,200,keyless Origin-checked |
| POST `/imports/:importId/apply` | `applyImport(ctx,projectId,importId,ApplyProjectImportInput)` | `projectImportAppliedResponseSchema`,200,keyed |
| GET `/imports/:importId/reconciliation` | `getReconciliation(ctx,projectId,importId)` | `projectImportReconciliationResponseSchema`,200 |

Все paths относительно `/api/v1/workspaces/:workspaceId/projects/:projectId`; первые две mutable operations stage/apply требуют Idempotency-Key, GET/preview не пишут. Factory `@workloom/db.createProjectImportApplication(source,options?:WorkspaceWriteOptions)`. Public port ровно пять ctx-first Promise methods.

### Input schemas и limits

`stageCsvImportInputSchema / StageCsvImportInput = {fileName:string(1..255),sourceNamespace:string(1..160),csvText:string}`. Scope namespace выбирается явно и сохраняется; trim source external IDs не превращает leading zeros в число. Parser не использует dynamic typing. Сервер ДО JSONB persistence отвергает NUL и ill-formed UTF16/unpaired surrogates во всех raw strings и считает фактическую UTF8 byte length≤1048576 (не string.length). Browser использует TextDecoder UTF8 с `{fatal:true,ignoreBOM:true}` (иначе default decoder удалит BOM до digest); не заменяет ошибочные bytes символом replacement. Accepted raw text digest включает BOM/CRLF и сохраняется losslessly, а parser может отдельно снять один initial BOM для header recognition. No URL fetch.

Stage-only request body cap **8MiB**; остальные старые caps не меняются. Preview/apply **256KiB**, root-approved 16 October. Mapping bound ниже действует также в shared schemas/domain; transport доказывает worst fully escaped legal JSON, а не только простой ASCII fixture.

`projectImportMappingSchema / ProjectImportMapping` (strict; optional keys не inject defaults):

- required `externalIdColumn`, `titleColumn`, `defaultStatusId`, `dateFormat:'iso'|'us'`, `shareableScopeConfirmed:boolean`, `people`, `statuses`, `sections`, `tags`, `customFields`, `preserveColumns`;
- optional column indices `descriptionColumn`, `startDateColumn`, `dueDateColumn`, `parentExternalIdColumn`, `responsibleColumn`, `participantsColumn`, `statusColumn`, `sectionColumn`, `tagsColumn`, `privateColumn`;
- indices zero-based0..99, refer to original staged header positions; duplicate header labels remain distinct;
- `people:[{sourceValue,membershipId}]`, `statuses:[{sourceValue,statusId}]`, `sections:[{sourceValue,sectionId}]`, `tags:[{sourceValue,tagId}]`: aggregate≤100 entries, each sourceValue1..254, unique within each namespace; IDs existingUUID;
- explicit `participantsDelimiter` / `tagsDelimiter` when a multi-value column is selected: `';'|'|'|','`; no implicit split by comma in a quoted label;
- optional `assigneeIsParticipant:boolean`: only explicit true adds responsible person to participant set; collaborators are not silently reassigned;
- `customFields`≤20 unique mapped field IDs/column indices: `{column,fieldId,expectedDefinitionRevision,empty:'missing'|'null',sourceMeaning:'ordinary'|'current_estimate'|'current_actual',sourceUnit?:'minutes'|'hours'}`;
- actual current field type must be one of text/number/duration/date/boolean. Duration requires explicit units; minutes integral, hours×60 integral, no rounding. Date uses chosen format; boolean strict case-insensitive true/false or1/0; numeric lexical form strict decimal finite (no locale guessing). Text keeps literal value. Source-current meaning records provenance in import manifest; it creates no WorkLog or original package baseline;
- `preserveColumns:number[]`≤100 unique indices: explicit nonempty unsupported-column acknowledgment; mapped and preserved sets do not overlap. Required relationship columns remain blocking unless the chosen pilot scope excludes dependent tasks before upload; preserve-only is not dependency import.

`previewProjectImportInputSchema / PreviewProjectImportInput = {expectedImportRevision,mapping}`.

`applyProjectImportInputSchema / ApplyProjectImportInput = {expectedImportRevision,mapping,previewHash}`. Hash64hex; normalized mapping arrays sorted by stable source string/field ID/column, including caller decisions. Stage revision checked after exact receipt replay; repeating successful apply from revision1 replays even though stage nowrevision2.

### Output DTOs

`projectImportSchema / ProjectImportDto = {id,workspaceId,projectId,sourceNamespace,fileName,fileDigest,revision,status:'staged'|'applied',headers:string[],sourceRows:[{rowNumber,cells:string[]}],createdAt,appliedAt:null|UTC}`. Row number starts1 for first DATA record, not physical CSV line; multiline cells remain one record. Source rows≤50, headers≤100, cell≤20000; exact original CSV remains controlled staged artifact, not repository/log output. Duplicate header names are preserved. Structural CSV malformed/over-limit returns400 with no stage/task writes.

`projectImportIssueSchema / ProjectImportIssueDto = {severity:'blocking'|'warning',code,rowNumber:number|null,column:number|null,message}`. Closed codes planned: `missing_external_id|duplicate_external_id|missing_title|unmapped_person|unmapped_status|unmapped_section|unmapped_tag|unmapped_column|invalid_date|invalid_value|invalid_field|parent_missing|parent_cycle|target_changed|source_changed|private_source|scope_unconfirmed|unsupported_relationship`. Messages plain safe user text, no SQL/secrets.

`projectImportPreviewSchema / ProjectImportPreviewDto = {importId,projectId,importRevision,sourceDigest,previewHash,rows:[{rowNumber,externalId:string|null,targetTaskId:UUID|null,action:'create'|'skip'|'conflict'|'blocked',title,parentExternalId:string|null,customValues:[{fieldId,value:TaskFieldData,sourceMeaning}]}],issues:ProjectImportIssueDto[],summary:{sourceRows,createCount,skipCount,conflictCount,blockedCount,preservedColumnCount},recoveryPeriodIds:UUID[]}`. All50 records accounted once; warning acknowledgment does not hide blocking issues. `sourceDigest` exact staged bytes; semantic mapping hash separate. Read-only preview never materializes/fixes tasks. Raw notes and unsupported nonempty cells remain visible in stage/reconciliation.

`projectImportReconciliationSchema / ProjectImportReconciliationDto` discriminated by status:

- `{status:'staged',importId,projectId,sourceRows,createdCount:0,skippedCount:0,rows:[],appliedAt:null}` before apply: no implied transferred records;
- `{status:'applied',importId,projectId,sourceRows,createdCount,skippedCount,rows:[{rowNumber,externalId,targetTaskId,state:'created'|'skipped',ownedRevisions:{taskRevision,participantsRevision,workPackageRevision,fields:[{fieldId,definitionRevision,valueRevision}]}}],appliedAt,sourceDigest,mappingHash,mapping:ProjectImportMapping}`.

`projectImportAppliedSchema / ProjectImportAppliedDto = {import:ProjectImportDto,reconciliation:ProjectImportReconciliationDto,tasks:TaskDto[],asOfChangeSeq}`; tasks includes created/skipped current authorized targets, canonical source-row order. Exact stored receipt is returned unchanged on retry; consumers invalidate/refetch instead of overwriting newer task snapshots.

Envelopes exactly `projectImportResponseSchema`, `projectImportPreviewResponseSchema`, `projectImportAppliedResponseSchema`, `projectImportReconciliationResponseSchema`. No list pagination needed for this50-row bounded artifact. Reading source/reconciliation requires current owner/admin `imports.manage`, matching source privacy restriction.

### Trusted source и transaction seams

Application derives context `{...trustedContext,source:'import'}` server-side without changing actor identity/requestId; no source/actor accepted in body. Current capability, artifact workspace/project and existing mapped target visibility before receipt replay; full new-command mapping/bounds/revisions/conflict eligibility after receipt, preserving exact success when unrelated source grows. New commands proposed `import.csv.stage` and `import.project.apply`. Inert stage has explicitly narrow prerequisite bypass, apply uses full current affected project/census policy and BEFORE-handler typed outcome. Unrecognized future import intent must fail closed.

Primitive readiness gate: one `createTaskInScope` and one scalar `setTaskFieldValueInScope` reused by original public commands and import; no production fake runner and no public nested command loop. Every target uses normal references/field policy; all rows/mapping/reconciliation commit once under one workspace barrier. Owned revision vector includes independently versioned mapped values/participants/package; task revision alone cannot certify unchanged source ownership.

Applied reconciliation хранит и возвращает normalized mapping целиком (всё ещё owner/admin-only): reopen показывает исходные sourceMeaning/sourceUnit/column decisions, а не восстанавливает их из текущих field labels или одного mappingHash. Для accepted UTF8 файлов browser/server digest используют один raw text с сохранённым initial BOM; parser view снимает BOM отдельно.
