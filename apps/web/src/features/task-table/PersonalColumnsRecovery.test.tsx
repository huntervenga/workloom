import type { ColumnChoice, PersonalTablePreferenceDto } from '@workloom/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { alpha, anna, deferred, failure, installFakeApi, ok, type RouteTable } from '../../test/fakeApi';
import { columns, field, PROJECT_ID, renderFieldUi } from '../fields/test/fixtures';
import { MEMBER_ID, rootPath } from '../planning/test/fixtures';
import { PersonalColumnsDialog } from './PersonalColumnsDialog';
import { usePersonalTablePreference, type PersonalTablePreferenceController } from './usePersonalTablePreference';

const path = `${rootPath}/projects/${PROJECT_ID}/table-preferences/me`;
const note = field('Stored note');
const title: ColumnChoice = { column: { kind: 'builtin', key: 'title' }, visible: true };
const head = (revision = 0, choices: ColumnChoice[] | null = null): PersonalTablePreferenceDto => ({ workspaceId: alpha.id, projectId: PROJECT_ID, membershipId: MEMBER_ID, revision, columns: choices });
const pending = 'Your column settings are still being saved.';
const unknown = 'Your column save is unconfirmed. Open Columns to retry the original settings.';
const conflictCopy = 'Your column changes were not saved because your settings changed elsewhere. Review them to reload and continue.';
const failedCopy = 'Your column changes were not saved. Review them to continue.';
const deniedCopy = 'Your column changes were not saved. Column settings are unavailable with your current access.';
const headCopy = 'Current column settings could not be refreshed. Review them and reload before saving again.';
const accessCopy = 'Column settings are unavailable with your current access.';
const refreshingCopy = 'Refreshing the current column settings…';
const headRefreshCopy = 'Current column settings could not be refreshed. Reload before saving again.';
const hiddenTitle = 'Project unavailable';

/** The page keeps one controller while Table, Board and Graph swap; only Table shows the Columns trigger. */
function example(table: RouteTable) {
  const api = installFakeApi(table); let current: PersonalTablePreferenceController | null = null;
  function Example() {
    const controller = usePersonalTablePreference(anna.id, alpha.id, PROJECT_ID, MEMBER_ID); current = controller;
    const [tableMode, setTableMode] = useState(true);
    return <>
      <button onClick={() => setTableMode(false)}>Graph QA view</button>
      <PersonalColumnsDialog showTrigger={tableMode} controller={controller} fields={[note]} projectColumns={columns([note])} timeAvailable={false} catalogError={null} onReloadCatalog={async () => undefined} />
      <button>Outside QA focus</button>
    </>;
  }
  const ui = { ...renderFieldUi(<Example />), ...api, controller: () => { if (!current) throw new Error('Missing preference controller'); return current; } };
  return { ...ui, writes: () => ui.calls.filter(call => call.method === 'PUT').length, reads: () => ui.calls.filter(call => call.method === 'GET').length };
}
type Ui = ReturnType<typeof example>;

/** Edits Tags, sends Save, closes the dialog while held and leaves Table for a trigger-less view. */
async function holdSaveThenLeaveTable(ui: Ui) {
  await waitFor(() => expect(ui.controller().query.isSuccess).toBe(true));
  await ui.user.click(screen.getByRole('button', { name: /^Columns/ }));
  await ui.user.click(screen.getByLabelText('Tags')); await ui.user.click(screen.getByRole('button', { name: 'Save columns' }));
  await waitFor(() => expect(ui.controller().held).not.toBeNull());
  await ui.user.keyboard('{Escape}');
  await ui.user.click(screen.getByRole('button', { name: 'Graph QA view' }));
  expect(screen.queryByRole('button', { name: /^Columns/ })).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent(pending);
  await ui.user.click(screen.getByRole('button', { name: 'Outside QA focus' }));
}

describe('closed personal-column save recovery outside Table', () => {
  it('keeps a definitive conflict visible and reopenable without implicit writes, reloads or focus moves', async () => {
    const response = deferred<Response>();
    const ui = example({ [`GET ${path}`]: () => ok(head(1, [title])), [`PUT ${path}`]: () => response.promise });
    await holdSaveThenLeaveTable(ui);
    await act(async () => response.resolve(failure(409, 'REVISION_CONFLICT', 'private preference internals')));
    await waitFor(() => expect(ui.controller().held).toBeNull());
    expect(screen.getByRole('status')).toHaveTextContent(conflictCopy);
    expect(screen.queryByText(pending)).not.toBeInTheDocument();
    expect(screen.queryByText('private preference internals')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Outside QA focus' })).toHaveFocus();
    expect(ui.controller().draft).not.toBeNull(); expect(ui.controller().command.error).not.toBeNull();
    const reads = ui.reads();
    await ui.user.click(screen.getByRole('button', { name: 'Review columns' }));
    const dialog = screen.getByRole('dialog', { name: 'My task columns' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText('Tags')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Save columns' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reload and review' })).toBeEnabled();
    expect(screen.queryByText('private preference internals')).not.toBeInTheDocument();
    expect(ui.controller().command.error).not.toBeNull(); expect(ui.controller().draft).not.toBeNull();
    expect(ui.writes()).toBe(1); expect(ui.reads()).toBe(reads);
  });

  it('keeps a definitive denial blocked after reopen, discard and close', async () => {
    const response = deferred<Response>();
    const ui = example({ [`GET ${path}`]: () => ok(head()), [`PUT ${path}`]: () => response.promise });
    await holdSaveThenLeaveTable(ui);
    await act(async () => response.resolve(failure(403, 'FORBIDDEN', 'private settings')));
    await waitFor(() => expect(ui.controller().denied).toBe(true));
    expect(screen.getByRole('status')).toHaveTextContent(deniedCopy);
    expect(screen.queryByText('private settings')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Outside QA focus' })).toHaveFocus();
    const reads = ui.reads();
    await ui.user.click(screen.getByRole('button', { name: 'Review columns' }));
    expect(screen.getByRole('dialog', { name: 'My task columns' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Tags')).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(ui.controller().denied).toBe(true);
    await ui.user.keyboard('{Escape}');
    expect(screen.getByRole('status')).toHaveTextContent(deniedCopy);
    expect(screen.getByRole('button', { name: 'Review columns' })).toBeInTheDocument();
    expect(ui.writes()).toBe(1); expect(ui.reads()).toBe(reads);
  });

  it('shows generic safe copy for a definitive validation rejection and keeps the draft saveable after review', async () => {
    const response = deferred<Response>();
    const ui = example({ [`GET ${path}`]: () => ok(head(2, [title])), [`PUT ${path}`]: () => response.promise });
    await holdSaveThenLeaveTable(ui);
    await act(async () => response.resolve(failure(422, 'VALIDATION_FAILED', 'private validator detail')));
    await waitFor(() => expect(ui.controller().command.error).not.toBeNull());
    expect(screen.getByRole('status')).toHaveTextContent(failedCopy);
    expect(screen.queryByText('private validator detail')).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Review columns' }));
    expect(screen.getByLabelText('Tags')).not.toBeChecked();
    expect(ui.controller().draft?.expectedRevision).toBe(2); expect(ui.writes()).toBe(1);
  });

  it('keeps an acknowledged save whose current-head refresh failed visible until an explicit reload', async () => {
    const response = deferred<Response>(); let saved = false; let failRefresh = true;
    const ui = example({ [`GET ${path}`]: () => saved && failRefresh ? failure(503, 'UNAVAILABLE', 'internal read failure') : ok(head(saved ? 8 : 7, [title])), [`PUT ${path}`]: () => response.promise });
    await holdSaveThenLeaveTable(ui);
    saved = true; await act(async () => response.resolve(ok(head(8, [title]))));
    await waitFor(() => expect(ui.controller().head).toBe('failed'));
    expect(screen.getByRole('status')).toHaveTextContent(headCopy);
    expect(screen.queryByText('internal read failure')).not.toBeInTheDocument();
    expect(screen.queryByText('Columns saved. Current settings refreshed.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Outside QA focus' })).toHaveFocus();
    const reads = ui.reads();
    await ui.user.click(screen.getByRole('button', { name: 'Review columns' }));
    expect(ui.controller().head).toBe('failed'); expect(ui.reads()).toBe(reads);
    expect(screen.getByRole('button', { name: 'Save columns' })).toBeDisabled();
    failRefresh = false; await ui.user.click(screen.getByRole('button', { name: 'Reload and review' }));
    await screen.findByText('Columns saved. Current settings refreshed.');
    await ui.user.keyboard('{Escape}');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(ui.writes()).toBe(1);
  });

  it('says access is unavailable, without claiming the acknowledged save failed, when its current-head read is denied', async () => {
    const response = deferred<Response>(); let saved = false;
    const ui = example({ [`GET ${path}`]: () => saved ? failure(403, 'FORBIDDEN', 'private settings') : ok(head(3, [title])), [`PUT ${path}`]: () => response.promise });
    await holdSaveThenLeaveTable(ui);
    saved = true; await act(async () => response.resolve(ok(head(4, [title]))));
    await waitFor(() => expect(ui.controller().head).toBe('failed'));
    expect(ui.controller().denied).toBe(true); expect(ui.controller().command.error).toBeNull(); expect(ui.controller().saveConfirmed).toBe(true);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent(accessCopy);
    for (const copy of [deniedCopy, headCopy, failedCopy, 'not saved']) expect(banner).not.toHaveTextContent(copy);
    expect(screen.queryByText('private settings')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Outside QA focus' })).toHaveFocus();
    const reads = ui.reads();
    await ui.user.click(screen.getByRole('button', { name: 'Review columns' }));
    const dialog = screen.getByRole('dialog', { name: 'My task columns' });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(hiddenTitle);
    expect(screen.queryByLabelText('Tags')).not.toBeInTheDocument();
    await ui.user.keyboard('{Escape}');
    expect(screen.getByRole('status')).toHaveTextContent(accessCopy);
    expect(ui.writes()).toBe(1); expect(ui.reads()).toBe(reads);
  });

  it('keeps the unconfirmed retry copy distinct from definitive failures', async () => {
    let lose: () => void = () => undefined;
    const first = new Promise<Response>((_resolve, reject) => { lose = () => reject(new TypeError('Failed to fetch')); });
    const ui = example({ [`GET ${path}`]: () => ok(head(4, [title])), [`PUT ${path}`]: () => first });
    await holdSaveThenLeaveTable(ui);
    await act(async () => lose());
    await waitFor(() => expect(ui.controller().command.uncertain).not.toBeNull());
    expect(screen.getByRole('status')).toHaveTextContent(unknown);
    for (const copy of [conflictCopy, failedCopy, deniedCopy, headCopy]) expect(screen.queryByText(copy)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume column save' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review columns' })).not.toBeInTheDocument();
    expect(ui.writes()).toBe(1);
  });

  it('leaves no closed banner after a normal save refreshes the current head', async () => {
    const response = deferred<Response>(); let current = head();
    const ui = example({ [`GET ${path}`]: () => ok(current), [`PUT ${path}`]: () => response.promise });
    await holdSaveThenLeaveTable(ui);
    current = head(1, [title]); await act(async () => response.resolve(ok(current)));
    await waitFor(() => expect(ui.controller().query.data?.revision).toBe(1));
    await waitFor(() => expect(ui.controller().head).toBe('idle'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review columns' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Outside QA focus' })).toHaveFocus();
    expect(ui.writes()).toBe(1);
  });
});

it('also shows the closed failure beside the Table trigger without adding a second reopen action', async () => {
  const ui = example({ [`GET ${path}`]: () => ok(head(1, [title])), [`PUT ${path}`]: () => failure(409, 'REVISION_CONFLICT', 'private preference internals') });
  await waitFor(() => expect(ui.controller().query.isSuccess).toBe(true));
  await ui.user.click(screen.getByRole('button', { name: 'Columns' }));
  await ui.user.click(screen.getByLabelText('Tags')); await ui.user.click(screen.getByRole('button', { name: 'Save columns' }));
  await waitFor(() => expect(ui.controller().command.error).not.toBeNull());
  await ui.user.keyboard('{Escape}');
  expect(screen.getByRole('status')).toHaveTextContent(conflictCopy);
  expect(screen.getByRole('button', { name: 'Columns · unsaved' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Review columns' })).not.toBeInTheDocument();
  expect(ui.writes()).toBe(1);
});

it('shows the current command denial rather than an older unrelated head-read failure', async () => {
  let failRead = false;
  const ui = example({ [`GET ${path}`]: () => failRead ? failure(503, 'UNAVAILABLE', 'internal read failure') : ok(head(2, [title])), [`PUT ${path}`]: () => failure(403, 'FORBIDDEN', 'private settings') });
  await waitFor(() => expect(ui.controller().query.isSuccess).toBe(true));
  await ui.user.click(screen.getByRole('button', { name: 'Columns' })); await ui.user.click(screen.getByLabelText('Tags'));
  failRead = true; await act(async () => { await ui.controller().query.refetch(); });
  await waitFor(() => expect(ui.controller().query.error).toMatchObject({ kind: 'unavailable' })); expect(ui.controller().denied).toBe(false);
  await ui.user.click(screen.getByRole('button', { name: 'Save columns' }));
  await waitFor(() => expect(ui.controller().denied).toBe(true));
  expect(ui.controller().query.error).toMatchObject({ kind: 'unavailable' }); expect(ui.controller().command.error).toMatchObject({ kind: 'forbidden' });
  const alert = within(screen.getByRole('dialog', { name: 'My task columns' })).getByRole('alert');
  expect(alert).toHaveTextContent(hiddenTitle);
  expect(alert).not.toHaveTextContent('Unable to load your table columns'); expect(alert).not.toHaveTextContent('temporarily unavailable');
  expect(screen.queryByLabelText('Tags')).not.toBeInTheDocument();
  for (const text of ['private settings', 'internal read failure']) expect(screen.queryByText(text)).not.toBeInTheDocument();
  await ui.user.keyboard('{Escape}');
  expect(screen.getByRole('status')).toHaveTextContent(deniedCopy);
  expect(ui.writes()).toBe(1);
});

it('describes the post-conflict Discard refresh without claiming a save, including its failure after close', async () => {
  let refresh: Promise<Response> | null = null;
  const ui = example({ [`GET ${path}`]: () => refresh ?? ok(head(1, [title])), [`PUT ${path}`]: () => failure(409, 'REVISION_CONFLICT', 'private preference internals') });
  await waitFor(() => expect(ui.controller().query.isSuccess).toBe(true));
  await ui.user.click(screen.getByRole('button', { name: 'Columns' }));
  await ui.user.click(screen.getByLabelText('Tags')); await ui.user.click(screen.getByRole('button', { name: 'Save columns' }));
  await waitFor(() => expect(ui.controller().command.error).not.toBeNull());
  const response = deferred<Response>(); refresh = response.promise;
  await ui.user.click(screen.getByRole('button', { name: 'Discard changes' }));
  await waitFor(() => expect(ui.controller().head).toBe('loading'));
  expect(ui.controller().saveConfirmed).toBe(false);
  const dialog = screen.getByRole('dialog', { name: 'My task columns' });
  expect(within(dialog).getByText(refreshingCopy)).toHaveAttribute('role', 'status');
  for (const status of within(dialog).getAllByRole('status')) expect(status).not.toHaveTextContent(/Saved\.|Columns saved|confirmed/);
  await act(async () => response.resolve(failure(503, 'UNAVAILABLE', 'internal read failure')));
  await waitFor(() => expect(ui.controller().head).toBe('failed'));
  expect(within(dialog).getByText(headRefreshCopy)).toHaveAttribute('role', 'alert');
  expect(within(dialog).queryByText(/save was confirmed/i)).not.toBeInTheDocument();
  expect(screen.queryByText('internal read failure')).not.toBeInTheDocument();
  await ui.user.keyboard('{Escape}');
  expect(screen.getByRole('status')).toHaveTextContent(headCopy);
  expect(ui.writes()).toBe(1);
});
