# Workloom

Workloom is a team task tracker in the spirit of Asana, built around planning and time: tasks in projects and sections, custom fields, plan versus actual reporting, time off and capacity, dependencies and a Gantt view, and imports from Asana. "Workloom" is a working name, not an approved public brand.

It is an npm-workspaces monorepo: a React + TypeScript + Vite client, a Node.js + TypeScript + Fastify API, and PostgreSQL with Drizzle for storage.

## Features

- **Projects and tasks:** sections, statuses, tags, subtasks, assignees and collaborators, a task can live in several projects, inline editing in the table, Board, Timeline/Gantt and dependency graph views, Undo for moves and deletes.
- **Custom fields:** typed, project-scoped fields (text, number, duration, choice and more) with stable option IDs, value history and locks.
- **Planning and reports:** configurable reports and summaries, plan versus actual, soft planning checks, per-project defaults for new tasks, project copy without tasks.
- **Time off and capacity:** leave policies, requests and approvals, working-time capacity, team calendar.
- **People:** workspaces, roles, personal invitations, pending teammates that can be assigned work before they join, shared sign-in.
- **Import:** reusable two-file Asana import (JSON plus CSV) from the Projects page, and a CSV import.
- **Automation:** personal access tokens, a public REST API at `/api/public/v1` (docs served at `/docs`) and a remote MCP endpoint at `/mcp`.
- **Operator tools:** permanent delete of tasks and projects (API and CLI, see [docs/126](docs/126-permanent-delete.md)).

Shared calls (a task with a call roster and attendance confirmation) were removed on 24 October 2026; see [docs/127](docs/127-shared-calls-removed.md).

## Repository layout

```text
apps/web/            React SPA
apps/api/            HTTP API; also serves the built SPA
apps/worker/         Recurrence preparation and outbox relay (optional process)
apps/mcp/            Local stdio MCP adapter
packages/contracts/  Shared DTOs and validation schemas
packages/domain/     Application commands and rules
packages/db/         PostgreSQL, Drizzle, migrations
packages/ui/         Base components and design tokens
packages/config/     Shared TypeScript and lint configuration
infra/               Docker Compose for local PostgreSQL
scripts/             Build order, boundary checks, .env loading, operator scripts
tests/               Integration (PostgreSQL), end-to-end (Playwright) and fixtures
docs/                Specifications, guides and verification records
```

UI, HTTP, MCP, imports and background jobs all go through the same domain commands and access rules.

## Requirements

- Node.js 24.19.x (pinned in `.node-version` and `.nvmrc`)
- PostgreSQL 17 or newer (Docker Compose is provided for a local instance)
- Docker, only if you use the Compose database

Run every command from the repository root. Install dependencies strictly from the lockfile: `npm ci`.

## Quick start

```sh
cp -n .env.example .env   # synthetic values, no secrets; never overwrites an existing .env
npm ci
npm run db:up             # PostgreSQL in Docker on 127.0.0.1:54329
npm run build
npm run db:migrate
npm run db:seed:demo      # synthetic people and workspaces
npm run dev               # API on http://127.0.0.1:4310, client on http://127.0.0.1:4311
```

`AUTH_MODE=dev` in `.env.example` signs you in as a synthetic demo user. It is for local development only and must never be exposed publicly.

To use your own PostgreSQL instead of Docker, set `DATABASE_URL` in `.env` and skip `db:up`. The root scripts `dev:api`, `start` and `db:*` read `.env`; variables already set in the environment take precedence.

### Production build locally

```sh
npm run build
NODE_ENV=production npm start   # built API and SPA on http://127.0.0.1:4310
```

### Optional worker (recurring meetings)

`npm run dev` starts only the API and the web client. Automatic preparation of recurring meetings needs a separate process:

```sh
npm run build
npm run db:migrate
npm run db:queue:migrate        # installs/verifies the pg-boss schema and the approved queues
npm run start --workspace @workloom/worker
```

The worker only checks readiness at start; it never creates or repairs schema. See [apps/worker/README](apps/worker/README.md) and [docs/43](docs/43-managed-local-worker.md).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Builds libraries, then runs the API and the Vite dev server |
| `npm run build` | Builds packages and apps in order: contracts, domain, db, ui, api, web, worker |
| `npm start` | Runs the built API (`apps/api/dist/main.js`) |
| `npm run lint` | ESLint with zero warnings, browser-code boundary check and localization audit |
| `npm run typecheck` | Type checks all packages, root configs and `tests/` |
| `npm run check` | `lint` and `typecheck` |
| `npm run check:localization` | Audits translation calls against the English catalogs |
| `npm run test:unit` | Unit tests of contracts, domain, db, API and worker, then jsdom tests of the web app |
| `npm run test:integration` | Full build, then PostgreSQL integration tests and a built API/SPA smoke test (needs `TEST_DATABASE_URL`) |
| `npm run test:e2e` | Playwright browser tests in Chromium |
| `npm run db:up` / `db:down` | Start / stop the Docker PostgreSQL (`db:down` keeps the data) |
| `npm run db:generate` / `db:migrate` / `db:seed:demo` | Generate migrations, apply migrations, load the synthetic demo set |
| `npm run db:queue:migrate` | Install or verify the pg-boss schema and queues |

## Testing

- **Unit:** `npm run test:unit`.
- **Integration:** export a separate `TEST_DATABASE_URL=postgres://<user>:<password>@127.0.0.1:<port>/workloom_test`, then `npm run test:integration`. The root `.env` is not read. The database name must start with `workloom_test` or end with `_test`, and must never be the one in `DATABASE_URL`.
- **End to end:** run `npm run test:e2e:install` once, then `npm run test:e2e`. Playwright starts `npm run dev` (or reuses a running one) and opens `http://127.0.0.1:4311`. PostgreSQL must already be running, migrated and seeded.

Code conventions that are enforced by lint: no inline `eslint-disable` comments, no non-null assertions, no hardcoded UI strings (everything goes through the translation catalogs), and database migrations are additive only.

## Deployment

The hosted setup is one Railway service (`@workloom/api`) with a Railway PostgreSQL database, a custom domain behind Cloudflare, and the shared Auth service for sign-in. The image is built from the root `Dockerfile`; `railway.json` holds the service settings.

Railway runs `node scripts/hosted-migrate.mjs --apply` before each deployment. It discovers pending migrations from the built image, so new migrations need no count/hash edits in the deployment config. Already applied migrations are skipped; changed history, an older image or a failed migration stops the deployment. The API itself never migrates at startup.

- Step-by-step guide (variables, domain, Auth origin, migrations, rollback): [docs/124](docs/124-railway-cloudflare-deploy.md)
- Moving a local database to the hosted one (dump and restore): [docs/125](docs/125-data-transfer-to-hosted.md)
- Hosted runtime preparation notes: [docs/85](docs/85-hosted-runtime-preparation.md)

Never expose `AUTH_MODE=dev` on a public host. Secrets such as `AUTH_SESSION_KEY` and database URLs are set only in the hosting provider, never committed or pasted into chats.

## Importing from Asana

Use Projects, then Import, to upload an Asana JSON export together with its CSV. The importer previews the result, creates the project with sections, fields and tasks, and can be repeated safely. Details and limits: [docs/111](docs/111-local-asana-upload.md) and [docs/108](docs/108-reusable-asana-import.md). Exports contain team data and must not be committed.

## Public API and MCP

Create a personal access token on the Integrations page. The REST API lives under `/api/public/v1`, its documentation is served at `/docs`, and the remote MCP endpoint is `/mcp`. Tokens are stored as hashes only, and each request is limited to the intersection of the token scope and the user's current role. See [docs/120](docs/120-public-api-and-mcp.md).

## Adding a language

1. Copy the namespace JSON files from `apps/web/src/i18n/locales/en/` into a folder named with a valid language tag, for example `apps/web/src/i18n/locales/de/` or `fr-CA/`.
2. Translate the values. Keep the English keys, the `{{parameter}}` names and the message shape. For plurals keep an object with the mandatory `other` form. Do not add HTML. A translation may be partial: missing messages fall back to English.
3. Check the catalogs, discovery and types:

   ```sh
   npm run check:localization
   npm run test --workspace @workloom/web -- src/i18n/LocalizationManager.test.tsx src/i18n/catalog-discovery.test.ts src/i18n/audit.test.ts
   npm run typecheck --workspace @workloom/web
   ```

No registry or import needs editing: languages are discovered from the JSON files. Run `npm run build` and reload the tab; with two or more languages in the build, a language switcher appears in the top bar. English stays the default until a user chooses otherwise. Details: [docs/23](docs/23-localization-and-ux.md#add-a-language).

## Documentation

- [docs/README](docs/README.md) is the index of specifications and guides.
- [AGENTS.md](AGENTS.md) holds project rules for contributors and coding agents, plus the status of recent work.
- Product spec: [docs/01](docs/01-product-spec.md). Architecture and technical decisions: [docs/02](docs/02-architecture.md).
- Most documents under `docs/` are written in Russian and many are historical verification records. Where a record and the code disagree, the code and tests are authoritative.
