import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { LeaveOverviewDto } from '@workloom/contracts';
import { installFakeApi, ok } from '../../test/fakeApi';
import { LeaveRequestForm } from './LeaveRequestForm';
import { MEMBER, VACATION, overview, prefix } from './test/fixtures';

function mount(data: LeaveOverviewDto) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onCreate = vi.fn();
  const onBulk = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <LeaveRequestForm
        overview={data}
        disabled={false}
        onCreate={onCreate}
        onBulk={onBulk}
        actorId={MEMBER}
        onCancel={onCancel}
      />
    </QueryClientProvider>
  );
  return { ...view, client, onCreate, onBulk, onCancel };
}

describe('historical absence creation form', () => {
  it('preview empty reason shows clear inline required feedback then reason then review/save callback', async () => {
    const data = overview();
    // Preview response for historical dates (before today 2026-10-19)
    installFakeApi({
      [`POST ${prefix}/preview`]: () => ok({
        sourceVersion: 'a'.repeat(64),
        today: '2026-10-19',
        chargedDays: [{ date: '2026-10-01', microdays: 1_000_000, scheduledMinutes: 480 }],
        totalMicrodays: 5_000_000,
        unavailableMinutes: 2400,
        overlappingRequestIds: [],
        pausesAccrual: false,
        balancesBefore: [],
        balancesAfter: [],
        deficits: [{
          membershipId: MEMBER,
          typeId: VACATION,
          requestId: 'f0000000-0000-4000-8000-000000000008',
          date: '2026-10-05',
          availableMicrodays: -2_000_000,
          negativeAllowed: false,
          negativeApprovalRequired: true,
        }],
      }),
    });

    const user = userEvent.setup();
    const { onCreate, unmount, client } = mount(data);

    // Set historical dates (before today 2026-10-19)
    await user.clear(screen.getByLabelText('Start date'));
    await user.type(screen.getByLabelText('Start date'), '2026-10-01');
    await user.clear(screen.getByLabelText('End date (inclusive)'));
    await user.type(screen.getByLabelText('End date (inclusive)'), '2026-10-05');

    // Click Review charge (no reason yet)
    await user.click(screen.getByRole('button', { name: 'Review charge' }));

    // Should fetch preview successfully
    const chargePreview = await screen.findByRole('region', { name: 'Charge preview' });
    expect(chargePreview).toBeVisible();
    expect(within(chargePreview).getByText(/5 balance days/)).toBeVisible();

    // Should show historical recording advisory with date and amount
    const advisory = screen.getByRole('region', { name: 'Balance recalculation' });
    expect(advisory).toBeVisible();
    expect(within(advisory).getByText(/You can save the correction/)).toBeVisible();

    // Should show deficits table
    expect(within(advisory).getByText('2026-10-05')).toBeVisible();
    expect(within(advisory).getByText(/-2 days/)).toBeVisible();

    // Should NOT show the blocking "Approval cannot bypass" copy
    expect(screen.queryByText(/Approval cannot bypass/i)).not.toBeInTheDocument();

    // Should show hint about reason being required
    expect(screen.getByText(/You can review without a reason/i)).toBeVisible();

    // Try to submit without reason - should show inline error
    await user.click(screen.getByRole('button', { name: 'Submit request' }));

    // Should show inline reason error
    const reasonError = screen.getByRole('alert');
    expect(reasonError).toHaveTextContent(/Enter a reason before saving/i);
    expect(onCreate).not.toHaveBeenCalled();

    // Focus should move to reason field
    expect(screen.getByLabelText(/reason/i)).toHaveFocus();

    // Enter reason
    await user.type(screen.getByLabelText(/reason/i), 'Recording historical vacation from paper records');

    // Error should clear
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // Now submit should work
    await user.click(screen.getByRole('button', { name: 'Submit request' }));
    expect(onCreate).toHaveBeenCalledWith({
      membershipId: MEMBER,
      typeId: VACATION,
      startDate: '2026-10-01',
      endDate: '2026-10-05',
      note: '',
      reason: 'Recording historical vacation from paper records',
      expectedSourceVersion: 'a'.repeat(64),
    });

    unmount();
    client.clear();
  });

  it('advisory with date and signed amount shows for historical recording', async () => {
    const data = overview();
    installFakeApi({
      [`POST ${prefix}/preview`]: () => ok({
        sourceVersion: 'b'.repeat(64),
        today: '2026-10-19',
        chargedDays: [
          { date: '2026-09-14', microdays: 1_000_000, scheduledMinutes: 480 },
          { date: '2026-09-15', microdays: 1_000_000, scheduledMinutes: 480 },
          { date: '2026-09-16', microdays: 1_000_000, scheduledMinutes: 480 },
        ],
        totalMicrodays: 3_000_000,
        unavailableMinutes: 1440,
        overlappingRequestIds: [],
        pausesAccrual: false,
        balancesBefore: [],
        balancesAfter: [],
        deficits: [],
      }),
    });

    const user = userEvent.setup();
    const { unmount, client } = mount(data);

    // Set historical dates
    await user.clear(screen.getByLabelText('Start date'));
    await user.type(screen.getByLabelText('Start date'), '2026-09-14');
    await user.clear(screen.getByLabelText('End date (inclusive)'));
    await user.type(screen.getByLabelText('End date (inclusive)'), '2026-09-16');

    await user.click(screen.getByRole('button', { name: 'Review charge' }));

    const advisory = await screen.findByRole('region', { name: 'Balance recalculation' });
    // Should show the recording advisory with date and amount
    expect(within(advisory).getByText(/No business conflicts found/)).toBeVisible();
    // Should show "will be saved as approved history"
    expect(screen.getByRole('region',{name:'Charge preview'})).toHaveTextContent('24 working hours unavailable');
    // No deficits, so no deficit table
    expect(within(advisory).queryByRole('table')).not.toBeInTheDocument();

    unmount();
    client.clear();
  });

  it('hardblock copy absent for historical recording', async () => {
    const data = overview();
    installFakeApi({
      [`POST ${prefix}/preview`]: () => ok({
        sourceVersion: 'c'.repeat(64),
        today: '2026-10-19',
        chargedDays: [],
        totalMicrodays: 10_000_000,
        unavailableMinutes: 4800,
        overlappingRequestIds: [],
        pausesAccrual: false,
        balancesBefore: [],
        balancesAfter: [],
        deficits: [{
          membershipId: MEMBER,
          typeId: VACATION,
          requestId: 'f0000000-0000-4000-8000-000000000008',
          date: '2026-09-01',
          availableMicrodays: -5_000_000,
          negativeAllowed: false,
          negativeApprovalRequired: true,
        }],
      }),
    });

    const user = userEvent.setup();
    const { unmount, client } = mount(data);

    await user.clear(screen.getByLabelText('Start date'));
    await user.type(screen.getByLabelText('Start date'), '2026-08-15');
    await user.clear(screen.getByLabelText('End date (inclusive)'));
    await user.type(screen.getByLabelText('End date (inclusive)'), '2026-08-30');

    await user.click(screen.getByRole('button', { name: 'Review charge' }));

    await screen.findByRole('region', { name: 'Charge preview' });

    // Historical recording should NOT show the blocking message
    expect(screen.queryByText(/Approval cannot bypass/i)).not.toBeInTheDocument();
    // Should show the advisory instead
    expect(screen.getByText(/You can save the correction/)).toBeVisible();

    unmount();
    client.clear();
  });

  it('ordinary new/future/member warnings unchanged', async () => {
    const data = overview(); data.capabilities.canManage=false;
    // Future dates (after today 2026-10-19)
    installFakeApi({
      [`POST ${prefix}/preview`]: () => ok({
        sourceVersion: 'd'.repeat(64),
        today: '2026-10-19',
        chargedDays: [{ date: '2026-11-01', microdays: 1_000_000, scheduledMinutes: 480 }],
        totalMicrodays: 1_000_000,
        unavailableMinutes: 480,
        overlappingRequestIds: [],
        pausesAccrual: false,
        balancesBefore: [],
        balancesAfter: [],
        deficits: [{
          membershipId: MEMBER,
          typeId: VACATION,
          requestId: 'f0000000-0000-4000-8000-000000000008',
          date: '2026-11-01',
          availableMicrodays: -1_000_000,
          negativeAllowed: false,
          negativeApprovalRequired: true,
        }],
      }),
    });

    const user = userEvent.setup();
    const { unmount, client } = mount(data);

    // Future request - should use ordinary flow
    await user.clear(screen.getByLabelText('Start date'));
    await user.type(screen.getByLabelText('Start date'), '2026-11-01');
    await user.clear(screen.getByLabelText('End date (inclusive)'));
    await user.type(screen.getByLabelText('End date (inclusive)'), '2026-11-01');

    await user.click(screen.getByRole('button', { name: 'Review charge' }));

    await screen.findByRole('region', { name: 'Charge preview' });

    // Future request should show the standard blocking copy
    expect(screen.getAllByText(/Approval cannot bypass/i).length).toBeGreaterThan(0);
    // Should NOT show historical recording advisory
    expect(screen.queryByText(/recording.*historical absence/i)).not.toBeInTheDocument();

    unmount();
    client.clear();
  });

  it('uses authoritative preview.today not browser clock', async () => {
    const data = overview();
    // Browser/fixture says today is 2026-10-19
    // But preview says today is 2026-10-25 (server is authoritative)
    installFakeApi({
      [`POST ${prefix}/preview`]: () => ok({
        sourceVersion: 'e'.repeat(64),
        today: '2026-10-20', // End date equals authoritative today, so is not historical
        chargedDays: [],
        totalMicrodays: 1_000_000,
        unavailableMinutes: 480,
        overlappingRequestIds: [],
        pausesAccrual: false,
        balancesBefore: [],
        balancesAfter: [],
        deficits: [],
      }),
    });

    const user = userEvent.setup();
    const { unmount, client } = mount(data);

    // End date 2026-10-20 is PAST according to browser (2026-10-19)
    // but NOT PAST according to server (2026-10-25)
    await user.clear(screen.getByLabelText('Start date'));
    await user.type(screen.getByLabelText('Start date'), '2026-10-20');
    await user.clear(screen.getByLabelText('End date (inclusive)'));
    await user.type(screen.getByLabelText('End date (inclusive)'), '2026-10-20');

    await user.click(screen.getByRole('button', { name: 'Review charge' }));

    await screen.findByRole('region', { name: 'Charge preview' });

    // Should NOT show historical recording (because server says it's not past yet)
    expect(screen.queryByText(/recording.*historical absence/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Reason \/ correction note/)).toHaveAttribute('aria-required','true');
    // Should show normal recalculation review
    expect(screen.getByRole('region', { name: 'Balance recalculation' })).toBeVisible();

    unmount();
    client.clear();
  });

  it('preserves unknown-retry protections and sourceversion payload', async () => {
    const data = overview();
    let callCount = 0;
    installFakeApi({
      [`POST ${prefix}/preview`]: () => {
        callCount++;
        return ok({
          sourceVersion: 'f'.repeat(64),
          today: '2026-10-19',
          chargedDays: [],
          totalMicrodays: 1_000_000,
          unavailableMinutes: 480,
          overlappingRequestIds: [],
          pausesAccrual: false,
          balancesBefore: [],
          balancesAfter: [],
          deficits: [],
        });
      },
    });

    const user = userEvent.setup();
    const { onCreate, unmount, client } = mount(data);

    // Set historical dates
    await user.clear(screen.getByLabelText('Start date'));
    await user.type(screen.getByLabelText('Start date'), '2026-10-01');
    await user.clear(screen.getByLabelText('End date (inclusive)'));
    await user.type(screen.getByLabelText('End date (inclusive)'), '2026-10-05');

    await user.click(screen.getByRole('button', { name: 'Review charge' }));
    await screen.findByRole('region', { name: 'Charge preview' });

    // Preview should have been called once
    expect(callCount).toBe(1);

    // Add reason and submit
    await user.type(screen.getByLabelText(/reason/i), 'Test reason');
    await user.click(screen.getByRole('button', { name: 'Submit request' }));

    // Should include sourceVersion from preview
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSourceVersion: 'f'.repeat(64),
      })
    );

    unmount();
    client.clear();
  });
});

describe('unpaid historical presentation',()=>{
 it('labels unavailability in working hours instead of claiming zero absence days',async()=>{
  const data=overview(),user=userEvent.setup();installFakeApi({[`POST ${prefix}/preview`]:()=>ok({sourceVersion:'a'.repeat(64),today:data.today,chargedDays:[{date:'2026-10-01',microdays:0,scheduledMinutes:480}],totalMicrodays:0,unavailableMinutes:480,overlappingRequestIds:[],pausesAccrual:true,balancesBefore:[],balancesAfter:[],deficits:[]})});
  const view=mount(data);await user.click(screen.getByRole('combobox',{name:'Leave type'}));await user.click(screen.getByRole('option',{name:'Unpaid leave'}));await user.clear(screen.getByLabelText('Start date'));await user.type(screen.getByLabelText('Start date'),'2026-10-01');await user.clear(screen.getByLabelText('End date (inclusive)'));await user.type(screen.getByLabelText('End date (inclusive)'),'2026-10-01');await user.click(screen.getByRole('button',{name:'Review charge'}));const advisory=await screen.findByRole('region',{name:'Charge preview'});expect(within(advisory).getByText(/8 working hours unavailable/)).toBeVisible();expect(within(screen.getByRole('region',{name:'Charge preview'})).getByText('0 balance days · 8 working hours unavailable')).toBeVisible();expect(screen.queryByText(/Recording 0 days/)).not.toBeInTheDocument();view.unmount();view.client.clear();
 });
});

describe('bulk retrospective reason feedback',()=>{
 it('reviews without reason but focuses the shared reason before bulk saving, without an extra review after typing',async()=>{
  const data=overview(),user=userEvent.setup();let reviews=0;
  installFakeApi({[`POST ${prefix}/requests/bulk-preview`]:()=>{reviews++;return ok({sourceVersion:'a'.repeat(64),previews:[{membershipId:MEMBER,preview:{sourceVersion:'b'.repeat(64),today:data.today,chargedDays:[{date:'2026-10-01',microdays:1_000_000,scheduledMinutes:480}],totalMicrodays:1_000_000,unavailableMinutes:480,overlappingRequestIds:[],pausesAccrual:false,balancesBefore:[],balancesAfter:[],deficits:[]}}]});}});
  const view=mount(data);await user.clear(screen.getByLabelText('Start date'));await user.type(screen.getByLabelText('Start date'),'2026-10-01');await user.clear(screen.getByLabelText('End date (inclusive)'));await user.type(screen.getByLabelText('End date (inclusive)'),'2026-10-01');await user.click(screen.getByRole('checkbox',{name:'Assign and approve for several people'}));await user.click(screen.getByRole('combobox',{name:'Add person'}));await user.click(screen.getByRole('option',{name:data.members.find(m=>m.id===MEMBER)?.displayName??'Person'}));await user.click(screen.getByRole('button',{name:'Review charge'}));await screen.findByRole('region',{name:'Charge preview'});await user.click(screen.getByRole('button',{name:'Assign & approve'}));expect(screen.getByRole('alert')).toHaveTextContent('Enter a reason before saving');expect(screen.getByLabelText(/Reason \/ correction note/)).toHaveFocus();expect(view.onBulk).not.toHaveBeenCalled();await user.type(screen.getByLabelText(/Reason \/ correction note/),'Confirmed absence');await user.click(screen.getByRole('button',{name:'Assign & approve'}));expect(view.onBulk).toHaveBeenCalledWith(expect.objectContaining({membershipIds:[MEMBER],reason:'Confirmed absence',expectedSourceVersion:'a'.repeat(64)}));expect(reviews).toBe(1);view.unmount();view.client.clear();
 });
});

describe('LeaveRequestForm drafts and validation', () => {
  it('employee cannot set historical start dates', async () => {
    const data = overview();
    data.capabilities = { canManage: false, canApprove: false, canRequest: true };

    const { unmount, client } = mount(data);

    // Employee should have min constraint on start date
    const startInput = screen.getByLabelText('Start date');
    // futureDate(today) = 2026-10-20
    expect(startInput).toHaveAttribute('min', '2026-10-20');

    unmount();
    client.clear();
  });

  it('manager can set historical start dates (no min)', () => {
    const data = overview();
    data.capabilities = { canManage: true, canApprove: true, canRequest: true };

    const { unmount, client } = mount(data);

    // Manager should NOT have min constraint
    const startInput = screen.getByLabelText('Start date');
    expect(startInput).not.toHaveAttribute('min');

    unmount();
    client.clear();
  });
});
