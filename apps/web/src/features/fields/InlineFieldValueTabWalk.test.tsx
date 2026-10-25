import type { TaskFieldValueDto } from '@workloom/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { alpha, alphaMembers, anna, installFakeApi, ok, type FakeRequest } from '../../test/fakeApi';
import { task } from '../planning/test/fixtures';
import { InlineFieldValueCell } from './InlineFieldValueCell';
import { useSetTaskFieldValueMutation } from './queries';
import { FIELD_ID, OTHER_FIELD_ID, STAMP, field, renderFieldUi } from './test/fixtures';
import { useFieldValueDrafts } from './useFieldValueDrafts';

const estimate = { ...field('Hours Est', 'number', FIELD_ID), projectId: task.projectId };
const fact = { ...field('Hours Fact', 'number', OTHER_FIELD_ID), projectId: task.projectId };
const path = (id: string) => `PUT /api/v1/workspaces/${alpha.id}/tasks/${task.id}/field-values/${id}`;

function row(definition: typeof estimate, value: TaskFieldValueDto['value'], revision: number): TaskFieldValueDto {
  return { workspaceId: alpha.id, projectId: task.projectId, taskId: task.id, fieldId: definition.id, definitionVersionId: definition.definitionVersionId, revision, value, updatedAt: STAMP };
}

function setup() {
  const api = installFakeApi({
    [path(FIELD_ID)]: (request: FakeRequest) => ok(row(estimate, (request.body as { value: TaskFieldValueDto['value'] }).value, 1)),
  });
  function Harness() {
    const mutation = useSetTaskFieldValueMutation(anna.id, alpha.id);
    const owner = useFieldValueDrafts(anna.id, alpha.id, task.projectId, mutation);
    const cell = (definition: typeof estimate) => (
      <td><InlineFieldValueCell actorId={anna.id} workspaceId={alpha.id} task={task} field={definition} value={null} members={alphaMembers}
        writable mutation={mutation} drafts={owner.current} onMoreDetails={() => undefined} /></td>
    );
    return <table><tbody><tr>{cell(estimate)}{cell(fact)}</tr></tbody></table>;
  }
  renderFieldUi(<Harness />);
  return api;
}

afterEach(() => vi.unstubAllGlobals());

describe('Tab between custom field cells', () => {
  it('saves the typed value and opens the next cell ready for typing, even while the save runs', async () => {
    const api = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: `Edit Hours Est for ${task.title}` }));
    await user.keyboard('5');
    await user.keyboard('{Tab}');
    const next = await screen.findByRole('textbox', { name: `Edit Hours Fact for ${task.title}` });
    await waitFor(() => expect(next).toHaveFocus());
    await user.keyboard('3');
    expect(next).toHaveValue('3');
    expect(api.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
  });

  it('Tab on an untouched cell just moves on and opens the next one', async () => {
    setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: `Edit Hours Est for ${task.title}` }));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab' });
    expect(await screen.findByRole('textbox', { name: `Edit Hours Fact for ${task.title}` })).toBeInTheDocument();
  });
});
