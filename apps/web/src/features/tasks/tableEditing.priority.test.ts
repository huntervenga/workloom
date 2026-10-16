import { describe, expect, it } from 'vitest';
import { taskPrioritySchema } from '@workloom/contracts';
import { task } from '../planning/test/fixtures';
import { buildUpdateInput, draftFromTask } from './taskDraft';
import { canResumeInlineSession, matchesInlineTaskReceipt, taskInlineColumn } from './tableEditing';

describe('inline Priority field contract', () => {
  it.each(taskPrioritySchema.options)('emits exactly the task revision and %s, including clearing to none', priority => {
    const base = { ...task, priority: priority === 'none' ? 'medium' as const : 'none' as const, revision: 7 };
    const draft = { ...draftFromTask(base), priority };
    expect(taskInlineColumn('priority')).toBe('priority');
    expect(canResumeInlineSession({ base, draft, inlineField: 'priority' }, 'priority')).toBe(true);
    expect(buildUpdateInput(base, draftFromTask(base), draft)).toEqual({ ok: true, input: { expectedRevision: 7, priority } });
  });
  it('keeps a rich drawer or another field session Resume-only, including priority-only rich drafts', () => {
    const draft = { ...draftFromTask(task), priority: 'urgent' as const };
    expect(canResumeInlineSession({ base: task, draft }, 'priority')).toBe(false);
    expect(canResumeInlineSession({ base: task, draft, inlineField: 'dueDate' }, 'priority')).toBe(false);
    expect(canResumeInlineSession({ base: task, draft: { ...draft, description: 'Separate rich draft' }, inlineField: 'priority' }, 'priority')).toBe(false);
  });
  it('matches only the exact task identity, current revision and Priority receipt', () => {
    const receipt = { ...task, priority: 'high' as const, revision: 8 };
    expect(matchesInlineTaskReceipt(receipt, receipt, 'priority')).toBe(true);
    for (const changed of [{ ...receipt, id: 'another-task' }, { ...receipt, revision: 9 }, { ...receipt, priority: 'urgent' as const }]) expect(matchesInlineTaskReceipt(changed, receipt, 'priority')).toBe(false);
  });
});
