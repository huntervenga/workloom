# Railway и эксплуатация Workloom

План от 16 октября 2026 года. Railway выбран как предпочтительная площадка. Сервисы, домены, переменные и deployment ещё не созданы. Начальные версии работают локально. P6 подключает общий вход и Railway после P3 и минимального импорта; оставшиеся P4/P5 могут внедряться уже после первой командной недели.

## Топология

```text
Browser -> Railway app [Fastify API + built React SPA]
                    -> PostgreSQL [application + audit + outbox + queue]
          Railway worker [same commit/image, separate process]
                    -> PostgreSQL
                    -> approved integration endpoints later
App -> existing shared Auth
App/worker -> object storage only when actual file uploads are enabled
```

App не требует persistent volume: исходники/собранные assets входят в image, пользовательские файлы — в отдельном storage, данные — в PostgreSQL. Worker не имеет публичного домена. PostgreSQL и внутренние соединения используют private networking; публичный DB proxy не нужен для повседневной работы приложения.

Railway поддерживает shared JavaScript monorepos и отдельные start commands. Для наших shared packages build context остаётся корень репозитория; установка rootDirectory в apps/api отрежет packages и lockfile. [Monorepo deployment](https://docs.railway.com/deployments/monorepo). Внутренние адреса и настройки соединений сверяются с [private networking](https://docs.railway.com/networking/private-networking).

## Окружения

| Окружение | Identity | Данные | Назначение |
| --- | --- | --- | --- |
| local | dev fixture actor или test session | Синтетическая БД | Начальная разработка и дальнейшие локальные проверки |
| CI | Fixture actor/injected test principal | Изолированный PostgreSQL на run | Unit/integration/browser проверки |
| staging | Shared Auth | Синтетические fixtures и разрешённый test import | Полная репетиция P6 |
| production | Shared Auth | Данные команды | Пилот и последующая работа |

Ни APP_ENV=production/staging, ни обнаруженная Railway environment не стартуют с dev actor. NODE_ENV=production обозначает оптимизацию runtime и не заменяет APP_ENV: P0 может проверять собранные dist при APP_ENV=local, bind на loopback и синтетической БД. Этот local smoke не разрешает публичный hosting и не является проверкой входа. Для раннего удалённого demo возможен отдельный будущий режим с внешним ограничением доступа и синтетическими данными, но он не является скрытым fallback текущего плана.

## Будущая сборка

На P0 определить npm scripts, на P6 добавить `infra/docker/Dockerfile`, `.dockerignore`, `infra/railway/app.toml` и `infra/railway/worker.toml`. Это будущие файлы, сейчас они не существуют.

Порядок multi-stage image:

1. Закреплённый Node 24 LTS base и npm ci от корня.
2. Сборка contracts/config, domain/db, api/worker, web.
3. Runtime stage содержит production dependencies и dist нужных packages, миграции и собранный SPA.
4. App запускается будущим `npm run start:api`; worker — `npm run start:worker` из того же image revision.
5. `.env`, тестовые exports, локальные базы, секреты и лишние fixtures не входят в runtime image.

Зависимости, нужные при runtime (Fastify, ORM, contracts runtime, queue), не должны случайно оказаться только в devDependencies. Проверка production image обязана выполняться без mounted checkout и node_modules разработчика.

Railway app слушает `0.0.0.0:$PORT`; local dev — loopback. Built SPA использует relative `/api/v1`, не требует зашитого внешнего API origin. Public Vite variables считаются публичными; секреты туда не передаются.

## Configuration contract

| Переменная | Где | Значение/назначение |
| --- | --- | --- |
| NODE_ENV | Все процессы | development/test/production; оптимизация runtime, не доверенная граница доступа |
| APP_ENV | API/worker | local/test/staging/production; явная граница режима исполнения |
| AUTH_MODE | API | dev локально; shared staging/production |
| DATABASE_URL | API/worker/migrator | PostgreSQL URL через secret/reference |
| HOST, PORT | API | Loopback локально; Railway injected port |
| APP_ORIGIN | API | Точный разрешённый origin для cookie/callback |
| AUTH_ISSUER, AUTH_AUDIENCE, AUTH_JWKS_URL | API | Согласованные параметры общего Auth |
| SESSION_ENCRYPTION_KEY | API | Защита восстанавливаемых refresh secrets в BFF |
| DEV_ACTOR_ID | Только local | Allowlisted fixture identity |
| JOB_CONCURRENCY | Worker | Малое стартовое значение с замером DB lock wait |
| LOG_LEVEL | API/worker | Структурированные логи без содержимого частных задач |
| STORAGE_* | При включении uploads | Bucket/endpoint/credentials отдельно от браузера |

Точные имена утверждаются контрактом config на P0/P6 и обновляются во всех документах вместе. Не хранить реальные значения в Markdown или .env.example. API/worker pools ограничиваются общей ёмкостью PostgreSQL; начало — малые pools с замером, а не по 100 соединений на процесс.

## Миграции

Drizzle generate создаёт reviewed SQL в packages/db/migrations. Для каждого изменения: schema version, совместимость старого app/worker, проверка existing rows, backfill plan и возможность вернуть код без отката данных.

Railway pre-deploy может выполнить команду миграций до запуска новой версии; она должна быть самостоятельной, входить в image и не зависеть от app/volume filesystem. [Pre-deploy command](https://docs.railway.com/deployments/pre-deploy-command).

Запускать миграции из одного release step/app service, не независимо каждым worker replica. Дополнительный PostgreSQL advisory lock защищает от двойного запуска. При неуспехе выпуск не переключается. Очередь pg-boss имеет собственный schema lifecycle: закрепить совместимую версию, отдельно проверить upgrade и режим миграций; не допускать гонок между несколькими процессами startup.

Использовать expand → backfill → switch → contract для несовместимых изменений. Старые колонки/события удалять после окончания совместимости со старым image и jobs. Rollback application image не означает автоматический rollback SQL. Snapshot/worklog tables не пересоздаются из current task state.

## Worker и восстановление

Задания: occurrence generation, cutoff sweep, internal notifications, import batches, отчёты, outbox relay и approved webhook delivery. Обработчик получает workspace и actor/service context, проверяет текущие права, когда job действует от пользователя. Системный cutoff имеет узкую явно назначенную capability.

Для каждой queue: max concurrency, timeout/lease, bounded retry with backoff, failure reason и manual retry. Доставка считается at least once; business source/idempotency constraints не допускают повторного начисления. Отсутствие Redis не означает отсутствие очереди: pg-boss хранит состояние в PostgreSQL.

При SIGTERM worker прекращает брать jobs, завершает короткие операции либо отдаёт lease на retry; API перестаёт принимать новые запросы и завершает активные транзакции. Нельзя держать DB lock во время HTTP-запроса, загрузки файла или ожидания внешнего сервиса.

## Health и наблюдаемость

На P0 согласовать и реализовать `/healthz/live` и `/healthz/ready`. Live показывает, что процесс отвечает; ready проверяет доступ к PostgreSQL и достаточную schema version. Ответ не содержит имён workspace, приватных данных или credentials. Worker health — heartbeat и queue lag, а не фиктивный HTTP 200.

Railway healthcheck вызывает readiness во время deployment и не заменяет постоянный мониторинг. Он использует PORT; hostname healthcheck должен проходить фильтр приложения. [Railway healthchecks](https://docs.railway.com/deployments/healthchecks).

Минимальные показатели: errors/latency по типам commands, DB lock wait/pool usage, failed jobs, queue lag, due-but-unmaterialized recurrences, cutoff lag, import mismatch count, backup/restore status. Пользовательские тексты, записи звонков, tokens и private names в логах не нужны. Audit trail бизнес-изменений хранится отдельно от operational logs.

## Assets и старые вкладки

API и authenticated HTML — private/no-store по контракту; hashed JS/CSS — долгий immutable cache. Приватные attachments не размещаются под общедоступным cache path. Не вводить zone-wide DNS/cache rules ради этого продукта.

При release старый tab может запросить прежний lazy chunk. Для пилота выбран управляемый переход: bootstrap заранее содержит обработку version mismatch/chunk-load failure и показывает «Доступно обновление» с возможностью сохранить либо скопировать незаписанный ввод перед reload. Нельзя автоматически перезагружать страницу и терять черновик. Этот сценарий проверяется до первого реального выпуска; открытие нового HTML не доказывает поддержку старого tab. Хранение assets нескольких совместимых выпусков в object storage — возможное дальнейшее улучшение, не скрытая зависимость пилота.

API должен принимать прежнюю совместимую DTO revision в заявленном окне upgrade. Повтор mutation использует прежний idempotency key; refresh страницы не должен отправлять attendance заново с новым источником. Тестируется раскрытый task drawer и незавершённое редактирование перед выпуском.

## Резервирование

Для PostgreSQL настроить доступные в выбранном Railway плане scheduled backups; оценить PITR отдельно по фактической конфигурации и стоимости. Railway документирует volume backups и PostgreSQL PITR, но это не подтверждение их включения у нас. [Database capabilities](https://docs.railway.com/databases), [PITR](https://docs.railway.com/volumes/point-in-time-recovery).

Перед пилотом выполнить restore в отдельную базу, сверить counts, baseline IDs, worklog revisions, отчёт F01–F15 и пройти login/membership mapping без изменения Auth production. Очереди/outbox после restore сначала остановлены: согласовать watermarks и историю доставок, затем включать consumers, чтобы не повторить внешние сообщения.

Предлагаемые цели для пилота: допустимая потеря до 24 часов при ежедневной backup, восстановление в пределах рабочего дня. Это стартовые цели, а не обещанный SLA; если они неприемлемы, настроить меньший RPO/PITR до реальных данных. Выбор частоты и retention требует фактической проверки тарифа. Файлы требуют отдельного backup/retention, один DB backup их не сохраняет.

## Порядок первого выпуска

1. Зафиксировать candidate commit, schema, app/worker image и completed checks.
2. Пройти auth/private/worklog/recurrence/базовые report/import fixtures в staging. Graph/полный builder/MCP проверять при их включении; отсутствующие модули явно отмечать вне объёма раннего пилота.
3. Проверить backup restore и app rollback на совместимой schema.
4. Подготовить точный Railway service/env/domain plan без изменения соседних продуктов; получить разрешение на конкретный выпуск.
5. Выполнить portfolio public-health baseline по [runbook HQ](../../pavel_ignatov/ops/runbooks/production-release.md).
6. Выполнить migrations, проверить readiness; запустить app и совместимый worker.
7. Проверить API тела, HTML, JS/CSS, authenticated UI, private meeting, старый tab и queue effects.
8. Повторить portfolio baseline; записать отклонения отдельно, остановить rollout при регрессии.
9. После отдельного cutover rehearsal включить реальную пилотную неделю.

## Откат

При проблеме отключить конкретную feature/consumer и остановить новые опасные writes, сохранив уже записанное. Вернуть совместимый предыдущий image, проверить schema compatibility и работу часов. Если нужна коррекция данных, сначала экспортировать изменения/сделать backup и подготовить явный migration plan. Никогда не заменять production локальной fixture database.

Новые сообщения, покупка сервиса, реальное приглашение, provision и production deployment не входят в выполненную подготовку. Проверка ссылок этого документа не является release verification.
