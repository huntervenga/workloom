import type { BulkUpdateTasksInput, TaskDto } from '@workloom/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { TaskTools, TaskWriteScope, WorkPackageRecord } from './ports.js';
import { applyBulkExtras, prepareBulkExtras } from './bulk-extras.js';
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const at = '2026-10-18T00:00:00.000Z', projectId = id(1), packageId = id(2);
function fixture() {
  const pack = { id: packageId, workspaceId: id(3), projectId, estimateMinutes: 60, revision: 4, createdAt: at, updatedAt: at } as WorkPackageRecord;
  const findWorkPackage = vi.fn(async () => pack), saveWorkPackage = vi.fn(async () => undefined);
  const scope = { context: { workspaceId: id(3) }, barrierAt: new Date(at), repository: { findWorkPackage, saveWorkPackage } } as unknown as TaskWriteScope;
  const tasks = [{ id: id(4), workPackageId: packageId }, { id: id(5), workPackageId: packageId }] as TaskDto[];
  const input: BulkUpdateTasksInput = { projectId, tasks: tasks.map(task => ({ taskId: task.id, expectedRevision: 1, expectedWorkPackageRevision: 4 })), changes: { estimateMinutes: 90 } };
  return { scope, tasks, input, findWorkPackage, saveWorkPackage, pack };
}
describe('atomic shared-estimate preparation', () => {
  it('preflights every selected guard and writes one shared package only once', async () => {
    const f = fixture();
    const prepared = await prepareBulkExtras(f.scope, f.input, f.tasks);
    expect(f.saveWorkPackage).not.toHaveBeenCalled();
    expect(prepared.packages.size).toBe(1);
    await applyBulkExtras(f.scope, f.input, f.tasks, prepared, { newId: () => id(99) } as Pick<TaskTools, 'newId'>);
    expect(f.saveWorkPackage).toHaveBeenCalledExactlyOnceWith({ ...f.pack, estimateMinutes: 90, revision: 5, updatedAt: at });
  });
  it('rejects a later conflicting package guard before any proposal', async () => {
    const f = fixture();
    const later = f.input.tasks[1];
    if (!later) throw new Error('Missing later target.');
    later.expectedWorkPackageRevision = 3;
    await expect(prepareBulkExtras(f.scope, f.input, f.tasks)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(f.saveWorkPackage).not.toHaveBeenCalled();
  });
  it('keeps a same-budget command a true package no-op', async () => {
    const f = fixture();
    f.input.changes.estimateMinutes = 60;
    const prepared = await prepareBulkExtras(f.scope, f.input, f.tasks);
    await applyBulkExtras(f.scope, f.input, f.tasks, prepared, { newId: () => id(99) });
    expect(prepared.packages.size).toBe(0);
    expect(f.saveWorkPackage).not.toHaveBeenCalled();
  });
});
