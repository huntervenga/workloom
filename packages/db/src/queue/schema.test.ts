import { getConstructionPlans, getMigrationPlans } from 'pg-boss';
import { describe, expect, it } from 'vitest';

import {
  CUTOFF_QUEUE, CUTOFF_DEAD_LETTER_QUEUE, CUTOFF_QUEUE_REGISTRATIONS, WORKLOOM_QUEUE_REGISTRATIONS,
  QueueSchemaStateError,
  RECURRENCE_DEAD_LETTER_QUEUE,
  RECURRENCE_DEAD_LETTER_QUEUE_OPTIONS,
  RECURRENCE_MATERIALIZE_QUEUE,
  RECURRENCE_MATERIALIZE_QUEUE_OPTIONS,
  RECURRENCE_QUEUE_REGISTRATIONS,
  WORKLOOM_QUEUE_SCHEMA,
  findQueueOptionMismatches,
  splitMigrationPlan,
} from './schema.js';

// Plans come from the installed pinned pg-boss, so a release that changes their shape fails here
// instead of half-running against a database. No connection is opened.
const PARTITION_TABLE = `j${'0a'.repeat(28)}`;

describe('splitMigrationPlan', () => {
  it('keeps the official construction plan as one locked transaction', () => {
    const plan = getConstructionPlans(WORKLOOM_QUEUE_SCHEMA, { createSchema: true });
    const split = splitMigrationPlan(plan);
    expect(split.concurrent).toEqual([]);
    expect(split.transactional).toBe(plan);
    expect(split.transactional).toContain('pg_advisory_xact_lock');
  });

  it('separates the inlined CONCURRENTLY builds of an official migration from its transaction', () => {
    const plan = getMigrationPlans(WORKLOOM_QUEUE_SCHEMA, 45, {
      partitionTables: [{ tableName: PARTITION_TABLE, policy: 'standard' }],
    });
    const split = splitMigrationPlan(plan);

    expect(split.transactional).toMatch(/COMMIT;\s*$/);
    expect(split.transactional).toContain(`UPDATE ${WORKLOOM_QUEUE_SCHEMA}.version SET version = '46'`);
    expect(split.transactional).not.toContain('CONCURRENTLY');
    expect(split.concurrent.length).toBe(plan.split('\n-- inlined from ').length - 1);
    expect(split.concurrent.length).toBeGreaterThan(0);
    for (const statement of split.concurrent) {
      expect(statement).toMatch(/INDEX CONCURRENTLY/);
      expect(statement).not.toMatch(/;|\bCOMMIT\b|\bBEGIN\b/);
    }
    expect(split.concurrent.some((statement) => statement.includes(`${WORKLOOM_QUEUE_SCHEMA}.${PARTITION_TABLE}`))).toBe(true);
  });

  it('refuses plans that are not one transaction followed only by index builds', () => {
    const migration = getMigrationPlans(WORKLOOM_QUEUE_SCHEMA, 45);
    expect(() => splitMigrationPlan('CREATE SCHEMA workloom_queue;')).toThrow(QueueSchemaStateError);
    expect(() => splitMigrationPlan(`${migration}\n-- inlined from elsewhere\nDROP TABLE ${WORKLOOM_QUEUE_SCHEMA}.job;`)).toThrow(
      QueueSchemaStateError,
    );
    expect(() => splitMigrationPlan(migration.replace(/;\s*$/, ''))).toThrow(QueueSchemaStateError);
  });
});

describe('findQueueOptionMismatches', () => {
  // Shaped like a getQueue() row: approved options plus reported fields the check must ignore.
  const reported = {
    ...RECURRENCE_MATERIALIZE_QUEUE_OPTIONS,
    name: RECURRENCE_MATERIALIZE_QUEUE,
    heartbeatSeconds: null,
    queuedCount: 3,
    totalCount: 7,
  };

  it('accepts a queue whose every approved option matches', () => {
    expect(findQueueOptionMismatches(RECURRENCE_MATERIALIZE_QUEUE_OPTIONS, reported)).toEqual([]);
  });

  it('reports each differing, missing or null option by strict equality', () => {
    const { retryDelayMax: _omitted, ...withoutMax } = reported;
    const drifted = { ...withoutMax, retryLimit: '5', retryBackoff: false, retentionSeconds: null };
    expect(findQueueOptionMismatches(RECURRENCE_MATERIALIZE_QUEUE_OPTIONS, drifted)).toEqual([
      { property: 'retryLimit', expected: 5, actual: '5' },
      { property: 'retryBackoff', expected: true, actual: false },
      { property: 'retryDelayMax', expected: 300, actual: undefined },
      { property: 'retentionSeconds', expected: 604800, actual: null },
    ]);
  });

  it('requires the materialization queue to dead-letter into the dead-letter queue', () => {
    expect(findQueueOptionMismatches(RECURRENCE_MATERIALIZE_QUEUE_OPTIONS, { ...reported, deadLetter: null })).toEqual([
      { property: 'deadLetter', expected: RECURRENCE_DEAD_LETTER_QUEUE, actual: null },
    ]);
  });
});

describe('RECURRENCE_QUEUE_REGISTRATIONS', () => {
  const [deadLetter, materialize] = RECURRENCE_QUEUE_REGISTRATIONS;
  const reportedDeadLetter = { ...RECURRENCE_DEAD_LETTER_QUEUE_OPTIONS, name: RECURRENCE_DEAD_LETTER_QUEUE, deadLetter: null, retryDelayMax: null };

  it('registers the dead-letter queue before the queue that names it', () => {
    expect(RECURRENCE_QUEUE_REGISTRATIONS).toHaveLength(2);
    expect(deadLetter.name).toBe(RECURRENCE_DEAD_LETTER_QUEUE);
    expect(materialize.name).toBe(RECURRENCE_MATERIALIZE_QUEUE);
    expect(materialize.options.deadLetter).toBe(deadLetter.name);
    expect(materialize.expected).toBe(RECURRENCE_MATERIALIZE_QUEUE_OPTIONS);
    expect(deadLetter.options).not.toHaveProperty('deadLetter');
  });

  it('accepts a dead-letter queue only without its own dead letter', () => {
    expect(findQueueOptionMismatches(deadLetter.expected, reportedDeadLetter)).toEqual([]);
    expect(findQueueOptionMismatches(deadLetter.expected, { ...reportedDeadLetter, deadLetter: RECURRENCE_MATERIALIZE_QUEUE })).toEqual([
      { property: 'deadLetter', expected: null, actual: RECURRENCE_MATERIALIZE_QUEUE },
    ]);
    const { deadLetter: _omitted, ...withoutDeadLetter } = reportedDeadLetter;
    expect(findQueueOptionMismatches(deadLetter.expected, withoutDeadLetter)).toEqual([
      { property: 'deadLetter', expected: null, actual: undefined },
    ]);
  });
});


describe('additive cutoff queue registrations', () => {
  it('keeps both recurrence registrations and adds a separate cutoff queue/DLQ with the same finite policy', () => {
    expect(WORKLOOM_QUEUE_REGISTRATIONS).toHaveLength(4);
    expect(WORKLOOM_QUEUE_REGISTRATIONS.slice(0, 2)).toEqual(RECURRENCE_QUEUE_REGISTRATIONS);
    const [dead, cutoff] = CUTOFF_QUEUE_REGISTRATIONS;
    expect(dead.name).toBe(CUTOFF_DEAD_LETTER_QUEUE);
    expect(cutoff.name).toBe(CUTOFF_QUEUE);
    expect(cutoff.expected).toEqual({ ...RECURRENCE_MATERIALIZE_QUEUE_OPTIONS, deadLetter: dead.name });
    expect(dead.expected).toEqual({ ...RECURRENCE_DEAD_LETTER_QUEUE_OPTIONS, deadLetter: null });
    for (const queue of WORKLOOM_QUEUE_REGISTRATIONS) {
      expect(findQueueOptionMismatches(queue.expected, { ...queue.expected })).toEqual([]);
      expect(queue.expected.retentionSeconds).toBe(604800);
    }
  });
});
