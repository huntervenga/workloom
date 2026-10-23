import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import { taskActivityKindSchema, type TaskCommentDto } from '@workloom/contracts';
import type { TaskCommentsRepository } from '@workloom/domain';
import type { WorkloomExecutor } from '../client.js';
import { auditEvents, memberships, projects, taskCommentMentions, taskComments, tasks, users } from '../schema.js';
import { createTaskRepository } from '../repositories/task-repository.js';
import { listTimeline, safeAvatarUrl } from './timeline.js';
const bounded = (take: number) => { if (!Number.isSafeInteger(take) || take < 1 || take > 101) throw new TypeError('Task timeline pages are bounded to 101 read rows.'); };
/** Explicit public projection: activity never SELECTs diff/reason/credentials/raw event payload. */
export function createTaskCommentsRepository(db: WorkloomExecutor): TaskCommentsRepository {
  const taskRepository = createTaskRepository(db);
  return {
    access: taskRepository.access, permissionEpoch: taskRepository.permissionEpoch,
    findIdempotency: taskRepository.findIdempotency, insertIdempotency: taskRepository.insertIdempotency,
    async findTarget(workspaceId, taskId) {
      const [row] = await db.select({ id: tasks.id, projectId: tasks.projectId, visibility: tasks.visibility, archivedAt: tasks.archivedAt, projectArchivedAt: projects.archivedAt }).from(tasks).innerJoin(projects, and(eq(projects.workspaceId, tasks.workspaceId), eq(projects.id, tasks.projectId))).where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId))).limit(1);
      return row ? { ...row, archivedAt: row.archivedAt?.toISOString() ?? null, projectArchivedAt: row.projectArchivedAt?.toISOString() ?? null } : null;
    },
    async listComments(workspaceId, taskId, after, take) {
      bounded(take);
      const rows = await db.select({ comment: taskComments, avatarUrl: users.avatarUrl }).from(taskComments).leftJoin(users, eq(users.id, taskComments.authorUserId)).where(and(eq(taskComments.workspaceId, workspaceId), eq(taskComments.taskId, taskId), after ? or(lt(taskComments.createdAt, new Date(after.createdAt)), and(eq(taskComments.createdAt, new Date(after.createdAt)), lt(taskComments.id, after.id))) : undefined)).orderBy(desc(taskComments.createdAt), desc(taskComments.id)).limit(take);
      // Current author avatar, HTTPS-only per the contract policy; never stored with the comment.
      return rows.map(({ comment, avatarUrl }): TaskCommentDto => ({ ...comment, createdAt: comment.createdAt.toISOString(), authorAvatarUrl: safeAvatarUrl(avatarUrl) }));
    },
    listTimeline(workspaceId, taskId, after, take) { return listTimeline(db, workspaceId, taskId, after, take); },
    async listActivity(workspaceId, taskId, after, take) {
      bounded(take);
      const rows = await db.select({ id: auditEvents.id, workspaceId: auditEvents.workspaceId, taskId: auditEvents.entityId, action: auditEvents.action, actorUserId: auditEvents.actorUserId, actorMembershipId: auditEvents.actorMembershipId, actorDisplayName: users.displayName, occurredAt: auditEvents.recordedAt, changeSeq: auditEvents.changeSeq, eventOrdinal: auditEvents.eventOrdinal })
        .from(auditEvents)
        .innerJoin(memberships, and(eq(memberships.workspaceId, auditEvents.workspaceId), eq(memberships.id, auditEvents.actorMembershipId), eq(memberships.userId, auditEvents.actorUserId)))
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(auditEvents.workspaceId, workspaceId), eq(auditEvents.entityType, 'task'), eq(auditEvents.entityId, taskId), inArray(auditEvents.action, taskActivityKindSchema.options), after ? or(lt(auditEvents.changeSeq, BigInt(after.changeSeq)), and(eq(auditEvents.changeSeq, BigInt(after.changeSeq)), lt(auditEvents.eventOrdinal, after.eventOrdinal))) : undefined))
        .orderBy(desc(auditEvents.changeSeq), desc(auditEvents.eventOrdinal)).limit(take);
      return rows.map(({ action, ...row }) => ({ ...row, kind: taskActivityKindSchema.parse(action), occurredAt: row.occurredAt.toISOString(), changeSeq: row.changeSeq.toString() }));
    },
    async insertComment({ authorAvatarUrl: _avatar, ...comment }) { await db.insert(taskComments).values({ ...comment, createdAt: new Date(comment.createdAt) }); },
    async insertMentions(workspaceId, commentId, membershipIds, createdAt) {
      const people = await db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.state, 'active'), inArray(memberships.id, [...membershipIds])));
      if (people.length > 0) await db.insert(taskCommentMentions).values(people.map(person => ({ workspaceId, commentId, membershipId: person.id, createdAt: new Date(createdAt) }))).onConflictDoNothing();
    },
  };
}
