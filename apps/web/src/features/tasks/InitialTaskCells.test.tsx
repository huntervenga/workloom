import type { TaskFieldDefinitionDto, TaskFieldType } from '@workloom/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n';
import {
  InitialCustomFieldCell,
  InitialTaskTimeCell,
  emptyInitialTaskCellsDraft,
  explicitTimeContext,
  hasInitialTaskCells,
  setInitialHours,
  stageInitialField,
  unstageInitialField,
  validateInitialTaskCells,
  type InitialHoursKind,
  type InitialTaskCellsDraft,
  type InitialTimeContext,
} from './InitialTaskCells';

const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const PROJECT = '00000000-0000-4000-8000-000000000002';
const VERSION = '00000000-0000-4000-8000-000000000003';
const AT = '2026-01-01T00:00:00.000Z';
let nextId = 10;

function definition(type: TaskFieldType, name: string, revision = 3): TaskFieldDefinitionDto {
  nextId += 1;
  return {
    id: `00000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`,
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    name,
    type,
    revision,
    definitionVersionId: VERSION,
    historyEnabled: true,
    locked: false,
    archivedAt: null,
    options: [],
    createdAt: AT,
    updatedAt: AT,
  };
}

const weekA = explicitTimeContext({
  periodId: '00000000-0000-4000-8000-0000000000a1',
  membershipId: '00000000-0000-4000-8000-0000000000b1',
  periodName: 'Week 12',
  memberName: 'Anna',
}) as InitialTimeContext;
const weekB = explicitTimeContext({
  periodId: '00000000-0000-4000-8000-0000000000a2',
  membershipId: '00000000-0000-4000-8000-0000000000b1',
  periodName: 'Week 13',
  memberName: 'Anna',
}) as InitialTimeContext;
const PARENT_PACKAGE = '00000000-0000-4000-8000-0000000000c1';
const weekAPlan = explicitTimeContext({ ...weekA, plan: { workPackageId: PARENT_PACKAGE, expectedRevision: 4 } }) as InitialTimeContext;
const weekBPlan = explicitTimeContext({ ...weekB, plan: { workPackageId: PARENT_PACKAGE, expectedRevision: 9 } }) as InitialTimeContext;

/** Records which elements enter the top layer; jsdom has no popover API of its own. */
function stubTopLayer() {
  const proto = HTMLElement.prototype;
  const saved = {
    showPopover: Object.getOwnPropertyDescriptor(proto, 'showPopover'),
    hidePopover: Object.getOwnPropertyDescriptor(proto, 'hidePopover'),
  };
  const shown: HTMLElement[] = [];
  Object.defineProperty(proto, 'showPopover', {
    configurable: true,
    writable: true,
    value(this: HTMLElement) {
      shown.push(this);
    },
  });
  Object.defineProperty(proto, 'hidePopover', { configurable: true, writable: true, value() {} });
  return {
    shown,
    restore() {
      for (const key of ['showPopover', 'hidePopover'] as const) {
        const descriptor = saved[key];
        if (descriptor) Object.defineProperty(proto, key, descriptor);
        else Reflect.deleteProperty(proto, key);
      }
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('initial task cell staging', () => {
  it('keeps false, zero, empty text, an empty list and explicit clears apart, each against revision 0', () => {
    const flag = definition('boolean', 'Approved');
    const count = definition('number', 'Count', 7);
    const note = definition('text', 'Note');
    const tags = definition('multi_select', 'Tags');
    const people = definition('person', 'Reviewers');
    const due = definition('date', 'Due');
    const effort = definition('duration', 'Effort');
    const untouched = definition('url', 'Link');

    let draft = emptyInitialTaskCellsDraft();
    expect(hasInitialTaskCells(draft)).toBe(false);
    draft = stageInitialField(draft, flag, { type: 'boolean', value: false });
    draft = stageInitialField(draft, count, { type: 'number', text: '0' });
    draft = stageInitialField(draft, note, { type: 'text', value: '' });
    draft = stageInitialField(draft, tags, { type: 'multi_select', value: [] });
    draft = stageInitialField(draft, people, { type: 'person', value: null });
    draft = stageInitialField(draft, due, { type: 'date', text: '' });
    draft = stageInitialField(draft, effort, { type: 'duration', text: '0' });
    expect(hasInitialTaskCells(draft)).toBe(true);

    const result = validateInitialTaskCells(draft, { definitions: [flag, count, note, tags, people, due, effort, untouched] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.time).toBeNull();
    expect(result.data.fields).toEqual([
      { fieldId: flag.id, definitionVersionId: VERSION, expectedDefinitionRevision: 3, expectedValueRevision: 0, value: { type: 'boolean', value: false } },
      { fieldId: count.id, definitionVersionId: VERSION, expectedDefinitionRevision: 7, expectedValueRevision: 0, value: { type: 'number', value: 0 } },
      { fieldId: note.id, definitionVersionId: VERSION, expectedDefinitionRevision: 3, expectedValueRevision: 0, value: { type: 'text', value: '' } },
      { fieldId: tags.id, definitionVersionId: VERSION, expectedDefinitionRevision: 3, expectedValueRevision: 0, value: { type: 'multi_select', value: [] } },
      { fieldId: people.id, definitionVersionId: VERSION, expectedDefinitionRevision: 3, expectedValueRevision: 0, value: { type: 'person', value: null } },
      { fieldId: due.id, definitionVersionId: VERSION, expectedDefinitionRevision: 3, expectedValueRevision: 0, value: { type: 'date', value: null } },
      { fieldId: effort.id, definitionVersionId: VERSION, expectedDefinitionRevision: 3, expectedValueRevision: 0, value: { type: 'duration', value: 0 } },
    ]);
    // An unstaged field sends nothing at all, which differs from the explicit clears above.
    expect(result.data.fields.some((value) => value.fieldId === untouched.id)).toBe(false);
    // Plain data: survives serialization unchanged.
    expect(JSON.parse(JSON.stringify(result.data))).toEqual(result.data);
  });

  it('never mutates a draft and keeps the first definition snapshot', () => {
    const count = definition('number', 'Count', 4);
    const before = deepFreeze(stageInitialField(emptyInitialTaskCellsDraft(), count, { type: 'number', text: '1' }));
    const edited = stageInitialField(before, { ...count, revision: 5 }, { type: 'number', text: '2' });
    expect(before.fields[count.id]?.draft).toEqual({ type: 'number', text: '1' });
    expect(edited.fields[count.id]?.field.revision).toBe(4);

    const removed = unstageInitialField(before, count.id);
    expect(removed.fields).toEqual({});
    expect(before.fields[count.id]).toBeDefined();
    expect(unstageInitialField(removed, count.id)).toBe(removed);
  });

  it('retains invalid typed values and blocks the result with the field message', () => {
    const count = definition('number', 'Count');
    const draft = stageInitialField(emptyInitialTaskCellsDraft(), count, { type: 'number', text: '12abc' });
    const result = validateInitialTaskCells(draft);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([{ kind: 'field', fieldId: count.id, message: expect.any(String) }]);
    expect(draft.fields[count.id]?.draft).toEqual({ type: 'number', text: '12abc' });
  });

  it('reports a field that changed or left instead of re-targeting its value', () => {
    const count = definition('number', 'Count', 2);
    const draft = stageInitialField(emptyInitialTaskCellsDraft(), count, { type: 'number', text: '5' });
    const changed = validateInitialTaskCells(draft, { definitions: [{ ...count, revision: 3 }] });
    const gone = validateInitialTaskCells(draft, { definitions: [] });
    expect(changed).toEqual({ ok: false, issues: [{ kind: 'field', fieldId: count.id, message: t('taskRows.field.definitionChanged') }] });
    expect(gone).toEqual({ ok: false, issues: [{ kind: 'field', fieldId: count.id, message: t('taskRows.field.definitionUnavailable') }] });
  });

  it('keeps an explicit zero, omits blank hours and tracks touched separately', () => {
    let draft = setInitialHours(emptyInitialTaskCellsDraft(), 'planned', '0', weekA);
    draft = setInitialHours(draft, 'fact', '', weekA);
    expect(draft.time.planned).toEqual({ raw: '0', touched: true });
    expect(draft.time.fact).toEqual({ raw: '', touched: true });

    const result = validateInitialTaskCells(draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.time).toEqual({ periodId: weekA.periodId, membershipId: weekA.membershipId, plannedMinutes: 0 });
    expect(result.data.time && 'actualMinutes' in result.data.time).toBe(false);

    const both = validateInitialTaskCells(setInitialHours(draft, 'fact', '1:30', weekA));
    expect(both.ok && both.data.time).toEqual({ periodId: weekA.periodId, membershipId: weekA.membershipId, plannedMinutes: 0, actualMinutes: 90 });
  });

  it('turns invalid hours into a localized issue and keeps the raw text', () => {
    const draft = setInitialHours(emptyInitialTaskCellsDraft(), 'fact', '-2', weekA);
    expect(validateInitialTaskCells(draft)).toEqual({ ok: false, issues: [{ kind: 'hours', hours: 'fact', message: t('taskRows.time.negative') }] });
    expect(draft.time.fact.raw).toBe('-2');
  });

  it('stages no hours without an explicit week and person', () => {
    const empty = emptyInitialTaskCellsDraft();
    expect(explicitTimeContext({ periodId: '', membershipId: weekA.membershipId, periodName: '', memberName: 'Anna' })).toBeNull();
    expect(explicitTimeContext({ periodId: weekA.periodId, membershipId: null, periodName: 'Week 12', memberName: '' })).toBeNull();
    expect(setInitialHours(empty, 'planned', '2', null)).toBe(empty);
  });

  it('keeps typed hours on the captured week when the selection changes, and reports it', () => {
    let draft = setInitialHours(emptyInitialTaskCellsDraft(), 'planned', '2', weekA);
    draft = setInitialHours(draft, 'planned', '3', weekB);
    expect(draft.time.context).toEqual(weekA);

    const result = validateInitialTaskCells(draft, { currentContext: weekB });
    expect(result).toEqual({
      ok: true,
      contextChanged: true,
      data: { fields: [], time: { periodId: weekA.periodId, membershipId: weekA.membershipId, plannedMinutes: 180 } },
    });

    // Once nothing is typed any more, the next hours follow the current selection.
    const cleared = setInitialHours(draft, 'planned', '', weekB);
    expect(cleared.time.context).toBeNull();
    expect(setInitialHours(cleared, 'fact', '1', weekB).time.context).toEqual(weekB);
  });

  it('does not plan a subtask that shares its parent package', () => {
    const draft = setInitialHours(emptyInitialTaskCellsDraft(), 'planned', '4', weekA);
    expect(validateInitialTaskCells(draft, { sharesParentPackage: true })).toEqual({
      ok: false,
      issues: [{ kind: 'hours', hours: 'planned', message: t('taskRows.time.sharedPackagePlan') }],
    });
    const fact = validateInitialTaskCells(setInitialHours(emptyInitialTaskCellsDraft(), 'fact', '4', weekA), { sharesParentPackage: true });
    expect(fact.ok && fact.data.time).toEqual({ periodId: weekA.periodId, membershipId: weekA.membershipId, actualMinutes: 240 });
  });

  it('keeps only a usable parent commitment on an explicit context', () => {
    expect(weekAPlan.plan).toEqual({ workPackageId: PARENT_PACKAGE, expectedRevision: 4 });
    expect(explicitTimeContext({ ...weekA, plan: { workPackageId: PARENT_PACKAGE, expectedRevision: null } })?.plan).toEqual({
      workPackageId: PARENT_PACKAGE,
      expectedRevision: null,
    });
    expect(explicitTimeContext({ ...weekA, plan: { workPackageId: ' ', expectedRevision: 2 } })).not.toHaveProperty('plan');
    expect(explicitTimeContext({ ...weekA, plan: { workPackageId: PARENT_PACKAGE, expectedRevision: 1.5 } })).not.toHaveProperty('plan');
    expect(explicitTimeContext({ ...weekA, plan: { workPackageId: PARENT_PACKAGE, expectedRevision: -1 } })).not.toHaveProperty('plan');
    expect(explicitTimeContext({ ...weekA, plan: null })).toEqual(weekA);
  });

  it('plans the whole parent package only against the captured commitment revision', () => {
    const draft = setInitialHours(emptyInitialTaskCellsDraft(), 'planned', '4', weekAPlan);
    expect(validateInitialTaskCells(draft, { sharesParentPackage: true })).toEqual({
      ok: true,
      contextChanged: false,
      data: {
        fields: [],
        time: { periodId: weekA.periodId, membershipId: weekA.membershipId, plannedMinutes: 240, expectedPlanRevision: 4 },
      },
    });

    // A commitment known to be absent is guarded as `null`, not left out.
    const absent = explicitTimeContext({ ...weekA, plan: { workPackageId: PARENT_PACKAGE, expectedRevision: null } });
    const fresh = validateInitialTaskCells(setInitialHours(emptyInitialTaskCellsDraft(), 'planned', '1', absent), { sharesParentPackage: true });
    expect(fresh.ok && fresh.data.time).toEqual({ periodId: weekA.periodId, membershipId: weekA.membershipId, plannedMinutes: 60, expectedPlanRevision: null });

    // The new task's own package plan carries no parent guard, and actual hours never do.
    const own = validateInitialTaskCells(draft);
    expect(own.ok && own.data.time).toEqual({ periodId: weekA.periodId, membershipId: weekA.membershipId, plannedMinutes: 240 });
    const fact = validateInitialTaskCells(setInitialHours(emptyInitialTaskCellsDraft(), 'fact', '2', weekAPlan), { sharesParentPackage: true });
    expect(fact.ok && fact.data.time).toEqual({ periodId: weekA.periodId, membershipId: weekA.membershipId, actualMinutes: 120 });
  });

  it('keeps the captured parent commitment and an explicit zero when the selection changes', () => {
    let draft = setInitialHours(emptyInitialTaskCellsDraft(), 'planned', '0', weekAPlan);
    draft = setInitialHours(draft, 'fact', '0', weekBPlan);
    expect(draft.time.context).toEqual(weekAPlan);
    expect(draft.time.planned.raw).toBe('0');

    expect(validateInitialTaskCells(draft, { sharesParentPackage: true, currentContext: weekBPlan })).toEqual({
      ok: true,
      contextChanged: true,
      data: {
        fields: [],
        time: {
          periodId: weekA.periodId,
          membershipId: weekA.membershipId,
          plannedMinutes: 0,
          expectedPlanRevision: 4,
          actualMinutes: 0,
        },
      },
    });
  });
});

function FieldHarness({ field, onDraft }: { field: TaskFieldDefinitionDto; onDraft: (draft: InitialTaskCellsDraft) => void }) {
  const [draft, setDraft] = useState(emptyInitialTaskCellsDraft);
  return (
    <InitialCustomFieldCell
      field={field}
      draft={draft}
      members={[]}
      onChange={(next) => {
        setDraft(next);
        onDraft(next);
      }}
    />
  );
}

function TimeHarness({
  kind,
  context,
  initial = emptyInitialTaskCellsDraft(),
  sharesParentPackage,
  onDraft,
}: {
  kind: InitialHoursKind;
  context: InitialTimeContext | null;
  initial?: InitialTaskCellsDraft;
  sharesParentPackage?: boolean;
  onDraft: (draft: InitialTaskCellsDraft) => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <InitialTaskTimeCell
      kind={kind}
      draft={draft}
      context={context}
      sharesParentPackage={sharesParentPackage}
      onChange={(next) => {
        setDraft(next);
        onDraft(next);
      }}
    />
  );
}

describe('InitialCustomFieldCell', () => {
  it('stages typed text locally under the field name and can leave the field unset again', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const user = userEvent.setup();
    const onDraft = vi.fn<(draft: InitialTaskCellsDraft) => void>();
    const note = definition('text', 'Customer note');
    render(<FieldHarness field={note} onDraft={onDraft} />);

    const trigger = screen.getByRole('button', { name: t('taskRows.field.editLabel', { field: 'Customer note' }) });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: t('taskRows.field.editLabel', { field: 'Customer note' }) })).toBeTruthy();

    await user.type(screen.getByRole('textbox', { name: 'Customer note' }), 'Call first');
    expect(onDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ fields: { [note.id]: { field: note, draft: { type: 'text', value: 'Call first' } } } }),
    );

    await user.click(screen.getByRole('button', { name: t('taskRows.field.leaveUnset') }));
    expect(onDraft.mock.lastCall?.[0].fields).toEqual({});

    // The disabled «Leave unset» button drops focus; Escape is handled inside the panel.
    await user.click(screen.getByRole('textbox', { name: 'Customer note' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps an invalid number as typed and exposes the error on the cell', async () => {
    const user = userEvent.setup();
    const onDraft = vi.fn<(draft: InitialTaskCellsDraft) => void>();
    const count = definition('number', 'Count');
    render(<FieldHarness field={count} onDraft={onDraft} />);

    await user.click(screen.getByRole('button', { name: t('taskRows.field.editLabel', { field: 'Count' }) }));
    const input = screen.getByRole('textbox', { name: 'Count' });
    await user.type(input, '1x');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    await user.click(screen.getByRole('button', { name: t('taskRows.field.done') }));

    const trigger = screen.getByRole('button', { name: t('taskRows.field.editLabel', { field: 'Count' }) });
    expect(trigger.textContent).toContain('1x');
    expect(trigger.getAttribute('aria-describedby')).toBeTruthy();
    expect(onDraft.mock.lastCall?.[0].fields[count.id]?.draft).toEqual({ type: 'number', text: '1x' });
  });

  it('opens its editor in the top layer from inside a clipping cell and focuses it only on open', async () => {
    const topLayer = stubTopLayer();
    try {
      const user = userEvent.setup();
      const note = definition('text', 'Note');
      render(
        <table>
          <tbody>
            <tr>
              <td style={{ overflow: 'hidden', maxWidth: 80, height: 28 }}>
                <FieldHarness field={note} onDraft={vi.fn()} />
              </td>
            </tr>
          </tbody>
        </table>,
      );
      const label = t('taskRows.field.editLabel', { field: 'Note' });
      const trigger = screen.getByRole('button', { name: label });
      expect(topLayer.shown).toEqual([]);

      await user.click(trigger);
      const dialog = screen.getByRole('dialog', { name: label });
      // The popover is the dialog itself, not a second panel around it.
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      expect(dialog.getAttribute('popover')).toBe('manual');
      expect(topLayer.shown).toContain(dialog);
      // It stays a DOM child of the cell, so focus, Escape and form ownership keep working.
      expect(trigger.closest('td')?.contains(dialog)).toBe(true);
      expect(trigger.getAttribute('aria-controls')).toBe(dialog.id);
      expect(dialog.contains(document.activeElement)).toBe(true);

      await user.click(screen.getByRole('button', { name: t('taskRows.field.done') }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally {
      topLayer.restore();
    }
  });

  it('closes a nested picker on Escape before the editor and keeps Escape away from the row', async () => {
    const user = userEvent.setup();
    const rowKeys = vi.fn<(key: string) => void>();
    // Boolean now uses a checkbox; a single-select exercises the actual nested picker.
    const flag = { ...definition('single_select', 'Approved'), options: [{ id: '00000000-0000-4000-8000-000000000099', name: 'Approved', color: '#6366f1', position: 0, revision: 1, archivedAt: null }] };
    render(
      <div onKeyDown={(event) => rowKeys(event.key)}>
        <FieldHarness field={flag} onDraft={vi.fn()} />
      </div>,
    );
    const label = t('taskRows.field.editLabel', { field: 'Approved' });
    const trigger = screen.getByRole('button', { name: label });
    await user.click(trigger);
    const picker = screen.getByRole('combobox', { name: 'Approved' });
    await user.click(picker);
    expect(screen.getByRole('listbox', { name: 'Approved' })).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('dialog', { name: label })).toBeTruthy();
    expect(document.activeElement).toBe(picker);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(rowKeys).not.toHaveBeenCalledWith('Escape');
  });
});

describe('InitialTaskTimeCell', () => {
  it('offers no input without an explicit week and person', () => {
    render(<TimeHarness kind="fact" context={null} onDraft={vi.fn()} />);
    expect(screen.getByText(t('taskRows.time.chooseContext'))).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('captures the context, keeps an explicit zero and shows a parser error', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const user = userEvent.setup();
    const onDraft = vi.fn<(draft: InitialTaskCellsDraft) => void>();
    render(<TimeHarness kind="planned" context={weekA} onDraft={onDraft} />);

    const input = screen.getByRole('textbox', { name: t('taskRows.time.plannedLabel', { period: 'Week 12', member: 'Anna' }) });
    await user.type(input, '0');
    expect(onDraft.mock.lastCall?.[0].time).toEqual({ context: weekA, planned: { raw: '0', touched: true }, fact: { raw: '', touched: false } });

    await user.type(input, ':75');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(t('taskRows.time.clockMinutes'))).toBeTruthy();
    expect(onDraft.mock.lastCall?.[0].time.planned.raw).toBe('0:75');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps typed hours on the captured week and asks for review after the selection changes', async () => {
    const user = userEvent.setup();
    const onDraft = vi.fn<(draft: InitialTaskCellsDraft) => void>();
    const initial = setInitialHours(emptyInitialTaskCellsDraft(), 'fact', '2', weekA);
    render(<TimeHarness kind="fact" context={weekB} initial={initial} onDraft={onDraft} />);

    expect(screen.getByText(t('taskRows.time.contextChanged', { period: 'Week 12', member: 'Anna' }))).toBeTruthy();
    const input = screen.getByRole('textbox', { name: t('taskRows.time.factLabel', { period: 'Week 12', member: 'Anna' }) });
    await user.type(input, '5');
    expect(onDraft.mock.lastCall?.[0].time.context).toEqual(weekA);
    expect(onDraft.mock.lastCall?.[0].time.fact.raw).toBe('25');
  });

  it('leaves planning of a subtask to its parent package', () => {
    render(<TimeHarness kind="planned" context={weekA} sharesParentPackage onDraft={vi.fn()} />);
    expect(screen.getByText(t('taskRows.time.sharesParentPackage'))).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('offers the whole parent package plan with the loaded commitment and says what it sets', async () => {
    const user = userEvent.setup();
    const onDraft = vi.fn<(draft: InitialTaskCellsDraft) => void>();
    render(<TimeHarness kind="planned" context={weekAPlan} sharesParentPackage onDraft={onDraft} />);

    const params = { period: 'Week 12', member: 'Anna' };
    expect(screen.queryByRole('textbox', { name: t('taskRows.time.plannedLabel', params) })).toBeNull();
    const input = screen.getByRole('textbox', { name: t('taskRows.time.parentPlannedLabel', params) });
    const note = screen.getByText(t('taskRows.time.sharedPackageTotal'));
    expect(input.getAttribute('aria-describedby')).toBe(note.closest('p')?.id);

    await user.type(input, '0');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(onDraft.mock.lastCall?.[0].time).toEqual({ context: weekAPlan, planned: { raw: '0', touched: true }, fact: { raw: '', touched: false } });
  });
});
