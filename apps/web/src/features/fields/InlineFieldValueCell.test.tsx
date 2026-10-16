import type { TaskFieldDefinitionDto, TaskFieldValueDto } from '@workloom/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { alpha, alphaMembers, anna, failure, installFakeApi, ok, type FakeRequest, type RouteTable } from '../../test/fakeApi';
import { task } from '../planning/test/fixtures';
import { InlineFieldValueCell } from './InlineFieldValueCell';
import { newFieldSession, type SetFieldValueMutation } from './FieldValueForm';
import type { ObservableFieldValueDraftStore } from './fieldValueDraftStore';
import { useSetTaskFieldValueMutation } from './queries';
import { FIELD_ID, OTHER_FIELD_ID, STAMP, field, heldResponse, renderFieldUi } from './test/fixtures';
import { useFieldValueDrafts } from './useFieldValueDrafts';

const DESIGN = '91000000-0000-4000-8000-000000000001';
const REVIEW = '91000000-0000-4000-8000-000000000002';
const OLD = '91000000-0000-4000-8000-000000000003';
const GONE = '91000000-0000-4000-8000-0000000000ff';
const valuePath = `/api/v1/workspaces/${alpha.id}/tasks/${task.id}/field-values/${FIELD_ID}`;
const LABEL = `Edit QA stage for ${task.title}`;

function stage(overrides: Partial<TaskFieldDefinitionDto> = {}): TaskFieldDefinitionDto {
  return {
    ...field('QA stage', 'single_select'),
    projectId: task.projectId,
    revision: 4,
    options: [
      { id: REVIEW, name: 'Review', color: '#0d9488', position: 2, revision: 1, archivedAt: null },
      { id: DESIGN, name: 'Design', color: '#6366f1', position: 1, revision: 1, archivedAt: null },
      { id: OLD, name: 'Legacy', color: '#f59e0b', position: 3, revision: 2, archivedAt: STAMP },
    ],
    ...overrides,
  };
}

function row(definition: TaskFieldDefinitionDto, value: TaskFieldValueDto['value'], revision = 3): TaskFieldValueDto {
  return {
    workspaceId: alpha.id, projectId: task.projectId, taskId: task.id, fieldId: definition.id,
    definitionVersionId: definition.definitionVersionId, revision, value, updatedAt: STAMP,
  };
}

interface Exposed { drafts: ObservableFieldValueDraftStore; mutation: SetFieldValueMutation }

function setup(options: { definition?: TaskFieldDefinitionDto; value?: TaskFieldValueDto | null; writable?: boolean; routes?: RouteTable; seed?: (drafts: ObservableFieldValueDraftStore) => void } = {}) {
  const definition = options.definition ?? stage();
  const api = installFakeApi(options.routes ?? {});
  const onMoreDetails = vi.fn();
  const exposed = {} as Exposed;
  let seeded = false;
  function Harness() {
    const mutation = useSetTaskFieldValueMutation(anna.id, alpha.id);
    const owner = useFieldValueDrafts(anna.id, alpha.id, task.projectId, mutation);
    if (!seeded) { seeded = true; options.seed?.(owner.current); }
    exposed.drafts = owner.current;
    exposed.mutation = mutation;
    return (
      <InlineFieldValueCell
        actorId={anna.id} workspaceId={alpha.id} task={task} field={definition} value={options.value ?? null}
        members={alphaMembers} writable={options.writable ?? true} mutation={mutation} drafts={owner.current} onMoreDetails={onMoreDetails}
      />
    );
  }
  const ui = renderFieldUi(<Harness />);
  const writes = () => api.calls.filter((call) => call.method !== 'GET');
  return { ...ui, ...api, writes, onMoreDetails, exposed, definition };
}

const echo = (definition: TaskFieldDefinitionDto, revision: number) => (request: FakeRequest) =>
  ok(row(definition, (request.body as { value: TaskFieldValueDto['value'] }).value, revision));

afterEach(() => vi.unstubAllGlobals());

describe('InlineFieldValueCell single-select', () => {
  it('opens a custom listbox in one click and stores only the explicitly clicked stable option ID', async () => {
    const definition = stage();
    const ui = setup({ definition, routes: { [`PUT ${valuePath}`]: echo(definition, 1) } });
    const trigger = screen.getByRole('combobox', { name: LABEL });
    expect(document.querySelector('select')).toBeNull();
    await ui.user.click(trigger);
    const listbox = screen.getByRole('listbox', { name: LABEL });
    // Active options by position; the archived one is not offered when it is not stored.
    expect(within(listbox).getAllByRole('option').map((option) => option.textContent)).toEqual(['Not set', 'Design', 'Review']);
    expect(ui.writes()).toEqual([]);
    await ui.user.click(within(listbox).getByRole('option', { name: 'Review' }));
    await waitFor(() => expect(ui.writes()).toHaveLength(1));
    expect(ui.writes()[0]?.body).toEqual({ expectedRevision: 0, expectedDefinitionRevision: 4, value: { type: 'single_select', value: REVIEW } });
    await waitFor(() => expect(ui.exposed.mutation.data).toBeDefined());
    // Confirmed: the retained session is retired and the confirmed value stays shown.
    await waitFor(() => expect(ui.exposed.drafts.getTask(task.id)).toEqual({}));
    expect(screen.getByRole('combobox', { name: LABEL })).toHaveTextContent('Review');
    expect(screen.queryByText('Draft')).toBeNull();
  });

  it('commits a keyboard choice once against the loaded value and definition revisions', async () => {
    const definition = stage();
    const ui = setup({ definition, value: row(definition, { type: 'single_select', value: DESIGN }, 7), routes: { [`PUT ${valuePath}`]: echo(definition, 8) } });
    screen.getByRole('combobox', { name: LABEL }).focus();
    await ui.user.keyboard('{ArrowDown}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await ui.user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(ui.writes()).toHaveLength(1));
    expect(ui.writes()[0]?.body).toEqual({ expectedRevision: 7, expectedDefinitionRevision: 4, value: { type: 'single_select', value: REVIEW } });
    await waitFor(() => expect(screen.getByRole('combobox', { name: LABEL })).toHaveTextContent('Review'));
    expect(ui.writes()).toHaveLength(1);
  });

  it('sends nothing for the same choice, for clearing a missing value or a stored null, and for Escape', async () => {
    const definition = stage();
    const same = setup({ definition, value: row(definition, { type: 'single_select', value: DESIGN }) });
    await same.user.click(screen.getByRole('combobox', { name: LABEL }));
    await same.user.click(screen.getByRole('option', { name: 'Design' }));
    await same.user.click(screen.getByRole('combobox', { name: LABEL }));
    await same.user.keyboard('{ArrowDown}{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(same.writes()).toEqual([]);
    same.unmount();

    const missing = setup({ definition, value: null });
    await missing.user.click(screen.getByRole('combobox', { name: LABEL }));
    await missing.user.click(screen.getByRole('option', { name: 'Not set' }));
    expect(missing.writes()).toEqual([]);
    expect(missing.exposed.drafts.getTask(task.id)).toEqual({});
    missing.unmount();

    const typedNull = setup({ definition, value: row(definition, { type: 'single_select', value: null }) });
    await typedNull.user.click(screen.getByRole('combobox', { name: LABEL }));
    await typedNull.user.click(screen.getByRole('option', { name: 'Not set' }));
    expect(typedNull.writes()).toEqual([]);
  });

  it('clears a stored option with an explicit null against the row revision', async () => {
    const definition = stage();
    const ui = setup({ definition, value: row(definition, { type: 'single_select', value: DESIGN }, 5), routes: { [`PUT ${valuePath}`]: echo(definition, 6) } });
    await ui.user.click(screen.getByRole('combobox', { name: LABEL }));
    await ui.user.click(screen.getByRole('option', { name: 'Not set' }));
    await waitFor(() => expect(ui.writes()).toHaveLength(1));
    expect(ui.writes()[0]?.body).toEqual({ expectedRevision: 5, expectedDefinitionRevision: 4, value: { type: 'single_select', value: null } });
  });

  it('keeps a stored archived or unknown option visible but disabled', async () => {
    const definition = stage();
    const archived = setup({ definition, value: row(definition, { type: 'single_select', value: OLD }) });
    const trigger = screen.getByRole('combobox', { name: LABEL });
    expect(trigger).toHaveTextContent('Legacy');
    await archived.user.click(trigger);
    const legacy = screen.getByRole('option', { name: /Legacy/ });
    expect(legacy).toHaveAttribute('aria-disabled', 'true');
    expect(legacy).toHaveAttribute('aria-selected', 'true');
    await archived.user.click(legacy);
    expect(archived.writes()).toEqual([]);
    archived.unmount();

    const unknown = setup({ definition, value: row(definition, { type: 'single_select', value: GONE }) });
    await unknown.user.click(screen.getByRole('combobox', { name: LABEL }));
    expect(screen.getByRole('option', { name: 'Option unavailable' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows a locked or read-only value without any editor or write', async () => {
    const definition = stage({ locked: true });
    const locked = setup({ definition, value: row(definition, { type: 'single_select', value: DESIGN }) });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByLabelText('QA stage is locked')).toBeInTheDocument();
    expect(screen.getByText('Design')).toBeInTheDocument();
    expect(locked.writes()).toEqual([]);
    locked.unmount();

    setup({ writable: false });
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});

describe('InlineFieldValueCell retained sessions and recovery', () => {
  it('never overwrites an existing dirty drawer draft and sends it to details for review', async () => {
    const definition = stage();
    const value = row(definition, { type: 'single_select', value: DESIGN });
    const kept = newFieldSession(definition, value, { type: 'single_select', value: REVIEW });
    const ui = setup({ definition, value, seed: (drafts) => drafts.set(task.id, { [FIELD_ID]: kept }) });
    expect(screen.queryByRole('combobox')).toBeNull();
    const draft = screen.getByRole('button', { name: `QA stage for ${task.title} has an unsaved draft. Review it in task details.` });
    expect(draft).toHaveTextContent('Draft');
    await ui.user.click(draft);
    expect(ui.onMoreDetails).toHaveBeenCalledTimes(1);
    expect(ui.exposed.drafts.getTask(task.id)[FIELD_ID]).toBe(kept);
    expect(ui.writes()).toEqual([]);
  });

  it('switches to review and keeps a draft started in the drawer while the menu is open', async () => {
    const definition = stage();
    const value = row(definition, { type: 'single_select', value: DESIGN });
    const ui = setup({ definition, value });
    await ui.user.click(screen.getByRole('combobox', { name: LABEL }));
    const later = newFieldSession(definition, value, { type: 'single_select', value: null });
    // The drawer writes a draft while this menu is open; the cell re-renders into review state.
    act(() => { ui.exposed.drafts.set(task.id, { [FIELD_ID]: later }); });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(ui.exposed.drafts.getTask(task.id)[FIELD_ID]).toBe(later);
    expect(ui.writes()).toEqual([]);
  });

  it('holds a lost write, blocks new choices and retries the original key and body exactly', async () => {
    const definition = stage();
    const lost = heldResponse();
    let attempt = 0;
    const ui = setup({
      definition,
      routes: { [`PUT ${valuePath}`]: (request) => (++attempt === 1 ? lost.promise : echo(definition, 1)(request)) },
    });
    await ui.user.click(screen.getByRole('combobox', { name: LABEL }));
    await ui.user.click(screen.getByRole('option', { name: 'Review' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: LABEL })).toBeDisabled());
    expect(screen.getByRole('status')).toHaveTextContent(`Saving QA stage for ${task.title}…`);
    expect(screen.getByRole('combobox', { name: LABEL })).toHaveTextContent('Review');

    await act(async () => { lost.lose(); });
    const popover = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('[data-cell-popover]');
      if (!node) throw new Error('Expected cell popover');
      return node;
    });
    expect(within(popover).getByRole('alert')).toBeInTheDocument();
    // Still the sent value and still frozen while the outcome is unknown.
    expect(screen.getByRole('combobox', { name: LABEL })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: LABEL })).toHaveTextContent('Review');
    await ui.user.click(within(popover).getByRole('button', { name: 'Retry original' }));
    await waitFor(() => expect(ui.writes()).toHaveLength(2));
    const [first, second] = ui.writes();
    expect(second?.body).toEqual(first?.body);
    expect(second?.body).toEqual({ expectedRevision: 0, expectedDefinitionRevision: 4, value: { type: 'single_select', value: REVIEW } });
    expect(second?.headers.get('Idempotency-Key')).toBe(first?.headers.get('Idempotency-Key'));
    await waitFor(() => expect(screen.getByRole('combobox', { name: LABEL })).toBeEnabled());
    expect(document.querySelector('[data-cell-popover]')).toBeNull();
    expect(ui.exposed.drafts.getTask(task.id)).toEqual({});
  });

  it('disables choices while another value command is held', async () => {
    const definition = stage();
    const other = { ...stage(), id: OTHER_FIELD_ID };
    const lost = heldResponse();
    const ui = setup({ definition, routes: { [`PUT /api/v1/workspaces/${alpha.id}/tasks/${task.id}/field-values/${OTHER_FIELD_ID}`]: () => lost.promise } });
    act(() => {
      ui.exposed.mutation.mutate({ taskId: task.id, fieldId: other.id, input: { expectedRevision: 0, expectedDefinitionRevision: 4, value: { type: 'single_select', value: DESIGN } } });
    });
    await waitFor(() => expect(screen.getByRole('combobox', { name: LABEL })).toBeDisabled());
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => { lost.lose(); });
    expect(screen.getByRole('combobox', { name: LABEL })).toBeDisabled();
    expect(document.querySelector('[data-cell-popover]')).toBeNull();
  });

  it('keeps a confirmed conflict as a stale draft with its error in a popover that never grows the cell', async () => {
    const definition = stage();
    const value = row(definition, { type: 'single_select', value: DESIGN }, 2);
    const ui = setup({ definition, value, routes: { [`PUT ${valuePath}`]: () => failure(409, 'VERSION_CONFLICT', 'stale') } });
    await ui.user.click(screen.getByRole('combobox', { name: LABEL }));
    await ui.user.click(screen.getByRole('option', { name: 'Review' }));
    await waitFor(() => expect(ui.exposed.drafts.getTask(task.id)[FIELD_ID]?.stale).toBe(true));
    const session = ui.exposed.drafts.getTask(task.id)[FIELD_ID];
    expect(session).toMatchObject({ submitted: true, stale: true, value, draft: { type: 'single_select', value: REVIEW } });
    const cell = ui.container.querySelector<HTMLElement>('[data-inline-field-cell]');
    const popover = cell?.querySelector<HTMLElement>('[data-cell-popover]');
    if (!cell || !popover) throw new Error('Expected cell feedback');
    // The popover is fixed and out of flow; the cell keeps its single h-8 line.
    expect(cell.className).toContain('h-8');
    expect(popover.style.position).toBe('fixed');
    expect(within(popover).getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
    await ui.user.click(within(popover).getByRole('button', { name: 'Hide' }));
    expect(cell.querySelector('[data-cell-popover]')).toBeNull();
    await ui.user.click(screen.getByRole('button', { name: 'Show the save problem for QA stage' }));
    await ui.user.click(screen.getByRole('button', { name: 'Review in details' }));
    expect(ui.onMoreDetails).toHaveBeenCalledTimes(1);
    expect(ui.exposed.drafts.getTask(task.id)[FIELD_ID]).toBe(session);
    expect(ui.writes()).toHaveLength(1);
  });

  it('marks a server lock refusal on the kept session without resetting it', async () => {
    const definition = stage();
    const ui = setup({ definition, routes: { [`PUT ${valuePath}`]: () => failure(409, 'FIELD_LOCKED', 'locked') } });
    await ui.user.click(screen.getByRole('combobox', { name: LABEL }));
    await ui.user.click(screen.getByRole('option', { name: 'Design' }));
    await waitFor(() => expect(ui.exposed.drafts.getTask(task.id)[FIELD_ID]?.serverLocked).toBe(true));
    expect(ui.exposed.drafts.getTask(task.id)[FIELD_ID]).toMatchObject({ stale: false, draft: { type: 'single_select', value: DESIGN } });
    expect(screen.getByRole('button', { name: /has an unsaved draft/ })).toBeInTheDocument();
  });
});

describe('InlineFieldValueCell confirmed receipts', () => {
  const otherPath = `/api/v1/workspaces/${alpha.id}/tasks/${task.id}/field-values/${OTHER_FIELD_ID}`;
  const OTHER_LABEL = `Edit Phase for ${task.title}`;

  /** Two cells share one page mutation; X's loaded row is held old (no refetch) until changed explicitly. */
  function setupPair(routes: RouteTable) {
    const x = stage();
    const y = { ...stage(), id: OTHER_FIELD_ID, name: 'Phase' };
    const api = installFakeApi(routes);
    const control = {} as { mutation: SetFieldValueMutation; setX: (value: TaskFieldValueDto | null) => void; setActor: (id: string) => void };
    function Pair() {
      const mutation = useSetTaskFieldValueMutation(anna.id, alpha.id);
      const owner = useFieldValueDrafts(anna.id, alpha.id, task.projectId, mutation);
      const [xValue, setX] = useState<TaskFieldValueDto | null>(row(x, { type: 'single_select', value: DESIGN }, 3));
      const [actor, setActor] = useState(anna.id);
      Object.assign(control, { mutation, setX, setActor });
      const common = { actorId: actor, workspaceId: alpha.id, task, members: alphaMembers, writable: true, mutation, drafts: owner.current, onMoreDetails: () => undefined };
      return (
        <>
          <InlineFieldValueCell {...common} field={x} value={xValue} />
          <InlineFieldValueCell {...common} field={y} value={null} />
        </>
      );
    }
    const ui = renderFieldUi(<Pair />);
    return { ...ui, ...api, control, x, writes: () => api.calls.filter((call) => call.method !== 'GET') };
  }

  async function choose(ui: ReturnType<typeof setupPair>, label: string, option: string) {
    await waitFor(() => expect(screen.getByRole('combobox', { name: label })).toBeEnabled());
    await ui.user.click(screen.getByRole('combobox', { name: label }));
    await ui.user.click(screen.getByRole('option', { name: option }));
  }

  it('keeps X confirmed after Y resets the shared mutation data, and a newer loaded row still wins', async () => {
    let xRevision = 3;
    const ui = setupPair({
      [`PUT ${valuePath}`]: (request) => ok(row(stage(), (request.body as { value: TaskFieldValueDto['value'] }).value, ++xRevision)),
      [`PUT ${otherPath}`]: (request) => ok(row({ ...stage(), id: OTHER_FIELD_ID }, (request.body as { value: TaskFieldValueDto['value'] }).value, 1)),
    });
    await choose(ui, LABEL, 'Review');
    await waitFor(() => expect(ui.control.mutation.data?.revision).toBe(4));

    await choose(ui, OTHER_LABEL, 'Design');
    // Y's send replaces the page's only answer; X's own receipt must not depend on it.
    await waitFor(() => expect(ui.control.mutation.data?.fieldId).toBe(OTHER_FIELD_ID));
    expect(screen.getByRole('combobox', { name: LABEL })).toHaveTextContent('Review');
    expect(screen.getByRole('combobox', { name: OTHER_LABEL })).toHaveTextContent('Design');

    // Next X send is based on the confirmed revision 4, not the held loaded revision 3.
    await choose(ui, LABEL, 'Not set');
    await waitFor(() => expect(ui.writes()).toHaveLength(3));
    expect(ui.writes()[2]?.body).toEqual({ expectedRevision: 4, expectedDefinitionRevision: 4, value: { type: 'single_select', value: null } });
    await waitFor(() => expect(ui.control.mutation.data?.revision).toBe(5));

    // A newer loaded row for the same field wins over every receipt.
    act(() => ui.control.setX(row(ui.x, { type: 'single_select', value: DESIGN }, 9)));
    expect(screen.getByRole('combobox', { name: LABEL })).toHaveTextContent('Design');
    await choose(ui, LABEL, 'Review');
    await waitFor(() => expect(ui.writes()).toHaveLength(4));
    expect(ui.writes()[3]?.body).toEqual({ expectedRevision: 9, expectedDefinitionRevision: 4, value: { type: 'single_select', value: REVIEW } });
  });

  it('drops a receipt when the actor context changes', async () => {
    const ui = setupPair({
      [`PUT ${valuePath}`]: (request) => ok(row(stage(), (request.body as { value: TaskFieldValueDto['value'] }).value, 4)),
      [`PUT ${otherPath}`]: (request) => ok(row({ ...stage(), id: OTHER_FIELD_ID }, (request.body as { value: TaskFieldValueDto['value'] }).value, 1)),
    });
    await choose(ui, LABEL, 'Review');
    await waitFor(() => expect(ui.control.mutation.data?.revision).toBe(4));
    await choose(ui, OTHER_LABEL, 'Design');
    await waitFor(() => expect(ui.control.mutation.data?.fieldId).toBe(OTHER_FIELD_ID));
    expect(screen.getByRole('combobox', { name: LABEL })).toHaveTextContent('Review');
    act(() => ui.control.setActor(alphaMembers[1]?.userId ?? ''));
    // Only the loaded row remains for another actor; the old receipt is never carried over.
    expect(screen.getByRole('combobox', { name: LABEL })).toHaveTextContent('Design');
  });
});

describe('InlineFieldValueCell other types', () => {
  it('picks one person with search and avatars, and sends a one-member list', async () => {
    const definition = { ...field('Reviewer', 'person'), projectId: task.projectId };
    const target = alphaMembers[2];
    if (!target) throw new Error('Expected member fixture');
    const ui = setup({ definition, routes: { [`PUT ${valuePath}`]: echo(definition, 1) } });
    await ui.user.click(screen.getByRole('combobox', { name: `Edit Reviewer for ${task.title}` }));
    await ui.user.type(screen.getByRole('combobox', { name: `Search: Edit Reviewer for ${task.title}` }), target.displayName.slice(0, 4));
    await ui.user.keyboard('{Enter}');
    await waitFor(() => expect(ui.writes()).toHaveLength(1));
    expect(ui.writes()[0]?.body).toEqual({ expectedRevision: 0, expectedDefinitionRevision: 1, value: { type: 'person', value: [target.id] } });
  });

  it('opens details instead of replacing several people, and for non-choice types', async () => {
    const people = { ...field('Reviewers', 'person'), projectId: task.projectId };
    const many = setup({ definition: people, value: row(people, { type: 'person', value: alphaMembers.slice(0, 2).map((member) => member.id) }) });
    expect(screen.queryByRole('combobox')).toBeNull();
    await many.user.click(screen.getByRole('button', { name: `Edit Reviewers for ${task.title}` }));
    expect(many.onMoreDetails).toHaveBeenCalledTimes(1);
    many.unmount();

    const notes = { ...field('Notes', 'text'), projectId: task.projectId };
    const text = setup({ definition: notes, value: row(notes, { type: 'text', value: 'hello' }) });
    await text.user.click(screen.getByRole('button', { name: `Edit Notes for ${task.title}` }));
    expect(text.onMoreDetails).toHaveBeenCalledTimes(1);
    expect(text.writes()).toEqual([]);
  });
});
