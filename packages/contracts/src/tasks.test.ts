import { describe, expect, it } from 'vitest';

import {
  createSectionInputSchema,
  createTaskInputSchema,
  moveTaskInputSchema,
  taskInsertionSchema,
  taskListQuerySchema,
  taskSchema,
  updateProjectInputSchema,
  updateTagInputSchema,
  updateTaskInputSchema,
} from './index.js';

const ids = {
  workspace: '00000000-0000-4000-8000-000000000101',
  memberA: '00000000-0000-4000-8000-000000000201',
  memberB: '00000000-0000-4000-8000-000000000202',
  project: '00000000-0000-4000-8000-000000000401',
  status: '00000000-0000-4000-8000-000000000501',
  parent: '00000000-0000-4000-8000-000000000601',
  task: '00000000-0000-4000-8000-000000000602',
  workPackage: '00000000-0000-4000-8000-000000000701',
  tagDesign: '00000000-0000-4000-8000-000000000801',
  tagOps: '00000000-0000-4000-8000-000000000802',
} as const;

const rootTask = { projectId: ids.project, title: 'Draft the onboarding checklist', statusId: ids.status };
const subtask = { ...rootTask, parentTaskId: ids.parent };

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** Dotted paths of the issues in a failed parse; empty when parsing succeeded. */
function issuePaths(result: { error?: { issues: readonly { path: readonly PropertyKey[] }[] } }): string[] {
  return result.error?.issues.map((issue) => issue.path.map(String).join('.')) ?? [];
}

describe('createTaskInputSchema work packages', () => {
  it('lets a root task set an estimate whatever its workScope', () => {
    expect(createTaskInputSchema.safeParse({ ...rootTask, estimateMinutes: 120 }).success).toBe(true);
    expect(createTaskInputSchema.safeParse({ ...rootTask, estimateMinutes: 120, workScope: 'detail' }).success).toBe(
      true,
    );
    expect(createTaskInputSchema.safeParse({ ...rootTask, parentTaskId: null, estimateMinutes: 30 }).success).toBe(
      true,
    );
  });

  it('rejects any estimate on a detail subtask, zero included, so the parent budget is never copied', () => {
    for (const estimateMinutes of [0, 90]) {
      for (const scope of [{}, { workScope: 'detail' }]) {
        const result = createTaskInputSchema.safeParse({ ...subtask, ...scope, estimateMinutes });

        expect(result.success).toBe(false);
        expect(issuePaths(result)).toEqual(['estimateMinutes']);
      }
    }
  });

  it('accepts a detail subtask that leaves the estimate empty', () => {
    expect(createTaskInputSchema.safeParse(subtask).success).toBe(true);
    expect(createTaskInputSchema.safeParse({ ...subtask, estimateMinutes: null }).success).toBe(true);
  });

  it('lets an added_scope subtask estimate new work with null, 0 or a positive value', () => {
    for (const estimateMinutes of [null, 0, 45]) {
      const parsed = createTaskInputSchema.parse({ ...subtask, workScope: 'added_scope', estimateMinutes });

      expect(parsed.estimateMinutes).toBe(estimateMinutes);
    }
  });
});

describe('createTaskInputSchema fields', () => {
  it('rejects server-owned and unknown fields', () => {
    for (const extra of [
      { actor: { id: ids.memberA } },
      { actualMinutes: 30 },
      { capabilities: ['task.update'] },
      { workspaceId: ids.workspace },
    ]) {
      expect(createTaskInputSchema.safeParse({ ...rootTask, ...extra }).success).toBe(false);
    }
  });

  it('rejects duplicate participants, also when they differ only in letter case', () => {
    expect(
      createTaskInputSchema.safeParse({ ...rootTask, participantMembershipIds: [ids.memberA, ids.memberA] }).success,
    ).toBe(false);
    expect(
      createTaskInputSchema.safeParse({
        ...rootTask,
        participantMembershipIds: [ids.memberA, ids.memberA.toUpperCase()],
      }).success,
    ).toBe(false);
    expect(
      createTaskInputSchema.safeParse({ ...rootTask, participantMembershipIds: [ids.memberA, ids.memberB] }).success,
    ).toBe(true);
  });

  it('caps participants at 100', () => {
    const members = (count: number) => Array.from({ length: count }, (_, index) => uuid(1000 + index));

    expect(createTaskInputSchema.safeParse({ ...rootTask, participantMembershipIds: members(100) }).success).toBe(true);
    expect(createTaskInputSchema.safeParse({ ...rootTask, participantMembershipIds: members(101) }).success).toBe(
      false,
    );
  });

  it('takes tags as unique IDs, not label strings', () => {
    expect(createTaskInputSchema.safeParse({ ...rootTask, tagIds: [ids.tagDesign, ids.tagOps] }).success).toBe(true);
    expect(createTaskInputSchema.safeParse({ ...rootTask, tagIds: [ids.tagDesign, ids.tagDesign] }).success).toBe(
      false,
    );
    expect(createTaskInputSchema.safeParse({ ...rootTask, tagIds: ['design'] }).success).toBe(false);
    expect(createTaskInputSchema.safeParse({ ...rootTask, tags: ['design'] }).success).toBe(false);
  });

  it('caps tags at 50', () => {
    const tagIds = (count: number) => Array.from({ length: count }, (_, index) => uuid(2000 + index));

    expect(createTaskInputSchema.safeParse({ ...rootTask, tagIds: tagIds(50) }).success).toBe(true);
    expect(createTaskInputSchema.safeParse({ ...rootTask, tagIds: tagIds(51) }).success).toBe(false);
  });

  it('accepts only real calendar dates as dueDate', () => {
    for (const dueDate of ['2026-02-30', '2026-02-29', '2026-13-01', '2026-10-16T00:00:00Z']) {
      expect(createTaskInputSchema.safeParse({ ...rootTask, dueDate }).success).toBe(false);
    }
    for (const dueDate of ['2028-02-29', '2026-10-16', null]) {
      expect(createTaskInputSchema.safeParse({ ...rootTask, dueDate }).success).toBe(true);
    }
  });

  it('rejects a blank title after trimming', () => {
    expect(createTaskInputSchema.safeParse({ ...rootTask, title: '   ' }).success).toBe(false);
  });
});

describe('createTaskInputSchema insertion', () => {
  /** Has letters so upper-case input proves canonicalization. */
  const anchor = 'abcdef00-0000-4000-8000-000000003001';

  it('parses the old literal body to exactly its old keys, adding no insertion', () => {
    const parsed = createTaskInputSchema.parse({ projectId: ids.project, title: 'Draft the onboarding checklist', statusId: ids.status });

    expect(parsed).toStrictEqual(rootTask);
    expect(Object.keys(parsed).sort()).toEqual(['projectId', 'statusId', 'title']);
    expect(Object.hasOwn(parsed, 'insertion')).toBe(false);
    const explicitUndefined = createTaskInputSchema.safeParse({ ...rootTask, insertion: undefined });
    expect(explicitUndefined.success).toBe(true);
    expect(explicitUndefined.data?.insertion).toBeUndefined();
  });

  it('accepts one canonical anchor before or after, for root tasks and subtasks', () => {
    for (const placement of ['before', 'after'] as const) {
      const expected = { anchorTaskId: anchor, placement };
      expect(taskInsertionSchema.parse({ anchorTaskId: anchor.toUpperCase(), placement })).toStrictEqual(expected);
      expect(createTaskInputSchema.parse({ ...rootTask, insertion: { anchorTaskId: anchor.toUpperCase(), placement } }).insertion).toStrictEqual(expected);
      expect(createTaskInputSchema.parse({ ...subtask, insertion: expected }).insertion).toStrictEqual(expected);
    }
  });

  it('rejects malformed or open-ended insertions', () => {
    for (const insertion of [
      null,
      anchor,
      [anchor],
      {},
      { anchorTaskId: anchor },
      { placement: 'after' },
      { anchorTaskId: anchor, placement: 'inside' },
      { anchorTaskId: anchor, placement: 'AFTER' },
      { anchorTaskId: anchor, placement: '' },
      { anchorTaskId: anchor, placement: null },
      { anchorTaskId: 'task-1', placement: 'after' },
      { anchorTaskId: null, placement: 'after' },
      { anchorTaskId: anchor, placement: 'after', index: 2 },
      { anchorTaskId: anchor, placement: 'after', sectionId: ids.parent },
    ]) {
      expect(createTaskInputSchema.safeParse({ ...rootTask, insertion }).success).toBe(false);
    }
  });

  it('keeps position and insertion mutually exclusive', () => {
    for (const position of [0, 7]) {
      const result = createTaskInputSchema.safeParse({ ...rootTask, position, insertion: { anchorTaskId: anchor, placement: 'before' } });
      expect(issuePaths(result)).toEqual(['insertion']);
    }
    expect(createTaskInputSchema.parse({ ...rootTask, position: 7 }).position).toBe(7);
  });

  it('is not an update field', () => {
    const insertion = { anchorTaskId: anchor, placement: 'after' };
    expect(updateTaskInputSchema.safeParse({ expectedRevision: 3, insertion }).success).toBe(false);
    expect(updateTaskInputSchema.safeParse({ expectedRevision: 3, title: 'Renamed', insertion }).success).toBe(false);
  });
});

describe('moveTaskInputSchema', () => {
  const anchor = 'abcdef00-0000-4000-8000-000000003001';
  const move = { expectedRevision: 3, anchorTaskId: anchor, placement: 'after' } as const;

  it('parses exactly a guarded canonical anchor and placement', () => {
    expect(moveTaskInputSchema.parse(move)).toStrictEqual(move);
    expect(moveTaskInputSchema.parse({ ...move, anchorTaskId: anchor.toUpperCase(), placement: 'before' })).toStrictEqual({
      ...move,
      placement: 'before',
    });
  });

  it('requires every field, so even a no-op carries expectedRevision', () => {
    for (const body of [
      {},
      { anchorTaskId: anchor, placement: 'after' },
      { expectedRevision: 3, placement: 'after' },
      { expectedRevision: 3, anchorTaskId: anchor },
    ]) {
      expect(moveTaskInputSchema.safeParse(body).success).toBe(false);
    }
    for (const expectedRevision of [0, -1, 1.5, '3', null]) {
      expect(moveTaskInputSchema.safeParse({ ...move, expectedRevision }).success).toBe(false);
    }
    for (const placement of ['inside', 'first', 'BEFORE', '', null]) {
      expect(moveTaskInputSchema.safeParse({ ...move, placement }).success).toBe(false);
    }
    for (const anchorTaskId of ['task-1', '', null]) {
      expect(moveTaskInputSchema.safeParse({ ...move, anchorTaskId }).success).toBe(false);
    }
  });

  it('rejects fields outside the supported order modes', () => {
    for (const extra of [
      { position: 0 },
      { sectionId: ids.parent },
      { parentTaskId: ids.parent },
      { insertion: { anchorTaskId: anchor, placement: 'after' } },
      { actor: ids.memberA },
      { workspaceId: ids.workspace },
    ]) {
      expect(moveTaskInputSchema.safeParse({ ...move, ...extra }).success).toBe(false);
    }
  });
});

describe('updateTaskInputSchema', () => {
  it('rejects a body with no field to change', () => {
    expect(updateTaskInputSchema.safeParse({ expectedRevision: 3 }).success).toBe(false);
    expect(updateTaskInputSchema.safeParse({ expectedRevision: 3, expectedWorkPackageRevision: 2 }).success).toBe(
      false,
    );
    expect(updateTaskInputSchema.safeParse({ expectedRevision: 3, expectedParticipantsRevision: 2 }).success).toBe(
      false,
    );
  });

  it('counts clearing a nullable field as a change', () => {
    expect(updateTaskInputSchema.parse({ expectedRevision: 3, dueDate: null }).dueDate).toBeNull();
  });

  it('requires expectedWorkPackageRevision whenever estimateMinutes is sent, null included', () => {
    for (const estimateMinutes of [null, 0, 60]) {
      const result = updateTaskInputSchema.safeParse({ expectedRevision: 3, estimateMinutes });

      expect(issuePaths(result)).toEqual(['expectedWorkPackageRevision']);
    }
  });

  it('keeps null (clear the estimate) distinct from 0 (estimated as zero)', () => {
    const guard = { expectedRevision: 3, expectedWorkPackageRevision: 2 };
    const cleared = updateTaskInputSchema.parse({ ...guard, estimateMinutes: null });
    const zero = updateTaskInputSchema.parse({ ...guard, estimateMinutes: 0 });

    expect(cleared.estimateMinutes).toBeNull();
    expect(zero.estimateMinutes).toBe(0);
  });

  it('rejects a revision guard sent without its field', () => {
    const packageGuard = updateTaskInputSchema.safeParse({
      expectedRevision: 3,
      title: 'Renamed',
      expectedWorkPackageRevision: 2,
    });
    const participantsGuard = updateTaskInputSchema.safeParse({
      expectedRevision: 3,
      title: 'Renamed',
      expectedParticipantsRevision: 2,
    });

    expect(issuePaths(packageGuard)).toEqual(['expectedWorkPackageRevision']);
    expect(issuePaths(participantsGuard)).toEqual(['expectedParticipantsRevision']);
  });

  it('requires expectedParticipantsRevision to replace participants, including clearing them', () => {
    expect(issuePaths(updateTaskInputSchema.safeParse({ expectedRevision: 3, participantMembershipIds: [] }))).toEqual([
      'expectedParticipantsRevision',
    ]);
    expect(
      updateTaskInputSchema.safeParse({
        expectedRevision: 3,
        participantMembershipIds: [],
        expectedParticipantsRevision: 4,
      }).success,
    ).toBe(true);
  });

  it('rejects duplicate participant and tag IDs', () => {
    expect(
      updateTaskInputSchema.safeParse({
        expectedRevision: 3,
        participantMembershipIds: [ids.memberB, ids.memberB],
        expectedParticipantsRevision: 4,
      }).success,
    ).toBe(false);
    expect(updateTaskInputSchema.safeParse({ expectedRevision: 3, tagIds: [ids.tagOps, ids.tagOps] }).success).toBe(
      false,
    );
  });

  it('rejects actor, capabilities and actualMinutes in the body', () => {
    for (const extra of [{ actor: ids.memberA }, { capabilities: [] }, { actualMinutes: 15 }]) {
      expect(updateTaskInputSchema.safeParse({ expectedRevision: 3, title: 'Renamed', ...extra }).success).toBe(false);
    }
  });

  it('rejects revisions that are not positive integers', () => {
    for (const expectedRevision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(updateTaskInputSchema.safeParse({ expectedRevision, title: 'Renamed' }).success).toBe(false);
    }
  });
});

describe('project, section and tag commands', () => {
  it('require a change besides expectedRevision', () => {
    expect(updateProjectInputSchema.safeParse({ expectedRevision: 1 }).success).toBe(false);
    expect(updateProjectInputSchema.safeParse({ expectedRevision: 1, archived: false }).success).toBe(true);
    expect(updateTagInputSchema.safeParse({ expectedRevision: 1 }).success).toBe(false);
    expect(updateTagInputSchema.safeParse({ expectedRevision: 1, color: null }).success).toBe(true);
  });

  it('reject unknown fields on updates', () => {
    expect(updateProjectInputSchema.safeParse({ expectedRevision: 1, name: 'Ops', owner: ids.memberA }).success).toBe(
      false,
    );
  });

  it('accept only #rrggbb tag colors', () => {
    for (const color of ['red', '#fff', '#12345g', '123456']) {
      expect(updateTagInputSchema.safeParse({ expectedRevision: 1, color }).success).toBe(false);
    }
    expect(updateTagInputSchema.safeParse({ expectedRevision: 1, color: '#1A2b3C' }).success).toBe(true);
  });

  it('bounds section positions to 0..2147483647', () => {
    expect(createSectionInputSchema.safeParse({ name: 'Backlog', position: 2_147_483_647 }).success).toBe(true);
    expect(createSectionInputSchema.safeParse({ name: 'Backlog', position: 2_147_483_648 }).success).toBe(false);
    expect(createSectionInputSchema.safeParse({ name: 'Backlog', position: -1 }).success).toBe(false);
  });
});

describe('taskListQuerySchema', () => {
  it('accepts one canonical tag ID without adding a default to old queries', () => {
    const tagId = 'abcdef00-0000-4000-8000-000000000801';
    expect(taskListQuerySchema.parse({ projectId: ids.project, tagId: tagId.toUpperCase() }).tagId).toBe(tagId);
    expect(taskListQuerySchema.parse({ projectId: ids.project })).toEqual({ projectId: ids.project, limit: 50 });
    for (const tagId of ['', 'design', null, [ids.tagDesign], [ids.tagDesign, ids.tagOps]]) {
      expect(taskListQuerySchema.safeParse({ projectId: ids.project, tagId }).success).toBe(false);
    }
    expect(taskListQuerySchema.safeParse({ projectId: ids.project, tagIds: [ids.tagDesign] }).success).toBe(false);
  });

  it('reads includeArchived=false from a query string as false', () => {
    const query = taskListQuerySchema.parse({ projectId: ids.project, includeArchived: 'false' });

    expect(query.includeArchived).toBe(false);
    expect(taskListQuerySchema.parse({ projectId: ids.project, includeArchived: 'true' }).includeArchived).toBe(true);
    expect(taskListQuerySchema.parse({ projectId: ids.project, includeArchived: true }).includeArchived).toBe(true);
  });

  it('rejects boolean spellings other than true and false', () => {
    for (const includeArchived of ['yes', '1', '0', 'FALSE', '']) {
      expect(taskListQuerySchema.safeParse({ projectId: ids.project, includeArchived }).success).toBe(false);
    }
  });

  it('defaults limit to 50 and coerces it within 1..200', () => {
    expect(taskListQuerySchema.parse({ projectId: ids.project }).limit).toBe(50);
    expect(taskListQuerySchema.parse({ projectId: ids.project, limit: '200' }).limit).toBe(200);
    for (const limit of ['0', '201', '2.5', 'abc']) {
      expect(taskListQuerySchema.safeParse({ projectId: ids.project, limit }).success).toBe(false);
    }
  });

  it('requires projectId and rejects unknown parameters, empty cursors and long searches', () => {
    expect(taskListQuerySchema.safeParse({}).success).toBe(false);
    expect(taskListQuerySchema.safeParse({ projectId: ids.project, sort: 'title' }).success).toBe(false);
    expect(taskListQuerySchema.safeParse({ projectId: ids.project, cursor: '' }).success).toBe(false);
    expect(taskListQuerySchema.safeParse({ projectId: ids.project, search: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('taskSchema', () => {
  const task = {
    id: ids.task,
    workspaceId: ids.workspace,
    projectId: ids.project,
    sectionId: null,
    parentTaskId: ids.parent,
    workPackageId: ids.workPackage,
    workPackageRevision: 2,
    title: 'Write the import mapping',
    description: '',
    statusId: ids.status,
    responsibleMembershipId: ids.memberA,
    participants: [
      { membershipId: ids.memberA, role: 'assignee', active: true, revision: 1 },
      { membershipId: ids.memberB, role: 'assignee', active: false, revision: 2 },
    ],
    participantsRevision: 3,
    dueDate: '2026-10-30',
    priority: 'high',
    tags: [
      {
        id: ids.tagDesign,
        workspaceId: ids.workspace,
        name: 'Design',
        color: '#3366ff',
        revision: 1,
        archivedAt: '2026-10-01T09:00:00.000Z',
      },
    ],
    estimateMinutes: 0,
    revision: 5,
    position: 10,
    visibility: 'workspace',
    archivedAt: null,
    createdAt: '2026-10-16T08:00:00.000Z',
    updatedAt: '2026-10-16T09:30:00Z',
  } as const;

  it('keeps inactive participants, archived tags and a zero estimate as sent', () => {
    expect(taskSchema.parse(task)).toEqual(task);
    expect(taskSchema.parse({ ...task, estimateMinutes: null }).estimateMinutes).toBeNull();
  });

  it('rejects timestamps with an offset and non-workspace visibility', () => {
    expect(taskSchema.safeParse({ ...task, updatedAt: '2026-10-16T12:30:00+03:00' }).success).toBe(false);
    expect(taskSchema.safeParse({ ...task, visibility: 'private' }).success).toBe(false);
  });

  it('rejects tags given as label strings', () => {
    expect(taskSchema.safeParse({ ...task, tags: ['Design'] }).success).toBe(false);
  });
});


describe('bounded task due sort query', () => {
  it('adds no default sort to legacy query output', () => {
    expect(taskListQuerySchema.parse({ projectId: ids.project })).toEqual({ projectId: ids.project, limit: 50 });
    for (const sort of ['manual', 'due_asc']) expect(taskListQuerySchema.parse({ projectId: ids.project, sort })).toMatchObject({ sort });
  });
  it('accepts only one bounded scalar mode and keeps page limits independent', () => {
    for (const sort of ['due_desc', 'title', '', null, ['due_asc'], { dueDate: 'asc' }]) {
      expect(taskListQuerySchema.safeParse({ projectId: ids.project, sort }).success).toBe(false);
    }
    for (const limit of [0, 201]) expect(taskListQuerySchema.safeParse({ projectId: ids.project, sort: 'due_asc', limit }).success).toBe(false);
    expect(taskListQuerySchema.safeParse({ projectId: ids.project, sort: 'due_asc', direction: 'asc' }).success).toBe(false);
  });
});

describe('open task completion filter query', () => {
  it('adds no completion key or default to legacy query output', () => {
    const legacy = taskListQuerySchema.parse({ projectId: ids.project });
    expect(legacy).toEqual({ projectId: ids.project, limit: 50 });
    expect(Object.keys(legacy)).toEqual(['projectId', 'limit']);
    expect(Object.hasOwn(legacy, 'completion')).toBe(false);
    const explicitUndefined = taskListQuerySchema.parse({ projectId: ids.project, completion: undefined });
    expect(Object.hasOwn(explicitUndefined, 'completion')).toBe(true);
    expect(explicitUndefined.completion).toBeUndefined();
  });

  it('accepts only the scalar open mode alongside the other filters', () => {
    const query = { projectId: ids.project, statusId: ids.status, tagId: ids.tagDesign, completion: 'open', sort: 'due_asc' };
    expect(taskListQuerySchema.parse(query)).toEqual({ ...query, limit: 50 });
    for (const completion of ['all', 'done', 'closed', 'OPEN', '', null, true, ['open'], { group: 'todo' }]) {
      expect(taskListQuerySchema.safeParse({ projectId: ids.project, completion }).success).toBe(false);
    }
    expect(taskListQuerySchema.safeParse({ projectId: ids.project, completed: 'open' }).success).toBe(false);
    expect(taskListQuerySchema.safeParse({ projectId: ids.project, statusGroup: 'todo' }).success).toBe(false);
  });
});


describe('atomic Board lane move input', () => {
  const legacy = { expectedRevision: 1, anchorTaskId: ids.parent, placement: 'before' as const };
  it('adds no status default to old parsed moves and accepts exact status lane placement', () => {
    expect(moveTaskInputSchema.parse(legacy)).toEqual(legacy);
    expect(Object.hasOwn(moveTaskInputSchema.parse(legacy), 'statusId')).toBe(false);
    expect(moveTaskInputSchema.parse({ ...legacy, statusId: ids.status.toUpperCase() })).toEqual({ ...legacy, statusId: ids.status });
    expect(moveTaskInputSchema.parse({ ...legacy, statusId: ids.status, anchorTaskId: null, placement: 'after' })).toEqual({ ...legacy, statusId: ids.status, anchorTaskId: null, placement: 'after' });
  });
  it('rejects mixed modes, unbounded positions and invalid lane ends', () => {
    for (const extra of [
      { statusId: null }, { statusId: 'unknown' },
      { statusId: ids.status, responsibleMembershipId: null },
      { statusId: ids.status, responsibleMembershipId: ids.memberA },
      { statusId: ids.status, anchorTaskId: null },
      { statusId: ids.status, position: 3 }, { statusId: ids.status, placement: 'end' },
    ]) expect(moveTaskInputSchema.safeParse({ ...legacy, ...extra }).success).toBe(false);
  });
});
