# Workloom: передача локального пилота

16 октября 2026, создано06:30 UTC, обновлено после root acceptance06:38 UTC. Автор — Codex gpt-6.1-sol high. Это практическая памятка для следующей сессии, не новый release approval. Ограниченные P0–P5a приняты; source checkpoint P5a — `0fcb2cd7533520d47dc3e48541107cc006cdb2ed`. **Ограниченный P5b MCP A+B принят root в06:38 UTC** после раздельных core/PG/protocol/browser/visual gates; source checkpoint добавляет координатор. Точные результаты, исправления и окончательный checkpoint смотреть в [журнале](11-implementation-progress.md) и [состоянии прогона](12-active-run.md).

## Открыть сейчас

Репозиторий: `/Volumes/PavelData/ai/workloom`. Оптимизированный локальный app/API — [http://127.0.0.1:4310](http://127.0.0.1:4310); Vite для разработки — [http://127.0.0.1:4311](http://127.0.0.1:4311). Readiness: [GET /healthz/ready](http://127.0.0.1:4310/healthz/ready), ожидается точное тело `{ "status": "ok", "checks": { "database": "ok", "schema": "ok" } }`. Сам по себе HTTP200 не подтверждает пользовательские сценарии: их отдельная приёмка остаётся в журнале.

Работает **только синтетическая локальная identity**, без входа реальных пользователей. Dev-переключение участников — проверка ролей fixtures, не Auth и не приглашения команды. Временный нативный PostgreSQL17 слушает только `127.0.0.1:55432`; существующий `.env` уже связан с ним. Не заменять `.env` примером Docker54329, не останавливать чужие PostgreSQL и не сбрасывать seed/БД ради запуска. Credentials в Markdown не копируются.

### Если процессы уже работают

Открыть app и readiness; второй API на4310 не запускать. Перед рестартом проверить владельца текущего процесса и [active run](12-active-run.md): PID/session меняются в QA. Остановить только свой API/web через его терминал или graceful SIGTERM, дождаться выхода, затем запускать заново. После API restart старый signed cursor может получить400 — перезагрузить соответствующий список. Не повторять неизвестную запись с новым ключом: использовать исходную отправку.

### Если нужно поднять остановленный checkout

Node24.19.0 закреплён в `.node-version`/`.nvmrc`; команды выполняются из корня:

```sh
cd /Volumes/PavelData/ai/workloom
node --version
npm run dev
```

На этом компьютере Node24 доступен также в `/Users/pavelignatov/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin`. Сначала включить его в PATH, если shell показывает другую версию. Зависимости уже установлены; для чистой копии — `npm ci`, полный порядок установки и создания новой БД находится в [README](../README.md#локальный-запуск). Если существующий PostgreSQL остановлен, сначала восстановить именно согласованный локальный cluster; не создавать поверх него новый.

Для проверки собранной SPA вместо Vite, после остановки прежнего API:

```sh
npm run build
NODE_ENV=production npm start
```

`NODE_ENV=production` здесь означает сборку; `APP_ENV=local`/`AUTH_MODE=dev` остаются локальной границей. Это не deploy. После новых migrations отдельным согласованным шагом выполнить `npm run db:migrate` до старта новой версии; startup сам DDL не делает.

Worker запускается отдельно, `npm run dev` его не включает. После явной подготовки application/queue schema — `npm run db:queue:migrate`, затем `npm run start --workspace @workloom/worker`. Проверять `worker.health`/`worker.health_queue`; останавливать graceful SIGTERM. Не включать worker посреди controlled demo/QA без координации. Подробности: [worker README](../apps/worker/README.md).

## Обзор за 5–10 минут

**Ссылка на финальную демонстрацию ожидается от QA.** Пока здесь нет выдуманных project/period/report IDs или утверждения, что новый demo уже записан. После готового manifest добавить ниже ссылки на таблицу, неделю, отчёты, граф, Gantt и встречу. Проход можно выполнить чтением; новые записи безопаснее пробовать в отдельном синтетическом проекте.

1. **Таблица, 1–2 минуты.** Открыть задачу и участников, колонку с историей, текущую оценку. Общая оценка относится к одному WorkPackage; detail child делит пакет, `added_scope` создаёт отдельный. Не складывать один пакет повторно по детям/людям.
2. **Неделя и план/факт, 2 минуты.** Явно выбрать период и человека. Различить текущий бюджет, личный недельный план и исходный зафиксированный baseline. Открыть сохранённый отчёт: он закрепляет версии, а не пересчитывает прошлое из текущей таблицы. Ноль, отсутствие записи и void различаются.
3. **Общая встреча, 1–2 минуты.** Открыть одну задачу встречи: план предлагается отдельно, фактическое присутствие — отдельная atomic команда. Invitation/список участников сам не начисляет часы. Present/partial/absent/unknown показывают разные состояния; сохранённая ссылка/длительность сама не переписывает факт.
4. **Зависимости и даты, 1–2 минуты.** Переключить таблицу в граф и Gantt. Blockers определяются сервером; личное положение узлов не двигает задачи. Date-only диапазон не выводится из оценки в часах. Изменение дат сначала показывает preview; baseline overlay не подставляет текущую дату вместо неизвестной старой.
5. **Типы работы и импорт, 1–2 минуты.** Открыть pinned отчёт по категориям: «Без категории» входит в знаменатель; теги могут пересекаться. В импорте посмотреть staging/mapping/reconciliation. Исходные HoursEst/HoursFact сохраняются с явными единицами в выбранных колонках, не становятся исходной оценкой или weekly fact автоматически.
6. **Локальный MCP, принят P5b.** Workspace → «Интеграции»: личные scopes, срок и отзыв. Секрет виден один раз в памяти браузера, сервер хранит hash/metadata. Запускать compiled main напрямую, без npm banner; точная [конфигурация клиента](../apps/mcp/README.md). На unknown write повторять EXACT original call и `operationKey`; membership/revocation проверяются и перед старым cached result.

## Что готово и где граница

| Доступно локально | Ограничение |
| --- | --- |
| Таблица, задачи/подзадачи, роли fixtures, типизированные колонки и история | Workspace-visible модель; нет полноценного private ACL, saved views, bulk paste и общей истории всех built-in полей |
| Личные недельные планы, immutable freezes, ручной факт, категории и pinned reports | Нет полного close/corrections/carryover/transfer workflow, daily precision, required fact on Done и общего report builder |
| Разовые/конечные recurring meetings, присутствие, версии/исключения и отдельный worker | Не внешний календарь, не рассылка приглашений, не произвольная бесконечная recurrence; cross-period move ограничен |
| Зависимости, warn/status-enforce, личный граф, ручные даты и bounded Gantt | Нет автопланирования/cascade, pointer drag/resize, resource calendar и исторической топологии |
| CSV import до50 data rows, пять scalar types, явные существующие ссылки, preview/atomic apply/reconciliation | Нет полного Asana JSON/API enrichment, comments/attachments/private ACL migration; исходная история не придумывается |
| Принятый bounded MCP A+B:7 reads+2 guarded writes, self credentials | Только local stdio/loopback, без remote MCP/OAuth и без заявления полного P5.8 |

Shared Auth ещё не подключён; создание реальных workspace/приглашение/принятие приглашений и отзыв настоящих sessions не реализованы. Railway — [план эксплуатации](08-railway-and-operations.md), а не созданные production-сервисы. Локальные migrations/health не заменяют staging, backup/restore, old-tab upgrade и разрешённый deploy. Внешние Google/Microsoft календари — [будущий opt-in read-only connector](10-calendar-integration.md), не зависимость текущего пилота.

## Следующая сессия

1. Зафиксировать финальный source checkpoint, demo manifest/ссылки и раздельный статус MCP/браузера/upgrade из QA. Сохранить локальные данные; начать с working-tree и active-run проверки.
2. Для реальной команды приоритет — P6: Shared Auth/BFF, настоящие membership/invite/revoke и private ACL во всех таблицах, поиске, отчётах, meetings, MCP. До этого не переносить сюда частные пользовательские данные.
3. Провести разрешённый Asana dry run с явным manifest/scope, сверкой задач/связей/часов и согласованием непереносимых данных. Текущий CSV пилот расширять только под проверенный экспорт, без подмены current значений historical baseline.
4. Подготовить staging/production image app+worker, явный migration step, backup/restore, recovery/monitoring и old-tab upgrade; затем запросить разрешение на конкретный Railway выпуск и недельный пилот5–7 человек.
5. После обратной связи выбрать оставшиеся P1/P2/P4/P5 функции; внешний calendar connector и remote MCP/OAuth не блокируют первый согласованный недельный цикл.

Полная последовательность и будущие критерии — [план P0–P6](06-implementation-plan.md), проверки — [pilot checklist](07-verification-and-pilot.md). Этот handoff их не заменяет и новых инфраструктурных действий не разрешает.
