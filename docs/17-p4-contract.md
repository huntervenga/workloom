# P4a: зависимости, блокировки и персональный граф — контракт кандидата

Статус: **принятый ограниченный P4a, 16 октября 2026 года**. Реализованы девять операций frozen-каталога, общий task/recurrence status validator, глобальные cycle checks, ограниченный graph projection и собственная раскладка. Функциональные, upgrade/replay и текущие desktop/mobile проверки приняты; точная хронология широких и последующих targeted проверок, первоначальных ошибок и исправлений — в [журнале](11-implementation-progress.md). Source checkpoint и финальная сверка served assets оформляются coordinator отдельно. Gantt/startDate/date batch/baseline overlay/private ACL/Auth/deploy не входят в этот приёмочный срез.

Основания: [продукт](01-product-spec.md), [архитектура](02-architecture.md), [domain §12](03-domain-and-data.md), [P4.1–P4.6](06-implementation-plan.md), [baseline](13-p2a-contract.md), [meetings](15-p3a-contract.md), [recurrence](16-p3b-contract.md). Публичные schemas/types находятся в `packages/contracts/src/dependencies.ts`; nine-method `DependencyApplication` и реальная `@workloom/db.createDependencyApplication` реализованы.

## 1. Принятый ограниченный срез

**P4a:** одна модель finish-to-start edges между задачами разных проектов одного workspace; серверный authoritative blocking; warn по умолчанию и status-only enforce; карточка связей; базовый плоский граф выбранного набора и персональное сохранение координат. A→B→C виден в карточке и графе, C→A отклоняется, скрытый пользовательским фильтром predecessor продолжает блокировать.

**P4b отдельно:** nullable startDate, календарный timeline/Gantt, atomic date preview/apply, baseline date overlay. Historical dependency topology — ещё отдельное последующее решение snapshot section. P4a не добавляет startDate, не меняет старые task inputs/defaults/hashes и не выдаёт граф за Gantt. Effort, commitment и факт не превращаются в календарную длительность. Нет lag, auto cascade, critical path, resource levelling, nested subflows, общего layout или SavedView builder.

## 2. Истина, доступ и совместимость

Task, parent tree, package lineage и dependency — разные сущности. Graph node использует исходный task ID, selection открывает обычную карточку. Перемещение/удаление node из вида не меняет Task, его parent, package, estimate, plan, fact или существование.

Оба конца edge принадлежат одному workspace; разные проекты разрешены. Read проверяет current task.read на обоих концах, create/remove/restore — current task.edit на обоих. Cross-workspace/неизвестный endpoint возвращает404 без чужих данных. Self-edge/несовместимое состояние —422. В P4a archived endpoints разрешены при тех же правах; archive не удаляет edge и не снимает unresolved blocker.

Текущий продукт workspace-visible. Будущие private ACL здесь не реализуются и не сертифицируются. После их появления нельзя раскрывать ID/название/координаты/число закрытых blockers без отдельной политики. Denied refetch прячет cached graph/list/detail/layout до восстановления доступа. Queries/cursors/cache scoped actor+workspace+current permission epoch.

Старые TaskDto, request input/hash, idempotency outcomes, baseline/report JSON остаются байтово прежними. P4a projections отдельные: не добавлять blocking default в старый stored TaskDto и не переписывать pinned документы. Старые браузерные bundles и old-tab upgrade — отдельный P6 gate.

## 3. Domain records и SQL

`TaskDependencyDto = {id,workspaceId,predecessorTaskId,successorTaskId,type:'finish_to_start',state:'active'|'removed',revision,createdAt,updatedAt}`. Все IDs UUID; revision>=1; timestamps UTC. Таблица FK `(workspace_id, task_id)` на оба конца, CHECK predecessor<>successor, UNIQUE(workspace,predecessor,successor,type). Никаких cascade deletes истории. Stable ID сохраняется после remove/restore.

POST input `{predecessorTaskId,successorTaskId,type:'finish_to_start',expectedAbsent:true}`. Сервер создаёт ID; уже существующая natural identity active **или removed** даёт409, кроме exact-key replay. PATCH `{expectedRevision>=1,state:'active'|'removed'}`; restore explicit, same-state no-op проверяет revision, но не добавляет revision/audit/outbox.

`ProjectDependencyPolicyDto = {projectId,mode:'warn'|'enforce',revision>=0,updatedAt:UTC|null}`. При отсутствии row сервер возвращает warn/revision0/updatedAtnull; это read projection, не скрытая запись. PATCH `{expectedRevision>=0,mode}`:0 означает expected absent, первый реальный change создаёт revision1. Same-mode no-op не пишет. Capability **`dependencies.manage` только owner/admin**, добавить в единую role-capability table; не заимствовать случайную fields/time capability.

`GraphLayoutDto = {workspaceId,projectId,membershipId,viewKey:'default',revision>=0,positions:[{taskId,x,y}],updatedAt:UTC|null}`. Natural identity `(workspace,project,membership,viewKey)`, own membership серверный, не input. Absent layout возвращает revision0/positions[]/updatedAtnull без insert. Positions unique taskId, <=500, x/y finite в диапазоне -100000..100000, дробные значения допустимы. Task FK scoped workspace, межпроектные neighbor positions разрешены. Layout read/write требует task.read на проекте и каждом возвращаемом/записываемом task; пользователь меняет только свой layout, в том числе viewer может сохранить собственное представление.

PUT layout `{expectedRevision>=0,positions:[...]}` — **явная полная замена**, не patch загруженного viewport. UI сначала получает весь собственный layout, сохраняет скрытые фильтром позиции и отправляет reviewed full set; explicit positions[] сбрасывает только этот персональный layout. Expected0 — absent; same normalized positions no-op. Layout revision независим от task/dependency revisions. Это view preference с footprint none: **явно обойти все due-freeze/materialization loops**, а не просто передать none существующему guard, который ещё может фиксировать complete overdue periods. Own ACL/revision/idempotency/barrier сохраняются; движение узла не фиксирует даже готовые чужие периоды.

## 4. Циклы, blocking и статусная политика

Все edge create/restore выполняются под существующим workspace barrier. После lock recursive query ищет путь successor→predecessor по **всем active edges workspace**, включая другие проекты, archived tasks и узлы вне UI. Путь → `DEPENDENCY_CYCLE`409 (существующий canonical DomainError); self-edge →422. SQL traversal использует visited/UNION, не зацикливается на повреждённом графе. UI bounds никогда не ограничивают cycle check. Конкурентные A→B/B→A не могут обе закоммититься.

Predecessor resolved только когда текущий status.group===done. Cancelled без done и archived без done остаются unresolved; archived done resolved. Policy берётся **у проекта successor**. Полный incoming graph определяет blocking независимо от загруженных rows/filters. Warn: unresolved indicator/warning сохраняется, но новый переход successor в in_progress/done разрешён. Enforce: **реальное изменение statusId** в target group in_progress/done при unresolved predecessor отклоняется `DOMAIN_VALIDATION_FAILED`422 до proposed task writes. Metadata-only и exact same-status no-op допустимы; переход между двумя разными in_progress status IDs тоже статусная правка и проверяется. Переход в todo/cancelled не запрещается этим guard.

Create/restore unresolved edge к successor уже in_progress/done в enforce отклоняется422. Включение enforce или reopening predecessor не переписывает существующие successor statuses: projection показывает violation. Meeting Done остаётся status signal, не создаёт attendance/fact. Edge remove не обходит current access и остаётся audited.

Guard — **общая in-scope проверка перехода статуса**, не HTTP/web и не только TaskApplication.updateTask. Её вызывают TaskApplication и P3b reviseOccurrenceMeetingInScope при template edit существующих встреч; initial create новой встречи ещё не имеет edges. Batch/series apply заранее проверяет все предполагаемые status transitions до любых command writes, затем тот же validator защищает relevant task save. Recurrence template не получает bypass из-за внутреннего composer. Edge writes и policy writes используют тот же planning/recurrence pre-handler guard protocol; footprint включает проекты обоих endpoints, policy — successor project. Неожиданный поздний сбой откатывает edge/policy/audit/outbox/key. Если cutoff сохраняется с ожидаемым отказом — только существующий tagged pre-handler outcome; не catch-and-commit после частичных proposed writes. Новые edges не изменяют прошлый baseline и не притворяются historical topology.

## 5. Публичные schemas и projections

Файл `packages/contracts/src/dependencies.ts`:

- `dependencyTaskContextSchema/DependencyTaskContextDto`, `taskDependencySchema/TaskDependencyDto`, `dependencyPolicyModeSchema`, `projectDependencyPolicySchema/ProjectDependencyPolicyDto`, `taskBlockingSummarySchema/TaskBlockingSummaryDto`, `taskBlockerSchema/TaskBlockerDto`, `taskBlockingSchema/TaskBlockingDto`, `dependencyGraphSchema/DependencyGraphDto`, `graphLayoutSchema/GraphLayoutDto`, `graphPositionSchema/GraphPositionDto`.
- Inputs `createTaskDependencyInputSchema/CreateTaskDependencyInput`, `updateTaskDependencyInputSchema/UpdateTaskDependencyInput`, `updateDependencyPolicyInputSchema/UpdateDependencyPolicyInput`, `setGraphLayoutInputSchema/SetGraphLayoutInput` — strict без новых defaults у старых commands.
- Queries `taskDependencyListQuerySchema/TaskDependencyListQuery`, `taskBlockingQuerySchema/TaskBlockingQuery`, `dependencyGraphQuerySchema/DependencyGraphQuery`. Для graph **отдельный `dependencyGraphInputSchema`** проверяет нормализованный array domain input, а wire schema преобразует CSV→sorted UUID array; не парсить transformed output повторно CSV schema.
- Responses `taskDependencyResponseSchema`, `taskDependencyListResponseSchema`, `taskBlockingResponseSchema`, `projectDependencyPolicyResponseSchema`, `dependencyGraphResponseSchema`, `graphLayoutResponseSchema` — существующие envelopes/meta.requestId/meta.nextCursor.

`TaskBlockingSummaryDto = {taskId,policy:{projectId,mode,revision},isBlocked:boolean,unresolvedCount:integer>=0,canStart:boolean,canComplete:boolean,violatesCurrentStatus:boolean}`. isBlocked=unresolvedCount>0 независимо от warn; canStart/canComplete false только при enforce+unresolved. violatesCurrentStatus=true при enforce+unresolved и текущей группе in_progress/done. Counts вычислены по полным authorized sources, не текущей странице. Никакого worklog/attendance вывода из status.

`DependencyTaskContextDto = {project:{id,name,archivedAt:UTC|null},status:{id,name,group:TaskStatusGroup}}` — labels в том же consistent read; context.project.id===task.projectId, context.status.id===task.statusId, status project совпадает. Текущий TaskStatusDto не имеет typed color, поэтому новый color не изобретается. Graph/карточка не отображает cross-project neighbor через root-project statuses и не делает до500 HTTP metadata lookups.

`TaskBlockerDto = {dependency:TaskDependencyDto,predecessor:TaskDto,predecessorContext:DependencyTaskContextDto}` только для unresolved active incoming edge. `TaskBlockingDto = {summary:TaskBlockingSummaryDto,blockers:TaskBlockerDto[],asOfChangeSeq:string}`; blockers paged, summary полная. Signed cursor связан с actor/workspace/task/permission epoch/source changeSeq; изменение источников между страницами → controlled `VALIDATION_FAILED`400 с явным restart списка. Meta.nextCursor не меняет summary semantics.

`DependencyGraphDto = {projectId,rootTaskIds:UUID[],neighborDepth:0|1|2,asOfChangeSeq:string,nodes:[{task:TaskDto,context:DependencyTaskContextDto,blocking:TaskBlockingSummaryDto,hasOutsideDependencies:boolean,outsideUnresolvedPredecessorCount:integer>=0}],edges:TaskDependencyDto[]}`. Источник — один consistent read; numeric changeSeq сериализуется строкой, UI сравнивает BigInt, не lexical/Number. Graph contains active edges induced выбранным neighborhood; summary по полным edges. `hasOutsideDependencies` учитывает active incident edge к узлу вне возвращённого набора. Exact outside unresolved count допустим в текущем workspace-visible продукте; никакой private-count гарантии.

## 6. HTTP/port каталог — 9 операций

Все пути под `/api/v1/workspaces/:workspaceId`. `ctx` первый, доверенный server actor/workspace/source/requestId; mutations требуют Idempotency-Key, Origin/Host guards сохраняются. Только PUT graph-layout получает scoped bodyLimit **256 KiB** для500 строго проверенных positions, включая escaped UUID JSON; остальные routes сохраняют глобальные16 KiB. Valid500 и payload>256 KiB проверяются транспортными тестами; cap не заменяет schema limits.

| Метод/путь | Query/input → result | Domain method |
| --- | --- | --- |
| GET `/dependencies` | strict union scope ниже → dependency page | `listDependencies(ctx,query)` |
| POST `/dependencies` | CreateTaskDependencyInput → Dependency201 | `createDependency(ctx,input)` |
| PATCH `/dependencies/:dependencyId` | UpdateTaskDependencyInput → Dependency200 | `updateDependency(ctx,dependencyId,input)` |
| GET `/tasks/:taskId/blocking` | limit/cursor → TaskBlockingDto200 +meta.nextCursor | `getTaskBlocking(ctx,taskId,query)` |
| GET `/projects/:projectId/dependency-policy` | no query → Policy200 | `getProjectPolicy(ctx,projectId)` |
| PATCH `/projects/:projectId/dependency-policy` | UpdateDependencyPolicyInput → Policy200 | `updateProjectPolicy(ctx,projectId,input)` |
| GET `/projects/:projectId/graph` | rootTaskIds CSV/depth → Graph200 | `getGraph(ctx,projectId,normalizedQuery)` |
| GET `/projects/:projectId/graph-layout` | no query → own Layout200 | `getGraphLayout(ctx,projectId)` |
| PUT `/projects/:projectId/graph-layout` | SetGraphLayoutInput → own Layout200 | `setGraphLayout(ctx,projectId,input)` |

`TaskDependencyListQuery` strict union: `{taskId,direction:'incoming'|'outgoing'|'both'(default both),state:'active'|'removed'|'all'(default active),limit1..100(default50),cursor?}` **либо** `{projectId,state,limit,cursor?}`. Exactly one scope, no direction in project branch. Project list включает edge когда хотя бы один endpoint в project; cross-project neighbor виден явно. Page `{items:TaskDependencyDto[],nextCursor:string|null}`. Stable UUID ordering; signed cursor scoped filters/current actor/permission epoch/source changeSeq. Blocking query только limit/cursor (defaults те же).

Graph query требует `rootTaskIds` CSV1..100 уникальных UUID, rejects array/repeated/empty query syntax, neighborDepth integer0..2 default1. Roots должны принадлежать path project (чужой workspace404; доступный root другого project422). Neighbor expansion по incoming **и** outgoing active edges на заданную глубину; доступные cross-project и archived endpoints включаются явно. Затем все active edges между выбранными nodes. Не task filter engine: UI берёт выбранные roots из существующего task list; implicit «весь проект» не разрешён. Максимум **500 nodes/1000 edges**, включая roots; превышение422 «сузьте набор», никакого silent truncation/partial graph. Check циклов/blockers не имеет этого cap.

`DependencyApplication` ровно эти9 ctx-first Promise methods. `getTaskBlocking` внутренне возвращает `{data:TaskBlockingDto,nextCursor:string|null}`; HTTP кладёт data в envelope, cursor в meta. Остальные singleton methods возвращают matching DTO; listDependencies — page. Реальная композиция `@workloom/db.createDependencyApplication(source:Database|WorkloomExecutor,options?:DependencyApplicationOptions extends WorkspaceWriteOptions{cursorSecret?:string}):DependencyApplication`. Нет второго пула, nested writer.run или business rules в API.

Canonical command names: `dependency.create`, `dependency.update`, `dependency.policy.update`, `graph.layout.set`. Hash включает command+path project/dependency target+parsed input; current access обоих endpoints/own membership проверяется **до stored outcome replay**. Same-key changed target/body409, same-key exact original outcome без повторных effects. Старые task command hashes не меняются: guard интегрируется после существующего replay/current access boundary.

## 7. UI и личный layout

Карточка показывает authoritative blockers до графа: searchable обычные task selects и add/remove/restore buttons, не только pointer handles. Показывает cross-project name/archived status и кнопку открыть доступный predecessor. Повторный confirmed400 cursor вызывает explicit restart; uncertain write повторяет original payload/key, не новую команду. Pending/uncertain state живёт выше modal/filter и привязан к исходной задаче/проекту.

Первое открытие графа использует явный table selection, иначе текущие видимые загруженные task IDs<=100 с подписью «из загруженных задач». Если набора больше100, UI просит сузить выбор, не обрезает его молча. После первого выбора roots и drafts остаются стабильными при фильтре/новой странице и меняются лишь явно; server query всё равно содержит конкретный массив, не implicit весь проект.

Граф плоский, fixed node dimensions; auto-layout локальный deterministic preview, не domain scheduling. Late layout response для старого graph source/actor/project игнорируется. «Сохранить раскладку» отдельная reviewed команда. Новые task/graph данные не запускают молчаливый full-layout save. Keyboard form add/remove и список остаются доступными на390px; Enter/Space открывает task, Escape снимает selection, arrow movement меняет только unsent coordinates, zoom/fit labels русские. Node delete не удаляет Task. Pending/uncertain/saved layout и unsent draft защищают departure согласно текущему общему lifecycle.

## 8. Отдельный P4b и deferred historical topology

P4b реализован и принят отдельно: nullable date-only startDate, inclusive dueDate, unknown/not_set distinction, обычные date guards и atomic preview/apply1..100 tasks одного проекта. Meeting schedule остаётся guarded single source. Calendar span не выводится из hours. Gantt/baseline overlay требует выбранного baselineId и captured values; старый snapshot без startDate — not_captured, не current backfill. Historical edges могут появиться лишь отдельной additive optional/no-default snapshot section, а current edges никогда не выдаются за прошлую topology. Ни один из этих routes/inputs не входит в текущие9 операций P4a.

## 9. Приёмка P4a и граница последующих проверок

1. Real PG/domain/API: A→B→C, opposite concurrent A→B/B→A ровно один commit; self422, cycle409, cross-workspace404; remove/restore stable IDs/revision; natural duplicate409; rollback позднего audit/outbox/key failure. Cross-project cycle проверяется через все active workspace edges, даже вне roots/depth500 UI bounds.
2. Authoritative blockers: archived/cancelled non-done остаётся unresolved; filter-hidden predecessor не исчезает. Warn permits new in_progress/done с предупреждением; enforce rejects before proposed writes, including direct TaskApplication. Same-status/metadata allowed; recurrence template edit существующей meeting задачи также проверяет enforce и при отказе не оставляет частичных series/task writes; existing policy/reopen violations видны без переписывания старых statuses. Meeting status не добавляет факт.
3. Current membership/capability before replay; viewer читает/сохраняет только свой layout, edge edit403; member не меняет policy; owner/admin dependencies.manage; unknown/foreign IDs no disclosure. Бounded cursor actor/workspace/filter/source race controlled400/restart.
4. Graph exact induced bounded neighborhood, roots100/depth2/nodes500/edges1000; overflow422 без partial pass. External blockers всё ещё authoritative. Async local layout по старому source/actor/project не заменяет current draft.
5. Layout own revision0 absence/no write, first save1, stale409, exact retry unchanged. Full-set save retains filtered positions; explicit reset не удаляет tasks/edges. При overdue cutoff (включая complete и incomplete census чужих периодов) layout save не меняет task/plan/baseline и не создаёт чужой outbox/audit: допустимы только own layout event/idempotency. Task/package/plan/fact histories unchanged. Upgrade old columns/replay/pinned JSON byte equality.
6. Browser: keyboard edge CRUD + pointer alternative, graph selected subset/cross-project/filtered blocker, one-node position save/reload, uncertain response exact retry and original target, current denied cached hiding. Desktop и390px визуально отдельно.

P4b отдельные gates: start/due null/DST/effort independence, atomic date batch/races/meeting locks, selected baseline provenance/old missing field, Gantt keyboard/date-input/overlay (pointer drag остаётся deferred). P4a не сертифицирует эти сценарии, private ACL, Auth, old-tab upgrade или production/worker hosting.

## 10. Dependency research и принятые зависимости


16 октября 2026 года после P4a GO повторно проверен официальный npm registry: `@xyflow/react` **12.12.0 MIT**, React/ReactDOM/@types peers>=17; `@dagrejs/dagre` **3.1.1 MIT**, bundled `dist/types/index.d.ts`, transitive graphlib4.0.5. Coordinator разрешил только эти два UI dependency pins; frontend изменил только web manifest, foundation выполнил единственный root install/lock update. Установлено22 packages, audited485,0 vulnerabilities на этом запуске. Проверка конкретных UI/types/bundle остаётся частью QA gate, а не следует из npm metadata.

`elkjs`0.12.0 (`EPL-2.0 OR GPL-3.0-or-later`) остался исследованной альтернативой; он не установлен. Git master/pre-release metadata не подменяет опубликованный stable artifact. Новые graph/Gantt зависимости этим контрактом не разрешаются.

- [React Flow package/license](https://github.com/xyflow/xyflow/blob/main/packages/react/package.json), [MIT file](https://github.com/xyflow/xyflow/blob/main/LICENSE): кандидат renderer для уже выбранной архитектуры. Dependency commands, даты, доступ и циклы остаются domain/API, не библиотечными callbacks.
- [Официальная accessibility документация React Flow](https://reactflow.dev/learn/advanced-use/accessibility): есть node/edge focus, keyboard selection, arrow movement, localized ariaLabelConfig. Это основание сохранить штатные возможности и добавить явные формы связей/дат, а не объявить готовую WCAG-проверку Workloom.
- [Официальный layout обзор](https://reactflow.dev/learn/layouting/layouting) отделяет renderer от внешней раскладки. Dagre проще для небольшого плоского directed graph; documented subflow limitation важна при связях наружу nested subflow. Предлагается сначала плоская раскладка, без ложного parent nesting.
- [Dagre repository](https://github.com/dagrejs/dagre), [MIT](https://github.com/dagrejs/dagre/blob/master/LICENSE): выбранный узкий P4a layout adapter; версия закреплена, конкретный bundle/types проверены текущим gate. UI direction и node dimensions заданы явно; layout не scheduling engine.
- [ELK package metadata](https://github.com/kieler/elkjs/blob/master/package.json), [EPL-2.0 text](https://github.com/kieler/elkjs/blob/master/LICENSE.md): альтернативный кандидат для более сложного layout/ports/routing. Его declared license отличается от MIT; не называть MIT и не включать автоматически. Выбор конкретного artifact/license и distribution notices принимается до install; draft не даёт юридического заключения.

Собственный узкий calendar timeline использует существующие React/CSS/date contracts. Коммерческий Gantt engine, d3 force simulation и иные graph dependencies сейчас не нужны и не одобрены.


## 11. Владение и приёмка

Foundation: exact contracts/domain/DB/migration0007 и единственный root install/lock owner. Backend: thin9 API adapters/composition/transport tests. Frontend: card/graph/personal layout UI и packages/ui. QA: real PG concurrency/integration/browser/visual. Публичные exports были опубликованы до persistence; lanes реализовали один frozen каталог.

Широкий core/API/worker gate — 998 tests/49 files, real HTTP/PG — 163 tests/15 files; build/lint/typecheck прошли. Последующие frontend reset/automatic-bounds/async-arrange исправления имеют отдельные текущие web/targeted доказательства: финальный desktop1/1 и предшествующий mobile1/1 прошли, root принял текущие visuals. Первоначальные browser/fixture failures не переименовываются в pass; итоговые точные web/browser counts и asset parity записаны отдельно в журнале.

Миграция0007 сохранила все47 старых таблиц по исходным колонкам,13 настоящих cached command rows/hashes/results и четыре nested pinned report SQL документа; предыдущие14 SQL/snapshot файлов и journal prefix не изменены. Применена только0007, повторный запуск пустой. Fresh install содержит51 таблицу, isolated Drizzle не даёт diff. Эта проверка не сертифицирует старый browser bundle, private ACL, production hosting или полный P4/MVP.

Generated auto-layout на500 узлах проверяется отдельно: только автоматически вычисленные координаты при необходимости центрируются/равномерно масштабируются в разрешённый диапазон. Уже сохранённые и пользовательские координаты не нормализуются. Pending automatic calculation блокирует Save/reset/discard/move; успешная full replacement погашает отправленное reset intent. Эти UI исправления не меняют tasks, даты, планы или факты.

[P4b](18-p4b-contract.md) принят отдельно как bounded manual-date/Gantt/overlay срез; его доказательства не приписываются прежнему P4a gate. Pointer drag/resize, automatic scheduling и historical topology остаются deferred.
