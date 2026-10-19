# Отпуска, рабочая ёмкость и Undo перемещений

**ПРИНЯТО И АКТИВИРОВАНО ЛОКАЛЬНО.** Product commit `c228181`, Candidate E, 19 октября 2026, `http://127.0.0.1:4310/app`. Все девять финальных gates прошли на одном замороженном source/build. Контролируемая локальная активация завершилась **18:43:20.508 UTC**: только0021, 86→94 таблицы, 21→22 ledger, прежние данные и ресурсы сохранены. Это отдельная локальная приёмка; real Google/Auth, authenticated main UI, real old-tab и production не проверены.

Этот документ и обновлённые указатели — **docs-only delta после** product commit и его source/build proofs. Указанный ниже digest относится к проверенному продуктовому snapshot до этих документальных изменений. Предыдущие RED сохраняются как история.

При активации восемь новых leave-таблиц были пусты. Политики, профили, остатки и заявки в main автоматически не создавались; private QA fixtures туда не переносились. Владелец должен сам применить шаблон и указать реальные даты найма/начала учёта и остатки. Действий от имени владельца и выдуманных персональных данных для настройки main не выполнялось.

Предыдущая принятая локальная версия описана в [90](90-inline-editing-compact-pane-and-undo.md). Контракты новой функции — [91](91-time-off-and-capacity.md) и [92](92-spatial-undo.md). Ниже — финальные доказательства, сохранённые RED и точные границы проверки.

## Что получает команда

Раздел **Time off** работает на уровне workspace. Владелец настраивает виды отсутствия, начисление, перенос/сгорание, общие выходные, рабочие графики и права согласования. Шаблон «21 день отпуска +10 гибких дней + неоплачиваемое отсутствие» применяется только явным действием и остаётся редактируемым. 31 декабря/1 января — отключаемые общие выходные без списания личного баланса.

У сотрудника есть даты работы, дата начала учёта, начальные остатки и график с часовым поясом. Заявка хранит конкретный вид отсутствия и включённый диапазон дат. Списываются только запланированные рабочие дни вне общих праздников. Утверждённые дневные списания сохраняются: поздняя правка календаря не переписывает их незаметно. Начислено сегодня, уже использовано, будущие резервы и прогноз на явно показанную дату разделены.

Настройки независимы: `pausesAccrual` останавливает начисление оплачиваемых пулов за календарные дни интервала, включая выходные; `capacityUnavailable` убирает соответствующие рабочие минуты из доступной ёмкости; `consumesBalance` отдельно определяет списание личного баланса. В шаблонном неоплачиваемом виде включены первые два флага и выключено списание, но каждый из них можно изменить отдельно. Администратор может внести прошлый интервал с причиной; расчёт меняется, история и прежние отчётные snapshots сохраняются. Минус требует разрешающей политики/лимита и отдельного согласия работодателя. Отрицательный начальный буфер вводится через явную согласованную корректировку, а не через профиль.

Calendar показывает утверждённое отсутствие и общие выходные; отсутствующий график обозначается как неизвестный. В Gantt доступность видна отдельно от дат задач: система сама не передвигает задачи из-за отпуска. В обычном настраиваемом отчёте можно включить **Compare with working capacity** и выбрать собственный диапазон/людей. Оценка и факт остаются выбранными пользователем обычными duration-полями. Из task-level часов не придумываются ежедневные worklogs.

Ctrl+Z / Command+Z после подтверждённого перемещения возвращает место задачи и изменённую группировку — исполнителя, секцию или статус. На Timeline/Gantt возвращается прежняя пара дат. Для Graph поддерживается отмена подтверждённого сохранения личной раскладки. Сервер повторно проверяет права и актуальные guards; чужая правка может остановить Undo. В текстовом поле сочетание сохраняет нативную отмену ввода; очередь хранится в памяти текущего контекста, redo не добавлен.

## Быстрый запуск для владельца

1. Открой workspace → **Time off**. Выбери год правил и **Apply company template**. Флажок общих выходных можно снять.
2. В **Policies** проверь числа, перенос, начисление, флаги неоплачиваемого отсутствия и необходимость согласования. Будущие изменения копируются в новый год правил; историческая корректировка требует причины и preview.
3. В **People & schedules** заполни даты работы/начала учёта и положительные начальные остатки. Проверь часовой пояс и часы по дням недели. Сохрани показанную корректировку после проверки её влияния.
4. Через **Request time off** выбери вид и даты, проверь preview списываемых дней и отправь заявку. Требующее согласования отсутствие уменьшает capacity после одобрения. Для общего назначенного отдыха владелец может использовать **Assign & approve** для нескольких людей; ошибка одного человека не оставляет частичного назначения.
5. Сотрудник может менять будущие даты. Для уже согласованного вида с обязательным approval он может сократить утверждённый интервал; новые дни требуют новой заявки. Сегодняшние/прошлые дни исправляет администратор с причиной.
6. Проверь Calendar и Gantt. Для отчёта открой **Reports**, выбери обычные Plan/Fact поля и при необходимости включи **Compare with working capacity**, задав даты и людей. Люди без задач тоже входят в выбранную рабочую ёмкость; неизвестный график не становится нулём.
7. После сохранённого drag задачи или изменения дат выйди из текстового редактора и нажми Ctrl+Z / Command+Z. При конфликте используй показанное восстановление; чужое состояние не перетирается автоматически.

Этот quickstart описывает принятый продуктовый путь. Его native-проверка использовала private fake Auth; ручной проход существующей реальной main-сессии остаётся отдельным непроверенным gate.

## Замороженный Candidate E

- QA-root: `/private/tmp/workloom-time-off-20261019`.
- Build: `build-2af4a1fd-56f4-4717-a08f-dbf8f2b35e82`.
- Source digest: `3f76668eb1b73496623f6a085f01b51b6d725cc4743d1055b887c0f5d2e2e039`.
- **1439 source /1074 compiled** файла; build manifest SHA-256: `af11e8871475def0707a0c8021cf8d1d62f583e8337b65b23fe50ff6996bd4f2`.
- QA helper SHA-256: `cfb384ff1c5813ca9dd95a6676672731d9e0297eeb31453872d1da1caa9e691c`.
- Activation helper SHA-256: `074ace871377cb122c061b1a54edb956a5af4769e5bf65540ae35b4aa5dd055f`.
- Product commit: `c228181`; активация19Oct2026 **18:43:20.508UTC**. Документальный follow-up не входит в этот продуктовый digest.

SHA прочитаны непосредственно из private evidence, без `.env`, секретов или чтения содержимого базы. Для каждого из девяти результатов независимо сверены source/build/helper bindings. Для пяти native results дополнительно пересчитаны фактические spec/report SHA и проверены actual report statistics.

## Девять обязательных финальных gates

Все девять результатов должны иметь один source digest, build manifest и актуальный helper SHA. Native дополнительно привязываются к фактическим spec bytes и report SHA; expected>0, skipped/unexpected/flaky=0. Фокусные проверки не прибавляются повторно к полному прогону.

Пути в таблице относительны к E build выше. **9/9 зелёных, actual exit0; локальная activation выполнена отдельно после их проверки.**

| Gate | Текущее состояние E | Result path | SHA-256 result |
| --- | --- | --- | --- |
| global | PASS, exit0, 19Oct18:21:26UTC | `check-global-89090b71-8b5f-4e11-8f4d-1918b5e051e8/result.json` | `a97f4930ced37dd9440d8413da04b5dcb7248595b8829f03f5d1da5c621a9651` |
| unit | PASS **2122/123**, exit0, 44.75s | `check-unit-80161f4f-2939-47ea-b25d-80e46b061b50/result.json` | `5ccb7a8888696b6d8ab46e544a1c0afad28a0e98db3a8bf66f5530c17f609049` |
| web | PASS **2312/285**, exit0, 741.31s, без skips | `check-web-a345a481-7c6d-4243-87aa-d22cd3bffa9a/result.json` | `599bf0fb7fcb5b5d3fc45a40ceee3dca5f7aaedc04eaa1c3a02a442831dade69` |
| integration | PASS **407/48**, exit0, 336.02s, без skips | `check-integration-ea96cceb-6d06-42c8-953c-b9ddc3edd0ff/result.json` | `8b32717b1804cdacc8c21c702249bbb2ce6d0557c0efb122a7410f445156e844` |
| native:inline | PASS **5/5** | `native-inline-1400d7e6-667f-4094-82e4-496ddc089263/result.json` | `b5e9b664cd4833844e3ecec720388772ab5d31b107b0ef70e275caf4cc40d4a1` |
| native:spatial | PASS **3/3** | `native-spatial-2794c050-fbf9-4d8b-89e5-710997383298/result.json` | `263209f031a6c11971ae4251358e1f09a6fc34fe36582c535006af9b3d9de7d7` |
| native:timeoff | PASS **2/2** | `native-timeoff-aa0fc97f-36f8-4752-b62d-3e243eca29e7/result.json` | `7a03697046ac27a5c07ed7be120701c94098a276cfae50e6447a2cfc17ae14e7` |
| native:reports | PASS **6/6** | `native-reports-bb49ba8c-16fd-4ebf-80a8-714d53ec4025/result.json` | `70235ce5f625e3e7bd7ed98928581b701ddb765cb0f1902601eae0194daac0ad` |
| native:board | PASS **2/2** | `native-board-211175e9-5315-4ecf-9f75-ceb83c09e729/result.json` | `a906c3c30d104f2fb26262b742755f2a1743c6159ef613ff05dff3bfa6ef5b0c` |

В пяти отдельных native-командах —18 cases суммарно; у каждой skipped/unexpected/flaky=0. Это private compiled Chrome с fake Auth. Отдельные actual spec/report hashes:

| Native suite / spec | Spec SHA-256 | Report SHA-256 |
| --- | --- | --- |
| native:inline / `inline-ux.spec.ts` | `2f1acbdc3e89af7f4ef6741a483b808eff486d9f78c8390d40da6d95942fd0d5` | `521c1ba428fb947279d2baeae5ce2faa8c6264502b06a8cf80dcb3b2bcf24356` |
| native:spatial / `spatial-undo.spec.ts` | `79667288bacc5a883204b1af148617ea651f0536489be31f4fc6c01502dc4b47` | `8c42bce90c1109e40288d178fd3f2ed8703786775afbec1d0ada1184f40dd5f3` |
| native:timeoff / `time-off.spec.ts` | `2e5df1a4376e028051077d026de3064480be0cde3a8dc1da3ce24e47e69fd126` | `81403fe8279c2c04d8286452e1fdcea086e08a27d93a33b73dbc37897d95edda` |
| native:reports / `newgenericreports.spec.ts` | `09df686fe3c12b033a9423db3b0df81249054614ab67b93d251e248dc23d4b67` | `f75d08201b5d1b77ec38255419a8652bcbb1e9360f95bd5d42c696fc3b36ea67` |
| native:board / `board-order-graph-sections.spec.ts` | `1168eb8ec9c0878e37bec4cb9654bdc87363038144ca71ea8a099753d03f7217` | `194da29c0e8db135aa150175f690ab909f9c2a60e58c7ba8b513b84b80ede69e` |

## Отдельный визуальный просмотр и его границы

Root просмотрел финальные E Calendar в светлой/тёмной теме и Gantt в тёмной теме: элементы управления и отсутствие читаемы, warning/band отображается нейтрально. Отдельная native assertion проверила `pointer-events: none` у Gantt availability overlay. Сам просмотр PNG — визуальная проверка private compiled fake-Auth UI, а не ручной проход main-взаимодействий.

Общая папка screenshots внутри E build: `native-timeoff-aa0fc97f-36f8-4752-b62d-3e243eca29e7/artifacts/time-off-configurable-time-29053--Gantt-bands-in-both-themes-chrome/`.

| Screenshot | SHA-256 |
| --- | --- |
| `time-off-calendar-light.png` | `8bab6a9450526846dc26b6b780b3d8dbdfad8a5f979b84f92f230efb88610bee` |
| `time-off-calendar-dark.png` | `9dfda6251c89f40f2700a757025f0bbe31437bc0f4d52e1702ad73274a0aa386` |
| `time-off-gantt-dark.png` | `47259d3f1b02d221ad194c63a83f16a204abbc7cc649898bfefb8802513e7738` |

CUA текущей main-сессии заблокирован при инициализации окружения из-за symlink. **Существующая authenticated main UI, реальный Google/Auth цикл, реальный old-tab workflow и production не проверены.** Просмотр этих PNG не заменяет эти gates; PNG в репозиторий не копировались.

## Сохранённые RED и диагностическая хронология

**A** — `build-e1f50a5e-fcb9-435c-9ddd-c1d04dba209b`, digest `ae89deade87d8a7937c29cb6aee1ce8ff075326afa20ad937e27058e5285f288`. Spatial: **1 failed /2 serial not run**, первый отказ до test body, **0ms**. Строгий fake-Auth key-root allowlist разрешал только прежний private QA-root. Исправление добавило ровно новый известный root; root/realpath/owner/O_NOFOLLOW/regular-file/key guards не снимались. A не исправлялся на месте и не активировался. Result: `native-spatial-3051890b-6b0f-40ff-abcd-da175da2aade/result.json`, SHA `47427e29bae7fcf662464ef4f9be66b51ee9bd610f74c26b8f1864bc56bcb95a`.

**B** — `build-1ec78664-cb21-4c39-bf52-0429166b6b0c`, digest `ad0926436c77cbd7c88f7a319f436a98da24f82f3aa39e053f51181d450aef0c`.

- Global: **17 localization violations**, при зелёных lint/boundaries. Это были dynamic-key/typed-label annotations и диагностические literal-строки; результат не переименовывается в PASS. Proof SHA `2c1697e38dfaa03f2a75499ada3b559565938a9ad703954af728fe5e7d1e4226`.
- Spatial: **1 failed /2 not run**, реальный test body около8s. Тест искал table drag handle по имени **Drag task**, тогда как доступное имя — **Move task**; до move POST он не дошёл. Proof SHA `b586c046611086bc5d7f84789a0e34c353f295e404c27330e00537b408d4fb8c`.
- Timeoff: **1 passed /1 failed**, первый тест около12.8s. После approval nested summary давал strict locator два совпадения; второй сценарий configurable capacity report прошёл. Proof SHA `638762496c286c37755b09601c72f7c8af377e5ecee9833a0604038740b557f8`.

**C** — `build-df2280cf-7368-4089-883c-70bef36a5fd9`, digest `f6490db5aa7bccc820296e26446b6f2ee94cfe398e9902c74700c747168ef045`. Выполнены четыре зелёных диагностических gates: global; unit **2122/123**; native spatial **3/3**; native timeoff **2/2**. Это не комплект из девяти gates. Root при визуальном просмотре отметил слишком слабую заливку отсутствия, поэтому C не был активирован; private C runtime штатно остановлен. Исправление породило новый D; в нём изменились ровно `apps/web/src/features/time-off/TimeOffCalendar.tsx` и `tests/e2e/time-off.spec.ts` для более сильной заливки и ожидания установившегося отображения. D проверялся заново. C proofs: global `27cc5f5eff013c0df76df2caf058a89a233d8f4f68afad946e741e22f2524c77`, unit `451501637573d7d68d6aee9712540edd25cc6aa42be06a309e4d2b397d8bcc89`, spatial `0bbf2b35d09692b0ec9d1752b69436475812fda85dac71d46260b4227ab094f2`, timeoff `7aec6563b5bbac4d60bb7083fbefc4a51a590a0d9209441ce5f300826b5224e7`.

**D** — `build-b26736dd-bfb1-46ca-b3e2-e5018bbb5948`, digest `460dc128dbf8ab36d2ad7592ce1341dad407724cf065650a6b7b5b3a19526aa7`, build manifest `58fc3347eae8b8cccd09ec13f7a27bb008e8aff98f599342a697d0318e5b0767`. Global, unit2122/123 и native timeoff2/2 прошли, но полный web завершился **RED: 2285 PASS /26 FAIL, 278 PASS /7 FAIL files, всего2311 tests /285 files, 675.60s**. Result `check-web-61c4d29a-5b78-4b7c-a847-6b79811f3ff9/result.json`, SHA `b07ce1d604a4766f00a8d25da5e6d9e64375fd3e51a806c5b0f0fe4d67d8b648`.

Семь файлов с отказами: GanttMoveBar8, date boundary1, gantt6, ProjectToolbar6, Sidebar1, ganttConnectors3 и ui1. Старые fixtures считали любой non-GET записью; новый keyless `POST /time-off/availability` — чтение и требует явной классификации/fixture без настроенной policy. Отдельно исправлена продуктовая граница дат: task dates0001–9999 сохраняются, availability запрашивается только на пересечении с поддерживаемыми1900–2200 и показывает unknown coverage вне него. Hint описывает сохранённый статус/границы без выдуманной недоступности.

После исправлений прошёл ограниченный source-alias checkpoint **73/8** и отдельные TypeScript/lint/localization checks. Это не исправление D на месте и не полный web PASS. Финальный E snapshot собран заново; все девять gates выполняются повторно. Остальные финальные D gates не запускались, D не активировался.

## Review provenance и ограниченные проверки

Pure engine прошёл ограниченный source-only checkpoint **25/25** плюс lint. Он включал регрессию: cancelled/rejected immutable history не блокирует изменение текущих employment/accounting dates; active pending/approved сохраняют ограничения. Последующие полные gates должны подтверждать уже финальный snapshot, а не складываться с этим checkpoint.

Независимые code-only reviews использовали подтверждённую **Claude Max subscription / firstParty**, явно `--model opus --effort high`, фактически `claude-opus-5-5`:

- `/private/tmp/workloom-opus-leave-engine-5l6dyj52` — пять конечных source/test файлов;
- `/private/tmp/workloom-opus-activation-review-ugag_o2y` — activation helper и ограниченный код контекста.

Tools/MCP, `.env`, секреты и содержимое БД в этих reviews не передавались. Исходные manifests сохраняют реально прочитанные hashes; source менялся во время реализации, поэтому reviewed snapshots не выдаются за финальный E. Follow-up исправления отдельно проверены root. Остальные ограниченные backend/UI/Undo проверки и review chronology сохранены в [91](91-time-off-and-capacity.md) и [92](92-spatial-undo.md); они не прибавляются к итоговым gates повторно.

Helper проверялся синтаксически и изолированными in-memory guards: сохранность старых rows/schema/ledger; отклонение DROP/INSERT/index-on-old-table; MIME equality, CAS и spawn error; native report hashes/counts. URL timeout options проверены actual parser/postgres.js constructor без запросов к БД. Эти тесты не являются запуском main activation или реального native scenario.

## Контролируемая локальная активация

Root проверил девять зелёных gates и сформировал `/private/tmp/workloom-time-off-20261019/release-e.json`, SHA-256 `51b3970eebd3388bbc1fe9c793adb923a6f89984dcbb3cc95991c3870994be37`. Read-only `plan` фактически завершился exit0 с `noMainMutations=true`: только0021 pending, 21 из22 migrations уже применены; API48904/PG20323/Vite20378 в точности принадлежали записанным runtime identities. Результат plan был в stdout tool, отдельный файл/его hash не создавался.

Применён только reviewed `0021_time_off.sql`: SQL SHA `e11299de271d86081bd2a8f1a70bf31adbafceb3e674bcc82b74cbc903f306f4`, journal `when=1792302979170`. Полный custom backup создан до DDL, archive/TOC проверены. Содержимое backup и `.env` в этом документе не приводится.

Activation evidence: `.local/backups/time-off-activation-e0f5b348-ddcf-4811-a965-4fc711b5bd62/result.json`, SHA-256 `31e21fc9d0c08d1882f7d70d0f29afb9d9e6dc6196e8bf81cdaa98c417abced0`, `pass=true`, finished `2026-10-19T18:43:20.508Z`.

| Свойство | Фактический результат |
| --- | --- |
| Full backup до DDL | `main-before.dump`, archive SHA `d4e9fd7764b2d38d3a8e11c521634670544ab4c2d1480cc43ce0b5ce627e5e58`; TOC verified |
| Applied migrations | Только0021; ledger21→22, прежний полный prefix сохранён |
| Старые таблицы | Все86: counts и row digests сохранены, кроме ожидаемого единственного добавления в migration ledger |
| Новые таблицы | Ровно8 новых пустых; общий count86→94 |
| Old schema objects, owner/ACL | Сохранены; сравнение schema dump исключает только8 новых таблиц и их собственные объекты |
| .env / PG / Vite / worker | Env-file bytes сохранены; PG20323 и Vite20378 прежние identities; workerOFF |
| API | Только verified owned API restart48904→58103; actual ready200, body database/schema `ok` |
| Static resources | Старый inventory245;243 non-HTML сохранены с прежними bytes и exact MIME;2HTML entrypoints заменены и отдельно проверены |
| Новый runtime | Все promoted/merged ресурсы проверены bytes/MIME; `/` и `/app` соответствуют verified документам |
| Реальная main session после reload | **НЕ ПРОВЕРЕНА**: CUA blocked при symlink-инициализации; healthz не заменяет этот gate |

Восемь таблиц: `leave_settings`, `leave_settings_versions`, `leave_profiles`, `leave_profile_versions`, `leave_requests`, `leave_request_versions`, `leave_charge_ledger`, `leave_adjustments`. Все они были пусты после activation; реальная настройка workspace оставлена владельцу.

После завершения root штатно остановил private QA: cleanup=true, порты49318/49319/60651 закрыты, private `runtime.json` отсутствует, operation.lock освобождён. Main4310/API58103,4311/Vite20378 и55432/PG20323 остались точными прежними/новыми owned identities; ready после cleanup снова вернул200 с database/schema `ok`.

При сбое после попытки миграции helper не разворачивает DDL назад, не восстанавливает БД и не запускает прежний API против новой ledger. Он останавливает только проверенный собственный новый API и сохраняет runtime lock с evidence для root. Это защитное поведение было рассмотрено отдельно; успешный activation не выдаётся за фактическую проверку такого сбоя на main. Конкурентная пользовательская запись во время строгой сверки была бы основанием отказа, а не замалчиваемым исключением.

## Границы приёмки

- Первая версия — целые дни. Task dates0001–9999 не сужены: availability вычисляется на пересечении с диапазоном1900–2200, вне него покрытие явно unknown. Pure request/calculation range максимум3660 включённых дат; HTTP capacity/report/Gantt range максимум366 дней и100 людей. Пустой/неизвестный график остаётся unknown.
- Правила действуют по годам; отсутствующая историческая policy не заменяется выдуманным календарём без праздников. Ранее известные виды сохраняются как archived, а не исчезают вместе с переносимыми остатками.
- Подтверждённые дневные charges и старые report snapshots сохраняются; исправление unpaid может пересчитать нынешние начисления, не переписывая прежний отчёт. Capacity показывает нейтральную недоступность без private notes/type/profile/request revision lists.
- Отдельный диапазон capacity не превращает произвольные task-level Plan/Fact значения в ежедневное фактическое время. Обычные custom fields и отчёты остаются независимыми от обязательного выбора недели.
- Undo консервативно блокируется при чужих/неподтверждённых изменениях. Очередь не сохраняется через reload, native text Undo не перехватывается, redo не обещан. Предел нового table/Board captureUndo —5000 полных project rows.
- Private compiled Chrome с fake Auth — отдельное доказательство. Реальные внешние Auth/Google, main existing-session UI, настоящий old-tab interaction, Safari/touch/IME и production/Railway должны иметь собственные результаты. Сохранённые старые ресурсы сами по себе не доказывают old-tab workflow.
- Production deployment, реальные приглашения, восстановление managed backup и перенос команды этой локальной приёмкой не подтверждаются.
