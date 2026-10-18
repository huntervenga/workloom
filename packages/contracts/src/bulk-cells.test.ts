import { describe, expect, it } from 'vitest';
import { bulkUpdateTasksInputSchema } from './tasks.js';
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const base = { projectId: id(1), tasks: [{ taskId: id(2), expectedRevision: 3 }, { taskId: id(3), expectedRevision: 7 }] };
describe('atomic bulk cell guards', () => {
  it('keeps legacy bodies byte-identical and never injects optional guards', () => {
    const input = { ...base, changes: { dueDate: null } };
    expect(JSON.stringify(bulkUpdateTasksInputSchema.parse(input))).toBe(JSON.stringify(input));
  });
  it('requires a package guard on every selected row only when changing the shared estimate', () => {
    expect(bulkUpdateTasksInputSchema.safeParse({ ...base, changes: { estimateMinutes: 0 } }).success).toBe(false);
    const tasks = base.tasks.map(row => ({ ...row, expectedWorkPackageRevision: 2 }));
    expect(bulkUpdateTasksInputSchema.parse({ ...base, tasks, changes: { estimateMinutes: null } }).changes.estimateMinutes).toBeNull();
    expect(bulkUpdateTasksInputSchema.safeParse({ ...base, tasks, changes: { priority: 'high' } }).success).toBe(false);
  });
  it.each([
    { type: 'text', value: '' }, { type: 'number', value: 0 }, { type: 'duration', value: 0 },
    { type: 'date', value: '2027-01-02' }, { type: 'single_select', value: null },
    { type: 'multi_select', value: [] }, { type: 'person', value: [] }, { type: 'boolean', value: false },
    { type: 'url', value: 'https://example.com/path' },
  ])('preserves an explicit $type custom value with independently guarded missing rows', value => {
    const tasks = base.tasks.map(row => ({ ...row, expectedFieldValueRevision: 0 }));
    const changes = { customField: { fieldId: id(4), expectedDefinitionRevision: 2, value } };
    expect(bulkUpdateTasksInputSchema.parse({ ...base, tasks, changes }).changes.customField?.value).toEqual(value);
    expect(bulkUpdateTasksInputSchema.safeParse({ ...base, changes }).success).toBe(false);
    expect(bulkUpdateTasksInputSchema.safeParse({ ...base, tasks, changes: { dueDate: null } }).success).toBe(false);
  });
  it('rejects title/description/time changes and invalid typed custom values', () => {
    for (const changes of [{ title: 'No mass rename' }, { description: 'No mass overwrite' }, { actualMinutes: 60 }]) {
      expect(bulkUpdateTasksInputSchema.safeParse({ ...base, changes }).success).toBe(false);
    }
    const tasks = base.tasks.map(row => ({ ...row, expectedFieldValueRevision: 0 }));
    expect(bulkUpdateTasksInputSchema.safeParse({ ...base, tasks, changes: { customField: { fieldId: id(4), expectedDefinitionRevision: 1, value: { type: 'number', value: 'not a number' } } } }).success).toBe(false);
  });
});
