import type { TaskStatusDto } from '@workloom/contracts';
import { act, screen } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { alpha, anna, installFakeApi } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { PROJECT_ID, task } from '../planning/test/fixtures';
import { QuickTaskAdd } from './QuickTaskAdd';
import { useTaskCommands } from './useTaskCommands';

const statuses: TaskStatusDto[] = [{ id: task.statusId, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Todo', group: 'todo', position: 0, revision: 1 }];
const context = { periodId: 'a1000000-0000-4000-8000-000000000001', membershipId: 'b1000000-0000-4000-8000-000000000001', periodName: 'Selected week', memberName: 'Visible person' };
const renderRow = (cell: (id: string) => ReactNode) => <tr><td>{cell('title')}</td><td>{cell('weekly-plan')}</td></tr>;

it('keeps the same typed hours input focused through a background source refresh', async () => {
  const { calls } = installFakeApi({});
  let refreshSource: ((current: boolean) => void) | undefined;
  function Harness() {
    const commands = useTaskCommands(anna.id, alpha.id);
    const [current, setCurrent] = useState(true);
    refreshSource = setCurrent;
    return <table><tbody><QuickTaskAdd projectId={PROJECT_ID} sectionId={null} sectionName="No section" statuses={statuses} commands={commands} writable
      renderRow={renderRow} initialTimeContext={context} initialTimeWritable initialTimeCurrent={current}
      onClose={vi.fn()} onMoreDetails={vi.fn()} onCreated={vi.fn()} /></tbody></table>;
  }
  const { user } = renderFieldUi(<Harness />);
  const input = screen.getByRole('textbox', { name: 'Planned hours for the new task: Selected week, Visible person' }) as HTMLInputElement;
  await user.type(input, '1:30');
  input.setSelectionRange(1, 3);
  expect(input).toHaveFocus();
  act(() => refreshSource?.(false));
  expect(screen.getByRole('textbox', { name: 'Planned hours for the new task: Selected week, Visible person' })).toBe(input);
  expect(input).not.toBeDisabled();
  expect(input).toHaveFocus();
  expect(input).toHaveValue('1:30');
  expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3]);
  act(() => refreshSource?.(true));
  expect(input).toHaveFocus();
  expect(input).toHaveValue('1:30');
  expect(calls).toHaveLength(0);
});
