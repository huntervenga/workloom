import { describe, expect, it } from 'vitest';

import {
  createTaskFieldInputSchema,
  createTaskFieldOptionInputSchema,
  projectColumnsSchema,
  setTaskFieldValueInputSchema,
  taskFieldBatchQuerySchema,
  taskFieldDataSchema,
  taskFieldDefinitionSchema,
  taskFieldHistoryQuerySchema,
  taskFieldValueHistoryListResponseSchema,
  taskFieldValueHistorySchema,
  updateProjectColumnsInputSchema,
  updateTaskFieldInputSchema,
  updateTaskFieldOptionInputSchema,
  type TaskFieldDefinitionDto,
} from './index.js';

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const ids = {
  workspace: uuid(101),
  project: uuid(401),
  task: uuid(602),
  field: uuid(901),
  version: uuid(902),
  optionA: uuid(911),
  optionB: uuid(912),
  actor: uuid(201),
  history: uuid(951),
} as const;

const at = '2026-10-16T09:30:00.000Z';

/** Dotted paths of the issues in a failed parse; empty when parsing succeeded. */
function issuePaths(result: { error?: { issues: readonly { path: readonly PropertyKey[] }[] } }): string[] {
  return result.error?.issues.map((issue) => issue.path.map(String).join('.')) ?? [];
}

const draftOption = { id: ids.optionA, name: 'Draft', color: '#aabbcc', position: 0, revision: 1, archivedAt: null };

function selectField(overrides: Partial<TaskFieldDefinitionDto> = {}): TaskFieldDefinitionDto {
  return {
    id: ids.field,
    workspaceId: ids.workspace,
    projectId: ids.project,
    name: 'Stage',
    type: 'single_select',
    revision: 3,
    definitionVersionId: ids.version,
    historyEnabled: true,
    locked: false,
    archivedAt: null,
    options: [draftOption, { id: ids.optionB, name: 'Review', color: null, position: 1, revision: 2, archivedAt: at }],
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

describe('taskFieldDataSchema', () => {
  it('accepts a typed null clear for every one of the nine types', () => {
    const types = ['text', 'number', 'duration', 'date', 'single_select', 'multi_select', 'person', 'boolean', 'url'];

    for (const type of types) {
      expect(taskFieldDataSchema.parse({ type, value: null })).toEqual({ type, value: null });
    }
  });

  it('keeps zero, false, an empty list and empty text as values distinct from null', () => {
    const samples = [
      { type: 'text', value: '' },
      { type: 'number', value: 0 },
      { type: 'duration', value: 0 },
      { type: 'boolean', value: false },
      { type: 'multi_select', value: [] },
      { type: 'person', value: [] },
    ];

    for (const sample of samples) expect(taskFieldDataSchema.parse(sample)).toEqual(sample);
  });

  it('keeps text verbatim and bounds it at 10 000 characters', () => {
    expect(taskFieldDataSchema.parse({ type: 'text', value: '  spaced  ' })).toEqual({ type: 'text', value: '  spaced  ' });
    expect(taskFieldDataSchema.safeParse({ type: 'text', value: 'x'.repeat(10_000) }).success).toBe(true);
    expect(taskFieldDataSchema.safeParse({ type: 'text', value: 'x'.repeat(10_001) }).success).toBe(false);
  });

  it('bounds numbers to finite values within ±1e12', () => {
    for (const value of [-1e12, 1e12, 3.25]) {
      expect(taskFieldDataSchema.safeParse({ type: 'number', value }).success).toBe(true);
    }
    for (const value of [1e12 + 1, -1e12 - 1, Number.POSITIVE_INFINITY, Number.NaN, '5']) {
      expect(taskFieldDataSchema.safeParse({ type: 'number', value }).success).toBe(false);
    }
  });

  it('takes durations as whole, non-negative int32 minutes', () => {
    expect(taskFieldDataSchema.safeParse({ type: 'duration', value: 2_147_483_647 }).success).toBe(true);
    for (const value of [-1, 1.5, 2_147_483_648]) {
      expect(taskFieldDataSchema.safeParse({ type: 'duration', value }).success).toBe(false);
    }
  });

  it('accepts only real calendar dates without time or offset', () => {
    expect(taskFieldDataSchema.safeParse({ type: 'date', value: '2028-02-29' }).success).toBe(true);
    for (const value of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-10-16T00:00:00Z', '2026-10-16+03:00']) {
      expect(taskFieldDataSchema.safeParse({ type: 'date', value }).success).toBe(false);
    }
  });

  it('accepts only absolute http and https URLs up to 2048 characters', () => {
    for (const value of ['https://example.com/a?b=c#d', 'HTTP://example.com']) {
      expect(taskFieldDataSchema.safeParse({ type: 'url', value }).success).toBe(true);
    }
    const rejected = [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'ftp://example.com/file',
      'http:example.com',
      '//example.com/path',
      ' https://example.com',
      'https://exa mple.com',
      'https://user:secret@example.com',
      `https://example.com/${'a'.repeat(2048)}`,
    ];
    for (const value of rejected) {
      expect(taskFieldDataSchema.safeParse({ type: 'url', value }).success).toBe(false);
    }
  });

  it('canonicalizes multi_select and person IDs to lowercase sorted sets and rejects duplicates', () => {
    const upperB = ids.optionB.toUpperCase();

    expect(taskFieldDataSchema.parse({ type: 'multi_select', value: [upperB, ids.optionA] })).toEqual({
      type: 'multi_select',
      value: [ids.optionA, ids.optionB],
    });
    expect(taskFieldDataSchema.safeParse({ type: 'person', value: [ids.actor, ids.actor.toUpperCase()] }).success).toBe(
      false,
    );
    expect(
      taskFieldDataSchema.safeParse({ type: 'person', value: Array.from({ length: 101 }, (_, i) => uuid(i + 1)) })
        .success,
    ).toBe(false);
    expect(taskFieldDataSchema.parse({ type: 'single_select', value: ids.optionA.toUpperCase() })).toEqual({
      type: 'single_select',
      value: ids.optionA,
    });
  });

  it('rejects mismatched types, labels in place of IDs and free-form extra keys', () => {
    expect(taskFieldDataSchema.safeParse({ type: 'boolean', value: 'true' }).success).toBe(false);
    expect(taskFieldDataSchema.safeParse({ type: 'single_select', value: 'Draft' }).success).toBe(false);
    expect(taskFieldDataSchema.safeParse({ type: 'text', value: 'x', label: 'y' }).success).toBe(false);
    expect(taskFieldDataSchema.safeParse({ type: 'json', value: { any: 1 } }).success).toBe(false);
    expect(taskFieldDataSchema.safeParse({ type: 'text' }).success).toBe(false);
  });
});

describe('field definitions and options', () => {
  it('normalizes option colors to lowercase and rejects other color formats', () => {
    const parsed = createTaskFieldInputSchema.parse({
      projectId: ids.project,
      name: 'Stage',
      type: 'single_select',
      options: [{ name: 'Draft', color: '#AABBCC' }, { name: 'Review' }],
    });

    expect(parsed.options).toEqual([
      { name: 'Draft', color: '#aabbcc' },
      { name: 'Review', color: null },
    ]);
    expect(createTaskFieldOptionInputSchema.safeParse({ expectedRevision: 1, name: 'X', color: 'red' }).success).toBe(
      false,
    );
  });

  it('defaults history on, lock off and no options, and leaves option/type compatibility to the domain', () => {
    expect(createTaskFieldInputSchema.parse({ projectId: ids.project, name: ' Notes ', type: 'text' })).toEqual({
      projectId: ids.project,
      name: 'Notes',
      type: 'text',
      historyEnabled: true,
      locked: false,
      options: [],
    });
    expect(
      createTaskFieldInputSchema.safeParse({ projectId: ids.project, name: 'N', type: 'text', options: [{ name: 'A' }] })
        .success,
    ).toBe(true);
  });

  it('rejects caller-supplied identity, workspace, IDs and bindings on create', () => {
    const base = { projectId: ids.project, name: 'Stage', type: 'single_select' };

    for (const spoof of [
      { id: ids.field },
      { workspaceId: ids.workspace },
      { actor: { id: ids.actor } },
      { binding: 'estimate' },
      { revision: 1 },
    ]) {
      expect(createTaskFieldInputSchema.safeParse({ ...base, ...spoof }).success).toBe(false);
    }
    expect(
      createTaskFieldInputSchema.safeParse({ ...base, options: [{ name: 'A', id: ids.optionA }] }).success,
    ).toBe(false);
  });

  it('requires a field revision and at least one change on field and option updates', () => {
    expect(issuePaths(updateTaskFieldInputSchema.safeParse({ expectedRevision: 2 }))).toEqual(['']);
    expect(updateTaskFieldInputSchema.safeParse({ expectedRevision: 0, archived: true }).success).toBe(false);
    expect(updateTaskFieldInputSchema.safeParse({ expectedRevision: 2, historyEnabled: false }).success).toBe(true);
    expect(updateTaskFieldInputSchema.safeParse({ expectedRevision: 2, type: 'number' }).success).toBe(true);
    expect(updateTaskFieldInputSchema.safeParse({ expectedRevision: 2, deleteValues: true }).success).toBe(false);

    expect(updateTaskFieldOptionInputSchema.safeParse({ expectedRevision: 3 }).success).toBe(false);
    expect(updateTaskFieldOptionInputSchema.safeParse({ expectedRevision: 3, color: null }).success).toBe(true);
    expect(updateTaskFieldOptionInputSchema.safeParse({ expectedRevision: 3, position: -1 }).success).toBe(false);
  });

  it('rejects options on non-select definitions and duplicate option IDs', () => {
    expect(taskFieldDefinitionSchema.safeParse(selectField()).success).toBe(true);
    expect(issuePaths(taskFieldDefinitionSchema.safeParse(selectField({ type: 'text' })))).toEqual(['options']);
    expect(
      issuePaths(taskFieldDefinitionSchema.safeParse(selectField({ options: [draftOption, draftOption] }))),
    ).toEqual(['options']);
  });
});

describe('project columns', () => {
  const column = (fieldId: string, position: number) => ({ fieldId, visible: true, width: 160, position });

  it('accepts an empty full update for a project without active fields', () => {
    expect(updateProjectColumnsInputSchema.safeParse({ expectedRevision: 1, columns: [] }).success).toBe(true);
  });

  it('rejects duplicate field IDs (case-insensitively) and duplicate positions', () => {
    const upper = ids.field.toUpperCase();

    expect(
      updateProjectColumnsInputSchema.safeParse({ expectedRevision: 1, columns: [column(ids.field, 0), column(upper, 1)] })
        .success,
    ).toBe(false);
    expect(
      projectColumnsSchema.safeParse({
        workspaceId: ids.workspace,
        projectId: ids.project,
        revision: 1,
        columns: [column(ids.field, 0), column(ids.optionA, 0)],
      }).success,
    ).toBe(false);
  });

  it('bounds width to 80..640 and the update to 100 columns', () => {
    for (const width of [79, 641, 100.5]) {
      expect(
        updateProjectColumnsInputSchema.safeParse({ expectedRevision: 1, columns: [{ ...column(ids.field, 0), width }] })
          .success,
      ).toBe(false);
    }
    const many = Array.from({ length: 101 }, (_, i) => column(uuid(i + 1), i));
    expect(updateProjectColumnsInputSchema.safeParse({ expectedRevision: 1, columns: many }).success).toBe(false);
    expect(updateProjectColumnsInputSchema.safeParse({ expectedRevision: 1, columns: many.slice(0, 100) }).success).toBe(
      true,
    );
  });
});

describe('setTaskFieldValueInputSchema', () => {
  it('lets revision 0 create a row, including an explicit null', () => {
    const parsed = setTaskFieldValueInputSchema.parse({
      expectedRevision: 0,
      expectedDefinitionRevision: 1,
      value: { type: 'boolean', value: null },
    });

    expect(parsed.value).toEqual({ type: 'boolean', value: null });
  });

  it('rejects negative or fractional revisions, a zero definition revision, untyped values and spoofed keys', () => {
    const value = { type: 'number', value: 1 };

    expect(setTaskFieldValueInputSchema.safeParse({ expectedRevision: -1, expectedDefinitionRevision: 1, value }).success).toBe(
      false,
    );
    expect(setTaskFieldValueInputSchema.safeParse({ expectedRevision: 1.5, expectedDefinitionRevision: 1, value }).success).toBe(
      false,
    );
    expect(setTaskFieldValueInputSchema.safeParse({ expectedRevision: 1, expectedDefinitionRevision: 0, value }).success).toBe(
      false,
    );
    expect(
      setTaskFieldValueInputSchema.safeParse({ expectedRevision: 1, expectedDefinitionRevision: 1, value: 1 }).success,
    ).toBe(false);
    for (const spoof of [{ taskId: ids.task }, { fieldId: ids.field }, { actor: { id: ids.actor } }, { source: 'job' }]) {
      expect(
        setTaskFieldValueInputSchema.safeParse({ expectedRevision: 1, expectedDefinitionRevision: 1, value, ...spoof })
          .success,
      ).toBe(false);
    }
  });
});

describe('queries', () => {
  it('splits a CSV taskIds string into a lowercase, sorted list', () => {
    const raw = `${ids.task.toUpperCase()},${ids.field}`;

    expect(taskFieldBatchQuerySchema.parse({ taskIds: raw })).toEqual({ taskIds: [ids.task, ids.field].sort() });
    expect(taskFieldBatchQuerySchema.parse({ taskIds: [ids.field] })).toEqual({ taskIds: [ids.field] });
  });

  it('rejects empty, duplicated, malformed and oversized task batches', () => {
    const rejected = [
      '',
      `${ids.task},`,
      `${ids.task},${ids.task.toUpperCase()}`,
      'not-a-uuid',
      Array.from({ length: 201 }, (_, i) => uuid(i + 1)).join(','),
    ];

    for (const taskIds of rejected) expect(taskFieldBatchQuerySchema.safeParse({ taskIds }).success).toBe(false);
    expect(taskFieldBatchQuerySchema.safeParse({}).success).toBe(false);
    expect(
      taskFieldBatchQuerySchema.safeParse({ taskIds: Array.from({ length: 200 }, (_, i) => uuid(i + 1)).join(',') })
        .success,
    ).toBe(true);
  });

  it('coerces the history limit from the query string with a default of 50', () => {
    expect(taskFieldHistoryQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(taskFieldHistoryQuerySchema.parse({ limit: '100', cursor: 'opaque' })).toEqual({
      limit: 100,
      cursor: 'opaque',
    });
    for (const query of [{ limit: '0' }, { limit: '101' }, { limit: '2.5' }, { cursor: '' }, { cursor: 'c'.repeat(2049) }]) {
      expect(taskFieldHistoryQuerySchema.safeParse(query).success).toBe(false);
    }
    expect(taskFieldHistoryQuerySchema.safeParse({ actorId: ids.actor }).success).toBe(false);
  });
});

describe('taskFieldValueHistorySchema', () => {
  const entry = {
    id: ids.history,
    workspaceId: ids.workspace,
    projectId: ids.project,
    taskId: ids.task,
    fieldId: ids.field,
    valueRevision: 1,
    definition: selectField(),
    before: null,
    after: { type: 'single_select', value: ids.optionA },
    actor: { id: ids.actor, displayName: 'Synthetic Member One' },
    source: 'web',
    recordedAt: at,
    changeSeq: '9007199254740993',
    eventOrdinal: 1,
  };

  it('accepts a first write with no previous row and keeps a bigint changeSeq exact', () => {
    const parsed = taskFieldValueHistorySchema.parse(entry);

    expect(parsed.before).toBeNull();
    expect(parsed.changeSeq).toBe('9007199254740993');
    expect(
      taskFieldValueHistoryListResponseSchema.safeParse({ data: [entry], meta: { requestId: 'r-1', nextCursor: null } })
        .success,
    ).toBe(true);
  });

  it('records a clear as a typed null after a previous value', () => {
    const clear = { ...entry, valueRevision: 2, before: entry.after, after: { type: 'single_select', value: null } };

    expect(taskFieldValueHistorySchema.safeParse(clear).success).toBe(true);
    expect(taskFieldValueHistorySchema.safeParse({ ...clear, after: null }).success).toBe(false);
  });

  it('rejects values whose type differs from the snapshot and snapshots of another field', () => {
    expect(issuePaths(taskFieldValueHistorySchema.safeParse({ ...entry, after: { type: 'text', value: 'Draft' } }))).toEqual([
      'after.type',
    ]);
    expect(
      issuePaths(taskFieldValueHistorySchema.safeParse({ ...entry, definition: selectField({ id: ids.optionA }) })),
    ).toEqual(['definition.id']);
  });

  it('rejects unknown sources, non-decimal sequences, zero ordinals and local timestamps', () => {
    for (const patch of [
      { source: 'cron' },
      { changeSeq: '012' },
      { changeSeq: 12 },
      { changeSeq: '-1' },
      { eventOrdinal: 0 },
      { valueRevision: 0 },
      { recordedAt: '2026-10-16T12:30:00+03:00' },
    ]) {
      expect(taskFieldValueHistorySchema.safeParse({ ...entry, ...patch }).success).toBe(false);
    }
  });
});
