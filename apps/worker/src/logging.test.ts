import { describe, expect, it } from 'vitest';

import type { WorkerLogLevel } from './config.js';
import { REDACTED, classifyError, createWorkerLogger, type LogFields } from './logging.js';

const JOB_ID = '6F1C2A8E-3B4D-4E5F-8A9B-0C1D2E3F4A5B';
const WORKSPACE_ID = '11111111-2222-4333-8444-555555555555';
const FIXED = new Date('2026-10-16T08:00:00.000Z');

// Canaries: none of these may ever appear in a log line.
const PASSWORD = 'canary-db-password-7f3a';
const DATABASE_URL = `postgres://workloom:${PASSWORD}@127.0.0.1:54329/workloom`;
const TITLE = 'Canary private task title about layoffs';
const MEETING_URL = 'https://meet.example.com/canary-room-9z?pwd=canary-meeting-secret';
const TOKEN = 'canary-bearer-token-4c1d';
const COOKIE = 'wl_session=canary-cookie-value';
const BODY = '{"title":"canary-request-body"}';
const CANARIES = [PASSWORD, DATABASE_URL, TITLE, MEETING_URL, TOKEN, COOKIE, BODY, 'canary'];

function capture(level: WorkerLogLevel = 'trace') {
  const lines: string[] = [];
  const logger = createWorkerLogger({ level, sink: (line) => lines.push(line), now: () => FIXED });
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, records };
}

function expectNoCanaries(lines: readonly string[]): void {
  const output = lines.join('\n').toLowerCase();
  for (const canary of CANARIES) {
    expect(output).not.toContain(canary.toLowerCase());
  }
}

describe('createWorkerLogger', () => {
  it('writes one JSON object per line with allowlisted, normalized operational fields', () => {
    const { logger, lines, records } = capture('info');
    logger.info('job.completed', {
      jobId: JOB_ID,
      workspaceId: WORKSPACE_ID,
      jobName: 'meeting.materialize',
      result: 'succeeded',
      count: 3,
      durationMs: 12.6,
    });
    expect(lines).toHaveLength(1);
    expect(records()[0]).toEqual({
      time: FIXED.toISOString(),
      level: 'info',
      service: 'worker',
      event: 'job.completed',
      jobId: JOB_ID.toLowerCase(),
      workspaceId: WORKSPACE_ID,
      jobName: 'meeting.materialize',
      result: 'succeeded',
      count: 3,
      durationMs: 13,
    });
  });

  it('applies the threshold and writes nothing when silent', () => {
    const warn = capture('warn');
    warn.logger.info('ignored');
    warn.logger.debug('ignored');
    warn.logger.warn('kept');
    warn.logger.fatal('kept');
    expect(warn.records().map((record) => record.level)).toEqual(['warn', 'fatal']);
    expect(warn.logger.isEnabled('info')).toBe(false);

    const silent = capture('silent');
    silent.logger.fatal('dropped', { error: new Error('boom') });
    expect(silent.lines).toEqual([]);
    expect(silent.logger.isEnabled('fatal')).toBe(false);
  });

  it('drops unknown keys and redacts allowlisted fields that carry private payloads (canary)', () => {
    const { logger, lines, records } = capture();
    const smuggled = {
      jobId: DATABASE_URL,
      entityId: TITLE,
      jobName: MEETING_URL,
      entityType: TITLE,
      commandType: `Bearer ${TOKEN}`,
      reason: COOKIE,
      result: BODY,
      count: Number.NaN,
      durationMs: -1,
      attempt: TOKEN,
      title: TITLE,
      meetingUrl: MEETING_URL,
      databaseUrl: DATABASE_URL,
      password: PASSWORD,
      authorization: `Bearer ${TOKEN}`,
      cookie: COOKIE,
      body: BODY,
      message: TITLE,
    } as unknown as LogFields;
    logger.warn('job.input_rejected', smuggled);
    logger.info(TITLE);
    logger.child(smuggled).error('job.failed');

    expectNoCanaries(lines);
    const [first, second, third] = records();
    expect(first).toEqual({
      time: FIXED.toISOString(),
      level: 'warn',
      service: 'worker',
      event: 'job.input_rejected',
      jobId: REDACTED,
      entityId: REDACTED,
      jobName: REDACTED,
      entityType: REDACTED,
      commandType: REDACTED,
      reason: REDACTED,
      result: REDACTED,
      count: REDACTED,
      durationMs: REDACTED,
      attempt: REDACTED,
    });
    expect(second?.event).toBe(REDACTED);
    expect(third?.jobId).toBe(REDACTED);
  });

  it('logs only the classified name and code of errors, never message, stack or cause (canary)', () => {
    const { logger, lines, records } = capture();
    const cause = Object.assign(new Error(`connect to ${DATABASE_URL} failed`), { code: 'ECONNREFUSED' });
    const error = new Error(`Task "${TITLE}" at ${MEETING_URL} failed with ${TOKEN}`, { cause });
    logger.error('job.failed', { jobId: JOB_ID, error });
    logger.error('job.failed', { error: { message: TITLE, stack: BODY, code: PASSWORD } });
    logger.error('job.failed', { error: TITLE });

    expectNoCanaries(lines);
    expect(lines.join('\n')).not.toMatch(/stack|message|cause|at .*\.ts:\d+/);
    expect(records().map((record) => record.error)).toEqual([
      { name: 'Error', code: 'ECONNREFUSED' },
      { name: 'NonErrorThrown' },
      { name: 'NonErrorThrown' },
    ]);
  });

  it('binds child fields, lets call fields override them, and keeps the parent unchanged', () => {
    const { logger, records } = capture();
    const child = logger.child({ jobId: JOB_ID, jobName: 'meeting.materialize' });
    child.info('job.started', { attempt: 1 });
    child.info('job.retry', { jobName: 'meeting.retry' });
    logger.info('worker.idle');
    const [started, retry, idle] = records();
    expect(started).toMatchObject({ jobId: JOB_ID.toLowerCase(), jobName: 'meeting.materialize', attempt: 1 });
    expect(retry?.jobName).toBe('meeting.retry');
    expect(idle).not.toHaveProperty('jobId');
  });

  it('survives a throwing sink', () => {
    const logger = createWorkerLogger({
      level: 'info',
      sink: () => {
        throw new Error('EPIPE');
      },
    });
    expect(() => logger.error('job.failed')).not.toThrow();
  });
});

describe('classifyError', () => {
  it('keeps controlled names and well-formed codes from the cause chain', () => {
    class FieldLockedError extends Error {
      override readonly name = 'FieldLockedError';
      readonly code = 'FIELD_LOCKED';
    }
    expect(classifyError(new FieldLockedError(TITLE))).toEqual({ name: 'FieldLockedError', code: 'FIELD_LOCKED' });
    const pg = Object.assign(new Error(`duplicate key ${TITLE}`), { name: 'PostgresError', code: '23505' });
    expect(classifyError(new Error('wrapped', { cause: pg }))).toEqual({ name: 'Error', code: '23505' });
  });

  it('drops names and codes that could carry payload text (canary)', () => {
    const named = Object.assign(new Error('x'), { name: TITLE, code: `${PASSWORD} ${TOKEN}` });
    const info = classifyError(named);
    expect(info).toEqual({ name: 'Error' });
    expectNoCanaries([JSON.stringify(info)]);
    expect(classifyError(undefined)).toEqual({ name: 'NonErrorThrown' });
  });
});
