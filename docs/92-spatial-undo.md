# Undo перемещений задач и дат

**Реализуется; финальная compiled/PG/native приёмка ещё не записана.** Это расширение [90](90-inline-editing-compact-pane-and-undo.md), а не изменение его исторических результатов или локальной активации. Текущий принятый срез до новой приёмки остаётся указанным в AGENTS.md.

## Поведение

После подтверждённого перемещения задачи в таблице или Board Ctrl+Z / Command+Z отправляет новую обратную команду. Возвращаются точное место и та часть группировки, которую изменило перемещение: исполнитель, статус или секция. На Timeline/Gantt отмена возвращает исходную пару дат. Сначала нужно получить подтверждение сохранения; pointer preview и ещё выполняющийся запрос не считаются сохранённым действием.

Сочетание работает через общую очередь проекта из90. В input/textarea/select/contenteditable оно остаётся нативной отменой текста. Во время защищённого draft, другой pending/unknown команды или чужого конфликтующего изменения Undo не перескакивает к более старому действию. Оно показывает существующее сообщение о блокировке. Redo не добавлен.

Очередь остаётся в памяти actor/workspace/project, до100 записей. Reload и смена контекста не сохраняют обычную очередь. Уже отправленная обратная команда с неизвестным исходом сохраняет собственную exact-retry identity и защиту до разрешения исхода; новый пользователь не получает права повторить её.

## Таблица и Board: серверная исходная запись

Загруженные строки не определяют полный порядок проекта: существуют другие секции, подзадачи, скрытые фильтром, архивные и ещё не загруженные задачи. Поэтому браузер не придумывает обратный anchor и не присваивает старую числовую позицию одной строке отдельно от сдвинутых соседей.

Новый UI запрашивает `captureUndo: true` у существующего `POST /tasks/:taskId/move`. Только этот opt-in добавляет `moveUndo` в отдельный `MoveTaskDto`. Обычный TaskDto, task history и list JSON не получают новый системный столбец. Если opt-in отсутствует, прежний parsed input/hash, результат и exact receipt replay остаются прежними.

В одной workspace-barrier транзакции сервер сохраняет:

- обычный результат `task.move`;
- внутренний actor/workspace-scoped источник `task.move.undo-source`, под настоящим Idempotency-Key исходного move;
- точные исходные числовые позиции всего проекта, включая ties/gaps и архивные строки, и исходные section/parent/assignee/status самой перемещаемой задачи;
- fingerprint полного порядка и группировки после записи;
- публичные `beforeHeads` / `afterHeads` только тех строк, чьи core revisions изменились.

Источник не содержит названий, descriptions, дат, custom values, участников или оценок. Он остаётся на сервере. Публичный ACK содержит идентификаторы и подтверждённые ревизии, исходный ключ и непрозрачный fingerprint. Перемещение без изменения состояния не создаёт источник. Для такого no-op поддержанная обратная операция не обещается.

`POST /tasks/:taskId/restore-move` принимает только guards: `originalMoveKey`, `expectedOrderFingerprint`, `expectedRevision` самой задачи и `expectedHeads` каждой исходно затронутой строки. Клиент не передаёт восстановленные позиции или группировку как доверенные данные.

Сервер заново проверяет текущую membership/capability, существующий собственный источник, задачу и проект до exact replay. Перед новой записью он проверяет полный семантический fingerprint и точный набор/значения core heads. Содержимое источникa и текущие строки читаются под barrier. После обязательного planning guard порядок и heads проверяются снова: prerequisite не может незаметно заменить базу восстановления.

Восстановление использует текущие status/dependency, assignee, section и meeting ограничения и обычные audit/outbox. Все строки меняются атомарно; поздняя ошибка откатывает также уже изменённую source task, соседние позиции и inverse receipt. Названия, даты, package/participants/custom values берутся из текущих строк и не переписываются исходным снимком. Старые ревизии, события, baselines и счётчики изменений не возвращаются назад.

### Конфликты и последовательность

Fingerprint включает все project IDs, позиции, parent/section/assignee/status/archive. Он не включает titles, descriptions или revisions. Отдельные core guards всех исходно сдвинутых строк всё же консервативно блокируют чужую правку этих строк, даже если менялся только title. Это предотвращает ошибочное продвижение более старого Undo до ревизии чужого изменения.

Наше подтверждённое изменение и его собственная обратная команда могут продвинуть известный head. Поэтому M1 → M2 → Undo M2 → Undo M1 и move → title edit → Undo title → Undo move не требуют сбрасывать очередь. Продвигаются только те heads, которые проверены сервером и действительно возвращены после восстановления; refetch не служит разрешением заменить guard новой ревизией.

Новый opt-in ограничен **5000 строками полного проекта**. Проверка выполняется до предложенных move writes. Snapshot, публичные head arrays и `expectedHeads` также ограничены. Этот предел не добавляется в старый API-вызов без captureUndo. Чужая перестановка/группировка в полном проекте может консервативно заблокировать Undo независимо от того, видна ли строка в текущем фильтре.

## Gantt и Timeline

Используется существующий протокол [72](72-gantt-date-move.md): forward preview сохраняется неизменяемым вместе с конкретной отправкой, а ACK даёт подтверждённые task revisions. Поздний cache/context read не подменяет исходные даты.

Обратная команда сначала делает keyless `schedule-preview` с исходными date-only значениями и известными подтверждёнными heads, затем один `schedule-apply` для всего набора. Это тот же авторизованный атомарный путь, что обычный date move: cutoff/meeting/archive guards, актуальные dependency comparisons, preview freshness и shared barrier сохраняются. Новый серверный endpoint для дат не нужен. Автоматического cascade/rescheduling соседних задач нет.

Исходные `null` endpoints сохраняются: due-only точка не получает выдуманный start, start-only не получает due. Разные диапазоны нескольких строк восстанавливаются одним all-or-none apply. Неполный, дублированный или чужой ACK не считается успешной отменой. Новые protected/recovery targets не отправляются как предложенные даты.

После подготовки inverse apply body его previewHash/rows/key замораживаются. Неизвестный исход повторяет этот exact request; повторного preview и подстановки новых source heads для уже отправленного apply нет. До отправки apply неуспешный keyless preview может быть повторён только с теми же исходными dates/expected revisions.

## Graph

Дополнительная поддержка касается **подтверждённого сохранения** личной раскладки: Save my layout, сохранённый reset и automatic layout. Полный предыдущий набор координат и независимая layout revision фиксируются до отправки. Обратный `set-layout` восстанавливает весь набор, включая позиции скрытых nodes; если до первого сохранения позиции отсутствовали, отправляется действительно пустой набор.

Подтверждённый полный layout ACK синхронизирует существующий actor-scoped cache до следующего сохранения. Старый GET отменяется до merge; более новая сохранённая revision не откатывается при cancellation. Сравнение revision действует только внутри одной workspace/project/membership/viewKey identity. Удалённый при смене пользователя cache не создаётся повторно. Обратный ACK использует тот же путь; два последовательных подтверждённых Save не зависят от скорости GET refetch.

Локальное перетаскивание Graph до Save остаётся draft с существующим Discard moves и защитой. Отдельная локальная Ctrl+Z-история черновых координат не добавляется. Координаты Graph не становятся датами, порядком задач, effort или availability.

## Проверки и provenance

Новые исходники проверок:

- [frontend move Undo](../apps/web/src/features/undo/recordMoveUndo.test.ts): все shifted heads, свой edit/inverse chain, чужой конфликт, malformed ACK и exact unknown retry;
- [schedule/layout Undo](../apps/web/src/features/undo/recordSpatialUndo.test.ts): nullable endpoints, атомарный набор строк, preview blockers, immutable retry, полный/пустой layout;
- [confirmed layout cache](../apps/web/src/features/dependencies/layoutReceiptCache.test.tsx): held stale GET, cancellation/newer-head race, actor/membership isolation, два быстрых сохранения и две обратные команды;
- [domain move tests](../packages/domain/src/tasks/service.test.ts): ties/gaps/archive, группировка, legacy omission/no-op, последовательные M1/M2, shifted sibling guard и поздняя ошибка;
- [isolated PostgreSQL](../tests/integration/task-move-undo.test.ts): настоящие транзакции/receipts/audit, последовательные reverses, actor/core guard и rollback после SQL trigger fault;
- [private native Chrome](../tests/e2e/spatial-undo.spec.ts): настоящее mouse+keyboard для assignee/table, Board и nullable Gantt; исходный HTTP ACK и доступный control обязательны перед клавишей Undo.

Предварительные source-alias запуски дали backend **211/211 в3files**, web **46/46 в5files**. После них были добавлены current-target-before-replay check и расширение adapter recording-double/catalog; это не финальный gate текущих байтов. Первый owned lint нашёл один неиспользованный test type import, он удалён; итоговый lint нового snapshot ещё должен быть записан. При первых source-alias запусках PostgreSQL/native источники выше ещё **не запускались**; последующие ограниченные PG-результаты и native A startup RED записаны ниже. Отдельный финальный compiled manifest и результаты добавит координатор; source-тесты и наличие файла не выдаются за production/browser PASS.

Часть server implementation создана через подписочный Claude CLI: явный `--model opus`, фактический modelUsage `claude-opus-5-5`, exit0, code-only private mirror. Исходный prompt/result/source manifests сохранены в `/private/tmp/workloom-move-undo-opus-20261019/`. Последующие Codex corrections добавили обязательные all-row expectedHeads, bound5000, post-planning revalidation и HTTP wiring. Ранние неудачные CLI-вызовы также сохранены; модель и результаты задним числом не переименованы.

Новая Undo-функция не требует миграции. Производственная активация, реальные внешние Auth/Google, main existing-session UI и old-tab upgrade этим документом не подтверждаются. Миграция0021 относится к отдельной availability/time-off функции и не является зависимостью Undo.

### Дополнительная изолированная PG-проверка до финального B

19 октября2026: три новых PG-сценария прошли **3/3, один файл,2.47s, exit0** на отдельном backend-owned PostgreSQL60652. Каждый файл создал и удалил собственную throwaway child database; кластер и main database не останавливались. Использовались compiled libraries из `/private/tmp/workloom-leave-backend-check-20261019/build-236a75d3-41dd-4c53-9085-016125c6c265/source`. Это отдельная ограниченная PG-проверка, не полный integration gate.

Proof: `/private/tmp/workloom-move-undo-opus-20261019/pg60652-result.json`; log SHA-256 `a1376ad55703665d7d89817c4397cca6c2b931b2890505eb75937399d302402e`; compiled task-service SHA-256 `3b9fc927a51d3cb0e7f3b66c7393ffb427181ec828fee5dd219e894bb8ea7173`. Source service/helper/contracts в этом mirror побайтово совпали с текущей move implementation. Отдельная последующая аннотация `userId: string` в test fixture исправила только owner-literal TypeScript inference; test body не изменился.

Первый root native A завершился **RED до test body**:1 failed/2 not run,0ms. Приватный fake-Auth helper разрешал только прежний QA-root и отказал новому owned `/private/tmp/workloom-time-off-20261019`. Product-сценарий не запускался. Log сохранён в `/private/tmp/workloom-time-off-20261019/build-e1f50a5e-fcb9-435c-9ddd-c1d04dba209b/native-spatial-3051890b-6b0f-40ff-abcd-da175da2aade/native.log`. В исходнике разрешены ровно два известных private roots с UUID filename; realpath/owner-only/O_NOFOLLOW/regular-file/key checks сохранены. Frozen A не исправлялся на месте; повторный native run должен привязываться к новому snapshot.

### Confirmed Graph cache follow-up before B

Независимый source-alias run после cache correction: **13/13 PASS в трёх файлах,3.17s, exit0** (`layoutReceiptCache`, `recordSpatialUndo`, `layout-reset`). Включены два последовательных confirmed Save при незавершённых старых GET и две обратные команды до действительно пустого набора. Четыре затронутых web-файла прошли ESLint, общий source-aliased web `tsc --noEmit` завершился exit0. Это ограниченные source checks; native/compiled acceptance по-прежнему требует финального snapshot.

Proof: `/private/tmp/workloom-move-undo-opus-20261019/graph-cache-check/results.json`; test-log SHA-256 `34f92899c88116bd28c031ac7f6c641ff2ca681a4e3bbc7a64534fd1f71c7569`. Новая логика не меняет server receipt или Graph DTO: подтверждённый полный ACK синхронизирует только существующий exact actor-scoped cache.
