import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { TaskFieldDefinitionDto, TaskFieldValueDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { alpha, alphaMembers, anna, deferred, installFakeApi, ok } from '../../test/fakeApi';
import { makeTask } from '../task-table/taskTableFixtures';
import { TaskCustomFields } from './TaskCustomFields';
import { useSetTaskFieldValueMutation } from './queries';
import { FIELD_ID, PROJECT_ID, field, fieldsPath, heldResponse, renderFieldUi, STAMP } from './test/fixtures';

const task = makeTask({ id: 'f0000000-0000-4000-8000-000000000011', workspaceId: alpha.id, projectId: PROJECT_ID, title: 'Задача' });
const valuesPath = '/api/v1/workspaces/' + alpha.id + '/tasks/' + task.id + '/field-values';
const writePath = valuesPath + '/' + FIELD_ID;

function Page() {
  const mutation = useSetTaskFieldValueMutation(anna.id, alpha.id);
  return (
    <TaskCustomFields
      actorId={anna.id} workspaceId={alpha.id} task={task}
      members={alphaMembers} writable mutation={mutation} onOpenTask={() => undefined}
    />
  );
}

/** Field definitions plus a value write that never answers unless the test settles it. */
function setup(definition: TaskFieldDefinitionDto, writes: Array<ReturnType<typeof heldResponse>> = [], initial: TaskFieldValueDto[] = []) {
  const { calls } = installFakeApi({
    ['GET ' + fieldsPath]: () => ok([definition]),
    ['GET ' + valuesPath]: () => ok(initial),
    ['PUT ' + writePath]: () => {
      const response = heldResponse();
      writes.push(response);
      return response.promise;
    },
  });
  const sent = () => calls.filter((call) => call.method !== 'GET');
  return { sent, writes, ...renderFieldUi(<Page />) };
}

function bodyOf(call: unknown): unknown {
  const body = (call as { body?: unknown }).body;
  return typeof body === 'string' ? JSON.parse(body) : body;
}

const label = (name: string) => `Edit ${name} for ${task.title}`;
async function openEditor(user: ReturnType<typeof setup>['user'], name: string) {
  const picker = await screen.findByLabelText(label(name), { selector: 'button' });
  const cell = picker.closest('[data-inline-field-cell]') as HTMLElement;
  if (picker.getAttribute('role') !== 'combobox' && !picker.hasAttribute('disabled')) await user.click(picker);
  return cell;
}

describe('custom field autosave', () => {
  it('reenables an idle custom editor after a foreign command acknowledges without an editor action or write', async () => {
    const definition = field('Score', 'number');
    const foreignTaskId = 'f0000000-0000-4000-8000-000000000099';
    const gate = deferred<Response>();
    const { calls } = installFakeApi({
      ['GET ' + fieldsPath]: () => ok([definition]),
      ['GET ' + valuesPath]: () => ok([]),
      ['PUT /api/v1/workspaces/' + alpha.id + '/tasks/' + foreignTaskId + '/field-values/' + FIELD_ID]: () => gate.promise,
    });
    function ForeignWrite() {
      const mutation = useSetTaskFieldValueMutation(anna.id, alpha.id);
      return <button onClick={() => mutation.mutate({ taskId: foreignTaskId, fieldId: FIELD_ID, input: { expectedRevision: 0, expectedDefinitionRevision: 1, value: { type: 'number', value: 9 } } })}>Start another write</button>;
    }
    const { user } = renderFieldUi(<><ForeignWrite /><Page /></>);
    await user.click(screen.getByRole('button', { name: 'Start another write' }));
    await waitFor(() => expect(calls.filter(call => call.method === 'PUT')).toHaveLength(1));
    const dialog = await openEditor(user, 'Score');
    expect(within(dialog).getByRole('button', { name: label('Score') })).toBeDisabled();
    await act(async () => gate.resolve(ok({ workspaceId: alpha.id, projectId: PROJECT_ID, taskId: foreignTaskId, fieldId: FIELD_ID, definitionVersionId: definition.definitionVersionId, revision: 1, value: { type: 'number', value: 9 }, updatedAt: STAMP })));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: label('Score') })).toBeEnabled());
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(1);
  });

  it('clicking Clear commits only the explicit clear, not the text blurred by that click', async () => {
    const definition = field('Score', 'number');
    const initial: TaskFieldValueDto = { workspaceId: alpha.id, projectId: PROJECT_ID, taskId: task.id, fieldId: FIELD_ID, definitionVersionId: definition.definitionVersionId, revision: 3, value: { type: 'number', value: 5 }, updatedAt: STAMP };
    const { user, sent } = setup(definition, [], [initial]);
    const dialog = await openEditor(user, 'Score');
    const input = within(dialog).getByRole('textbox', { name: label('Score') });
    await user.clear(input); await user.type(input, '7');
    expect(sent()).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Clear: Score' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(bodyOf(sent()[0])).toEqual({ expectedRevision: 3, expectedDefinitionRevision: 1, value: { type: 'number', value: null } });
  });

  it('saves a changed number once on Tab, without a Save value step', async () => {
    const { user, sent } = setup(field('Оценка', 'number'));
    const dialog = await openEditor(user, 'Оценка');

    await user.type(within(dialog).getByRole('textbox', { name: label('Оценка') }), '7');
    expect(sent()).toHaveLength(0);
    await user.tab();

    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(bodyOf(sent()[0])).toEqual({ expectedRevision: 0, expectedDefinitionRevision: 1, value: { type: 'number', value: 7 } });
    expect(within(dialog).queryByRole('button', { name: 'Save value' })).not.toBeInTheDocument();
    // Leaving the now read-only control again sends nothing more.
    await user.tab();
    expect(sent()).toHaveLength(1);
  });

  it('sends an explicitly chosen false right away, never as not set', async () => {
    const { user, sent } = setup(field('Готово', 'boolean'));
    const dialog = await openEditor(user, 'Готово');

    await user.click(within(dialog).getByRole('combobox', { name: label('Готово') }));
    await user.click(screen.getByRole('option', { name: 'No' }));

    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(bodyOf(sent()[0])).toMatchObject({ value: { type: 'boolean', value: false } });
    // The held command shows exactly what was sent.
    expect(within(dialog).getByRole('combobox', { name: label('Готово') })).toHaveTextContent('No');
    await user.tab();
    expect(sent()).toHaveLength(1);
  });

  it('resends an unconfirmed write only on Retry, with the exact same request', async () => {
    const { user, sent, writes } = setup(field('Оценка', 'number'));
    const cell = await openEditor(user, 'Оценка');
    await user.type(within(cell).getByRole('textbox', { name: label('Оценка') }), '42{Enter}');
    await waitFor(() => expect(sent()).toHaveLength(1));
    const first = writes[0];
    if (!first) throw new Error('First field request missing.');
    await act(async () => first.lose());
    await screen.findByRole('button', { name: 'Retry original' });
    await user.tab();
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    expect(sent()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /Show the save problem/ }));
    await user.click(screen.getByRole('button', { name: 'Retry original' }));
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]).toEqual(sent()[0]);
    expect(sent()[1]?.headers.get('Idempotency-Key')).toBe(sent()[0]?.headers.get('Idempotency-Key'));
    expect(bodyOf(sent()[1])).toEqual({ expectedRevision: 0, expectedDefinitionRevision: 1, value: { type: 'number', value: 42 } });
  });

  it('keeps an invalid partial date as a visible draft instead of saving it', async () => {
    const { user, sent } = setup(field('Срок', 'date'));
    const cell = await openEditor(user, 'Срок');
    const input = within(cell).getByRole('textbox', { name: label('Срок') });
    await user.type(input, '2026-1');
    await user.tab();
    expect(input).toHaveValue('2026-1');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(sent()).toHaveLength(0);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // A normal validation failure is corrected in the same input, without opening details.
    fireEvent.change(input, { target: { value: '2026-10-20' } });
    await user.click(input); await user.keyboard('{Enter}');
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(bodyOf(sent()[0])).toMatchObject({ value: { type: 'date', value: '2026-10-20' } });
  });

  it('shows a clean editor without Save value or Discard and closes without writing', async () => {
    const { user, sent } = setup(field());
    const cell = await openEditor(user, 'Заметка');
    expect(within(cell).queryByRole('button', { name: 'Save value' })).not.toBeInTheDocument();
    expect(within(cell).queryByRole('button', { name: 'Discard draft' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(within(cell).queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(sent()).toHaveLength(0);
  });
});
