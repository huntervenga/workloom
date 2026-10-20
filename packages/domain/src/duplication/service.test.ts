import type * as C from '@workloom/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../access/context.js';
import type { DuplicationDependencies, DuplicationScope } from './ports.js';
import { createDuplicationApplication, selectDuplicationTree } from './service.js';
import { createPlanningMutationGuard } from '../planning/freeze.js';
import { resolveRecurrenceAffectedProjects } from '../recurrence/footprint.js';
import type { RecurrenceFootprintScope } from '../recurrence/footprint.js';
const id = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(2), ws = id(1), stamp = '2026-10-20T08:00:00.000Z';
const project: C.ProjectDto = { id: projectId, workspaceId: ws, name: 'Source', revision: 1, archivedAt: null, createdAt: stamp, updatedAt: stamp };
const row = (n: number, parent: string | null = null): C.TaskDto => ({ id: id(n), workspaceId: ws, projectId, sectionId: id(3), parentTaskId: parent, workPackageId: id(90), workPackageRevision: 1, title: `Task ${n}`, description: 'Source', statusId: id(4), responsibleMembershipId: null, participants: [], participantsRevision: 1, startDate: null, dueDate: null, priority: 'none', tags: [], estimateMinutes: null, position: n, revision: 1, visibility: 'workspace', archivedAt: null, createdAt: stamp, updatedAt: stamp, meetingId: null });
const copy: C.DuplicationCopyOptions = { description: true, assignee: true, dates: true, tags: true, priority: true, participants: true, subtasks: true, customFieldIds: [] };
const context: CommandContext = { workspaceId: ws, actor: { userId: id(10), kind: 'fixture', displayName: 'Person' }, source: 'web', requestId: id(11), idempotencyKey: 'duplicate-key' };
function fixture() {
  const rows = [row(20), row(21, id(20))], section: C.SectionDto = { id: id(3), projectId, workspaceId: ws, name: 'Source section', revision: 1, position: 0, archivedAt: null };
  const field: C.TaskFieldDefinitionDto = { id: id(30), projectId, workspaceId: ws, name: 'Actual ordinary value', type: 'boolean', revision: 1, definitionVersionId: id(31), locked: false, archivedAt: null, historyEnabled: true, options: [], createdAt: stamp, updatedAt: stamp };
  const values: C.TaskFieldValueDto[] = [{ taskId: id(20), fieldId: field.id, definitionVersionId: field.definitionVersionId, projectId, workspaceId: ws, value: { type: 'boolean', value: false }, revision: 1, updatedAt: stamp }];
  const writes = vi.fn(), receipt = { current: null as unknown }, placements: C.TaskProjectPlacementDto[] = [];
  const scope = {
    context, barrierAt: new Date(stamp), access: { membership: { role: 'owner', id: id(12) } }, recordChange: writes,
    repository: { tasks: { findTask: async (_ws: string, key: string) => rows.find(task => task.id === key) ?? null, findSection: async () => section, findProject: async () => project, listTasks: async () => rows, listSections: async () => [section], listStatuses: async () => [{ id: id(4), workspaceId: ws, projectId, group: 'todo', name: 'To do', revision: 1, position: 0 }], permissionEpoch: async () => '1', findIdempotency: async () => receipt.current, insertIdempotency: writes }, fields: { listFields: async () => [field], listProjectValues: async () => values } },
    placements: { listProject: async () => placements },
  } as unknown as DuplicationScope;
  // Stable within this fixture and collision-free for distinct canonical inputs.
  // Production SHA-256 belongs to the database adapter, not this portable domain test.
  const digests = new Map<string, string>();
  const digest = (text: string): string => {
    const existing = digests.get(text);
    if (existing !== undefined) return existing;
    const next = (digests.size + 1).toString(16).padStart(64, '0');
    digests.set(text, next);
    return next;
  };
  const deps: DuplicationDependencies = { read: async (_ctx, _cap, work) => work(scope), write: async (_ctx, _cap, work) => work(scope), newId: () => id(100), digest };
  return { app: createDuplicationApplication(deps), scope, rows, field, values, writes, receipt, placements };
}
describe('complete duplication trees and authorized previews', () => {
  it('preserves full preorder including children outside the root section and never duplicates a selected descendant twice', () => {
    const a = row(20), b = { ...row(21, a.id), sectionId: id(7) }, c = row(22, b.id);
    expect(selectDuplicationTree([c, b, a], [a, b], true).map(task => task.id)).toEqual([a.id, b.id, c.id]);
    expect(selectDuplicationTree([c, b, a], [a], false).map(task => task.id)).toEqual([a.id]);
  });
  it('rejects cycles, hidden meetings and over100 tasks without truncation', () => {
    const a = row(20, id(21)), b = row(21, a.id);
    expect(() => selectDuplicationTree([a, b], [a], true)).toThrow();
    expect(() => selectDuplicationTree([row(20), { ...row(21, id(20)), meetingId: id(70) }], [row(20)], true)).toThrow();
    const many = Array.from({ length: 101 }, (_, i) => row(100 + i));
    expect(() => selectDuplicationTree(many, many, true)).toThrow();
  });
  it('is read-only, counts explicit false and binds independent value revisions in its source digest', async () => {
    const f = fixture(), input = { projectId, title: 'Copy', copy: { ...copy, customFieldIds: [f.field.id] } };
    const first = await f.app.previewTask(context, id(20), input);
    expect(first.taskCount).toBe(2); expect(first.customValueCount).toBe(1); expect(f.writes).not.toHaveBeenCalled();
    f.scope.barrierAt.setUTCDate(22);
    expect((await f.app.previewTask(context, id(20), input)).sourceVersion).toBe(first.sourceVersion);
    const old = f.values[0]; if (!old) throw new Error('Expected value'); f.values[0] = { ...old, revision: 2 };
    expect((await f.app.previewTask(context, id(20), input)).sourceVersion).not.toBe(first.sourceVersion);
    await expect(f.app.duplicateTask(context, id(20), { ...input, expectedSourceVersion: first.sourceVersion })).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    expect(f.writes).not.toHaveBeenCalled();
  });
  it('blocks a linked task context and sections with linked rows instead of silently copying elsewhere or omitting rows', async () => {
    const f = fixture();
    await expect(f.app.previewTask(context, id(20), { projectId: id(8), title: 'Copy', copy })).rejects.toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED' });
    f.placements.push({ id: id(71), workspaceId: ws, projectId, homeProjectId: id(8), taskId: id(72), sectionId: id(3), revision: 1, position: 0, archivedAt: null, createdAt: stamp, updatedAt: stamp });
    await expect(f.app.previewSection(context, id(3), { name: 'Copy', includeTasks: true, includeSettings: false, copy })).rejects.toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED' });
    expect(f.writes).not.toHaveBeenCalled();
  });
  it('rejects a disconnected cyclic section component rather than copying only its valid root', async () => {
    const f = fixture(); f.rows.push(row(22, id(23)), row(23, id(22)));
    await expect(f.app.previewSection(context, id(3), { name: 'Complete section', includeTasks: true, includeSettings: false, copy })).rejects.toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED' });
    expect(f.writes).not.toHaveBeenCalled();
  });
  it('requires current manager settings capability before even an old successful settings receipt', async () => {
    const f = fixture();
    Object.assign(f.scope.access.membership, { role: 'member' });
    f.receipt.current = { payloadHash: 'old', result: {} };
    await expect(f.app.duplicateSection(context, id(3), { name: 'Copy', includeTasks: false, includeSettings: true, copy, expectedSourceVersion: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
    expect(f.writes).not.toHaveBeenCalled();
  });
  it('resolves the duplicate project census and enforces new-value locks before proposed writes', async () => {
    const f = fixture(), trace: string[] = [];
    Object.assign(f.scope.repository, { listPeriods: async () => [], listLocks: async () => [] });
    Object.assign(f.scope.repository.fields, { findField: async () => ({ ...f.field, locked: true }), policies: { find: async () => null } });
    Object.assign(f.scope, { recurrenceCensus: { resolveAffectedProjects: async () => { trace.push('footprint'); return { kind: 'projects', projectIds: [projectId] }; }, requireCompleteCensus: async () => { trace.push('census'); } } });
    const intent = { family: 'duplication' as const, command: 'task.duplicate' as const, target: { projectId, sourceId: id(20) }, input: {}, fieldPolicyCandidates: [{ fieldId: f.field.id, expectedDefinitionRevision: 1, value: { type: 'boolean' as const, value: false } }] };
    const footprintScope: RecurrenceFootprintScope = { context, repository: f.scope.repository, recurrence: {} as RecurrenceFootprintScope['recurrence'] };
    expect(await resolveRecurrenceAffectedProjects(footprintScope, intent)).toEqual({ kind: 'projects', projectIds: [projectId] });
    const guard = createPlanningMutationGuard(f.scope, { newId: () => id(90), digest: value => value });
    expect(await guard.check(intent)).toMatchObject({ __workloomPlanningOutcome: 'rejected', code: 'FIELD_LOCKED' });
    expect(trace).toEqual(['footprint', 'census']); expect(f.writes).not.toHaveBeenCalled();
  });

});
