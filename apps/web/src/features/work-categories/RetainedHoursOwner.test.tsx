import { QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { Children, isValidElement, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { alpha, anna, boris, installFakeApi, project } from '../../test/fakeApi';
import { FactDialog, factSession, type FactSession } from '../planning/FactDialog';
import { period } from '../planning/test/fixtures';
import { MEMBER_ID, PERIOD_A, PROJECT_ID, tablePath, tableRoutes, task } from './test/fixtures';
import { useTaskTimeTable } from './useTaskTimeTable';

function unload() { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }
describe('retained hours owner lifetime', () => {
  it.each(['actor', 'workspace', 'project'] as const)('detaches old %s callbacks and protects only the current owner', scope => {
    installFakeApi(tableRoutes());
    const client = createQueryClient({ retry: false });
    let change: ((session: FactSession) => void) | undefined;
    function Owner({ actorId = anna.id, workspaceId = alpha.id, projectId = PROJECT_ID }) {
      const time = useTaskTimeTable({ actorId, workspace: { ...alpha, id: workspaceId }, project: project(workspaceId, projectId, 'Owner test'), members: [], tasks: [task], hasMoreTasks: false, loadingMoreTasks: false, onLoadTasks: () => undefined, accessDenied: false });
      const child = Children.toArray(time.dialogs.props.children).find(element => isValidElement(element) && element.type === FactDialog);
      if (!isValidElement<{ onChange: (session: FactSession) => void }>(child)) throw new Error('Missing fact callback');
      change = child.props.onChange;
      return null;
    }
    const wrapper = (owner: ReactNode) => <QueryClientProvider client={client}><MemoryRouter initialEntries={[`${tablePath}?week=${PERIOD_A}`]}>{owner}</MemoryRouter></QueryClientProvider>;
    const view = render(wrapper(<Owner />));
    const oldChange = change; if (!oldChange) throw new Error('Missing first owner');
    const dirty = { ...factSession(period(), null, MEMBER_ID, task.id), hours: 'invalid' };
    act(() => { oldChange(dirty); expect(protectedDraftsFor(client).protecting).toBe(true); expect(unload()).toBe(true); });
    view.rerender(wrapper(<Owner actorId={scope === 'actor' ? boris.id : anna.id} workspaceId={scope === 'workspace' ? 'b0000000-0000-4000-8000-000000000099' : alpha.id} projectId={scope === 'project' ? 'e0000000-0000-4000-8000-000000000099' : PROJECT_ID} />));
    expect(protectedDraftsFor(client).protecting).toBe(false); expect(unload()).toBe(false);
    act(() => { oldChange({ ...dirty, hours: 'another invalid input' }); expect(unload()).toBe(false); });
    const currentChange = change; if (!currentChange) throw new Error('Missing current owner');
    act(() => { currentChange(dirty); expect(unload()).toBe(true); });
    view.unmount(); expect(protectedDraftsFor(client).protecting).toBe(false); expect(unload()).toBe(false); client.clear();
  });
});
