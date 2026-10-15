# Workloom

Workloom is the provisional name for a team task tracker. This monorepo holds a React/TypeScript client and Node.js/TypeScript backend. The repository contains application code: a locally verified P0 (React → Fastify → PostgreSQL with a synthetic development identity) and a locally verified bounded P1a (projects, sections, statuses, tags, workspace-visible tasks with shared work-package estimates). Full P1 (private ACLs, shared Auth, typed custom columns, history UI, saved views, bulk edits) and later stages are not done. Use `README.md` for setup and `docs/11-implementation-progress.md` for what was actually verified, when and by whom.

## Start here

Read `README.md`, `docs/README.md`, and the documents relevant to the assigned milestone. Preserve requirements from `docs/01-product-spec.md`; the newer implementation decisions in `docs/02-architecture.md` govern staging and technical choices.

## Working boundaries

- Keep client code in `apps/web`, server adapters in `apps/api`, jobs in `apps/worker`, shared contracts in `packages/contracts`, domain commands in `packages/domain`, persistence in `packages/db`, and shared UI in `packages/ui`.
- Run all commands with this repository as the explicit working directory. Commands described in planning documents are intended future interfaces until implemented; do not claim they already run.
- Preserve other contributors' uncommitted changes and stay within assigned files.
- Early local versions may use a development identity adapter without login. Keep workspace/actor context and permission checks in domain commands. The no-login mode is for local development with synthetic data, not a deployable public authentication bypass.
- UI, HTTP, MCP, imports and background jobs use the same domain commands and access rules. Baselines and confirmed history are corrected by revision, not silently overwritten.
- Entity IDs are UUIDs; the shared `idSchema` in `packages/contracts` canonicalizes them to lowercase, and domain code compares IDs case-insensitively.
- Do not deploy, publish, provision paid services, send invitations or external messages, change secrets, or perform destructive data operations without the user's authorization.
- Before reading or editing a sibling product, announce the target, inspect its Git state and read local instructions. Do not import sibling product source at runtime.
- Verify only the affected scope. Documentation changes require link and consistency checks; implementation requires the milestone's meaningful tests. No website build is needed for documentation-only changes.
- If Claude CLI is used, pass `--model opus` unless Pavel requests a different model; preserve actual review provenance.
