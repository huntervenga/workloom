import type { MembershipDto, SectionDto, TagDto, TaskDto, TaskStatusDto } from '@workloom/contracts';

// Synthetic test data only; the table itself never ships fixtures.

const WORKSPACE = 'ws-1';
const PROJECT = 'project-1';
const CREATED = '2026-10-01T09:00:00Z';

export function makeTask(overrides: Partial<TaskDto> & Pick<TaskDto, 'id'>): TaskDto {
  return {
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    sectionId: null,
    parentTaskId: null,
    workPackageId: `wp-${overrides.id}`,
    workPackageRevision: 1,
    title: `Задача ${overrides.id}`,
    description: '',
    statusId: 'status-todo',
    responsibleMembershipId: null,
    participants: [],
    participantsRevision: 1,
    dueDate: null,
    priority: 'none',
    tags: [],
    estimateMinutes: null,
    revision: 1,
    position: 0,
    visibility: 'workspace',
    archivedAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

export function makeSection(overrides: Partial<SectionDto> & Pick<SectionDto, 'id' | 'name'>): SectionDto {
  return {
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    position: 0,
    revision: 1,
    archivedAt: null,
    ...overrides,
  };
}

export function makeTag(overrides: Partial<TagDto> & Pick<TagDto, 'id' | 'name'>): TagDto {
  return { workspaceId: WORKSPACE, color: null, revision: 1, archivedAt: null, ...overrides };
}

export function makeMember(overrides: Partial<MembershipDto> & Pick<MembershipDto, 'id' | 'userId' | 'displayName'>): MembershipDto {
  return { workspaceId: WORKSPACE, role: 'member', ...overrides };
}

export const statuses: TaskStatusDto[] = [
  { id: 'status-todo', workspaceId: WORKSPACE, projectId: PROJECT, name: 'К работе', group: 'todo', position: 0, revision: 1 },
  {
    id: 'status-progress',
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    name: 'В работе',
    group: 'in_progress',
    position: 1,
    revision: 1,
  },
];

export function participant(membershipId: string, active = true): TaskDto['participants'][number] {
  return { membershipId, role: 'assignee', active, revision: 1 };
}
