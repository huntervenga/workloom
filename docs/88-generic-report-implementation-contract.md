# Обычные duration-поля и конфигурируемые отчёты: Phase1

**IMPLEMENTING — контракт следующего среза, не приёмка.**18 октября2026.
Основание — подтверждённое направление [86](86-generic-fields-and-reports.md).
Обычные custom duration/number/date-поля уже существуют; новый результат — понятный Plan/Fact template, report editor/query и generic aggregates.
Нет заявления, что builder, новые API, snapshots или migration уже проверены/активированы.
Текущий section web checkpoint [87](87-project-section-creation.md) не является приёмкой этого продукта.

## Один обычный проект

Пустому проекту не нужны personal period, week или native Worklogs, чтобы хранить duration.
Пользователь создаёт поля Budget/Spent, A/B или любые другие; server использует field IDs/type, не названия.
Duration хранится в целых минутах по существующему контракту, UI показывает понятные часы/минуты.
Rename сохраняет ID; delete/archive оставляет историю; recreate одноимённого поля даёт новый ID.
Старая definition/report не перепривязывается автоматически к новому полю по имени.
Native package estimate и native weekly plan/fact не подставляются в эти колонки скрыто.

Opt-in Plan/Fact template создаёт обычные duration-поля и конфигурацию сравнения.
Перед подтверждением видны создаваемые поля; существующие поля не захватываются по совпадению имени.
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

Footer/group aggregates обычных numeric/duration columns используют тот же authoritative aggregation path.
Phase1 по решению root использует shared project-column aggregate settings с revision/measures; новой named/personal view модели нет. Личная visibility и порядок колонок сохраняются; per-view persistence не заявляется.
Сумма секции работает для обычной колонки, а не исключительно для native Hours Est.
Если full-scope result не готов, UI показывает loading/error/coverage, а не выдаёт loaded-page сумму за полный итог.

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

Общая приёмка строк pending до final compiled/PG/browser и root acceptance. Отдельно root выполнил focused-source calculator36/36 tests в1 файле,exit0,468мс: generic types erased, существующий field-value runtime export; новый compiled backend этим не заявлен.
Новые counts/proofs и точный реализованный subset будут добавлены отдельным итогом, без переименования старой weekly приёмки.
