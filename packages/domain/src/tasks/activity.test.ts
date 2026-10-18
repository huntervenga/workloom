import { describe, expect, it } from 'vitest';
import type { SectionDto, TagDto, TaskDto, TaskParticipantDto, TaskStatusDto } from '@workloom/contracts';

import type { MembershipRecord } from '../access/ports.js';
import { loadTaskActivityLabels, taskActivityDiff, type TaskActivityPair } from './activity.js';
import type { TaskRepository, TaskWriteScope } from './ports.js';

const WS = '00000000-0000-4000-8000-000000000001';
const PROJECT = '00000000-0000-4000-8000-000000000002';
const TODO = '00000000-0000-4000-8000-000000000010';
const DONE = '00000000-0000-4000-8000-000000000011';
const GONE_STATUS = '00000000-0000-4000-8000-000000000012';
const BACKLOG = '00000000-0000-4000-8000-000000000020';
const ANNA = '00000000-0000-4000-8000-000000000030';
const BORIS = '00000000-0000-4000-8000-000000000031';
const REVOKED = '00000000-0000-4000-8000-000000000032';
const T0 = '2026-10-01T09:00:00.000Z';

const SECRET_TITLE = 'Secret acquisition plan';
const SECRET_DESCRIPTION = 'Confidential description body';

function status(id: string, name: string, group: TaskStatusDto['group']): TaskStatusDto {
  return { id, workspaceId: WS, projectId: PROJECT, name, group, position: 0, revision: 1 };
}

function section(id: string, name: string): SectionDto {
  return { id, workspaceId: WS, projectId: PROJECT, name, position: 0, revision: 1, archivedAt: null };
}

function member(id: string, displayName: string): MembershipRecord {
  return { id, workspaceId: WS, userId: id, displayName } as unknown as MembershipRecord;
}

function tag(id: string, name: string): TagDto {
  return { id, workspaceId: WS, name, color: null, revision: 1, archivedAt: null };
}

function participant(membershipId: string, active = true): TaskParticipantDto {
  return { membershipId, role: 'assignee', active, revision: 1 };
}

function task(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id: '00000000-0000-4000-8000-000000000100',
    workspaceId: WS,
    projectId: PROJECT,
    sectionId: null,
    parentTaskId: null,
    workPackageId: '00000000-0000-4000-8000-000000000200',
    workPackageRevision: 1,
    title: SECRET_TITLE,
    description: SECRET_DESCRIPTION,
    statusId: TODO,
    responsibleMembershipId: null,
    participants: [],
    participantsRevision: 1,
    startDate: null,
    dueDate: null,
    priority: 'none',
    tags: [],
    estimateMinutes: null,
    revision: 1,
    position: 0,
    visibility: 'workspace',
    archivedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

interface Store {
  statuses: TaskStatusDto[];
  sections: SectionDto[];
  members: MembershipRecord[];
}

function fakeScope(store: Store) {
  const calls = { statuses: [] as string[], sections: [] as string[], memberLists: 0 };
  const repository: Pick<TaskRepository, 'findStatus' | 'findSection'> & {
    access: Pick<TaskRepository['access'], 'listActiveMemberships'>;
  } = {
    async findStatus(workspaceId, id) {
      calls.statuses.push(id);
      const row = store.statuses.find((candidate) => candidate.workspaceId === workspaceId && candidate.id === id);
      return row === undefined ? null : { ...row };
    },
    async findSection(workspaceId, id) {
      calls.sections.push(id);
      const row = store.sections.find((candidate) => candidate.workspaceId === workspaceId && candidate.id === id);
      return row === undefined ? null : { ...row };
    },
    access: {
      async listActiveMemberships(workspaceId) {
        calls.memberLists += 1;
        return store.members.filter((candidate) => candidate.workspaceId === workspaceId);
      },
    },
  };
  const scope = {
    repository: repository as unknown as TaskRepository,
    context: { workspaceId: WS } as unknown as TaskWriteScope['context'],
  };
  return { scope, calls };
}

function defaultStore(): Store {
  return {
    statuses: [status(TODO, 'To do', 'todo'), status(DONE, 'Done', 'done')],
    sections: [section(BACKLOG, 'Backlog')],
    members: [member(ANNA, 'Anna'), member(BORIS, 'Boris')],
  };
}

describe('taskActivityDiff', () => {
  it('captures initial references of a created task', async () => {
    const { scope } = fakeScope(defaultStore());
    const pair: TaskActivityPair = {
      before: null,
      after: task({
        sectionId: BACKLOG,
        responsibleMembershipId: ANNA,
        participants: [participant(ANNA), participant(BORIS, false)],
        tags: [tag('00000000-0000-4000-8000-000000000040', 'urgent')],
      }),
    };
    const labels = await loadTaskActivityLabels(scope, [pair]);
    expect(taskActivityDiff(pair, {}, labels).activity).toEqual({
      v: 1,
      status: { from: null, to: { id: TODO, name: 'To do', availability: 'snapshot', group: 'todo' } },
      section: { from: null, to: { id: BACKLOG, name: 'Backlog', availability: 'snapshot' } },
      responsible: { from: null, to: { id: ANNA, name: 'Anna', availability: 'snapshot' } },
      participants: { added: [{ id: ANNA, name: 'Anna', availability: 'snapshot' }], removed: [], omitted: 0 },
      tags: { added: [{ id: '00000000-0000-4000-8000-000000000040', name: 'urgent', availability: 'snapshot' }], removed: [], omitted: 0 },
    });
  });

  it('keeps status groups so completion and reopening are distinguishable', async () => {
    const { scope } = fakeScope(defaultStore());
    const reopen: TaskActivityPair = { before: task({ statusId: DONE }), after: task({ statusId: TODO, revision: 2 }) };
    const labels = await loadTaskActivityLabels(scope, [reopen]);
    expect(taskActivityDiff(reopen, {}, labels).activity).toEqual({
      v: 1,
      status: {
        from: { id: DONE, name: 'Done', availability: 'snapshot', group: 'done' },
        to: { id: TODO, name: 'To do', availability: 'snapshot', group: 'todo' },
      },
    });
  });

  it('keeps the existing diff and inputs intact and snapshots labels against later renames', async () => {
    const store = defaultStore();
    const { scope } = fakeScope(store);
    const tagId = '00000000-0000-4000-8000-000000000041';
    const pair = deepFreeze<TaskActivityPair>({
      before: task({ tags: [tag(tagId, 'old name')] }),
      after: task({ statusId: DONE, tags: [tag(tagId, 'new name')], revision: 2 }),
    });
    const diff = deepFreeze({ statusId: { from: TODO, to: DONE }, revision: { from: 1, to: 2 } });
    const encodedDiff = JSON.stringify(diff);
    const labels = await loadTaskActivityLabels(scope, [pair]);
    store.statuses = [status(DONE, 'Shipped', 'done'), status(TODO, 'Queued', 'todo')];

    const result = taskActivityDiff(pair, diff, labels);
    const { activity, ...rest } = result;
    expect(JSON.stringify(rest)).toBe(encodedDiff);
    expect(JSON.stringify(diff)).toBe(encodedDiff);
    expect(activity).toEqual({
      v: 1,
      status: {
        from: { id: TODO, name: 'To do', availability: 'snapshot', group: 'todo' },
        to: { id: DONE, name: 'Done', availability: 'snapshot', group: 'done' },
      },
    });
  });

  it('never copies titles, descriptions or custom values into the summary', async () => {
    const { scope } = fakeScope(defaultStore());
    const pair: TaskActivityPair = {
      before: task({ title: 'Old secret', description: 'Old body' }),
      after: task({ responsibleMembershipId: BORIS, revision: 2 }),
    };
    const diff = { title: { from: 'Old secret', to: SECRET_TITLE }, customFieldValue: 'classified-42' };
    const labels = await loadTaskActivityLabels(scope, [pair]);
    const result = taskActivityDiff(pair, diff, labels);
    const encoded = JSON.stringify(result.activity);
    for (const secret of ['Old secret', 'Old body', SECRET_TITLE, SECRET_DESCRIPTION, 'classified-42']) {
      expect(encoded).not.toContain(secret);
    }
    expect(result.title).toBe(diff.title);
    expect(Object.keys(result.activity as object).sort()).toEqual(['responsible', 'v']);
  });

  it('loads each changed reference once across a bulk batch', async () => {
    const { scope, calls } = fakeScope(defaultStore());
    const pairs: TaskActivityPair[] = [1, 2, 3].map((n) => ({
      before: task({ id: `00000000-0000-4000-8000-00000000010${n}`, statusId: TODO }),
      after: task({ id: `00000000-0000-4000-8000-00000000010${n}`, statusId: DONE, sectionId: BACKLOG, responsibleMembershipId: ANNA }),
    }));
    await loadTaskActivityLabels(scope, pairs);
    expect(calls.statuses.sort()).toEqual([TODO, DONE].sort());
    expect(calls.sections).toEqual([BACKLOG]);
    expect(calls.memberLists).toBe(1);
  });

  it('marks unknown statuses and revoked members as uncaptured instead of inventing names', async () => {
    const { scope } = fakeScope(defaultStore());
    const pair: TaskActivityPair = {
      before: task({ statusId: GONE_STATUS, responsibleMembershipId: REVOKED, participants: [participant(REVOKED)] }),
      after: task({ statusId: TODO, responsibleMembershipId: null, participants: [participant(REVOKED, false)], revision: 2 }),
    };
    const labels = await loadTaskActivityLabels(scope, [pair]);
    expect(taskActivityDiff(pair, {}, labels).activity).toEqual({
      v: 1,
      status: {
        from: { id: GONE_STATUS, name: null, availability: 'uncaptured' },
        to: { id: TODO, name: 'To do', availability: 'snapshot', group: 'todo' },
      },
      responsible: { from: { id: REVOKED, name: null, availability: 'uncaptured' }, to: null },
      participants: { added: [], removed: [{ id: REVOKED, name: null, availability: 'uncaptured' }], omitted: 0 },
    });
  });

  it('describes a no-op without any lookup', async () => {
    const { scope, calls } = fakeScope(defaultStore());
    const unchanged = task({ sectionId: BACKLOG, responsibleMembershipId: ANNA, participants: [participant(ANNA)] });
    const pair: TaskActivityPair = { before: unchanged, after: { ...unchanged } };
    const labels = await loadTaskActivityLabels(scope, [pair]);
    expect(calls).toEqual({ statuses: [], sections: [], memberLists: 0 });
    expect(taskActivityDiff(pair, { position: { from: 0, to: 0 } }, labels)).toEqual({ position: { from: 0, to: 0 }, activity: { v: 1 } });
  });

  it('counts references beyond the public cap instead of dropping them silently', async () => {
    const ids = Array.from({ length: 120 }, (_, n) => `00000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`);
    const { scope } = fakeScope({ ...defaultStore(), members: ids.map((id, n) => member(id, `Member ${n}`)) });
    const pair: TaskActivityPair = { before: null, after: task({ participants: ids.map((id) => participant(id)) }) };
    const labels = await loadTaskActivityLabels(scope, [pair]);
    const activity = taskActivityDiff(pair, {}, labels).activity as { participants: { added: unknown[]; omitted: number } };
    expect(activity.participants.added).toHaveLength(100);
    expect(activity.participants.omitted).toBe(20);
  });

  it('rejects more pairs than one bulk command may hold', async () => {
    const { scope } = fakeScope(defaultStore());
    const pairs = Array.from({ length: 101 }, () => ({ before: null, after: task() }));
    await expect(loadTaskActivityLabels(scope, pairs)).rejects.toThrow(RangeError);
  });
});
