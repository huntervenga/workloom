import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
