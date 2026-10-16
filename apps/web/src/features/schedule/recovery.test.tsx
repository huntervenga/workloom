import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { expect, it } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, installFakeApi, ok } from '../../test/fakeApi';
import { period, PERIOD_B } from '../planning/test/fixtures';
import { PROJECT_B } from '../dependencies/test/fixtures';
import { ScheduleDialog } from './ScheduleDialog';
import { scheduledTask, scheduleContext, schedulePreview, schedulePath, PROJECT_ID, rootPath } from './test/fixtures';
import { useScheduleWorkspace } from './useScheduleWorkspace';
import type { TaskScheduleBatchInput } from '@workloom/contracts';

it('resolves an explicitly opened recovery period to its authorized other-project route', async () => {
  const task = scheduledTask(1), rows = scheduleContext([task]).rows;
  const { calls } = installFakeApi({
    [`POST ${schedulePath}/schedule-preview`]: request => ok({ ...schedulePreview(request.body as TaskScheduleBatchInput, [task]), recoveryPeriodIds: [PERIOD_B] }),
    [`GET ${rootPath}/periods/${PERIOD_B}`]: () => ok({ ...period(PERIOD_B), projectId: PROJECT_B }),
  });
  const client = createQueryClient({ retry: false });
  function Host() {
    const controller = useScheduleWorkspace(anna.id, alpha.id, PROJECT_ID, alpha.timezone);
    const location = useLocation();
    const opened = useRef(false);
    useEffect(() => { if (!opened.current) { opened.current = true; controller.open([task], new Map(rows.map(row => [row.taskId, row]))); } }, [controller]);
    return <><ScheduleDialog controller={controller} workspaceId={alpha.id} projectId={PROJECT_ID} periods={[]} writable /><output aria-label="Текущий маршрут">{location.pathname}{location.search}</output></>;
  }
  const view = render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/w/${alpha.id}/projects/${PROJECT_ID}?view=gantt`]}><Host /></MemoryRouter></QueryClientProvider>);
  try {
    const dialog = await screen.findByRole('dialog', { name: "Edit task dates" });
    fireEvent.click(within(dialog).getByRole('button', { name: "Preview changes" }));
    const recovery = await within(dialog).findByRole('button', { name: 'Open period: period 1' });
    expect(calls.filter(call => call.path.includes('/periods/'))).toHaveLength(0);
    fireEvent.click(recovery);
    await waitFor(() => expect(screen.getByLabelText('Текущий маршрут')).toHaveTextContent(`/w/${alpha.id}/projects/${PROJECT_B}/week?period=${PERIOD_B}`));
    expect(calls.filter(call => call.path === `${rootPath}/periods/${PERIOD_B}`)).toHaveLength(1);
    expect(calls.some(call => call.path.endsWith('/schedule-apply'))).toBe(false);
  } finally { view.unmount(); client.clear(); }
});
