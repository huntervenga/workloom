import { fireEvent, screen, within } from '@testing-library/react';
import type { TaskDto } from '@workloom/contracts';
import { useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { alpha, alphaMembers, anna, installFakeApi, ok } from '../../test/fakeApi';
import { makeTask } from '../task-table/taskTableFixtures';
import { TaskCustomFields, type FieldValueDraftStore } from './TaskCustomFields';
import { useSetTaskFieldValueMutation } from './queries';
import { PROJECT_ID, field, fieldsPath, renderFieldUi } from './test/fixtures';

const taskA = makeTask({ id: 'f0000000-0000-4000-8000-000000000001', workspaceId: alpha.id, projectId: PROJECT_ID, title: 'Задача А' });
const taskB = makeTask({ id: 'f0000000-0000-4000-8000-000000000002', workspaceId: alpha.id, projectId: PROJECT_ID, title: 'Задача Б' });

function DraftPage() {
  const mutation = useSetTaskFieldValueMutation(anna.id, alpha.id);
  const drafts = useRef<FieldValueDraftStore>(new Map());
  const [task, setTask] = useState<TaskDto | null>(taskA);
  return (
    <>
      <button onClick={() => setTask(taskA)}>Открыть А</button>
      <button onClick={() => setTask(taskB)}>Открыть Б</button>
      <button onClick={() => setTask(null)}>Закрыть карточку</button>
      {task ? (
        <TaskCustomFields
          key={task.id} actorId={anna.id} workspaceId={alpha.id} task={task}
          members={alphaMembers} writable mutation={mutation} draftStore={drafts.current}
          onOpenTask={(id) => setTask(id === taskA.id ? taskA : taskB)}
        />
      ) : null}
    </>
  );
}

describe('custom field draft ownership', () => {
  it('keeps independent invalid unsent drafts through A edit → close card → B edit → A', async () => {
    const { calls } = installFakeApi({
      ['GET ' + fieldsPath]: () => ok([field('Заметка', 'number')]),
      ['GET /api/v1/workspaces/' + alpha.id + '/tasks/' + taskA.id + '/field-values']: () => ok([]),
      ['GET /api/v1/workspaces/' + alpha.id + '/tasks/' + taskB.id + '/field-values']: () => ok([]),
    });
    const { user } = renderFieldUi(<DraftPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit Заметка for Задача А' }));
    expect(screen.queryByRole('dialog', { name: 'Value of “Заметка”' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit Заметка for Задача А' }), { target: { value: 'Черновик А' } });
    await user.click(screen.getByRole('button', { name: 'Закрыть карточку' }));
    await user.click(screen.getByRole('button', { name: 'Открыть Б' }));
    await user.click(await screen.findByRole('button', { name: 'Edit Заметка for Задача Б' }));
    expect(screen.getByRole('textbox', { name: 'Edit Заметка for Задача Б' })).toHaveValue('');
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit Заметка for Задача Б' }), { target: { value: 'Черновик Б' } });
    await user.click(screen.getByRole('button', { name: 'Закрыть карточку' }));
    await user.click(screen.getByRole('button', { name: 'Открыть А' }));
    await user.click(await screen.findByRole('button', { name: /Заметка for Задача А has an unsaved draft/ }));
    let dialog = screen.getByRole('dialog', { name: 'Value of “Заметка”' });
    expect(within(dialog).getByRole('textbox', { name: 'Заметка' })).toHaveValue('Черновик А');
    await user.click(within(dialog).getByLabelText('Close', { selector: 'button' }));
    expect(within(dialog).getByText('Enter a number, such as 12 or 3.5.')).toBeInTheDocument();
    await user.click(within(dialog).getByLabelText('Close', { selector: 'button' }));
    await user.click(screen.getByRole('button', { name: 'Открыть Б' }));
    await user.click(await screen.findByRole('button', { name: /Заметка for Задача Б has an unsaved draft/ }));
    dialog = screen.getByRole('dialog', { name: 'Value of “Заметка”' });
    expect(within(dialog).getByRole('textbox', { name: 'Заметка' })).toHaveValue('Черновик Б');
    expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
  });
});
