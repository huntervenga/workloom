import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { alpha, alphaMembers, anna, installFakeApi, ok, project } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { GanttView } from './GanttView';
import { useScheduleWorkspace } from './useScheduleWorkspace';
import { PROJECT_ID, scheduleContext, scheduledTask, schedulePath } from './test/fixtures';

const firstTask = scheduledTask(1, '2026-10-24', '2026-10-26');
const tasks = [firstTask, scheduledTask(2, '2026-10-25', '2026-10-27')];
function mount(selectedIds: string[] = [firstTask.id]) {
  const changed = vi.fn();
  installFakeApi({ [`GET ${schedulePath}/schedule-context`]: () => ok(scheduleContext(tasks)) });
  function Host({ locked }: { locked: boolean }) {
    const controller = useScheduleWorkspace(anna.id, alpha.id, PROJECT_ID, alpha.timezone);
    return <MemoryRouter><GanttView actorId={anna.id} workspace={alpha} project={project(alpha.id, PROJECT_ID, 'Timeline selection')} tasks={tasks} tasksSettled selectedIds={selectedIds} onSelect={changed}
      selectionDisabled={locked} periods={[]} members={alphaMembers} controller={controller} writable={!locked} hasMore={false} loadingMore={false} onLoadMore={() => undefined} onOpen={() => undefined} /></MemoryRouter>;
  }
  const ui = renderFieldUi(<Host locked />);
  return { ...ui, changed, unlock: () => ui.rerender(<QueryClientProvider client={ui.client}><Host locked={false} /></QueryClientProvider>) };
}

describe('native Timeline selection lock', () => {
  it('disables selected and unselected checkboxes while held and restores selection and date controls after release', async () => {
    const ui = mount(); const first = tasks[0], second = tasks[1];
    if (!first || !second) throw new Error('Expected two timeline fixtures');
    const selected = await screen.findByRole('checkbox', { name: `Select dates: ${first.title}` });
    const unselected = screen.getByRole('checkbox', { name: `Select dates: ${second.title}` });
    expect(selected).toBeChecked(); expect(unselected).not.toBeChecked();
    expect(selected).toBeDisabled(); expect(unselected).toBeDisabled();
    await ui.user.click(selected); await ui.user.click(unselected); expect(ui.changed).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Edit dates' })).not.toBeInTheDocument();
    expect(document.querySelector('[data-gantt-movable]')).toBeNull();
    ui.unlock();
    await waitFor(() => expect(selected).toBeEnabled()); expect(unselected).toBeEnabled();
    await ui.user.click(unselected); expect(ui.changed).toHaveBeenCalledExactlyOnceWith(second.id, true);
    expect(screen.getAllByRole('button', { name: 'Edit dates' })).toHaveLength(2);
  });
  it('preserves the existing 100-task cap when the explicit lock is released', async () => {
    const first = tasks[0], second = tasks[1]; if (!first || !second) throw new Error('Expected timeline fixtures');
    const ui = mount([first.id, ...Array.from({ length: 99 }, (_, index) => `hidden-${index}`)]);
    const selected = await screen.findByRole('checkbox', { name: `Select dates: ${first.title}` });
    const unselected = screen.getByRole('checkbox', { name: `Select dates: ${second.title}` });
    ui.unlock(); expect(selected).toBeEnabled(); expect(unselected).toBeDisabled();
    fireEvent.click(selected); expect(ui.changed).toHaveBeenCalledExactlyOnceWith(first.id, false);
  });
});
