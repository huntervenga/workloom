# Журнал активного прогона

Краткий рабочий ledger текущего непрерывного прогона реализации; должен пережить сжатие контекста. Это не журнал доказательств: факты проверок, команды и происхождение — только в [11](11-implementation-progress.md), этапы и приёмка — в [06](06-implementation-plan.md) и [07](07-verification-and-pilot.md). Сам этот документ новых проверок не заявляет.

## Рамки

- Старт: `2026-10-15T23:18:10Z`; жёсткий конец: `2026-10-16T07:18:10Z` (10:18 по Кипру; 8 часов). Точные значения уточнены root, не сдвигать. Остановка — по дедлайну или по команде пользователя, с отчётом о фактически сделанном и оставшемся.
- Пользователь разрешил непрерывный прогон через родительского координатора. Лимит времени управляет работой, но не разрешает deploy, публикацию, внешние сообщения, платные сервисы, смену секретов или разрушительные операции с данными.
- Root координирует, специалисты выполняют только свою зону и сохраняют исходники, demo-данные и историю. Каждый пригодный вертикальный срез проходит gate и локальный checkpoint, затем root назначает следующий.

## Политика моделей

**Текущее явное указание пользователя после P4a checkpoint: только Codex `gpt-6.1-sol` high и агенты этого семейства до нового указания. Автоматического возврата к Claude и probes на reset нет.** Исторические Opus runs, фактические quota events и прежние переключения ниже сохраняют исходную атрибуцию; прежняя политика возврата больше не действует.

- Историческая политика до нового указания: предпочтительно Claude Code CLI `--model opus --effort high`; фактическую resolved-модель записывать для каждого запуска (предыдущая — `claude-opus-5-5`).
- Историческое правило: fallback на Codex `gpt-6.1-sol` high — только при фактическом исчерпании квоты и до reset провайдера. Fallback глобально координирует root; агенты сообщают фактическое событие квоты и время reset, недоступный Claude повторно не дёргают.
- Историческое правило возврата: в самое раннее подтверждённое провайдером время reset — ОДНА ограниченная проба, затем root рассылает возврат. Предполагаемый reset не основание.
- Свежее подтверждённое провайдером `rate_limit_event` в этом прогоне (источник — root/foundation; то же фактическое событие наблюдал QA), статус `allowed`: `five_hour` utilization 0.75, reset `2026-10-16T02:50:00Z` (`1792119000`); `seven_day` 0.40, reset `2026-10-16T04:00:00Z` (`1792123200`). Ранее наблюдавшийся `1792119000` теперь подтверждён свежим событием, а не только исторический. Это исходное разрешённое событие; позже квота фактически исчерпана — переход указан ниже. Это историческое исходное событие; текущий выбор пользователя указан выше.
- Без автоматической оплаты, покупок и bypass permissions. Вымышленные исторические переключения не записывать.
- Частичный Claude-код сохраняется: HTTP acceptance session `d6fcb3e9-e3fa-4fb3-97c2-98f74c4506b3` успела записать `tests/integration/support/p1b.ts` и `tests/integration/p1b-fields.test.ts` перед следующим quota rejection; отдельная policy-сессия остановилась по квоте до записи. Последующее авторство Codex записывать отдельно; в окне fallback до reset новых Claude-запусков не было (историческое утверждение).
- Возврат: root подтвердил фактический успешный ограниченный Claude-запуск `2026-10-16T02:50:16Z`, `--model opus --effort high` → `claude-opus-5-5`. В том историческом окне предпочтительная модель снова Claude; resolved-модель по-прежнему записывать для каждого запуска. Фактическим началом возврата остаётся этот запуск root.
- После возврата было разрешённое окно Claude. Затем root подтвердил фактическое исчерпание в 03:36–03:39 UTC; QA также получил `rejected`, `five_hour` 1.01/reset `2026-10-16T07:50:00Z` (`1792137000`), `seven_day` 0.51/reset 04:00 UTC. Reset позже конца прогона: текущая модель авторства — Codex `gpt-6.1-sol` high, новых Claude probes до дедлайна нет.

| Время UTC | Модель | Статус | Фактическая причина | Reset | Возврат |
| --- | --- | --- | --- | --- | --- |
| 2026-10-15T23:18:10Z | Claude Code CLI, opus (`claude-opus-5-5`) | исходная, предпочтительная; сначала `allowed` | исходное свежее событие root/foundation и QA | `five_hour` `02:50:00Z`, `seven_day` `04:00:00Z` | см. следующий переход |
| 2026-10-15T23:37:38Z (время записи подтверждения) | Codex `gpt-6.1-sol` high | исторический временный fallback, подтверждён root; завершён возвратом | фактический Claude `rate_limit_event`: `rejected`, five_hour 1.0; ответ «You've hit your session limit», QA session `193b2f21-1f53-4de6-be13-4fa3be70a65f`, exit 1 | провайдер подтвердил `2026-10-16T02:50:00Z` (05:50 Кипр), seven_day 0.43/reset 04:00 UTC | возврат `2026-10-16T02:50:16Z` после одной ограниченной пробы root, см. следующую строку |
| 2026-10-16T02:50:16Z | Claude Code CLI, `--model opus --effort high` (`claude-opus-5-5`) | историческое разрешённое окно после reset; завершено следующим fallback | фактический успешный ограниченный запуск после подтверждённого reset | — | выполнен; root разослал возврат |
| 2026-10-16 03:36–03:39 UTC (подтверждение root; QA также rejected) | Codex `gpt-6.1-sol` high | исторический fallback, затем явный текущий выбор пользователя | фактический Claude five_hour 1.01; QA follow-ups 9968/2540 exit 1 до записи, прежние Opus-файлы сохранены | `2026-10-16T07:50:00Z`, позже deadline 07:18:10 | в этом прогоне не запланирован |

Текущий выбор после P4a: Codex `gpt-6.1-sol` high по прямому указанию пользователя. Подтверждённый provider reset07:50UTC остаётся историческим фактом и не запускает ни probe, ни автоматическую смену модели.

## Исходный checkpoint

- Source A: `cf586b324a22dd2f77336c2fd6657f87b94c3f1f`; docs-only B: `5a398228648e314b7cde5825253a0b1e264dcfc1`.
- Локально проверены P0 и ограниченный P1a. Исторический широкий gate: integration 65, core/API 271; последний: web 75, browser 8 и просмотр координатором 4 текущих изображений после правки 3 файлов layout. Counts раздельные и не суммируются; детали — в [11](11-implementation-progress.md#текущий-статус-по-областям).
- Не сделано: полный P1, MVP, общий Auth, приватные ACL, worker, календари, deploy, обновление старых вкладок.

## Среда

- Нативный PostgreSQL 17.5 на loopback `55432`, базы dev и test раздельны; синтетические credentials — только в игнорируемом `.env` или метаданных `/tmp`, сюда их не записывать.
- API `4310` — текущая скомпилированная сборка с локальной dev identity, `NODE_ENV=production`; Vite — `4311`. Demo-проект «Запуск команды Workloom» сохранять; migration, drop и seed на посторонней БД не выполнять.
- Перезапуск runtime и заморозку кода не предполагать до согласованного gate.

## Текущий checkpoint и следующая работа

| Зона | Владелец |
| --- | --- |
| contracts, domain, db; единственный владелец migration | foundation |
| HTTP API | backend |
| web и UI | frontend |
| корневые integration/e2e, docs 11, `docs/README.md`, docs 12 | QA |

- DTO, маршруты и ports P1b заморожены; перед следующим срезом снова согласовать контракт между владельцами.
- Принятый bounded scope: 9 типов custom fields ([06 P1.4–P1.5](06-implementation-plan.md#p1-таблица-задач-и-дополнительные-поля)), настройки полей проекта, ревизии значений и выборочная история; ручная блокировка custom field (`locked`) подтверждена в контракте; она отдельна от недельного baseline P2.
- Приёмка, реальный PostgreSQL: persist, rollback, replay, tenant safety; стабильные IDs options и сохранение при архиве; валидация типа; null отличается от 0; история с момента включения, отключение не удаляет записанное; блокировка действует во всех каналах; конфликт параллельных ревизий.
- Приёмка, реальный browser: создание поля, правка, перезагрузка, история — desktop и mobile.
- Bounded P1b принят root после исправления 3 визуальных findings. Source checkpoint `dee59bae06be4505b4a60e0bf469d31c8816aeda`; отдельный docs-only provenance commit `67ca7d47ca8ca456300c5d85550d2b5a01efa47d`, после каждого дерево было чистым. Раздельные факты gate — только в [11](11-implementation-progress.md#текущий-статус-по-областям). Полный P1/MVP не завершён.
- Root выпустил P2a: foundation сначала фиксирует DTO/ports/routes и `docs/13`; QA пишет приёмку после frozen shape, frontend/backend работают по тому же контракту. Контракт [13](13-p2a-contract.md) заморожен; Ограниченный P2a реализован и принят локально. Core/API, реальный PostgreSQL и финальный web/browser gate завершены; точные раздельные результаты — в11. Координатор принял bounded P2a после timezone correction и просмотра4 текущих кадров; source checkpoint `fd69f3748a8538ad45e9480c0cfecd70ad7e2c9c` и docs-only provenance `5f5e984715767d0435591b99a470ef764341215d` созданы, дерево сразу после каждого commit чистое. Runtime/build изменения только в согласованном окне.
- P2a acceptance: исходный vs недельный план, Worklog revisions и weekly precision, self/project freeze с source freshness, identity locks при missing rows и removal участников, auto-freeze commit+409 против неожиданного SQL rollback, current ACL при replay/чтении pinned reports и tenant isolation, дедупликация tags/participants. Split/replace/transfer/carryover/close сверх согласованного P2a остаются поздним P2, не pass.

## Последний checkpoint P2b

Root выпустил categories + quick entry по замороженному [14](14-p2b-contract.md). P2b source заморожен; core/API, реальные HTTP/PG и upgrade/replay gates прошли. Initial browser14:13 pass/1 QA fixture fail; после исправления fixture targeted2 pass. Координатор просмотрел все7 текущих кадров и принял bounded P2b; source checkpoint `5e46a8e4a50d747bd01a810dcc37a0506bc95e7c` и docs-only provenance `4777aefc98eaa233b75a3a42f6588a62d6f50aef` созданы, дерево перед provenance-правкой было чистым, раздельные факты в11. В момент P2b checkpoint compiled API82234/PID52278 работал на4310 после согласованного0004 upgrade; demo сохранены. Отдельная реальная pre0004 compatibility fixture создана через прежний API: exact raw `work.set` body/key/result, SQL hash/revision и pinned report JSON сохранены в `/tmp/workloom-p2a-compat-fixture.json`; это synthetic IDs/данные, credentials в файл не входят. После upgrade exact raw replay дважды прошёл без дублирования и без обогащения старого cached outcome; legacy90/correction120 и старый pinned JSON подтверждены в11. На момент этого checkpoint новых Claude-запусков не было, действовал fallback до reset02:50UTC (исторически).

## Последний checkpoint P3a

Root выпустил разовые workspace-visible meetings/attendance по [15](15-p3a-contract.md). Точные DTO/ports/source union заморожены; bounded P3a реализован и принят root. P3a не включает recurrence/worker/private ACL или внешние календари. Реально проверены: nominal budget300 при5×60, proposals без автоматического плана/факта, atomic posting210, unknown/absent0/void, independent attendance/worklog revisions после recategorization, planned_absence без выдуманного actual времени, explicit period/UTC/DST, generic bypass guards и единый report source reader. Первый focused realPG15:13 pass/1 product same-roster no-op failure/1 QA overlap fixture failure. Scoped semantic guard fix + fixture date correction дали targeted15/15 pass. Отдельный equivalent UTC instant case1 pass; затем stable core/API643/30 и полный real HTTP/PG120/12 pass. Это пересекающиеся gates, counts не суммировать. Populated upgrade и genuine raw3 HTTP replay прошли отдельно; fresh root build/lint/types и web157/29 pass. Initial browser16:14pass/2 QA locator failures; corrected targeted2 pass после ещё2 QA assumptions. Root выявил и frontend исправил attendance/plan draft cleanup по immutable submitted IDs, включая global retry. Current web161 до plan-only fix; final affected components30/2, build/types и targeted browser2/2 pass9,3с после QA close-transition sync. Root принял bounded P3a: visual8 pre-cleanup+4 current surfaces pass, final plan ownership callback и targeted browser2/2 pass9,3с. Source checkpoint `9443e063aba5b15eedb41b4ed6f4f43c68cf4baf` создан, дерево сразу после commit чистое; exact final HTML/JS/CSS parity pass; точные gates в11.

Genuine pre0005 P2b fixture уже создана через принятый API: `/tmp/workloom-p2b-compat-fixture.json` (0600, без credentials), exact task.create без будущего marker, work.set/categoryA/rev1 и work.recategorize/categoryB/rev2 raw keys/results/hashes, оба pinned report types JSON и старые SQL rows. По отдельному разрешению root quiet0005 upgrade выполнен:35 прежних old-column table digests неизменны,current6/repeat[]. QA exact raw3 HTTP replay и оба pinned report types подтвердил, unified manual90 без дублирования. Fresh P3a API32694/PID65721 ready200; финальный P3a SPA обслуживается с exact HTML/JS/CSS byte parity, latest JS index-B95BHm_Q.js. Functional и visual gates приняты root. Тогда действовал fallback Codex high без Claude probes до reset02:50UTC (исторически; возврат — в политике моделей); deadline 07:18:10UTC без сдвига.

## Последний checkpoint P3b

P3b по [16](16-p3b-contract.md) принят root после bounded functional/visual gates и финального served asset parity; source checkpoint `7441251470e32b47272a2031cdcf76e70c668a31` создан, дерево сразу после commit чистое. Core/API/worker и web заморожены. Раздельные точные результаты, initial failures и исправления — в [11](11-implementation-progress.md): core/API/worker919, web206, realPG147; первый browser18=17pass/1реальный CSS failure, corrected targeted2=2pass. Root принял desktop и исправленные390px frames; chronological UI sort — отдельный nonblocking follow-up после checkpoint.

- Quiet0006:40 старых таблиц по старым колонкам/cache/pinnedJSON неизменны,current7/repeat[]. Genuine pre0006 fixture с source9443e06 сохранена;7 exact raw replays и отсутствие будущих keys в старых cached outcomes подтверждены. Новый API session56168/PID6837 на4310, исходные demo сохранены.
- Все явно зарегистрированные bounded candidates готовятся без28-day horizon;≤366/series,≤100 реальных creates/chunk. Manual chunk возвращает signed cursor и не обязан ставить continuation; worker pending ставит его в том же UOW передACK. Typed recovery проходит независимо для двух overdue112 периодов; ordinary≤100 может закончить census/freeze перед proposed write, >100/blocked fail closed.
- Реальный worker7 в147 проверил transactional relay/poison isolation/ACK-loss/durable receipt/current grant/stale/pause/DLQ. Отдельно official queue lifecycle install/repeat/drift strict options. После controlled browser dev queue явно установлена; compiled entrypoint автоматически подготовил3 occurrences без плана/факта, healthok, SIGTERMexit0. Worker сейчас OFF; npmdev запускает только API+web.
- Reset planned-calendar seam реально red→green; required before/after preview и calendar-only sync сохраняют task metadata/actual/history. Модели: исходные Opus files сохранены; после actual03:36–39 quota действует Codex gpt-6.1-sol high. Reset07:50UTC позже жёсткого конца07:18:10UTC; новых probes нет.
- Следующий шаг назначает root после source checkpoint. Полный P3/MVP, Auth/private ACL, внешние календари и deploy не достигнуты. Последние15 минут прогона — стабильный checkpoint.

## Последний checkpoint P4a

P4a dependencies/blocking/personal graph layout по [17](17-p4-contract.md) принят root05:05UTC; source checkpoint `12f5dbd8c9d5af8c01070e0278ec1ec8fe499fe2` создан root05:06UTC, дерево сразу после commit чистое. Initial core998/PG163/allweb228 и lint/types/build pass; reset fix allweb230 pass. Initial browser20:18pass/2QAselectlocators; corrected2:mobilepass/desktoprealasync-arrange race; после fix18focused/types/lint/build и finaldesktop1 pass. Counts раздельные в [11](11-implementation-progress.md), одного зелёного20 не заявлять. Root принял mobile4/desktopblockers и final optimized4310 FitView; все6 served HTML/assets совпадают с dist, proof в11.

Quiet0007 proof:47 oldtables/cache13/4reportSQL preserved,current8/repeat[]. Genuine pre0007 fixture0600/source744125 и exact13raw replay/32scoped projections/5HTTP pinned docs unchanged. Runtime89940/PID15941 на4310 готов DB/schemaok; workerOFF, demo сохранены. Vite4311 transformedGraphView содержит новый arranging Save guard. Новых Claude calls нет: fallback Codex high до конца, reset07:50 позже deadline07:18:10. Последние15 минут — стабильный checkpoint.

## Последний checkpoint P4b

Root дал GO после source12f5dbd и docs-only48b138. Точный контракт — [18](18-p4b-contract.md): ordinary start/due dates, read-only bounded schedule review, atomic keyed apply и baseline overlay без подстановки текущих дат. Functional candidate прошёл build7/lint/types, core1059/53, web252/46, actualHTTP/PG175/16 и полныйbrowser22/22. Root просмотрел все6 текущих кадров и принял boundedP4b; source checkpoint `2d885a9f3c6834dff796779a74b739d31d73cd38` создан root, дерево сразу после commit чистое. Quiet0008 уже выполнен:51oldtables/21cache/6baselineSQL+6reportSQL preserved,current9/repeat[]. Fresh API40855/PID23140 на4310 и финальнаяP4bSPA совпадают с dist; workerOFF. Работает только Codex gpt-6.1-sol high по текущему указанию пользователя; Claude не вызывать автоматически.

Genuine pre0008 fixture `/tmp/workloom-p4a-compat-fixture.json` (0600/source12f5dbd) снята через принятый API: ordinary TaskDto/create/update и personal/project baseline без startDate, dueDate2027-01-16 captured;1200whole/360weekly/300fact/−60, оба report types pinned.8 новых raw/cache commands +13 nested старых =21;34 old-column scoped projections сохранены. Начальная setup-попытка manual expectedRevision0 получила400; исправлена на контрактныйnull, отдельная fixture успешна. Это QA предположение, не product failure. Post0008 exact21raw/cache replay,34scoped old-column sets и4HTTP pinned docs pass; обе genuineстарые baseline показывают startDate not_captured и dueDate set2027-01-16. FreshTask startDate:null, oldcachedTask propertyabsent. Capture framing исправлен GET/UI-scroll-only без source change; initialframes сохранены. Полный P4/MVP/Auth/privateACL/production не достигнуты.

## Последний принятый P5a

Root дал source GO05:34UTC после P4b source2d885a9/docs0fcb7bd. Ограниченный CSV-only50 DATA ROWS/five-operation catalog — [19](19-p5-import-contract.md). Shared in-scope primitives прошли ранний31-case stop gate; первый realHTTP/PG15/15 pass32,01с. После web source freeze05:57UTC QA broad gate: build7/lint239/types pass, core/API/worker1119/56, web265/51, PostgreSQL190/17, fullbrowser24/24. Counts отдельно, не сумма.

Root visual первых6 кадров нашёл только mobile reconciliation сжатие текста; one-file CSS fix, owner types/lint pass, QA webbuild+targeted2/2 pass6,4с. Root просмотрел ровно2 replacement reconciliation06:09UTC и принял boundedP5a, остальные4 исходных состояния уже приняты. Финальная optimizedSPA и6assets200/MIME/exactdist06:09:03UTC; `/tmp/workloom-p5a-final-asset-parity.json`. Source checkpoint ожидается; точные evidence/logs/images в [11](11-implementation-progress.md#p5a--широкий-gate-и-визуальная-правка).

Genuine pre0009 `/tmp/workloom-p4b-compat-fixture.json`0600/source2d885a9:9raw+21nested=30cache,34scopedoldcolumns; baseline11→16January2027/current12→18,1200whole/360plan/300fact/−60. Quiet0009 только additive migration:51oldtables/30cache/12baselines+8reportSQL/18oldfiles preserved,current10/repeat[]. FreshAPI36256/PID30886 readinessDB/schema, raw30/34sets/4HTTPpinneddocs exact; workerOFF. Static web теперь текущий compiledP5a, Vite4311 source соответствует. Только Codex gpt-6.1-sol high; Claude calls/probes нет. Настоящий user export/Asana OAuth/live sync/fullMVP/Auth/privateACL/deploy не разрешены этим срезом. MCP docs20 остаются draft и исключаются из P5a checkpoint до отдельного GO. Deadline07:18:10UTC неизменен, последние20минут — стабильный checkpoint.

## Матрица P2a и оставшиеся границы

Срез назначил root, замороженный контракт — [13](13-p2a-contract.md). Ограниченная приёмка по [06](06-implementation-plan.md#p2-недельный-план-факт-и-первые-отчёты) и [07](07-verification-and-pilot.md#инварианты-модели-и-истории): immutable baseline против факта, added scope, carryover, allocations, missing отличается от 0, недельная точность, без смещения к завершённой когорте. Core/API, реальный PG и web/browser gate выполнены; bounded P2a принят координатором, source checkpoint `fd69f3748a8538ad45e9480c0cfecd70ad7e2c9c` создан, дерево сразу после commit чистое. Carryover/transfer/close и explicit late estimate acceptance остаются поздним P2, не pass. P2b теперь означает только categories + quick entry по [14](14-p2b-contract.md), ограниченный срез принят локально, доказательства в11. Post-freeze новая работа остаётся разрешена, но server-derived added/unplanned относительно immutable personal/project baseline; detail child суммируется по тому же package, added_scope отдельно. Выбранное missing value/estimate блокирует identity даже без строки значения, позднее заполнение не становится original.

## Журнал checkpoints прогона

| Время UTC | Срез | Статус | Ссылка на доказательство в 11 |
| --- | --- | --- | --- |
| после root visual acceptance (16 октября local) | bounded P1b | принят локально; source `dee59bae06be4505b4a60e0bf469d31c8816aeda`, дерево после коммита чистое | [11](11-implementation-progress.md#p1b--targeted-gate-после-визуальных-исправлений) |
| после root visual acceptance (16 октября local) | bounded P2a | принят локально; source `fd69f3748a8538ad45e9480c0cfecd70ad7e2c9c`, дерево сразу после commit чистое | [11](11-implementation-progress.md#p2a--targeted-gate-после-timezone-finding) |
| после root visual acceptance (16 октября local) | bounded P2b | принят локально; source `5e46a8e4a50d747bd01a810dcc37a0506bc95e7c`, дерево перед provenance-правкой чистое | [11](11-implementation-progress.md#p2b--полный-source-gate-и-ограниченный-browser-rerun) |
| после root functional/visual acceptance | bounded P3a | принят локально; source `9443e063aba5b15eedb41b4ed6f4f43c68cf4baf`, дерево после commit чистое; узкая docs-only provenance без reruns | [11](11-implementation-progress.md#p3a--final-plan-cleanup-targeted-gate) |
| после root functional/visual/operator acceptance | bounded P3b | принят локально; source `7441251470e32b47272a2031cdcf76e70c668a31`, дерево сразу после commit чистое; узкая docs-only provenance без reruns | [11](11-implementation-progress.md#p3b--итоговые-core-postgresql-upgrade-и-browser-gates) |
| root acceptance05:05UTC/source05:06UTC | bounded P4a | source `12f5dbd8c9d5af8c01070e0278ec1ec8fe499fe2`, дерево сразу после commit чистое; narrow docs-only provenance без reruns | [11](11-implementation-progress.md#p4a--широкая-проверка-ui-redgreen-и-итоговая-приёмка) |
| root functional/visual acceptance | bounded P4b | принят локально; source `2d885a9f3c6834dff796779a74b739d31d73cd38`, дерево после commit чистое; narrow docs-only provenance без reruns | [11](11-implementation-progress.md#p4b--широкий-gate-и-браузерный-кандидат) |

| root acceptance06:09UTC | bounded P5a | functional/visual accepted; source checkpoint pending | [11](11-implementation-progress.md#p5a--широкий-gate-и-визуальная-правка) |
