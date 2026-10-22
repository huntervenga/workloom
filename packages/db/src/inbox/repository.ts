import { sql } from 'drizzle-orm';
import type { InboxItemDto } from '@workloom/contracts';
import type { InboxReadRepository } from '@workloom/domain';
import type { WorkloomExecutor } from '../client.js';
import { createTaskRepository } from '../repositories/task-repository.js';

interface Row extends Record<string, unknown> {
  id: string; kind: 'assigned' | 'comment'; at: Date | string; actor_name: string; excerpt: string | null;
  task_id: string; task_title: string; project_id: string; project_name: string;
}

/** Assignments come from the audit trail, comments from the comment table; both are limited to the person's own tasks. */
export function createInboxReadRepository(db: WorkloomExecutor): InboxReadRepository {
  return {
    access: createTaskRepository(db).access,
    async list(workspaceId, membershipId, windowDays, take) {
      if (!Number.isSafeInteger(take) || take < 1 || take > 100) throw new TypeError('The inbox is bounded to 100 items.');
      const rows = await db.execute<Row>(sql`
        with events as (
          select a.id, 'assigned'::text as kind, a.recorded_at as at, a.actor_user_id as actor_user_id, a.entity_id as task_id, null::text as excerpt
          from audit_events a
          where a.workspace_id = ${workspaceId} and a.entity_type = 'task' and a.action in ('created', 'updated')
            and a.recorded_at > now() - make_interval(days => ${windowDays})
            and a.actor_membership_id <> ${membershipId}
            and ((a.action = 'updated' and a.diff -> 'responsibleMembershipId' ->> 'to' = ${membershipId})
              or (a.action = 'created' and a.diff ->> 'responsibleMembershipId' = ${membershipId}))
          union all
          select c.id, 'comment', c.created_at, c.author_user_id, c.task_id, left(c.body, 240)
          from task_comments c
          join tasks t on t.workspace_id = c.workspace_id and t.id = c.task_id
          where c.workspace_id = ${workspaceId} and c.created_at > now() - make_interval(days => ${windowDays})
            and c.author_membership_id <> ${membershipId}
            and (t.responsible_membership_id = ${membershipId}
              or exists (select 1 from task_participants p where p.workspace_id = c.workspace_id and p.task_id = c.task_id and p.membership_id = ${membershipId} and p.active))
        )
        select e.id, e.kind, e.at, u.display_name as actor_name, e.excerpt, t.id as task_id, t.title as task_title, p.id as project_id, p.name as project_name
        from events e
        join tasks t on t.workspace_id = ${workspaceId} and t.id = e.task_id and t.archived_at is null
        join projects p on p.workspace_id = t.workspace_id and p.id = t.project_id and p.archived_at is null
        join users u on u.id = e.actor_user_id
        order by e.at desc, e.id desc
        limit ${take}`);
      return [...rows].map((row): InboxItemDto => ({
        id: row.id, kind: row.kind, at: new Date(row.at).toISOString(), actorName: row.actor_name, excerpt: row.excerpt,
        task: { id: row.task_id, title: row.task_title, projectId: row.project_id, projectName: row.project_name },
      }));
    },
  };
}
