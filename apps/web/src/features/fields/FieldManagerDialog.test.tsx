import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../../lib/queryKeys';
import { alpha, anna, created, failure, installFakeApi, ok } from '../../test/fakeApi';
import { FieldManagerDialog } from './FieldManagerDialog';
import { FIELD_ID, OTHER_FIELD_ID, OPTION_ID, PROJECT_ID, STAMP, columns, columnsPath, field, fieldsPath, heldResponse, renderFieldUi } from './test/fixtures';

function manager() {
  return <FieldManagerDialog actorId={anna.id} workspaceId={alpha.id} projectId={PROJECT_ID} canManage />;
}

async function open(user: ReturnType<typeof renderFieldUi>['user']) {
  await user.click(screen.getByRole('button', { name: "Columns" }));
  return screen.findByRole('dialog', { name: "Project columns" });
}

async function close(user: ReturnType<typeof renderFieldUi>['user']) {
  const dialog = screen.getByRole('dialog', { name: "Project columns" });
  await user.click(within(dialog).getByRole('button', { name: "Close" }));
}

function expectExactRetry(writes: { body: unknown; headers: Headers }[]) {
  expect(writes).toHaveLength(2);
  expect(writes[1]?.body).toEqual(writes[0]?.body);
  const key = writes[0]?.headers.get('idempotency-key');
  expect(key).toMatch(/^[0-9a-f-]{36}$/);
  expect(writes[1]?.headers.get('idempotency-key')).toBe(key);
}

describe('column manager command boundaries', () => {
  it('keeps an uncertain field create frozen after closing and reopening, then retries the original command', async () => {
    const gate = heldResponse();
    const added = field('Согласование');
    let saved = false;
    let attempts = 0;
    const { calls } = installFakeApi({
      ['GET ' + fieldsPath]: () => ok(saved ? [added] : []),
      ['GET ' + columnsPath]: () => ok(columns(saved ? [added] : [])),
      ['POST ' + fieldsPath]: () => {
        saved = true;
        attempts += 1;
        return attempts === 1 ? gate.promise : created(added);
      },
    });
    const { user } = renderFieldUi(manager());
    let dialog = await open(user);
    await user.click(await within(dialog).findByRole('button', { name: "Add column" }));
    await user.type(within(dialog).getByLabelText("Column name"), 'Согласование');
    await user.click(within(dialog).getByRole('button', { name: "Add column" }));
    await waitFor(() => expect(attempts).toBe(1));
    await close(user);
    dialog = await open(user);
    expect(within(dialog).getByLabelText("Column name")).toHaveValue('Согласование');
    expect(within(dialog).getByLabelText("Column name")).toHaveAttribute('readonly');
    await act(async () => gate.lose());
    await within(dialog).findByRole('button', { name: "Retry submission" });
    await close(user);
    dialog = await open(user);
    expect(within(dialog).getByLabelText("Column name")).toHaveValue('Согласование');
    await user.click(within(dialog).getByRole('button', { name: "Retry submission" }));
    await waitFor(() => expect(within(dialog).queryByLabelText("Column name")).not.toBeInTheDocument());
    expectExactRetry(calls.filter((call) => call.method === 'POST'));
  });

  it('restores an unconfirmed shared layout across dialog remounts with the original settings revision and key', async () => {
    const first = field('Заметка');
    const second = field('Число', 'number', OTHER_FIELD_ID);
    const original = columns([first, second]);
    const gate = heldResponse();
    let attempts = 0;
    let remote = original;
    const { calls } = installFakeApi({
      ['GET ' + fieldsPath]: () => ok([first, second]),
      ['GET ' + columnsPath]: () => ok(remote),
      ['PATCH ' + columnsPath]: (request) => {
        attempts += 1;
        const input = request.body as { columns: typeof original.columns };
        remote = { ...original, revision: 2, columns: input.columns };
        return attempts === 1 ? gate.promise : ok(remote);
      },
    });
    const { user } = renderFieldUi(manager());
    let dialog = await open(user);
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Заметка' }));
    await user.click(within(dialog).getByRole('button', { name: "Move column “Число” up" }));
    await user.click(within(dialog).getByRole('button', { name: "Save layout" }));
    await waitFor(() => expect(attempts).toBe(1));
    await close(user);
    dialog = await open(user);
    expect(within(dialog).getByRole('checkbox', { name: 'Заметка' })).not.toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Заметка' })).toBeDisabled();
    await act(async () => gate.lose());
    await within(dialog).findByRole('button', { name: "Retry submission" });
    await close(user);
    dialog = await open(user);
    await user.click(within(dialog).getByRole('button', { name: "Retry submission" }));
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: "Retry submission" })).not.toBeInTheDocument());
    const writes = calls.filter((call) => call.method === 'PATCH');
    expectExactRetry(writes);
    expect(writes[0]?.body).toEqual({
      expectedRevision: 1,
      columns: [
        { fieldId: OTHER_FIELD_ID, visible: true, width: 160, position: 0 },
        { fieldId: FIELD_ID, visible: false, width: 160, position: 1 },
      ],
    });
  });

  it('keeps an option create pending through field-selection attempts and manager reopening', async () => {
    const select = field('Тип работы', 'single_select');
    const other = field('Подробности', 'text', OTHER_FIELD_ID);
    let remote = select;
    let attempts = 0;
    const gate = heldResponse();
    const { calls } = installFakeApi({
      ['GET ' + fieldsPath]: () => ok([remote, other]),
      ['GET ' + columnsPath]: () => ok(columns([select, other])),
      ['POST ' + fieldsPath + '/' + FIELD_ID + '/options']: () => {
        attempts += 1;
        remote = { ...select, revision: 2, options: [{ id: OPTION_ID, name: 'Встреча', color: null, position: 0, revision: 1, archivedAt: null }] };
        return attempts === 1 ? gate.promise : created(remote);
      },
    });
    const { user } = renderFieldUi(manager());
    let dialog = await open(user);
    await user.click(await within(dialog).findByRole('button', { name: "Edit column “Тип работы”" }));
    await user.type(within(dialog).getByLabelText("New option"), 'Встреча');
    await user.click(within(dialog).getByRole('button', { name: "Add option" }));
    await waitFor(() => expect(attempts).toBe(1));
    await user.click(within(dialog).getByRole('button', { name: "Edit column “Подробности”" }));
    expect(within(dialog).getByLabelText("New option")).toHaveValue('Встреча');
    await close(user);
    dialog = await open(user);
    expect(within(dialog).getByLabelText("New option")).toHaveValue('Встреча');
    expect(within(dialog).getByLabelText("New option")).toHaveAttribute('readonly');
    await act(async () => gate.lose());
    await user.click(await within(dialog).findByRole('button', { name: "Retry submission" }));
    await waitFor(() => expect(attempts).toBe(2));
    expectExactRetry(calls.filter((call) => call.method === 'POST'));
  });

  it.each([403, 404])('hides cached definitions and editors after an authoritative %s refetch', async (status) => {
    const secret = field('Скрытая колонка');
    let allowed = true;
    installFakeApi({
      ['GET ' + fieldsPath]: () => allowed ? ok([secret]) : failure(status, status === 403 ? 'FORBIDDEN' : 'NOT_FOUND', 'private detail'),
      ['GET ' + columnsPath]: () => ok(columns([secret])),
    });
    const { user, client } = renderFieldUi(manager());
    const dialog = await open(user);
    await user.click(await within(dialog).findByRole('button', { name: "Edit column “Скрытая колонка”" }));
    expect(within(dialog).getByLabelText("Column name")).toHaveValue(secret.name);
    allowed = false;
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.fieldDefinitions(anna.id, alpha.id, PROJECT_ID) }); });
    await within(dialog).findByRole('alert');
    expect(within(dialog).queryByText(secret.name)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Column name")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: "Save" })).not.toBeInTheDocument();
  });

  it('offers exact-key retry when another actor archives the target of an uncertain definition edit', async () => {
    const original = field('Заметка');
    let remote = original;
    const gate = heldResponse();
    let attempts = 0;
    const { calls } = installFakeApi({
      ['GET ' + fieldsPath]: () => ok([remote]),
      ['GET ' + columnsPath]: () => ok(columns(remote.archivedAt ? [] : [remote])),
      ['PATCH ' + fieldsPath + '/' + FIELD_ID]: () => {
        attempts += 1;
        return attempts === 1 ? gate.promise : ok({ ...original, revision: 2, name: 'Новая заметка' });
      },
    });
    const { user, client } = renderFieldUi(manager());
    let dialog = await open(user);
    await user.click(await within(dialog).findByRole('button', { name: "Edit column “Заметка”" }));
    const input = within(dialog).getByLabelText("Column name");
    await user.clear(input);
    await user.type(input, 'Новая заметка');
    await user.click(within(dialog).getByRole('button', { name: "Save" }));
    await waitFor(() => expect(attempts).toBe(1));
    await act(async () => gate.lose());
    remote = { ...original, revision: 3, archivedAt: STAMP };
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.fields(anna.id, alpha.id) }); });
    await within(dialog).findByRole('button', { name: "Retry column change" });
    await close(user);
    dialog = await open(user);
    await user.click(within(dialog).getByRole('button', { name: "Retry column change" }));
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: "Retry column change" })).not.toBeInTheDocument());
    expectExactRetry(calls.filter((call) => call.method === 'PATCH'));
  });
});


it('archives a field without deleting its identity or history and restores it from archived fields', async () => {
  let stored = field('Hours Estimation', 'duration');
  const { calls } = installFakeApi({
    ['GET ' + fieldsPath]: () => ok([stored]),
    ['GET ' + columnsPath]: () => ok(columns(stored.archivedAt ? [] : [stored], stored.revision)),
    ['PATCH ' + fieldsPath + '/' + FIELD_ID]: request => {
      const input = request.body as { expectedRevision: number; archived: boolean };
      stored = { ...stored, revision: stored.revision + 1, archivedAt: input.archived ? STAMP : null };
      return ok(stored);
    },
  });
  const { user } = renderFieldUi(manager());
  const dialog = await open(user);
  await user.click(await within(dialog).findByRole('button', { name: 'Edit column “Hours Estimation”' }));
  await user.click(within(dialog).getByRole('button', { name: 'Archive field for the project' }));
  const summary = await within(dialog).findByText('Archived fields');
  await user.click(summary);
  await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
  await waitFor(() => expect(within(dialog).queryByText('Archived fields')).not.toBeInTheDocument());
  const writes = calls.filter(call => call.method === 'PATCH');
  expect(writes).toHaveLength(2);
  expect(writes[0]?.body).toEqual({ expectedRevision: 1, archived: true });
  expect(writes[1]?.body).toEqual({ expectedRevision: 2, archived: false });
  expect(writes.every(call => call.path.includes(FIELD_ID))).toBe(true);
  expect(calls.some(call => call.method === 'DELETE')).toBe(false);
  expect(stored.historyEnabled).toBe(true);
});

describe('field header shortcuts and option colors', () => {
  it('opens the requested field directly and edits colors by stable option ID and current revision', async () => {
    let current = { ...field('ReportType', 'single_select'), options: [{ id: OPTION_ID, name: 'Bugfix', color: null as string | null, position: 0, revision: 1, archivedAt: null }] };
    const other = field('Other field', 'text', OTHER_FIELD_ID);
    const { calls } = installFakeApi({
      ['GET ' + fieldsPath]: () => ok([other, current]),
      ['GET ' + columnsPath]: () => ok(columns([other, current])),
      ['PATCH ' + fieldsPath + '/' + FIELD_ID + '/options/' + OPTION_ID]: request => {
        const input = request.body as { expectedRevision: number; color: string | null };
        expect(input.expectedRevision).toBe(current.revision);
        current = { ...current, revision: current.revision + 1, options: current.options.map(option => ({ ...option, color: input.color, revision: option.revision + 1 })) };
        return ok(current);
      },
    });
    const { user } = renderFieldUi(<FieldManagerDialog actorId={anna.id} workspaceId={alpha.id} projectId={PROJECT_ID} canManage initialFieldId={FIELD_ID}/>);
    let dialog = await open(user);
    await within(dialog).findByRole('region', { name: 'Options' });
    expect(within(dialog).getByLabelText('Column name')).toHaveValue('ReportType');
    await user.click(within(dialog).getByRole('button', { name: 'Change color for “Bugfix”' }));
    await user.click(within(dialog).getByRole('radio', { name: 'Purple' }));
    await waitFor(() => expect(current.options[0]?.color).toBe('#8b5cf6'));
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: 'Purple' })).toBeChecked());
    await user.click(within(dialog).getByRole('button', { name: 'No color' }));
    await waitFor(() => expect(current.options[0]?.color).toBeNull());
    expect(calls.filter(call => call.method === 'PATCH').map(call => call.body)).toEqual([
      { expectedRevision: 1, color: '#8b5cf6' }, { expectedRevision: 2, color: null },
    ]);
    expect(current.options[0]?.id).toBe(OPTION_ID);
    await close(user);
    dialog = await open(user);
    await user.click(await within(dialog).findByRole('button', { name: 'Change color for “Bugfix”' }));
    expect(within(dialog).getByRole('button', { name: 'No color' })).toBeDisabled();
  });

  it('retains an unknown option color command through reopening and retries the identical payload', async () => {
    const gate = heldResponse();
    const select = { ...field('ReportType', 'single_select'), options: [{ id: OPTION_ID, name: 'Bugfix', color: null, position: 0, revision: 1, archivedAt: null }] };
    let attempts = 0;
    const { calls } = installFakeApi({
      ['GET ' + fieldsPath]: () => ok([select]),
      ['GET ' + columnsPath]: () => ok(columns([select])),
      ['PATCH ' + fieldsPath + '/' + FIELD_ID + '/options/' + OPTION_ID]: () => { attempts++; return attempts === 1 ? gate.promise : ok({ ...select, revision: 2, options: [{ ...select.options[0], color: '#ef4444' }] }); },
    });
    const { user } = renderFieldUi(<FieldManagerDialog actorId={anna.id} workspaceId={alpha.id} projectId={PROJECT_ID} canManage initialFieldId={FIELD_ID}/>);
    let dialog = await open(user);
    await user.click(await within(dialog).findByRole('button', { name: 'Change color for “Bugfix”' }));
    await user.click(within(dialog).getByRole('radio', { name: 'Red' }));
    await waitFor(() => expect(attempts).toBe(1));
    await close(user); await act(async () => gate.lose()); dialog = await open(user);
    const retry = await within(dialog).findByRole('button', { name: 'Retry submission' });
    expect(within(dialog).getByRole('radio', { name: 'Red' })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: 'Blue' })).toBeDisabled();
    await user.click(retry);
    await waitFor(() => expect(attempts).toBe(2));
    expectExactRetry(calls.filter(call => call.method === 'PATCH'));
    expect(calls.find(call => call.method === 'PATCH')?.body).toEqual({ expectedRevision: 1, color: '#ef4444' });
  });
});


it('offers the selected ordinary field in the shared project check editor without writing or discarding the field form', async () => {
  const definition = field('Effort allowance', 'duration');
  const { calls } = installFakeApi({ ['GET ' + fieldsPath]: () => ok([definition]), ['GET ' + columnsPath]: () => ok(columns([definition])) });
  const configure = vi.fn();
  const ui = renderFieldUi(<FieldManagerDialog actorId={anna.id} workspaceId={alpha.id} projectId={PROJECT_ID} canManage open initialFieldId={definition.id} onConfigurePlanningCheck={configure} />);
  const dialog = await screen.findByRole('dialog', { name: 'Project columns' });
  const name = await within(dialog).findByLabelText('Column name');
  await ui.user.clear(name); await ui.user.type(name, 'Unsubmitted rename');
  await ui.user.click(within(dialog).getByRole('button', { name: 'Configure planning check for Effort allowance' }));
  expect(configure).toHaveBeenCalledExactlyOnceWith(definition.id);
  expect(name).toHaveValue('Unsubmitted rename');
  expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});
