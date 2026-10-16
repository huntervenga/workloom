import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@workloom/ui';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, created, installFakeApi } from '../../test/fakeApi';
import { PeriodDialog } from './PeriodDialog';
import { usePlanningCommands } from './queries';
import { PROJECT_ID, lostResponse, period, rootPath } from './test/fixtures';

function Harness() {
  const commands = usePlanningCommands(anna.id, alpha.id, PROJECT_ID);
  const [open, setOpen] = useState(true);
  return <><Button onClick={() => setOpen(true)}>Открыть создание</Button><PeriodDialog projectId={PROJECT_ID} timezone={alpha.timezone} fields={[]} mutation={commands.createPeriod} open={open} onOpenChange={setOpen} onCreated={() => setOpen(false)} /></>;
}

describe('create-period local time and protected snapshot', () => {
  it('sends browser-local cutoff as UTC and retains its exact visible fields/key through loss and reopen', async () => {
    const gate = lostResponse();
    let attempts = 0;
    const { calls } = installFakeApi({ [`POST ${rootPath}/periods`]: () => ++attempts === 1 ? gate.promise : created(period()) });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<QueryClientProvider client={createQueryClient({ retry: false })}><Harness /></QueryClientProvider>);
    let dialog = screen.getByRole('dialog', { name: 'Новый недельный период' });
    await user.type(within(dialog).getByLabelText('Название периода'), 'Командная неделя');
    await user.type(within(dialog).getByLabelText('Первый день недели'), '2027-03-22');
    const cutoff = within(dialog).getByLabelText(/^Срок фиксации \(/);
    await user.type(cutoff, '2027-03-22T10:30');
    await user.click(within(dialog).getByRole('button', { name: 'Создать период' }));
    await waitFor(() => expect(attempts).toBe(1));
    expect(within(dialog).getByLabelText('Название периода')).toBeDisabled();
    const topClose = within(dialog).getAllByRole('button', { name: 'Закрыть' }).find((button) => button.hasAttribute('aria-label'));
    if (!topClose) throw new Error('Expected close button');
    await user.click(topClose);
    await act(async () => gate.lose());
    await user.click(screen.getByRole('button', { name: 'Открыть создание' }));
    dialog = await screen.findByRole('dialog', { name: 'Новый недельный период' });
    expect(within(dialog).getByLabelText('Название периода')).toHaveValue('Командная неделя');
    expect(within(dialog).getByLabelText(/^Срок фиксации \(/)).toHaveValue('2027-03-22T10:30');
    await user.click(within(dialog).getByRole('button', { name: 'Повторить отправку' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toMatchObject({ cutoffAt: new Date('2027-03-22T10:30').toISOString(), localStart: '2027-03-22', timezone: alpha.timezone });
    expect(calls[1]?.body).toEqual(calls[0]?.body);
    expect(calls[1]?.headers.get('Idempotency-Key')).toBe(calls[0]?.headers.get('Idempotency-Key'));
    await user.click(screen.getByRole('button', { name: 'Открыть создание' }));
    expect(screen.getByLabelText('Название периода')).toHaveValue('');
    expect(screen.getByLabelText(/^Срок фиксации \(/)).toHaveValue('');
  });
});
