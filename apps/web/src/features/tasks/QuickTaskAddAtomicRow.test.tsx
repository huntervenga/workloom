import type { TaskDto, TaskStatusDto } from '@workloom/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { alpha, alphaMembers, anna, created, installFakeApi } from '../../test/fakeApi';
import { field, renderFieldUi } from '../fields/test/fixtures';
import { PROJECT_ID, rootPath, task } from '../planning/test/fixtures';
import { emptyInitialTaskCellsDraft, setInitialHours, stageInitialField, type InitialTimeContext } from './InitialTaskCells';
import { QuickTaskAdd, QuickTaskDraftPreview } from './QuickTaskAdd';
import { freshQuickSession } from './tableEditing';
import { useTaskCommands, type CreateRequest, type CreateSession, type TaskCommands } from './useTaskCommands';

const SECTION = 'e1000000-0000-4000-8000-000000000001';
const X_ID = 'f2000000-0000-4000-8000-0000000000e1';
const FLAG_ID = '90000000-0000-4000-8000-0000000000f1';
const POINTS_ID = '90000000-0000-4000-8000-0000000000f2';
const PERIOD_A = 'a1000000-0000-4000-8000-000000000001';
const PERIOD_B = 'a1000000-0000-4000-8000-000000000002';
const MEMBER_A = 'b1000000-0000-4000-8000-000000000001';
const MEMBER_B = 'b1000000-0000-4000-8000-000000000002';
const PACKAGE_ID = 'c1000000-0000-4000-8000-000000000001';
const statuses: TaskStatusDto[] = [{ id: task.statusId, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored todo', group: 'todo', position: 0, revision: 1 }];
const flag = field('Flag', 'boolean', FLAG_ID);
const points = field('Points', 'number', POINTS_ID);
const weekA: InitialTimeContext = { periodId: PERIOD_A, membershipId: MEMBER_A, periodName: 'Week 43', memberName: 'Anna Stored' };
const weekB: InitialTimeContext = { periodId: PERIOD_B, membershipId: MEMBER_B, periodName: 'Week 44', memberName: 'Boris Stored' };
const columns = ['title', 'status', 'estimate', FLAG_ID, POINTS_ID, 'weekly-plan', 'weekly-fact'];
const renderRow = (renderCell: (columnId: string) => ReactNode) => <tr data-testid="draft-row">{columns.map(column => <td key={column} data-column={column}>{renderCell(column)}</td>)}</tr>;
const cell = (column: string) => screen.getByTestId('draft-row').querySelector(`[data-column="${column}"]`) as HTMLElement;
const rowsPath = `POST ${rootPath}/tasks/rows`;
const rowCreated = (body: unknown, extra: Partial<TaskDto> = {}) => created({ task: { ...task, id: X_ID, title: (body as { task: { title: string } }).task.title, ...extra }, fields: [] });
const planned = (context: InitialTimeContext) => screen.getByRole('textbox', { name: `Planned hours for the new task: ${context.periodName}, ${context.memberName}` });
const actual = (context: InitialTimeContext) => screen.getByRole('textbox', { name: `Actual hours for the new task: ${context.periodName}, ${context.memberName}` });

function lost() {
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<Response>((_resolve, fail) => { reject = fail; });
  return { promise, lose: () => reject(new TypeError('Failed to fetch')) };
}

function atomicRow(options: { request?: CreateRequest; context?: InitialTimeContext | null; open?: boolean } = {}) {
  const onCreated = vi.fn();
  let current: TaskCommands | null = null;
  function Example() {
    const commands = useTaskCommands(anna.id, alpha.id);
    current = commands;
    const [open, setOpen] = useState(options.open ?? true);
    const [context, setContext] = useState<InitialTimeContext | null>(options.context === undefined ? weekA : options.context);
    return <>
      <table><tbody>{open ? <QuickTaskAdd projectId={PROJECT_ID} sectionId={SECTION} sectionName="Stored section" statuses={statuses} members={alphaMembers} commands={commands} writable
        request={options.request} renderRow={renderRow} initialFields={[flag, points]} initialTimeContext={context} initialTimeWritable initialTimeCurrent
        onClose={() => setOpen(false)} onMoreDetails={vi.fn()} onCreated={onCreated} /> : null}</tbody></table>
      <button onClick={() => setOpen(true)}>Open atomic row</button>
      <button onClick={() => setContext(weekB)}>Show another week and person</button>
    </>;
  }
  const view = renderFieldUi(<Example />);
  return { ...view, onCreated, commands: () => { if (!current) throw new Error('No command harness'); return current; } };
}

type Ui = ReturnType<typeof atomicRow>;

async function stageFlagNo(ui: Ui) {
  await ui.user.click(screen.getByRole('button', { name: 'Flag for the new task' }));
  const dialog = await screen.findByRole('dialog', { name: 'Flag for the new task' });
  const checkbox = within(dialog).getByRole('checkbox', { name: 'Flag' });
  expect(checkbox).toBePartiallyChecked();
  await ui.user.click(checkbox);
  expect(checkbox).toBeChecked();
  await ui.user.click(checkbox);
  expect(checkbox).not.toBeChecked();
  expect(checkbox).not.toBePartiallyChecked();
  await ui.user.click(within(dialog).getByRole('button', { name: 'Done' }));
}

async function stagePoints(ui: Ui, text: string) {
  await ui.user.click(screen.getByRole('button', { name: 'Points for the new task' }));
  const dialog = await screen.findByRole('dialog', { name: 'Points for the new task' });
  const input = within(dialog).getByRole('textbox');
  await ui.user.clear(input);
  await ui.user.type(input, text);
  await ui.user.click(within(dialog).getByRole('button', { name: 'Done' }));
}

async function submitTitle(ui: Ui, title: string) {
  await ui.user.click(screen.getByLabelText('Task name'));
  await ui.user.keyboard(`${title}{Enter}`);
}

describe('quick task row with staged extras', () => {
  it('stages false, zero and zero hours before the title and sends them in one atomic create', async () => {
    const { calls } = installFakeApi({ [rowsPath]: request => rowCreated(request.body) });
    const ui = atomicRow();
    await stageFlagNo(ui);
    await stagePoints(ui, '0');
    await ui.user.type(planned(weekA), '0');
    await ui.user.type(actual(weekA), '0');
    // A blank title with staged extras is a protected draft, not an empty row.
    expect(calls).toHaveLength(0);
    expect(screen.getByLabelText('Task name')).toBeInTheDocument();
    expect(ui.commands().quick.draft?.initialCells?.time.planned.raw).toBe('0');
    await submitTitle(ui, 'Atomic row');
    await waitFor(() => expect(ui.onCreated).toHaveBeenCalledTimes(1));
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([`POST ${rootPath}/tasks/rows`]);
    expect(calls[0]?.body).toEqual({
      task: { projectId: PROJECT_ID, sectionId: SECTION, title: 'Atomic row', statusId: task.statusId },
      fields: [
        { fieldId: FLAG_ID, expectedDefinitionRevision: 1, value: { type: 'boolean', value: false } },
        { fieldId: POINTS_ID, expectedDefinitionRevision: 1, value: { type: 'number', value: 0 } },
      ],
      plan: { periodId: PERIOD_A, membershipId: MEMBER_A, expectedRevision: null, plannedMinutes: 0 },
      actual: { periodId: PERIOD_A, membershipId: MEMBER_A, minutes: 0 },
    });
    // The fresh next row starts without the sent extras, and nothing is written afterwards.
    expect(screen.getByLabelText('Task name')).toHaveValue('');
    expect(planned(weekA)).toHaveValue('');
    expect(ui.commands().quick.draft?.initialCells).toBeUndefined();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    expect(calls).toHaveLength(1);
  });

  it('retries a lost atomic create with its exact body and key and keeps the next row’s extras', async () => {
    const first = lost(); let attempt = 0;
    const { calls } = installFakeApi({ [rowsPath]: request => ++attempt === 1 ? first.promise : rowCreated(request.body) });
    const ui = atomicRow();
    await ui.user.type(planned(weekA), '2');
    await submitTitle(ui, 'Lost row');
    await waitFor(() => expect(attempt).toBe(1));
    // The next buffer gets its own hours while the first create has no answer.
    await ui.user.type(actual(weekA), '1');
    await act(async () => first.lose());
    await ui.user.click(await screen.findByRole('button', { name: 'Retry original' }));
    await waitFor(() => expect(ui.onCreated).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toEqual({
      task: { projectId: PROJECT_ID, sectionId: SECTION, title: 'Lost row', statusId: task.statusId },
      plan: { periodId: PERIOD_A, membershipId: MEMBER_A, expectedRevision: null, plannedMinutes: 120 },
    });
    expect(calls[1]?.body).toEqual(calls[0]?.body);
    expect(calls[1]?.headers.get('Idempotency-Key')).toBe(calls[0]?.headers.get('Idempotency-Key'));
    // The confirmation never touches the next unsent row or sends its hours.
    expect(actual(weekA)).toHaveValue('1');
    expect(ui.commands().quick.draft?.initialCells?.time.fact.raw).toBe('1');
    expect(ui.commands().quick.queue).toHaveLength(0);
    expect(calls).toHaveLength(2);
  });

  it('keeps the whole row and sends nothing while any built-in or staged value is invalid', async () => {
    const { calls } = installFakeApi({ [rowsPath]: request => rowCreated(request.body) });
    const ui = atomicRow();
    await stagePoints(ui, 'many');
    await ui.user.type(actual(weekA), 'soon');
    await submitTitle(ui, 'Blocked row');
    expect(await screen.findAllByRole('alert')).toHaveLength(2);
    expect(calls).toHaveLength(0);
    expect(ui.commands().quick.queue).toHaveLength(0);
    expect(screen.getByLabelText('Task name')).toHaveValue('Blocked row');
    expect(actual(weekA)).toHaveValue('soon');
    expect(ui.commands().quick.draft?.initialCells?.fields[POINTS_ID]).toBeDefined();
    await stagePoints(ui, '3');
    await ui.user.clear(actual(weekA));
    await ui.user.type(actual(weekA), '1');
    await ui.user.click(screen.getByLabelText('Task name'));
    await ui.user.keyboard('{Enter}');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({
      task: { title: 'Blocked row' },
      fields: [{ fieldId: POINTS_ID, expectedDefinitionRevision: 1, value: { type: 'number', value: 3 } }],
      actual: { periodId: PERIOD_A, membershipId: MEMBER_A, minutes: 60 },
    });
    expect(calls[0]?.body).not.toHaveProperty('plan');
  });

  it('blocks a shared parent package plan without the captured parent revision and keeps a known one', async () => {
    const parent: TaskDto = { ...task, sectionId: SECTION };
    const request: CreateRequest = { sectionId: null, parent };
    const { calls } = installFakeApi({ [rowsPath]: body => rowCreated(body.body, { parentTaskId: parent.id }) });
    // A retained child row whose hours were captured without the parent commitment.
    const ui = atomicRow({ request, open: false });
    const seeded: CreateSession = {
      ...freshQuickSession(SECTION, task.statusId, request),
      initialCells: setInitialHours(emptyInitialTaskCellsDraft(), 'planned', '2', weekA),
    };
    act(() => { ui.commands().setQuickDraft({ ...seeded, draft: { ...seeded.draft, title: 'Child unguarded' } }); });
    await ui.user.click(screen.getByRole('button', { name: 'Open atomic row' }));
    expect(screen.getByLabelText('Task name')).toHaveValue('Child unguarded');
    await ui.user.click(screen.getByLabelText('Task name'));
    await ui.user.keyboard('{Enter}');
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
    expect(ui.commands().quick.queue).toHaveLength(0);
    expect(ui.commands().quick.draft?.initialCells?.time.planned.raw).toBe('2');
  });

  it('sends a shared parent package plan only at the captured parent revision', async () => {
    const parent: TaskDto = { ...task, sectionId: SECTION };
    const guarded: InitialTimeContext = { ...weekA, plan: { workPackageId: PACKAGE_ID, expectedRevision: 4 } };
    const { calls } = installFakeApi({ [rowsPath]: request => rowCreated(request.body, { parentTaskId: parent.id }) });
    const ui = atomicRow({ request: { sectionId: null, parent }, context: guarded });
    await ui.user.type(screen.getByRole('textbox', { name: 'Planned hours for the whole parent package: Week 43, Anna Stored' }), '2');
    await submitTitle(ui, 'Child guarded');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({
      task: { projectId: PROJECT_ID, sectionId: SECTION, parentTaskId: parent.id, workScope: 'detail', title: 'Child guarded', statusId: task.statusId },
      plan: { periodId: PERIOD_A, membershipId: MEMBER_A, expectedRevision: 4, plannedMinutes: 120 },
    });
  });

  it('keeps typed hours on their captured week and person after the table shows another one', async () => {
    const { calls } = installFakeApi({ [rowsPath]: request => rowCreated(request.body) });
    const ui = atomicRow();
    await ui.user.type(planned(weekA), '1:30');
    await ui.user.click(screen.getByRole('button', { name: 'Show another week and person' }));
    // The raw text and its captured IDs stay; the cell asks for review instead of retargeting.
    expect(planned(weekA)).toHaveValue('1:30');
    expect(within(cell('weekly-plan')).getByText('Kept for Week 43, Anna Stored. The table now shows another week or person.')).toBeInTheDocument();
    expect(ui.commands().quick.draft?.initialCells?.time.context).toMatchObject({ periodId: PERIOD_A, membershipId: MEMBER_A });
    await submitTitle(ui, 'Captured row');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ plan: { periodId: PERIOD_A, membershipId: MEMBER_A, expectedRevision: null, plannedMinutes: 90 } });
    expect(calls[0]?.body).not.toHaveProperty('actual');
  });
});

describe('submitted atomic row preview', () => {
  it('shows the frozen staged extras without any control', () => {
    installFakeApi({});
    const staged = setInitialHours(stageInitialField(emptyInitialTaskCellsDraft(), points, { type: 'number', text: '7' }), 'planned', '1:30', weekA);
    const session: CreateSession = { ...freshQuickSession(SECTION, task.statusId), initialCells: staged };
    renderFieldUi(<table><tbody><QuickTaskDraftPreview session={{ ...session, draft: { ...session.draft, title: 'Submitted atomic' } }} renderRow={renderRow} pending statuses={statuses} members={alphaMembers} /></tbody></table>);
    expect(within(cell('weekly-plan')).getByText('1:30')).toBeInTheDocument();
    expect(cell(POINTS_ID)).not.toBeEmptyDOMElement();
    expect(cell(FLAG_ID)).toBeEmptyDOMElement();
    expect(cell('weekly-fact')).toBeEmptyDOMElement();
    const preview = within(screen.getByTestId('draft-row'));
    expect(preview.queryByRole('textbox')).not.toBeInTheDocument();
    expect(preview.queryByRole('button')).not.toBeInTheDocument();
    expect(preview.queryByRole('combobox')).not.toBeInTheDocument();
  });
});
