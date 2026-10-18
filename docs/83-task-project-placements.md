# Одна задача в нескольких проектах

**Ограниченный локальный контракт принят в `87fba71`, активен на `http://127.0.0.1:4310/app`.** Пользователь подтвердил **один общий canonical status во всех проектах**. Нет per-placement workflow. Final web2060/253,backend1872/106,isolated placements PG7,Chrome64/12 на одном82-artifact stage и finalcheck/build прошли. Source certificate1964source/compiled+82stage/19gates и exact main preservation — в [82](82-reports-and-five-person-demo.md). Исходное proposal теперь реализовано только в перечисленных ниже границах; полный Asana parity не заявлен.

## Одна задача, несколько присутствий

Canonical Task сохраняет task ID, содержание, ответственного/участников, даты, **общий статус**, parent/work package, комментарии и историю. `TaskDto.projectId` всегда означает home/accounting project. Additive `task_project_placements` хранит отдельные placement ID/revision и target project-local section/position. Home row обязательна:ID=task ID,home/project IDs совпадают,section/order зеркалят canonical task. Home transfer не является побочным эффектом drag/detach.

ProjectRowDto разделяет `placement`, `canonicalTask`, `canonicalStatus` и `homeProject`. Статус выбирается из статусов home project и меняется обычной canonical task command; target Board status нельзя подставить вместо него. Дополнительный placement не копирует task или package, не создаёт commitment/allocation/work log/baseline/report row. Само присутствие в проекте не выдаёт workspace membership/private ACL.

[Tasks schema](../packages/db/src/schema.ts) сохраняет canonical project-scoped parent/status/package ссылки; [DTO](../packages/contracts/src/task-project-placements.ts) и [domain commands](../packages/domain/src/tasks/project-placements.ts) добавляют отдельное присутствие. Отсутствие parent placement не создаёт копию родителя и не переподчиняет child. Используются home custom fields; target-period личный план/факт не выдумывается.

## Команды и интерфейс

Второй проект показывает linked rows отдельной секцией. Row identity — placement ID, общие edits адресуют canonical task ID/revision. Обычные сохранённые fields используют autosave, общего Save задачи нет. Attach/detach/restore и recovery остаются явными действиями. Unknown повторяет исходные target/body/key, не ретаргетируется при смене списка.

Read placements/project rows не выдаёт новые права. Все writes проверяют current task.edit/target objects под workspace barrier до replay, выполняют planning guards для home и target и записывают audit/outbox/receipt атомарно. Historical replay подтверждает прежний ответ, а не сегодняшнее placement state: после него нужен свежий authorized read. Detached identity зарезервирована до explicit restore. Home placement нельзя detach/delete; home order/section меняются существующими task commands и зеркалятся trigger.

Generic placement writes не распространяются на meeting/recurrence. Canonical parent/history и frozen sources сохраняются. Канонический archive общий, а detach дополнительного placement не удаляет Task, комментарии, dependencies или facts.

## Учёт и ограничения

Home project — единственный accounting источник personal plans/facts и authoritative recorded category. Дополнительная видимость не удваивает часы. Межпроектные сводки должны дедуплицировать task/package IDs и source/revision work logs; складывать повторные витрины в командные часы нельзя. Saved reports/baselines не переписываются; multi-tags не умножают Work type denominator.

В этом bounded slice **нет** общего home+linked bulk/manual order, linked Graph, отдельного workflow на placement и home-project transfer. Linked Timeline показывает общие home dates read-only; редактирование через pane/Home. Position linked row независим, tie-break по placement ID; это не единый adjacent splice/reindex с home rows. Private ACL/invitations/production не добавлены.

## Проверки и сохранение

Root actual isolatedPG7 PASS после сохранённого initial6/1 RED (`membership.revoked_at` fixture); scoped backend23/3,UI20/5,focus8. Final compiled placements4/4 (`/private/tmp/workloom-placements-20261018-qa/run-placements-xvG1v5/proof.json`) входит в64/12, не прибавляется повторно. Native и все11 regressions выполнены на stage SHA `3172398eaec6b42b5768cac0f07c4fd83375187c78345010e8ffb5e79a189ece`; actual source/compiled certificate SHA `2362957f20103e643c6744363015ee4aa81f60135cb5243b006a7707298fbd4c`.

Main activation PASS:только0017,78→79tables/17→18ledger,старые rows/columns/schema/ledgerprefix неизменны,1816homes/1816tasks/mismatch0. Затем отдельный additive demo apply/replay139/0 сохранил прежние строки и те же IDs. Нет копирования tasks/projectId rewrites/fact doubling или потери freeze. Env/PG/Vite/workerOFF и actual old/new served bodies проверены отдельно, подробный proof — в82. Main browser CUA blocked до inventory; queued UI opening не является authenticated verification. Нет нового live Google/old-tab/production/physical-mobile claim.

Rapid-child defect7fKKDt/causal RED и cancellation/cache follow-up сохранены в82; final page-owned read после Close покрывает403/500/unmount,49/6PASS30.70s,lint/noemit0,independent bounded review noP1/P2. Это не повод объявлять прежние RED harmless. Actual author/review provenance сохраняется, declined optional review не считается выполненным.

Для ручного пилота использовать demo synthetic задачи: показать одну Task в двух проектах, изменить общий статус и проверить обе страницы/reload; independent target section/order не меняет canonical parent/home; detach/restore/unknown retry не дублируют задачу или часы, original saved report остаётся прежним. Ссылки на созданные team/person/Work type отчёты — в82. Связанные контракты: [planning](13-p2a-contract.md),[work categories](14-p2b-contract.md),[dependencies](17-p4-contract.md),[manual order](78-task-row-and-manual-order.md),[task pane/Activity](81-task-pane-profile-history-and-bulk.md).
