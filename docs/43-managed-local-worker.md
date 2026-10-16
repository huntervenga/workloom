# Optional managed local worker

This extends the existing [local runtime helper](26-local-runtime.md) with explicit worker management. The implementation has focused source tests. A real managed start/drain/stop gate and an actual OS reboot have **not yet been verified**; execution evidence belongs in [25](25-ux-verification.md). The separately controlled manual worker gate does not establish this helper's lifecycle coverage.

## Start deliberately

Use Node.js 24 from the repository root. After a reboot, the convenient opt-in command is:

```sh
node scripts/local-runtime.mjs start --worker
node scripts/local-runtime.mjs doctor
```

`start --worker` starts/reuses the existing local PostgreSQL, compiled API and Vite development UI, then starts the compiled worker if none is already managed. The helper must own the exact healthy PostgreSQL process before starting a worker. An existing unowned cluster is not adopted; resolve its ownership through the coordinated operations handoff rather than editing a PID into the private state.

Plain `start` keeps its earlier application behavior. It never starts a new worker implicitly, and it preserves an already managed running worker. An OFF worker remains OFF. No OS login agent, reboot daemon or scheduler is installed; these commands must be run explicitly after reboot.

To control only the worker while the helper-owned PostgreSQL process is already running:

```sh
node scripts/local-runtime.mjs worker-start
node scripts/local-runtime.mjs worker-stop
```

These actions preserve API and Vite processes. There is no worker HTTP port. The manager inspects PID, process start time, repository cwd and exact compiled command, and checks for possible manual/source/npm worker processes. It refuses foreign or duplicate workers without adopting or signalling them. A manual worker must complete its separately owned shutdown before managed startup is attempted.

## Prerequisites and evidence

The existing private `.env`, PostgreSQL 17 cluster and current compiled worker/libraries must already exist. All four queues must have been installed through the separate explicit application/queue migration gate described in the [worker guide](../apps/worker/README.md). The manager never builds, initializes, migrates, installs queues, seeds, restores or resets data. A readiness failure is a refusal or diagnostic; it never triggers a repair command.

Managed operation requires `LOG_LEVEL=info`, `debug` or `trace` so startup, health and drain can be verified. An incompatible quieter setting is refused without silently changing it. Existing exported environment values retain precedence. `WORKER_SHUTDOWN_TIMEOUT_MS` keeps its worker bounds of 1,000–120,000 ms and defaults to 10,000 ms.

Before launch, the helper verifies its PostgreSQL ownership and uses `pg_isready` on the existing loopback port. Worker startup itself verifies application readiness and all four exact approved queues before either consumer starts. The manager waits up to 60 seconds for this launch's `worker.started`, complete four-queue observations, and cutoff/discovery health. A timeout leaves verified ownership recorded for a safe `worker-stop`; it does not force-kill or tear down other services.

Worker logs are appended to ignored `.local/runtime/worker.log` with mode 0600 inside the existing 0700 runtime directory. The existing private atomic `processes.json` adds a worker record containing its process identity, launch time, log byte offset, log device/inode, finite drain setting and confirmed startup time. Credentials and unrelated process command lines are never printed or stored in that record. Every mutating helper action uses the same operation lock as ordinary start/stop.

Only bounded log reads from the recorded launch/file establish evidence. Replaced or truncated files, malformed or partial records, old launch records and incomplete queue observations remain unconfirmed. Doctor requires a fresh observation no older than 90 seconds; it reports degraded health explicitly. A later `worker.health_failed` invalidates an earlier successful observation immediately. Health becomes confirmed again only after a later complete success with all four queues, cutoff and discovery observations. Equal-millisecond records follow log append order. Process presence or an old startup line is insufficient.

## Stop and drain

`worker-stop` rechecks exact ownership, sends one SIGTERM and waits for disappearance plus this stop's clean `worker.shutdown_started`/`worker.shutdown_finished` evidence. Its finite observation budget is the larger of 30 seconds and the configured queue shutdown timeout plus 45 seconds; individual process inspections also have finite bounds. It never sends SIGKILL.

The ordinary full stop also includes an owned worker:

```sh
node scripts/local-runtime.mjs stop
```

Full stop preflights all ownership and foreign-worker conditions before signalling anything. It drains the owned worker first, then stops owned Vite, API and PostgreSQL in that order. An unowned worker blocks full stop before app/database mutations. A failed or unconfirmed worker drain preserves its state and leaves those other services alone. A fresh worker check occurs again immediately before an owned database shutdown.

A reused PID, changed command/cwd, uncertain inspection, missing clean-stop evidence or timeout causes refusal. No process is force-killed and no uncertain ownership record is silently adopted. If a process was stopped externally, inspect its exact recorded identity and log before repairing stale state. Startup may forget a prior worker record only when its PID is proven absent and no candidate worker exists. It does not remove PostgreSQL locks or clear an operation lock automatically. PID checks reduce reuse risk but are not an atomic operating-system process handle.

## Truthful status

`doctor` continues to check PostgreSQL, API and Vite readiness. Its worker line distinguishes optional OFF, unmanaged/manual presence, a managed running process with fresh health, degraded health, and stale/malformed/incomplete evidence.

An optional OFF worker alone does not fail an otherwise healthy application check. The message explicitly says automatic processing is not operating through this helper. Manual/unowned, stale and degraded worker observations fail the worker health assessment. A healthy running worker is evidence that processing can proceed; a particular deadline is complete only when its persisted baseline and job provenance have been verified. Automatic report creation remains outside the accepted cutoff slice.

## Focused verification and next real gate

```sh
node --check scripts/local-runtime.mjs
node --test tests/scripts/local-runtime.test.mjs
```

The focused tests use synthetic identities, log records and injected process/time ports. They do not inspect or signal live processes, connect to PostgreSQL or execute the helper. They cover optional dispatch, exact identity, manual-worker refusal, proven-dead reboot reconciliation, complete/fresh evidence, failed/uncertain drain, no forced kill and full-stop ordering. Source tests do not establish a real reboot or managed lifecycle pass.

After the coordinator confirms the manual worker has stopped, the proposed real gate is: capture current app/database/process evidence; run worker-start and doctor; verify exact new ownership plus all four queues and fresh cutoff/discovery observations; run plain start and verify the same worker PID/start time was preserved; run worker-stop and verify clean drain, OFF status and unchanged API/Vite/PostgreSQL identities. A separately approved full stop/start with `--worker` can then prove combined lifecycle and reboot-style dead-record recovery. Preserve existing data, record intended job writes separately, and keep old-tab/browser coverage separate from process health. The coordinator must authorize this gate before execution.
