import type { TaskFieldValueDto } from '@workloom/contracts';
import { act, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import { alpha, anna, boris } from '../../test/fakeApi';
import { newFieldSession, type FieldEditSession } from './FieldValueForm';
import { ObservableFieldValueDraftStore } from './fieldValueDraftStore';
import { useFieldValueDrafts } from './useFieldValueDrafts';
import { useSetTaskFieldValueMutation } from './queries';
import { FIELD_ID, OTHER_FIELD_ID, PROJECT_ID, STAMP, field, renderFieldUi } from './test/fixtures';

const TASK = 'f0000000-0000-4000-8000-000000000001';
const OTHER_TASK = 'f0000000-0000-4000-8000-000000000002';
const numberField = field('Number', 'number');
const dirty = (text = 'raw invalid value') => newFieldSession(numberField, null, { type: 'number', text });
const receipt = (): TaskFieldValueDto => ({ workspaceId: alpha.id, projectId: PROJECT_ID, taskId: TASK, fieldId: FIELD_ID, definitionVersionId: numberField.definitionVersionId, revision: 1, value: { type: 'number', value: 0 }, updatedAt: STAMP });
function unload() { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }
function example() {
  const owners = new Map<string, ObservableFieldValueDraftStore>();
  function Owner({ id, actor, workspace, project }: { id: string; actor: string; workspace: string; project: string }) {
    const mutation = useSetTaskFieldValueMutation(actor, workspace);
    const owner = useFieldValueDrafts(actor, workspace, project, mutation);
    owners.set(id, owner.current);
    return null;
  }
  function Example() {
    const [first, setFirst] = useState(true);
    const [actor, setActor] = useState(anna.id);
    const [workspace, setWorkspace] = useState(alpha.id);
    const [project, setProject] = useState(PROJECT_ID);
    return <>
      {first ? <Owner id="first" actor={actor} workspace={workspace} project={project} /> : null}
      <Owner id="second" actor={anna.id} workspace={alpha.id} project={PROJECT_ID} />
      <button onClick={() => setFirst(false)}>Unmount first</button>
      <button onClick={() => setActor(boris.id)}>Change actor</button>
      <button onClick={() => setWorkspace('b0000000-0000-4000-8000-000000000099')}>Change workspace</button>
      <button onClick={() => setProject('e0000000-0000-4000-8000-000000000099')}>Change project</button>
    </>;
  }
  const ui = renderFieldUi(<Example />);
  const get = (id = 'first') => { const owner = owners.get(id); if (!owner) throw new Error('Missing field owner'); return owner; };
  return { ...ui, get };
}

describe('observable retained custom-field input', () => {
  it('uses the existing dirty semantics for explicit null, false, zero and invalid raw input', () => {
    const store = new ObservableFieldValueDraftStore();
    const booleanField = field('Boolean', 'boolean');
    const cases: [FieldEditSession, boolean][] = [
      [newFieldSession(numberField, null), false],
      [dirty('0'), true],
      [dirty('not a number'), true],
      [newFieldSession(booleanField, null, { type: 'boolean', value: false }), true],
      [newFieldSession(numberField, receipt()), false],
      [newFieldSession(numberField, receipt(), { type: 'number', text: '' }), true],
      [newFieldSession(booleanField, { ...receipt(), value: { type: 'boolean', value: false } }), false],
      [newFieldSession(booleanField, { ...receipt(), value: { type: 'boolean', value: false } }, { type: 'boolean', value: null }), true],
    ];
    for (const [session, expected] of cases) {
      store.set(TASK, { [FIELD_ID]: session });
      expect(store.getSnapshot()).toBe(expected);
      expect(store.getTask(TASK)[FIELD_ID]).toBe(session);
    }
  });

  it('confirms only the captured original slot, retaining another field/task and a newer same-slot identity', () => {
    const store = new ObservableFieldValueDraftStore();
    const original = dirty('0');
    const other = newFieldSession(field('Other', 'number', OTHER_FIELD_ID), null, { type: 'number', text: '12' });
    store.set(TASK, { [FIELD_ID]: original, [OTHER_FIELD_ID]: other });
    store.set(OTHER_TASK, { [FIELD_ID]: dirty('9') });
    store.capture(TASK, original);
    store.set(TASK, { ...store.getTask(TASK), [FIELD_ID]: { ...original, submitted: true } });
    const saved = receipt();
    expect(store.confirm(saved)).toBe(true);
    expect(store.getTask(TASK)[FIELD_ID]).toBeUndefined();
    expect(store.getTask(TASK)[OTHER_FIELD_ID]).toBe(other);
    expect(store.getTask(OTHER_TASK)[FIELD_ID]?.draft).toEqual({ type: 'number', text: '9' });
    expect(store.getSnapshot()).toBe(true);

    const sent = dirty('0');
    store.set(TASK, { ...store.getTask(TASK), [FIELD_ID]: sent });
    store.capture(TASK, sent);
    const replacement = newFieldSession(numberField, sent.value, sent.draft);
    store.set(TASK, { ...store.getTask(TASK), [FIELD_ID]: replacement });
    expect(store.confirm(receipt())).toBe(false);
    expect(store.getTask(TASK)[FIELD_ID]).toBe(replacement);
    store.delete(OTHER_TASK);
    store.set(TASK, { [FIELD_ID]: replacement });
    expect(store.getSnapshot()).toBe(true);
    store.clear();
    expect(store.getSnapshot()).toBe(false);
  });

  it('protects same-turn writes and disposes only its own owner on unmount', async () => {
    const ui = example();
    act(() => { ui.get().set(TASK, { [FIELD_ID]: dirty() }); expect(protectedDraftsFor(ui.client).protecting).toBe(true); expect(unload()).toBe(true); });
    act(() => { ui.get('second').set(TASK, { [FIELD_ID]: dirty('other owner') }); ui.get().clear(); });
    await ui.user.click(screen.getByRole('button', { name: 'Unmount first' }));
    expect(unload()).toBe(true);
    act(() => { ui.get('second').clear(); expect(unload()).toBe(false); });
    expect(protectedCommandsFor(ui.client).protecting).toBe(false);
  });

  it.each(['actor', 'workspace', 'project'] as const)('isolates detached %s callbacks and leaves other current owners protected', async scope => {
    const ui = example();
    const old = ui.get();
    act(() => { old.set(TASK, { [FIELD_ID]: dirty() }); ui.get('second').set(TASK, { [FIELD_ID]: dirty('other owner') }); });
    await ui.user.click(screen.getByRole('button', { name: `Change ${scope}` }));
    expect(ui.get().size).toBe(0);
    act(() => { ui.get('second').clear(); old.set(TASK, { [FIELD_ID]: dirty('late old callback') }); });
    expect(unload()).toBe(false);
    expect(protectedDraftsFor(ui.client).protecting).toBe(false);
  });
});
