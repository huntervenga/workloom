import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { localization } from '../../i18n';
import { alpha, anna, installFakeApi, ok } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { TaskProjectsField } from './TaskProjectsField';
import { PlacementCommandFeedback } from './PlacementCommandFeedback';
import { usePlacementCommands } from './queries';
import { home, homePlacement, placement, target, task } from './testFixtures';
const root = `/api/v1/workspaces/${alpha.id}`;
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });
function Harness() {
  const commands = usePlacementCommands(anna.id, alpha.id);
  const [shown, setShown] = useState(true);
  return <><button onClick={() => setShown(value => !value)}>Toggle pane</button><PlacementCommandFeedback commands={commands} actorId={anna.id} workspaceId={alpha.id} />{shown ? <TaskProjectsField actorId={anna.id} task={task} homeProject={home} writable commands={commands} /> : null}</>;
}
describe('independently saved Projects field', () => {
  it('uses the actual localization interpolator for project names without literal braces', () => {
    expect(localization.t('placements.removeFrom', { p0: 'Launch' })).toBe('Remove from Launch');
    expect(localization.t('placements.restoreTo', { p0: 'Launch' })).toBe('Restore to Launch');
    expect(localization.t('placements.homeContext', { p0: 'Home', p1: 'Launch' })).toBe('Home: Home · Viewing: Launch. Fields and hours use the home project.');
  });
  it('keeps home identity nonremovable and adds a project immediately using the canonical task revision', async () => {
    let attached = false;
    const api = installFakeApi({
      [`GET ${root}/projects`]: () => ok([home, target]),
      [`GET ${root}/tasks/${task.id}/placements`]: () => ok(attached ? [homePlacement, placement] : [homePlacement]),
      [`POST ${root}/tasks/${task.id}/placements`]: () => { attached = true; return ok(placement); },
    });
    const ui = renderFieldUi(<Harness />); cleanups.push(() => { ui.unmount(); ui.client.clear(); });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Add to project' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Remove from Canonical home' })).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('combobox', { name: 'Add to project' }));
    await ui.user.click(screen.getByRole('option', { name: 'Viewed project' }));
    await screen.findByRole('button', { name: 'Remove from Viewed project' });
    expect(api.calls.find(call => call.method === 'POST')?.body).toEqual({ projectId: target.id, expectedTaskRevision: task.revision });
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
  it('retains an unknown detach outside the closed pane and retries exactly with the same key', async () => {
    let attempts = 0;
    const api = installFakeApi({
      [`GET ${root}/projects`]: () => ok([home, target]),
      [`GET ${root}/tasks/${task.id}/placements`]: () => ok([homePlacement, placement]),
      [`POST ${root}/task-project-placements/${placement.id}/detach`]: () => { if (++attempts === 1) throw new TypeError('Lost response'); return ok({ ...placement, archivedAt: task.createdAt }); },
    });
    const ui = renderFieldUi(<Harness />); cleanups.push(() => { ui.unmount(); ui.client.clear(); });
    const remove = await screen.findByRole('button', { name: 'Remove from Viewed project' });
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
    await screen.findByRole('button', { name: 'Retry original change' });
    await ui.user.click(screen.getByRole('button', { name: 'Toggle pane' }));
    expect(screen.queryByRole('combobox', { name: 'Add to project' })).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry original change' })); });
    await waitFor(() => expect(attempts).toBe(2));
    const writes = api.calls.filter(call => call.method === 'POST');
    expect(writes[0]?.body).toEqual({ expectedRevision: 7 });
    expect(writes[1]?.body).toEqual(writes[0]?.body);
    expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
  });
});
