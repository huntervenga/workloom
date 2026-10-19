import {createHash} from 'node:crypto';
import {createLeaveRepository} from '../leave/repository.js';
import { and, asc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { genericAggregateSettingsSchema, genericInitialSnapshotSchema, genericReportDefinitionSchema, genericReportRowSchema, taskFieldValueSchema, type GenericReportDefinitionDto } from '@workloom/contracts';
import { DomainError, notFoundError, usedFieldIds, buildLeaveAvailability, type GenericReportRepository, type GenericReportSource } from '@workloom/domain';
import type { WorkloomExecutor } from '../client.js';
import { genericReportDefinitions, genericReportDefinitionVersions, genericReportInitialSnapshots, genericReportColumnSettings, memberships, users, workspaces, projects, tasks, taskStatuses, taskProjectPlacements, taskTags, taskFieldValues, sections } from '../schema.js';
import { createTaskFieldRepository } from '../repositories/task-field-repository.js';
function definition(row: typeof genericReportDefinitions.$inferSelect): GenericReportDefinitionDto { return genericReportDefinitionSchema.parse({ ...row, archivedAt: row.archivedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }); }
export function createGenericReportRepository(tx: WorkloomExecutor, workspaceId: string): GenericReportRepository {
  const fields = createTaskFieldRepository(tx);
  return {
    async list(projectId) { return (await tx.select().from(genericReportDefinitions).where(and(eq(genericReportDefinitions.workspaceId, workspaceId), eq(genericReportDefinitions.projectId, projectId))).orderBy(asc(genericReportDefinitions.createdAt), asc(genericReportDefinitions.id))).map(definition); },
    async find(reportId) { const [row] = await tx.select().from(genericReportDefinitions).where(and(eq(genericReportDefinitions.workspaceId, workspaceId), eq(genericReportDefinitions.id, reportId))).limit(1); return row ? definition(row) : null; },
    async save(report) {
      const row = { ...report, archivedAt: report.archivedAt ? new Date(report.archivedAt) : null, createdAt: new Date(report.createdAt), updatedAt: new Date(report.updatedAt) };
      if (report.revision === 1) await tx.insert(genericReportDefinitions).values(row);
      else { const updated = await tx.update(genericReportDefinitions).set({ name: row.name, revision: row.revision, config: row.config, archivedAt: row.archivedAt, updatedAt: row.updatedAt }).where(and(eq(genericReportDefinitions.workspaceId, workspaceId), eq(genericReportDefinitions.id, report.id), eq(genericReportDefinitions.revision, report.revision - 1))).returning({ id: genericReportDefinitions.id }); if (updated.length !== 1) throw new DomainError('REVISION_CONFLICT', 'The report changed.'); }
      await tx.insert(genericReportDefinitionVersions).values({ workspaceId, projectId: report.projectId, reportId: report.id, revision: report.revision, snapshot: report, createdAt: row.updatedAt });
    },
    async validateCapacity(config,allowFormer=true){
      if(!config.capacity)return;const selected=config.capacity.people;
      if(selected.kind==='selected'){
        const rows=await tx.select({id:memberships.id}).from(memberships).where(and(eq(memberships.workspaceId,workspaceId),inArray(memberships.id,selected.membershipIds),...(allowFormer?[]:[eq(memberships.state,'active')]))).limit(101);
        if(rows.length!==selected.membershipIds.length&&!allowFormer)throw notFoundError();
        if(rows.length!==selected.membershipIds.length)throw new DomainError('DOMAIN_VALIDATION_FAILED','A selected capacity person is not a membership of this workspace.');
      }else{
        const rows=await tx.select({id:memberships.id}).from(memberships).where(and(eq(memberships.workspaceId,workspaceId),eq(memberships.state,'active'))).limit(101);
        if(rows.length>100)throw new DomainError('DOMAIN_VALIDATION_FAILED','Choose at most 100 capacity people.');
      }
    },
    async source(config) {
      const [head] = await tx.select({ seq: workspaces.changeSeq, epoch: workspaces.permissionEpoch }).from(workspaces).where(eq(workspaces.id, workspaceId)); if (!head) throw notFoundError();
      // One target-project placement at most (SQL unique constraint), canonical task ID is the identity.
      const rows = await tx.select({ id: tasks.id, projectId: tasks.projectId, title: tasks.title, revision: tasks.revision, parentTaskId: tasks.parentTaskId, homeSectionId: tasks.sectionId, linkedSectionId: taskProjectPlacements.sectionId, responsibleMembershipId: tasks.responsibleMembershipId, dueDate: tasks.dueDate, statusGroup: taskStatuses.group }).from(tasks)
        .innerJoin(projects, and(eq(projects.workspaceId, workspaceId), eq(projects.id, tasks.projectId), isNull(projects.archivedAt)))
        .innerJoin(taskStatuses, and(eq(taskStatuses.workspaceId, workspaceId), eq(taskStatuses.projectId, tasks.projectId), eq(taskStatuses.id, tasks.statusId)))
        .leftJoin(taskProjectPlacements, and(eq(taskProjectPlacements.workspaceId, workspaceId), eq(taskProjectPlacements.taskId, tasks.id), eq(taskProjectPlacements.projectId, config.projectId), isNull(taskProjectPlacements.archivedAt)))
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.visibility, 'workspace'), isNull(tasks.archivedAt), or(eq(tasks.projectId, config.projectId), isNotNull(taskProjectPlacements.id)))).orderBy(asc(tasks.id)).limit(5001);
      if (rows.length > 5000) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'This project exceeds the 5000-task report scope limit; no partial totals were calculated.');
      const ids = rows.map(r => r.id), selected = usedFieldIds(config), values: GenericReportSource['values'] = [], tags: { taskId: string; tagId: string }[] = [];
      for (let start = 0; start < ids.length; start += 1000) {
        const chunk = ids.slice(start, start + 1000);
        tags.push(...await tx.select({ taskId: taskTags.taskId, tagId: taskTags.tagId }).from(taskTags).where(and(eq(taskTags.workspaceId, workspaceId), inArray(taskTags.taskId, chunk))));
        if (selected.length) for (const row of await tx.select().from(taskFieldValues).where(and(eq(taskFieldValues.workspaceId, workspaceId), eq(taskFieldValues.projectId, config.projectId), inArray(taskFieldValues.taskId, chunk), inArray(taskFieldValues.fieldId, selected)))) values.push(taskFieldValueSchema.parse({ workspaceId: row.workspaceId, projectId: row.projectId, taskId: row.taskId, fieldId: row.fieldId, definitionVersionId: row.definitionVersionId, revision: row.revision, value: row.value, updatedAt: row.updatedAt.toISOString() }));
      }
      const members = await tx.select({ id: memberships.id, label: users.displayName }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.workspaceId, workspaceId));
      const sectionRows = await tx.select({ id: sections.id, label: sections.name }).from(sections).where(and(eq(sections.workspaceId, workspaceId), eq(sections.projectId, config.projectId)));
      return { ...(config.capacity?{capacity:buildLeaveAvailability(await createLeaveRepository(tx,workspaceId).source(),config.capacity,true,(s)=>createHash('sha256').update(s).digest('hex'))}:{}), head: `${head.seq}:${head.epoch}`, fields: await fields.listFields(workspaceId, config.projectId), tasks: rows.map(r => ({ id: r.id, projectId: r.projectId, title: r.title, revision: r.revision, parentTaskId: r.parentTaskId, sectionId: r.projectId === config.projectId ? r.homeSectionId : r.linkedSectionId, responsibleMembershipId: r.responsibleMembershipId, dueDate: r.dueDate, statusGroup: r.statusGroup, tagIds: tags.filter(t => t.taskId === r.id).map(t => t.tagId) })), values, memberLabels: Object.fromEntries(members.map(m => [m.id, m.label])), sectionLabels: Object.fromEntries(sectionRows.map(s => [s.id, s.label])) };
    },
    async listSnapshots(reportId) { return (await tx.select({ header: genericReportInitialSnapshots.header }).from(genericReportInitialSnapshots).where(and(eq(genericReportInitialSnapshots.workspaceId, workspaceId), eq(genericReportInitialSnapshots.reportId, reportId))).orderBy(asc(genericReportInitialSnapshots.createdAt), asc(genericReportInitialSnapshots.id))).map(r => genericInitialSnapshotSchema.parse(r.header)); },
    async findSnapshot(reportId, snapshotId) { const [row] = await tx.select().from(genericReportInitialSnapshots).where(and(eq(genericReportInitialSnapshots.workspaceId, workspaceId), eq(genericReportInitialSnapshots.reportId, reportId), eq(genericReportInitialSnapshots.id, snapshotId))).limit(1); return row ? { header: genericInitialSnapshotSchema.parse(row.header), rows: row.rows.map(r => genericReportRowSchema.parse(r)), values: row.values.map(v => taskFieldValueSchema.parse(v)) } : null; },
    async insertSnapshot(value) { await tx.insert(genericReportInitialSnapshots).values({ id: value.header.id, workspaceId, projectId: value.header.projectId, reportId: value.header.reportId, definitionRevision: value.header.definitionRevision, header: value.header, rows: value.rows, values: value.values, createdAt: new Date(value.header.capturedAt) }); },
    async settings(projectId) { const [row] = await tx.select().from(genericReportColumnSettings).where(and(eq(genericReportColumnSettings.workspaceId, workspaceId), eq(genericReportColumnSettings.projectId, projectId))).limit(1); return genericAggregateSettingsSchema.parse(row ?? { workspaceId, projectId, revision: 0, measures: [] }); },
    async saveSettings(value) { await tx.insert(genericReportColumnSettings).values(value).onConflictDoUpdate({ target: [genericReportColumnSettings.workspaceId, genericReportColumnSettings.projectId], set: { revision: value.revision, measures: value.measures } }); },
  };
}
