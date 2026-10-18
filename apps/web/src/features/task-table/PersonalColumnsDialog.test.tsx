import type { ColumnChoice, PersonalTablePreferenceDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { alpha, anna, deferred, failure, installFakeApi, ok, renderApp, type RouteTable } from '../../test/fakeApi';
import { columns, field, PROJECT_ID, renderFieldUi } from '../fields/test/fixtures';
import { tableRoutes, tablePath, task } from '../work-categories/test/fixtures';
import { MEMBER_ID, rootPath } from '../planning/test/fixtures';
import { PersonalColumnsDialog } from './PersonalColumnsDialog';
import { usePersonalTablePreference, type PersonalTablePreferenceController } from './usePersonalTablePreference';

const path = `${rootPath}/projects/${PROJECT_ID}/table-preferences/me`;
const note = field('Stored note');
const title: ColumnChoice = { column: { kind: 'builtin', key: 'title' }, visible: true };
const head = (revision = 0, choices: ColumnChoice[] | null = null): PersonalTablePreferenceDto => ({ workspaceId: alpha.id, projectId: PROJECT_ID, membershipId: MEMBER_ID, revision, columns: choices });
function example(table: RouteTable) {
  const api = installFakeApi(table); let current: PersonalTablePreferenceController | null = null;
  function Example() {
    const controller = usePersonalTablePreference(anna.id, alpha.id, PROJECT_ID, MEMBER_ID); current = controller;
    return <><PersonalColumnsDialog controller={controller} fields={[note]} projectColumns={columns([note])} timeAvailable={false} catalogError={null} onReloadCatalog={async () => undefined} /><span data-testid="head">{JSON.stringify(controller.query.data)}</span><button>Outside QA focus</button></>;
  }
  return { ...renderFieldUi(<Example />), ...api, controller: () => { if (!current) throw new Error('Missing preference controller'); return current; } };
}
async function open(ui: ReturnType<typeof example>) {
  await waitFor(() => expect(ui.controller().query.isSuccess).toBe(true));
  await ui.user.click(screen.getByRole('button', { name: /^Columns/ }));
}

describe('personal column chooser and page-owned commands', () => {
  it('keeps title pinned, moves columns with keyboard focus, and writes only after explicit Save', async () => {
    let persisted = head();
    const ui = example({ [`GET ${path}`]: () => ok(persisted), [`PUT ${path}`]: request => { persisted = head(1, (request.body as { columns: ColumnChoice[] }).columns); return ok(persisted); } });
    await open(ui);
    expect(screen.getByLabelText(/TaskAlways visible/)).toBeDisabled();
    await ui.user.click(screen.getByRole('button', { name: 'Move Assignee up' }));
    expect(screen.getByRole('button', { name: 'Move Assignee down' })).toHaveFocus();
    await ui.user.click(screen.getByLabelText('Tags'));
    expect(ui.calls.filter(call => call.method === 'PUT')).toHaveLength(0);
    await ui.user.click(screen.getByRole('button', { name: 'Save columns' }));
    await waitFor(() => expect(ui.controller().head).toBe('idle'));
    const write = ui.calls.find(call => call.method === 'PUT');
    const input = write?.body as { expectedRevision: number; columns: ColumnChoice[] };
    expect(input.expectedRevision).toBe(0); expect(input.columns[0]).toEqual(title);
    expect(input.columns[1]?.column).toEqual({ kind: 'builtin', key: 'responsible' });
    expect(input.columns.find(choice => choice.column.kind === 'builtin' && choice.column.key === 'tags')?.visible).toBe(false);
    expect(write?.headers.get('Idempotency-Key')).toBeTruthy();
    await waitFor(() => expect(ui.controller().query.data?.revision).toBe(1));
  });

  it('retains unsent visibility/order after Escape and reopens without any write', async () => {
    const ui = example({ [`GET ${path}`]: () => ok(head()) }); await open(ui);
    await ui.user.click(screen.getByLabelText('Tags')); await ui.user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Columns · unsaved' }));
    expect(screen.getByLabelText('Tags')).not.toBeChecked();
    expect(ui.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });

  it('locks a reopened pending snapshot then refetches the authoritative head rather than installing an old receipt', async () => {
    const response = deferred<Response>(); let current = head(1, [title]);
    const ui = example({ [`GET ${path}`]: () => ok(current), [`PUT ${path}`]: () => response.promise }); await open(ui);
    await ui.user.click(screen.getByLabelText('Tags')); await ui.user.click(screen.getByRole('button', { name: 'Save columns' }));
    await waitFor(() => expect(ui.controller().held).not.toBeNull());
    await ui.user.keyboard('{Escape}'); await ui.user.click(screen.getByRole('button', { name: 'Columns · unsaved' }));
    expect(screen.getByLabelText('Tags')).toBeDisabled();
    const newer = [title, { column: { kind: 'builtin' as const, key: 'estimate' as const }, visible: false }];
    current = head(3, newer);
    await act(async () => response.resolve(ok(head(2, [title]))));
    await waitFor(() => expect(ui.controller().query.data?.revision).toBe(3));
    expect(ui.controller().query.data?.columns).toEqual(newer); expect(ui.controller().draft).toBeNull();
    const estimate = screen.getByLabelText('Team estimateAvailable in Legacy time columns; your saved visibility is preserved.');
    expect(estimate).toBeDisabled(); expect(estimate).not.toBeChecked();
    expect(ui.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
  });

  it('retries an unconfirmed layout with the same original body/revision/key after remount', async () => {
    let lose: () => void = () => undefined; let attempt = 0; let current = head(4, [title]);
    const first = new Promise<Response>((_resolve, reject) => { lose = () => reject(new TypeError('Failed to fetch')); });
    const ui = example({ [`GET ${path}`]: () => ok(current), [`PUT ${path}`]: request => { if (++attempt === 1) return first; current = head(5, (request.body as { columns: ColumnChoice[] }).columns); return ok(current); } }); await open(ui);
    await ui.user.click(screen.getByLabelText('Tags')); await ui.user.click(screen.getByRole('button', { name: 'Save columns' }));
    await waitFor(() => expect(attempt).toBe(1)); await act(async () => lose());
    await screen.findByRole('button', { name: 'Retry original columns' }); await ui.user.keyboard('{Escape}');
    await ui.user.click(screen.getByRole('button', { name: 'Columns · unsaved' }));
    expect(screen.getByLabelText('Tags')).toBeDisabled();
    await ui.user.click(screen.getByRole('button', { name: 'Retry original columns' }));
    await waitFor(() => expect(ui.controller().query.data?.revision).toBe(5));
    const writes = ui.calls.filter(call => call.method === 'PUT'); expect(writes).toHaveLength(2);
    expect(writes[0]?.body).toEqual(writes[1]?.body); expect((writes[0]?.body as { expectedRevision: number }).expectedRevision).toBe(4);
    expect(writes[0]?.headers.get('Idempotency-Key')).toBe(writes[1]?.headers.get('Idempotency-Key'));
  });

  it('keeps a conflict draft until an explicit reload/review supplies the next preference revision', async () => {
    let current = head(1, [title]); let attempt = 0;
    const ui = example({ [`GET ${path}`]: () => ok(current), [`PUT ${path}`]: request => ++attempt === 1 ? failure(409, 'REVISION_CONFLICT', 'private preference internals') : ok(current = head(3, (request.body as { columns: ColumnChoice[] }).columns)) }); await open(ui);
    await ui.user.click(screen.getByLabelText('Tags')); await ui.user.click(screen.getByRole('button', { name: 'Save columns' }));
    await waitFor(() => expect(ui.controller().command.error).not.toBeNull());
    expect(screen.getByLabelText('Tags')).not.toBeChecked(); expect(screen.getByRole('button', { name: 'Save columns' })).toBeDisabled();
    expect(screen.queryByText('private preference internals')).not.toBeInTheDocument();
    current = head(2, [title]); await ui.user.click(screen.getByRole('button', { name: 'Reload and review' }));
    await waitFor(() => expect(ui.controller().draft?.expectedRevision).toBe(2));
    expect(screen.getByLabelText('Tags')).not.toBeChecked();
    await ui.user.click(screen.getByRole('button', { name: 'Save columns' }));
    await waitFor(() => expect(attempt).toBe(2));
    expect((ui.calls.filter(call => call.method === 'PUT')[1]?.body as { expectedRevision: number }).expectedRevision).toBe(2);
  });

  it('saves reset as null at the current revision without returning the persisted row to zero', async () => {
    let current = head(6, [title]);
    const ui = example({ [`GET ${path}`]: () => ok(current), [`PUT ${path}`]: () => ok(current = head(7)) }); await open(ui);
    await ui.user.click(screen.getByRole('button', { name: 'Use project defaults' }));
    expect(ui.calls.filter(call => call.method === 'PUT')).toHaveLength(0);
    await ui.user.click(screen.getByRole('button', { name: 'Save columns' }));
    await waitFor(() => expect(ui.controller().query.data?.revision).toBe(7));
    expect(ui.calls.find(call => call.method === 'PUT')?.body).toEqual({ expectedRevision: 6, columns: null });
    expect(ui.controller().query.data?.columns).toBeNull();
  });

  it('hides cached preference choices on current denial and cannot recover merely by discarding the draft', async () => {
    const ui = example({ [`GET ${path}`]: () => ok(head()), [`PUT ${path}`]: () => failure(403, 'FORBIDDEN', 'private settings') }); await open(ui);
    await ui.user.click(screen.getByLabelText('Tags')); await ui.user.click(screen.getByRole('button', { name: 'Save columns' }));
    await waitFor(() => expect(ui.controller().denied).toBe(true));
    expect(screen.queryByLabelText('Tags')).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(ui.controller().denied).toBe(true); expect(screen.queryByLabelText('Tags')).not.toBeInTheDocument();
  });
});

it('confirms a closed columns dialog without reopening it or taking outside focus', async () => {
  let current = head(); const response = deferred<Response>();
  const ui = example({ [`GET ${path}`]: () => ok(current), [`PUT ${path}`]: () => response.promise }); await open(ui);
  await ui.user.click(screen.getByLabelText('Tags')); await ui.user.click(screen.getByRole('button', { name: 'Save columns' }));
  await waitFor(() => expect(ui.controller().held).not.toBeNull()); await ui.user.keyboard('{Escape}');
  await ui.user.click(screen.getByRole('button', { name: 'Outside QA focus' })); current = head(1, [title]);
  await act(async () => response.resolve(ok(current)));
  await waitFor(() => expect(ui.controller().head).toBe('idle'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Outside QA focus' })).toHaveFocus();
  expect(ui.controller().draft).toBeNull();
});

it('cancels a pre-save head read before fetching the authoritative post-confirmation head', async () => {
  let count = 0; let fresh = head(); const stale = deferred<Response>(); const response = deferred<Response>();
  const ui = example({ [`GET ${path}`]: () => ++count === 2 ? stale.promise : ok(fresh), [`PUT ${path}`]: () => response.promise }); await open(ui);
  await ui.user.click(screen.getByLabelText('Tags')); await ui.user.click(screen.getByRole('button', { name: 'Save columns' }));
  await waitFor(() => expect(ui.controller().held).not.toBeNull());
  act(() => { void ui.controller().query.refetch(); }); await waitFor(() => expect(count).toBe(2));
  fresh = head(5, [title]);
  await act(async () => response.resolve(ok(head(2, [title]))));
  await waitFor(() => expect(ui.controller().query.data?.revision).toBe(5));
  await act(async () => stale.resolve(ok(head(1, [title]))));
  expect(ui.controller().query.data?.revision).toBe(5); expect(count).toBe(3);
});

it('keeps confirmed feedback after head refresh and clears it only when the next edit begins', async () => {
  let current = head();
  const ui = example({ [`GET ${path}`]: () => ok(current), [`PUT ${path}`]: request => ok(current = head(1, (request.body as { columns: ColumnChoice[] }).columns)) }); await open(ui);
  await ui.user.click(screen.getByLabelText('Tags')); await ui.user.click(screen.getByRole('button', { name: 'Save columns' }));
  await screen.findByText('Columns saved. Current settings refreshed.');
  expect(screen.getByRole('dialog')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Save columns' })).toBeDisabled();
  await ui.user.keyboard('{Escape}'); await ui.user.click(screen.getByRole('button', { name: 'Columns' }));
  expect(screen.getByText('Columns saved. Current settings refreshed.')).toBeVisible();
  await ui.user.click(screen.getByLabelText('Tags'));
  expect(screen.queryByText('Columns saved. Current settings refreshed.')).not.toBeInTheDocument();
});

it('requires a successful authoritative reload when confirmation succeeds but head refresh fails', async () => {
  let saved = false; let failRefresh = true;
  const ui = example({ [`GET ${path}`]: () => saved && failRefresh ? failure(503, 'UNAVAILABLE', 'internal read failure') : ok(head(saved ? 8 : 7, [title])), [`PUT ${path}`]: () => { saved = true; return ok(head(8, [title])); } }); await open(ui);
  await ui.user.click(screen.getByLabelText('Tags')); await ui.user.click(screen.getByRole('button', { name: 'Save columns' }));
  await waitFor(() => expect(ui.controller().head).toBe('failed'));
  expect(screen.getByRole('button', { name: 'Save columns' })).toBeDisabled();
  expect(screen.queryByText('Columns saved. Current settings refreshed.')).not.toBeInTheDocument();
  expect(ui.controller().query.data?.revision).toBe(7);
  failRefresh = false; await ui.user.click(screen.getByRole('button', { name: 'Reload and review' }));
  await screen.findByText('Columns saved. Current settings refreshed.'); expect(ui.controller().query.data?.revision).toBe(8);
  expect(ui.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
});

it('keeps original task-command recovery reachable when a saved preference hides its inline date editor', async () => {
  let preference = head(); let lose: () => void = () => undefined;
  const unknown = new Promise<Response>((_resolve, reject) => { lose = () => reject(new TypeError('Failed to fetch')); });
  const { calls } = installFakeApi({ ...tableRoutes(), [`GET ${path}`]: () => ok(preference), [`GET ${rootPath}/tasks/${task.id}`]: () => ok(task), [`PATCH ${rootPath}/tasks/${task.id}`]: () => unknown, [`PUT ${path}`]: request => ok(preference = head(1, (request.body as { columns: ColumnChoice[] }).columns)) });
  const { user } = renderApp(tablePath);
  await user.click(await screen.findByRole('button', { name: `Edit due date for ${task.title}` }));
  fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-10-20' } });
  await user.keyboard('{Enter}');
  await waitFor(() => expect(calls.some(call => call.method === 'PATCH')).toBe(true));
  await act(async () => lose()); await screen.findByRole('button', { name: 'Retry' });
  await user.click(screen.getByRole('button', { name: 'Columns' }));
  const dialog = screen.getByRole('dialog', { name: 'My task columns' });
  await user.click(within(dialog).getByLabelText('Due date')); await user.click(within(dialog).getByRole('button', { name: 'Save columns' }));
  await screen.findByText('Columns saved. Current settings refreshed.'); await user.keyboard('{Escape}');
  expect(screen.queryByRole('columnheader', { name: 'Due date' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Due date')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Resume original editor' }));
  const drawer = await screen.findByRole('dialog', { name: task.title });
  expect(within(drawer).getByLabelText('Due date')).toHaveValue('2026-10-20');
  expect(within(drawer).getByLabelText('Due date')).toBeDisabled();
  expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
});

it('refreshes the authoritative head after discarding a conflict and blocks stale edits until it arrives', async () => {
  let current = head(1, [title]); let attempt = 0; let refresh: Promise<Response> | null = null;
  const ui = example({
    [`GET ${path}`]: () => refresh ?? ok(current),
    [`PUT ${path}`]: request => { if (++attempt === 1) { current = head(2, [title]); return failure(409, 'REVISION_CONFLICT', 'private preference internals'); } return ok(current = head(3, (request.body as { columns: ColumnChoice[] }).columns)); },
  }); await open(ui);
  await ui.user.click(screen.getByLabelText('Tags')); await ui.user.click(screen.getByRole('button', { name: 'Save columns' }));
  await waitFor(() => expect(ui.controller().command.error).not.toBeNull());
  const response = deferred<Response>(); refresh = response.promise;
  const reads = ui.calls.filter(call => call.method === 'GET').length;
  await ui.user.click(screen.getByRole('button', { name: 'Discard changes' }));
  await waitFor(() => expect(ui.calls.filter(call => call.method === 'GET')).toHaveLength(reads + 1));
  expect(ui.controller().head).toBe('loading');
  expect(ui.controller().draft).toBeNull(); expect(ui.controller().command.error).toBeNull();
  expect(screen.getByLabelText('Tags')).toBeDisabled(); expect(screen.getByRole('button', { name: 'Save columns' })).toBeDisabled();
  act(() => { ui.controller().setDraft([title]); });
  act(() => { ui.controller().save([title]); });
  expect(ui.controller().draft).toBeNull(); expect(ui.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
  refresh = null; await act(async () => response.resolve(ok(current)));
  await waitFor(() => expect(ui.controller().head).toBe('idle'));
  expect(ui.controller().query.data?.revision).toBe(2); expect(screen.getByLabelText('Tags')).toBeChecked();
  await ui.user.click(screen.getByLabelText('Tags'));
  expect(ui.controller().draft?.expectedRevision).toBe(2);
  await ui.user.click(screen.getByRole('button', { name: 'Save columns' }));
  await waitFor(() => expect(ui.controller().query.data?.revision).toBe(3));
  const writes = ui.calls.filter(call => call.method === 'PUT'); expect(writes).toHaveLength(2);
  expect((writes[1]?.body as { expectedRevision: number }).expectedRevision).toBe(2);
});

it('keeps editing blocked with explicit reload when the post-conflict discard refresh fails', async () => {
  let current = head(1, [title]); let attempt = 0; let failRefresh = false;
  const ui = example({
    [`GET ${path}`]: () => failRefresh ? failure(503, 'UNAVAILABLE', 'internal read failure') : ok(current),
    [`PUT ${path}`]: request => { if (++attempt === 1) { current = head(2, [title]); return failure(409, 'REVISION_CONFLICT', 'private preference internals'); } return ok(current = head(3, (request.body as { columns: ColumnChoice[] }).columns)); },
  }); await open(ui);
  await ui.user.click(screen.getByLabelText('Tags')); await ui.user.click(screen.getByRole('button', { name: 'Save columns' }));
  await waitFor(() => expect(ui.controller().command.error).not.toBeNull());
  failRefresh = true; await ui.user.click(screen.getByRole('button', { name: 'Discard changes' }));
  await waitFor(() => expect(ui.controller().head).toBe('failed'));
  expect(ui.controller().query.data?.revision).toBe(1); expect(ui.controller().denied).toBe(false);
  expect(screen.getByLabelText('Tags')).toBeDisabled(); expect(screen.getByRole('button', { name: 'Save columns' })).toBeDisabled();
  act(() => { ui.controller().setDraft([title]); }); expect(ui.controller().draft).toBeNull();
  failRefresh = false; await ui.user.click(screen.getByRole('button', { name: 'Reload and review' }));
  await waitFor(() => expect(ui.controller().head).toBe('idle'));
  expect(ui.controller().query.data?.revision).toBe(2);
  await ui.user.click(screen.getByLabelText('Tags')); await ui.user.click(screen.getByRole('button', { name: 'Save columns' }));
  await waitFor(() => expect(ui.controller().query.data?.revision).toBe(3));
  const writes = ui.calls.filter(call => call.method === 'PUT'); expect(writes).toHaveLength(2);
  expect((writes[1]?.body as { expectedRevision: number }).expectedRevision).toBe(2);
});
