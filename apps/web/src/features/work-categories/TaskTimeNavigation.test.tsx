import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { Children, isValidElement, type ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, alphaMembers, anna, installFakeApi, project } from '../../test/fakeApi';
import { PERIOD_A, PERIOD_B, PROJECT_ID } from '../planning/test/fixtures';
import { legacyTablePath, tablePath, tableRoutes, task } from './test/fixtures';
import { ChoicePicker } from '../../shared/ChoicePicker';
import { timeContextLabel } from './test/timeContext';
import { useTaskTimeTable } from './useTaskTimeTable';

// Retain the real rendered callbacks across both navigations, as a queued browser event can.
function picker(node: ReactNode, id: string): (value: string) => void {
  let found: ((value: string) => void) | undefined;
  function visit(value: ReactNode) {
    Children.forEach(value, child => {
      if (!isValidElement<{ id?: string; onValueChange?: (value: string) => void; children?: ReactNode }>(child)) return;
      if (child.type === ChoicePicker && child.props.id === id) found = child.props.onValueChange;
      else visit(child.props.children);
    });
  }
  visit(node);
  if (!found) throw new Error(`Missing picker ${id}`);
  return found;
}

describe('real table time picker partial intents', () => {
  it.each(['week-person', 'person-week'] as const)('preserves both choices from retained callbacks in %s order without a render between them', async order => {
    const { calls } = installFakeApi(tableRoutes());
    const nextPerson = alphaMembers[1]?.id ?? ''; if (!nextPerson) throw new Error('Missing second person');
    let original: { week: (value: string) => void; person: (value: string) => void } | undefined;
    function Page() {
      const time = useTaskTimeTable({ actorId: anna.id, workspace: alpha, project: project(alpha.id, PROJECT_ID, 'Time navigation'), members: alphaMembers, tasks: [task], hasMoreTasks: false, loadingMoreTasks: false, onLoadTasks: () => undefined, accessDenied: false });
      original ??= { week: picker(time.controls, 'task-time-week'), person: picker(time.controls, 'task-time-worker') };
      const location = useLocation();
      return <><output data-testid="current-query">{location.search}{location.hash}</output>{time.controls}</>;
    }
    const client = createQueryClient({ retry: false });
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[legacyTablePath(`${tablePath}?week=${PERIOD_A}&worker=${alphaMembers[0]?.id}&view=board&other=kept#anchor`)]}><Page /></MemoryRouter></QueryClientProvider>);
    if (!original) throw new Error('Missing original callbacks');
    const retained = original;
    await act(async () => { if (order === 'week-person') { retained.week(PERIOD_B); retained.person(nextPerson); } else { retained.person(nextPerson); retained.week(PERIOD_B); } });
    const current = screen.getByTestId('current-query');
    expect(current).toHaveTextContent(`week=${PERIOD_B}`); expect(current).toHaveTextContent(`worker=${nextPerson}`);
    expect(current).toHaveTextContent('view=board'); expect(current).toHaveTextContent('other=kept'); expect(current).toHaveTextContent('#anchor');
    await waitFor(() => expect(screen.getByLabelText('Week for hours')).toHaveTextContent(timeContextLabel('Week for hours', PERIOD_B))); expect(screen.getByLabelText('Whose hours to show')).toHaveTextContent(timeContextLabel('Whose hours to show', nextPerson));
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
});
