# Project и workspace: менеджерский дашборд

**ПРИНЯТО И АКТИВИРОВАНО ЛОКАЛЬНО.** Product `1677d7d` (`1677d7dbc5736bd1ad4443d15b4fd47871aaf1f8`): реализация `ea29f39` и type-only follow-up. Candidate D: `build-561954c8-b4e8-4fd3-914c-ab49eaa59439`; 1482 source / 1090 compiled, source digest `c0ce2c9b38655958c187c7f26f00ed38a91721f13e8cae812b6298c384199780`. Локальная активация завершена **20 октября 2026, 01:21:33 Asia/Nicosia** (`2026-10-19T22:21:33.121Z`). Это отдельный docs-only follow-up после проверенного product snapshot. Предыдущий принятый продукт — `58ed0c9`, [95](95-manager-calendar-board-and-reports.md). Контракт — [97](97-workspace-manager-dashboard-contract.md); реализована первая ограниченная часть направления [96](96-workspace-report-trends.md), не все будущие источники времени.

## Как открыть и что увидеть

Внутри проекта вкладка **Reports** остаётся рядом с Tasks/Board/Graph/Timeline и сохраняет заголовок проекта. Одна рабочая страница объединяет командные Available/Plan/Actual, таблицу/полосы по людям, категории задач и распределение текущих статусов. Не нужно открывать разные сохранённые отчёты только ради переключения «люди / work type». Категорию выбирают из текущих обычных single-select полей; названия не становятся системной привязкой.

В боковом меню workspace появился отдельный **Reports**: `/app/w/:workspaceId/reports`. Он сравнивает выбранные проекты, людей и календарные когорты за более длинный срок. Начальное отображение: текущие активные люди, последние три календарных месяца по доверенной серверной дате workspace, недельные группы; можно выбрать месяц, произвольные границы, конкретных людей и источники. Период — фильтр отчёта, не обязательная сущность планирования и не специальное поле задачи.

Дефолт выбирает один подходящий сохранённый источник на проект, предпочитая источник с текущей явной категорией. При более 20 доступных проектах начальное подмножество ограничено 20 и область показана как **выбранные проекты**; это не скрытая претензия на весь workspace. Источники и category overrides можно изменить. Нет подходящих источников — понятное состояние с переходом к проектам, без выдуманных Hours-полей.

Практический путь в текущем демо: [проектный Reports](http://127.0.0.1:4310/app/w/2ea2e40e-b442-48b7-9b9d-45c26e9eb77b/projects/1268a6cd-c760-4c72-b4af-6caf988b303d/reports) → выбрать сохранённый Plan/Actual источник → выбрать даты и working capacity. Для команды целиком открой [workspace Reports](http://127.0.0.1:4310/app/w/2ea2e40e-b442-48b7-9b9d-45c26e9eb77b/reports), при необходимости раскрой Sources и выбери проекты/обычную категорию. Графики и детали задач находятся на одной странице. Эти ссылки дают путь пользователю; их наличие не заявляет проверку main authenticated UI.

## Три показателя и единицы

- **Available** — рабочая ёмкость по действующему графику человека за указанные даты, за вычетом общих праздников и подтверждённых отсутствий. Настроенные 8h Mon–Fri дают 40h в полную неделю, один подтверждённый 8h день отсутствия — 32h. Pending отсутствие не списывает capacity. Человек без задач всё равно виден с ёмкостью.
- **Plan** — полная серверная SUM выбранного обычного duration-поля, а не только подмножество закрытых задач с заполненным фактом.
- **Actual** — полная серверная SUM выбранного обычного duration-поля, отдельно от парной оценки точности. Отсутствующее, явное null и записанный 0 не смешиваются.

По каждому человеку три ряда/колонки показаны рядом. Дополнительный **Actual/Estimate** сравнивает только один и тот же eligible paired набор с обеими величинами; done-only/all-tasks задаётся отдельно. 100% означает равенство оценки и факта, превышение выделяется; нулевой/неизвестный план не превращается в бесконечность или выдуманный рейтинг. Доли категорий считаются по полной подходящей сумме, включая Uncategorized, без суммирования загруженной страницы.

Неизвестное расписание не заменяется 40h или 0. В workspace общий/периодный Available неизвестен, если хотя бы один выбранный человек не настроен; по людям известные и неизвестные значения различимы. В проекте у частично настроенной capacity остаётся явная отметка неизвестных сотрудников; отношение записанных часов к ёмкости недоступно при неизвестных/несогласованных источниках. Для работы capacity владелец/администратор настраивает реальные графики/даты в Time off; члену команды предлагается обратиться к нему. Профили автоматически не переписываются.

## Одна проектная страница

Временные фильтры людей/дат и выбор категорий делают чтения, не перезаписывают сохранённую конфигурацию. Когда для dashboard нужны SUM, а определение содержит AVG, добавляются только временные read measures; достигнутый лимит 12 показывается явно, не подменяет результат средним и не изменяет report definition. Отдельные assignee/category/status запросы используют полный серверный scope и одинаковые фильтры; capacity прикрепляется только из уже разрешённого основного результата, без нового прямого чтения скрытых бывших сотрудников.

Проектная Available имеет собственный явный интервал; быстрый выбор выбранных дат/This week объединяет календарные границы и людей для сравнения. Это действие чтения не навязывает неделю всем задачам/проекту. На сохранённом immutable snapshot сохраняется его историческая конфигурация: живые дополнительные графики не выдаются за прошлый результат.

Блок Delivery показывает текущие количества по статусам. Это удобная информация о потоке задач, **не** автоматически вычисленное качество продукта. Work type и оценка времени не доказывают отсутствие дефектов, удовлетворённость клиентов или качество труда; новые реальные показатели качества потребуют явных обычных полей/источников, не скрытого балла.

## Workspace: целый набор и настройки

Read-only discovery и POST-query описаны в 97. Нет новых таблиц, миграций, периодов, report definitions, idempotency receipts или записей audit ради открытия dashboard. Сохранённые проектные отчёты поставляют **только привязки полей**. Их личные/status/tag/date filters не наследуются: выбор отчёта конкретного человека не сужает незаметно командный workspace-dashboard. Видимые people/range/hierarchy/completion принадлежат текущему dashboard.

Настройки кодируются валидированным параметром URL `dashboard`: источники с expected revisions, категория, люди, даты и группировка переживают reload/Back/Forward. Это не новый сохранённый в PostgreSQL workspace-report объект. Повреждённый/неподдерживаемый явный URL не заменяется незаметно дефолтом; предлагается явный сброс. Изменившийся источник даёт conflict/stale: отдельное действие повторно загружает mappings. Исчезнувший источник требует выбрать другой, без молчаливого сокращения scope; поздний ответ восстановления не перетирает уже изменённый URL.

Сервер объединяет присутствие задач в выбранных разрешённых проектах и дедуплицирует canonical task ID до сумм. Часы читаются по выбранным home-project field ID; linked task не получает чужое одноимённое поле. Home mapping отсутствует — отдельный unmapped diagnostic, а не придуманное значение. Графики относятся к текущему primary assignee; участники встречи/теги/placement не размножают generic часы. All-active явно ограничивает состав текущими активными людьми; Unassigned остаётся отдельным без capacity. Это не история бывших сотрудников по умолчанию.

Категория имеет устойчивую идентичность `(homeProjectId, fieldId, optionId)`: одинаковые подписи в двух проектах не объединяются по тексту. Источник/report/field/category IDs и версии входят в проверку и source digest. Действующая membership/`reports.read`, scope, visibility и field types проверяются в одной authorized shared read transaction с нейтральной capacity. Foreign/revoked subjects не раскрываются, private leave notes/reasons/types в ответ не попадают.

## Что означает динамика

Недельные/месячные графики группируют **текущие значения задач по due date или явно выбранному custom date**, с подписями task cohort. Перенос due date перемещает всю текущую величину в другую группу. Недатированные задачи показываются в coverage, без выдуманной даты; unmapped home coverage считается до проверки диапазона, потому что неизвестна и привязка даты.

Это не dated worklog «столько человек физически работал в эту неделю» и не восстановление старого состояния после правок. Snapshots по времени, настоящие person work-date logs и многолетние серии остаются будущими частями 96. Текущий диапазон — 1–366 включённых дат, 1900–2200; календарные buckets клипируются по границам. Остальные явные пределы: 20 проектов с привязками, 100 people, 1000 saved sources в discovery, 5000 canonical tasks. Overflow отклоняется, не даёт частичные суммы.

## Календарная доработка

Чтения workspace GET/list теперь могут возвращать **optional `weekStart`**. Это добавление не инъецирует default в старые create-input/replay результаты и не меняет старые receipt/hash. Новые быстрые presets используют IANA timezone workspace и ISO weekStart, Monday fallback — только для старого ответа без поля. Workspace trends уже используют серверный weekStart для buckets.

**Ограничение:** исторический `calendarRange` внутри старого редактора определения отчёта этой доработкой не менялся. Принятие новых quick presets не является утверждением, что каждый прежний календарный control переведён на эти правила.

## Финальные проверки D и активация

Все **10 финальных gates** имеют фактический PASS на одном frozen source D. Это targeted acceptance, не новый запуск всех тестов монорепозитория. Корень proofs: `/private/tmp/workloom-manager-reports-20261020/build-561954c8-b4e8-4fd3-914c-ab49eaa59439/`. Build manifest SHA: `5d08b77a821eb5001eed0ea7301a1168e037b9421e539e9ae1d4c8c5c23d87e2`.

| Проверка D | Фактический результат | Proof относительно корня D |
| --- | --- | --- |
| Build | 1482 source / 1090 compiled, PASS | `build-result.json` |
| Global lint / types / boundaries / localization | PASS | `check-global-3ed7fcb2-a17b-496a-870b-c8412bc58d7b/result.json` |
| Scoped web | **251/251**, 32 files, 81.79 s | `check-web-focus-a0ac88a5-f952-4a21-8787-3c1ec922371d/result.json` |
| Scoped contracts / domain / HTTP | **106/106**, 8 files, 4.28 s | `check-unit-focus-3cd36a43-af47-4425-a262-a2cca2745507/result.json` |
| Isolated PostgreSQL | **30/30**, 3 files, 7.19 s | `check-integration-focus-ebad610a-512e-4150-8b17-472a1f8fadea/result.json` |
| Private compiled Chrome: project manager | **2/2**, 8.135 s | `native-manager-fe958660-9a57-4738-b633-7083a6f20ced/result.json` |
| Private compiled Chrome: workspace | **2/2**, 5.643 s | `native-workspace-4752d952-2c1a-4646-9545-5702fdc13ddf/result.json` |
| Private compiled Chrome: ordinary Reports | **6/6**, 17.515 s | `native-reports-848dc87c-77f9-43aa-a468-26cd36327700/result.json` |
| Private compiled Chrome: Time off | **3/3**, 9.526 s | `native-timeoff-ca3d0afa-5885-4bff-bdde-0156e3450959/result.json` |
| Private compiled Chrome: spatial Undo | **3/3**, 5.606 s | `native-spatial-a32e658c-bec4-450d-998c-b97c06bc43bd/result.json` |
| Private compiled Chrome: Board | **2/2**, 5.482 s | `native-board-1ab5031d-c55d-48f5-b9d7-e0634c36df6e/result.json` |

Шесть native suites — **18 distinct cases**, skipped/unexpected/flaky = 0. Промежуточные A/B/C запуски к ним не прибавляются. Private compiled Chrome использует fake Auth и отдельную PostgreSQL; private D после проверок остановлен, cleanup:true. Root-final proof summary и release manifest в корне QA связывают результаты с product/source/build. SHA `root-final-release.json`: `c62c1c0c09b475a316d19d258518ce62dc486dd84b3ed572bb15749e8fb3ea6a`. QA helper SHA: `2f734f4550c9ef9c86a0f86d7c24ace40e97dd7c9d34ac3974a37254524f7216`; activation helper SHA: `f95aaa6b1a9792b3a91005ac47bd97bdf50b837568ae38f222d50e6c073d10d6`.

### Локальная активация

Proof: `.local/backups/manager-reports-fecb169f-3c5e-4eb9-a6e4-6769cdfa8535/result.json`, pass:true. Сохранены все **94 таблицы** с прежними row digests, schema и **22 migration ledger**; не выполнялись DB writes, миграции или восстановление БД. `.env`, PostgreSQL и Vite неизменны, worker OFF. Изменены только compiled `apps/api/dist`, `apps/web/dist`, `packages/contracts/dist`, `packages/db/dist`, `packages/domain/dist`. Выполнен API-only restart: PID 58103 → 45375, новый процесс начат 20 октября в 01:21:28 по местному времени. Main readiness проверен по настоящему response body: status/database/schema = ok.

Из **312** прежних статических ресурсов сохранены **310 non-HTML** с проверкой bytes/MIME; отдельно проверены **2 HTML entrypoints** и все **337 merged resources**. Это сохранность статической выдачи, не проверка workflow в настоящей старой вкладке. **Main authenticated UI/session, live Google, actual old-open-tab workflow и production не проверены этим запуском.** Private fake Auth и HTTP-ready их не заменяют. Production не выкатывался, данные команды не заменялись QA fixtures.

### Сохранённая история A/B/C

| Этап | Исторический результат; не заменяет D |
| --- | --- |
| A | Build 1090 compiled, scoped unit 86 и PG 30 PASS. Native manager: **0 PASS / 1 FAIL / 1 SKIP** до открытия UI — exact private-provider root allowlist не включал новый QA root. Guard расширен только точным новым путём, без wildcard; отдельные **6/6 guard tests** PASS. |
| B | Native manager **2/2**, workspace **2/2**, ordinary Reports **6/6** PASS. Root просмотрел dark-dashboard изображения. Последующие calendar/name fixes означают, что B не является final D proof. |
| C | Source `f9601389c0c9796e88b6ad9919d4e4cfbe244d192c279bafaf6c7a1a1b57984c`, `build-472dad9f-31eb-4c15-8075-4cc36fcb29c6`. Остальные 9 gates PASS, включая unit 106/8, PG 30/3, шесть native suites и scoped UI. **Global RED:** `ports.ts` использовал запрещённые `import()` type annotations (`consistent-type-imports`). Результат не переименован в PASS; private C cleanup:true. |
| D follow-up | Type-only `1677d7d` заменяет ровно три `import()` аннотации на top-level `import type`, без runtime/behavior changes. Scoped ESLint файла exit 0, diff check PASS; затем заново выполнены все 10 gates D выше. |

## Generated-artifact incident

Ранний developer `build:libs` временно перезаписал ignored generated outputs трёх library dist в main: инвентарь non-web достиг 996. Это не переименовывается в «всё время неизменный runtime». Root отдельно проверенным helper восстановил принятые K **984 non-web artifacts**, сохранив изменённые outputs в backup: `.local/backups/restore-precheck-libs-0a05d03f-7d07-4408-96b1-0f7792169301/result.json`, pass:true. У восстановления `noDatabaseAccess/noServiceSignals`, env/runtime state/API/PG/Vite unchanged, worker OFF. Этот restore — отдельное событие перед финальными изолированными сборками. Он не подменяет последующую активацию D, описанную выше.

## Claude provenance

Часть тестовой реализации workspace engine подготовлена подписочным Claude CLI `--model opus --effort high`, фактически `claude-opus-5-5`, verified claude.ai/firstParty/Max, exit 0 без timeout. Конечный source/test/schema packet без `.env`, секретов, содержимого БД, tools/MCP и repository discovery: `/private/tmp/workloom-workspace-engine-opus-sryo4wob`. Получен 13-case test module, просмотрен и интегрирован; строка проверки overflow согласована с сохранённой семантикой ошибки. Manifest честно отмечает source drift: после packet были внесены preindex capacity и explicit date-type guard; их нельзя приписывать раннему Claude snapshot. Собственные service/HTTP/PG проверки и итоговая проверка root относятся к последующему общему source snapshot.
