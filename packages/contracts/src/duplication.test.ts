import { describe, expect, it } from 'vitest';
import { duplicateSectionPreviewInputSchema, duplicateTaskInputSchema, duplicateTaskPreviewInputSchema } from './duplication.js';
const id = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const copy = { description: true, assignee: true, dates: true, tags: true, priority: true, participants: true, subtasks: true, customFieldIds: [] };
describe('explicit bounded duplication contracts', () => {
  it('copies no ordinary values implicitly and permits any explicitly chosen field without plan/fact names', () => {
    expect(duplicateTaskPreviewInputSchema.parse({ projectId: id(1), title: 'Copy', copy }).copy.customFieldIds).toEqual([]);
    expect(duplicateTaskInputSchema.parse({ projectId: id(1), title: 'Copy', copy: { ...copy, customFieldIds: [id(3), id(2)] }, expectedSourceVersion: 'a'.repeat(64) }).copy.customFieldIds).toEqual([id(2), id(3)]);
  });
  it('rejects injected task contents, missing choices, duplicate fields, oversized titles and missing preview versions', () => {
    const input = { projectId: id(1), title: 'Copy', copy };
    for (const bad of [{ ...input, fields: [] }, { ...input, title: 'x'.repeat(501) }, { ...input, copy: {} }, { ...input, copy: { ...copy, customFieldIds: [id(2), id(2).toUpperCase()] } }]) expect(duplicateTaskPreviewInputSchema.safeParse(bad).success).toBe(false);
    expect(duplicateTaskInputSchema.safeParse(input).success).toBe(false);
    expect(duplicateSectionPreviewInputSchema.safeParse({ name: 'Copy', includeTasks: false, includeSettings: true, copy }).success).toBe(true);
  });
});
