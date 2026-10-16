import { classifyError, type SafeErrorInfo, type WorkerLogger } from './logging.js';

/**
 * Process-independent graceful shutdown. Phases run strictly in order and each
 * step is awaited before the next one starts:
 *
 * 1. `stopIntake`: stop fetching/accepting new work.
 * 2. `drain`: wait for in-flight work to finish (e.g. a graceful queue stop
 *    with its own finite timeout). Skipped when intake could not be stopped,
 *    because waiting for a still-filling queue may never end.
 * 3. `close`: release owned resources (queue client, database pools). Every
 *    close step runs, whatever failed before it.
 *
 * Nothing here cancels database work or races a timeout against a step: a
 * step's timeout belongs to the resource it stops. The result promise never
 * rejects and is shared by every caller; failures are reported as safe
 * name/code classifications only.
 */
export type ShutdownPhase = 'stopIntake' | 'drain' | 'close';

export interface ShutdownStep {
  /** Code-defined identifier used in logs and results (e.g. `queue.stop`). */
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

export interface ShutdownPlan {
  readonly stopIntake?: readonly ShutdownStep[];
  readonly drain?: readonly ShutdownStep[];
  readonly close?: readonly ShutdownStep[];
}

export interface ShutdownStepRef {
  readonly phase: ShutdownPhase;
  readonly step: string;
}

export interface ShutdownFailure extends ShutdownStepRef {
  readonly error: SafeErrorInfo;
}

export interface ShutdownResult {
  readonly status: 'clean' | 'failed';
  /** Reason given by the first caller, e.g. `SIGTERM`; later reasons are ignored. */
  readonly reason: string;
  readonly failures: readonly ShutdownFailure[];
  readonly skipped: readonly ShutdownStepRef[];
}

export interface ShutdownController {
  /** Starts shutdown once; every call (including concurrent ones) returns the same promise. */
  shutdown(reason: string): Promise<ShutdownResult>;
  readonly started: boolean;
}

export interface ShutdownOptions {
  readonly logger?: WorkerLogger;
  readonly now?: () => number;
}

export function createShutdown(plan: ShutdownPlan, options: ShutdownOptions = {}): ShutdownController {
  const phases: readonly (readonly [ShutdownPhase, readonly ShutdownStep[]])[] = [
    ['stopIntake', [...(plan.stopIntake ?? [])]],
    ['drain', [...(plan.drain ?? [])]],
    ['close', [...(plan.close ?? [])]],
  ];
  const now = options.now ?? (() => performance.now());
  let pending: Promise<ShutdownResult> | undefined;

  // An injected logger must not be able to turn shutdown into a rejected promise.
  const log: WorkerLogger['log'] = (severity, event, fields) => {
    try {
      options.logger?.log(severity, event, fields);
    } catch {
      // Ignored: logging is best effort during shutdown.
    }
  };

  async function run(reason: string): Promise<ShutdownResult> {
    const startedAt = now();
    const failures: ShutdownFailure[] = [];
    const skipped: ShutdownStepRef[] = [];
    log('info', 'worker.shutdown_started', { reason });

    for (const [phase, steps] of phases) {
      const skip = phase === 'drain' && failures.some((failure) => failure.phase === 'stopIntake');
      for (const step of steps) {
        if (skip) {
          skipped.push({ phase, step: step.name });
          log('warn', 'worker.shutdown_step_skipped', { phase, step: step.name });
          continue;
        }
        const stepStartedAt = now();
        try {
          await step.run();
          log('debug', 'worker.shutdown_step_done', { phase, step: step.name, durationMs: now() - stepStartedAt });
        } catch (error) {
          failures.push({ phase, step: step.name, error: classifyError(error) });
          log('error', 'worker.shutdown_step_failed', { phase, step: step.name, durationMs: now() - stepStartedAt, error });
        }
      }
    }

    const status = failures.length === 0 ? 'clean' : 'failed';
    log(status === 'clean' ? 'info' : 'error', 'worker.shutdown_finished', {
      reason,
      result: status,
      count: failures.length,
      durationMs: now() - startedAt,
    });
    return { status, reason, failures, skipped };
  }

  return {
    shutdown(reason) {
      // Assigned synchronously, so a second signal in the same tick still gets the same promise.
      pending ??= run(reason);
      return pending;
    },
    get started() {
      return pending !== undefined;
    },
  };
}

export type ShutdownSignal = 'SIGTERM' | 'SIGINT';

/** The part of `process` used for signal binding; inject a fake emitter in tests. */
export interface SignalSource {
  on(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
}

export interface BindShutdownSignalsOptions {
  readonly source?: SignalSource;
  readonly signals?: readonly ShutdownSignal[];
  /** Called once with the shared result; the caller decides the exit code. Never calls process.exit itself. */
  readonly onSettled?: (result: ShutdownResult) => void;
}

/**
 * Routes SIGTERM/SIGINT to `controller.shutdown`. Repeated signals reuse the
 * running shutdown. Returns an idempotent dispose that removes the listeners.
 */
export function bindShutdownSignals(controller: ShutdownController, options: BindShutdownSignalsOptions = {}): () => void {
  const source: SignalSource = options.source ?? process;
  const signals = [...new Set(options.signals ?? (['SIGTERM', 'SIGINT'] as const))];
  let settledNotified = false;

  const listeners = signals.map((signal) => {
    const listener = (): void => {
      void controller.shutdown(signal).then((result) => {
        if (settledNotified) return;
        settledNotified = true;
        try {
          options.onSettled?.(result);
        } catch {
          // The callback owns its own failures; shutdown itself has already finished.
        }
      });
    };
    source.on(signal, listener);
    return [signal, listener] as const;
  });

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const [signal, listener] of listeners) {
      source.off(signal, listener);
    }
  };
}
