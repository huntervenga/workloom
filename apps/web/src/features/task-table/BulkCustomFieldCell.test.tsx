import type { TaskFieldValueDto } from '@workloom/contracts';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { field as fieldFixture, renderFieldUi, STAMP } from '../fields/test/fixtures';
import { ObservableFieldValueDraftStore } from '../fields/fieldValueDraftStore';
import { task } from '../planning/test/fixtures';
import { BulkCustomFieldCell } from './BulkCustomFieldCell';

describe('selected custom URL cell editing', () => {
  it('opens the typed editor from stored URL text without creating a nested navigation link', async () => {
    const field = { ...fieldFixture('Website', 'url'), projectId: task.projectId };
    const value: TaskFieldValueDto = { workspaceId: task.workspaceId, projectId: task.projectId, taskId: task.id, fieldId: field.id, definitionVersionId: field.definitionVersionId, value: { type: 'url', value: 'https://example.com/task' }, revision: 3, updatedAt: STAMP };
    const submit = vi.fn(() => 'sent' as const), capture = vi.fn();
    const ui = renderFieldUi(<BulkCustomFieldCell task={task} field={field} value={value} members={[]} writable drafts={new ObservableFieldValueDraftStore()} capture={capture}
      port={() => ({ count: 3, pending: false, uncertain: false, error: null, notice: null, unsupported: false, submit, retry: vi.fn() })} />);
    const trigger = screen.getByRole('button', { name: `Edit Website for ${task.title}` });
    expect(within(trigger).queryByRole('link')).not.toBeInTheDocument();
    await ui.user.click(within(trigger).getByText('https://example.com/task'));
    const dialog = await screen.findByRole('dialog', { name: `Edit Website for ${task.title}` });
    expect(within(dialog).getByLabelText('Website')).toHaveValue('https://example.com/task');
    expect(within(dialog).getByText('Applies to 3 selected tasks')).toBeVisible();
    expect(capture).toHaveBeenCalledTimes(1); expect(submit).not.toHaveBeenCalled();
  });
});
