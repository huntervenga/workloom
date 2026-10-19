# Inline editing, компактная задача и Undo

**ПРИНЯТО И АКТИВИРОВАНО ЛОКАЛЬНО.** Product commit `cca200a`, 19 октября 2026, `http://127.0.0.1:4310/app`. Предыдущий срез — [89](89-board-sections-and-ordinary-report-demo.md).

Документ описывает текущую реализацию и границы проверки. Candidate K прошёл все семь финальных QA gates; strict local activation завершена 19 октября 2026 в 12:51:39 UTC. Предыдущие RED и неудачные activation attempts сохранены отдельно. Исторические результаты [89](89-board-sections-and-ordinary-report-demo.md) не являются проверкой этого среза.

## Что меняется для пользователя

Обычный путь остаётся Tasks → редактирование значения прямо в строке → автоматическое сохранение. Название редактируется в собственной ячейке; область открытия задачи рядом с названием открывает правую панель. Изменение чисел, duration, перечислений или людей не должно открывать эту панель.

При выделении нескольких строк редактирование ячейки выбранной задачи использует тот же тип редактора и применяет одно значение ко всему выбранному набору. Обычный выбор не превращается в отдельный диалог массового изменения. Сервер проверяет полный набор до записи; отказ по правам, ревизии или правилам не должен оставлять частично применённый набор. Сохранение не делает неизвестные значения нулём и не копирует часы между разными источниками без явного изменения.

Сложные состояния сохраняют отдельный явный Review: конфликт, lock, невалидный сохранённый буфер или неизвестный исход запроса. Это восстановление исходной операции, а не обязательный шаг обычного редактирования. Неизвестный исход повторяется с прежними target/body/idempotency key; открытие Review само по себе ничего не повторяет.

## Колонки прямо из таблицы

В последнем заголовке таблицы находится **+**. Через него можно:

- создать обычное поле с именем и типом; для select задать варианты;
- показать или скрыть существующие колонки, включая Priority;
- открыть изменение порядка и ширины личных колонок;
- открыть настройки определений полей при наличии прав владельца.

Скрытие колонки — личная настройка отображения. Оно не удаляет значение, определение поля, историю или данные отчёта. Поле остаётся доступным в карточке задачи. Поэтому Priority может присутствовать в карточке и быть скрытым в конкретной личной таблице.

Архивация определения в настройках полей — отдельное общее действие для проекта: новые значения больше не принимаются, старые значения и история остаются доступны. Это не кнопка удаления личной колонки и не физическое удаление данных.

Флажок истории при создании поля определяет запись последующих изменений значения. Включение истории позже не придумывает прошлые значения, а отключение не стирает уже сохранённые immutable snapshots. Автосохранение значения и история используют то же определение, field ID и revision, что таблица и отчёты; названия Hours Estimation / Fact нигде не являются специальными идентификаторами.

## Строки и секции

Add task выровнен по началу названий задач. Нижний Add section выровнен по заголовкам секций и создаёт новую секцию там, где пользователь ожидает продолжить список. Верхнее меню добавления сохраняется как дополнительный путь.

При горизонтальном скролле название задачи и видимая подпись секции остаются у левого края таблицы. Секция не должна создавать впечатление смещающейся sticky-колонки. Линия drop placement и существующая drag-карточка сохраняются; порядок Board и Graph из [89](89-board-sections-and-ordinary-report-demo.md) не подменяется новой моделью.

## Компактная правая панель

Сохранённая задача показывает название и status в одной верхней строке. Status имеет доступное имя для клавиатуры и screen reader, без отдельной занимающей место подписи. Уменьшены пустой верхний отступ и пустая строка служебных badges.

Далее идут компактные свойства: Assignee, Dates, Projects, Section, Priority, Tags и Participants; зависимости и обычные custom fields расположены до Description. Description, subtasks и общая Activity продолжают задачу в одном скроллере. Нормальные custom fields больше не спрятаны за More fields и не требуют кнопки Edit. History остаётся доступной отдельно.

Каждое значение использует общий inline editor таблицы и карточки. Scalar редактируется на месте, выбор использует собственный dropdown; обычный edit не открывает Value dialog. Значения сохраняются при выходе из поля или Enter, а choices — после выбора. Незавершённый raw input и конфликт не теряются из-за переключения задач; явный Review сохраняет прежние защитные процедуры.

Dates в карточке — компактное значение с календарём в popover. Используется тот же `TaskDateInput`, что у таблицы: по умолчанию due date, опциональная **+ Start date**, отдельная очистка endpoints, date-only YYYY-MM-DD, общая проверка start <= due. Выход из popover или Enter сохраняет итоговый диапазон одной операцией. Escape отменяет локальную правку даты, закрывает только календарь и возвращает фокус к Dates; parent pane остаётся открытой. Raw дата до commit сохраняется через существующий autosave draft owner и защищена при SPA-навигации и перезагрузке. Приходящий refetch не заменяет opening revision; конфликт не перезаписывает чужую дату. Известный внутренний relatedTarget не считается уходом, даже если Chrome временно оставляет body активным между focusout и focusin. При + Start date новый input получает фокус во время DOM commit; отдельный click не сохраняет диапазон.

Participants в create, More details и сохранённой задаче показывает только выбранные chips. **Add participant** открывает поиск по доступным людям; участник добавляется выбором, удаляется крестиком в chip. Список из 100 людей не разворачивается постоянно в карточке. Уже сохранённая недоступная membership остаётся нейтральной ссылкой: её можно снять и вернуть, без выдуманного имени или нового пользователя.

Desktop pane остаётся немодальной, ниже global header, с существующей анимацией и доступной основной таблицей. Узкий экран сохраняет существующий modal drawer; данная правка не меняет общую модель DialogShell.

## Обычные часы и совместимость

Hours Estimation и Fact — обычные duration-поля проекта. Отчёт выбирает stable IDs этих полей и настраиваемые grouping/filter/comparison; обязательная неделя не появляется. Личные visible-columns настройки не определяют доступность поля в задаче или отчёте.

Нормальная сохранённая задача больше не показывает посторонний legacy Team estimate, hours и не загружает Original estimate для старого work package. Явный `?legacyTime=1` сохраняет старые поля и чтение original history. Старые `/week`, worklogs, freezes, package lineage, receipts и persisted personal-column payload не удаляются и не конвертируются этим срезом.

Create/subtask work-scope остаётся совместимым: detail использует parent package, added scope создаёт собственный. Обычные create, More details и сохранённая задача не показывают legacy Team estimate. Явный legacyTime=1 сохраняет его. Скрытие legacy поля не меняет смысла старой оценки, не переносит её автоматически в пользовательский Fact и не создаёт выдуманного baseline.

## Undo: контракт и честные границы

Текущий поддержанный список: common task update (title, description, status, assignee, start/due, priority, tags, participants и старый package estimate при явном legacy использовании); ordinary custom value; bulk scalar/custom/participants через atomic `changes.restore`; создание задачи → archive; archive → restore; restore → archive. Это не обещание глобальной отмены любого действия.

Task, package, participant и custom-value heads защищены отдельно. Новый `includeFieldValueAck: true` для bulk запрашивает полный подтверждённый custom-value DTO, чтобы строить inverse из сохранённого результата. Старые payload hashes/receipts и обычные ответы без этого opt-in не переписываются.

После подтверждённой поддержанной записи Ctrl+Z / Command+Z вне текстового редактора отправляет новую обратную команду. Пока фокус в input, textarea, select или contenteditable, сочетание остаётся нативной отменой набранного текста. Redo этим срезом не заявляется.

Undo хранится в памяти текущего actor/workspace/project, максимум 100 записей. Переход к другому контексту очищает обычную очередь. После reload или новой сессии прежняя очередь не восстанавливается. Неподтверждённая уже отправленная обратная операция сохраняет защиту и свою exact-retry identity до разрешения исхода.

Для архивирования показывается компактное уведомление с Undo; автоматическое скрытие уведомления через пять секунд не выдаёт архивирование за физическое удаление. Восстановление использует новую серверную команду и текущие права. Уведомление о каждом маленьком успешном edit не требуется: клавиатурная отмена доступна через очередь.

Обратная операция использует известные подтверждённые revision heads. Чужое новое изменение, несовпадение исходной базы, lock или недостаток прав не дают Undo молча перетереть актуальные данные. Другие pending/unknown writes и защищённые drafts должны задерживать Undo; это явное сообщение о блокировке, а не автоматическое rebase. Неизвестный исход обратной команды повторяет уже отправленный body/key, без генерации новой операции.

Первое заполнение ранее отсутствовавшего custom value нельзя представить как физическое удаление истории. Такая отмена пишет новый явный `null` value с новой ревизией: cleared отличается от absent row, нуля, false и пустого списка. UI должен сообщать об очистке, а отчёт сохраняет различие coverage. Undo не обещает восстановить отсутствовавшую строку через удаление из БД.

Undo никогда не отматывает immutable audit/value snapshots, baseline, freeze или ограничение количества изменений. Это новая запись через обычные domain access/revision/field-policy guards; при включённой истории она создаёт новую запись истории и может расходовать разрешённое число изменений либо быть отклонена текущим lock. Исключения владельца остаются текущими серверными правами, а не обходом из браузера.

Поддержка DnD reorder/move, graph layout, schedule composer, импорта и специальных meeting operations этим списком не заявляется; подтверждённая неподдержанная запись устанавливает silent barrier и не позволяет перескочить к более старому Undo. Изменения схемы полей, linked placements, зависимостей, авторизации и любые не включённые в проверенный список операции также не покрыты. Неподдержанная последняя операция должна явно сообщаться и не перескакиваться ради отмены более старой записи.

## Финальная проверка K и промежуточный J

**Authoritative acceptance — K и отдельный strict activation proof ниже.** J сохранён как промежуточная проверка. Документационные правки после активации не изменяют проверенный product snapshot.

Frozen candidate J: `/private/tmp/workloom-inline-ux-20261019/build-941e3a98-5997-4457-84c5-0a7605e3f571`, 1387 source files, SHA-256 source digest `ca496ad9438db6e3bf8567b3b112649f5f3495782f6d8822ea9701749315b0f5`. Build PASS:1022 compiled artifacts. Источник — `source-manifest.json`, артефакты — `build-result.json`; документационные правки после активации не выдаются за исходный compiled snapshot.

| Gate J | Фактический результат |
| --- | --- |
| Build | PASS,1022 artifacts; `build-result.json` |
| Global | PASS, `check-global-0fb8e836-c765-4f15-890e-849383e026d3/` |
| Private compiled Chrome inline | 5/5 PASS, `native-inline-e78caea0-60d6-46ae-9060-0b1bcd4b8795/` |
| Private compiled Chrome Board/Graph | 2/2 PASS, `native-board-5bfd6c1b-b40b-45f6-ad0f-b5e4cdfbe78f/` |
| Root unit J | 2077/2077 tests,120/120files PASS,130.07s; `check-unit-a3a6aac8-34e6-41a6-a9fd-93caedd8fe9b/` |
| Private compiled Chrome Reports J | 6/6 PASS,27.4s; `native-reports-029a9496-5b14-4c40-8955-724701f40415/` |
| Full private PostgreSQL integration J | RED:384PASS/4FAIL,42PASS/3FAIL из45files,670.34s; `check-integration-835727b0-d8fd-4cbc-b1a6-dc7534208a1a/` |
| Whole web J | Не запускался как финальная приёмка; authoritative K ниже |
| Local activation J | Не активировался как отдельная принятая версия; окончательный K activation ниже |
| Main existing-session UI after reload | NOT CHECKED for J |
| Fresh login/live Google/real old-tab/production | NOT CHECKED |

Candidate K: `/private/tmp/workloom-inline-ux-20261019/build-f108101c-3186-4d09-aacc-f68490a52070`, digest `e0ba3d954c7b365345ea55b38349224699a975ff3463514cde706d2eded38a62`. Build PASS1022 artifacts; все compiled artifact names/hashes совпадают с J. Source delta состоит только из test fixtures `tests/integration/cutoff-automation.test.ts` и `tests/integration/task-bulk-undo.test.ts`. Совпадение bytes не выдаётся за повторные browser commands: отдельные фактические K native runs перечислены ниже.

| Gate K | Фактический результат |
| --- | --- |
| Global | PASS, `check-global-acf015cc-d9fa-4cc5-a412-3ff57e3bf845/` |
| Root unit | 2077/2077 tests,120/120files PASS,65.04s; `check-unit-cfcda398-33f0-44d4-b5a3-cac5e2a56ae5/` |
| Focused private PG | RED:46PASS/1FAIL,210.02s; `check-integration-focus-a86a2318-2969-48ee-882d-1f2526024e1c/`. Все21cutoff и6Undo PASS. Единственный FAIL — первый p3b case достиг120s; второй p3b PASS9407ms. Это не full PG. |
| p3b isolated diagnostic | Два прежних case PASS89.751s/3.882s, отдельный `/private/tmp/workloom-inline-ux-20261019/p3b-diagnostic-k/result.json`, exit0. Это диагностика, не full PG acceptance и не переименование focused RED. |
| Baseline c4 full20case comparison | RED:18PASS/2FAIL, `/private/tmp/workloom-inline-ux-20261019/p3b-diagnostic-c4-full/`. Это сравнение прежнего baseline, не PASS и не доказательство performance fix. |
| Full private PG K | 388/388 tests,45/45files PASS,349.84s; `check-integration-5b060340-a8f5-4893-8973-60b1d051241d/`. p3b20PASS, первые два case59938ms/3734ms. Wrapper `/private/tmp/workloom-inline-ux-20261019/full-pg-execution-3dfc3a0d-501e-440d-a9a2-18c83e2a4fe0/receipt.json`:exit0,completedtrue,checkPasstrue. |
| Whole web K | 2274/2274 tests,276/276files PASS,955.21s; `check-web-c6ba8ee6-4910-42cf-8f9f-dd5061025943/` |
| Private compiled Chrome inline K | 5/5 PASS, `native-inline-ffc08de8-2a9f-4dcd-a49c-febc82ec7455/` |
| Private compiled Chrome Board/Graph K | 2/2 PASS, `native-board-8b98f8d7-7d7b-4b4c-ab2a-b702a370f64f/` |
| Private compiled Chrome Reports K | 6/6 PASS, `native-reports-19a96ffd-ca1c-45ce-8e12-73421bf83cad/` |
| Product identity | `cca200a`; root проверил, что source bytesK не изменены. Ksource digest выше не заменяется commit hash. |
| Actual local activation / main UI | Strict activation PASS, 12:51:39 UTC, доказательство ниже; main existing-session UI after reload NOT CHECKED |

Native здесь использует disposable PostgreSQL и синтетический first-party Auth provider, без main Chrome profile или данных основной БД. Это не реальный Google-вход и не production evidence. Inline5 покрывает обычные single/bulk values, light/dark table chrome, compact pane dates/participants/nonmodal table и keyboard Undo/archive toast. Отдельные команды не складываются с ранними перекрывающимися попытками в придуманный distinct-case total.

В J обычный custom-field ACK отменяет/согласует старые query reads, чтобы удержанный до записи GET не откатил подтверждённое значение. Route regression:150 →180 при удержанном GET →Undo150/null. Focused helper/recordUndo13PASS относится к этой коррекции; первоначальные76PASS/2RED из78 остаются историей fixture staleTime=0, исправлены с сохранением assertions. Это не полный web gate.

## Сохранённая хронология RED и промежуточных проверок

Все пути ниже относительно `/private/tmp/workloom-inline-ux-20261019/`, кроме явно указанных внешних review folders. Ни один RED не переименован в PASS; успешный следующий кандидат проверяет уже исправленное дерево.

| Попытка | Фактический результат и исправление |
| --- | --- |
| A `build-04588e1c-2f83-43b6-aa8f-dd1ba1e801f7` | Build RED: mirror не сохранил workspace dependency topology, `@fastify/static` не разрешался. `build.log`, нет успешного build-result. Исправлен приватный snapshot helper; production dependencies не переписаны. |
| B `build-8b21b603-92e8-4bb5-a11b-54a72b7fed0a` | Build PASS; global RED9 ESLint violations (void-union/non-null assertions): `check-global-5758d042-3ea8-4d97-bd36-33819ea3daf5/`. |
| C `build-852252f1-70de-431a-8a90-d05a0d66f238` | Build PASS; global RED6 localization audit violations: `check-global-4c3fe0fb-a92c-414c-a724-674e8c2cfcc4/`. Styling/dynamic key annotations и internal machine codes исправлены; нет утверждения об исправлении уже сохранённого C proof. |
| D `build-ae8cdca0-cf69-4402-b493-73f2fa0a8828` | Build/global PASS. Whole-web сначала653PASS/1613RED из2266,69PASS/206RED из275 files,220.70s при ошибочном production React test environment: `check-web-2f7892fa-64dd-4c79-8f09-75065deaae93/`. Затем правильный test environment:2265PASS/1RED из2266,274PASS/1RED из275 files,1000.22s: `check-web-5abfe34d-85a6-4640-9f3e-66a204c154df/`. Единственный RED — localization legacy estimate fixture без showLegacyEstimate; исправлен одним prop, assertions/deadlines неизменны. Private inline1PASS/1FAIL/3not-run: `native-inline-c486afdc-d56f-40b7-8d9e-ad30255e49fa/`; section fixture readiness исправлена. |
| E `build-ea1cc269-093c-4362-a5d6-190e0c992384` | Только build PASS; отдельные gates не заявлены. |
| F `build-71c5b048-155e-479d-b183-d1806543f713` | Inline3PASS/1FAIL/1not-run: `native-inline-eeaddac3-3291-4c6a-8024-f72873ac65af/`; +Start исчезает после premature PATCH. Первый layout-focus fix дал18 focusedPASS, но не являлся native acceptance. |
| G `build-24566b8f-7903-4585-9f59-61574899b0f7` | Inline2PASS/3FAIL: `native-inline-4b3e2ba1-7768-45bd-85fa-ae03caff3a4e/`. Два product defects: stale custom ACK/read race и тот же date focusout; третий — synthetic JWKS key rotation при worker restart. Browser diagnosis `date-diagnostic-a9f97516-06b5-4d47-be06-f54f97f6b42b/diagnostic-manifest.json` привязан к неизменённому G. Chrome доказал BODY checkpoint до focusin известной внутренней кнопки, затем PATCH200 до pointerup/click. Исправлен relatedTarget guard; focused dates19PASS, это отдельно от native gates. |
| Provider probe | `provider-key-probe-8abbd2d0-4c8e-40bc-8331-d14ab1d5572f.json`:PASS, два fresh processes используют одну synthetic public JWKS, два invalid-path guards отклонены. Не проверка real Auth или Google. Ключи/fixture содержимое в документацию не копируются. |
| H `build-5f079199-ecf1-492e-b703-afbb2796ca64` | Inline4PASS/1FAIL: `native-inline-2835fbae-69af-4456-af42-b08dff408394/`; Undo oracle нажимал до получения ACK, ориентируясь на optimistic preview. Диагностический fifth-only повтор1PASS на неизменённом H после ACK readiness: `diagnostic-fifth-1556d19d-f7e5-493a-8aeb-96575928ced5/`. Это не исходный H5PASS. |
| I `build-ddeb1503-0637-4eb8-90b8-0f73fed05928` | Только build PASS; отдельные gates не заявлены. |
| J | Build/global/unit/native inline5+Board2+Reports6 PASS; полный PG384PASS/4FAIL остаётся историческим RED, не переименован после нового KPASS. |
| K | Только два PG test fixtures исправлены,1022 runtime artifacts byte-identicalJ. Ранний focused PG46PASS/1FAIL сохранён; isolated p3b2PASS и baseline c4 18PASS/2FAIL не подменяют его. Позднейший новый FULL K PG388/45 PASS отдельным command/receipt, без product performance fix или deadline relaxation. Все семь окончательных gatesK PASS; последующая strict activation PASS отдельным proof ниже. |

## Scoped reviews Claude Opus: три Undo и отдельный ACK follow-up

Все четыре запуска — authenticated subscription CLI с явным `--model opus --effort high`, фактическая модель `claude-opus-5-5`, exit0/success. Переданы только allowlisted code/test excerpts, без .env, секретов или PostgreSQL contents; tools/MCP отключены. Модель не запускала тесты. Это scoped reviews Undo/ACK, не blanket approval всего продукта или запуск тестов моделью.

1. `/private/tmp/workloom-opus-undo-review-uen5qhtf/`:17files108922bytes, prompt SHA `7d14fcf4a9c401f24ee4bbcf3bc8991094a795acde5d6166dcd140ebe1133cc4`. Position/unknown-key inverse, unsupported ACK barriers и writable lifecycle отмечены и исправлены позже. Snapshot предшествует ACK bus; conditional normalization concern не подтверждён, participant no-op совпадает с прежним контрактом.
2. `/private/tmp/workloom-opus-undo-ack-review-u9p0b8yg/`:20files151198bytes, SHA `744b3b286a624fc6495540f501c7aaa22e8f17dafb88665482c8fa3ffa5d0cbb`. Первые исправления подтверждены; новыеA observer failure после confirmed write,B readonly ACK boundary,C actor retry/late ACK были исправлены автором. Пять файлов изменились после snapshot до следующей correction closure; это историческая проверка прежних bytes.
3. `/private/tmp/workloom-opus-undo-closure-zkienx2u/`:9files48595bytes, SHA `185a7b2f6f696463b498cb4d86c8d21a4c5852f84eb97475c7d33ca8ed4b97d5`. Five core files, two tests, two callback-only excerpts. Ответ: все три scoped defects исправлены, correction-induced regressions не найдены. При завершении9/9 full-file hashes совпадали. Позднее в D7/9 неизменны,2/9 изменены только internal English→machine diagnostic literals (`useIdempotentMutation.ts`, `mutationDiagnostics.ts`), точные hashes/patch в `post-review-source-d-drift.json` и `post-review-source-d-diagnostic-literals.patch`. `recordUndo.ts` не входит в final9; не выдавать callback excerpt за whole-file review. Более поздние actual Chrome date-focus и custom ACK cancel/reconcile product fixes проверены root/тестами, а не этим Opus snapshot.

4. `/private/tmp/workloom-opus-field-ack-review-2pd1_5c3/`: отдельный post-fix ACK/cache follow-up,13source/test files (9full+4line slices),69010promptbytes,SHA `d0031ed7ccf588b213f61b78cb0fbbb1f8d40cc612e5f2d4759fbcc1c2f2bacd`. Явный opus/high, actual `claude-opus-5-5`, Claude Max firstParty OAuth subscription verified,exit0/success. Все13full-file hashes совпадают с K после review. Concrete product defect не найден. Условные UUID casing/observer failure замечания triaged без спекулятивных правок; дополнительные observer/read тесты и Response.clone fixture improvement остаются advisory/test coverage limitations, не воспроизведёнными defects. Полный independent wording, реальные CLI outputs и границы — `findings.md`, `triage.md`, `manifest.json`. Это отдельная проверка новой ACK reconciliation, не заднее расширение старого9-file snapshot. Date-focus native fix ею не покрыт.

## Strict local activation и сохранение данных

Product source HEAD — `cca200a`; accepted K digest — `e0ba3d954c7b365345ea55b38349224699a975ff3463514cde706d2eded38a62`. Документационный commit будет отдельным; он не подменяет исходные source/compiled hashes.

Финальный strict release manifest: `/private/tmp/workloom-inline-ux-20261019/release-strict-k-readiness-fixed-43fb4080-171a-4f6b-abfd-80da83934382.json`, SHA-256 `506d7eb4be5ab6e71eaa4ba8ba26e7e2477eaf3ebf46ec27340149d02650c1fe`. Он связывает семь фактически успешных result files с K source digest и buildManifestSHA `ceeaff6bceecbe7c860817a71e23ca7c47f53e455bd4a455e310b8dbe0e51590`. Qualified alternative не использован.

Actual activation PASS: `/Volumes/PavelData/ai/workloom/.local/backups/inline-activation-ca0f6429-ff39-4548-bd9f-e2adfe98af6e/result.json`, завершение `2026-10-19T12:51:39.004Z`, helper SHA-256 `4e573f016ae453091622dc5562140883f8cd2611685c5414b5af45468d5138e9`.

- Миграций не было. Все 86 table/ledger digests и schema остались прежними; `database-before.json` и `database-after.json` идентичны, SHA-256 обоих `3eb5919a0ad3b7bff30dc713764bbad05f2127d7052117724fe813b7e84f9e95`. Отдельная проверка sequence counters не заявлена.
- Существующие workspace, Team delivery demo, обычные поля и сохранённые отчёты сохранены вместе со всеми прежними данными; reseed, импорт, конвертация legacy или новый initial snapshot не выполнялись. Reports route не менялся.
- `.env`, PostgreSQL и Vite сохранены; worker OFF. Перезапущен только owned API: PID 48904, start `Mon Oct 19 15:51:36 2026` EEST. Последующий doctor подтвердил готовность PostgreSQL/API/web и worker OFF.
- Прежний HTTP inventory содержал 226 resources: 224 non-HTML public resources сохранены и проверены по bytes/MIME, а два HTML entrypoints обновлены и проверены отдельно. Helper проверил весь merged набор прежних и новых ресурсов; новое общее число здесь не заявляется. Старые hashed ресурсы сохранены вместе с новой сборкой. Сам по себе root HTTP200 не использовался как достаточная проверка приложения.
- До promotion создан `main-before.dump`; SHA-256 `38fadc3b846a0ecbbecce830d7a29395d0a537aaf90579b3463bbf7f4518e2b0`. Backup contents не являются частью документации или model review.

Это локальная активация, не production deployment. Данные сохранены proof-ом; main existing-session browser journey после reload этим не подтверждён. Disposable private QA environment впоследствии остановлен root через `qa.mjs stop`, `cleanup:true`; основной локальный runtime на 4310/4311/55432 остался ready, worker OFF.

### Предыдущие activation attempts и исправления private helper

Первые две strict attempts завершились отказом во время staging до API stop. Private activation directories/result metadata сохранены; первая причина не была поймана исходным log, и её нельзя называть установленным временным сбоем. Read-only sentinel `/private/tmp/workloom-inline-ux-20261019/preflight-readonly-b4871179-65de-4389-a96c-a9539f303a42/result.json` прошёл только до `before-operation-lock`; он не проверял весь activation staging и не был activation PASS.

Позднейший cause proof: `/private/tmp/workloom-inline-ux-20261019/staging-cause-proof-d1d31541-affa-4237-bd53-3a11ce1c8afa.json`. Identical public files, скопированные в private staged tree с mode0400, нельзя было повторно перезаписать через copyFileSync: EACCES. Private helper теперь пропускает идентичные bytes и заменяет только staged HTML через unlink; main resources не chmod-ились. Exact staging diagnostic проверил 1022 compiled artifacts и сохранение 224 прежних public resources. Это коррекция local helper, не изменение продукта или разрешений main-файлов.

Третья попытка: `.local/backups/inline-activation-b9cb70de-d989-4cb3-9b1f-2e248f372ec4/result.json` — failed `restart-owned-api` с TypeError; исходная receipt `requires-root-inspection` сохранена. Точный прежний exception message и network cause не пойманы и не выдумываются. Последующий read-only `/private/tmp/workloom-inline-ux-20261019/post-rollback-audit-1bbf5a1a-1f06-4d37-a058-e96da3f0fd9b/result.json` подтвердил прежние 86 table/ledger digests и schema, `.env`, runtime state, восстановление прежнего HTML и compiled contracts/db/domain. Это отдельная проверка после rollback, не переименование третьей попытки в PASS.

Readiness helper раньше выпускал fetch/JSON exception из bounded loop. Исправленный ready() возвращает false при этих ошибках, сохраняя loop/deadline и прежние проверки healthy status/database/schema. Извлечённая pure function прошла 7/7 probes без сети/main mutation: `/private/tmp/workloom-inline-ux-20261019/readiness-probe-1fa0792b-d050-48c5-a665-40aae5be2ff9/result.json`. Это не доказательство точной причины старого TypeError. После этих helper-only corrections strict activation успешно повторена отдельной финальной попыткой выше. Product/test/runtime bytes не менялись; новый app build не выдаётся за выполненный или необходимый для исправления private helper.

## Границы итоговой приёмки

Root просмотрел K compact-pane и dark-table screenshots. Private compiled Chrome — три отдельные команды 5/5 inline, 2/2 Board/Graph и 6/6 Reports с fake Auth; это не существующая реальная пользовательская Chrome-сессия. Повторный main UI после reload не выполнен: CUA недоступен из-за environment symlink/writable-root error до проверки интерфейса.

Не проверены и не заявлены: main existing-session UI после reload, fresh real Auth/Google login, actual old-tab upgrade этого checkpoint, production/Railway deployment, физический touch/IME, Safari. Межпроектные/legacy ограничения из [88](88-generic-report-implementation-contract.md) и [89](89-board-sections-and-ordinary-report-demo.md), Phase2 generic reports и legacy mapping не становятся завершёнными от нового inline UX. Быстродействие recurrence не объявляется исправленным на основании повторного PG PASS.

Наличие локального backup и сохранение данных не заменяют отдельную проверку hosted restore. Следующие release gates и операторский порядок остаются в [84](84-team-pilot-plan.md) и [85](85-hosted-runtime-preparation.md). Все исторические результаты [89](89-board-sections-and-ordinary-report-demo.md) сохраняют свой прежний scope.
