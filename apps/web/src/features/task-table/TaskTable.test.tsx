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

function summaryRow(): HTMLElement {
  const row = screen.getByText('Оценка загруженных задач').closest('tr');
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
    expect(within(rowOf('Вёрстка')).getByText('Раздел: Дизайн')).toBeInTheDocument();
    expect(within(summaryRow()).getByText('10 ч')).toBeInTheDocument();

    const collapse = screen.getByRole('button', { name: 'Свернуть подзадачи «Запуск сайта»' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    await user.click(collapse);

    expect(screen.queryByRole('button', { name: 'Вёрстка' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Тексты' })).not.toBeInTheDocument();
    const expand = screen.getByRole('button', { name: 'Развернуть подзадачи «Запуск сайта»' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(expand).toHaveFocus();
    expect(within(summaryRow()).getByText('10 ч')).toBeInTheDocument();
    expect(within(summaryRow()).getByText(/Загружено: 3 задачи/)).toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Вёрстка' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Свернуть подзадачи «Запуск сайта»' })).toHaveFocus();
  });

  it('marks rows sharing one work package and counts that budget once', () => {
    renderTable({ tasks: [launch, layout, copy] });

    for (const title of ['Запуск сайта', 'Вёрстка', 'Тексты']) {
      expect(within(rowOf(title)).getByText('общая')).toBeInTheDocument();
    }
    expect(within(summaryRow()).getByText('10 ч')).toBeInTheDocument();
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
    expect(headers[2]).toMatch(/^Без раздела/);
  });

  it('shows a subtask whose parent was filtered out instead of dropping it', () => {
    renderTable({
      tasks: [makeTask({ id: 'orphan', title: 'Проверить формы', parentTaskId: 'filtered-out', estimateMinutes: 45 })],
      partial: true,
    });

    expect(within(rowOf('Проверить формы')).getByText('Подзадача')).toBeInTheDocument();
    expect(within(summaryRow()).getByText('45 мин')).toBeInTheDocument();
    expect(within(summaryRow()).getByText(/часть задач проекта/)).toBeInTheDocument();
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
    expect(screen.getAllByText('Цикл в иерархии')).toHaveLength(1);
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
    expect(within(row).getByText('Участник недоступен')).toBeInTheDocument();
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
    expect(within(row).getByText('· архив')).toBeInTheDocument();
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

    expect(within(summaryRow()).getByText('Итог недоступен')).toBeInTheDocument();
    expect(within(summaryRow()).getByText(/обновите данные/)).toBeInTheDocument();
    expect(within(summaryRow()).queryByText('3 ч')).not.toBeInTheDocument();
  });
});

describe('TaskTable actions', () => {
  it('offers create actions only when writable', () => {
    renderTable({ tasks: [launch], onRenameSection: vi.fn() });

    expect(screen.queryByRole('button', { name: /Добавить/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Переименовать/ })).not.toBeInTheDocument();
  });

  it('passes the real task and section to the parent callbacks', async () => {
    const user = userEvent.setup();
    const onRenameSection = vi.fn();
    const handlers = renderTable({ tasks: [launch, layout], writable: true, onRenameSection });

    await user.click(screen.getByRole('button', { name: 'Добавить подзадачу к «Запуск сайта»' }));
    expect(handlers.onCreateChild).toHaveBeenCalledWith(launch);

    await user.click(screen.getByRole('button', { name: 'Добавить задачу в раздел «Дизайн»' }));
    expect(handlers.onCreateTask).toHaveBeenCalledWith(design.id);

    await user.click(screen.getByRole('button', { name: 'Переименовать раздел «Аналитика»' }));
    expect(onRenameSection).toHaveBeenCalledWith(analytics);

    screen.getByRole('button', { name: 'Вёрстка' }).focus();
    await user.keyboard(' ');
    expect(handlers.onOpenTask).toHaveBeenCalledWith('layout');
  });

  it('does not offer a subtask under an archived task', () => {
    const archived = makeTask({ id: 'old', title: 'Старый запуск', archivedAt: '2026-10-05T09:00:00Z' });
    renderTable({ tasks: [launch, archived], writable: true });

    expect(screen.getByRole('button', { name: 'Добавить подзадачу к «Запуск сайта»' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Добавить подзадачу к «Старый запуск»' })).not.toBeInTheDocument();
  });
});
