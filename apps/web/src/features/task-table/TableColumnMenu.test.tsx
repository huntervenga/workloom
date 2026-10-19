import type { ColumnChoice, PersonalTablePreferenceDto } from '@workloom/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { alpha, anna, created, installFakeApi, ok, type RouteTable } from '../../test/fakeApi';
import { columns, columnsPath, field, fieldsPath, heldResponse, PROJECT_ID, renderFieldUi } from '../fields/test/fixtures';
import { MEMBER_ID, rootPath } from '../planning/test/fixtures';
import { TableColumnMenu } from './TableColumnMenu';
import { usePersonalTablePreference, type PersonalTablePreferenceController } from './usePersonalTablePreference';

const path = `${rootPath}/projects/${PROJECT_ID}/table-preferences/me`;
const note = field('Team notes');
const head = (revision = 0, choices: ColumnChoice[] | null = null): PersonalTablePreferenceDto => ({ workspaceId: alpha.id, projectId: PROJECT_ID, membershipId: MEMBER_ID, revision, columns: choices });
function example(routes: RouteTable, canManage = true) {
  const api = installFakeApi({ [`GET ${fieldsPath}`]: () => ok([note]), [`GET ${columnsPath}`]: () => ok(columns([note])), ...routes });
  let current: PersonalTablePreferenceController | null = null;
  function Example() {
    const controller = usePersonalTablePreference(anna.id, alpha.id, PROJECT_ID, MEMBER_ID); current = controller;
    return <TableColumnMenu actorId={anna.id} workspaceId={alpha.id} projectId={PROJECT_ID} canManage={canManage} controller={controller} fields={[note]} projectColumns={columns([note])} timeAvailable={false} catalogError={null} />;
  }
  return { ...renderFieldUi(<Example />), ...api, controller: () => { if (!current) throw new Error('No controller'); return current; } };
}
async function open(ui: ReturnType<typeof example>) {
  await waitFor(() => expect(ui.controller().query.isSuccess).toBe(true));
  await ui.user.click(screen.getByRole('button', { name: 'Add or show columns' }));
  return screen.findByRole('menu');
}
async function createPopover(ui: ReturnType<typeof example>) {
  const menu = await open(ui);
  await ui.user.click(within(menu).getByRole('menuitem', { name: /Create field|Resume field creation/ }));
  return screen.findByRole('dialog', { name: 'Create field' });
}

describe('table header columns', () => {
  it('autosaves ordinary column visibility, including Priority, without exposing legacy time columns', async () => {
    const legacy: ColumnChoice = { column: { kind: 'builtin', key: 'estimate' }, visible: true };
    let current = head(4, [{ column: { kind: 'builtin', key: 'title' }, visible: true }, legacy]);
    const ui = example({ [`GET ${path}`]: () => ok(current), [`PUT ${path}`]: request => ok(current = head(5, (request.body as { columns: ColumnChoice[] }).columns)) });
    const menu = await open(ui);
    expect(within(menu).queryByRole('menuitemcheckbox', { name: /Team estimate|weekly plan|actual hours/i })).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Task' })).toHaveAttribute('aria-disabled', 'true');
    await ui.user.click(within(menu).getByRole('menuitemcheckbox', { name: 'Priority' }));
    await waitFor(() => expect(ui.controller().query.data?.revision).toBe(5));
    const writes = ui.calls.filter(call => call.method === 'PUT');
    expect(writes).toHaveLength(1);
    const input = writes[0]?.body as { expectedRevision: number; columns: ColumnChoice[] };
    expect(input.expectedRevision).toBe(4);
    expect(input.columns[1]).toEqual(legacy);
    expect(input.columns.find(choice => choice.column.kind === 'builtin' && choice.column.key === 'priority')?.visible).toBe(true);
    expect(ui.controller().draft).toBeNull();
  });

  it('creates an ordinary duration field directly from the header using the shared definition command', async () => {
    const added = field('Hours Estimation', 'duration');
    const ui = example({ [`GET ${path}`]: () => ok(head()), [`POST ${fieldsPath}`]: () => created(added) });
    const dialog = await createPopover(ui);
    await ui.user.type(within(dialog).getByLabelText('Field name'), 'Hours Estimation');
    await ui.user.click(within(dialog).getByRole('button', { name: 'Field type' }));
    await ui.user.click(screen.getByRole('menuitem', { name: 'Duration' }));
    await ui.user.click(within(dialog).getByRole('button', { name: 'Create field' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create field' })).not.toBeInTheDocument());
    const write = ui.calls.find(call => call.method === 'POST');
    expect(write?.body).toEqual({ projectId: PROJECT_ID, name: 'Hours Estimation', type: 'duration', historyEnabled: true, locked: false, options: [] });
    expect(write?.headers.get('Idempotency-Key')).toBeTruthy();
  });

  it('retains a hidden pending create and retries an unknown outcome with exactly the original body and key', async () => {
    const gate = heldResponse(); let attempts = 0;
    const added = field('Delivery type', 'single_select');
    const ui = example({ [`GET ${path}`]: () => ok(head()), [`POST ${fieldsPath}`]: () => ++attempts === 1 ? gate.promise : created(added) });
    let dialog = await createPopover(ui);
    await ui.user.type(within(dialog).getByLabelText('Field name'), 'Delivery type');
    await ui.user.click(within(dialog).getByRole('button', { name: 'Field type' }));
    await ui.user.click(screen.getByRole('menuitem', { name: 'Single select' }));
    await ui.user.type(within(dialog).getByLabelText('Options · one per line'), 'Bug{Enter}Feature');
    await ui.user.click(within(dialog).getByRole('button', { name: 'Create field' }));
    await waitFor(() => expect(attempts).toBe(1));
    await ui.user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Create field' })).not.toBeInTheDocument();
    dialog = await createPopover(ui);
    expect(within(dialog).getByLabelText('Field name')).toHaveValue('Delivery type');
    expect(within(dialog).getByLabelText('Field name')).toHaveAttribute('readonly');
    await act(async () => gate.lose());
    await ui.user.click(await within(dialog).findByRole('button', { name: 'Retry original field' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create field' })).not.toBeInTheDocument());
    const writes = ui.calls.filter(call => call.method === 'POST');
    expect(writes).toHaveLength(2);
    expect(writes[0]?.body).toEqual({ projectId: PROJECT_ID, name: 'Delivery type', type: 'single_select', historyEnabled: true, locked: false, options: [{ name: 'Bug', color: null }, { name: 'Feature', color: null }] });
    expect(writes[1]?.body).toEqual(writes[0]?.body);
    expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
  });

  it('keeps personal column choices available to a member without field management capability', async () => {
    const ui = example({ [`GET ${path}`]: () => ok(head()) }, false);
    const menu = await open(ui);
    expect(within(menu).queryByRole('menuitem', { name: 'Create field' })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Field settings…' })).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Priority' })).not.toHaveAttribute('aria-disabled');
  });
});
