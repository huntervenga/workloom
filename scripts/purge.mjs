#!/usr/bin/env node
/**
 * Operator command: permanently delete a project (with its tasks) or a single task (with its subtasks).
 * Local databases only. Requires the exact name or title as confirmation. Take a pg_dump first.
 *
 *   node scripts/purge.mjs project --workspace-id UUID --project-id UUID --confirm "Exact project name" [--yes]
 *   node scripts/purge.mjs task    --workspace-id UUID --task-id UUID    --confirm "Exact task title"   [--yes]
 *
 * Without --yes it only prints what would be asked to do.
 */
import { parseArgs } from 'node:util';
import { createDatabase, createPurgeApplication } from '../packages/db/dist/index.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { 'workspace-id': { type: 'string' }, 'project-id': { type: 'string' }, 'task-id': { type: 'string' }, confirm: { type: 'string' }, yes: { type: 'boolean' } },
});
const kind = positionals[0];
const workspaceId = values['workspace-id'];
const targetId = kind === 'project' ? values['project-id'] : values['task-id'];
if (!['project', 'task'].includes(kind ?? '') || !workspaceId || !targetId || values.confirm === undefined) {
  process.stderr.write('Usage: node scripts/purge.mjs project|task --workspace-id UUID --project-id|--task-id UUID --confirm "exact name" [--yes]\n');
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) { process.stderr.write('DATABASE_URL is required.\n'); process.exit(2); }
const db = createDatabase(url, { requireLoopback: true, maxConnections: 2, applicationName: 'workloom-purge' });
try {
  const [owner] = await db.sql`select u.id, u.display_name from memberships m join users u on u.id = m.user_id where m.workspace_id = ${workspaceId} and m.role = 'owner' and m.state = 'active' order by m.created_at limit 1`;
  if (!owner) throw new Error('The workspace has no active owner.');
  if (!values.yes) { process.stdout.write(`Would permanently delete the ${kind} ${targetId} as owner ${owner.display_name}. Re-run with --yes.\n`); process.exit(0); }
  const context = { workspaceId, actor: { userId: owner.id, displayName: owner.display_name, kind: 'real' }, source: 'job', requestId: `purge-${Date.now()}`, idempotencyKey: `purge-${targetId}` };
  const app = createPurgeApplication(db);
  const result = kind === 'project' ? await app.purgeProject(context, targetId, { confirmName: values.confirm }) : await app.purgeTask(context, targetId, { confirmTitle: values.confirm });
  process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
} finally { await db.close(); }
