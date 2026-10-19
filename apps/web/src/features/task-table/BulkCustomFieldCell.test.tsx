import type { TaskFieldValueDto } from '@workloom/contracts';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { field as fieldFixture, renderFieldUi, STAMP } from '../fields/test/fixtures';
import { ObservableFieldValueDraftStore } from '../fields/fieldValueDraftStore';
import { task } from '../planning/test/fixtures';
import { alphaMembers } from '../../test/fakeApi';
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
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: `Edit Website for ${task.title}` });
    expect(input).toHaveValue('https://example.com/task');
    await ui.user.clear(input); await ui.user.type(input, 'https://example.com/new{Enter}');
    expect(submit).toHaveBeenCalledWith({ customField: { fieldId: field.id, expectedDefinitionRevision: field.revision, value: { type: 'url', value: 'https://example.com/new' } } }, expect.any(Object));
    expect(capture).toHaveBeenCalledTimes(1); expect(submit).toHaveBeenCalledTimes(1);
  });
});

const scalarCases = [
  ['text', 'hello', { type: 'text', value: 'hello' }],
  ['number', '0', { type: 'number', value: 0 }],
  ['duration', '1:30', { type: 'duration', value: 90 }],
  ['date', '2026-10-20', { type: 'date', value: '2026-10-20' }],
  ['url', 'https://example.com', { type: 'url', value: 'https://example.com' }],
] as const;

describe('same custom control for every selected scalar type', () => {
  it.each(scalarCases)('autosaves %s directly on Enter through the one captured bulk port', async (type, text, expected) => {
    const field = { ...fieldFixture('Ordinary field', type), projectId: task.projectId };
    const submit = vi.fn(() => 'sent' as const), capture = vi.fn();
    const drafts = new ObservableFieldValueDraftStore();
    const ui = renderFieldUi(<BulkCustomFieldCell task={task} field={field} value={null} members={[]} writable drafts={drafts} capture={capture}
      port={() => ({ count: 3, pending: false, uncertain: false, error: null, notice: null, unsupported: false, submit, retry: vi.fn() })} />);
    const name = `Edit Ordinary field for ${task.title}`;
    await ui.user.click(screen.getByRole('button', { name }));
    await ui.user.type(screen.getByRole('textbox', { name }), `${text}{Enter}`);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({ customField: { fieldId: field.id, expectedDefinitionRevision: field.revision, value: expected } }, expect.any(Object));
    expect(capture).toHaveBeenCalledTimes(1);
  });
});


describe('same anchored custom picker for every selected choice type', () => {
  it.each(['single_select', 'multi_select', 'person', 'boolean'] as const)('commits %s using the normal picker and never a batch value dialog', async type => {
    const member = alphaMembers[0];
    if (!member) throw new Error('Expected first member fixture');
    const option = { id: '91000000-0000-4000-8000-000000000001', name: 'Design', color: '#6366f1', position: 0, revision: 1, archivedAt: null };
    const field = { ...fieldFixture('Choice', type), projectId: task.projectId, options: type === 'single_select' || type === 'multi_select' ? [option] : [] };
    const submit = vi.fn(() => 'sent' as const), capture = vi.fn();
    const ui = renderFieldUi(<BulkCustomFieldCell task={task} field={field} value={null} members={alphaMembers} writable drafts={new ObservableFieldValueDraftStore()} capture={capture}
      port={() => ({ count: 3, pending: false, uncertain: false, error: null, notice: null, unsupported: false, submit, retry: vi.fn() })} />);
    await ui.user.click(screen.getByRole('combobox', { name: `Edit Choice for ${task.title}` }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const target = type === 'person' ? member.displayName : type === 'boolean' ? 'No' : 'Design';
    await ui.user.click(screen.getByRole('option', { name: target }));
    const expected = type === 'person' ? [member.id] : type === 'boolean' ? false : type === 'multi_select' ? [option.id] : option.id;
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({ customField: { fieldId: field.id, expectedDefinitionRevision: field.revision, value: { type, value: expected } } }, expect.any(Object));
    expect(capture).toHaveBeenCalledTimes(1);
  });
});

it('releases a clean picker capture on Escape and captures a fresh selection when reopened', async () => {
  const field = { ...fieldFixture('Flag', 'boolean'), projectId: task.projectId };
  const drafts = new ObservableFieldValueDraftStore();
  let selected = ['first', 'second'];
  const captures = new WeakMap<object, readonly string[]>();
  const submit = vi.fn();
  const capture = vi.fn((identity: object) => captures.set(identity, [...selected]));
  const ui = renderFieldUi(<BulkCustomFieldCell task={task} field={field} value={null} members={[]} writable drafts={drafts} capture={capture}
    port={identity => {
      const captured = captures.get(identity);
      return captured ? { count: captured.length, pending: false, uncertain: false, error: null, notice: null, unsupported: false,
        submit: (changes, callbacks) => { submit(captured, changes, callbacks); return 'sent'; }, retry: vi.fn() } : undefined;
    }} />);
  const name = `Edit Flag for ${task.title}`;
  await ui.user.click(screen.getByRole('combobox', { name }));
  await ui.user.keyboard('{Escape}');
  expect(drafts.getTask(task.id)).toEqual({});
  selected = ['second', 'third'];
  await ui.user.click(screen.getByRole('combobox', { name }));
  await ui.user.click(screen.getByRole('option', { name: 'No' }));
  expect(capture).toHaveBeenCalledTimes(2);
  expect(capture.mock.calls[0]?.[0]).not.toBe(capture.mock.calls[1]?.[0]);
  expect(submit).toHaveBeenCalledWith(['second', 'third'], expect.any(Object), expect.any(Object));
});
