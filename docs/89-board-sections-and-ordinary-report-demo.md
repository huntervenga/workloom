# Board, секции Graph и обычный отчёт demo

**ПРИНЯТО ЛОКАЛЬНО.** 19 октября2026; `c3a244b` (product `1bd1ebd`) активен на `http://127.0.0.1:4310/app`.
Product source `1bd1ebd`; test-only navigation adapters `c3a244b`.
Предыдущий generic runtime720cd9e описан в [88](88-generic-report-implementation-contract.md).
Этот срез не конвертирует legacy данные и не завершает весь [86](86-generic-fields-and-reports.md).

## Фактические финальные gates

Все результаты ниже привязаны к одной isolated build B `build-IsZ7Yc`: **1260 source /932 compiled /86 web artifacts**, PASS.
Все932 compiled и86 web bytes идентичны build A; follow-up изменил только3 test files.

| Final B gate | Фактический результат |
| --- | --- |
| Global `check-global-rehQwM` | PASS, cleanup true |
| Backend `check-unit-r2hjcb` | 2068 tests/119files PASS,60,13с |
| Whole web `check-web-A9LxkM` | 2197 tests/268files PASS,745,59с |
| Full PG `check-integration-MxfrvR` | 382 tests/44files PASS,746,90с |
| Chrome Board/Graph `run-board-order-96JbXX` | 2/2 PASS, cleanup true |
| Chrome Reports `run-reports-ndoTPf` | 6/6 PASS,49,0с, cleanup true |
| Local no-migration activation | PASS,07:54:39UTC; lock released |

Proofs находятся в `/private/tmp/workloom-board-graph-20261019-qa/` под указанными run names.
Build proof SHA `e1755aede510ea8dc58605590a2bfb27b7d34833b529e04255c7612ecf2f4ed5`.
Final web proof SHA `5895355618e9a5f6da06021cd31a483429354d706098ef6e37e73e91abf0ea5c`.
Final PG proof SHA `cd974b5d32d6e3b7141ff0b1b0d60b8c2bbdc35553a279e7dfff1a5e26e99570`.
Release certificate `release-certificate-final-b.json`, SHA `32e2b2742e5d57c2b81eeb455f88f1c82a1810d0ad9df62ce11f5f5d34e99cbc`, собран из4 actual check PASS и2 native PASS.
Source/tests/case deadlines/find policy/worker count/isolation/checker не менялись после B; последний PASS — отдельный запуск, а не переименование RED.

Root просмотрел build A Board cross-lane и Graph dark screenshots: ghost/insertion/3 реальные section columns; B имеет те же compiled/web bytes.
Private native Reports screenshot показал ≈1.17 для paired14h30/17h и coverage63 source tasks.
Это fake Auth/private PG; просмотр build A не переименован в новый visual run B.

## Локальная активация и границы

Активация07:53:54–07:54:39UTC PASS: только owned API2724→54853; миграций нет.
Все86 таблиц: прежние rows/columns/schema/ledger сохранены; env/PG/Vite неизменны,workerOFF, lock released.
146 retained JS/CSS и167 promoted merged resources (включая2HTML) проверены по фактическим bytes/MIME; эти наборы пересекаются и не суммируются как уникальные или новые.
Sequence query фиксирует definitions, не last_values; сохранение sequence counters не заявлено.
Proof `activation-48b5630c-b474-4c11-8f4d-b97501fcb657.json`, SHA `e7719db15dcc5cdf60a2014beeb15d91325d9d1a84b5f564c258535a858a2e50`, в том же private QA directory.

После native Chrome reload точной main-вкладки выполнена отдельная read-only UI-проверка: оба сохранённых отчёта повторно открыты, scope32, суммы16h/14h, coverage10/32 и9/32, paired9/25 15h/14h−1h, ratio≈0.93.
Work type Fact shares: Business25%, Bugfix≈10.71%, Development≈39.29%, Sales25%; Management/Uncategorized — недоступны, не0. Все6 групп просмотрены с ограниченным scroll.
Tasks показывает ordinary Hours/Fact headers без primary Legacy controls.
Graph **Section columns** preview показал32 tasks/8 dependencies и5 реальных section headers Hunter/Maya/Leo/Sofia/Noah с7/6/6/6/7 задачами.
Use/Save/drag/rules не применялись; сохранение личной раскладки через UI не выполнялось. Controller35501 завершён EXIT0, lease освобождён.
Evidence: `/private/tmp/workloom-main-ui-postactivation-20261019/actual-ui-verification.json`, SHA `8dba39a5f904528fc4683544ce14c21a79928f44f22597ef161a34ee86c4bb2c`,8 новых snapshots.
Это существующая Auth-сессия после полной Chrome-перезагрузки, не app Refresh. Exact tooltip/pixel measurements/network-write interception не заявлены; fresh login, live Google, real old-tab upgrade и production не проверены.

## Основной путь — обычные поля

Tasks/Board/Graph/Timeline/**Reports** и доступный owner CSV import остаются основными project views.
Primary Legacy time columns/Legacy weekly planning убраны; обычному duration и Reports не нужна неделя.
Ordinary Columns не предлагает native Team estimate/Personal weekly plan/Personal actual hours.
Полный сохранённый payload сохраняет прежние hidden flags/order этих колонок при ordinary saves.
Явные старые URL `?legacyTime=1` и `/week`, worklogs, snapshots/freezes и личные настройки остаются совместимыми.
Нет удаления старого движка, автоматической конвертации, reseed или выдуманных original/day facts.

## Board: точное место карточки

В **Manual** карточка переносится до/после конкретной карточки своей или другой status lane с видимыми ghost и insertion line.
Status и position сохраняются одной серверной move-командой; dependency/access/revision отказ не оставляет partial change.
Порядок использует один canonical home-project global `position`, поэтому влияет и на другие manual-проекции той же задачи.
Server читает весь project scope, включая незагруженные/скрытые строки; null anchor/after — конец полной активной lane.
Пустая lane или источник уже после последнего участника сохраняют global slot, numeric ties/gaps; остальные строки сохраняют относительный порядок.
Flat Board допускает anchor с другим parent/section, но не меняет source parent/section/assignee/package/dates/participants/history.
Archived/foreign/wrong-lane anchors отвергаются; dependency policy обычная, exact retry повторяет исходные body/key/target.
В due-date sort ручное упорядочение выключено с явным переходом в **Manual**.
Linked Board остаётся status-only проекцией: общий home+linked manual order не заявляется.

## Graph: section columns без потери ручной раскладки

Новый несохранённый вид **Section columns** располагает реальные project sections слева направо по section position/ID.
Tasks идут вертикально по собственным task position/ID; parent не подменяет section ребёнка.
**Unsectioned**, недоступный section и **Other project** отмечены отдельно; foreign section names/order не выдумываются.
Это selected starting tasks/depth, не автоматическая загрузка всего проекта.
Measured размеры карточек определяют отступы; непомещающийся layout сообщает ошибку вместо наложения.
Headers — non-task geometry, не выбираются/соединяются/открывают task и не попадают в layout save; edges остаются между реальными задачами.
Selection/open/blockers/list/pan/zoom сохраняются.

Существующие saved positions по умолчанию открываются в **My layout**.
Переключение в Section columns — read-only preview, без записи и без потери manual positions.
**Use section layout** явно переносит только видимые task positions в personal draft, сохраняя hidden positions.
Далее доступны drag/keyboard controls, **Save my layout**, discard/reset и exact-command recovery.
Graph layout не меняет dates, отношения или task metadata.

## Reports: записанные доли и точность

Group breakdown для duration SUM показывает **Share of recorded time** от matching полного report SUM (key/field/operation/unit).
Это server totals, а не loaded pages или subset complete comparison pairs.
Missing/cleared исключены из recorded denominator с coverage; known0 не равен пропуску.
При неизвестной/нулевой общей сумме доля недоступна; без grouping bars не показываются.
Single-category/current primary-assignee attribution не умножает часы на tags/participants/placements.

Reports display округляет дробные measures/ratios/shares максимум до2 знаков, убирая конечные нули; **≈** отмечает неточность.
Measures/ratios сохраняют tooltip `n/d (server decimal)`; derived percentage имеет exact percent fraction в aria-label/title, без выдуманного server decimal.
Маленькая positive share может отображаться ≈0%; genuine0% известен только при положительном known whole.
Integer durations показываются в часах/минутах; footer formatter сохраняет прежний exact-decimal путь.
Округлённые доли могут не сложиться ровно в100%; authoritative totals не меняются.
Original Plan/current Fact и immutable full initial measures сохраняют контракт88; old weekly originals не подменяются generic snapshots.

## Main demo: реальные UI-действия на прежнем runtime

В существующем **Team delivery · five-person demo** через указанную пользователем Chrome-вкладку с имеющейся Auth-сессией созданы ordinary duration **Hours Estimation** и **Fact**.
На10 sample tasks введены значения; **Hours · by person** и **Hours · by work type** сохранены и повторно выбраны после Tasks → Reports.
Scope32 canonical tasks: plan10filled=960мин (16h); fact9filled=840мин (14h), включая1 genuine0 и23 missing.
Completed comparison:9 paired из25 eligible, plan900мин (15h)/fact840мин (14h), delta−60мин, ratio14/15.
Partial plan sum960 не подменяет paired plan900.
Work type Plan/Fact минуты: Business270/210, Bugfix210/90, Development300/330, Sales180/210; Management/Uncategorized — missing, не0.
Все10 sample tasks сверены с literal oracle. Остальные22 задачи, status/date/person, legacy и snapshots не менялись; initial snapshot не создавался.
Без прямого API/SQL seed; controller завершён, вкладка оставлена открытой.

Evidence: `/private/tmp/workloom-main-ui-20261019/actual-normal-ui-demo-evidence.json`, SHA `6c32a818497c615d6f0d389a0792f38c7fa38ec3002071d92ed8b766e20ab841`.
Эта настройка сделана на **старом runtime720cd9e** и не является приёмкой новых Board/Graph/share bars/compact precision.
Следующий ordinary project может использовать Reports → Preview Plan and fact → свободные имена → Apply template либо свои поля вручную; main demo не выдаётся за template proof.
Полный login/live Google, настоящая old-tab upgrade и production из существующей сессии не следуют.

## Сохранённые whole RED и отдельная диагностика

| Исторический whole run | Фактический RED |
| --- | --- |
| Web A | 2190 PASS/7 FAIL из2197;265 PASS/3 FAIL из268files,1067,55с |
| PG A | 378 PASS/4 FAIL в44files,843,76с |
| PG B `S4Oe8n` | 380 PASS/2 FAIL из382;43 PASS/1 FAIL из44files,584,05с |
| Web B `N5aTqA` | 2196 PASS/1 FAIL из2197;267 PASS/1 FAIL из268files,1549,65с |

Web A7 stacks — removed-primary Legacy link: TaskHierarchy1/ProjectToolbar5/ProjectBoardTimeContext1.
Только3 independently reviewed test files заменили устаревшую navigation-проверку на exact Reports href/absence Legacy, сохранив actual route week/person, drafts и точные recovery path/body/key/count/deadlines.
Scoped43/3 PASS46,93с, lint/source-alias types/diff0 — отдельный run, не прежний whole PASS.
Web B sole15с neighboring-assignee case timeout остался RED; outer timedOut=false, supervisor не менялся.
Обе PG failure groups и причина web-case timeout остаются неустановленными: host-load correlation и последующие PASS не доказывают, что причины были безвредными.
New Board5 проходил и в RED PG, но это не превращало весь command в PASS.

Cutoff diagnostic в отдельном clone:21/1 PASS64,48с; исходный case54,417с<неизменных60с.
Focused unchanged neighbor file:19/1 PASS27,77с; прежний failed case1,069с<15с.
Оба имеют acceptanceGate=false/cleanup true, не заменяют final whole gates.
Original cutoff phases.json0 из-за ANSI сохранён; отдельный bound parse дал96 events/48end, около93% case time во внешних worker phases (census/materialization/freeze вместе), без установленной причины старых RED.

Исторические proof SHAs: web A `2983263672f151ab1eab6c2ccb79661018b548cb5b1c26b96955a8ad42d89f23`; PG A `dfc8061566d096d80df7ab55db329b89ac8f5da8b15ebf5560a3a4c24c1e4de0`; PG B `1ca1b3c59831d6fe849480cc6b41ce3e77207c727eb3b6f5109a4d43f028fb87`; web B `9e971cc3571bae31029c813f86e1272a113bdd8beb44b936b641ebceb9d35d69`.
Diagnostic proofs: cutoff `d34fdab45cc33b5eace606164f60611b6b366ccb15459119cdc126c8f1b677b2`; focused web `d719b8495101fc905adb95c9ec92a1bb35313bdb1dbbd589f2c101acb324285d`; derived phase `cca24cc9b0eec35385fedbfcc9470d9bc73e39786ec65e0bf58a8b71dafdb905`.
Focused Graph/source history остаётся в `/private/tmp/workloom-graph-sections-20261019/`; подробный progressive journal сохранён до сокращения в `/private/tmp/workloom-board-graph-reports-doc89-20261019/progress-before-final-restructure.md`.

Локальная активация и ограниченная read-only main UI-проверка подтверждены отдельно. Real old-tab upgrade, fresh login/live Google и production не заявлены.
