#!/usr/bin/env node
/**
 * Operator command: copy one project's sums, planning checks and new-task defaults onto other projects of the same
 * workspace (fields and sections are matched by name). Local databases only; on a hosted instance use the
 * "Copy settings to other projects" button of the source project. Take a pg_dump first.
 *
 *   node scripts/apply-settings.mjs --workspace-id UUID --source UUID --targets UUID,UUID,... [--replace] [--yes]
 *   node scripts/apply-settings.mjs --workspace-id UUID --source UUID --all [--replace] [--yes]
 *
 * Without --yes it only lists the targets.
 */
import { parseArgs } from 'node:util';
import { createDatabase, createProjectCopyApplication } from '../packages/db/dist/index.js';

const { values } = parseArgs({ options: { 'workspace-id': { type: 'string' }, source: { type: 'string' }, targets: { type: 'string' }, all: { type: 'boolean' }, replace: { type: 'boolean' }, yes: { type: 'boolean' } } });
const workspaceId = values['workspace-id'], source = values.source;
if (!workspaceId || !source || (!values.targets && !values.all)) {
  process.stderr.write('Usage: node scripts/apply-settings.mjs --workspace-id UUID --source UUID (--targets UUID,UUID | --all) [--replace] [--yes]\n');
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) { process.stderr.write('DATABASE_URL is required.\n'); process.exit(2); }
const db = createDatabase(url, { requireLoopback: true, maxConnections: 2, applicationName: 'workloom-apply-settings' });
try {
  const [owner] = await db.sql`select u.id, u.display_name from memberships m join users u on u.id = m.user_id where m.workspace_id = ${workspaceId} and m.role = 'owner' and m.state = 'active' order by m.created_at limit 1`;
  if (!owner) throw new Error('The workspace has no active owner.');
  const targets = values.all
    ? (await db.sql`select id from projects where workspace_id = ${workspaceId} and archived_at is null and id <> ${source} order by created_at`).map(row => row.id)
    : values.targets.split(',').map(id => id.trim()).filter(Boolean);
  const names = new Map((await db.sql`select id, name from projects where workspace_id = ${workspaceId}`).map(row => [row.id, row.name]));
  process.stdout.write(`Source: ${names.get(source) ?? source}\nTargets (${targets.length}):\n${targets.map(id => `  ${names.get(id) ?? id}`).join('\n')}\n`);
  if (!values.yes) { process.stdout.write('Re-run with --yes to apply.\n'); process.exit(0); }
  const context = { workspaceId, actor: { userId: owner.id, displayName: owner.display_name, kind: 'real' }, source: 'job', requestId: `apply-settings-${Date.now()}`, idempotencyKey: `apply-settings-${source}-${Date.now()}` };
  const result = await createProjectCopyApplication(db).applySettings(context, source, { targetProjectIds: targets, replaceExisting: values.replace === true });
  for (const item of result.results) {
    const parts = [item.applied.aggregates && 'sums', item.applied.checkRules > 0 && `${item.applied.checkRules} checks`, item.applied.defaults && 'defaults'].filter(Boolean);
    process.stdout.write(`${names.get(item.projectId) ?? item.projectId}: ${parts.length ? parts.join(', ') : 'nothing copied'}${item.warnings.map(w => `\n    ! ${w.part}: ${w.message}`).join('')}\n`);
  }
} finally { await db.close(); }
