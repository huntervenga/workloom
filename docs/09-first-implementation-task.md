# Первая задача реализации Workloom

Задание на P0, подготовлено 16 октября 2026 года. Исторический документ: остаётся эталоном приёмки и handoff P0, не отчётом о выполнении. Статус: локальный checkpoint P0 проверен 16 октября 2026 года в рабочем дереве без коммита; фактические команды, результаты и ограничения (включая неисполненный Docker-путь) — в [11](11-implementation-progress.md). Позднее локально проверен ограниченный P1a (см. 11); этот документ новых задач не ставит.

## Цель

В `/Volumes/PavelData/ai/workloom` подготовить запускаемую React/TypeScript + Node.js/TypeScript монорепу с PostgreSQL. Пользователь открывает локальный UI без логина, видит тестовое пространство из базы и индикатор тестовой личности. Исторические часы, встречи и полноценная task table пока не нужны.

Прочитать [AGENTS](../AGENTS.md), [архитектуру](02-architecture.md), [план](06-implementation-plan.md), релевантные разделы [данных](03-domain-and-data.md) и [API](04-api-and-integrations.md). Сохранить всю существующую документацию и чужие правки.

## Входит

1. npm workspaces и один lockfile; Node 24 LTS и TypeScript strict.
2. Реальные workspace packages: web, api, contracts, domain, db, ui/config по необходимости. Worker оставить структурой до P3.
3. Fastify app factory отдельно от listen; structured errors, request IDs, validated config, graceful shutdown.
4. PostgreSQL local container; Drizzle migrations для минимальных user/workspace/membership записей; idempotent demo seed.
5. Dev IdentityAdapter, server-controlled actor, CommandContext и проверка workspace membership. Запуск dev adapter при APP_ENV=staging/production или Railway environment отклоняется.
6. Workspace list/read API с Zod schemas. Отдельные live/ready endpoints; ready проверяет базу и применённую схему.
7. React/Vite shell в стиле Thermis: sidebar, workspace header, простое содержимое и Query loading/error/empty states.
8. Один запрос UI → API → PostgreSQL. Dev proxy с единым выбранным портом API; не копировать несовпадающие значения из разных Thermis docs.
9. Документированный local quickstart, .env.example без секретов, lint/typecheck/unit/integration/browser smoke.
10. Оптимизированный dist build локально отдаёт SPA через API: APP_ENV=local, NODE_ENV=production, AUTH_MODE=dev, loopback и синтетическая БД. NODE_ENV не заменяет проверку окружения; этот локальный smoke режим запрещён в Railway. Railway resources не создавать.

## Не входит

Task CRUD, все custom fields, freeze, worklogs, meetings, Gantt, Auth UI, real invitations, deployment, реальные импорты и внешние сообщения. Не создавать фиктивные завершённые функции и пустые pass-tests на будущие модули.

## Требуемый результат

- С чистого checkout воспроизводимо устанавливаются зависимости и запускается локальный PostgreSQL.
- Миграции применяются на пустую БД и повторно безопасно определяют отсутствие новых миграций.
- Demo seed создаёт два пространства и пользователей с явными memberships; повтор seed не удваивает записи.
- В браузере видны название пространства и тестовый actor из API.
- Запрос workspace без membership не раскрывает название и данные.
- Ошибка DATABASE_URL даёт понятную конфигурационную ошибку без печати credentials.
- Health/readiness не раскрывают секреты или имена частных пространств.
- `npm run build`, `typecheck`, `lint` и нужные тесты реально работают; README содержит именно реализованные команды.

## Проверки

Unit: config rejects unsafe dev mode, policy grants/denials, error mapping. Integration: реальные PostgreSQL migrations/seed/query; rollback одного failed write. Browser: start → workspace loading → content, API error state. Smoke production build: HTML и referenced JS/CSS доступны, неизвестный API route не возвращает HTML SPA.

Если Docker или тестовый PostgreSQL недоступны, оставить это как blocked check, не подменять результат in-memory тестом и не называть P0 готовым.

## Отчёт по завершении

Вернуть изменённые файлы, как запустить, команды и результаты проверок, screenshot рабочего shell при доступном браузере, ограничения и готовность к P1. Деплой и публикация не выполняются. Новый чат автоматически не создаётся: задание можно использовать в отдельном Codex-проекте Workloom по решению Павла.
