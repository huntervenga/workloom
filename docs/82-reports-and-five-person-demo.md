# Autosave, Reports и пятичеловечный demo

**Код `87fba71` принят локально и активен на `http://127.0.0.1:4310/app`.** Final web **2060/2060 tests,253/253files PASS690.29s**; backend **1872/106 PASS36.65s**; private compiled Chrome **64/64 в12 отдельных suites**; isolated placements PG7 и demo apply/replay PG PASS; final global/API/web builds actual0. Certificate SHA-256 `2362957f20103e643c6744363015ee4aa81f60135cb5243b006a7707298fbd4c` связывает1964 source/compiled files +82 stage artifacts с19 actual zero-exit gates. Commit локальный, без push/public deployment. Предыдущий принятый main — [docs81](81-task-pane-profile-history-and-bulk.md).

## Как пользоваться

- **Table:** Group by→Assignee и Sort→Manual для личных списков. Клавиатура, перенос, выделение строки/Shift/Ctrl/Cmd и atomic bulk сохраняют canonical parent/package и историю.
- **Task pane:** обычные сохранённые title/description/поля используют autosave при завершении редактирования; общего обязательного Save задачи нет. У popup, create и unknown recovery остаются их явные действия. Pending/unknown показывает исходную команду, exact retry не меняет body/key. Соседнее поле таблицы остаётся доступно рядом с компактной панелью.
- **Child rows:** Enter создаёт следующую строку. Parent renewal не теряет уже выраженный Enter intent; page-owned parent read может завершить его после Close без повторного открытия pane.403/500/unmount не дают stale разрешения на отправку.
- **Tags/Board/Timeline:** цветные tags читаемы в обеих темах; Board drag меняет статус. Timeline сохраняет даты при переносе полосы без обычного подтверждения, показывает зависимости; клик по полосе открывает задачу. Сохранение итогового диапазона остаётся guarded; resize/автоматическое расписание не заявлены.
- **Reports:** видимая ссылка рядом с Week открывает результаты; team/person saved runs и Work types отделены от advanced setup. Calculate current report — явная новая команда. Открытие Reports или смена вкладки не создаёт отчёт автоматически; dirty/failed/held setup остаётся открытым.
- **Одна задача в нескольких проектах:** общий статус и home accounting одни. Linked rows — отдельная секция, без единого home+linked bulk/manual order/linked Graph. Linked Timeline даты read-only, правятся через pane/Home; подробный контракт — [83](83-task-project-placements.md).

## Что означает отчёт

Недельная разница показывает прогресс, а не качество оценки незавершённой работы. Completed review использует **original personal weekly plan**, известный plan, recorded fact и captured completion; не подменяет личный план shared package estimate. Missing остаётся unknown, recorded0 — настоящий0. Versioned `completionAtCalculation` получает полный авторизованный серверный набор неархивных package tasks, включая hidden/unloaded child. Пустой/архивный-only пакет или неизвестный status дают unknown. Старый report без optional поля не backfill сегодняшним статусом. Это не метрика точности полного shared package budget.

Report totals/cohort/fact revisions — сохранённый server snapshot, не сумма загруженной страницы. Original baseline, added и unplanned раздельны. Work type — одна авторитетная категория recorded revision; Uncategorized входит в denominator. Другие multi-tags могут пересекаться, но не умножают проценты или часы. Настройки области отчёта и week/person ввода независимы. Связанные исходные контракты: [planning](13-p2a-contract.md), [work categories](14-p2b-contract.md).

## Созданный main demo

Новый dedicated project в существующем выбранном workspace с real owner и4 вымышленными fixture users/memberships. Нет новых Auth identities/sessions/invites/email; owner/profile и прежние данные сохранены. Бизнес-записи создаются domain commands с ACL/barrier/planning guards; каждый fictional actor фиксирует только свой план/факт. Это additive dataset, не замена существующего проекта.

- [Таблица demo](http://127.0.0.1:4310/app/w/2ea2e40e-b442-48b7-9b9d-45c26e9eb77b/projects/1268a6cd-c760-4c72-b4af-6caf988b303d?week=a08c4d32-2794-40f2-8d77-cabdd1b2dd67).
- [Сохранённый team Reports](http://127.0.0.1:4310/app/w/2ea2e40e-b442-48b7-9b9d-45c26e9eb77b/projects/1268a6cd-c760-4c72-b4af-6caf988b303d/week?period=a08c4d32-2794-40f2-8d77-cabdd1b2dd67&view=report&run=c5629da1-3ce8-492f-a39e-9afefb50f389); personal runs доступны в Saved report.
- [Work types](http://127.0.0.1:4310/app/w/2ea2e40e-b442-48b7-9b9d-45c26e9eb77b/projects/1268a6cd-c760-4c72-b4af-6caf988b303d/week?period=a08c4d32-2794-40f2-8d77-cabdd1b2dd67&view=work-types&typeRun=df0df9ca-186d-47d2-be58-9cab55e6a223).

32 задачи с индивидуальными английскими описаниями, датами,8 dependencies, статусами и цветными категориями. Demo week12–18Oct2026, timezoneAsia/Nicosia, cutoff `2026-10-25T21:59:00.000Z` намеренно позже недели, чтобы выполнить явный freeze до facts при настоящем запуске. Baselines захвачены сейчас, не задним числом:5 personal +project в новом journal-owned period нового проекта. Прежние периоды не выбирались/не фиксировались.30 original rows дают2400min=40h на человека,12000min=200h team. Затем shared estimate480→600; original snapshot480 остаётся прежним. Five personal reports создаются перед team run, поэтому newest fallback открывает команду.

Независимый literal oracle: original actual11820min, added90, unplanned75, all recorded11985min=199h45. Coverage29/30: единственный missing относится к unfinished task, completed genuine0 записан явно. По людям original actual: owner2400,Maya2370,Leo2310,Sofia2160,Noah2580; all-recorded owner2490/Maya2370/Leo2310/Sofia2160/Noah2655. Категории Bugfix1380,Development2700,Business3270,Sales2040,Management2055,Uncategorized540 суммируются в11985. Overlapping extra tags не участвуют в denominator.

Root first main apply actualexit0:139checks PASS/0fail,2026-10-18T12:47:05Z; exact main replay также139/0 и те же project/report IDs: `/private/tmp/workloom-five-person-main-demo-replay-20261018.json`. Указанный в handoff replay SHA относится к result stdout, не к bytes этого receipt-файла. Old-row guard прошёл. Private0600 journal хранит исходные serializedArgs/digest/actor/app/method/key до вызова и повторяет их точно, без silent rebase. Общий dataset не является одной гигантской транзакцией; ошибка не разрешает сброс/reseed baseline. `scripts/bootstrap-hunterman-weekly-demo.mjs --dry-run` offline; повторный main apply — только явный операторский scope с прежним journal, не инструкция заново выполнять seed при каждом открытии.

## Проверки и сохранение

Final stage `/private/tmp/workloom-placements-web-dist`:82 artifacts,SHA `3172398eaec6b42b5768cac0f07c4fd83375187c78345010e8ffb5e79a189ece`. Final globalREQGv9:localization279files/3425calls/3366English messages/1locale. Full-web actualexit0 — `/private/tmp/workloom-placements-activation-candidate/gates/targeted-web-O6WfTG/proof.json`; общий ledger19 gates — `/private/tmp/workloom-phase2-actual-final-gates-20261018.json`. Названия wrapper targeted-unit/targeted-web обозначают фактически выполненные **полные** backend/web команды.

Native proofs: `/private/tmp/workloom-placements-20261018-qa/run-<suite>-<id>/proof.json`; каждый pass/actualexit0, cleanup собственного child и catalog restored:

| Suite | Run ID | Cases |
| --- | --- | ---: |
| insertion | l8eZ63 | 7 |
| placements | xvG1v5 | 4 |
| autosave | uB5d7g | 5 |
| drawer | XGudrd | 5 |
| board | zv0Iwl | 4 |
| timeline | RaSSYf | 5 |
| reports | yV6vkY | 1 |
| daily | HAIy2G | 12 |
| bulk | m8GAoe | 6 |
| selection | uj7g5d | 7 |
| history | pk9Bot | 4 |
| profile | JbVxNC | 4 |

Это64 cases/12 suites на одних bytes, не один общий command. Настоящий Chrome использовал fake Auth/private PostgreSQL. Main read-only CUA был попытан, но kernel остановился **до inventory** из-за unsupported writable-root symlink Auth; main browser взаимодействия не было. `open_in_codex` вернул queued: открытие не является проверкой. Нет нового authenticated-main/live Google/old-tab/production/physical-mobile acceptance.

Main activation actualPASS/phasecomplete: `/private/tmp/workloom-placements-main-activation-1ff69827-30a5-4d7b-9530-97e13f145416.json`. Только0017:78→79tables/17→18ledger; старые rows/columns/schema/ledger prefix идентичны;1816 deterministic homes/1816 canonical tasks,mismatch0. Env/PG/Vite сохранены,workerOFF,API-only restart;82 old и99 promoted served resources проверены actual bytes/MIME (это два пересекающихся набора, не181 уникальный ресурс). Backup `.local/backups/web-placements-1ff69827-30a5-4d7b-9530-97e13f145416`. Это pre-demo conservation; seed затем добавил свои строки, сохранив прежние. Postseed health PASS12:49:31Z:ready200db/schema,shared config200,guestme401,root/app200 byte-exactstage; `/private/tmp/workloom-placements-postseed-health-20261018.json`.

## Сохранённые RED и provenance

Whole FIRST1986PASS/43FAIL2029tests247files799.96s и Qehxne2047PASS/5FAIL остаются RED собственных source runs. Пять report-discovery обращений к скрытому advanced setup исправлены test-only: unchanged31/5→36/36,6files28.58s; cohort/body/key/deadlines не менялись. Qehxne missing-row fixture отдельно10focusedGREEN. Initial placements PG6/1 — fixture `membership.revoked_at`; реальные parent/child дефекты не классифицируются как harness noise.

Native7fKKDt доказал D201→parentGET→Edisabled→Enter проигнорирован. Local draftWritable/dispatch guard:2causalRED→4GREEN; reviewer нашёл cancellation-success/invalidated stale-cache путь:RED→5GREEN; affected46/6PASS69.65s. Final page-owned read после Close/403/500/unmount:49/6PASS30.70s,lint4files/noemit0,independent bounded review noP1/P2; `owned-read-final-proof.json`/`owned-read-production.patch` сохраняют точный scope. Финальные insertion7 входят в64 и не прибавляются повторно. Старые native/Timeline/placements RED, wrapper ENOENT и ранний cwd startupFAIL сохранены; новый PASS их не стирает. Test durations не являются performance acceptance. Actual Claude Opus source-author/review jobs сохраняют свои manifests; отказанный automatic review не считается состоявшимся. Local Codex authored этот handoff/helper и конкретные разрешённые follow-ups.
