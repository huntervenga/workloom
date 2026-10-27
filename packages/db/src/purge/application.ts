import { sql } from 'drizzle-orm';
import { DomainError, notFoundError, type CommandContext } from '@workloom/domain';
import type { Database, WorkloomExecutor } from '../client.js';
import { createWorkspaceWriteRunner } from '../transactions/workspace-write.js';

export interface PurgeResult {
  /** Rows removed per table, only tables that lost rows. */
  deleted: Readonly<Record<string, number>>;
}

export interface PurgeApplication {
  /** Permanently removes a project, every task homed in it and everything that depends on them. */
  purgeProject(context: CommandContext, projectId: string, input: { confirmName: string }): Promise<PurgeResult>;
  /** Permanently removes a task, its subtasks and everything that depends on them. */
  purgeTask(context: CommandContext, taskId: string, input: { confirmTitle: string }): Promise<PurgeResult>;
}

interface ForeignKey { child: string; parent: string; childCols: string[]; parentCols: string[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const rowsOf = (result: unknown) => result as unknown as Record<string, unknown>[];

/**
 * Hard delete by foreign-key closure. Immutable history tables reject deletes through user triggers, so those
 * triggers are switched off for the tables that lose rows, inside this transaction only (a rollback restores
 * them) and switched back on before it commits. Only the roles allowed to manage members may purge, and every
 * purge leaves a workspace audit event with per-table counts.
 */
async function purge(tx: WorkloomExecutor, root: { table: string; ids: readonly string[] }): Promise<Record<string, number>> {
  const run = async (text: string) => rowsOf(await tx.execute(sql.raw(text)));
  const fks: ForeignKey[] = (await run(`
    select format('%I.%I', cn.nspname, cc.relname) child, format('%I.%I', pn.nspname, pc.relname) parent,
      array(select format('%I', a.attname) from unnest(c.conkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum order by k.ord) "childCols",
      array(select format('%I', a.attname) from unnest(c.confkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum order by k.ord) "parentCols"
    from pg_constraint c join pg_class cc on cc.oid = c.conrelid join pg_namespace cn on cn.oid = cc.relnamespace
      join pg_class pc on pc.oid = c.confrelid join pg_namespace pn on pn.oid = pc.relnamespace
    where c.contype = 'f' and cn.nspname = 'public' and pn.nspname = 'public'`)) as unknown as ForeignKey[];

  const rootTable = `public.${root.table}`; // same spelling as format(%I) yields for these plain names
  const temp = new Map<string, string>(); // table -> temp table holding the ctids of doomed rows
  const tempFor = async (table: string) => {
    let name = temp.get(table);
    if (name === undefined) {
      name = `purge_doomed_${temp.size}`;
      await run(`create temp table ${name} (row_id tid primary key) on commit drop`);
      temp.set(table, name);
    }
    return name;
  };
  const added = async (table: string, selectText: string) => {
    const name = await tempFor(table);
    const result = await run(`with ins as (insert into ${name} ${selectText} on conflict do nothing returning 1) select count(*)::int n from ins`);
    return Number(result[0]?.['n'] ?? 0);
  };

  await added(rootTable, `select ctid from ${rootTable} where id in (${root.ids.map((id) => `'${id}'::uuid`).join(',')})`);
  for (let changed = true; changed;) {
    changed = false;
    for (const fk of fks) {
      const parentTemp = temp.get(fk.parent);
      if (parentTemp === undefined) continue;
      const on = fk.childCols.map((col, i) => `c.${col} = p.${fk.parentCols[i]}`).join(' and ');
      const n = await added(fk.child, `select c.ctid from ${fk.child} c where exists (select 1 from ${fk.parent} p where p.ctid in (select row_id from ${parentTemp}) and ${on})`);
      if (n > 0) changed = true;
    }
  }

  // Tables the closure reached without finding a row take no part.
  const doomed = new Set<string>();
  for (const [table, name] of temp) if (Number((await run(`select count(*)::int n from ${name}`))[0]?.['n'] ?? 0) > 0) doomed.add(table);
  // Mutually referencing tables form one group removed by a single statement (its foreign keys are checked at the
  // end); the groups themselves go children first.
  const parentsOf = (table: string) => fks.filter((fk) => fk.child === table && fk.parent !== table && doomed.has(fk.parent)).map((fk) => fk.parent);
  const index = new Map<string, number>(), low = new Map<string, number>(), onStack = new Set<string>(), stack: string[] = [], groups: string[][] = [];
  let counter = 0;
  const connect = (table: string): void => {
    index.set(table, counter); low.set(table, counter); counter += 1; stack.push(table); onStack.add(table);
    for (const parent of parentsOf(table)) {
      if (!index.has(parent)) { connect(parent); low.set(table, Math.min(low.get(table) ?? 0, low.get(parent) ?? 0)); }
      else if (onStack.has(parent)) low.set(table, Math.min(low.get(table) ?? 0, index.get(parent) ?? 0));
    }
    if (low.get(table) === index.get(table)) {
      const group: string[] = [];
      for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
        onStack.delete(member);
        group.push(member);
        if (member === table) break;
      }
      groups.push(group);
    }
  };
  for (const table of doomed) if (!index.has(table)) connect(table);
  // Tarjan emits a group after every group it references (parents first); deletion needs the reverse.
  groups.reverse();

  // Replay receipts keep the ids of what they created. A later command with the same key (an import run again) would
  // be answered with an entity that no longer exists, so receipts naming a removed project or task go too.
  const removedIds: string[] = [];
  for (const table of ['public.projects', 'public.tasks']) {
    const name = temp.get(table);
    if (name !== undefined) for (const row of await run(`select id::text id from ${table} where ctid in (select row_id from ${name})`)) removedIds.push(String(row['id']));
  }

  // The registry has no FK, so it survives the closure. Record deletion before any rows disappear.
  const attachments = temp.get('public.task_attachments');
  if (attachments !== undefined) await run(`update public.attachment_storage_objects o
    set cleanup_at = case when o.cleanup_at is null then clock_timestamp()
      else greatest(clock_timestamp(), o.write_deadline + interval '5 minutes') end
    where exists (select 1 from public.task_attachments a where a.id = o.id
      and a.ctid in (select row_id from ${attachments}))`);
  const switched: { table: string; trigger: string }[] = [];
  for (const table of doomed) {
    const triggers = await run(`select tgname from pg_trigger where tgrelid = '${table}'::regclass and not tgisinternal and tgenabled = 'O'`);
    for (const row of triggers) switched.push({ table, trigger: String(row['tgname']) });
  }
  for (const { table, trigger } of switched) await run(`alter table ${table} disable trigger ${quote(trigger)}`);
  const counts: Record<string, number> = {};
  for (const group of groups) {
    const ctes = group.map((table, i) => `d${i} as (delete from ${table} where ctid in (select row_id from ${temp.get(table) ?? ''}) returning 1)`).join(', ');
    const picks = group.map((_, i) => `(select count(*)::int from d${i}) n${i}`).join(', ');
    const result = (await run(`with ${ctes} select ${picks}`))[0] ?? {};
    group.forEach((table, i) => { const n = Number(result[`n${i}`] ?? 0); if (n > 0) counts[table.replace(/^public\./, '').replaceAll('"', '')] = n; });
  }
  if (removedIds.length > 0) {
    const result = await run(`with del as (delete from public.command_idempotency where result::text ~ '(${removedIds.join('|')})' returning 1) select count(*)::int n from del`);
    const n = Number(result[0]?.['n'] ?? 0);
    if (n > 0) counts['command_idempotency'] = n;
  }
  // Deferred checks must run now: a table with pending trigger events cannot be altered.
  await run('set constraints all immediate');
  for (const { table, trigger } of switched) await run(`alter table ${table} enable trigger ${quote(trigger)}`);
  return counts;
}

export function createPurgeApplication(source: Database | WorkloomExecutor): PurgeApplication {
  const writer = createWorkspaceWriteRunner(source);
  const mayPurge = (role: string) => role === 'owner' || role === 'admin';

  return {
    purgeProject(context, projectId, input) {
      if (!UUID.test(projectId)) throw new DomainError('VALIDATION_FAILED', 'Invalid project id.');
      const id = projectId.toLowerCase();
      return writer.run(context, 'members.manage', async (scope) => {
        if (!mayPurge(scope.access.membership.role)) throw new DomainError('CAPABILITY_REQUIRED', 'Only an owner or admin can delete a project permanently.');
        const found = rowsOf(await scope.tx.execute(sql`select name from projects where workspace_id = ${context.workspaceId} and id = ${id}`));
        const name = String(found[0]?.['name'] ?? '');
        if (found.length === 0) throw notFoundError();
        if (name !== input.confirmName) throw new DomainError('VALIDATION_FAILED', 'Type the project name exactly to confirm.');
        const deleted = await purge(scope.tx, { table: 'projects', ids: [id] });
        await scope.recordChange({ entityType: 'project', entityId: id, action: 'purged', diff: { name, deleted } });
        return { deleted };
      });
    },
    purgeTask(context, taskId, input) {
      if (!UUID.test(taskId)) throw new DomainError('VALIDATION_FAILED', 'Invalid task id.');
      const id = taskId.toLowerCase();
      return writer.run(context, 'members.manage', async (scope) => {
        if (!mayPurge(scope.access.membership.role)) throw new DomainError('CAPABILITY_REQUIRED', 'Only an owner or admin can delete a task permanently.');
        const found = rowsOf(await scope.tx.execute(sql`select title from tasks where workspace_id = ${context.workspaceId} and id = ${id}`));
        const title = String(found[0]?.['title'] ?? '');
        if (found.length === 0) throw notFoundError();
        if (title !== input.confirmTitle) throw new DomainError('VALIDATION_FAILED', 'Type the task title exactly to confirm.');
        const deleted = await purge(scope.tx, { table: 'tasks', ids: [id] });
        await scope.recordChange({ entityType: 'task', entityId: id, action: 'purged', diff: { title, deleted } });
        return { deleted };
      });
    },
  };
}
