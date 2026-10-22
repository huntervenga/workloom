import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { LeaveOverviewDto, LeaveRequestDto } from '@workloom/contracts';
import { alpha, anna, installFakeApi, ok } from '../../test/fakeApi';
import { ApiError } from '../../lib/api';
import { LeaveRequestList, type RequestMutationError } from './LeaveRequestList';
import { MEMBER, OTHER, UNPAID, overview, prefix, required, VACATION } from './test/fixtures';
const request: LeaveRequestDto = { id:'f0000000-0000-4000-8000-000000000001',workspaceId:alpha.id,membershipId:MEMBER,typeId:VACATION,revision:1,startDate:'2026-10-18',endDate:'2026-10-23',status:'approved',note:'Private note',createdBy:MEMBER,createdAt:'2026-10-01T09:00:00.000Z',updatedAt:'2026-10-01T09:00:00.000Z',consumesBalance:true,pausesAccrual:false,capacityUnavailable:true,chargedDays:[],negativeApproved:false };
function mount(data:LeaveOverviewDto, props:Partial<ComponentProps<typeof LeaveRequestList>> = {}) { const client = new QueryClient({defaultOptions:{queries:{retry:false}}}); const onUpdate=vi.fn().mockResolvedValue(request),onDecision=vi.fn().mockResolvedValue(request); const view=render(<QueryClientProvider client={client}><LeaveRequestList actorId={anna.id} overview={data} disabled={false} onUpdate={onUpdate} onDecision={onDecision} {...props}/></QueryClientProvider>); return {...view,client,onUpdate,onDecision}; }
describe('leave request history and approval',()=>{
 it('locks started dates and notes while allowing an employee to shorten only the future tail',()=>{
  const data=overview();data.capabilities={canManage:false,canApprove:false,canRequest:true};data.requests=[request];const {container,unmount,client}=mount(data);required(container.querySelector('details')).open=true;
  expect(screen.getByLabelText('Start date')).toBeDisabled();expect(screen.getByLabelText('Private note (you and administrators)')).toBeDisabled();expect(screen.getByLabelText('End date (inclusive)')).toBeEnabled();expect(screen.getByLabelText('End date (inclusive)')).toHaveAttribute('min','2026-10-19');expect(screen.queryByRole('button',{name:'Cancel request'})).not.toBeInTheDocument();expect(screen.getByText(/started and past days stay unchanged/)).toBeVisible();unmount();client.clear();
 });
 it('offers no past edit to an employee',()=>{
  const data=overview();data.capabilities={canManage:false,canApprove:false,canRequest:true};data.requests=[{...request,startDate:'2026-10-12',endDate:'2026-10-16'}];const{container,unmount,client}=mount(data);required(container.querySelector('details')).open=true;expect(screen.queryByLabelText('Start date')).not.toBeInTheDocument();expect(screen.getByText(/Past days are locked/)).toBeVisible();unmount();client.clear();
 });
 it('requires an authoritative review before approving an absence',async()=>{
  const data=overview();data.requests=[{...request,startDate:'2026-11-02',endDate:'2026-11-02',status:'pending'}];installFakeApi({[`POST ${prefix}/preview`]:()=>ok({sourceVersion:'c'.repeat(64),today:data.today,chargedDays:[{date:'2026-11-02',microdays:1_000_000,scheduledMinutes:480}],totalMicrodays:1_000_000,unavailableMinutes:480,overlappingRequestIds:[],pausesAccrual:false,balancesBefore:[],balancesAfter:[],deficits:[]})});const user=userEvent.setup();const{container,onDecision,unmount,client}=mount(data);required(container.querySelector('details')).open=true;
  expect(onDecision).not.toHaveBeenCalled();await user.click(screen.getByRole('button',{name:'Review approval'}));const preview=await screen.findByRole('region',{name:'Charge preview'});expect(within(preview).getByText('1 balance days · 8 working hours unavailable')).toBeVisible();expect(onDecision).not.toHaveBeenCalled();await user.click(screen.getByRole('button',{name:'Approve'}));expect(onDecision).toHaveBeenCalledWith(request.id,{expectedRevision:1,decision:'approve',reason:'',approveNegative:false,expectedSourceVersion:'c'.repeat(64)});unmount();client.clear();
 });
 it('shows selected-person history of all types and filters acknowledgements after merging latest revisions',()=>{
  const data=overview(); const policy=required(required(data.settings).policyVersions[0]);const flexible={...required(policy.types[0]),id:'e0000000-0000-4000-8000-000000000004',name:'Flexible days',color:'#16a34a'};policy.types.push(flexible);
  data.requests=[{...request,note:'Vacation entry',chargedDays:[{date:'2026-10-19',microdays:1_000_000,scheduledMinutes:480}]},{...request,id:'f0000000-0000-4000-8000-000000000002',typeId:UNPAID,note:'Unpaid entry',consumesBalance:false},{...request,id:'f0000000-0000-4000-8000-000000000003',typeId:flexible.id,note:'Flexible entry'}];
  const other={...request,id:'f0000000-0000-4000-8000-000000000004',membershipId:OTHER,note:'Other confirmed entry',revision:2};
  const{unmount,client}=mount(data,{membershipId:MEMBER,acknowledgedRequests:{[other.id]:other}});
  const history=screen.getByRole('region',{name:'Time off history'});expect(within(history).getByText('Vacation entry')).toBeVisible();expect(within(history).getByText('Unpaid entry')).toBeVisible();expect(within(history).getByText('Flexible entry')).toBeVisible();expect(within(history).getByText('1 recorded balance days')).toBeVisible();expect(within(history).queryByText('Other confirmed entry')).not.toBeInTheDocument();expect(history.querySelector('summary')).toHaveTextContent('2026-10-18 → 2026-10-23');unmount();client.clear();
 });
 it('shows a clear empty history when a latest confirmed record belongs to another person',()=>{
  const data=overview();data.requests=[request];const{unmount,client}=mount(data,{membershipId:MEMBER,acknowledgedRequests:{[request.id]:{...request,revision:2,membershipId:OTHER}}});expect(screen.getByText('No time off recorded for this person.')).toBeVisible();expect(screen.queryByText('Private note')).not.toBeInTheDocument();unmount();client.clear();
 });
 it('preserves an unsaved edit across a remote revision, and explicit discard loads that latest record',async()=>{
  const data=overview();data.requests=[request];const onDirty=vi.fn(),user=userEvent.setup(),view=mount(data,{membershipId:MEMBER,onDirtyChange:onDirty});required(view.container.querySelector('details')).open=true;await user.clear(screen.getByLabelText('Private note (you and administrators)'));await user.type(screen.getByLabelText('Private note (you and administrators)'),'Unsent correction');await waitFor(()=>expect(onDirty).toHaveBeenLastCalledWith(true));
  view.rerender(<QueryClientProvider client={view.client}><LeaveRequestList actorId={anna.id} overview={{...data,requests:[{...request,revision:2,note:'Remote saved note'}]}} membershipId={MEMBER} disabled={false} onUpdate={view.onUpdate} onDecision={view.onDecision} onDirtyChange={onDirty}/></QueryClientProvider>);
  expect(screen.getByLabelText('Private note (you and administrators)')).toHaveValue('Unsent correction');expect(screen.getByText(/changed elsewhere/)).toBeVisible();await user.click(screen.getByRole('button',{name:'Discard local changes'}));expect(screen.getByLabelText('Private note (you and administrators)')).toHaveValue('Remote saved note');await waitFor(()=>expect(onDirty).toHaveBeenLastCalledWith(false));view.unmount();view.client.clear();
 });

});

describe('inline mutation error handling', () => {
 it('displays a stale revision error inline with load latest action', async () => {
  const data = overview();
  data.requests = [{ ...request, startDate: '2026-11-02', endDate: '2026-11-02' }];
  const onRetry = vi.fn(), onDismiss = vi.fn();
  const staleError: RequestMutationError = {
   requestId: request.id,
   error: new ApiError({ kind: 'conflict', status: 409, code: 'REVISION_CONFLICT' }),
   isUncertain: false,
   onRetry,
   onDismiss,
  };
  const user = userEvent.setup();
  const { container, unmount, client } = mount(data, { mutationErrors: { [request.id]: staleError } });
  required(container.querySelector('details')).open = true;
  const alert = screen.getByRole('alert');
  expect(within(alert).getByText(/modified elsewhere/i)).toBeVisible();
  expect(within(alert).getByRole('button', { name: /refresh current record/i })).toBeVisible();
  expect(within(alert).getByRole('button', { name: /dismiss/i })).toBeVisible();
  await user.click(within(alert).getByRole('button', { name: /dismiss/i }));
  expect(onDismiss).toHaveBeenCalledOnce();
  unmount(); client.clear();
 });

 it('displays an uncertain write error inline with retry exact action and no dismiss', async () => {
  const data = overview();
  data.requests = [{ ...request, startDate: '2026-11-02', endDate: '2026-11-02' }];
  const onRetry = vi.fn(), onDismiss = vi.fn();
  const uncertainError: RequestMutationError = {
   requestId: request.id,
   error: new ApiError({ kind: 'network', status: null }),
   isUncertain: true,
   onRetry,
   onDismiss,
  };
  const user = userEvent.setup();
  const { container, unmount, client } = mount(data, { mutationErrors: { [request.id]: uncertainError } });
  required(container.querySelector('details')).open = true;
  const alert = screen.getByRole('alert');
  expect(within(alert).getByText(/not confirmed/i)).toBeVisible();
  expect(within(alert).getByRole('button', { name: /retry exact/i })).toBeVisible();
  // Uncertain outcomes must NOT offer dismiss action
  expect(within(alert).queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
  await user.click(within(alert).getByRole('button', { name: /retry exact/i }));
  expect(onRetry).toHaveBeenCalledOnce();
  expect(onDismiss).not.toHaveBeenCalled();
  unmount(); client.clear();
 });

 it('displays a validation error inline without retry action', async () => {
  const data = overview();
  data.requests = [{ ...request, startDate: '2026-11-02', endDate: '2026-11-02' }];
  const onRetry = vi.fn(), onDismiss = vi.fn();
  const validationError: RequestMutationError = {
   requestId: request.id,
   error: new ApiError({ kind: 'validation', status: 422, code: 'DOMAIN_VALIDATION_FAILED' }),
   isUncertain: false,
   onRetry,
   onDismiss,
  };
  const user = userEvent.setup();
  const { container, unmount, client } = mount(data, { mutationErrors: { [request.id]: validationError } });
  required(container.querySelector('details')).open = true;
  const alert = screen.getByRole('alert');
  expect(within(alert).queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  expect(within(alert).getByRole('button', { name: /dismiss/i })).toBeVisible();
  await user.click(within(alert).getByRole('button', { name: /dismiss/i }));
  expect(onDismiss).toHaveBeenCalledOnce();
  unmount(); client.clear();
 });

 it('preserves draft fields when mutation error is displayed', async () => {
  const data = overview();
  data.requests = [{ ...request, startDate: '2026-11-02', endDate: '2026-11-02' }];
  const staleError: RequestMutationError = {
   requestId: request.id,
   error: new ApiError({ kind: 'conflict', status: 409, code: 'REVISION_CONFLICT' }),
   isUncertain: false,
   onRetry: vi.fn(),
   onDismiss: vi.fn(),
  };
  const user = userEvent.setup();
  const { container, unmount, client } = mount(data, { mutationErrors: { [request.id]: staleError } });
  required(container.querySelector('details')).open = true;
  await user.clear(screen.getByLabelText('Private note (you and administrators)'));
  await user.type(screen.getByLabelText('Private note (you and administrators)'), 'My important edit');
  expect(screen.getByLabelText('Private note (you and administrators)')).toHaveValue('My important edit');
  expect(screen.getByRole('alert')).toBeVisible();
  unmount(); client.clear();
 });

 it('scopes mutation errors to specific requests only', () => {
  const data = overview();
  const request2 = { ...request, id: 'f0000000-0000-4000-8000-000000000002', note: 'Second request' };
  data.requests = [
   { ...request, startDate: '2026-11-02', endDate: '2026-11-02', note: 'First request' },
   { ...request2, startDate: '2026-11-03', endDate: '2026-11-03' },
  ];
  const errorForFirst: RequestMutationError = {
   requestId: request.id,
   error: new ApiError({ kind: 'conflict', status: 409, code: 'REVISION_CONFLICT' }),
   isUncertain: false,
   onRetry: vi.fn(),
   onDismiss: vi.fn(),
  };
  const { container, unmount, client } = mount(data, { mutationErrors: { [request.id]: errorForFirst } });
  const details = container.querySelectorAll('details');
  required(details[0]).open = true;
  required(details[1]).open = true;
  const firstEditor = within(required(screen.getByText('First request').closest('details')));
  const secondEditor = within(required(screen.getByText('Second request').closest('details')));
  expect(firstEditor.getByRole('alert')).toBeVisible();
  expect(secondEditor.queryByRole('alert')).not.toBeInTheDocument();
  unmount(); client.clear();
 });

 it('refreshes conflicting source without discarding the local draft', async () => {
  const data = overview();
  data.requests = [{ ...request, startDate: '2026-11-02', endDate: '2026-11-02', revision: 2, note: 'Server updated note' }];
  const onDismiss = vi.fn(), onRetry = vi.fn();
  const staleError: RequestMutationError = {
   requestId: request.id,
   error: new ApiError({ kind: 'conflict', status: 409, code: 'REVISION_CONFLICT' }),
   isUncertain: false,
   onRetry,
   onDismiss,
  };
  const user = userEvent.setup();
  const { container, unmount, client } = mount(data, { mutationErrors: { [request.id]: staleError } });
  required(container.querySelector('details')).open = true;
  const alert = screen.getByRole('alert');
  await user.click(within(alert).getByRole('button', { name: /refresh current record/i }));
  expect(onRetry).toHaveBeenCalledOnce(); expect(onDismiss).not.toHaveBeenCalled();
  unmount(); client.clear();
 });

 it('displays PREVIEW_STALE error with refresh preview action, not stale revision text', () => {
  const data = overview();
  data.requests = [{ ...request, startDate: '2026-11-02', endDate: '2026-11-02' }];
  const previewStaleError: RequestMutationError = {
   requestId: request.id,
   error: new ApiError({ kind: 'conflict', status: 409, code: 'PREVIEW_STALE' }),
   isUncertain: false,
   onRetry: vi.fn(),
   onDismiss: vi.fn(),
  };
  const { container, unmount, client } = mount(data, { mutationErrors: { [request.id]: previewStaleError } });
  required(container.querySelector('details')).open = true;
  const alert = screen.getByRole('alert');
  // Should show preview stale message, not revision conflict message
  expect(within(alert).getByText(/server data changed|refresh the preview/i)).toBeVisible();
  expect(within(alert).queryByText(/modified elsewhere/i)).not.toBeInTheDocument();
  // Should have refresh preview button
  expect(within(alert).getByRole('button', { name: /refresh preview/i })).toBeVisible();
  // Should NOT have load latest button (that's for revision conflicts)
  expect(within(alert).queryByRole('button', { name: /refresh current record/i })).not.toBeInTheDocument();
  unmount(); client.clear();
 });

 it('enables uncertain retry button even when disabled prop is true', () => {
  const data = overview();
  data.requests = [{ ...request, startDate: '2026-11-02', endDate: '2026-11-02' }];
  const onRetry = vi.fn();
  const uncertainError: RequestMutationError = {
   requestId: request.id,
   error: new ApiError({ kind: 'unavailable', status: 503 }),
   isUncertain: true,
   onRetry,
   onDismiss: vi.fn(),
  };
  // Mount with disabled=true (simulating global busy state)
  const { container, unmount, client } = mount(data, { disabled: true, mutationErrors: { [request.id]: uncertainError } });
  required(container.querySelector('details')).open = true;
  const alert = screen.getByRole('alert');
  // Retry button must be enabled despite disabled=true
  const retryBtn = within(alert).getByRole('button', { name: /retry exact/i });
  expect(retryBtn).toBeEnabled();
  unmount(); client.clear();
 });

 it('shows safe request ID from error description, not raw server text', () => {
  const data = overview();
  data.requests = [{ ...request, startDate: '2026-11-02', endDate: '2026-11-02' }];
  const errorWithRequestId: RequestMutationError = {
   requestId: request.id,
   error: new ApiError({ kind: 'validation', status: 422, code: 'DOMAIN_VALIDATION_FAILED', requestId: 'req_safe_id_12345' }),
   isUncertain: false,
   onRetry: vi.fn(),
   onDismiss: vi.fn(),
  };
  const { container, unmount, client } = mount(data, { mutationErrors: { [request.id]: errorWithRequestId } });
  required(container.querySelector('details')).open = true;
  const alert = screen.getByRole('alert');
  // Should show safe request ID
  expect(within(alert).getByText(/req_safe_id_12345/)).toBeVisible();
  unmount(); client.clear();
 });
});

describe('historical absence correction advisory', () => {
 it('shows advisory deficit details for eligible fully elapsed date correction with reason', async () => {
  // Approved historical request ending before today
  const historicalRequest: LeaveRequestDto = {
   ...request,
   startDate: '2026-10-01',
   endDate: '2026-10-10', // Strictly before today (2026-10-19)
   status: 'approved',
  };
  const data = overview();
  data.requests = [historicalRequest];
  // Preview response with deficits and authoritative today
  installFakeApi({
   [`POST ${prefix}/preview`]: () => ok({
    sourceVersion: 'd'.repeat(64),
    today: '2026-10-19',
    chargedDays: [{ date: '2026-10-01', microdays: 1_000_000, scheduledMinutes: 480 }],
    totalMicrodays: 1_000_000,
    unavailableMinutes: 480,
    overlappingRequestIds: [],
    pausesAccrual: false,
    balancesBefore: [],
    balancesAfter: [],
    deficits: [{
     membershipId: MEMBER,
     typeId: VACATION,
     requestId: request.id,
     date: '2026-10-05',
     availableMicrodays: -2_000_000,
     negativeAllowed: false,
     negativeApprovalRequired: true,
    }],
   }),
  });

  const user = userEvent.setup();
  const { container, unmount, client } = mount(data);
  required(container.querySelector('details')).open = true;

  // Change date to trigger preview (historical correction)
  await user.clear(screen.getByLabelText('End date (inclusive)'));
  await user.type(screen.getByLabelText('End date (inclusive)'), '2026-10-08');
  // Add reason (required for historical correction)
  await user.type(screen.getByLabelText('Reason / correction note'), 'Correcting dates from HR records');
  // Click review charge
  await user.click(screen.getByRole('button', { name: 'Review charge' }));

  // Should show the advisory section with historical correction copy, not blocking warning
  const advisory = await screen.findByRole('region', { name: 'Balance details for these dates' });
  expect(advisory).toBeVisible();
  expect(within(advisory).getByText(/You can save the correction/i)).toBeVisible();
  // Should show deficit table
  expect(within(advisory).getByText('2026-10-05')).toBeVisible();
  expect(within(advisory).getByText(/-2 days/)).toBeVisible();
  expect(screen.queryByText(/Approval cannot bypass/i)).not.toBeInTheDocument();

  unmount(); client.clear();
 });

 it('shows ordinary deficit warnings for same-day or future requests', async () => {
  // Request ending today - not eligible for historical correction
  const ongoingRequest: LeaveRequestDto = {
   ...request,
   startDate: '2026-10-15',
   endDate: '2026-10-19', // Same as today
   status: 'approved',
  };
  const data = overview();
  data.requests = [ongoingRequest];
  installFakeApi({
   [`POST ${prefix}/preview`]: () => ok({
    sourceVersion: 'e'.repeat(64),
    today: '2026-10-19',
    chargedDays: [],
    totalMicrodays: 1_000_000,
    unavailableMinutes: 480,
    overlappingRequestIds: [],
    pausesAccrual: false,
    balancesBefore: [],
    balancesAfter: [],
    deficits: [{
     membershipId: MEMBER,
     typeId: VACATION,
     requestId: request.id,
     date: '2026-10-18',
     availableMicrodays: -1_000_000,
     negativeAllowed: false,
     negativeApprovalRequired: true,
    }],
   }),
  });

  const user = userEvent.setup();
  const { container, unmount, client } = mount(data);
  required(container.querySelector('details')).open = true;

  // Change date
  await user.clear(screen.getByLabelText('End date (inclusive)'));
  await user.type(screen.getByLabelText('End date (inclusive)'), '2026-10-18');
  await user.type(screen.getByLabelText('Reason / correction note'), 'Some reason');
  await user.click(screen.getByRole('button', { name: 'Review charge' }));

  // Should show ordinary deficit details (expandable), NOT historical correction advisory
  await screen.findByRole('region', {name:'Balance details for these dates'});
  // Should show the standard expandable details
  expect(screen.getByText(/You can save the correction/i)).toBeVisible();
  expect(screen.queryByText(/Approval cannot bypass/i)).not.toBeInTheDocument();

  unmount(); client.clear();
 });

 it('shows ordinary deficit warnings when reason is missing', async () => {
  const historicalRequest: LeaveRequestDto = {
   ...request,
   startDate: '2026-10-01',
   endDate: '2026-10-10',
   status: 'approved',
  };
  const data = overview();
  data.requests = [historicalRequest];
  installFakeApi({
   [`POST ${prefix}/preview`]: () => ok({
    sourceVersion: 'f'.repeat(64),
    today: '2026-10-19',
    chargedDays: [],
    totalMicrodays: 1_000_000,
    unavailableMinutes: 480,
    overlappingRequestIds: [],
    pausesAccrual: false,
    balancesBefore: [],
    balancesAfter: [],
    deficits: [{
     membershipId: MEMBER,
     typeId: VACATION,
     requestId: request.id,
     date: '2026-10-05',
     availableMicrodays: -2_000_000,
     negativeAllowed: false,
     negativeApprovalRequired: true,
    }],
   }),
  });

  const user = userEvent.setup();
  const { container, unmount, client } = mount(data);
  required(container.querySelector('details')).open = true;

  // A whitespace reason is browser-filled but semantically empty.
  await user.clear(screen.getByLabelText('End date (inclusive)'));
  await user.type(screen.getByLabelText('End date (inclusive)'), '2026-10-08');
  await user.type(screen.getByLabelText('Reason / correction note'), '   ');
  await user.click(screen.getByRole('button', { name: 'Review charge' }));

  // Should show ordinary deficit details, not historical correction advisory
  await screen.findByRole('region', {name:'Balance details for these dates'});
  expect(screen.getByText(/You can save the correction/i)).toBeVisible();
  expect(screen.queryByText(/Approval cannot bypass/i)).not.toBeInTheDocument();

  unmount(); client.clear();
 });
});
