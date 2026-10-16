# P4: зависимости, календарные даты, Gantt и граф — проект контракта

Статус: **draft для ревью, 16 октября 2026 года; не разрешение на P4 implementation/install**. P3a проходит отдельный UI gate; P3b остаётся следующим этапом реализации. Этот документ сокращает подготовку последующего P4. Владение новым draft — foundation lane; contracts/domain/DB/API/web не менялись. Автор — Codex gpt-6.1-sol high в согласованном fallback после фактического лимита Claude, без новых Claude-проб.

Основания: [продукт](01-product-spec.md), [границы архитектуры](02-architecture.md), [domain §12](03-domain-and-data.md), [P4.1–P4.4](06-implementation-plan.md), [baseline P2a](13-p2a-contract.md), [meeting guards P3a](15-p3a-contract.md). Имена DTO/маршрутов ниже предложены, пока не существуют; точный freeze и migration owner назначаются после отдельного GO.

## 1. Ограниченный результат и порядок

Одни и те же TaskDependency edges видны в карточке, графе и Gantt. A блокирует B, B блокирует C; C→A отклоняется сервером, в том числе при конкурентных командах. Фильтр по человеку или статусу не превращает заблокированную задачу в свободную. Часы WorkPackage и личные commitments не превращаются в календарную длительность.

Предложенная последовательность: P4a — edges + карточка блокировок + обычные start/due dates + ручной Gantt preview/apply; P4b — React Flow, локальная auto-layout preview и персональное сохранение координат. Это внутренние срезы одного P4, не утверждение готовности полного MVP.

В объёме один тип finish_to_start без lag, автоматического каскадного reschedule, resource levelling, critical path, рабочих смен/праздников, percent-complete по часам или платного scheduling engine. Parent tree, package lineage и dependency — разные отношения. Граф не превращает задачу в копию, а линия зависимости не переносит план или факт.

## 2. Workspace, проекты и доступ

Сохраняется явное решение domain §12: endpoints могут принадлежать **разным проектам одного workspace**. Add/remove/restore требуют текущий task.read/task.edit на обоих концах. Cross-workspace всегда404 без раскрытия чужой задачи. Same-workspace несовместимая сущность или self-edge —422. Не ограничивать модель одним проектом только потому, что graph открыт из project page.

Текущий продукт workspace-visible; это не реализация будущих private ACL. При их появлении reads/commands обязаны заново проверять обе стороны. Filter-hidden endpoint, который доступен actor, можно раскрыть по отдельному действию «Показать блокирующую задачу». Недоступный endpoint нельзя раскрывать через ID, название, координаты, число приватных blockers или старый baseline. Нейтральный признак и право видеть его требуют отдельной разрешённой политики; P4 не обещает частную видимость заранее.

Project graph/timeline показывает текущий проект, а разрешённые межпроектные соседи помечаются явно. Права и blocking вычисляются сервером по полным source edges, не только по загруженным узлам/строкам. Cursor/access epoch/current actor входят в cache scope; denied refetch прячет старые данные до recovery.

## 3. Одна модель edges и конкурентный цикл

`TaskDependency = {id,workspaceId,predecessorTaskId,successorTaskId,type:'finish_to_start',state:'active'|'removed',revision,createdAt,updatedAt}`. FK `(workspaceId,taskId)` связывают каждый конец; CHECK predecessor<>successor и UNIQUE(workspace,predecessor,successor,type). Soft removal сохраняет ID и историю, повторное включение — explicit restore с expectedRevision, а не новая строка.

POST create использует expectedAbsent:true и серверный ID. Уже active/removed natural identity даёт409, кроме exact-key replay; UI читает существующую запись и использует её guarded update. PATCH принимает expectedRevision и state active/removed. Same-state no-op проверяет revision, но не создаёт вторую domain revision/event. Key hash включает оба endpoint при create и path ID при update; текущие права проверяются перед stored replay.

Для create/restore active edge общий workspace barrier удерживается до commit. После lock читается текущий граф и проверяется путь successor→predecessor по **всем active edges workspace**, включая другие проекты, archived tasks и узлы вне UI-фильтра. Путь означает cycle422. A→B и B→A в двух реальных PG transactions не могут обе пройти. SQL recursive query хранит visited IDs/использует UNION, чтобы уже повреждённый граф не вызывал бесконечный обход; лимит UI не является лимитом проверки цикла.

State + dependency revision/audit + outbox + idempotent result атомарны. Ни React Flow callback, ни importer/MCP/job не обходят эту команду. Unexpected late failure откатывает все эффекты; accepted cutoff/materialization guard outcomes сохраняют общий tagged protocol. Никакого каскадного удаления edges при архивировании задачи или удалении из фильтра.

## 4. Что означает «блокирует»

Предложение для первого среза: versioned project policy successor-проекта `{mode:'warn'|'enforce',revision}`, default warn. Owner/admin меняет mode отдельной audited командой с expectedRevision. Организатор встречи/ответственный не получает отдельного bypass.

Unresolved predecessor = его status group не done. Cancelled без done и archived без done **не снимают** блокировку; UI показывает состояние и предлагает явное разрешение/удаление edge. Архивный done остаётся resolved. Смена статуса predecessor пересчитывает current blocker projection; edge при этом не переписывается. Meeting Done не создаёт attendance и не подменяет этот статусный сигнал подтверждённым фактом.

В warn режиме переход successor в in_progress/done разрешён с видимым предупреждением. В enforce новая фактическая смена successor в in_progress/done при unresolved predecessor отклоняется422 до task writes; task.update через API/domain/MCP следует той же проверке. Metadata-only update или same-status no-op не блокируются. Добавление/restore unresolved edge к уже in_progress/done successor в enforce отклоняется; переключение policy не переписывает старые статусы, а явно показывает существующие violations. Снятие edge требует обе стороны и оставляет audit.

`BlockingProjection` возвращает canStart/canComplete, mode, known accessible blockers и указание внешних для текущего rendering window связей. Нельзя выводить «нет blockers» из отсутствия edge на странице. Полный список accessible blockers — cursor paginated; drawer и граф используют один источник. При будущей private ACL допустимый нейтральный restricted indicator определяется отдельно, без secret counts.

## 5. Календарные даты отдельно от effort

У ordinary Task появляются nullable date-only `startDate` и существующий `dueDate`: настоящие YYYY-MM-DD, не UTC midnight. Обе заданы → startDate<=dueDate. Due inclusive: диапазон одной даты — один календарный день. Нет смены дат из-за browser/workspace timezone; ось Gantt оперирует календарными датами. Усилие estimateMinutes и weekly plannedMinutes не меняется при drag/resize.

Fresh task reads возвращают startDate:null при отсутствии. Старый stored TaskDto без нового поля остаётся валиден: addition optional **без default** на historical output boundary; omitted old task input/default/hash остаётся прежним. Generic input принимает startDate лишь при явном изменении, без новых defaults. Raw old task.create/update replay проверяется populated upgrade proof. Для meeting start/due на ordinary Gantt не записываются: открывается guarded meeting editor; дата/UTC occurrence и schedule lock P3 сохраняют единственный источник.

Полный диапазон рисуется только при двух датах. Due-only или start-only — помеченный endpoint/«нет начала»/«нет срока», без выдуманной длительности. Обе null — отдельная группа «Без дат», а не исчезновение задачи. Hours не переводятся в дни по условному восьмичасовому дню. Daily worklog precision не появляется от наличия полосы Gantt.

Finish-to-start здесь означает статусную зависимость и календарное предупреждение: если у predecessor известен due и у successor start, successor start<=predecessor due — date conflict (due inclusive); иначе comparison unknown при missing dates. Сервер не «исправляет» даты автоматически и не объявляет отсутствие dates доказательством календарной совместимости.

## 6. Ручной Gantt preview/apply

Drag только готовит явную правку и показывает old/new start/due, affected task IDs/revisions, текущие policy/date conflicts, protected meeting/field impacts. Numeric inputs и кнопки сдвига на день дают тот же путь без drag. Пользователь видит, что изменение относится к выбранным задачам, а не ко всей dependency chain.

`SchedulePreviewInput = {rows:[{taskId,expectedRevision,startDate:null|date,dueDate:null|date}]}` —1–100 уникальных IDs одного project path. Read-only preview ничего не меняет и не freeze. `SchedulePreviewDto` содержит server previewHash и полную desired/source manifest: actor/access epoch, target task revisions/dates/meeting identity, relevant edges + endpoint statuses, successor policy revision и применимые locks/materialization state. Поздний endpoint/policy/date/grant change делает preview stale.

Apply принимает тот же desired payload + previewHash, keyed. Под workspace barrier заново проверяются current access, полный hash и обычные task/domain guards; все строки атомарны. Не вызывать public updateTask в цикле с отдельными transactions. Один protected meeting или stale row отклоняет всю proposed batch. Cutoff/materialization обязаны сохраняться через общий **pre-handler** typed outcome; нельзя ловить late error после частичных task writes. Source footprint включает затронутые проекты связей, не угадывается по одному viewport.

True no-op не поднимает task revision. Apply не меняет статус, participants, parent, package, estimate, allocation или worklogs. Даже если дата нарушает finish-to-start relation, warn policy сообщает конфликт без auto cascade; enforce date behavior надо отдельно утвердить (предложение P4a: enforce ограничивает статусный переход, даты остаются ручными с предупреждением).

## 7. Baseline overlay с происхождением

Overlay выбирает **конкретный immutable baselineId**, показывает scope self/project, periodId, frozenAt и источник снимка. Используются task dates из snapshot.tasks этой фиксации, не current task join. Старый snapshot без startDate означает `not_captured`, explicit null — `not_set`; задача вне snapshot — `not_in_baseline`. Не дополнять пробелы нынешними датами или старым полным package estimate.

P2a сохраняет только связанные с реальными commitments задачи; overlay не утверждает, что покрывает весь проект. Personal→project composition сохраняет ранее принятое earliest numeric changeSeq source policy. Compare current/old labels и dates с явным provenance; archived/current access проверяется при каждом чтении baseline. Нет общего «последнего baseline проекта» без выбора/label.

Если P4 требуется historical topology, новая snapshot section dependencies optional/no-default сохраняет точные edge revision/state/endpoint IDs в момент freeze. Старые snapshots показывают «связи тогда не фиксировались». Current graph edges не выдаются за historical ones. Эта additive section и cross-project access projection требуют отдельного contract freeze до реализации; дата overlay может работать независимо.

## 8. Граф и позиции

React Flow рендерит те же task IDs и dependency IDs. Selection открывает обычную задачу; создание/удаление связи вызывает domain edge commands. Delete node на canvas не удаляет задачу: это либо запрет, либо явная настройка представления с отдельной подписью. Parent nesting графа не меняет Task.parentTaskId и не создаёт lineage.

Первый layout — плоский directed graph с фиксированными известными dimensions узла, без nested subflows. Auto layout — локальная deterministic preview, async completion привязано к graph query/source version; поздний результат для старого actor/project не применяется. «Сохранить раскладку» — отдельная keyed команда, не дата/task.update. Новые данные не запускают молчаливое пересохранение всех позиций.

Предложение: персональный GraphLayout по `(workspace,project,membership,viewKey:'default')`, independent revision, positions `{taskId,x,y}` (finite bounded coordinates). Это узкий saved layout, не полный SavedView/filter builder. Server не принимает произвольные React node data/HTML/component IDs/JS. Existing positions retained при фильтре; explicit reset затрагивает только разрешённый layout. Другой member не меняет эту раскладку; общий layout — отдельное решение.

Layout writes проверяют current allowed task IDs, expected revision и actor scope. После ACL change старые position rows не раскрываются автоматически. Node move/arrow move меняет только координаты; проверить неизменность task/date/package/plan/fact histories. Локальное состояние до сохранения и uncertain payload/key переживает drawer/filter переключение по уже принятому command lifecycle; reload/departure предупреждает, durable offline queue не обещается.

## 9. Ограниченные чтения и предлагаемый каталог

Task list остаётся единственным task filter engine. Timeline берёт его stable paged rows + schedule/blocking/baseline projection; full-period/report totals из загруженных полос не считаются. Range query не исключает undated tasks молча: отдельная явная paged группа.

Graph read задаёт project,1–100 rootTaskIds и neighborDepth0–2. Server возвращает полный разрешённый induced neighborhood этого bounded запроса: max500 nodes/1000 edges; превышение — явный422 «сузьте выбор», не молчаливый cap. Эти bounds не ограничивают cycle/blocker checks. На node остаётся server blocking flag для внешних к rendering window связей; accessible blockers можно раскрыть страницами. Подпись UI — «граф выбранного набора», не весь workspace. Strict CSV wire query и отдельный normalized-array domain schema исключают повторный parse преобразованного запроса.

Предложенные маршруты под `/api/v1/workspaces/:workspaceId`:

| Метод/путь | Назначение |
| --- | --- |
| GET `/dependencies` | projectId/taskId scoped filter, direction, state, signed cursor |
| POST `/dependencies` | predecessor/successor/type/expectedAbsent;201 |
| PATCH `/dependencies/:dependencyId` | expectedRevision,state active/removed;200 |
| GET `/tasks/:taskId/blocking` | authoritative current policy/blocker projection + cursor |
| GET/PATCH `/projects/:projectId/dependency-policy` | current owner/admin policy + expected revision |
| POST `/projects/:projectId/schedule-preview` | read-only desired dates/source hash |
| POST `/projects/:projectId/schedule-apply` | same desired rows + hash; atomic keyed apply |
| GET `/projects/:projectId/timeline` | bounded stable task/date/blocking/baseline projection |
| GET `/projects/:projectId/graph` | bounded authorized root neighborhood, source version |
| GET/PATCH `/projects/:projectId/graph-layout` | actor-personal position projection/guarded save |

Read-only POST preview keyless + Origin; mutations keyed, trusted context first, normal envelopes/errors. Cursor binds actor/workspace/permission epoch/filters; consistent read captures source changeSeq. DTO/ports and exact routes remain proposals until P4 GO. No API/code/install is authorized by this table.

## 10. Клавиатура и small screen

Карточка предоставляет обычные searchable task selects для «Блокирует»/«Зависит от» и кнопки add/remove: соединение handles мышью не единственный путь. Все эти операции проходят те же guards. Graph nodes/edges focusable; Enter/Space selection, явный button открыть задачу, Escape снимает selection, видимый focus. Arrow move узла не запускает изменение даты; кнопки zoom/fit и русские accessible labels работают отдельно от task edits.

Gantt имеет текстовые поля start/due и доступный список rows с теми же данными; drag/resize — дополнительный способ подготовить preview. Pointer pan не захватывает навигацию клавиатуры или ввод в форму. Hidden/archived blocker остаётся виден в карточке статуса блокировки. Mobile может открыть list/date editor вместо тесного canvas; это не выдаётся за пройденный desktop drag flow.

Library keyboard support — только примитив, не готовая сертификация приложения. Реальные Tab/focus/move/connect альтернативы, screen-reader labels, 390px drawer и pending/uncertain navigation требуют browser tests и визуальной проверки.

## 11. Dependency research — только первичные источники

Проверено 16 октября 2026 года, без install/lockfile mutation. Official npm registry (`npm view`) на момент проверки: `@xyflow/react`12.12.0 MIT (React/ReactDOM peer>=17), `@dagrejs/dagre`3.1.1 MIT, `elkjs`0.12.0 с package SPDX `EPL-2.0 OR GPL-3.0-or-later`. Git master elkjs уже0.13.0, dagre3.1.2-pre: branch metadata не выдаётся за опубликованный stable version. Перед будущим install повторно проверить registry/tarball/license/React19 types и зафиксировать точную версию lockfile; этот draft не устанавливает ни одну библиотеку.

- [React Flow package/license](https://github.com/xyflow/xyflow/blob/main/packages/react/package.json), [MIT file](https://github.com/xyflow/xyflow/blob/main/LICENSE): кандидат renderer для уже выбранной архитектуры. Dependency commands, даты, доступ и циклы остаются domain/API, не библиотечными callbacks.
- [Официальная accessibility документация React Flow](https://reactflow.dev/learn/advanced-use/accessibility): есть node/edge focus, keyboard selection, arrow movement, localized ariaLabelConfig. Это основание сохранить штатные возможности и добавить явные формы связей/дат, а не объявить готовую WCAG-проверку Workloom.
- [Официальный layout обзор](https://reactflow.dev/learn/layouting/layouting) отделяет renderer от внешней раскладки. Dagre проще для небольшого плоского directed graph; documented subflow limitation важна при связях наружу nested subflow. Предлагается сначала плоская раскладка, без ложного parent nesting.
- [Dagre repository](https://github.com/dagrejs/dagre), [MIT](https://github.com/dagrejs/dagre/blob/master/LICENSE): предпочтительный кандидат узкого P4b layout adapter после версии/типов/bundle proof. UI direction и node dimensions заданы явно; layout не scheduling engine.
- [ELK package metadata](https://github.com/kieler/elkjs/blob/master/package.json), [EPL-2.0 text](https://github.com/kieler/elkjs/blob/master/LICENSE.md): альтернативный кандидат для более сложного layout/ports/routing. Его declared license отличается от MIT; не называть MIT и не включать автоматически. Выбор конкретного artifact/license и distribution notices принимается до install; draft не даёт юридического заключения.

Собственный узкий calendar timeline использует существующие React/CSS/date contracts. Коммерческий Gantt engine, d3 force simulation и иные graph dependencies сейчас не нужны и не одобрены.

## 12. Приёмка и решения до GO

1. A→B→C читается одинаково в карточке/графе/Gantt; C→A/self/foreign запрещены. Два реальных PG writers A→B/B→A: ровно одна новая связь, без второго audit/outbox/key-success. Remove/restore сохраняют ID, restore заново проверяет цикл.
2. Cross-project разрешённая связь в одном workspace работает; другой workspace404. Фильтр/архивирование unresolved predecessor не снимает blocker; hidden allowed endpoint раскрывается явно. Future ACL tests отдельно, не выдуманный private pass.
3. Warn/enforce guards действуют при direct domain/API task status update и через будущие transports; same-status/metadata no-op допустимы. Policy change audited, старые statuses/history не переписываются.
4. Start/due null/one endpoint/same day/reversed range; смена browser zone/DST не меняет date-only значения. Drag estimate120 не превращает его в days, move node не меняет dates/effort. Meeting task направляется в meeting editor и не обходит schedule locks.
5. Manual date preview→task/edge/policy/ACL race даёт409; mixed valid/protected batch оставляет все proposed dates прежними. Lazy cutoff/materialization сохраняет только разрешённый typed outcome; unexpected late outbox failure откатывает весь proposed state.
6. Overlay old snapshot missing startDate честно not_captured; null not_set; missing task not_in_baseline. Current date edit не переписывает pinned overlay; current task joins не заполняют историю. Selected personal/project provenance виден.
7. Graph bounds дают422 без silent truncation; root neighborhood/counts не объявляются всем workspace. Out-of-window blockers остаются через server projection. Набор >100 IDs не превращается в произвольный SQL; signed cursor связан с фильтром.
8. Personal coordinates survive reload, independent layout revision conflict409; same actor uncertain retry exactkey, actor/workspace switch не раскрывает старый canvas. Root/detail/tag/participant не создают дубликаты task nodes и факта.
9. Upgrade сохраняет старые task input/hash/replay/old pinned JSON и старую колонковую проекцию; nullable startDate/new snapshot sections без backfill. Old-tab compatibility — отдельный P6 gate, не следствие optional schema.
10. Browser: keyboard add/remove edge + pointer graph; accessible date inputs + optional drag preview; filter-hidden blocker; one-node position save; baseline overlay; desktop и390px отдельно. Production deploy, private Auth и worker hosting этим не сертифицируются.

До source нужны решения координатора: подтвердить cross-project правило из domain, warn default/status-only enforce, персональный layout scope, graph bounds и additive baseline topology. Затем exact DTO/ports freeze → один migration/domain владелец → тонкие API/web → real PG/concurrent/browser/visual gates. P3b остаётся ближайшей реализацией; этот документ не меняет последовательность.
