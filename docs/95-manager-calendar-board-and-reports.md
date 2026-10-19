# Календарь команды, стабильный Board и проектные Reports

**Последующий локальный срез:** product `1677d7d` активирован 20 октября 2026 в 01:21 Asia/Nicosia: единый проектный Available/Plan/Actual и workspace Reports — [98](98-project-and-workspace-manager-reports.md). Приёмка Candidate K ниже остаётся исторической и не заменяет proofs D.

**ПРИНЯТО И АКТИВИРОВАНО ЛОКАЛЬНО.** Product `58ed0c9` (`58ed0c98baedd2dc4c2f35a24e762f87c0c90435`), Candidate K, `http://127.0.0.1:4310/app`. Web-only активация завершена **19Oct2026 21:16:36.817 UTC** (20Oct local), без DB writes, миграций и перезапуска процессов. Это docs-only follow-up после принятого product/source/build snapshot. Ограниченная доработка интерфейса поверх [94](94-time-off-profile-defaults-and-save-feedback.md), [91](91-time-off-and-capacity.md), [92](92-spatial-undo.md) и [88](88-generic-report-implementation-contract.md). Не вводит обязательную неделю, специальные Hours-поля или новый источник фактически отработанного времени.

## Календарь и Timeline

В календаре Time off суббота и воскресенье имеют заметный фон и обозначены в легенде. Это календарная подсветка, а не правило списания: рабочие дни определяются расписанием сотрудника. При обычном Mon–Fri отпуск на две полные недели списывает 10 рабочих дней; при другом настроенном расписании результат может отличаться.

Календарь различает текущую доступность и уже подтверждённое списание баланса. Недоступность берётся из авторитетных ежедневных `holidayMinutes`/`absenceMinutes`, а не из самого наличия даты внутри сырого интервала заявки. Подтверждённые `chargedDays` показывают ранее записанное списание отдельно, даже если текущее расписание/праздники изменились. Эти записи не пересчитываются и не списываются второй раз ради отображения. Пересекающиеся данные не удваивают дневную метку; неизвестное расписание не превращается в0 доступных часов. Незавершённая заявка сама по себе не уменьшает capacity.

Timeline сохраняет нейтральные полосы недоступности и добавляет короткие подсказки у задачи/трека: человек, даты и недоступные часы в загруженном диапазоне. Причины, тип отпуска и приватные заметки в проект не передаются. Подсказка учитывает конкретного исполнителя и положительное уменьшение capacity; выходной без рабочего расписания не объявляется личным отпуском. Для неизвестного расписания/неназначенной задачи личная недоступность не выдумывается. Длинный диапазон сокращается до нескольких дат с числом остальных; это не обещание проверки за пределами загруженного окна.

Заголовок дат остаётся видимым при вертикальном скролле Gantt; горизонтальный скролл согласует ось и строки. Подсказки позиционируются относительно видимого scrollport и открываются также с клавиатуры. Они не блокируют перемещение задачи и не превращают предупреждение в автоматический перенос зависимых задач.

## Board и отмена

Карточка, её место в колонке и перетаскиваемая копия сохраняют одинаковую внутреннюю геометрию. Появление/блокировка drag handle и полосы приземления не должно менять высоту соседних карточек. Копия сохраняет визуальный completion control, не регистрируя второй действующий редактор/фокус. Концевая полоса колонки находится поверх её отступа, а не добавляет строку в поток.

Ручной порядок и перенос между статусами используют прежний серверный move. Ctrl/Cmd+Z после подтверждённого сохранения восстанавливает Board/table move и исходные даты Gantt через [92](92-spatial-undo.md). Новая проверка Undo не означает появления Redo, локальной отмены несохранённого Graph draft или обхода конфликтов/permissions. В текстовом поле остаётся нативная отмена текста; pending/unknown write требует разрешения исхода, а не слепой обратной записи.

## Reports в контексте проекта

Reports сохраняет название проекта и навигацию Tasks / Board / Graph / Timeline / Reports. Без явного `?report=` открывается первый подходящий сохранённый отчёт; ошибочная явная ссылка не подменяется другим отчётом. Фоновое обновление того же запроса не заменяет уже показанные графики пустым экраном. Picker/New/Edit/Run объединены в один toolbar; report-name heading сохранён для assistive navigation. Настройки шаблона и исходных снимков перенесены ниже результатов/задач. Полные технические descriptions доступны, но не занимают несколько строк над диаграммами; task count и выбранные люди/даты остаются видимыми. Coverage полных сумм и парного набора доступен в карточках; подробности — в раскрываемом блоке.

Значения остаются обычными пользовательскими полями со стабильными ID. Владелец/администратор выбирает поля, SUM/AVG/count, сравнение, фильтры и категории в сохранённой конфигурации. Название «Hours» не даёт полю системного поведения; денежные/обычные числовые значения не становятся часами. Недоступный источник показывает явную проблему, а не привязывается к новому одноимённому полю.

На первом экране доступны полные серверные суммы, отдельная доступная capacity при её настройке, парные Plan/Actual по исполнителю, категории и таблица задач с переходом в задачу. Положительное превышение оценки выделяется. Категория — обычное явно выбранное single-select поле; если она не настроена, интерфейс предлагает выбрать поле, а не угадывает его по названию. В одной рабочей странице можно видеть исполнителей и категории: дополнительные разбивки делает сервер с теми же task filters, без суммирования загруженной страницы. Для этих дополнительных чтений не запрашиваются скрытые capacity-данные; нейтральная capacity сохранённого отчёта не даёт право прямого чтения бывших сотрудников.

People и task-date range — временные фильтры чтения. Они не сохраняют/перезаписывают определение отчёта и не создают неделю. Даты — due date или выбранное обычное date-поле, с включёнными границами. Capacity сохраняет свой отдельный интервал/людей; явный checkbox позволяет применить к ней выбранные даты и людей. Это не автоматическое распределение Actual по рабочим дням.

Snapshot остаётся отдельным явным immutable capture полного разрешённого scope, а не снимком текущей страницы. Временный фильтр не используется для скрытой записи исходного плана. При просмотре снимка сохраняется его настроенная группировка; дополнительные живые разбивки не выдаются за исторический результат. Same-route Back/Forward на другой `?report=` сбрасывает page/filter/snapshot state, когда это безопасно; при несохранённом редакторе/неизвестном write текущая форма остаётся открытой до разрешения исхода. Отмена snapshot draft явно очищает его защиту; скрытого unsaved draft после Cancel не остаётся.

## Что именно означают проценты

- **Actual / Estimate** использует авторитетный `comparison.ratio` одного и того же eligible paired набора. 100% означает равенство, выше100% — превышение оценки. Отдельные полные SUM могут иметь другое coverage и не подменяют парное сравнение. Неизвестный/нулевой план даёт «—» с причиной, а не0%, бесконечность или выдуманный «балл точности».
- **Recorded / available** — сумма записанных текущих task-level Actual значений относительно настроенной capacity. Процент показывается только для duration SUM в минутах, совпадающих включённых границ task-date/capacity, проверяемого совпадения людей, известных расписаний и положительного знаменателя. Процент выше100 допустим и не обрезается; неизвестные/нулевые/mismatched источники дают «—» с короткой подсказкой. Неполное заполнение Actual остаётся видимым coverage. Парный Actual subtotal в этот числитель не подставляется.
- Это **сравнение записанного времени выбранной когорты задач с capacity**, а не доказанная посещаемость, часы физической работы в эти дни или продуктивность человека. Проект может включать лишь часть его работы; перенос due date перемещает целиком текущую длительность задачи между когортами.
- Доли категорий используют подходящий полный SUM, включая Uncategorized. Missing/null не становятся0; настоящий записанный0 различается с неизвестным знаменателем. Tags фильтруют задачи и могут пересекаться: их сумма не выдаётся за независимые100% категории. Chart widths и подписи рассчитываются из exact rational с округлением только отображения, включая суммы выше Number precision.

## Доступ

Действующая серверная модель [91](91-time-off-and-capacity.md) сохраняется: owner/admin управляет правилами, профилями, согласованием и обоснованными историческими исправлениями; member создаёт/меняет собственные будущие заявки; started/past days защищены. Для уже согласованного типа с approval сотрудник может только сократить подтверждённый интервал, а дополнительные дни требуют новой заявки/approval. Viewer читает нейтральную доступность без write. Заметки/балансы доступны только разрешённым субъектам; выбор человека в Reports не меняет права.

## Границы и следующий этап

Workspace-wide Reports hub, cross-project trends, dated person worklogs и полная история «часов работы по дням» **не реализованы этим slice**. [96](96-workspace-report-trends.md) — только **PROPOSED / NOT IMPLEMENTED** контракт. Ни дата изменения поля, ни completion, ни cumulative Actual не становятся work date автоматически. Предложенный будущий источник нельзя выдавать за текущий API или релизную возможность.

## Финальные проверки K

Замороженная сборка: `build-10265023-6a02-43f6-9e3f-1010fff81ed4`, **1450 source /1075 compiled**. Source digest `e57863c8da6b688cc1ddd1343d9fca216afeac290a1dba880115e54b0e32348f`; build manifest SHA `dec535711d629d7c25aff6070124396313c6466a82e06a42ec3d82d55c1b589b`.

Все команды ниже имеют фактический exit0 на этом frozen K. Это **scoped acceptance**, не новый whole-web/backend PASS. Папки proofs находятся в `/private/tmp/workloom-time-off-20261019/build-10265023-6a02-43f6-9e3f-1010fff81ed4/`; `root-release.json` связывает product commit, source/build identity, global и `root-final-focused-proof.json`.

| Проверка | Фактический результат / proof |
| --- | --- |
| Build | 1450source/1075compiled, `build-result.json` pass:true |
| Global lint/boundaries/localization/types | PASS, `check-global-79d73ae0-3f1a-4791-820b-c103ae6c417b/result.json` |
| Scoped web | **172/172 в22files**,88.77s: errors, Time off, Board, generic Reports, Gantt move/direct и project Board routes; `dashboard-web.log` |
| Permission/HTTP unit | **13/13 в2files**,2.96s; `dashboard-unit.log` |
| Isolated PostgreSQL | **17/17 в1file**,4.47s; `dashboard-pg.log` |
| Private compiled Chrome / Time off | **3/3**,21.431s; `native-timeoff-6300b84c-a917-4547-9411-e4f94dd55fcf` |
| Private compiled Chrome / Reports | **6/6**,29.862s; `native-reports-23eac030-e1c2-4eec-9ddc-adb5bf3ad97e` |
| Private compiled Chrome / spatial Undo | **3/3**,13.456s; `native-spatial-b56bdb1f-0ff2-4a3e-9370-e92587becf61` |
| Private compiled Chrome / stable Board | **2/2**,11.914s; `native-board-fd26237c-8a2d-4c14-b15a-f9f77e674f0d` |

У четырёх native suites skipped/unexpected/flaky =0. Это отдельные14 cases, без прибавления перекрывающихся промежуточных запусков. Root просмотрел K dark-calendar и manager-dashboard PNG. В Reports фактический `manager-dashboard-layout` attachment показывает **chartTop553px при1440×1000**, удовлетворяя `0<y<650`; screenshot `manager-report-overview-dark.png` относится к этому запуску. Private QA использует fake Auth и отдельную PostgreSQL, не реальные учётные записи/данные команды; после проверок остановлен, cleanup:true.

### Web-only активация и границы

Activation proof: `.local/backups/time-off-profile-web-d56445b8-1cf7-4c96-a587-33d441d15b18/result.json`, pass:true. Все **94 таблицы** с прежними row digests, schema и **22 migration ledger** идентичны; DB writes/DDL/migrations не выполнялись. `.env`, runtime state, идентичности API/PostgreSQL/Vite и **984 non-web artifacts** неизменны; workerOFF. Процессы не перезапускались, операция завершена без оставшегося lock. Main readiness проверен по настоящему response body: database/schema OK.

Из289 прежних ресурсов **287 non-HTML** сохранены с проверкой bytes/MIME; **2 HTML entrypoints** проверены отдельно, проверены все **312 merged resources**. Это доказательство сохранённой статической выдачи, **не** выполнение workflow в настоящей уже открытой старой вкладке. Реальные main-auth UI/session, Google, production и actual old-open-tab workflow этим slice **не проверены**; anonymous/readiness HTTP и private fakeAuth Chrome их не заменяют. Main Time off profiles/демо не перезаполнялись, QA данные в main не переносились.

## Сохранённая RED-история

| Run | Фактический результат / исправление |
| --- | --- |
| Reports focused A /B | **49PASS/5FAIL**, затем **52PASS/5FAIL**. Drivers адаптированы к default selection, disclosures, повторяющимся summary/detail и новому DOM после пагинации. Assertions/deadlines не удалены; последующие59/8 PASS — отдельные запуски |
| H native Reports | **3PASS/1FAIL/2SKIP из6**, flaky0,51.29s. Driver ждал `Distribution by Work type`, fixture создавала `Focus area`; accessible tree содержал правильные обе диаграммы. Только2 selectors заменены на `category.name` |
| H native Time off | **1PASS/2FAIL из3**,85.78s. Настоящий explicit-theme defect дал text contrast≈1.204<4.5: исправлены theme selectors. Другой driver не открывал Coverage details перед чтением capacity: добавлено открытие, проверки сохранены |
| I native | Reports **6/6 PASS**,36.01s. Time off **2PASS/1FAIL из3**: driver искал Days in window без открытия advanced controls. Исправлено открытие |
| J native | Reports **6/6 PASS**,35.66s, chartTop553px. Time off **2PASS/1FAIL из3**: rollover UTC/Nicosia сделал выбранную driver дату уже начавшейся для профиля; сервер правильно отказал интервалу без административного reason |
| K driver correction | Дата выбирается из актуальных trusted overview/member today с запасом; независимое ожидание начисления использует конкретный balance.asOf и календарные годы. Past-day guard/reason не ослаблены. Финальный K3/3 Time off выше — отдельный запуск |

Ранний handoff ошибочно называл native Reports7 cases. Фактически2 theme parameterizations+4 других = **6**, как в JSON; SKIP никогда не считается PASS. Ранние test type/lint diagnostics (`exact` option и unused import) исправлены отдельно. Localization probe потребовал конечную исчерпывающую регистрацию2 typed-map lookup; CSS-строка Gantt, ошибочно похожая на prose, заменена эквивалентным static Tailwind без глобального waiver. Финальный global PASS имеет собственный proof.

В scoped web log остаётся React warning `Cannot update a component (ProjectContent) while rendering a different component (ProjectContent)` в ReportScope. Он существовал **в том же тесте до этого slice**: accepted E whole-web log `build-2af4a1fd-56f4-4717-a08f-dbf8f2b35e82/check-web-a345a481-7c6d-4243-87aa-d22cd3bffa9a/check.log:666–669`,2312/285 PASS. Затронутый ProjectContent/ColumnAggregates/test body не менялся; новая регрессия не установлена. Точная причина старого warning не доказана и не переименована в «безвредный mock»; это отдельный существующий технический долг.

## Ограниченный Claude provenance

Reports implementation proposal получен через подписочный Claude CLI: явные `--model opus --effort high`, фактический `claude-opus-5-5`, verified `claude.ai`/firstParty/Max, exit0. Конечный allowlist исходников/тестов, без `.env`, секретов, БД, tools/MCP и repository discovery. Packet/manifest/result: `/private/tmp/workloom-opus-report-dashboard-32le_sqw`; компонент и7 тестов просмотрены и интегрированы, затем Codex добавил согласованные ratio/accuracy, безопасные secondary reads, protected identity, регрессии и compact layout. Manifest честно отмечает source drift после параллельной интеграции: финальные исправления не приписываются раннему Claude snapshot. Handoff: `/private/tmp/workloom-reports-ux-20261019/handoff.json`; layout/check chronology и hash-bound patch — в `layout-proposal/` этого каталога.
