import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { alpha, alphaMembers, anna, installFakeApi } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { task } from '../planning/test/fixtures';
import { InlineTaskEdit } from './InlineTaskEdit';
import { useTaskCommands } from './useTaskCommands';

function setup(onDeleteTask: (() => void) | undefined) {
  const onClose = vi.fn();
  function Example() {
    const commands = useTaskCommands(anna.id, alpha.id);
    return <InlineTaskEdit task={task} field="title" statuses={[]} members={alphaMembers} commands={commands} writable
      onClose={onClose} onDeleteTask={onDeleteTask} onMoreDetails={() => undefined} onSaved={() => undefined} />;
  }
  return { ...renderFieldUi(<Example />), onClose };
}

describe('Backspace in an emptied task name deletes the task', () => {
  it('does nothing while the name still has text, then deletes on the next Backspace', async () => {
    installFakeApi({});
    const onDelete = vi.fn();
    const ui = setup(onDelete);
    const input = screen.getByRole('textbox', { name: 'Task name' });
    await ui.user.keyboard('{Backspace}');
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '' } });
    expect(onDelete).not.toHaveBeenCalled();
    await ui.user.keyboard('{Backspace}');
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(ui.onClose).toHaveBeenCalledWith('cancel');
  });

  it('is off when the page offers no delete', async () => {
    installFakeApi({});
    const ui = setup(undefined);
    fireEvent.change(screen.getByRole('textbox', { name: 'Task name' }), { target: { value: '' } });
    await ui.user.keyboard('{Backspace}');
    expect(ui.onClose).not.toHaveBeenCalled();
  });
});
