import type { TaskStatusDto } from '@workloom/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { alpha, alphaMembers, anna, created, deferred, installFakeApi } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { PROJECT_ID, rootPath, task } from '../planning/test/fixtures';
import type { InitialTaskCellsDraft } from './InitialTaskCells';
import { QuickTaskAdd } from './QuickTaskAdd';
import { freshQuickSession } from './tableEditing';
import { useTaskCommands, type CreateSession, type TaskCommands } from './useTaskCommands';

const SECTION = 'e1000000-0000-4000-8000-000000000001';
const OTHER_SECTION = 'e1000000-0000-4000-8000-000000000002';
const statuses: TaskStatusDto[] = [
  { id: task.statusId, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored todo', group: 'todo', position: 0, revision: 1 },
];
const columns = ['title', 'status', 'weekly-plan'];
const renderRow = (renderCell: (columnId: string) => ReactNode) => <tr data-testid="draft-row">{columns.map(column => <td key={column} data-column={column}>{renderCell(column)}</td>)}</tr>;
const stagedHours: InitialTaskCellsDraft = { fields: {}, time: { context: null, planned: { raw: '2', touched: true }, fact: { raw: '', touched: false } } };

/** A typed bottom-row draft of the first section with staged planned hours. */
function retainedWithHours(title: string): CreateSession {
  const fresh = freshQuickSession(SECTION, task.statusId);
  return { ...fresh, draft: { ...fresh.draft, title }, initialCells: stagedHours };
}

function lost() {
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<Response>((_resolve, fail) => { reject = fail; });
  return { promise, lose: () => reject(new TypeError('Failed to fetch')) };
}

interface PageOptions {
  seed?: CreateSession;
  section?: string;
  detailsKeepInitialCells?: boolean;
  fullRow?: boolean;
}

/** One add row at a time, as on the page; each section's row is a fresh mount. */
function page({ seed, section = SECTION, detailsKeepInitialCells = false, fullRow = true }: PageOptions = {}) {
  const onCreated = vi.fn(); const onClosed = vi.fn();
  const onMoreDetails = vi.fn(() => document.getElementById('qa-details')?.focus());
  let current: TaskCommands | null = null;
  function Example() {
    const commands = useTaskCommands(anna.id, alpha.id);
    current = commands;
    const [open, setOpen] = useState<string | null>(() => { if (seed) commands.createSession.current = seed; return section; });
    return <>
      <table><tbody>{open !== null ? <QuickTaskAdd key={open} projectId={PROJECT_ID} sectionId={open} sectionName="Stored section" statuses={statuses} members={alphaMembers} commands={commands} writable
        renderRow={fullRow ? renderRow : undefined} detailsKeepInitialCells={detailsKeepInitialCells}
        onClose={reason => { onClosed(reason); setOpen(null); }} onMoreDetails={onMoreDetails} onCreated={onCreated} /> : null}</tbody></table>
      <button onClick={() => setOpen(SECTION)}>Open first section</button>
      <button onClick={() => setOpen(OTHER_SECTION)}>Open other section</button>
      <button id="qa-details">Details heading</button>
    </>;
  }
  const view = renderFieldUi(<Example />);
  return { ...view, onCreated, onClosed, onMoreDetails, commands: () => { if (!current) throw new Error('No command harness'); return current; } };
}

describe('Escape on an unsent row with staged extras', () => {
  it('discards the typed title and staged hours, so neither this nor another section brings them back', async () => {
    const { calls } = installFakeApi({});
    const seed = retainedWithHours('Typed bottom');
    const ui = page({ seed });
    expect(screen.getByLabelText('Task name')).toHaveValue('Typed bottom');
    expect(ui.commands().quick.draft).toBe(seed);
    await ui.user.keyboard('{Escape}');
    expect(ui.onClosed).toHaveBeenLastCalledWith('cancel');
    expect(ui.commands().quick.draft).toBeNull();
    expect(ui.commands().createSession.current).toBeNull();
    await ui.user.click(screen.getByRole('button', { name: 'Open other section' }));
    expect(screen.queryByRole('button', { name: 'Resume draft' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Task name')).toHaveValue('');
    expect(ui.commands().quick.draft?.initialCells).toBeUndefined();
    await ui.user.keyboard('{Escape}');
    await ui.user.click(screen.getByRole('button', { name: 'Open first section' }));
    expect(screen.getByLabelText('Task name')).toHaveValue('');
    expect(ui.commands().quick.draft?.initialCells).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe('central details transfer guard', () => {
  it.each([true, false])('refuses a foreign Resume while its create is unknown, keeping it exact and recoverable (full row: %s)', async fullRow => {
    const first = lost(); let attempt = 0;
    const { calls } = installFakeApi({ [`POST ${rootPath}/tasks`]: () => ++attempt === 1 ? first.promise : created({ ...task, sectionId: SECTION, title: 'Unknown first' }) });
    const ui = page({ fullRow });
    await ui.user.type(screen.getByLabelText('Task name'), 'Unknown first{Enter}');
    await waitFor(() => expect(attempt).toBe(1));
    await act(async () => first.lose());
    await screen.findByRole('button', { name: 'Retry original' });
    const queued = ui.commands().quick.queue[0]?.session;
    await ui.user.keyboard('{Escape}');
    await ui.user.click(screen.getByRole('button', { name: 'Open other section' }));
    const resume = screen.getByRole('button', { name: 'Resume draft' });
    expect(resume).toHaveAttribute('aria-disabled', 'true');
    expect(resume).toHaveAccessibleDescription(/still being saved or needs your decision/);
    await ui.user.click(resume);
    await ui.user.click(resume);
    expect(ui.onMoreDetails).not.toHaveBeenCalled();
    expect(ui.commands().createSession.current).toBe(queued);
    expect(ui.commands().quick.queue.map(entry => entry.session)).toEqual([queued]);
    // Recovery stays where it was: the original row retries the exact first body and key.
    await ui.user.click(screen.getByRole('button', { name: 'Collapse editor' }));
    await ui.user.click(screen.getByRole('button', { name: 'Open first section' }));
    await ui.user.click(screen.getByRole('button', { name: 'Retry original' }));
    await waitFor(() => expect(ui.onCreated).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toEqual(calls[0]?.body);
    expect(calls[1]?.headers.get('Idempotency-Key')).toBe(calls[0]?.headers.get('Idempotency-Key'));
    expect(ui.onMoreDetails).not.toHaveBeenCalled();
  });

  it('refuses details from the live row menu while a create is still pending', async () => {
    const response = deferred<Response>();
    installFakeApi({ [`POST ${rootPath}/tasks`]: () => response.promise });
    const ui = page();
    await ui.user.type(screen.getByLabelText('Task name'), 'Pending first{Enter}Next unsent');
    await waitFor(() => expect(ui.commands().create.pendingCommand).not.toBeNull());
    await ui.user.keyboard('{Shift>}{F10}{/Shift}');
    const menu = await screen.findByRole('menu', { name: 'New task actions' });
    const details = within(menu).getByRole('menuitem', { name: 'More details' });
    expect(details).toHaveAttribute('aria-disabled', 'true');
    await ui.user.click(details);
    expect(ui.onMoreDetails).not.toHaveBeenCalled();
    expect(ui.commands().quick.draft?.draft.title).toBe('Next unsent');
    expect(ui.commands().createSession.current?.draft.title).toBe('Pending first');
    await act(async () => response.resolve(created({ ...task, sectionId: SECTION, title: 'Pending first' })));
    await waitFor(() => expect(ui.onCreated).toHaveBeenCalledTimes(1));
  });

  it.each([false, true])('hands a retained foreign draft with staged hours to details only when details keep them (keeps: %s)', async keeps => {
    const { calls } = installFakeApi({});
    const seed = retainedWithHours('Retained elsewhere');
    const ui = page({ seed, section: OTHER_SECTION, detailsKeepInitialCells: keeps });
    const resume = screen.getByRole('button', { name: 'Resume draft' });
    await ui.user.click(resume);
    await ui.user.click(resume);
    expect(ui.onMoreDetails).toHaveBeenCalledTimes(keeps ? 1 : 0);
    if (!keeps) expect(resume).toHaveAccessibleDescription(/can't keep this draft's custom values or hours/);
    // Either way the original session stays exactly as retained, never a fresh stand-in.
    expect(ui.commands().createSession.current).toBe(seed);
    expect(seed.initialCells).toEqual(stagedHours);
    expect(seed.draft.title).toBe('Retained elsewhere');
    expect(calls).toHaveLength(0);
  });

  it.each([false, true])('opens details from the live row menu with every staged cell only when details keep them (keeps: %s)', async keeps => {
    const { calls } = installFakeApi({});
    const seed = retainedWithHours('Live with hours');
    const ui = page({ seed, detailsKeepInitialCells: keeps });
    expect(screen.getByLabelText('Task name')).toHaveValue('Live with hours');
    await ui.user.keyboard('{Shift>}{F10}{/Shift}');
    const menu = await screen.findByRole('menu', { name: 'New task actions' });
    const details = within(menu).getByRole('menuitem', { name: 'More details' });
    if (!keeps) {
      expect(details).toHaveAttribute('aria-disabled', 'true');
      expect(within(menu).getByText(/can't keep this draft's custom values or hours/)).toBeInTheDocument();
    }
    await ui.user.click(details);
    expect(ui.onMoreDetails).toHaveBeenCalledTimes(keeps ? 1 : 0);
    expect(ui.commands().createSession.current).toBe(seed);
    expect(ui.commands().createSession.current?.initialCells).toEqual(stagedHours);
    expect(ui.commands().quick.draft).toBe(keeps ? null : seed);
    expect(calls).toHaveLength(0);
  });
});
