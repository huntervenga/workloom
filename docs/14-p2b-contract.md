# P2b: категории работы и быстрый ввод недели — ограниченный контракт

Статус: **ограниченный P2b реализован и принят координатором, 16 октября 2026 года**, после принятого P2a source checkpoint `fd69f3748a8538ad45e9480c0cfecd70ad7e2c9c`. Контракт, domain, PostgreSQL, API и UI прошли отдельную приёмку; точные результаты, browser-сценарии и визуальные проверки находятся в [журнале 11](11-implementation-progress.md). Это не завершение всего P2 или MVP. Добавлена миграция 0004; применённые 0000–0003 и прежние work.set input/hash сохранены. Автор core — Codex gpt-6.1-sol high в согласованном fallback после фактического лимита Claude; новых Claude-запросов в этом срезе нет.

Основания: [простой факт и доли типов](01-product-spec.md), [история полей и worklogs](03-domain-and-data.md), [этапы P2/P3](06-implementation-plan.md), [контракт P2a](13-p2a-contract.md). Точные публичные схемы и порт находятся в packages/contracts/src/categories.ts и packages/domain/src/categories/application.ts. Фактическую приёмку и её границы фиксирует журнал 11, а не наличие экспортов.

## 1. Ограниченный результат

Проект выбирает одно существующее поле `single_select` как основной тип работы. Первая фактическая запись сохраняет категорию со стабильными ID и исторической подписью; изменение часов не переклассифицирует её. Отдельная явная команда меняет категорию с причиной и новой immutable revision. Отдельный pinned-отчёт показывает доли по типам и людям, включая «Без категории» в знаменателе. В таблице появляется явный выбор периода, личный план и безопасная запись собственного недельного факта без повторного выбора задачи.

Нет встроенного списка bugs/core/support и логики по строке «Тип работы». Названия и варианты выбирает проект. Tags остаются множественными измерениями: их пересекающиеся доли не выдаются за разбиение на 100%.

Отложены: required-fact-on-Done, неявный выбор недели, дневной факт, разделение одного недельного источника по нескольким категориям, перенос/merge факта, закрытие периода и его коррекции, универсальный report builder, новые meeting/attendance-источники, recurrence, Auth и deployment. P3 остаётся следующим отдельным этапом. Работа нескольких категорий внутри одного накопительного manual-period source не угадывается и не делится автоматически.

## 2. Каталог и публичный порт

Все пути имеют prefix `/api/v1/workspaces/:workspaceId`. Envelope и ошибки прежние. Все записи требуют `Idempotency-Key`. Контекст actor/workspace/source/requestId серверный; membership фильтра или исполнителя не становится actor. UUID lowercase, query/body строгие. Все списки используют `PlanningPage<T> {items,nextCursor}`, limit 1–100, default 50, подписанный cursor с actor/workspace/permission epoch/фильтрами. Неописанные query-поля отклоняются.

| Метод и путь | Schema входа / запроса | Schema ответа / метод `WorkCategoryApplication` |
| --- | --- | --- |
| GET `/projects/:projectId/work-category-binding` | — | `projectWorkCategoryBindingResponseSchema` / getBinding(ctx,projectId) |
| PATCH `/projects/:projectId/work-category-binding` | `updateProjectWorkCategoryBindingInputSchema` | binding response / updateBinding(ctx,projectId,input), 200 |
| POST `/worklogs/:workLogId/recategorize` | `recategorizeWorkLogInputSchema` | `categorizedWorkLogResponseSchema` / recategorizeWorkLog(ctx,workLogId,input), 200 |
| GET `/work-type-report-runs` | `workTypeReportRunListQuerySchema` | `workTypeReportRunListResponseSchema` / listReportRuns(ctx,query) |
| POST `/work-type-report-runs` | `createWorkTypeReportRunInputSchema` | `workTypeReportRunResponseSchema` / createReportRun(ctx,input), 201 |
| GET `/work-type-report-runs/:runId` | — | work-type run response / getReportRun(ctx,runId) |
| GET `/work-type-report-runs/:runId/rows` | `planningPageQuerySchema` | `workTypeReportRowListResponseSchema` / listReportRows(ctx,runId,query) |
| GET `/projects/:projectId/periods/:periodId/task-time-summary` | `taskTimeSummaryQuerySchema` | `taskTimeSummaryResponseSchema` / getTaskTimeSummary(ctx,projectId,periodId,query) |

Последний маршрут — принятая в этом проекте одна ограниченная read projection для видимых строк таблицы. Он не заменяет task query: не возвращает titles, statuses, tags или дерево. UI продолжает использовать существующую пагинацию задач. Зафиксированный каталог содержит восемь реализованных маршрутов.

Composition: `@workloom/db createWorkCategoryApplication(source, options?) : WorkCategoryApplication`, порт в `@workloom/domain`, ctx первым аргументом, все методы Promise. Реальный `PlanningApplication` использует тот же category resolver при создании ревизий времени. Нет optional no-op bypass в production composition. Чтения проходят согласованную read transaction; записи — текущие ACL, idempotent replay и общий workspace barrier/cutoff guard, состояние + audit + outbox + revision + stored outcome атомарны.

## 3. Версионируемая привязка проекта

`ProjectWorkCategoryBindingDto`:

- `workspaceId`, `projectId`, `revision` (integer >=1), `versionId: UUID|null`;
- `fieldId: UUID|null` — именно настроенный ID, сохраняется при архивировании поля;
- `availability: 'unbound'|'active'|'field_archived'` — вычисляемое состояние текущего определения.

Отсутствующая настройка читается как virtual revision 1, versionId=null, fieldId=null, availability=unbound; GET ничего не вставляет. Первый реальный PATCH создаёт revision 2 и серверный versionId. Дальнейшая реальная смена поля/очистка увеличивает revision и сохраняет immutable binding version. `fieldId:null` явно снимает привязку. Совпадающее значение — no-op без новой версии; expected revision всё равно проверяется.

`UpdateProjectWorkCategoryBindingInput = {expectedRevision, fieldId: UUID|null}`. Управление требует `fields.manage`; проект должен быть видимым и активным. Ненулевой fieldId должен принадлежать этому workspace/project, иметь тип single_select и быть активным: foreign/missing 404, видимая несовместимость 422. Чужое имя, client labels и произвольный список категорий не принимаются.

Переименование поля/варианта не меняет binding revision. Стабильные field/option IDs сохраняются. Архивирование связанного поля разрешено и делает binding unavailable; его настройки/версии не удаляются. Новый факт в этом состоянии сохраняется без категории с явным provenance, а часы не блокируются. Старые факты сохраняют прежнюю категорию. Владелец может явно перепривязать или очистить binding. Само изменение привязки не меняет TaskFieldValue, WorkLogRevision, planning baseline или старый report run.

UI получает варианты через существующий GET fields?projectId, включая retained archived metadata. Нового дублирующего options query не нужно.

## 4. Снимок категории в фактической ревизии

`WorkCategorySnapshot` — discriminated union:

```ts
type WorkCategorySnapshot =
  | {
      kind: 'categorized';
      bindingVersionId: UUID; bindingRevision: number;
      fieldId: UUID; fieldDefinitionVersionId: UUID; fieldLabel: string;
      optionId: UUID; optionRevision: number; optionLabel: string;
      color: string | null; optionArchivedAt: UtcTimestamp | null;
    }
  | {
      kind: 'uncategorized';
      reason: 'legacy' | 'unbound' | 'field_unavailable' | 'unset' | 'explicit_clear';
      bindingVersionId: UUID | null; bindingRevision: number | null;
      fieldId: UUID | null;
    };
```

Category ID — пара `(fieldId,optionId)`; binding version — происхождение выбора, а не дополнительный bucket. «Без категории» имеет отдельный системный key, не option с зарезервированным пользовательским названием.

На **первом** активном manual-period source команда читает текущую project binding, field definition и значение **его source task** под тем же barrier:

1. binding отсутствует/снят — uncategorized/unbound;
2. связанное поле архивировано — uncategorized/field_unavailable;
3. field value отсутствует или typed-null — uncategorized/unset;
4. валидный single-select ID — снимок текущей immutable definition version и option metadata.

Потомок использует категорию своей source task, без неявного наследования от родителя/package. Разные source tasks общего package могут иметь разные категории факта. Пакет и бюджет остаются общими; записи работы при группировке не размножаются.

Уже выбранный задачей архивный option может быть сохранён в первом снимке факта как retained reference: он всё ещё принадлежит тому же полю и отражён в текущем валидном TaskFieldValue. UI не предлагает его для новой установки категории задачи или явной переклассификации другой записи. Невалидная сохранённая ссылка — ошибка целостности, а не повод молча записать «Без категории».

Существующий PUT manual-period-work сохраняет прежние input/body defaults и командное имя `work.set`. При исправлении minutes/state он **копирует category snapshot прежней revision**. Смена task field, option label, binding или цвета не вызывает переклассификацию при вводе нового недельного итога. Повторное активирование void source также сохраняет его категорию. No-op minutes/state остаётся no-op; не создаёт скрытую «обновлённую категорию».

Один стабильный manual-period source — накопительный итог task/member/period с одной выбранной категорией последней ревизии. Отдельная переклассификация относится ко всему этому итогу. Если внутри недели реально было несколько типов работы, P2b не придумывает распределение: нужны разные source tasks либо будущий явный split с сохранением суммы.

Старые WorkLogRevision не получают категорию из нынешнего поля. На read boundary отсутствующий старый snapshot трактуется как uncategorized/legacy. Все старые минуты входят в этот bucket и знаменатель. Самих старых строк, JSON pinned-документов и snapshot labels миграция не переписывает.

`CategorizedWorkLogDto` — существующие ManualPeriodWorkLogDto fields + canonical `category: WorkCategorySnapshot`. Для старого GET worklogs допустимо additive **optional, без default** category-поле; старый stored idempotent DTO без него остаётся валидным. Новые category endpoints/projection/report rows возвращают canonical category обязательно. Старый успешный ответ после replay не достраивает историческую категорию из mutable task state; UI инвалидирует и читает текущую проекцию.

## 5. Явная переклассификация

`RecategorizeWorkLogInput = {expectedWorkLogRevision, expectedBindingRevision, optionId: UUID|null, reason}`. Revision integers >=1; reason trimmed 1–1000. Поля minutes/state/taskId/membershipId/periodId/labels/source запрещены. Клиент выбирает option только текущей binding проекта; null означает явную очистку.

Команда находит источник с текущим workspace scope, проверяет действующее membership actor и `time.write_self` либо `time.write_others` по **worker**, а не по автору старой записи. Проверяет actual worklog revision и actual binding revision до изменения; stale —409 REVISION_CONFLICT. Непустой option при unbound/unavailable binding или option другого видимого поля —422; missing/foreign reference —404; новое назначение архивного option —422.

Только active source можно переклассифицировать. Для void сначала нужно явное восстановление через существующий PUT с причиной. Та же identity категории — no-op после проверки guards; rename цвета/label не заставляет переписывать прежний snapshot. Clear уже uncategorized — no-op. Настоящая смена создаёт следующую immutable WorkLogRevision с прежними minutes/state/source identity, новым snapshot, причиной, actor/source/time/changeSeq, новым head и audit/outbox. Это не новый WorkLog и не второе начисление.

Для optionId=null допускается current unbound binding с его актуальной revision. Создаётся uncategorized/explicit_clear с текущим binding provenance. Старые category snapshots и старые report runs остаются читаемыми.

Replay hash включает workLogId и канонический input. Повтор после неопределённого ответа возвращает ту же revision; другой target/body под тем же ключом —409. Проверка текущего worker access/capability предшествует replay.

## 6. Отдельный pinned work-type report

`CreateWorkTypeReportRunInput = {periodId, membershipIds?: UUID[]}`; default selection — разрешённые worker identities с фактическими source этого периода, включая zero/void sources; людей без источников сервер не добавляет. Explicit selected member без sources получает нулевую summary/пустые buckets, проценты null, без заявления полноты.  explicit list 1–100 unique IDs либо omitted/empty для all. Нет baselineId, knownEstimatesOnly, клиентских percentages/labels, category filter или произвольного groupBy. Он работает **до фиксации плана**. Initial scope — один период/проект; источник периода всегда явный.

`WorkTypeReportRunListQuery = {periodId,limit?,cursor?}`. Получение summary/rows требует `reports.read`, актуального workspace/task access до суммирования и при каждом последующем чтении pinned run. Сохранённый snapshot не выдаёт исторических прав. Новый read-only viewer может смотреть только доступный ему набор; скрытые строки, counts и разность totals не раскрываются.

`WorkTypeReportRunDto`:

- id/workspaceId/projectId/periodId, `metricVersion:'weekly_work_type_v1'`;
- createdAt/actorUserId, factCutoffAt/factChangeSeq, effective membershipIds;
- `totalActualMinutes`, `activeSourceCount`, `categorizedMinutes`, `uncategorizedMinutes`;
- `byCategory: WorkTypeBucketDto[]` и `byPerson: {membershipId,memberName,totalActualMinutes,byCategory:WorkTypeBucketDto[]}[]`;
- rowCount, immutable workLogRevisionIds manifest и `labelPolicy:'highest_option_revision_then_change_seq_then_id'`.

`WorkTypeBucketDto = {key,fieldId:UUID|null,optionId:UUID|null,label,color:string|null,minutes,sharePercent:number|null}`. Null IDs относятся только к uncategorized. Никаких fixed bugs/support значений.

Непагинируемые manifest/summary arrays имеют явные пределы: effective membershipIds и byPerson — не более 1000 человек; byCategory — не более 1000 buckets с учётом uncategorized; вложенный byPerson.byCategory — не более 1000 buckets на человека. Лимиты проверяются до сохранения run. Превышение —422 с явной ошибкой размера, без обрезания людей, категорий, минут или знаменателя; выбор более узкого набора людей остаётся явным. Rows по-прежнему пагинируются.

Состав — по одной выбранной current revision **каждого фактического source** выбранного периода/людей на серверном cutoff, по unique WorkLog ID. Все реально реализованные источники должны участвовать; в текущем P2a это manual_period. P2b не создаёт фиктивную поддержку meeting/daily источников: добавление источников в P3 обязано расширить единый reader без изменения определения знаменателя. Original/added/unplanned работа, открытые/Done/архивные задачи и detail children не исключаются из факта из-за своего планового состояния.

Void revisions сохраняются в pinned revision manifest/diagnostic drilldown с excluded=true, но не входят в activeSourceCount, minutes или percentages. Active zero — внесённый source, его minutes=0; отсутствие source не создаёт фиктивную нулевую строку. `workLogRevisionIds` совпадает с pinned rows; каждый revision ID встречается один раз.

Отчёт показывает записанные минуты и recorded activeSourceCount. Наличие источников не доказывает полноту учёта времени: незаписанная работа неизвестна, её объём и долю сервер не выводит. UI не называет эти доли полным распределением всех трудозатрат или покрытием недели.

Для команды `bucket.sharePercent = bucket.minutes / totalActualMinutes * 100`; для строки человека знаменатель — все его active минуты в том же выбранном периоде. Uncategorized входит в оба знаменателя. При denominator=0 percent=null, даже если есть active zero. После округления подписей возможен визуальный 99,9/100,1%; исходные minutes и denominator не корректируются ради картинки.

Группировка categorized — stable `(fieldId,optionId)` через binding versions. Label/color каждого bucket берутся из **включённого active** category snapshot с наибольшим optionRevision, затем numeric worklog changeSeq и revision ID как tie-break; не из нынешнего option definition. Обычная коррекция часов старого source переносит его старую label и не может вернуть bucket к более старой optionRevision, если включён другой source с новой observed label. При наличии только zero active sources правило то же. Uncategorized label — локализованная системная подпись. Каждая pinned source row сохраняет собственный historical label, поэтому rename объясним в drilldown. Позднейшие rename, rebind, исправление факта и переклассификация не меняют прежний run; новый run получает новые revisions.

`WorkTypeReportRowDto = {id:revisionId, workLog:CategorizedWorkLogDto, taskTitle, memberName, excluded:boolean}`. Названия task/member фиксируются при создании run. Category label остаётся из revision snapshot. Summary, byPerson, byCategory и rows принадлежат одному manifest/cutoff; графики не вычисляют доли из загруженной страницы rows. Rows cursor привязан к run ID и текущему читателю. Клиентские фильтры drilldown не меняют незаметно pinned знаменатель.

Отдельные collection/DTO/table сохраняют старый `weekly_plan_fact_v1`: его schema literal, обязательный baselineId, формулы и JSON документов P2a не меняются. Добавлять второй тип документа в старую list collection без version negotiation запрещено. Новый report table immutable по UPDATE/DELETE/TRUNCATE, с настоящими scoped FK на period/project и проверками identity/manifest.

## 7. Таблица: явная неделя, личный план и факт

Используются существующие task query, GET periods, POST/PUT commitments, GET baselines, GET worklogs и PUT manual-period-work. Выбор периода обязателен; браузер не подставляет «текущую» неделю по часам. Личный lens по умолчанию выбирает server actor membership. Просмотр коллег не меняет actor; возможность правки чужих часов/плана определяется time.write_others/plan.write_others.

В task row:

- «Мой план недели» — allocation на эту task; пакетный commitment и его unallocatedMinutes показываются один раз на package, не копируются в каждую подзадачу. Null план, отсутствие commitment и allocation0 различаются. Для правки открывается существующая commitment form с настоящей revision. Исходный personal baseline доступен отдельно от текущего плана; added отметки сохраняются.
- «Факт недели» в личном lens показывает actual выбранного человека с ясным периодом. Если это один manual source данной task, действие сразу открывает компактную форму с prefilled task/member/period и expected revision. Enter сохраняет только явно введённое валидное число часов, 0 допустим, пусто не означает0; correction/void требуют причину.
- Если видимая сумма включает других работников, родительский/package rollup или иные sources, клетка открывает breakdown. Нельзя отправлять displayed aggregate в manual PUT. После явного выбора источника редактируется только он. Team/package totals остаются read-only.

Один исходный log на task/member/period не дублируется из-за другого key или перехода между карточкой/таблицей. Статус pending/uncertain, frozen submitted variables, ключ и drafts живут выше строк/пагинации/selector; их ключ включает actor/workspace/period/task/member. Смена строки, сортировки или недели не теряет неизвестную отправку и не посылает её под новой неделей. Retry — только явный, с прежним payload/key. Actor/workspace boundaries используют существующий cache/command cleanup. Denied refetch скрывает старые значения до любых recovery controls.

Никаких глобальных totals из загруженной части задач. Графики/итоги периода берутся из authoritative pinned report; table projection даёт только полностью посчитанные клетки конкретных task/package. Если UI показывает subtotal загруженного набора, он не называется итогом недели и не участвует в диаграмме долей.

## 8. Минимальная read projection

`TaskTimeSummaryQuery = {taskIds: CSV UUID[1..100], membershipId?:UUID}`. IDs unique/canonical/sorted; membership omitted разрешается сервером в текущий membership. Нельзя передать actor/source/timezone. Проект/период должны совпадать. Любой missing/foreign task ID —404 всего запроса; видимая task другого проекта —422. Ни частичного ответа, ни скрытого cap; GET ничего не фиксирует и не пишет.

`TaskTimeSummaryDto = {workspaceId,projectId,periodId,subjectMembershipId,asOfChangeSeq,tasks:TaskTimeRowDto[],packages:PackageTimeRowDto[]}`. Одна согласованная read transaction; cache key включает actor/workspace/period/subject/набор ID. Полные task DTO здесь не возвращаются.

`TaskTimeRowDto = {taskId,workPackageId,currentAllocationMinutes:number|null,ownManualWork:CategorizedWorkLogDto|null,subjectActualMinutes,taskActualMinutes,subjectActiveSourceCount,taskActiveSourceCount,hasOtherSources}`. Null allocation — связи нет, 0 — явное распределение0. ownManualWork — только stable manual source выбранного worker/периода на данной task, включая void для точной revision; subjectActualMinutes включает все active источники этого worker, taskActualMinutes — всех разрешённых workers данной task. activeSourceCount в task row считает active источники выбранного worker; package row считает все active источники, участвующие в его totalActualMinutes. `hasOtherSources` означает наличие active source выбранного worker, отличного от own manual source; для absent/void-only набора activeSourceCount=0 и hasOtherSources=false, хотя ownManualWork сохраняет void head для корректной expectedRevision. UI решает safe edit/breakdown по серверной проекции, не по догадке.

`PackageTimeRowDto = {workPackageId,commitment:PeriodCommitmentDto|null,subjectActualMinutes,totalActualMinutes,subjectActiveSourceCount,totalActiveSourceCount}`. По одной строке на package среди запрошенных task IDs, но actual считается по **всем доступным source tasks пакета этого периода**, включая незагруженных детей. При выводе package итог не прибавляется к detail task rows ещё раз. Ни task nor package subtotal не объявляется итогом всего периода.

Состояние active0/void/absent различается через source/state/count. Для archived task сохранённый source читается; обычная правка его часов следует P2a current rights/revision, новая категория не получается через подмену task identity. Ручная запись никогда не заменяет прочие источники.

## 9. Совместимость и целостность

1. P2a `work.set` command name, path targets, старый parsed input/defaults и payload hash остаются прежними. Новый category default не вставляется в старый input. Тот же старый raw запрос/key должен replay прежний результат после upgrade.
2. Все старые plain DTO и tagged committed-rejection outcomes остаются читаемыми. Category DTO additions optional **без default** на старом response boundary; старые cached outcomes не переписываются и не обогащаются при replay; canonical category требуется только в новых endpoints/проекциях.
3. Новая последовательная migration после принятого P2a, без редактирования применённых 0000–0003. Binding current header + immutable versions, nullable legacy category snapshot и реальные scoped category references в WorkLogRevision, отдельный immutable work-type run. Categorized refs обязаны через composite scoped FK соответствовать workspace/project/source log, bindingVersion, field/option owner и immutable definitionVersion. Nullable refs и snapshot проверяются совместно: допустимые комбинации categorized/uncategorized/legacy выражены CHECK (... IS TRUE), чтобы SQL NULL не пропускал неполный снимок; JSON labels не заменяют FK. Конкретный SQL layout утверждает DB owner.
4. Старые category snapshots, binding versions, work revisions и report documents нельзя UPDATE/DELETE/TRUNCATE. Нет backfill из current task. Для старых таблиц с новыми nullable columns migration proof сравнивает **старую проекцию колонок**, отдельно проверяет legacy uncategorized; не заявляет невозможное равенство whole-row JSON с добавленными ключами.
5. Новый resolver вызывается в общей time revision команде под barrier, не в HTTP/UI. Hours-only correction переносит старый snapshot; recategorization пишет ровно одну новую revision и правильный head, без нового source. Scope/source identity/head FK/immutable guards P2a сохраняются.
6. Новые command intents явно добавляются в exhaustive planning guard: binding changes/recategorization/report creation сначала выполняют due freeze, но не меняют исходный baseline. Ошибка откатывает все новые эффекты; replay после current ACL не создаёт ни второй revision, ни второй run.
7. Tags пока не добавляют взаимоисключающие buckets/клиентскую арифметику. Category report не применяет known-estimate cohort filter P2a: знаменатель — весь разрешённый факт выбранного периода/людей.

## 10. Проверки и границы приёмки

Обязательные fixtures:

- 60 минут категории A, 30 B, 30 legacy/unset: доли50/25/25, сумма120; team и person denominators явно различаются. Все unclassified минуты входят; active0 даёт recorded source без деления на0, void исключён.
- Категория source A → переименование option → обычное изменение часов: старая category identity/label snapshot сохраняется. Новая task/source после rename снимает новую label version; затем hours-only correction старого source переносит старую label, но bucket нового run сохраняет новую label по большей optionRevision. Pinned grouping детерминирован, старый run не меняется.
- Rebind/clear/archive field: старые facts/report не меняются; новые first facts получают правильную категорию либо явное uncategorized. Retained archived option и чужой/new archived option различаются.
- Explicit recategorization требует actual worklog/binding revisions, разрешённого worker, причины и текущего option owner; меняет revision, а не log identity/сумму. Stale409, foreign404, несовместимость422, lost response exact-key replay без дублей.
- Populated P2a upgrade сохраняет старые колонковые проекции/JSON documents и старый `work.set` replay hash/result. Новые отчёты считают старые active часы uncategorized. Старые report clients не получают новый metric в прежней collection.
- Root/detail tasks, несколько участников и несколько tags не размножают фактические минуты. Проекция по ≤100 видимым ID возвращает полный package subtotal с незагруженными детьми; итог периода/диаграмма не зависят от task/rows pagination.
- Quick entry: periodA/taskA отправлен → смена периода/сортировки/строки → pending/uncertain snapshot/key сохраняются; попытка другой записи не стирает первую; точный retry использует A. Manager не заменяет чужие/командные суммы. Denied refetch/actor switch не показывают cached category/fact/plan.
- Absent/void-only проекция даёт нулевые соответствующие subject/task/package counts и hasOtherSources=false и сохраняет void head; active0 остаётся recorded source. Пределы 1000 people/buckets дают явный422 без truncation. UI показывает recorded source count без заявления о полноте учёта.
- Один category report можно создать без baseline до freeze. Новый fact revision меняет новый run, но не прежний. Current access проверяется также при чтении старого run и rows.

Порядок принят после checkpoint P2a: review всеми владельцами → фиксация DTO/ports → contracts/DB/domain → тонкий API → table/report UI → реальные PostgreSQL и browser gates. Контракт зафиксирован; источником статуса завершения и фактических проверок остаётся журнал 11. Required-fact-on-Done остаётся отдельным решением: глобальный task status пока не определяет единственный период, worker и источник факта.

## 11. Точные экспорты замороженного контракта

`common/work-category.ts` содержит standalone `workCategorySnapshotSchema`/`WorkCategorySnapshot` без runtime import planning/categories. Старый `manualPeriodWorkLogSchema` добавляет только optional category без default; `setManualPeriodWorkInputSchema` не меняется. `categories.ts` экспортирует lowerCamel Schema и соответствующие PascalCase Dto/Input/Query из таблицы маршрутов; `categorizedWorkLogSchema` требует canonical category. Порт `WorkCategoryApplication` экспортируется из domain; factory `createWorkCategoryApplication(source:Database|WorkloomExecutor,options?:WorkCategoryApplicationOptions extends WorkspaceWriteOptions {cursorSecret?:string})`.

В byPerson также есть activeSourceCount. Для проекции counts разделены на subjectActiveSourceCount/taskActiveSourceCount и subjectActiveSourceCount/totalActiveSourceCount у package. Absent или void-only source означает active count0 и hasOtherSources=false, но ownManualWork сохраняет void head. hasOtherSources относится только к выбранному worker. Явный выбор недели обязателен для table writes; автоматический default отдельной weekly-route не используется. Batch >100 IDs разделяется, одинаковые package IDs не суммируются повторно; различный numeric asOfChangeSeq требует согласования/refetch.

Split/replace/transfer/carryover, close/corrections и принятие позднего unknown estimate остаются более поздним P2; этот P2b срез их не обещает. Приёмка этого среза не означает готовность всего продукта; следующие этапы требуют собственных проверок.
