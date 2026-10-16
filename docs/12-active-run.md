# Журнал активного прогона

Краткий рабочий ledger текущего непрерывного прогона реализации; должен пережить сжатие контекста. Это не журнал доказательств: факты проверок, команды и происхождение — только в [11](11-implementation-progress.md), этапы и приёмка — в [06](06-implementation-plan.md) и [07](07-verification-and-pilot.md). Сам этот документ новых проверок не заявляет.

## Рамки

- Старт: `2026-10-15T23:18:10Z`; жёсткий конец: `2026-10-16T07:18:10Z` (10:18 по Кипру; 8 часов). Точные значения уточнены root, не сдвигать. Остановка — по дедлайну или по команде пользователя, с отчётом о фактически сделанном и оставшемся.
- Пользователь разрешил непрерывный прогон через родительского координатора. Лимит времени управляет работой, но не разрешает deploy, публикацию, внешние сообщения, платные сервисы, смену секретов или разрушительные операции с данными.
- Root координирует, специалисты выполняют только свою зону и сохраняют исходники, demo-данные и историю. Каждый пригодный вертикальный срез проходит gate и локальный checkpoint, затем root назначает следующий.

## Политика моделей

- Предпочтительно Claude Code CLI `--model opus --effort high`; фактическую resolved-модель записывать для каждого запуска (предыдущая — `claude-opus-5-5`).
- Fallback на текущий Codex `gpt-6.1-sol` high — только при фактическом исчерпании квоты и до reset провайдера. Fallback глобально координирует root; агенты сообщают фактическое событие квоты и время reset, недоступный Claude повторно не дёргают.
- Возврат: в самое раннее подтверждённое провайдером время reset — ОДНА ограниченная проба, затем root рассылает возврат. Предполагаемый reset не основание.
- Свежее подтверждённое провайдером `rate_limit_event` в этом прогоне (источник — root/foundation; то же фактическое событие наблюдал QA), статус `allowed`: `five_hour` utilization 0.75, reset `2026-10-16T02:50:00Z` (`1792119000`); `seven_day` 0.40, reset `2026-10-16T04:00:00Z` (`1792123200`). Ранее наблюдавшийся `1792119000` теперь подтверждён свежим событием, а не только исторический. Это исходное разрешённое событие; позже квота фактически исчерпана — переход указан ниже. Политика выше не меняется.
- Без автоматической оплаты, покупок и bypass permissions. Вымышленные исторические переключения не записывать.
- Частичный Claude-код сохраняется: HTTP acceptance session `d6fcb3e9-e3fa-4fb3-97c2-98f74c4506b3` успела записать `tests/integration/support/p1b.ts` и `tests/integration/p1b-fields.test.ts` перед следующим quota rejection; отдельная policy-сессия остановилась по квоте до записи. Последующее авторство Codex записывать отдельно; до reset новых Claude-запусков нет.

| Время UTC | Модель | Статус | Фактическая причина | Reset | Возврат |
| --- | --- | --- | --- | --- | --- |
| 2026-10-15T23:18:10Z | Claude Code CLI, opus (`claude-opus-5-5`) | исходная, предпочтительная; сначала `allowed` | исходное свежее событие root/foundation и QA | `five_hour` `02:50:00Z`, `seven_day` `04:00:00Z` | см. следующий переход |
| 2026-10-15T23:37:38Z (время записи подтверждения) | Codex `gpt-6.1-sol` high | текущий временный fallback, подтверждён root | фактический Claude `rate_limit_event`: `rejected`, five_hour 1.0; ответ «You've hit your session limit», QA session `193b2f21-1f53-4de6-be13-4fa3be70a65f`, exit 1 | провайдер подтвердил `2026-10-16T02:50:00Z` (05:50 Кипр), seven_day 0.43/reset04:00UTC | ещё не было; root выполнит одну пробу после подтверждённого reset и разошлёт результат |

## Исходный checkpoint

- Source A: `cf586b324a22dd2f77336c2fd6657f87b94c3f1f`; docs-only B: `5a398228648e314b7cde5825253a0b1e264dcfc1`.
- Локально проверены P0 и ограниченный P1a. Исторический широкий gate: integration 65, core/API 271; последний: web 75, browser 8 и просмотр координатором 4 текущих изображений после правки 3 файлов layout. Counts раздельные и не суммируются; детали — в [11](11-implementation-progress.md#текущий-статус-по-областям).
- Не сделано: полный P1, MVP, общий Auth, приватные ACL, worker, календари, deploy, обновление старых вкладок.

## Среда

- Нативный PostgreSQL 17.5 на loopback `55432`, базы dev и test раздельны; синтетические credentials — только в игнорируемом `.env` или метаданных `/tmp`, сюда их не записывать.
- API `4310` — текущая скомпилированная сборка с локальной dev identity, `NODE_ENV=production`; Vite — `4311`. Demo-проект «Запуск команды Workloom» сохранять; migration, drop и seed на посторонней БД не выполнять.
- Перезапуск runtime и заморозку кода не предполагать до согласованного gate.

## Текущий checkpoint и следующая работа

| Зона | Владелец |
| --- | --- |
| contracts, domain, db; единственный владелец migration | foundation |
| HTTP API | backend |
| web и UI | frontend |
| корневые integration/e2e, docs 11, `docs/README.md`, docs 12 | QA |

- DTO, маршруты и ports P1b заморожены; перед следующим срезом снова согласовать контракт между владельцами.
- Принятый bounded scope: 9 типов custom fields ([06 P1.4–P1.5](06-implementation-plan.md#p1-таблица-задач-и-дополнительные-поля)), настройки полей проекта, ревизии значений и выборочная история; ручная блокировка custom field (`locked`) подтверждена в контракте; она отдельна от недельного baseline P2.
- Приёмка, реальный PostgreSQL: persist, rollback, replay, tenant safety; стабильные IDs options и сохранение при архиве; валидация типа; null отличается от 0; история с момента включения, отключение не удаляет записанное; блокировка действует во всех каналах; конфликт параллельных ревизий.
- Приёмка, реальный browser: создание поля, правка, перезагрузка, история — desktop и mobile.
- Bounded P1b принят root после исправления 3 визуальных findings. Source checkpoint `dee59bae06be4505b4a60e0bf469d31c8816aeda`; отдельный docs-only provenance commit `67ca7d47ca8ca456300c5d85550d2b5a01efa47d`, после каждого дерево было чистым. Раздельные факты gate — только в [11](11-implementation-progress.md#текущий-статус-по-областям). Полный P1/MVP не завершён.
- Root выпустил P2a: foundation сначала фиксирует DTO/ports/routes и `docs/13`; QA пишет приёмку после frozen shape, frontend/backend работают по тому же контракту. Контракт [13](13-p2a-contract.md) заморожен; Ограниченный P2a реализован и принят локально. Core/API, реальный PostgreSQL и финальный web/browser gate завершены; точные раздельные результаты — в11. Координатор принял bounded P2a после timezone correction и просмотра4 текущих кадров; source checkpoint ожидается. Runtime/build изменения только в согласованном окне.
- P2a acceptance: исходный vs недельный план, Worklog revisions и weekly precision, self/project freeze с source freshness, identity locks при missing rows и removal участников, auto-freeze commit+409 против неожиданного SQL rollback, current ACL при replay/чтении pinned reports и tenant isolation, дедупликация tags/participants. Split/transfer/carryover/close сверх согласованного P2a остаются P2b, не pass.

## Матрица P2a и оставшиеся границы

Срез назначил root, замороженный контракт — [13](13-p2a-contract.md). Ограниченная приёмка по [06](06-implementation-plan.md#p2-недельный-план-факт-и-первые-отчёты) и [07](07-verification-and-pilot.md#инварианты-модели-и-истории): immutable baseline против факта, added scope, carryover, allocations, missing отличается от 0, недельная точность, без смещения к завершённой когорте. Core/API, реальный PG и web/browser gate выполнены; bounded P2a принят координатором, source checkpoint ожидается. Carryover/transfer/close и explicit late acceptance остаются P2b, не pass. Post-freeze новая работа остаётся разрешена, но server-derived added/unplanned относительно immutable personal/project baseline; detail child суммируется по тому же package, added_scope отдельно. Выбранное missing value/estimate блокирует identity даже без строки значения, позднее заполнение не становится original.

## Журнал checkpoints прогона

| Время UTC | Срез | Статус | Ссылка на доказательство в 11 |
| --- | --- | --- | --- |
| после root visual acceptance (16 октября local) | bounded P1b | принят локально; source `dee59bae06be4505b4a60e0bf469d31c8816aeda`, дерево после коммита чистое | [11](11-implementation-progress.md#p1b--targeted-gate-после-визуальных-исправлений) |
| после root visual acceptance (16 октября local) | bounded P2a | принят локально; source checkpoint ещё не создан | [11](11-implementation-progress.md#p2a--targeted-gate-после-timezone-finding) |
