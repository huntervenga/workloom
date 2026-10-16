import { randomUUID } from 'node:crypto';

import type { PlanningPeriodDto, ProjectDto, TaskDto } from '@workloom/contracts';
import { FIXTURE_MEMBERSHIP_IDS, FIXTURE_USER_IDS, FIXTURE_WORKSPACE_IDS } from '@workloom/db/fixtures';

import { startApi, type ApiProcess } from './api-process.js';
import { migrateAndSeed } from './db-cli.js';
import { statusInGroup, uniqueName } from './p1a.js';
import { P2aClient } from './p2a.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.js';

export const TEAM = FIXTURE_WORKSPACE_IDS.team;
export const OUTSIDE = FIXTURE_WORKSPACE_IDS.outside;
export const MEMBERS = FIXTURE_MEMBERSHIP_IDS;
export const USERS = FIXTURE_USER_IDS;

export interface PlanningHarness {
  readonly db: ThrowawayDatabase;
  readonly owner: P2aClient;
  readonly replica: P2aClient;
  readonly member: P2aClient;
  readonly viewer: P2aClient;
  readonly outsider: P2aClient;
  close(): Promise<void>;
}

export async function planningHarness(label: string): Promise<PlanningHarness> {
  const db = await createThrowawayDatabase(label);
  const processes: ApiProcess[] = [];
  try {
    await migrateAndSeed(db.url);
    const started = await Promise.allSettled([USERS.owner, USERS.owner, USERS.memberA, USERS.viewer, USERS.outsider].map(async (actorId) => {
      const api = await startApi({ entry: 'source', databaseUrl: db.url, env: { DEV_ACTOR_ID: actorId } });
      processes.push(api);
      return api;
    }));
    for (const item of started) if (item.status === 'rejected') throw item.reason;
    const [owner, replica, member, viewer, outsider] = started.flatMap((item) => item.status === 'fulfilled' ? [item.value] : []);
    if (!owner || !replica || !member || !viewer || !outsider) throw new Error('Planning test API processes did not start.');
    return {
      db, owner: new P2aClient(owner, TEAM), replica: new P2aClient(replica, TEAM),
      member: new P2aClient(member, TEAM), viewer: new P2aClient(viewer, TEAM), outsider: new P2aClient(outsider, OUTSIDE),
      async close() { await Promise.all(processes.map((api) => api.stop())); await db.drop(); },
    };
  } catch (error) {
    await Promise.all(processes.map((api) => api.stop()));
    await db.drop();
    throw error;
  }
}

export async function planningProject(client: P2aClient, label: string) {
  const project = await client.tasks.createProject(uniqueName(label));
  const statuses = await client.tasks.listStatuses(project.id);
  const todo = statusInGroup(statuses, 'todo');
  return { project, todo, done: statusInGroup(statuses, 'done') };
}

export async function planningTask(client: P2aClient, project: ProjectDto, estimateMinutes: number | null = 480, title = uniqueName('Плановая работа')) {
  const statuses = await client.tasks.listStatuses(project.id);
  return client.tasks.createTask({
    projectId: project.id, statusId: statusInGroup(statuses, 'todo').id, title, estimateMinutes,
    participantMembershipIds: client.workspaceId === OUTSIDE ? [MEMBERS.outsideOwner] : [MEMBERS.teamOwner, MEMBERS.teamMemberA],
  });
}

export async function period(client: P2aClient, projectId: string, overrides: { protectEstimate?: boolean; protectedFieldIds?: string[]; cutoffAt?: string; localStart?: string } = {}) {
  const monday = new Date();
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return client.createPeriod({
    projectId, name: uniqueName('Неделя'), localStart: monday.toISOString().slice(0, 10), timezone: 'Asia/Nicosia',
    cutoffAt: new Date(Date.now() + 3_600_000).toISOString(), ...overrides,
  });
}

export async function commit(client: P2aClient, planningPeriod: PlanningPeriodDto, task: TaskDto, minutes: number | null, membershipId: string = MEMBERS.teamOwner) {
  return client.createCommitment(planningPeriod.id, {
    workPackageId: task.workPackageId, membershipId, expectedAbsent: true, plannedMinutes: minutes,
    allocations: minutes === null ? [] : [{ taskId: task.id, minutes }],
  });
}

export function freshKey(): string { return randomUUID(); }
