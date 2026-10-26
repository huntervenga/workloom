import { and, asc, desc, eq, exists, gt, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { projectRulesSchema, taskDefaultsSchema, type ProjectDto, type SectionDto, type TagDto, type TaskDto, type TaskParticipantDto, type TaskStatusDto } from '@workloom/contracts';
import {
  DomainError,
  notFoundError,
  type IdempotencyRecord,
  type TaskRepository,
  type WorkPackageRecord,
} from '@workloom/domain';

import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import {
  meetings,
  commandIdempotency,
  projects,
  projectRules,
  projectTaskDefaults,
  sections,
  taskParticipants,
  taskStatuses,
  taskTags,
  tasks,
  workPackages,
  workspaceTags,
  workspaces,
} from '../schema.js';
import { createAccessRepository } from './access-repository.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAG_NAME_UNIQUE_CONSTRAINT = 'workspace_tags_workspace_name_unique_idx';
/** Keeps `IN (…)` lists far below the protocol's 65 535 bind-parameter limit. */
const ID_CHUNK_SIZE = 1000;

/** Malformed IDs cannot match any row; answering "absent" avoids a database cast error. */
function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function chunks<T>(values: readonly T[], size = ID_CHUNK_SIZE): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    result.push(values.slice(start, start + size));
  }
  return result;
}

function toIso(value: Date): string {
  return value.toISOString();
}

function toIsoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toDateOrNull(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

/** `%`, `_` and `\` in user search text are literals, not LIKE wildcards. */
function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

function isTagNameConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === 'object' && current !== null; depth += 1) {
    const record = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (record.code === '23505' && record.constraint_name === TAG_NAME_UNIQUE_CONSTRAINT) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

/** Archived tag names stay reserved, so the message must not imply the name is visible. */
function tagNameTakenError(): DomainError {
  return new DomainError('DOMAIN_VALIDATION_FAILED', 'This tag name is already used in the workspace.', {
    details: { fields: ['name'] },
  });
}

async function withTagNameGuard(write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (error) {
    if (isTagNameConflict(error)) {
      throw tagNameTakenError();
    }
    throw error;
  }
}

function assertUpdated(rows: readonly unknown[]): void {
  if (rows.length === 0) {
    throw notFoundError();
  }
}

function toProject(row: typeof projects.$inferSelect): ProjectDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    ...(row.dateRangeFrom===null||row.dateRangeTo===null?{}:{dateRange:{from:row.dateRangeFrom,to:row.dateRangeTo}}),
    revision: row.revision,
    archivedAt: toIsoOrNull(row.archivedAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function toSection(row: typeof sections.$inferSelect): SectionDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    name: row.name,
    position: row.position,
    revision: row.revision,
    archivedAt: toIsoOrNull(row.archivedAt),
  };
}

function toStatus(row: typeof taskStatuses.$inferSelect): TaskStatusDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    name: row.name,
    group: row.group,
    position: row.position,
    revision: row.revision,
  };
}

function toTag(row: typeof workspaceTags.$inferSelect): TagDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    color: row.color,
    revision: row.revision,
    archivedAt: toIsoOrNull(row.archivedAt),
  };
}

function toWorkPackage(row: typeof workPackages.$inferSelect): WorkPackageRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    origin: row.origin,
    sourcePackageId: row.sourcePackageId,
    estimateMinutes: row.estimateMinutes,
    revision: row.revision,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

/** Task columns plus the current budget and revision of its work package (1:1 join). */
const taskColumns = {
  id: tasks.id,
  workspaceId: tasks.workspaceId,
  projectId: tasks.projectId,
  sectionId: tasks.sectionId,
  parentTaskId: tasks.parentTaskId,
  workPackageId: tasks.workPackageId,
  workPackageRevision: workPackages.revision,
  title: tasks.title,
  description: tasks.description,
  statusId: tasks.statusId,
  responsibleMembershipId: tasks.responsibleMembershipId,
  participantsRevision: tasks.participantsRevision,
  startDate: tasks.startDate,
  dueDate: tasks.dueDate,
  priority: tasks.priority,
  estimateMinutes: workPackages.estimateMinutes,
  revision: tasks.revision,
  position: tasks.position,
  visibility: tasks.visibility,
  archivedAt: tasks.archivedAt,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
};

/** Task row columns written by insertTaskCore; never the projection's joined values. */
function taskCoreValues(row: TaskDto) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    sectionId: row.sectionId,
    parentTaskId: row.parentTaskId,
    workPackageId: row.workPackageId,
    title: row.title,
    description: row.description,
    statusId: row.statusId,
    responsibleMembershipId: row.responsibleMembershipId,
    participantsRevision: row.participantsRevision,
    startDate: row.startDate ?? null,
    dueDate: row.dueDate,
    priority: row.priority,
    revision: row.revision,
    position: row.position,
    visibility: row.visibility,
    archivedAt: toDateOrNull(row.archivedAt),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

/**
 * Drizzle implementation of the domain TaskRepository: straight queries, projection and
 * persistence, no business rules. Every predicate names the workspace explicitly. Pass a
 * transaction so that reads and writes of one command share the workspace barrier.
 */
export function createTaskRepository(source: Database | WorkloomExecutor): TaskRepository {
  const db: WorkloomExecutor = isDatabase(source) ? source.db : source;

  function selectTasks() {
    return db
      .select(taskColumns)
      .from(tasks)
      .innerJoin(
        workPackages,
        and(
          eq(workPackages.workspaceId, tasks.workspaceId),
          eq(workPackages.projectId, tasks.projectId),
          eq(workPackages.id, tasks.workPackageId),
        ),
      );
  }

  type TaskRow = Awaited<ReturnType<typeof selectTasks>>[number];

  /** Batch-loads participants (active and inactive) and tags; two queries per chunk, not per task. */
  async function projectTasks(workspaceId: string, rows: readonly TaskRow[]): Promise<TaskDto[]> {
    const participantsByTask = new Map<string, TaskParticipantDto[]>();
    const tagsByTask = new Map<string, TagDto[]>();
    const meetingsByTask=new Map<string,string>();

    for (const ids of chunks(rows.map((row) => row.id))) {
      const meetingRows=await db.select({id:meetings.id,taskId:meetings.taskId}).from(meetings).where(and(eq(meetings.workspaceId,workspaceId),inArray(meetings.taskId,ids)));
      for(const m of meetingRows)meetingsByTask.set(m.taskId,m.id);
      const participantRows = await db
        .select({
          taskId: taskParticipants.taskId,
          membershipId: taskParticipants.membershipId,
          role: taskParticipants.role,
          active: taskParticipants.active,
          revision: taskParticipants.revision,
        })
        .from(taskParticipants)
        .where(and(eq(taskParticipants.workspaceId, workspaceId), inArray(taskParticipants.taskId, ids)))
        .orderBy(asc(taskParticipants.taskId), asc(taskParticipants.createdAt), asc(taskParticipants.membershipId));
      for (const { taskId, ...participant } of participantRows) {
        const list = participantsByTask.get(taskId) ?? [];
        list.push(participant);
        participantsByTask.set(taskId, list);
      }

      const tagRows = await db
        .select({ taskId: taskTags.taskId, tag: workspaceTags })
        .from(taskTags)
        .innerJoin(
          workspaceTags,
          and(eq(workspaceTags.workspaceId, taskTags.workspaceId), eq(workspaceTags.id, taskTags.tagId)),
        )
        .where(and(eq(taskTags.workspaceId, workspaceId), inArray(taskTags.taskId, ids)))
        .orderBy(asc(taskTags.taskId), asc(workspaceTags.name), asc(workspaceTags.id));
      for (const { taskId, tag } of tagRows) {
        const list = tagsByTask.get(taskId) ?? [];
        list.push(toTag(tag));
        tagsByTask.set(taskId, list);
      }
    }

    return rows.map((row) => ({
      id: row.id,
      meetingId:meetingsByTask.get(row.id)??null,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      sectionId: row.sectionId,
      parentTaskId: row.parentTaskId,
      workPackageId: row.workPackageId,
      workPackageRevision: row.workPackageRevision,
      title: row.title,
      description: row.description,
      statusId: row.statusId,
      responsibleMembershipId: row.responsibleMembershipId,
      participants: participantsByTask.get(row.id) ?? [],
      participantsRevision: row.participantsRevision,
      startDate: row.startDate ?? null,
      dueDate: row.dueDate,
      priority: row.priority,
      tags: tagsByTask.get(row.id) ?? [],
      estimateMinutes: row.estimateMinutes,
      revision: row.revision,
      position: row.position,
      visibility: row.visibility,
      archivedAt: toIsoOrNull(row.archivedAt),
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    }));
  }

  return {
    access: createAccessRepository(db),

    async permissionEpoch(workspaceId) {
      if (!isUuid(workspaceId)) {
        throw notFoundError();
      }
      const [row] = await db
        .select({ permissionEpoch: workspaces.permissionEpoch })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      if (row === undefined) {
        throw notFoundError();
      }
      return row.permissionEpoch.toString();
    },

    async findProjectRules(workspaceId, projectId) {
      if (!isUuid(workspaceId) || !isUuid(projectId)) return null;
      const [row] = await db.select().from(projectRules)
        .where(and(eq(projectRules.workspaceId, workspaceId), eq(projectRules.projectId, projectId))).limit(1);
      return row ? projectRulesSchema.parse({ workspaceId: row.workspaceId, projectId: row.projectId, revision: row.revision, config: row.config }) : null;
    },

    async findWorkspaceTimezone(workspaceId) {
      if (!isUuid(workspaceId)) return null;
      const [row] = await db.select({ timezone: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
      return row?.timezone ?? null;
    },

    async findTaskAbove(workspaceId, place) {
      if (!isUuid(workspaceId) || !isUuid(place.projectId)) return null;
      const siblings = and(
        eq(tasks.workspaceId, workspaceId), eq(tasks.projectId, place.projectId), isNull(tasks.archivedAt),
        place.sectionId === null ? isNull(tasks.sectionId) : eq(tasks.sectionId, place.sectionId),
        place.parentTaskId === null ? isNull(tasks.parentTaskId) : eq(tasks.parentTaskId, place.parentTaskId),
      );
      let id: string | undefined;
      if (place.insertion) {
        const anchorId = place.insertion.anchorTaskId;
        if (!isUuid(anchorId)) return null;
        const [anchor] = await db.select({ id: tasks.id, position: tasks.position }).from(tasks).where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, anchorId))).limit(1);
        if (!anchor) return null;
        if (place.insertion.placement === 'after') id = anchor.id;
        else {
          const [before] = await db.select({ id: tasks.id }).from(tasks)
            .where(and(siblings, or(sql`${tasks.position} < ${anchor.position}`, and(eq(tasks.position, anchor.position), sql`${tasks.id} < ${anchor.id}`))))
            .orderBy(desc(tasks.position), desc(tasks.id)).limit(1);
          id = before?.id;
        }
      } else {
        const [last] = await db.select({ id: tasks.id }).from(tasks).where(siblings).orderBy(desc(tasks.position), desc(tasks.id)).limit(1);
        id = last?.id;
      }
      if (id === undefined) return null;
      const rows = await selectTasks().where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, id))).limit(1);
      const [found] = await projectTasks(workspaceId, rows);
      return found ?? null;
    },

    async findTaskDefaults(workspaceId, projectId) {
      if (!isUuid(workspaceId) || !isUuid(projectId)) return null;
      const [row] = await db.select().from(projectTaskDefaults)
        .where(and(eq(projectTaskDefaults.workspaceId, workspaceId), eq(projectTaskDefaults.projectId, projectId))).limit(1);
      return row ? taskDefaultsSchema.parse({ workspaceId: row.workspaceId, projectId: row.projectId, revision: row.revision, config: row.config }) : null;
    },

    async findProject(workspaceId, projectId) {
      if (!isUuid(workspaceId) || !isUuid(projectId)) {
        return null;
      }
      const [row] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId)))
        .limit(1);
      return row === undefined ? null : toProject(row);
    },

    async listProjects(workspaceId, includeArchived = false) {
      if (!isUuid(workspaceId)) {
        return [];
      }
      const rows = await db
        .select()
        .from(projects)
        .where(and(eq(projects.workspaceId, workspaceId), includeArchived ? undefined : isNull(projects.archivedAt)))
        .orderBy(asc(projects.name), asc(projects.id));
      return rows.map(toProject);
    },

    async insertProject(row) {
      await db.insert(projects).values({
        id: row.id,
        workspaceId: row.workspaceId,
        name: row.name,
        revision: row.revision,
        archivedAt: toDateOrNull(row.archivedAt),
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      });
    },

    async saveProject(row) {
      const updated = await db
        .update(projects)
        .set({
          name: row.name,
          dateRangeFrom:row.dateRange?.from??null,
          dateRangeTo:row.dateRange?.to??null,
          revision: row.revision,
          archivedAt: toDateOrNull(row.archivedAt),
          updatedAt: new Date(row.updatedAt),
        })
        .where(and(eq(projects.workspaceId, row.workspaceId), eq(projects.id, row.id)))
        .returning({ id: projects.id });
      assertUpdated(updated);
    },

    async findSection(workspaceId, sectionId) {
      if (!isUuid(workspaceId) || !isUuid(sectionId)) {
        return null;
      }
      const [row] = await db
        .select()
        .from(sections)
        .where(and(eq(sections.workspaceId, workspaceId), eq(sections.id, sectionId)))
        .limit(1);
      return row === undefined ? null : toSection(row);
    },

    async listSections(workspaceId, projectId) {
      if (!isUuid(workspaceId) || !isUuid(projectId)) {
        return [];
      }
      const rows = await db
        .select()
        .from(sections)
        .where(
          and(eq(sections.workspaceId, workspaceId), eq(sections.projectId, projectId), isNull(sections.archivedAt)),
        )
        .orderBy(asc(sections.position), asc(sections.id));
      return rows.map(toSection);
    },

    async insertSection(row) {
      await db.insert(sections).values({
        id: row.id,
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        name: row.name,
        position: row.position,
        revision: row.revision,
        archivedAt: toDateOrNull(row.archivedAt),
      });
    },

    async saveSection(row) {
      const updated = await db
        .update(sections)
        .set({
          name: row.name,
          position: row.position,
          revision: row.revision,
          archivedAt: toDateOrNull(row.archivedAt),
        })
        .where(
          and(eq(sections.workspaceId, row.workspaceId), eq(sections.projectId, row.projectId), eq(sections.id, row.id)),
        )
        .returning({ id: sections.id });
      assertUpdated(updated);
    },

    async findStatus(workspaceId, statusId) {
      if (!isUuid(workspaceId) || !isUuid(statusId)) {
        return null;
      }
      const [row] = await db
        .select()
        .from(taskStatuses)
        .where(and(eq(taskStatuses.workspaceId, workspaceId), eq(taskStatuses.id, statusId)))
        .limit(1);
      return row === undefined ? null : toStatus(row);
    },

    async listStatuses(workspaceId, projectId) {
      if (!isUuid(workspaceId) || !isUuid(projectId)) {
        return [];
      }
      const rows = await db
        .select()
        .from(taskStatuses)
        .where(and(eq(taskStatuses.workspaceId, workspaceId), eq(taskStatuses.projectId, projectId)))
        .orderBy(asc(taskStatuses.position), asc(taskStatuses.id));
      return rows.map(toStatus);
    },

    async insertStatus(row) {
      await db.insert(taskStatuses).values({
        id: row.id,
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        name: row.name,
        group: row.group,
        position: row.position,
        revision: row.revision,
      });
    },

    async findTag(workspaceId, tagId) {
      if (!isUuid(workspaceId) || !isUuid(tagId)) {
        return null;
      }
      // Archived tags included: tasks and history keep showing them.
      const [row] = await db
        .select()
        .from(workspaceTags)
        .where(and(eq(workspaceTags.workspaceId, workspaceId), eq(workspaceTags.id, tagId)))
        .limit(1);
      return row === undefined ? null : toTag(row);
    },

    async listTags(workspaceId, includeArchived = false) {
      if (!isUuid(workspaceId)) {
        return [];
      }
      const rows = await db
        .select()
        .from(workspaceTags)
        .where(and(eq(workspaceTags.workspaceId, workspaceId), includeArchived ? undefined : isNull(workspaceTags.archivedAt)))
        .orderBy(asc(workspaceTags.name), asc(workspaceTags.id));
      return rows.map(toTag);
    },

    async insertTag(row) {
      await withTagNameGuard(() =>
        db.insert(workspaceTags).values({
          id: row.id,
          workspaceId: row.workspaceId,
          name: row.name,
          color: row.color,
          revision: row.revision,
          archivedAt: toDateOrNull(row.archivedAt),
        }),
      );
    },

    async saveTag(row) {
      await withTagNameGuard(async () => {
        const updated = await db
          .update(workspaceTags)
          .set({
            name: row.name,
            color: row.color,
            revision: row.revision,
            archivedAt: toDateOrNull(row.archivedAt),
          })
          .where(and(eq(workspaceTags.workspaceId, row.workspaceId), eq(workspaceTags.id, row.id)))
          .returning({ id: workspaceTags.id });
        assertUpdated(updated);
      });
    },

    async findWorkPackage(workspaceId, workPackageId) {
      if (!isUuid(workspaceId) || !isUuid(workPackageId)) {
        return null;
      }
      const [row] = await db
        .select()
        .from(workPackages)
        .where(and(eq(workPackages.workspaceId, workspaceId), eq(workPackages.id, workPackageId)))
        .limit(1);
      return row === undefined ? null : toWorkPackage(row);
    },

    async insertWorkPackage(row) {
      await db.insert(workPackages).values({
        id: row.id,
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        origin: row.origin,
        sourcePackageId: row.sourcePackageId,
        estimateMinutes: row.estimateMinutes,
        revision: row.revision,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      });
    },

    async saveWorkPackage(row) {
      // Provenance (origin, source package) is fixed at creation.
      const updated = await db
        .update(workPackages)
        .set({
          estimateMinutes: row.estimateMinutes,
          revision: row.revision,
          updatedAt: new Date(row.updatedAt),
        })
        .where(
          and(
            eq(workPackages.workspaceId, row.workspaceId),
            eq(workPackages.projectId, row.projectId),
            eq(workPackages.id, row.id),
          ),
        )
        .returning({ id: workPackages.id });
      assertUpdated(updated);
    },

    async findTasksByIds(ws,ids) {
      const result:TaskDto[]=[];
      for(const batch of chunks(ids)){const rows=await selectTasks().where(and(eq(tasks.workspaceId,ws),inArray(tasks.id,batch)));result.push(...await projectTasks(ws,rows));}
      return result;
    },
    async findTask(workspaceId, taskId) {
      if (!isUuid(workspaceId) || !isUuid(taskId)) {
        return null;
      }
      const rows = await selectTasks()
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId)))
        .limit(1);
      const [task] = await projectTasks(workspaceId, rows);
      return task ?? null;
    },

    async listTasks(workspaceId, input, after, take) {
      if (!Number.isSafeInteger(take) || take < 0) {
        throw new TypeError('listTasks needs a non-negative integer take.');
      }
      const filterIds = [input.projectId, input.sectionId, input.statusId, input.participantMembershipId, input.tagId];
      if (take === 0 || !isUuid(workspaceId) || filterIds.some((id) => id !== undefined && !isUuid(id))) {
        return [];
      }

      const conditions: (SQL | undefined)[] = [
        eq(tasks.workspaceId, workspaceId),
        eq(tasks.projectId, input.projectId),
      ];
      if (input.sectionId !== undefined) {
        conditions.push(eq(tasks.sectionId, input.sectionId));
      }
      if (input.statusId !== undefined) {
        conditions.push(eq(tasks.statusId, input.statusId));
      }
      if (input.participantMembershipId !== undefined) {
        conditions.push(
          exists(
            db
              .select({ one: sql`1` })
              .from(taskParticipants)
              .where(
                and(
                  eq(taskParticipants.workspaceId, tasks.workspaceId),
                  eq(taskParticipants.taskId, tasks.id),
                  eq(taskParticipants.membershipId, input.participantMembershipId),
                  eq(taskParticipants.active, true),
                ),
              ),
          ),
        );
      }
      if (input.tagId !== undefined) {
        conditions.push(
          exists(
            db
              .select({ one: sql`1` })
              .from(taskTags)
              .where(
                and(
                  eq(taskTags.workspaceId, tasks.workspaceId),
                  eq(taskTags.taskId, tasks.id),
                  eq(taskTags.tagId, input.tagId),
                ),
              ),
          ),
        );
      }
      if (input.completion !== undefined) {
        if (input.completion !== 'open') throw new TypeError('listTasks got an unsupported completion filter.');
        // Status group decides completion, so custom statuses follow their group; no client filtering.
        conditions.push(
          exists(
            db
              .select({ one: sql`1` })
              .from(taskStatuses)
              .where(
                and(
                  eq(taskStatuses.workspaceId, tasks.workspaceId),
                  eq(taskStatuses.projectId, tasks.projectId),
                  eq(taskStatuses.id, tasks.statusId),
                  inArray(taskStatuses.group, ['todo', 'in_progress']),
                ),
              ),
          ),
        );
      }
      if (input.search !== undefined && input.search !== '') {
        const pattern = likeContains(input.search);
        conditions.push(
          or(sql`${tasks.title} ilike ${pattern} escape '\\'`, sql`${tasks.description} ilike ${pattern} escape '\\'`),
        );
      }
      if (input.includeArchived !== true) {
        conditions.push(isNull(tasks.archivedAt));
      }
      const dueOrder = input.sort === 'due_asc';
      if (after !== null) {
        if (dueOrder !== ('dueDate' in after)) throw new TypeError('Task cursor anchor does not match its ordering.');
        conditions.push('dueDate' in after
          ? after.dueDate === null
            ? and(isNull(tasks.dueDate), gt(tasks.id, after.id))
            : or(gt(tasks.dueDate, after.dueDate), isNull(tasks.dueDate), and(eq(tasks.dueDate, after.dueDate), gt(tasks.id, after.id)))
          : or(gt(tasks.position, after.position), and(eq(tasks.position, after.position), gt(tasks.id, after.id))));
      }

      const rows = await selectTasks()
        .where(and(...conditions))
        .orderBy(...(dueOrder ? [sql`${tasks.dueDate} asc nulls last`, asc(tasks.id)] : [asc(tasks.position), asc(tasks.id)]))
        .limit(take);
      return projectTasks(workspaceId, rows);
    },

    async insertTaskCore(row) {
      await db.insert(tasks).values(taskCoreValues(row));
    },

    async saveTaskCore(row) {
      // Ownership, project, work package and creation time are immutable here.
      const updated = await db
        .update(tasks)
        .set({
          sectionId: row.sectionId,
          parentTaskId: row.parentTaskId,
          title: row.title,
          description: row.description,
          statusId: row.statusId,
          responsibleMembershipId: row.responsibleMembershipId,
          participantsRevision: row.participantsRevision,
          startDate: row.startDate ?? null,
      dueDate: row.dueDate,
          priority: row.priority,
          revision: row.revision,
          position: row.position,
          archivedAt: toDateOrNull(row.archivedAt),
          updatedAt: new Date(row.updatedAt),
        })
        .where(and(eq(tasks.workspaceId, row.workspaceId), eq(tasks.projectId, row.projectId), eq(tasks.id, row.id)))
        .returning({ id: tasks.id });
      assertUpdated(updated);
    },

    async saveParticipants(workspaceId, taskId, rows, at) {
      const timestamp = new Date(at);
      for (const batch of chunks(rows)) {
        await db
          .insert(taskParticipants)
          .values(
            batch.map((row) => ({
              workspaceId,
              taskId,
              membershipId: row.membershipId,
              role: row.role,
              active: row.active,
              revision: row.revision,
              createdAt: timestamp,
              updatedAt: timestamp,
            })),
          )
          .onConflictDoUpdate({
            target: [taskParticipants.workspaceId, taskParticipants.taskId, taskParticipants.membershipId],
            // created_at is kept; unchanged rows keep their updated_at.
            set: {
              role: sql`excluded.role`,
              active: sql`excluded.active`,
              revision: sql`excluded.revision`,
              updatedAt: sql`excluded.updated_at`,
            },
            setWhere: sql`(${taskParticipants.role}, ${taskParticipants.active}, ${taskParticipants.revision})
              is distinct from (excluded.role, excluded.active, excluded.revision)`,
          });
      }
    },

    async setTaskTagIds(workspaceId, taskId, tagIds) {
      const ids = [...new Set(tagIds)];
      await db
        .delete(taskTags)
        .where(
          and(
            eq(taskTags.workspaceId, workspaceId),
            eq(taskTags.taskId, taskId),
            ids.length === 0 ? undefined : notInArray(taskTags.tagId, ids),
          ),
        );
      for (const batch of chunks(ids)) {
        await db
          .insert(taskTags)
          .values(batch.map((tagId) => ({ workspaceId, taskId, tagId })))
          .onConflictDoNothing({ target: [taskTags.workspaceId, taskTags.taskId, taskTags.tagId] });
      }
    },

    async findIdempotency(workspaceId, actorUserId, command, idempotencyKey): Promise<IdempotencyRecord | null> {
      if (!isUuid(workspaceId) || !isUuid(actorUserId)) {
        return null;
      }
      const [row] = await db
        .select()
        .from(commandIdempotency)
        .where(
          and(
            eq(commandIdempotency.workspaceId, workspaceId),
            eq(commandIdempotency.actorUserId, actorUserId),
            eq(commandIdempotency.command, command),
            eq(commandIdempotency.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (row === undefined) {
        return null;
      }
      return {
        workspaceId: row.workspaceId,
        actorUserId: row.actorUserId,
        command: row.command,
        idempotencyKey: row.idempotencyKey,
        payloadHash: row.payloadHash,
        result: row.result,
        createdAt: toIso(row.createdAt),
      };
    },

    async insertIdempotency(row) {
      await db.insert(commandIdempotency).values({
        workspaceId: row.workspaceId,
        actorUserId: row.actorUserId,
        command: row.command,
        idempotencyKey: row.idempotencyKey,
        payloadHash: row.payloadHash,
        result: row.result,
        createdAt: new Date(row.createdAt),
      });
    },
  };
}
