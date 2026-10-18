# Панель задачи, фото профиля, история и inline bulk

> **Код `a9d7975` принят локально и активен на `http://127.0.0.1:4310/app`.** Global check9, API/web builds, backend1842/1842, private PG26, whole-web1955/1955 и compiled Chrome44/44 прошли. Root activation V3 actual exit0: применена только additive0016, прежние данные сохранены, перезапущен только owned API. Это ограниченная локальная приёмка; completed Google login, authenticated browser main, old-tab и production не заявлены. [Docs80](80-selection-inline-tags-theme-and-reports.md) сохраняет предыдущую приёмку `8ce1cef` без переписывания её истории.

## Как пользоваться

### Панель задачи рядом с таблицей

На desktop от1280px сохранённая задача открывается боковой немодальной панелью: таблица остаётся доступной, без подложки и блокировки её прокрутки. На меньшей ширине используется модальный вариант. Один поток прокрутки ведёт от деталей до Activity. Вложенные раскрытия/диалоги обрабатывают Escape раньше закрытия задачи. Фокус возвращается, только если принадлежал панели; работа с соседней ячейкой не перетягивает его обратно. Reduced motion не требует ожидания анимации.

Черновики, несохранённые изменения и неизвестный результат команды сохраняют правила [строки задачи](78-task-row-and-manual-order.md) и [ежедневной таблицы](79-assignee-daily-table.md). Переключение задачи не сохраняет и не удаляет draft молча. **Project отображается read-only; picker переноса задачи в другой проект не добавлен.** Shared estimate принадлежит work package, а не каждой дочерней строке.

### Фото вместо инициалов

Если проверенный Auth/provider token содержит допустимое `picture`, Workloom сохраняет URL и показывает фото в аккаунте, выборах людей, участниках и комментариях. **Email сам по себе фотографии не содержит**: поиска по почте, Gravatar и угадывания фото нет. Workloom не проксирует изображение через сервер.

Принимается ограниченный публичный HTTPS URL без credentials, fragments и произвольных token-query; небольшой публичный `sz` разрешён. Отсутствующий, небезопасный или не загрузившийся URL даёт инициалы в том же фиксированном размере, без сдвига строки; запрос использует `no-referrer`.

Фото читается после проверки подписи, issuer, audience, срока и subject; после rotation используется свежий проверенный token. Отсутствующее/некорректное поле сохраняет прежнее фото, явный `null` очищает. Refresh записывает фото и текущую сессию одной транзакцией. **Существующей сессии может потребоваться refresh или повторный вход**; email-backfill нет. Email/name не объединяют пользователей и не добавляют fixture membership. Старые сохранённые ответы без avatar не получают default.

### Activity: комментарии и изменения

В задаче один хронологический Activity с composer внизу. Комментарии и действия различимы; фото дополняет подпись автора, без фото остаются инициалы. Чтение требует текущего доступа к задаче. Выводятся разрешённые поля и сохранённые identities, а не raw audit JSON с скрытыми descriptions/reasons, токенами или внутренними payload.

Постраничное продолжение связано с workspace/task/actor/membership и текущими правами. Порядок событий задаёт сервер. Genuine0, missing/void факт и неизвестная исходная оценка различаются. Shared estimate и время не умножаются на участников или детей. Это история поддержанных команд, не полная ретроспективная реконструкция любых прежних изменений.

### Изменить выбранные задачи через ячейку

Выделите строки gutter/Shift/Ctrl/Cmd, откройте поддержанную ячейку и проверьте показанное число задач. Редактор захватывает selection: последующая смена выделения не перенаправляет начатую команду. Дополнение расширяет атомарное редактирование общей оценки work package и одного значения custom field вместе с поддержанными встроенными полями. Максимум100 уникальных задач одного project, актуальные права и revision guards.

Оценка записывается один раз на package: выбранные дети не создают её копии. Custom field сохраняет тип, definition/value revisions, историю и блокировки. Null/пустое не становятся0/false. Все preflight и planning/manual-lock проверки предшествуют пользовательским записям; применение атомарное. Unknown retry использует исходные body/key, а не новое выделение. Неподдержанные ячейки не выдают себя за bulk editor. План/факт требует явных недели и человека и не входит в произвольную массовую подстановку чисел.

## Проверки принятого кода

Certificate SHA `1502e605d066e82f9df02c84454807bd95b15e0488646576c6fcd91da3df8f56`:1881 source/compiled файла,82 stage artifacts,15 actual zero-exit gates. Counts tests/files, artifacts и отдельные команды не смешиваются.

| Gate | Фактический результат |
|---|---|
| Backend whole, вторая команда | **1842/1842 теста,101 файл PASS,101.74s** |
| Final global check | Девятая команда actual exit0 (`workloom-details-ninth-check.log`) |
| API build /web stage5 | Первая API build и пятая web build — actual exit0 |
| Private PG | **26 различных PASS**: photo/upgrades8 (4 файла,7.57s), history13, bulk5; три команды |
| Avatar focused unit/jsdom | Profile URL/Auth52/2 PASS1.31s; UserAvatar10/1 PASS1.29s; не суммируются с whole |
| Whole-web, вторая команда | **1955/1955 тестов,233/233 файла PASS,805.10s**, actual exit0 |
| Stage5 compiled Chrome | **44/44 PASS** в7 командах: drawer5,profile4,bulk6,history4,selection7,daily12,insertion6; те же82 artifacts; все pass/cleanup true и actual exit0 |

Private PG использовал собственные child DB; root подтвердил каталог `postgres`/`workloom_test` после cleanup. Native — installed Chrome, fake Auth upstream и реальный private PG, не live Google и не browser main. Все7 native `proof.json` находятся в `/private/tmp/workloom-details-20261018-qa/`: `run-drawer-46BS6X`, `run-profile-d5JVOn`, `run-bulk-xFtMMS`, `run-history-8wTjAP`, `run-selection-oO54wp`, `run-daily-01L31X`, `run-insertion-EDqb4o`.

## Main: миграция и активация

**V3 actual exit0, phase complete, pass true.** Proof: `/private/tmp/workloom-details-main-activation-c2706f75-649f-4baf-b97b-6dfa7a98f943.json`.

- Только0016: nullable `users.avatar_url` +CHECK, без UPDATE/default/новых таблиц. Прежние32SQL/snapshot-файла и16 journal entries сохранены. На main прежние ledger receipts сохранены и добавлен ровно один; сразу после миграции все существующие avatar NULL.
- В78 таблицах (64 public +13 queue +1 ledger) прежние колонки/строки и проверенная schema metadata сохранены; разрешены только avatar column/CHECK и новый ledger receipt. Полностью неизменная schema не заявляется. Миграция проверена при живом старом API; concurrent write сделал бы conservation RED без пересъёмки baseline.
- Только owned API7216→88608; PostgreSQL и Vite — те же identities, workerOFF. `.env`, source certificate и82 stage artifacts не изменились.
- Сохранены старые hashed assets; проверены реальные67 старых JS/CSS и84 ресурса promoted tree (включая2HTML), bytes+MIME, readiness JSON, shared config/guest401 и readonly doctor. Это не84 новых файла и не old-tab interaction.

После активации root остановил только собственный private QA PostgreSQL на60651 после проверки каталога `postgres`/`workloom_test`; основной55432 не затронут. Финальный read-only health actual exit0: readiness db/schema ok, `/app` HTML byte-identical stage, shared config/guest401 (`/private/tmp/workloom-details-post-cleanup-health.json`).

Сохранённый activation backup атомарно перенесён из исходного пути proof в ignored `.local/backups/web-details-c2706f75-649f-4baf-b97b-6dfa7a98f943`:128 обычных файлов,9346021 bytes, прежний tree SHA `0fbd1a9167f49f6e7a433d61638417bafc282d23b4d0b0da2e642ea867f20e0b`; mapping proof `/private/tmp/workloom-details-backup-preservation-c2706f75-649f-4baf-b97b-6dfa7a98f943.json`. Исторический activation proof не изменялся.

Schema/backend rollback не обещан. Фактическое завершение внешнего Auth, authenticated main-сценарий, старая вкладка, production/public deploy, физические mobile/IME/AT и полный паритет с Asana остаются вне этой приёмки.

## Сохранённые RED и происхождение

- Первый whole-web: **1945 PASS /10 FAIL из1955;230 PASS /3 FAIL из233 файлов,601.55s,exit1**. Исправления только в3 test files:4 ожидаемых CSS strings и2 fixture URL `.test`→`.com`, с сохранением остальных assertions/deadlines. Focused36 и FieldInput11/11 PASS1.73s — отдельные команды; второй whole выше не переименовывает первый RED.
- Первый backend whole1834/3 RED — устаревшие строгие ожидаемые объекты avatar/контракта; исправлены test-only, затем получен новый whole PASS.
- Реальные Chrome-дефекты:40px сдвиг строк из-за toolbar wrap, закрытие панели после соседнего edit, mobile calendar Escape. Исправлены до stage5. Отдельные test adapters — daily повторно определяет реальную цель после autoscroll, insertion работает с фокусом внутри nonmodal pane, history начинает ждать response до действия; это не product fixes.
- В первом drawer run первый/пятый вошли и упали на40px, средние3 — на callback. Fresh RSA/kid после failed-worker restart при30s JWKS cooldown — сильная гипотеза по исходникам, без точного JWT/HTTP исключения; реальный Auth-дефект не заявлен. Fail-fast не считает not-run cases прошедшими.
- Profile native2 PASS/1 FAIL/1 not run15.4s: неверный oracle `QS` вместо `QA` для `QA Shared Auth`; только3 fallback ожидания исправлены. Последующий profile4/4 — новый результат.
- Activation V1 остановился до proof/lock/DB:24 из111 node-команд отличались только trailing whitespace, обе повторные identity стабильны. V2 нормализовал сравнение через trim, сохранив worker/ownership guards; затем остановился до миграции на readonly snapshot42501. Diagnostic с намеренной permission-probe в целом остался RED. Причины: закрытый `data_directory`, raw inet CIDR и ошибочный boolean alias. V3 использует canonical host, публичный PG17 start, точные OS/postmaster bindings до/после и quoted `AS "notnull"`, без GRANT/снятия защит. Полный readonly78/77 hashes+ledger16 PASS предшествовал отдельному успешному activation; все оригиналы/RED proof сохранены.

Primary avatar implementation и первоначальные fixtures — actual subscription Claude Opus; узкие compiler/composition/fixture/native/verification изменения — Local Codex. После автоматического отказа дополнительных внешних вызовов работа продолжена локально без обхода. `.env`, credentials, пользовательские записи и содержимое PostgreSQL не передавались моделям.
