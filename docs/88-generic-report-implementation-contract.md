# Обычные duration-поля и конфигурируемые отчёты: Phase1

**ACCEPTED LOCALLY — ограниченная Phase1, `5d0e382` / runtime `720cd9e`.** Активация18Oct2026UTC /19Oct local, `http://127.0.0.1:4310/app`.
Основание — подтверждённое направление [86](86-generic-fields-and-reports.md).
Обычные custom duration/number/date-поля уже существуют; новый результат — понятный Plan/Fact template, report editor/query и generic aggregates.
Final build/check/backend/web/PG/private Chrome и локальная активация подтверждены ниже; это не завершение всей Phase2 и не hosted production.
Предыдущий section web checkpoint [87](87-project-section-creation.md) сохраняет собственную приёмку; generic Phase1 проверена отдельно ниже.

## Как попробовать

1. Откройте **Reports** нужного проекта. Неделя и native period не нужны.
2. Выберите **Preview Plan and fact**, проверьте названия обычных duration-колонок и нажмите **Apply template**. Либо создайте свои Budget/Spent или A/B и настройте **New report**.
3. Вернитесь через **Back to tasks** и заполните эти обычные колонки. Названия можно менять: отчёт связан с ID полей.
4. В **Reports** выберите сохранённый отчёт. В **Edit report** задайте **Measures**, **Group by** и необязательный **Date filter**. **All time** работает без недели; **This week**, **This month** и **Custom range** выбирают только границы фильтра.
5. Проверьте **Report scope**, **Results** и coverage. Суммы в сравнении используют одинаковый набор заполненных пар; отсутствующее число не считается нулём.
6. При необходимости нажмите **Capture initial snapshot** → **Save immutable snapshot**. Позднее original Plan сравнивается с текущим Actual для оставшихся подходящих задач; исходный набор и полные original totals сохраняются.
7. В таблице **Column totals** → **Configure totals** задаёт общие для проекта меры. Отдельный breakdown показывает собственные секции задач; он не копирует унаследованную структуру дерева таблицы.

Обычные поля и новый Reports доступны в текущем локальном runtime. Прежние weekly данные не подставляются в них автоматически.

## Один обычный проект

Пустому проекту не нужны personal period, week или native Worklogs, чтобы хранить duration.
Пользователь создаёт поля Budget/Spent, A/B или любые другие; server использует field IDs/type, не названия.
Duration хранится в целых минутах по существующему контракту, UI показывает понятные часы/минуты.
Rename сохраняет ID; delete/archive оставляет историю; recreate одноимённого поля даёт новый ID.
Старая definition/report не перепривязывается автоматически к новому полю по имени.
Native package estimate и native weekly plan/fact не подставляются в эти колонки скрыто.

Opt-in Plan/Fact template создаёт обычные duration-поля и конфигурацию сравнения.
Перед подтверждением видны создаваемые поля; существующие поля не захватываются по совпадению имени. Имена полей проекта уникальны, включая архивные: конфликт виден в preview, Apply template недоступен до выбора свободного имени. Шаблон не переиспользует одноимённое поле.
Template не создаёт выдуманный факт, начальный snapshot, период или worklog.
Можно отказаться от template и вручную настроить ровно тот же report query.

## Сохраняемая конфигурация

Report definition имеет стабильный ID, revision и явный project scope.
Команда create/update принимает только типизированный конечный каталог; actor/workspace/права берутся из server context.
Update проверяет expected revision; unknown retry сохраняет исходные body/key, не создаёт второе определение.
Definition хранит выбранные field IDs, меры, filters, grouping, optional date selector/range и comparison mapping.
Поля, options и memberships принадлежат этому workspace/project и совместимы с операцией.
Переименование обновляет отображаемую подпись, а удаление/недоступность показывает problem state без скрытой подмены.
Сохранение definition само по себе не редактирует значения, историю, usage quota или старый snapshot.

Phase1 measures — совместимые sum/avg/count; count tasks и count filled values должны быть разными явными смыслами.
Для avg знаменатель — только поддержанные заполненные значения; число пропусков показывается отдельно.
Comparison выбирает два duration field IDs; это конфигурация, а не два специальных глобальных поля. Plan/fact/delta/ratio считаются по одному набору полных eligible pairs; coverage охватывает все eligible rows, eligibleTasks и pairedTasks видны отдельно.
Delta и ratio возвращаются только при определённой математике; нулевой/неизвестный знаменатель не превращается в бесконечность. Authoritative result — exact numerator/denominator strings; decimal — presentation до12 знаков, не browser-derived total.
Точный DTO — packages/contracts/src/generic-reports.ts; frontend использует общий контракт, не дублирует свой parser. Measures имеют keys: sum/avg/count_values(fieldId) и count_tasks без fieldId;1–12 уникальных keys.
Неподдержанные measures/group/filter combinations отвергаются явной ошибкой; SQL/код от клиента недопустим.

## Необязательная дата

Без date filter отчёт работает по всему подходящему project scope; native period не создаётся.
При включении Phase1 пользователь выбирает due_date либо custom date-поле и видимые включённые границы from/to; start selector в этом каталоге отсутствует.
Week/month/arbitrary — presets одного фильтра, а не отдельные модели хранения Plan/Fact.
Date-only значения сравниваются как даты без timezone shift; from/to и inclusion rule одинаковы в editor и server query.
Строка без выбранной даты не должна тихо попадать в dated cohort; её excluded/missing-date смысл показывается явно.
Task-level duration не означает число за конкретный день; дневной breakdown не выводится из даты due или даты изменения поля.

## Авторитетный расчёт

Server строит полный разрешённый filtered scope; pagination/sort/collapse/loaded page не меняют totals.
Rows, groups, totals и coverage относятся к одному согласованному расчёту, а не к независимым browser суммам. Full scope ограничен5000 задачами без тихой обрезки; страницы до200 строк. sourceVersion включает workspace head/permission epoch/config/snapshot; expectedSourceVersion защищает продолжение страниц от смешения версий.
Одна canonical task учитывается один раз, даже если она имеет несколько placements в выбранном проектном scope.
Generic value принадлежит canonical task+field; нельзя умножать его на roster, participants или placement rows.
Parent/child независимые значения не равны shared package estimate: включение task rows должно быть явным и без повторного package rollup.
Missing row, typed null и known0 различаются; coverage показывает, какой набор действительно участвовал в мере.
Empty scope и all-missing scope не выдаются как полностью известная сумма0 без соответствующего coverage.

Phase1 attribution — один основной assignee, плюс Unassigned; participants не получают полную копию часов задачи.
Multiple-person split/subject scope не входит в implicit behavior; неподдержанное распределение не выдумывается.
Grouping по single-select использует один option или Uncategorized; authoritative category denominator не удваивается.
Multi-select tags либо не поддерживаются Phase1, либо явно маркируют overlap; их групповые суммы не становятся общим total повторно.
Phase1 groups: none/assignee/status/section/category(single_select); tags — только ALL filter до20 IDs, без overlap groups. Scope — home+active placements проекта, canonical dedupe; значения foreign-home project fields явно missing.

Column totals и отдельная панель group breakdown обычных numeric/duration columns используют тот же authoritative aggregation path; inline footer под каждой визуальной секцией не заявляется.
Phase1 по решению root использует shared project-column aggregate settings с revision/measures; новой named/personal view модели нет. Личная visibility и порядок колонок сохраняются; per-view persistence не заявляется.
Сумма секции работает для обычной колонки, а не исключительно для native Hours Est.
Если full-scope result не готов, UI показывает loading/error/coverage, а не выдаёт loaded-page сумму за полный итог. Неподдержанные table search/participant/individual-status/archive filters скрывают totals с пояснением; пользователь может снять фильтр или настроить поддержанную область в Reports.

## Снимок исходных значений

Пользователь явно сохраняет initial snapshot report configuration и полного task scope.
Capture сохраняет definition revision, field IDs/types, source value revisions/unknown states, task identities и attribution/filter rules.
Snapshot immutable: изменение текущего поля или definition не переписывает ранее сохранённый исходный набор.
New tasks, removed/archived tasks и изменение состава scope показываются отдельно от первоначальной cohort. DTO Phase1 даёт initial/retained/added/removed counts; rows описывают текущий scope, отдельного списка removed rows пока нет.
Unknown original остаётся unknown; позднее значение не становится исходным задним числом.
Снимок не ограничивается текущей страницей и не зависит от текущих названий полей. Capture включает все config-filtered rows независимо от comparison.done_only. Initial comparison берёт original Plan + CURRENT Fact для retained currently eligible tasks; added исключены, missing original не backfill. Initial measures сохраняют весь original scope, включая позднее removed tasks. Groups используют текущего assignee, исходная attribution остаётся в immutable storage.
Snapshot read повторно проверяет текущий доступ; сохранённые IDs не дают обход workspace/project permissions.
Capture не должно скрыто включать manual lock, снимать старую baseline-защиту или сбрасывать usage.
Разрешённость последующего field write определяется обычными правилами, исходный snapshot при этом остаётся неизменным.
Повтор исходной команды возвращает тот же capture, не создаёт новый original.

## Права и безопасность

Report reads требуют текущий reports.read; writes используют fields.manage (owner/admin). Они не раскрывают чужие workspace поля/options/tasks/values через totals/group labels. Query — readonly POST, не write-команда; наличие snapshotId требует проверки принадлежности этому report/project/workspace.
Создание template идёт через существующий field command path; все writers сохраняют history/deadline/quota/owner-exception проверки.
Manual field lock и legacy frozen baseline абсолютны; report/template/import не создаёт новый путь их обойти.
Нормальный owner подчиняется правилам; исключение отдельно подтверждается с reason и audit.
Новые SQL выбирают идентификаторы/операции из server allowlist; значения передаются параметрами, не конкатенацией пользовательского SQL.
Concurrent update/capture, rollback и idempotent replay должны давать целый результат или никакого нового результата.
Ошибки не публикуют скрытые значения, connection strings или технические SQL детали в UI/logs.

## Legacy остаётся отдельно

Native plans/worklogs, personal/weekly freezes, pinned reports и meeting attendance сохраняются как отдельная модель.
Никакой автоматической записи duration из member-period totals и никакой подделки original daily facts.
Первое применение generic template не меняет прежние tasks/logs/baselines/reports и не запускает seed/reset/migration старых данных.
Будущий переход требует owner-reviewed mapping/preview, проверки scope/units/attribution и отдельного разрешения apply.
Существующие meeting/recurrence/private-scope требования остаются в Phase2; их нельзя молча удалить ради простого отчёта.

## Матрица принятия

| Сценарий | Независимый ожидаемый результат |
| --- | --- |
| Budget/Spent и A/B без недели | Обычные duration вводятся без native period; rename не меняет totals/report binding |
| Empty/custom project + opt-in template | Только явно созданные обычные поля/config; нет hidden native values или invented original |
| sum/count/avg | Совместимые типы, точные units/count denominator и coverage;0 не равен missing/null |
| Week/month/arbitrary/no date | Одна явная выбранная date rule; без native period/daily precision invention |
| Full scope + pagination | Rows/groups/footer/totals сходятся с независимым oracle, включая unloaded tasks |
| Assignee/placement/tags | Одна task value учитывается по выбранному правилу; нет roster/placement/tag doubling |
| Immutable initial | После edits/new tasks исходные values/scope неизменны, изменения объяснены отдельно |
| Foreign/deleted fields + revoke | Явная безопасная ошибка/problem state, никаких leaks/rebind by name |
| Field rules через все writers | Deadline/quota/history/owner reason и absolute manual/baseline protection сохраняются |
| Unknown/retry/concurrent/rollback | Exact replay не дублирует definition/template/capture, неполная транзакция не видна |
| Legacy preservation | Старые personal/log/baseline/report/meeting sources неизменны, без flatten/reseed |
| Editor/reload/browser | Настройка сохраняется по IDs; draft/recovery/permission errors не теряются |

Матрица ограниченной Phase1 принята на основании final gates ниже. Ранний focused-source calculator36/36 tests в1 файле,exit0,468мс сохраняет свой исходный source-only scope и не подменяет последующую compiled приёмку.
Точные counts/proofs и ограниченный subset приведены ниже; старая weekly приёмка не переименована в generic.

## Фактическая финальная приёмка

Runtime source — `720cd9e`; final head `5d0e382` включает test-only legacy navigation/label adapters. Финальный isolated build `build-Ovawgo` — PASS: 1 255 source inputs / 932 compiled artifacts / 86 web artifacts, proof SHA `85334047c4704147800b100abb3803566bcee8bc219e0c97bf45ebef8951b02a`. Все932 compiled и86 web bytes идентичны F5cc30; runtime не менялся после720cd9e.

| Фактический final gate на Ovawgo | Результат |
| --- | --- |
| Global `check-global-ByKtYw` | PASS |
| Backend `check-unit-5xCYcx` | 2058 tests /119 files PASS,54,73с |
| Whole web `check-web-mpgUOM` | 2165 tests /266 files PASS,686,26с |
| Compiled Chrome `run-reports-2DQqHb` | 6/6 PASS,25,9с; все cleanup guards true |
| Final full PG integration `check-integration-6eDgf2` | 377 tests /43 files PASS,378,45с |
| Local activation / migration / old-data conservation | PASS,21:44:42–21:45:19UTC18Oct |

Root просмотрел5 PNG предыдущего `run-reports-h1eBgu`/F5cc30. Новая Ovawgo сборка имеет те же932 compiled/86 web bytes; этот просмотр не переименован в просмотр нового run. Chrome использует fake Auth/private PG, не authenticated main/Google/production.

Сохранённая последовательность: первый global RED16 dynamic-translation diagnostics исправлен closed typed maps без exemptions. Второй global RED из-за пропущенного существующего `.d.mts` input исправлен private QA allowlist. Промежуточные global/unit/PG PASS не являются final reruns. Первый native:1 FAIL/5 not run, status422 при конфликте Budget, тело не захвачено; collision preview/Apply guard исправлены без захвата старого поля. Следующий native:3 PASS/1 FAIL/2 not run — тест закрыл уже открытый Filters, исправлен только ensure-open helper. F5cc30 actual6/6 PASS сохранён отдельно от final6/6 выше.

Первый whole web `check-web-LdfrtS` остаётся **RED:2112 PASS/53 FAIL из2165 tests;252 PASS/14 FAIL из266 files;1114,93с**. Все25 generic cases уже тогда прошли. Исправлены только14 legacy route/navigation/label test files, включая8 meaningful negative guards; независимое review не разрешало weakening assertions/deadlines. Focused command дал226 PASS/3 FAIL из229; три вновь достигнутых test seams исправлены отдельно, scoped31/3 PASS плюс198 других ранее прошедших cases дают229 уникальных cases, но не один229-green command. Полный final2165/266 PASS выше — отдельный фактический запуск.

Phase1 не означает завершение всего [86](86-generic-fields-and-reports.md): multi-person subject scopes, recurring/meeting accounting и owner-reviewed mapping старых данных остаются отдельным этапом. Native personal plans/worklogs/freezes/reports не конвертированы автоматически.

Final release certificate: `/private/tmp/workloom-generic-reports-20261018-qa/release-final-814637db-fe15-4815-bb46-885864da13ce.json`, SHA `e2526900c9669abc7e3cc2eb0cdaf686423d1e128fe147f1fdade5683a71640f`. PG proof SHA `5c4f33827f76f21a6ce8eb0034028eb09ebae0d39f176526cd4fc36ae3a806f6`. Activation PASS; proof and boundaries ниже.

Активация: `/private/tmp/workloom-generic-reports-20261018-qa/activation-913d4237-7feb-4967-b28b-7768e8aa8ad7.json`, SHA `4de594a855e7a546754ef6af3c255f12d8c7338a63e0b6df6add7bd01782919e`. Применена только0020:82 прежние+4 новые пустые таблицы =86. Старые rows/columns/ledger/schema и .env/PG/Vite сохранены; workerOFF, API-only restart, owned lock released. Проверены bytes/MIME127 retained+148 new resources. Старые personal plans/worklogs/freezes/reports не преобразованы и не пересчитаны.

Root повторно вызвал CUA getState после активации; kernel environment symlink error произошёл до inventory. Поэтому authenticated main UI, реальная старая вкладка, live Google и production не заявляются.
