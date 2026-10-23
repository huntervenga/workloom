import { sql } from 'drizzle-orm';
import type { InboxItemDto } from '@workloom/contracts';
import type { InboxReadRepository } from '@workloom/domain';
import type { WorkloomExecutor } from '../client.js';
import { createTaskRepository } from '../repositories/task-repository.js';

interface Row extends Record<string, unknown> {
  id: string; kind: InboxItemDto['kind']; at: Date | string; actor_name: string; excerpt: string | null;
  task_id: string | null; task_title: string | null; project_id: string | null; project_name: string | null;
  leave_id: string | null; leave_status: string | null; leave_start: string | null; leave_end: string | null; leave_person: string | null;
}

/**
 * Assignments come from the audit trail, comments from the comment table, time-off decisions from the audit trail and the
 * approval queue from the requests themselves; everything is limited to what concerns this person.
 */
export function createInboxReadRepository(db: WorkloomExecutor): InboxReadRepository {
  return {
    access: createTaskRepository(db).access,
    async list(workspaceId, membershipId, { windowDays, take, includePendingLeave }) {
      if (!Number.isSafeInteger(take) || take < 1 || take > 100) throw new TypeError('The inbox is bounded to 100 items.');
      const rows = await db.execute<Row>(sql`
        with events as (
          select a.id, 'assigned'::text as kind, a.recorded_at as at, a.actor_user_id as actor_user_id, a.entity_id as task_id, null::text as excerpt,
                 null::uuid as leave_id, null::text as leave_status, null::text as leave_start, null::text as leave_end, null::text as leave_person
          from audit_events a
          where a.workspace_id = ${workspaceId} and a.entity_type = 'task' and a.action in ('created', 'updated')
            and a.recorded_at > now() - make_interval(days => ${windowDays})
            and a.actor_membership_id <> ${membershipId}
            and ((a.action = 'updated' and a.diff -> 'responsibleMembershipId' ->> 'to' = ${membershipId})
              or (a.action = 'created' and a.diff ->> 'responsibleMembershipId' = ${membershipId}))
          union all
          select c.id, 'comment', c.created_at, c.author_user_id, c.task_id, left(c.body, 240), null, null, null, null, null
          from task_comments c
          join tasks t on t.workspace_id = c.workspace_id and t.id = c.task_id
          where c.workspace_id = ${workspaceId} and c.created_at > now() - make_interval(days => ${windowDays})
            and c.author_membership_id <> ${membershipId}
            and not exists (select 1 from task_comment_mentions x where x.comment_id = c.id and x.membership_id = ${membershipId})
            and (t.responsible_membership_id = ${membershipId}
              or exists (select 1 from task_participants p where p.workspace_id = c.workspace_id and p.task_id = c.task_id and p.membership_id = ${membershipId} and p.active))
          union all
          select c.id, 'mention', c.created_at, c.author_user_id, c.task_id, left(c.body, 240), null, null, null, null, null
          from task_comment_mentions x
          join task_comments c on c.id = x.comment_id
          where x.workspace_id = ${workspaceId} and x.membership_id = ${membershipId}
            and c.created_at > now() - make_interval(days => ${windowDays})
            and c.author_membership_id <> ${membershipId}
          union all
          select a.id, 'leave_decided', a.recorded_at, a.actor_user_id, null::uuid, null::text,
                 a.entity_id, a.diff -> 'after' ->> 'status', a.diff -> 'after' ->> 'startDate', a.diff -> 'after' ->> 'endDate', null::text
          from audit_events a
          where a.workspace_id = ${workspaceId} and a.entity_type = 'leave_request' and a.action = 'updated'
            and a.recorded_at > now() - make_interval(days => ${windowDays})
            and a.actor_membership_id <> ${membershipId}
            and a.diff ->> 'membershipId' = ${membershipId}
            and a.diff -> 'after' ->> 'status' in ('approved', 'rejected', 'cancelled')
            and (a.diff -> 'before' ->> 'status') is distinct from (a.diff -> 'after' ->> 'status')
          ${includePendingLeave ? sql`
          union all
          select r.id, 'leave_pending', r.updated_at, mu.id, null::uuid, null::text,
                 r.id, r.snapshot ->> 'status', r.snapshot ->> 'startDate', r.snapshot ->> 'endDate', mu.display_name
          from leave_requests r
          join memberships m on m.workspace_id = r.workspace_id and m.id = r.membership_id
          join users mu on mu.id = m.user_id
          where r.workspace_id = ${workspaceId} and r.snapshot ->> 'status' = 'pending' and r.membership_id <> ${membershipId}` : sql``}
        )
        select e.id, e.kind, e.at, u.display_name as actor_name, e.excerpt,
               t.id as task_id, t.title as task_title, p.id as project_id, p.name as project_name,
               e.leave_id, e.leave_status, e.leave_start, e.leave_end, e.leave_person
        from events e
        join users u on u.id = e.actor_user_id
        left join tasks t on t.workspace_id = ${workspaceId} and t.id = e.task_id
        left join projects p on p.workspace_id = t.workspace_id and p.id = t.project_id
        where (e.task_id is null or (t.id is not null and t.archived_at is null and p.archived_at is null))
        order by e.at desc, e.id desc
        limit ${take}`);
      return [...rows].map((row): InboxItemDto => ({
        id: row.id, kind: row.kind, at: new Date(row.at).toISOString(), actorName: row.actor_name, excerpt: row.excerpt,
        task: row.task_id && row.task_title !== null && row.project_id && row.project_name !== null ? { id: row.task_id, title: row.task_title, projectId: row.project_id, projectName: row.project_name } : null,
        leave: row.leave_id && row.leave_status && row.leave_start && row.leave_end
          ? { requestId: row.leave_id, status: row.leave_status as 'pending' | 'approved' | 'rejected' | 'cancelled', startDate: row.leave_start, endDate: row.leave_end, personName: row.leave_person ?? row.actor_name } : null,
      }));
    },
  };
}
