# Создание секций проекта

**Принятый локальный web-only срез `808cd8d`, активен на `http://127.0.0.1:4310/app`.**
Frontend продвинут18 октября2026,18:42:30UTC поверх неизменённого backend baseline `306ed35`.
API/PG/Vite не перезапускались; DB mutations/migrations этим продвижением не выполнялись, workerOFF.
Это не реализация generic reports и не public deployment.

## Как пользоваться

В проекте откройте **More add options → Add section**.
Встроенная форма **Add section** показывает **Section name** и сразу передаёт фокус в название.
Введите название и нажмите Enter; Escape отменяет незавершённое создание.
Создание пустой секции не требует фиктивной задачи.
Новый header должен быть виден в scrollport, в том числе при повторном создании; sticky controls его не скрывают.
Форма владеет focus/scroll только пока активна: клик вне неё или смена вида прекращает автоматический возврат фокуса.
Это сохраняет возможность продолжить работу с соседними controls и не перетягивает пользователя обратно.
При группировке **Assignee** действие **Show sections** переключает **Group by** на **Section**.
Секции хранятся независимо от текущей группировки; другая группировка не означает потерю данных.
Существующие права, сохранение задач и обычный Manual order не заменены новым UI.

## Что проверено

| Проверка | Фактический результат |
| --- | --- |
| Canonical Node24 web build | PASS: tsc+Vite,82 stage files, final V3 через helper V2 |
| Focused component |31 tests/3 files PASS,29,29с; ProjectSectionCreation/ProjectSorting/taskGrouping |
| Compiled Chrome |4/4 PASS,14,9с;1440×720,light/dark, cleanup/catalog restoration true |
| Visual inspection | Root просмотрел4 PNG текущего прогона |
| Main static promotion | PASS18:42:30UTC; live188files, lock released |
| HTTP/static |112 старых JS/CSS response bodies сохранены по bytes/MIME;25 новых resources/documents проверены |
| Runtime preservation | health до/после200 с DB/schema ok; process identities/env/904 backend compiled files неизменны |

Это отдельные actual commands; большие suites baseline306ed35 не запускались повторно для section UI.
Chrome использовал private synthetic workspace/fake Auth/private PG; результаты не подтверждают реальный вход на main.
User main-browser inspection через CUA остаётся недоступным из-за environment error, не считается PASS.
Новая проверка physical mobile, live Google, настоящая старая вкладка и production deployment не заявлены.
Синхронная пара rename может дать короткий directory gap; zero-downtime не обещается.
При ошибке проверки helper предусматривает восстановление старого дерева; успешный путь здесь завершился без rollback.

## Точные proofs

- Build: `/private/tmp/workloom-sections-20261018-runtime-candidate/v2/build-hgjz4s/proof.json`; SHA `1ea31a505b866b67dacb9e8dd54a183360cb29d45f8f4e5d2e12a990f34c9b29`.
- Focused: `/private/tmp/workloom-sections-20261018-runtime-candidate/v2/focused-IMfrKv/proof.json`; SHA `53e6680a58d128b9b90c439e0d5ea49b11d725ca657fa26744e0a18612f6f004`.
- Chrome: `/private/tmp/workloom-sections-20261018-qa/v2/run-sections-BARtO6/proof.json`; SHA `c2cdbbf0c095bb0446f91be4e5baebbb61cd2509bd565d0033ed7baffbaca0ba`.
- Promotion: `/private/tmp/workloom-sections-20261018-runtime-candidate/v2/promotion-c5hxri/proof.json`; SHA `d74f344124175d0d00105c25670dfe5e69d4bf0621afa5063a54b503ac334996`.

## История и границы

Первый compiled native i2JGgu остаётся RED: созданный header действительно оказался вне viewport.
Focused tests также обнаружили stale-header ошибку при втором создании; она исправлена до final V3.
Последний4/4 — новый прогон на новых bytes, не переименование ранних результатов.
Source review helper обнаружил ложный success receipt при ошибке lock cleanup; исправление требует release lock до pass.
Прежние global/full backend/full web/integration/native scopes и Docker RED сохраняются в [84](84-team-pilot-plan.md)/[85](85-hosted-runtime-preparation.md).

**Продуктовый P0 не закрыт:** переход native Plan/Fact на обычные поля, настраиваемый report builder и generic footer/group aggregates из [86](86-generic-fields-and-reports.md) НЕ реализованы. Обычные custom/duration-поля уже существуют.
Native week/person accounting остаётся прежним отдельным сценарием; он не является generic полем или отчётом.
Этот section UX не меняет old logs/baselines/reports и не выполняет их миграцию.
Для пилота по уточнённой модели нужен контракт86, а для размещённого релиза — также remaining Docker/realAuth/managed restore/old-assets gates.
Командная памятка — [66](66-team-quick-start.md), текущий pilot go/no-go — [84](84-team-pilot-plan.md).
