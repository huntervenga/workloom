import type { TaskDto } from '@workloom/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TaskTable, type TaskTableProps } from './TaskTable';
import { makeMember, makeSection, makeTag, makeTask, participant, statuses } from './taskTableFixtures';

const design = makeSection({ id: 'sec-design', name: 'Дизайн', position: 1 });
const analytics = makeSection({ id: 'sec-analytics', name: 'Аналитика', position: 0 });

const anna = makeMember({ id: 'm-anna', userId: 'u-anna', displayName: 'Анна Ковалёва' });
const boris = makeMember({ id: 'm-boris', userId: 'u-boris', displayName: 'Борис Петров' });

function renderTable(props: Partial<TaskTableProps> & Pick<TaskTableProps, 'tasks'>) {
  const handlers = {
    onOpenTask: vi.fn<(taskId: string) => void>(),
    onCreateTask: vi.fn<(sectionId?: string | null) => void>(),
    onCreateChild: vi.fn<(parent: TaskDto) => void>(),
  };
  render(
    <TaskTable sections={[design, analytics]} statuses={statuses} members={[anna, boris]} {...handlers} {...props} />,
  );
  return handlers;
}

function rowOf(title: string): HTMLElement {
  const row = screen.getByRole('button', { name: title }).closest('tr');
  if (row === null) throw new Error(`No row for ${title}`);
  return row;
}

/** Add subtask lives in the row's Task actions menu. */
async function openTaskActions(user: ReturnType<typeof userEvent.setup>, title: string): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: `Task actions: ${title}` }));
  return screen.findByRole('menu');
}

function summaryRow(): HTMLElement {
  const row = screen.getByText("Loaded team budget").closest('tr');
  if (row === null) throw new Error('No summary row');
  return row;
}

const launch = makeTask({
  id: 'launch',
  title: 'Запуск сайта',
  sectionId: analytics.id,
  workPackageId: 'wp-launch',
  estimateMinutes: 600,
  participants: [participant(anna.id), participant(boris.id)],
});
const layout = makeTask({
  id: 'layout',
  title: 'Вёрстка',
  parentTaskId: 'launch',
  sectionId: design.id,
  workPackageId: 'wp-launch',
  estimateMinutes: 600,
  position: 0,
});
const copy = makeTask({
  id: 'copy',
  title: 'Тексты',
  parentTaskId: 'launch',
  sectionId: analytics.id,
  workPackageId: 'wp-launch',
  estimateMinutes: 600,
  position: 1,
});

describe('TaskTable hierarchy', () => {
  it('collapses and expands subtasks, keeping focus on the toggle and the total unchanged', async () => {
    const user = userEvent.setup();
    renderTable({ tasks: [copy, launch, layout] });

    // A child stays under its parent even though it belongs to another section.
    expect(within(rowOf('Вёрстка')).getByText("Section: Дизайн")).toBeInTheDocument();
    expect(within(summaryRow()).getByText("10h")).toBeInTheDocument();

    const collapse = screen.getByRole('button', { name: "Collapse subtasks of “Запуск сайта”" });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    await user.click(collapse);

    expect(screen.queryByRole('button', { name: 'Вёрстка' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Тексты' })).not.toBeInTheDocument();
    const expand = screen.getByRole('button', { name: "Expand subtasks of “Запуск сайта”" });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(expand).toHaveFocus();
    expect(within(summaryRow()).getByText("10h")).toBeInTheDocument();
    expect(within(summaryRow()).getByText(/Loaded: 3 tasks/)).toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Вёрстка' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Collapse subtasks of “Запуск сайта”" })).toHaveFocus();
  });

  it('marks rows sharing one work package and counts that budget once', () => {
    renderTable({ tasks: [launch, layout, copy] });

    for (const title of ['Запуск сайта', 'Вёрстка', 'Тексты']) {
      expect(within(rowOf(title)).getByText("shared")).toBeInTheDocument();
    }
    expect(within(summaryRow()).getByText("10h")).toBeInTheDocument();
  });

  it('groups root tasks by section position, then «Без раздела»', () => {
    const { container } = render(
      <TaskTable
        tasks={[
          makeTask({ id: 'loose', title: 'Без привязки' }),
          makeTask({ id: 'mockups', title: 'Макеты', sectionId: design.id }),
          makeTask({ id: 'metrics', title: 'Метрики', sectionId: analytics.id }),
        ]}
        sections={[design, analytics]}
        statuses={statuses}
        members={[]}
        onOpenTask={vi.fn()}
        onCreateTask={vi.fn()}
        onCreateChild={vi.fn()}
      />,
    );

    const headers = [...container.querySelectorAll('tbody > tr:first-child > th')].map((th) => th.textContent ?? '');
    expect(headers).toHaveLength(3);
    expect(headers[0]).toMatch(/^Аналитика/);
    expect(headers[1]).toMatch(/^Дизайн/);
    expect(headers[2]).toMatch(/^No section/);
  });

  it('shows a subtask whose parent was filtered out instead of dropping it', () => {
    renderTable({
      tasks: [makeTask({ id: 'orphan', title: 'Проверить формы', parentTaskId: 'filtered-out', estimateMinutes: 45 })],
      partial: true,
    });

    expect(within(rowOf('Проверить формы')).getByText("Subtask")).toBeInTheDocument();
    expect(within(summaryRow()).getByText("45m")).toBeInTheDocument();
    expect(within(summaryRow()).getByText(/Budget covers loaded tasks only/)).toBeInTheDocument();
  });

  it('renders every task of a parent cycle once without looping', () => {
    renderTable({
      tasks: [
        makeTask({ id: 'cyc-a', title: 'Цикл А', parentTaskId: 'cyc-b' }),
        makeTask({ id: 'cyc-b', title: 'Цикл Б', parentTaskId: 'cyc-a' }),
        makeTask({ id: 'cyc-d', title: 'Потомок', parentTaskId: 'cyc-a' }),
      ],
    });

    for (const title of ['Цикл А', 'Цикл Б', 'Потомок']) {
      expect(screen.getAllByRole('button', { name: title })).toHaveLength(1);
    }
    expect(screen.getAllByText("Hierarchy cycle")).toHaveLength(1);
  });
});

describe('TaskTable people, tags and budget', () => {
  it('matches members by membership ID and hides removed participants', () => {
    renderTable({
      tasks: [
        makeTask({
          id: 'task',
          title: 'Согласовать бриф',
          // A user ID is not a membership ID; it must not resolve to Boris.
          responsibleMembershipId: boris.userId,
          participants: [participant(anna.id), participant(boris.id, false)],
        }),
      ],
    });

    const row = rowOf('Согласовать бриф');
    expect(within(row).getByText("Member unavailable")).toBeInTheDocument();
    expect(within(row).getByText('Анна Ковалёва')).toBeInTheDocument();
    expect(within(row).queryByText('Борис Петров')).not.toBeInTheDocument();
  });

  it('shows archived tags as archived, with their own names', () => {
    renderTable({
      tasks: [
        makeTask({
          id: 'task',
          title: 'Обновить прайс',
          tags: [makeTag({ id: 'tag-old', name: 'Акция-2025', archivedAt: '2026-01-10T00:00:00Z' })],
        }),
      ],
    });

    const row = rowOf('Обновить прайс');
    expect(within(row).getByText('Акция-2025')).toBeInTheDocument();
    expect(within(row).getByText("(archived)")).toBeInTheDocument();
    expect(within(row).getByText("Акция-2025").closest("[data-tag-badge]")).toHaveAttribute("data-tag-badge", "tag-old");
  });

  it('withholds the total when loaded copies of one package disagree', () => {
    renderTable({
      tasks: [
        makeTask({ id: 'p', title: 'Родитель', workPackageId: 'wp-x', workPackageRevision: 2, estimateMinutes: 60 }),
        makeTask({
          id: 'c',
          title: 'Деталь',
          parentTaskId: 'p',
          workPackageId: 'wp-x',
          workPackageRevision: 2,
          estimateMinutes: 120,
        }),
      ],
    });

    expect(within(summaryRow()).getByText("Total unavailable")).toBeInTheDocument();
    expect(within(summaryRow()).getByText(/Refresh data/)).toBeInTheDocument();
    expect(within(summaryRow()).queryByText("3h")).not.toBeInTheDocument();
  });
});

describe('TaskTable actions', () => {
  it('offers create actions only when writable', async () => {
    const user = userEvent.setup();
    renderTable({ tasks: [launch], onRenameSection: vi.fn() });

    expect(screen.queryByRole('button', { name: /Add/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rename/ })).not.toBeInTheDocument();
    expect(within(await openTaskActions(user, launch.title)).queryByRole('menuitem', { name: 'Add subtask' })).not.toBeInTheDocument();
  });

  it('passes the real task and section to the parent callbacks', async () => {
    const user = userEvent.setup();
    const onRenameSection = vi.fn();
    const handlers = renderTable({ tasks: [launch, layout], writable: true, onRenameSection });

    await user.click(within(await openTaskActions(user, 'Запуск сайта')).getByRole('menuitem', { name: 'Add subtask' }));
    expect(handlers.onCreateChild).toHaveBeenCalledWith(launch);

    await user.click(screen.getByRole('button', { name: "Add task to “Дизайн”" }));
    expect(handlers.onCreateTask).toHaveBeenCalledWith(design.id);

    await user.click(screen.getByRole('button', { name: "Rename section “Аналитика”" }));
    expect(onRenameSection).toHaveBeenCalledWith(analytics);

    screen.getByRole('button', { name: 'Вёрстка' }).focus();
    await user.keyboard(' ');
    expect(handlers.onOpenTask).toHaveBeenCalledWith('layout');
  });

  it('does not offer a subtask under an archived task', async () => {
    const user = userEvent.setup();
    const archived = makeTask({ id: 'old', title: 'Старый запуск', archivedAt: '2026-10-05T09:00:00Z' });
    renderTable({ tasks: [launch, archived], writable: true });

    expect(within(await openTaskActions(user, 'Запуск сайта')).getByRole('menuitem', { name: 'Add subtask' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(within(await openTaskActions(user, 'Старый запуск')).queryByRole('menuitem', { name: 'Add subtask' })).not.toBeInTheDocument();
  });
});

describe('TaskTable everyday columns', () => {
  it('preserves task identity, budget totals and supplied weekly columns across compact and expanded views', () => {
    const task = makeTask({ id: 'daily-row', title: 'Daily task', estimateMinutes: 90, tags: [makeTag({ id: 'daily-tag', name: 'Stored label' })] });
    const props: TaskTableProps = {
      tasks: [task], sections: [], statuses, members: [anna], onOpenTask: vi.fn(), onCreateTask: vi.fn(), onCreateChild: vi.fn(),
      customColumns: [{ id: 'weekly-plan', label: 'Personal weekly plan', width: 140, renderCell: () => '45m' }],
    };
    const view = render(<TaskTable {...props} columnPreset="compact" />);
    expect(screen.getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Task', 'Status', 'Assignee', 'Due date', 'Personal weekly plan', 'Team estimate']);
    expect(within(rowOf('Daily task')).getByText('45m')).toBeInTheDocument();
    expect(within(summaryRow()).getByText('1h 30m')).toBeInTheDocument();
    expect(screen.queryByText('Stored label')).not.toBeInTheDocument();
    view.rerender(<TaskTable {...props} columnPreset="expanded" />);
    expect(screen.getByRole('columnheader', { name: 'Participants' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Tags' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Priority' })).toBeInTheDocument();
    expect(within(rowOf('Daily task')).getByText('Stored label')).toBeInTheDocument();
    expect(within(summaryRow()).getByText('1h 30m')).toBeInTheDocument();
  });
});

describe('TaskTable inline edit boundaries', () => {
  it.each([
    { name: 'meeting', patch: { meetingId: 'e9000000-0000-4000-8000-000000000001' } },
    { name: 'archived', patch: { archivedAt: '2026-10-16T10:00:00.000Z' } },
    { name: 'unknown type', patch: { meetingId: undefined } },
  ])('keeps $name rows out of ordinary cell edits', ({ patch }) => {
    const onEditTaskField = vi.fn();
    renderTable({ tasks: [makeTask({ id: 'guarded-row', title: 'Guarded task', ...patch })], writable: true, onEditTaskField });
    expect(screen.queryByRole('button', { name: 'Rename Guarded task' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit status for Guarded task' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit assignee for Guarded task' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit due date for Guarded task' })).not.toBeInTheDocument();
    expect(onEditTaskField).not.toHaveBeenCalled();
  });
});

it('renders exact personal column order and keeps package totals independent of estimate position', () => {
  const custom = { id: 'custom-note', label: 'Stored custom label', width: 160, renderCell: () => 'Stored custom value' };
  renderTable({ tasks: [launch, layout], columnIds: ['title', 'estimate', 'custom-note', 'responsible', 'status'], customColumns: [custom] });
  expect(screen.getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Task', 'Team estimate', 'Stored custom label', 'Assignee', 'Status']);
  const cells = within(rowOf(launch.title)).getAllByRole('cell');
  expect(cells).toHaveLength(5); expect(cells[1]).toHaveTextContent('10h'); expect(cells[2]).toHaveTextContent('Stored custom value');
  expect(within(summaryRow()).getAllByRole('cell')).toHaveLength(1);
  expect(within(summaryRow()).getByRole('cell')).toHaveAttribute('colspan', '5');
  expect(within(summaryRow()).getByText('10h')).toBeInTheDocument();
});

it('keeps a one-column personal view usable without forcing the old full table width or hiding budget provenance', () => {
  renderTable({ tasks: [launch], columnIds: ['title'] });
  expect(screen.getAllByRole('columnheader')).toHaveLength(1);
  expect(screen.getByRole('table')).toHaveStyle({ minWidth: 'calc(var(--task-title-width, clamp(280px, 42cqw, 460px)) + 0px)' });
  expect(within(summaryRow()).getByRole('cell')).toHaveAttribute('colspan', '1');
  expect(within(summaryRow()).getByText('Loaded team budget')).toBeInTheDocument();
});

describe('section disclosure', () => {
  it('uses one native keyboard disclosure and hides the complete root group without changing loaded totals or callbacks', async () => {
    const user = userEvent.setup();
    const onSelectTask = vi.fn();
    const complete = vi.fn();
    renderTable({ tasks: [launch, layout, copy], partial: true, writable: true, onSelectTask, renderCompletionAction: task => <button onClick={complete}>Complete QA {task.title}</button> });
    const toggle = screen.getByRole('button', { name: 'Collapse section “Аналитика”' });
    const header = toggle.closest('th'); if (!header) throw new Error('Missing section header');
    expect(header).toHaveTextContent('loaded: 3 tasks');
    toggle.focus(); await user.keyboard('{Enter}');
    expect(screen.queryByRole('button', { name: launch.title })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: layout.title })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.title })).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false'); expect(toggle).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Add task to “Аналитика”' })).toBeVisible();
    expect(header).toHaveTextContent('loaded: 3 tasks'); expect(summaryRow()).toHaveTextContent('10h'); expect(summaryRow()).toHaveTextContent('Loaded: 3 tasks');
    expect(onSelectTask).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
    await user.keyboard(' '); expect(screen.getByRole('button', { name: layout.title })).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true'); expect(toggle).toHaveFocus();
  });

  it('keeps descendant collapse separate and expands a standalone section on Add task', async () => {
    const user = userEvent.setup(); const handlers = renderTable({ tasks: [launch, layout, copy], writable: true });
    await user.click(screen.getByRole('button', { name: 'Collapse subtasks of “Запуск сайта”' }));
    await user.click(screen.getByRole('button', { name: 'Collapse section “Аналитика”' }));
    await user.click(screen.getByRole('button', { name: 'Add task to “Аналитика”' }));
    expect(handlers.onCreateTask).toHaveBeenCalledWith(analytics.id);
    expect(screen.getByRole('button', { name: 'Expand subtasks of “Запуск сайта”' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: layout.title })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand subtasks of “Запуск сайта”' }));
    expect(screen.getByRole('button', { name: layout.title })).toBeInTheDocument();
  });

  it('supports unavailable, unsectioned, archived and empty groups without enabling forbidden actions', async () => {
    const user = userEvent.setup();
    const archived = makeSection({ id: 'archived', name: 'Old section', archivedAt: '2026-10-01T00:00:00Z' });
    renderTable({ tasks: [makeTask({ id: 'missing-root', title: 'Unknown section task', sectionId: 'missing-a' }), makeTask({ id: 'loose', title: 'Loose task' }), makeTask({ id: 'old', title: 'Old task', sectionId: archived.id })], sections: [design, archived], writable: true });
    for (const name of ['Section unavailable', 'No section', 'Old section', design.name]) {
      const toggle = screen.getByRole('button', { name: `Collapse section “${name}”` }); await user.click(toggle); expect(toggle).toHaveAttribute('aria-expanded', 'false');
    }
    expect(screen.queryByRole('button', { name: 'Unknown section task' })).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Loose task' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add task to “Old section”' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add task to “Section unavailable”' })).not.toBeInTheDocument();
    expect(screen.queryByText('No tasks yet')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: `Expand section “${design.name}”` })); expect(screen.getByText('No tasks yet')).toBeVisible();
  });

  it('distinguishes duplicate section names and multiple unavailable groups without exposing IDs', () => {
    renderTable({ tasks: [makeTask({ id: 'a', sectionId: 'unknown-a' }), makeTask({ id: 'b', sectionId: 'unknown-b' })], sections: [makeSection({ id: 'one', name: 'Same section' }), makeSection({ id: 'two', name: 'Same section' })] });
    for (const [index, name] of ['Same section', 'Same section', 'Section unavailable', 'Section unavailable'].entries()) expect(screen.getByRole('button', { name: `Collapse section ${index + 1} “${name}”` })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('unknown-a'); expect(document.body).not.toHaveTextContent('unknown-b');
  });
});

describe('TaskTable assignee grouping', () => {
  it('keeps loaded parent/own section context in flat rows and counts each shared package once', async () => {
    const user = userEvent.setup();
    const parent = { ...launch, responsibleMembershipId: anna.id };
    const child = { ...layout, responsibleMembershipId: boris.id };
    renderTable({ tasks: [parent, child], grouping: 'assignee', writable: true, quickAdd: { sectionId: null, content: <span>Unexpected quick row</span> } });
    expect(screen.getAllByRole('button', { name: parent.title })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: child.title })).toHaveLength(1);
    expect(rowOf(child.title)).toHaveTextContent(`Section: ${design.name} · Subtask of ${parent.title}`);
    expect(screen.queryByTitle('Parent task is outside the loaded set')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /subtasks of/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add task to|Add task without|Rename section/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Unexpected quick row')).not.toBeInTheDocument();
    expect(summaryRow()).toHaveTextContent('10h');
    expect(within(await openTaskActions(user, child.title)).getByRole('menuitem', { name: 'Add subtask' })).not.toHaveAttribute('aria-disabled');
  });

  it('distinguishes unavailable member groups and honestly describes unloaded parents', async () => {
    const user = userEvent.setup();
    renderTable({ tasks: [makeTask({ id: 'first', title: 'First unknown', responsibleMembershipId: 'missing-one', parentTaskId: 'not-loaded' }), makeTask({ id: 'second', title: 'Second unknown', responsibleMembershipId: 'missing-two' })], grouping: 'assignee', partial: true });
    const buttons = screen.getAllByRole('button', { name: /Collapse assignee group.*Member unavailable/ });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.getAttribute('aria-label')).not.toBe(buttons[1]?.getAttribute('aria-label'));
    expect(rowOf('First unknown')).toHaveTextContent('Subtask (parent not loaded)');
    const first = buttons[0];
    if (!first) throw new Error('Missing first assignee group');
    await user.click(first);
    expect(screen.queryByRole('button', { name: 'First unknown' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Second unknown' })).toBeInTheDocument();
  });

  it('shows an honest empty loaded view without inventing empty member groups', () => {
    renderTable({ tasks: [], grouping: 'assignee' });
    expect(screen.getByText('No loaded tasks match this view.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /assignee group/ })).not.toBeInTheDocument();
  });
});

describe('TaskTable Asana-style add rows', () => {
  it('closes each expanded writable section with one persistent Add task row and keeps the header add only for collapsed groups', async () => {
    const user = userEvent.setup();
    const archived = makeSection({ id: 'old-section', name: 'Old section', archivedAt: '2026-10-01T00:00:00Z' });
    const handlers = renderTable({ tasks: [launch, makeTask({ id: 'old-row', title: 'Old row', sectionId: archived.id })], sections: [design, analytics, archived], writable: true });
    const analyticsRow = screen.getByRole('button', { name: 'Add task to “Аналитика”' });
    expect(analyticsRow.closest('th')).toBeNull();
    expect(analyticsRow).toHaveTextContent('Add task…');
    // The add row is the last row of its section, after the loaded tasks.
    const body = analyticsRow.closest('tbody');
    expect(body?.lastElementChild).toBe(analyticsRow.closest('tr'));
    expect(within(body as HTMLElement).getByRole('button', { name: launch.title })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add task to “Дизайн”' }).closest('th')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add task to “Old section”' })).not.toBeInTheDocument();
    await user.click(analyticsRow);
    expect(handlers.onCreateTask).toHaveBeenCalledWith(analytics.id);
    await user.click(screen.getByRole('button', { name: 'Collapse section “Аналитика”' }));
    const header = screen.getByRole('button', { name: 'Add task to “Аналитика”' });
    expect(header.closest('th')).not.toBeNull();
    expect(screen.getAllByRole('button', { name: 'Add task to “Аналитика”' })).toHaveLength(1);
  });

  it('replaces only the target section add row with the supplied quick row at the end of that section', () => {
    renderTable({ tasks: [launch], writable: true, quickAdd: { sectionId: analytics.id, content: <span>Quick row content</span> } });
    const quick = screen.getByText('Quick row content').closest('tr');
    expect(quick).toHaveAttribute('data-quick-add-row');
    expect(quick?.className).toContain('h-10');
    expect(quick?.parentElement?.lastElementChild).toBe(quick);
    expect(screen.queryByRole('button', { name: 'Add task to “Аналитика”' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add task to “Дизайн”' })).toBeInTheDocument();
  });

  it('separates in-place rename on the name from the details action', async () => {
    const user = userEvent.setup();
    const onEditTaskField = vi.fn();
    const handlers = renderTable({ tasks: [launch], writable: true, onEditTaskField });
    await user.click(screen.getByRole('button', { name: launch.title }));
    expect(onEditTaskField).toHaveBeenCalledExactlyOnceWith(launch, 'title');
    expect(handlers.onOpenTask).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: `Open task “${launch.title}”` }));
    expect(handlers.onOpenTask).toHaveBeenCalledExactlyOnceWith(launch.id);
    expect(onEditTaskField).toHaveBeenCalledTimes(1);
  });
});


describe('TaskTable column and section entry points', () => {
  it('keeps the header add control, ordinary rows, drafts and spanning rows in the same grid', () => {
    renderTable({ tasks: [launch], writable: true, showLegacySummary: false, columnIds: ['title', 'status'], columnMenu: <button>Add or show columns</button>, quickAdd: { sectionId: analytics.id, render: row => row('draft')(id => <span>{id === 'title' ? 'New title' : 'New status'}</span>) } });
    expect(screen.getAllByRole('columnheader')).toHaveLength(3);
    expect(within(rowOf(launch.title)).getAllByRole('cell')).toHaveLength(3);
    const draft = screen.getByText('New title').closest('tr');
    expect(within(draft as HTMLElement).getAllByRole('cell')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Collapse section “Аналитика”' }).closest('th')).toHaveAttribute('colspan', '3');
    expect(screen.getByRole('button', { name: 'Add or show columns' }).closest('th')).toBe(screen.getAllByRole('columnheader').at(-1));
  });

  it('offers Add section after the last group and delegates creation in either grouping', async () => {
    const user = userEvent.setup(); const onCreateSection = vi.fn();
    renderTable({ tasks: [launch], writable: true, grouping: 'assignee', onCreateSection });
    const add = screen.getByRole('button', { name: 'Add section' });
    const bodies = screen.getByRole('table').querySelectorAll('tbody');
    expect(add.closest('tbody')).toBe(bodies[bodies.length - 1]);
    await user.click(add); expect(onCreateSection).toHaveBeenCalledOnce();
  });

  it('replaces the bottom Add section action with its active composer', () => {
    renderTable({ tasks: [launch], writable: true, onCreateSection: vi.fn(), sectionComposer: <input aria-label="Section name" /> });
    expect(screen.queryByRole('button', { name: 'Add section' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Section name' })).toBeInTheDocument();
  });
});
