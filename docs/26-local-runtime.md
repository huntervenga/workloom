# Durable local Workloom startup

This guide operates the **existing synthetic local installation**. It does not create, migrate, seed, restore or reset a database. Local users and tasks live in the durable ignored `.local/postgres/data` directory, independent of application processes. Existing credentials remain in the private root `.env`.

## Start after reboot

From this repository:

```sh
export PATH="/Users/pavelignatov/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
node --version
node scripts/local-runtime.mjs doctor
node scripts/local-runtime.mjs start
```

Use Node.js 24. The helper currently supports this macOS native PostgreSQL installation. A stopped service makes `doctor` exit 1 with a status line; that is an observation, not an instruction to initialize data. `start` starts the existing PostgreSQL 17 cluster, compiled API and Vite development UI. Plain `start` preserves an already helper-owned worker but never starts a new worker; an OFF worker remains OFF. It reuses an existing service only when its listening PID, repository working directory, command and readiness are verified. Unknown port owners cause a refusal; the helper never kills them.

Open the compiled app at [127.0.0.1:4310](http://127.0.0.1:4310), or current development UI at [127.0.0.1:4311](http://127.0.0.1:4311). API readiness requires the response body to report database and schema `ok`. This health check does not certify browser workflows or worker jobs.

No OS login agent or automatic startup service is installed. Run `start` explicitly after reboot. No shell sourcing of `.env` occurs; Node parses it and keeps credentials out of command arguments and helper output. Existing exported variables win, matching the app's environment loading, and a remote/alternate database or nonlocal identity mode is refused.

## Optional worker management

After the separate explicit application/queue migration has installed all four approved queues, opt in to starting the compiled worker with the existing application:

```sh
node scripts/local-runtime.mjs start --worker
node scripts/local-runtime.mjs doctor
```

For worker-only control while the helper owns the healthy existing PostgreSQL process:

```sh
node scripts/local-runtime.mjs worker-start
node scripts/local-runtime.mjs worker-stop
```

Worker-only control preserves API, Vite and PostgreSQL identities. Foreign/manual or duplicate workers are refused, never adopted or signalled. Startup verifies ownership and complete worker startup evidence; `doctor` separately requires fresh four-queue, cutoff and discovery health. Process presence or a successful plain `start` is insufficient. An optional OFF worker does not fail otherwise healthy app checks, but means automatic processing is stopped. Manual/unowned, stale or degraded worker evidence fails that health assessment. A particular deadline still requires persisted baseline/job proof. Exact limits and lifecycle evidence are in [43](43-managed-local-worker.md).

## Prerequisites and deliberate build step

The helper expects the existing root `.env`, PostgreSQL 17 cluster and installed dependencies. Its default PostgreSQL bin directory is `/opt/homebrew/Cellar/postgresql@17/17.5/bin`; `WORKLOOM_PG_BIN` may name another absolute PostgreSQL 17 bin directory. It verifies binary major, cluster major, loopback-only bind and port 55432.

The compiled API and web build must already exist. If source changed, build deliberately in an agreed development window:

```sh
npm run build
```

`start` never builds implicitly. A missing build or dependency produces instructions and stops. For a fresh checkout with no local database, follow the separate [initial setup](../README.md#локальный-запуск); do not apply initialization or seed instructions over this recovered cluster. The private `.local/postgres/README.md` has native cluster-specific administration instructions.

## Stop services this helper owns

```sh
node scripts/local-runtime.mjs stop
```

Only processes started and recorded by the helper may be stopped. Previously running API, Vite or PostgreSQL processes are reused without taking ownership, so `stop` preserves them. Full stop preflights worker and app ownership, drains an owned worker first, then stops owned Vite, API and PostgreSQL in that order. An unowned worker or unconfirmed drain blocks subsequent app/database shutdown. Owned worker/API/Vite receive SIGTERM; the owned exact PostgreSQL cluster receives its normal fast shutdown. No SIGKILL is used. The helper refuses to stop an owned database if a preexisting unowned app still runs. The newer worker-inclusive full stop has not yet had a real combined restart gate.

Private state is `.local/runtime/processes.json` (0600, complete same-directory atomic replacement with fsync); logs are `.local/runtime/api.log`, `web.log` and optional `worker.log` (0600) inside a 0700 directory. Logs can contain synthetic application metadata and must remain private. Each ownership record includes PID, process start time, working directory and exact command. All owned identities are checked before any shutdown signal; reused/stale PIDs, changed commands and unknown listeners fail closed. A second identity check occurs before each signal. PID identity checks reduce reuse risk; they do not provide an operating-system atomic process handle.

`start` safely forgets a prior ownership record only when its PID is proven absent and its service port is empty. This covers ordinary post-reboot dead records without signalling anything. A live reused PID, occupied port or uncertain process inspection still causes refusal. PostgreSQL itself validates stale cluster locks and performs crash recovery through normal `pg_ctl start`; this helper never removes its lock file.

If a helper-owned process was killed externally, `stop` intentionally refuses stale state. Inspect the recorded PID's start time, working directory and command, and the three listening ports before manually moving the stale state file aside. Do not edit a PID in the state file to adopt another process. Likewise, `.local/runtime/operation.lock` prevents overlapping helper operations; inspect for a running helper before removing a stale lock after an interrupted operation. Routine startup never deletes `postmaster.pid` or changes PostgreSQL configuration.

A failed startup may leave already-started services recorded so `stop` can close them safely. It does not silently tear down a database after a later app error. The worker is an explicit opt-in managed service; plain `start` never turns it on. The worker runtime itself still owns queue/readiness validation and domain processing; see [managed helper behavior](43-managed-local-worker.md) and [worker operations](../apps/worker/README.md).

## Verification provenance

The implementation's process/environment guards have focused tests:

```sh
node --test tests/scripts/local-runtime.test.mjs
```

The initial read-only `doctor` verified all three preexisting processes and readiness without adopting them. On **2026-10-16, 08:20:01.258–08:21:38.126 UTC**, the coordinated real stop/start → doctor → stop/start → doctor gate passed, with all **54 public tables / 11,480 rows** matching exact pre/post counts and full-row digests. See [25](25-ux-verification.md) for process identities and snapshots. This proves that controlled local restart; an actual OS reboot was **not tested**. Pure guard tests remain separate from browser workflow evidence.

A later worker-only managed lifecycle passed on **2026-10-16, 11:23:26.252–11:26:16.608 UTC**: `worker-start`, fresh doctor health, plain `start` preserving the exact worker, then clean `worker-stop`. App/database process identities stayed unchanged. Of 60 public tables / 21,509 rows, 59 full-table digests were exact; only the expected cutoff discovery cursor advanced. All 42 physical jobs stayed exact, including six future stale cutoff jobs. Worker is now OFF. This adds worker-only evidence, without rerunning full stop/start or testing an actual OS reboot; details are in [43](43-managed-local-worker.md) and [25](25-ux-verification.md).
