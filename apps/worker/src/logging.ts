import { databaseErrorCode } from '@workloom/db';

import type { WorkerLogLevel } from './config.js';

/**
 * Structured JSON logging for the worker. Only allowlisted operational fields
 * are written, and each is validated at runtime, so a caller cannot route a task
 * title, meeting URL, connection string, token or request body into a log line
 * even through a cast. Errors are reduced to a controlled name and code: never
 * message, stack or cause.
 */
export type LogSeverity = Exclude<WorkerLogLevel, 'silent'>;

const SEVERITY_RANK: Record<WorkerLogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
};

/** Replaces a field value that failed its rule; the original value is never written. */
export const REDACTED = '[redacted]';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Code-defined names (event, job type, phase, result). No spaces, slashes or colons, so no titles or URLs. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** SQLSTATE, Node system codes and domain error codes. */
const ERROR_CODE = /^[A-Z0-9][A-Z0-9_]{0,63}$/;

const ID_FIELDS = ['jobId', 'workspaceId', 'actorId', 'entityId'] as const;
const NAME_FIELDS = ['jobName', 'entityType', 'commandType', 'phase', 'step', 'reason', 'result', 'status', 'lifecycle', 'state'] as const;
const COUNT_FIELDS = [
  'count',
  'attempt',
  'durationMs',
  'timeoutMs',
  // Health observation aggregates (see health-monitor.ts).
  'ageMs',
  'readyCount',
  'queuedCount',
  'activeCount',
  'failedCount',
  'readyOldestSeconds',
  'deadLetterCount',
  'pendingCount',
  'oldestAgeMs',
  'unsupportedCount',
  'consecutiveFailures',
  'failedBatches',
  'queueErrors',
  'jobsFailed',
  'jobsRejected',
] as const;
/** Lists of code-defined names, e.g. health reasons or mismatched option names. Each item follows the name rule. */
const LIST_FIELDS = ['reasons', 'properties'] as const;
const MAX_LIST_ITEMS = 32;

type IdField = (typeof ID_FIELDS)[number];
type NameField = (typeof NAME_FIELDS)[number];
type CountField = (typeof COUNT_FIELDS)[number];
type ListField = (typeof LIST_FIELDS)[number];

export type LogFields = { readonly [K in IdField]?: string } & { readonly [K in NameField]?: string } & {
  readonly [K in CountField]?: number;
} & { readonly [K in ListField]?: readonly string[] } & {
  /** Any caught value; only its safe classification is written. */
  readonly error?: unknown;
};

export interface SafeErrorInfo {
  readonly name: string;
  readonly code?: string;
}

/** Controlled error name plus the first well-formed code in the cause chain. Never message/stack/cause. */
export function classifyError(error: unknown): SafeErrorInfo {
  let name: string;
  if (error instanceof Error) {
    name = IDENTIFIER.test(error.name) ? error.name : 'Error';
  } else {
    name = 'NonErrorThrown';
  }
  const code = databaseErrorCode(error);
  return code !== undefined && ERROR_CODE.test(code) ? { name, code } : { name };
}

type SafeValue = string | number | readonly string[] | SafeErrorInfo;

function sanitizeFields(fields: LogFields | undefined): Record<string, SafeValue> {
  const out: Record<string, SafeValue> = {};
  if (fields === undefined) {
    return out;
  }
  const raw = fields as Readonly<Record<string, unknown>>;
  for (const key of ID_FIELDS) {
    const value = raw[key];
    if (value !== undefined) out[key] = typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : REDACTED;
  }
  for (const key of NAME_FIELDS) {
    const value = raw[key];
    if (value !== undefined) out[key] = typeof value === 'string' && IDENTIFIER.test(value) ? value : REDACTED;
  }
  for (const key of COUNT_FIELDS) {
    const value = raw[key];
    if (value !== undefined) {
      out[key] = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : REDACTED;
    }
  }
  for (const key of LIST_FIELDS) {
    const value: unknown = raw[key];
    if (value !== undefined) {
      out[key] =
        Array.isArray(value) && value.length <= MAX_LIST_ITEMS
          ? value.map((item: unknown) => (typeof item === 'string' && IDENTIFIER.test(item) ? item : REDACTED))
          : REDACTED;
    }
  }
  if ('error' in raw && raw.error !== undefined) {
    out.error = classifyError(raw.error);
  }
  return out;
}

export type LogSink = (line: string) => void;

export interface WorkerLoggerOptions {
  readonly level: WorkerLogLevel;
  /** Receives one JSON line without a trailing newline. Default: process.stdout. */
  readonly sink?: LogSink;
  readonly now?: () => Date;
}

export interface WorkerLogger {
  readonly level: WorkerLogLevel;
  isEnabled(severity: LogSeverity): boolean;
  log(severity: LogSeverity, event: string, fields?: LogFields): void;
  fatal(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  trace(event: string, fields?: LogFields): void;
  /** A logger whose lines carry `bindings` (validated now) unless overridden per call. */
  child(bindings: LogFields): WorkerLogger;
}

const stdoutSink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

export function createWorkerLogger(options: WorkerLoggerOptions): WorkerLogger {
  return buildLogger(options.level, options.sink ?? stdoutSink, options.now ?? (() => new Date()), {});
}

function buildLogger(
  level: WorkerLogLevel,
  sink: LogSink,
  now: () => Date,
  bindings: Readonly<Record<string, SafeValue>>,
): WorkerLogger {
  const threshold = SEVERITY_RANK[level];
  const isEnabled = (severity: LogSeverity): boolean => SEVERITY_RANK[severity] >= threshold;

  const log = (severity: LogSeverity, event: string, fields?: LogFields): void => {
    if (!isEnabled(severity)) {
      return;
    }
    const record = {
      time: now().toISOString(),
      level: severity,
      service: 'worker',
      event: IDENTIFIER.test(event) ? event : REDACTED,
      ...bindings,
      ...sanitizeFields(fields),
    };
    try {
      sink(JSON.stringify(record));
    } catch {
      // A broken log sink must not fail the job or shutdown that is being logged.
    }
  };

  return {
    level,
    isEnabled,
    log,
    fatal: (event, fields) => log('fatal', event, fields),
    error: (event, fields) => log('error', event, fields),
    warn: (event, fields) => log('warn', event, fields),
    info: (event, fields) => log('info', event, fields),
    debug: (event, fields) => log('debug', event, fields),
    trace: (event, fields) => log('trace', event, fields),
    child: (more) => buildLogger(level, sink, now, { ...bindings, ...sanitizeFields(more) }),
  };
}
