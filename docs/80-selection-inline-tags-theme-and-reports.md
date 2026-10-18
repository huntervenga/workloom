# Выделение строки, caret, теги в ячейке, темы и отчёты

> **Код `8ce1cef3f8c88bb308a8dc0e159b3abcd96b35cd` принят локально и активен на `http://127.0.0.1:4310/app`.** Финальная активация (harness 9fa1) actual exit 0, все финальные фазы PASS, около 00:44 UTC. Миграции БД нет; все 78 tables, schema и env сохранены. Это не завершённый внешний Auth на main, не повторный browser-прогон на main, не взаимодействие со старой вкладкой и не публичный deploy.

Продолжение [ежедневной таблицы](79-assignee-daily-table.md), [строки задачи и ручного порядка](78-task-row-and-manual-order.md) и [локального Auth](76-shared-auth-local.md). Исторические документы, включая docs79, не переписываются; их приёмки не переименовываются в проверку нового кода.

## Пользовательские сценарии

### Выделение строки и caret в названии

- Все ячейки выделенной сохранённой строки окрашены одним непрозрачным цветом — sticky-ячейка title и остальные ячейки, включая Tags и custom. Лишняя полоса в gutter убрана. Высота 41px, Shift-диапазон, Ctrl/Cmd-мультивыделение и фокус сохраняются.
- Клик мышью по названию ставит caret в точку клика (логическая позиция UTF-16): сначала `caretPositionFromPoint`, при отсутствии — `caretRangeFromPoint`. Offset вне кнопки title отклоняется (клик не отменяется); позиция ограничивается длиной текста, без валидного offset — стандартное поведение. Позиция одноразовая (`preventScroll`, затем `setSelection`). Unit-проверка — jsdom.
- Клавиатурное поведение по умолчанию не меняется. Поздний ACK и remount не забирают фокус.
- Source: `apps/web/src/features/task-table/TaskTable.tsx`, `titleCaret.ts` (тот же каталог), `apps/web/src/features/tasks/InlineTaskEdit.tsx`, узкий caret-prop в `apps/web/src/routes/ProjectPage.tsx`.

### Создание тега прямо в поиске тегов

- В поиске **Edit tags** (сохранённая задача и пустая новая строка) owner/admin (`fields.manage`) создаёт workspace tag явно — кнопкой Create или Enter, только если введённое имя не совпало с существующим тегом. Ввод текста никогда не отправляет POST. Member выбирает только существующие теги; управление тегами в details сохраняется.
- **Два шага.** Создание — существующая мутация `createTag`, body `{name: trimmedName, color: null}`; привязка к задаче — отдельный шаг через обычное сохранение выбора. **ACK и detach никогда не пишут Task**: ACK только добавляет тег в локальный draft выбора; автопривязки при remount и для чужого origin нет.
- **Сохранение задачи не меняется.** Существующее намеренное сохранение при клике снаружи и Tab/blur остаётся как было; контракт «только кнопка Save» не вводится. Enter в поиске тегов не отправляет задачу. Пустая строка создаёт Task только явным Enter/submit в title.
- **Unknown outcome:** Retry повторяет тот же body с исходным idempotency key; метаданные origin хранятся вне HTTP input, body и fingerprint. Область — lease страницы; уход защищает существующий registry. Подтверждённый уход или reload — прежний протокол: черновики на сервере не сохраняются.

### Потеря прав во время unknown createTag (P2 detach)

- После 31/31 GREEN независимое review actual Opus нашло P2: при смене роли owner/admin→member во время unknown `createTag` неразрешённое создание бессрочно блокировало задачу. Root утвердил production detach (4 файла) после повторного review actual Opus (новых P1/P2 нет; 105.776s, 4 turns).
- Явное действие **Continue without this tag**: exact body, idempotency key и registry сохраняются; тег постоянно catalogOnly и не привязывается ни после detach, ни после возврата прав; detach не пишет ни Tag, ни Task. Пока запрос unknown, busy блокирует только **новые создания тегов**, но не несвязанные создания Task. Фокус уходит в Search до release; глобальное восстановление — только без смонтированного owner, с фокусом на Open original. Байты старых 31 cases не менялись.
- Смена роли в 3 новых case — controlled UI capability, а не мутация membership в DB. Native/реальная DB membership для P2 не заявлены.

### Светлая и тёмная тема

Семантические CSS-переменные light/dark. Внешний `/theme-init.js` применяет тему до первой отрисовки в public/authenticated shell и на landing. Выбор хранится в `workloom.theme`, иначе — системная тема. Переключатель **Dark theme** (`aria-pressed`) — в Topbar и в public pending/guest/error shell. В Graph/Gantt меняются только цвета. Source заморожен по манифесту (25 файлов).

### Отчёты WeeklyReport / WorkTypes

Только отображение; backend, формулы, API и ранжирование не менялись. Показываются закреплённые project/period, неделя с timezone, as-of и сохранённые identities. Original baseline, added и unplanned — раздельно, из сохранённых серверных данных; клиент не пересчитывает суммы. Таблица людей по алфавиту, включая людей только с added; различаются active 0, missing и отсутствие baseline; в итоговой строке — «Difference unavailable». Покрытие графиком — только по original. Копирование сводки (read-only) с fallback и возвратом фокуса. На read-only вкладках Report/WorkTypes WeeklyPage намеренно скрывает выбор Time entry и сохраняет контекст человека в URL (query `worker` — параметр URL, а не фоновый worker-процесс).

Source: `apps/web/src/features/planning/` (`reportSummary.ts`, `ReportSnapshotHeader.tsx`, `WeeklyPeopleComparison.tsx`, `CopyReportSummary.tsx`, переменные `PlanFactChart.tsx`), `apps/web/src/i18n/locales/en/reportUX.json`, узкие seams в `WeeklyPage.tsx`, `WeeklyReport.tsx`, `WorkTypeReport.tsx`.

## Gates принятого кода

**Manifest:** sha256 `72515227c910dd0be6c67f449179f5a8b9d2c4e7487f640c8a115e471c7d899a` — 1820 source/compiled files + 82 stage artifacts. Относительно прежнего freeze `8f7500e8c069ce6ddd6bd091f36e1809b7ff43dd874bd24656d33ff866e47c45` изменены **только 3 jsdom test files**; остальные production/compiled/native files не менялись, все 82 artifacts пересобраны побайтно идентично.

| Gate | Scope | Результат |
|---|---|---|
| Whole web (второй) | 223/223 files | **1853/1853 PASS**, 561.90s; actual child и runner exit 0; report sha256 `fd0a2710c2aeaba03d5304f1ca0b4307f4e2756341c9dcd641f758c7b90fa860` |
| Global check (post-oracle) | lint/localization/root TS | actual exit 0 |
| Web build (post-oracle) | финальный manifest | actual exit 0 |
| API build | — | actual exit 0 |
| Private compiled native (6 команд, 40 tests) | те же 82 artifacts | **40 PASS**: theme 8/35.2s, inline tags 5/22.3s, daily 12/51.8s, core desktop+mobile 7/34.9s, reports 2/15.1s, Asana 6/41.8s |

- **Native:** собранный Chrome против свежих private BFF/PG с fake Auth upstream — это не live Google. После трёх jsdom-only правок native **не перезапускался**, и перезапуск не заявляется; валидность следует из побайтной идентичности всех 82 artifacts. Cleanup private PG: child DBs удалены, catalogue baseline восстановлен, cluster остановлен.
- **Native reports — покрытие:** desktop и mobile; точные сохранённые данные и все стабильные meta, кроме только `requestId`; литералы 270/195/20/10/225→255; per-person genuine 0/missing; scopeFrozen.
- **Unit (отдельные команды, не суммируются):** tags + P2 detach 34/34, 33.18s (5 files) — до test-only правки (2 deps array в fixture + удаление неподдерживаемого exact property; static checks после неё подтверждены global check, focused 34 не повторялся); theme 55/55 (7 files); reports 37/37, 44.93s (4 files); исправленные oracles whole — 37/37, 3 files, 5.24s.

## Активация main 4310

**Финальная попытка (harness 9fa1): PASS**, actual exit 0, около 00:44 UTC. Canonical proof — `/private/tmp/workloom-theme-inline-weekly-main-activation-proof.json`.

- **Данные:** все 78 tables (public 64 + queue 13 + drizzle 1 — существующий migration ledger) — counts и row hash идентичны before / pre-promote / after; все 15 schema parts идентичны, schema hash тот же; env не менялся.
- **Процессы:** owned PG и web сохранены, перезапущен только owned API; worker OFF.
- **Assets:** promotion 128 files = 82 stage artifacts + сохранённые старые assets (дедупликация). Body hashes всех 103 старых resources проверены до и после; 67 promoted JS/CSS — body и content type; 9 document references; root landing и app index — точное совпадение.
- **Auth (только чтение):** anonymous `me` → 401, shared Auth config в порядке.

**Короткая история.** Три предыдущие попытки FAILED **до любой мутации** (API не останавливался, promote не было, данные и assets не менялись):

1. Слишком строгая инвентаризация worker-процессов.
2. Перепись 78 tables с drizzle ledger.
3. Whole-row alias column `x` (harness 1dd5, шаг `db-before`).

Read-only диагностика: census 78/78; hashes 77 из 78 таблиц и schema 15/15 PASS, один hash-запрос завершился 42883. Исправление — две строки временного harness: `row_to_json(x.*)` и закреплённый локальный driver. Синтетическая проверка SQL collision/ordinary/empty PASS; legacy-ошибка 42883 воспроизведена. Независимое delta review actual Opus — 39.943s, 8 turns, ноль P1/P2. App source не менялся.

**Счёт таблиц.** Текущие 78 = 64 + 13 + 1 drizzle ledger. Прежний счёт 77 (docs79) пропускал ledger — это не изменение DB и не новая миграция; исторические утверждения о 77 относятся к своей области.

## Хронология RED (без переименования)

**Whole web, первый прогон** (freeze `8f7500e8…`): **1850 PASS / 3 FAIL** из 1853, 223 files, 678.756s; архив `*-before-legacy-oracle-corrections.{log,json}`. Все три — устаревшие oracles, исправлены test-only и стали строже; ни один runtime safety assert не ослаблен:

1. `ReportTaskLinks`:163 ждал скрытый выбор Time entry → источник person/full URL, отсутствие picker, строгие href всех 3 task links.
2. `GraphClarity`:64 ждал литерал red → точный `var` danger-line, 1px и все state labels.
3. callbackScript ждал 1 head script → ровно 2; первый inline до всех resources; порядок inline → theme → icon, theme блокирующий; остальные 22 security cases побайтно без изменений.

Второй whole 1853/1853 — **новый** PASS; он не заменяет ни первый RED, ни strict RED из docs79.

**Tags:**

1. Hook timeout (10s, по 5 skip) — не поведенческий RED.
2. Staged старый picker: 5 FAIL / 98.28s — 4 содержательных отсутствия Create/Retry/capability copy и 1 ошибочный selector Add.
3. Первый финальный picker: 22/27, 93.69s — 3 FAIL: Retry отсутствовал в UI (**дефект продукта**); 2 — селектор Add и начальное чтение EditTags.
4. Исправление actual Opus (sibling-кнопка Retry) → 31/31, 65.71s.
5. P2 detach: 3 FAIL, 4.49s → 34/34.
6. Scoped lint RED (2 deps в fixture) и typecheck (exact property) — исправлены test-only; первый root `npm run check` RED, 6 lint.

**Native:**

- Type helper `actualData: unknown` — только типизация теста.
- Core: 1 timeout + 6 skip из-за устаревших `transition.finished`; mobile wheel 92px исправил только навигацию теста, product padding не менялся, дефект недостижимости не заявляется.
- Reports: fixture U создавался после freeze (продукт корректно дал `added_scope`), затем envelope включал `requestId`; числовые oracles те же.
- Ранний staged build `7a125b06…` и его 40 native — результаты до исправления empty baseline, в финальные не переименовываются.

**Unit:**

- P2 empty baseline: RED 1 FAIL / 2 PASS, 9.49s → 3/3, 17.38s.
- Theme initial 45 PASS / 8 FAIL; причина для source-reader — stubbed CSS в fixture.
- Reports initial 51 PASS / 3 FAIL / 16 SKIP; причина readiness («Loading week») **не доказана**.

**Прежние результаты:** strict RED docs79 (1721/35, 1754/2, 1665/91) остаются историческими; backend 1525/93 и PG 26/3 — из docs79, не перезапускались. Изменений backend и Auth нет.

## Не заявлено

Завершённый внешний Auth на main, новый browser-прогон на main, реальное взаимодействие со старой вкладкой, live Google (private native — только fake upstream), публичный deploy/production, физические touch/IME, Safari, полный паритет с Asana, P2 detach в native/реальной DB membership, native rerun после jsdom-only правок, суммарные unit итоги.

## Proof-ссылки (private, вне репозитория)

- `/private/tmp/workloom-theme-inline-weekly-main-activation-proof.json` — canonical proof активации; `final-activation-packet.json` — финальные факты root
- `/private/tmp/workloom-theme-inline-weekly-whole-web-final-proof.json` — второй whole 1853/1853
- `/private/tmp/workloom-theme-inline-weekly-first-whole-and-freeze-archive.json` — первый whole RED и прежний freeze
- `/private/tmp/workloom-theme-inline-weekly-post-oracle-delta-proof.json` — delta 3 files, 37/37
- `/private/tmp/workloom-theme-inline-weekly-{check,web-build}-post-oracles.log` — global check и build
- `/private/tmp/workloom-theme-inline-weekly-final-native-proofs.json` — native 40, cleanup
- `/private/tmp/workloom-inline-tag-detach-{red,green}-proof.json` — 3 FAIL → 34/34; `/private/tmp/workloom-theme-owned-final-manifest.json` — theme freeze
