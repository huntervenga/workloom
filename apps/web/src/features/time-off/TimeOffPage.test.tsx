import type { LeaveRequestDto } from '@workloom/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { timeOffKeys } from './queries';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, anna, installFakeApi, ok, renderApp } from '../../test/fakeApi';
import { MEMBER, overview, prefix, profile, routes, settings, uiPath } from './test/fixtures';
beforeAll(async () => { await import('../../routes/TimeOffPage'); });
const writes = (calls: ReturnType<typeof installFakeApi>['calls']) => calls.filter(call => call.method !== 'GET' && !call.path.endsWith('/availability') && !call.path.endsWith('/preview'));
describe('time off workspace', () => {
  it('does not silently apply company policy and lets the owner explicitly omit free holidays', async () => {
    let configured = false; const { calls } = installFakeApi(routes({ [`GET ${prefix}/overview`]: () => ok({ ...overview(), settings: configured ? settings() : null }), [`POST ${prefix}/template`]: () => { configured = true; return ok(settings()); } }));
    const { user } = renderApp(uiPath); await screen.findByRole('heading',{name:'Set up your team’s time off'}); expect(writes(calls)).toHaveLength(0);
    await user.click(screen.getByRole('checkbox',{name:'Include 31 December and 1 January as free company holidays'})); await user.click(screen.getByRole('button',{name:'Apply company template'}));
    await screen.findByRole('table',{name:'Team calendar'}); expect(writes(calls)[0]?.body).toEqual({ expectedRevision:0,effectiveYear:2026,includeCompanyHolidays:false });
  });
  it('members have no policy editor and unpaid leave shows an authoritative review before the command', async () => {
    const data = overview(); data.capabilities = { canManage:false, canApprove:false,canRequest:true };
    const {calls}=installFakeApi(routes({ [`GET ${prefix}/overview`]:()=>ok(data), [`POST ${prefix}/preview`]:()=>ok({sourceVersion:'b'.repeat(64),today:data.today,chargedDays:[],totalMicrodays:0,unavailableMinutes:480,overlappingRequestIds:[],pausesAccrual:true,balancesBefore:[],balancesAfter:[],deficits:[]}) }));
    const {user}=renderApp(uiPath); await screen.findByRole('table',{name:'Team calendar'}); expect(screen.queryByRole('button',{name:'Policies'})).not.toBeInTheDocument(); await user.click(screen.getByRole('button',{name:'Request time off'}));
    await user.click(screen.getByRole('combobox',{name:'Leave type'})); await user.click(screen.getByRole('option',{name:'Unpaid leave'}));
    expect(screen.getByLabelText('Start date')).toHaveAttribute('min','2026-10-20'); expect(screen.getByText(/entire calendar day|every calendar day in the interval/)).toBeVisible();
    await user.click(screen.getByRole('button',{name:'Review charge'})); expect(await screen.findByRole('region',{name:'Charge preview'})).toHaveTextContent('0 balance days · 8 working hours unavailable'); expect(writes(calls)).toHaveLength(0);
    expect(screen.getByRole('button',{name:'Submit request'})).toBeEnabled();
  });
  it('shows availability failure rather than rendering everyone as available', async()=>{
    const {failure}=await import('../../test/fakeApi');installFakeApi(routes({[`POST ${prefix}/availability`]:()=>failure(503,'UNAVAILABLE','Private diagnostic')}));renderApp(uiPath);await screen.findByRole('heading',{name:'Time off'});await waitFor(()=>expect(screen.getByRole('alert')).toBeVisible());expect(screen.queryByRole('table',{name:'Team calendar'})).not.toBeInTheDocument();
  });
  it('does not expose settings or private requests when authorization is denied',async()=>{ const {failure}=await import('../../test/fakeApi');installFakeApi(routes({[`GET ${prefix}/overview`]:()=>failure(403,'FORBIDDEN','Private notes')}));renderApp(uiPath);await screen.findByRole('alert');expect(screen.queryByRole('button',{name:'Request time off'})).not.toBeInTheDocument();expect(screen.queryByText('Private notes')).not.toBeInTheDocument(); });
  it('uses confirmed profile revisions for two saves and clears its draft protection after each ACK', async () => {
    let saved = profile();
    const { calls } = installFakeApi(routes({ [`GET ${prefix}/overview`]: () => ok({ ...overview(), profiles: [saved] }), [`POST ${prefix}/members/${MEMBER}/profile/preview`]: () => ok({ sourceVersion: 'd'.repeat(64), balancesBefore: [], balancesAfter: [], deficits: [] }), [`PUT ${prefix}/members/${MEMBER}/profile`]: request => { const input = request.body as { timezone: string; expectedRevision: number }; expect(input.expectedRevision).toBe(saved.revision); saved = { ...saved, timezone: input.timezone, revision: saved.revision + 1 }; return ok(saved); } }));
    const { user, queryClient } = renderApp(uiPath); await screen.findByRole('table', { name: 'Team calendar' }); await user.click(screen.getByRole('button', { name: 'People & schedules' })); const region = screen.getByRole('region', { name: 'People & schedules' });
    for (const zone of ['UTC', 'Asia/Nicosia']) {
      await user.type(within(region).getByLabelText('Reason for change'), 'Correct timezone');
      const input = within(region).getByLabelText('Timezone'); await user.clear(input); await user.type(input, zone); expect(protectedDraftsFor(queryClient).protecting).toBe(true);
      await user.click(within(region).getByRole('button', { name: 'Review changes' })); await user.click(await within(region).findByRole('button', { name: 'Save person settings' })); await waitFor(() => expect(protectedDraftsFor(queryClient).protecting).toBe(false));
    }
    expect(writes(calls).map(call => (call.body as { expectedRevision: number }).expectedRevision)).toEqual([1,2]);
    expect(within(region).getByRole('button', { name: 'Review changes' })).toBeDisabled();
    await user.click(within(region).getByRole('button', { name: 'Review changes' }));
    expect(writes(calls)).toHaveLength(2);
    await user.click(screen.getByRole('link', { name: 'Projects' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps an existing profile change local until an administrator reason is supplied', async () => {
    const { failure } = await import('../../test/fakeApi');
    const { calls } = installFakeApi(routes({
      [`POST ${prefix}/members/${MEMBER}/profile/preview`]: () => ok({ sourceVersion: 'd'.repeat(64), balancesBefore: [], balancesAfter: [], deficits: [] }),
      [`PUT ${prefix}/members/${MEMBER}/profile`]: () => failure(422, 'LEAVE_RULE', 'Changing an existing employment profile requires an administrator reason.'),
    }));
    const { user, queryClient } = renderApp(uiPath);
    await screen.findByRole('table', { name: 'Team calendar' });
    await user.click(screen.getByRole('button', { name: 'People & schedules' }));
    const region = screen.getByRole('region', { name: 'People & schedules' });
    await user.clear(within(region).getByLabelText('Timezone'));
    await user.type(within(region).getByLabelText('Timezone'), 'UTC');
    await user.click(within(region).getByRole('button', { name: 'Review changes' }));
    expect(within(region).getByLabelText('Reason for change')).toHaveFocus();
    expect(within(region).getByText('Add a reason before reviewing changes to an existing profile.')).toBeVisible();
    expect(writes(calls)).toHaveLength(0);
    expect(protectedDraftsFor(queryClient).protecting).toBe(true);
  });

  it('closes a committed-but-unknown request after exact retry without creating a duplicate entity',async()=>{
    const { failure } = await import('../../test/fakeApi'); let attempts=0; let entities=0; let stored: LeaveRequestDto[]=[];
    const { calls }=installFakeApi(routes({ [`GET ${prefix}/overview`]:()=>ok({...overview(),requests:stored}), [`POST ${prefix}/preview`]:()=>ok({sourceVersion:'b'.repeat(64),today:'2026-10-19',chargedDays:[],totalMicrodays:0,unavailableMinutes:0,overlappingRequestIds:[],pausesAccrual:false,balancesBefore:[],balancesAfter:[],deficits:[]}), [`POST ${prefix}/requests`]:request=>{ attempts++; if(attempts===1){entities++;const body=request.body as {membershipId:string;typeId:string;startDate:string;endDate:string;note:string};stored=[{id:'f0000000-0000-4000-8000-000000000002',workspaceId:alpha.id,membershipId:body.membershipId,typeId:body.typeId,startDate:body.startDate,endDate:body.endDate,note:body.note,revision:1,status:'pending',createdBy:MEMBER,createdAt:'2026-10-19T12:00:00.000Z',updatedAt:'2026-10-19T12:00:00.000Z',consumesBalance:true,pausesAccrual:false,capacityUnavailable:true,chargedDays:[],negativeApproved:false}];return failure(503,'UNAVAILABLE','Lost ACK');}return ok(stored[0]);} }));
    const {user}=renderApp(uiPath);await screen.findByRole('table',{name:'Team calendar'});await user.click(screen.getByRole('button',{name:'Request time off'}));await user.click(screen.getByRole('button',{name:'Review charge'}));await user.click(await screen.findByRole('button',{name:'Submit request'}));await user.click(await screen.findByRole('button',{name:'Retry exact submission'}));await waitFor(()=>expect(screen.queryByRole('region',{name:'Request time off'})).not.toBeInTheDocument());expect(entities).toBe(1);expect(attempts).toBe(2);const sent=writes(calls);expect(sent[1]?.body).toEqual(sent[0]?.body);expect(sent[1]?.headers.get('Idempotency-Key')).toBe(sent[0]?.headers.get('Idempotency-Key'));
  });
  it('clears only a confirmed profile draft after a lost ACK and exact retry', async () => {
    const { failure } = await import('../../test/fakeApi'); let saved = profile(); let attempts = 0;
    const { calls } = installFakeApi(routes({ [`GET ${prefix}/overview`]: () => ok({ ...overview(), profiles: [saved] }), [`POST ${prefix}/members/${MEMBER}/profile/preview`]: () => ok({ sourceVersion: 'c'.repeat(64), balancesBefore: [], balancesAfter: [], deficits: [] }), [`PUT ${prefix}/members/${MEMBER}/profile`]: request => { attempts++; const input = request.body as { reason: string; timezone: string }; expect(input.reason).toBe('Correct timezone'); if (attempts === 1) { saved = { ...saved, revision: 2, timezone: input.timezone }; return failure(503, 'UNAVAILABLE', 'Lost ACK'); } return ok(saved); } }));
    const { user, queryClient } = renderApp(uiPath); await screen.findByRole('table', { name: 'Team calendar' }); await user.click(screen.getByRole('button', { name: 'People & schedules' }));
    const region = screen.getByRole('region', { name: 'People & schedules' }); await user.clear(within(region).getByLabelText('Timezone')); await user.type(within(region).getByLabelText('Timezone'), 'UTC'); await user.type(within(region).getByLabelText('Reason for change'), 'Correct timezone');
    await user.click(within(region).getByRole('button', { name: 'Review changes' })); await user.click(await within(region).findByRole('button', { name: 'Save person settings' }));
    expect(await screen.findByRole('button', { name: 'Retry exact submission' })).toBeEnabled(); expect(within(region).getByLabelText('Timezone')).toBeDisabled(); expect(within(region).queryByRole('alert')).not.toBeInTheDocument(); expect(protectedDraftsFor(queryClient).protecting).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Retry exact submission' })); await waitFor(() => expect(protectedDraftsFor(queryClient).protecting).toBe(false));
    expect(within(region).getByLabelText('Timezone')).toHaveValue('UTC'); expect(within(region).getByRole('button', { name: 'Review changes' })).toBeDisabled(); expect(attempts).toBe(2);
    const sent = writes(calls); expect(sent[1]?.body).toEqual(sent[0]?.body); expect(sent[1]?.headers.get('Idempotency-Key')).toBe(sent[0]?.headers.get('Idempotency-Key'));
  });

  it('shows a definite save error beside the affected person without leaking it into another person’s form', async () => {
    const { failure } = await import('../../test/fakeApi');
    installFakeApi(routes({ [`POST ${prefix}/members/${MEMBER}/profile/preview`]: () => ok({ sourceVersion: 'c'.repeat(64), balancesBefore: [], balancesAfter: [], deficits: [] }), [`PUT ${prefix}/members/${MEMBER}/profile`]: () => failure(409, 'REVISION_CONFLICT', 'Another correction won') }));
    const { user } = renderApp(uiPath); await screen.findByRole('table', { name: 'Team calendar' }); await user.click(screen.getByRole('button', { name: 'People & schedules' }));
    const region = screen.getByRole('region', { name: 'People & schedules' }); await user.clear(within(region).getByLabelText('Timezone')); await user.type(within(region).getByLabelText('Timezone'), 'UTC'); await user.type(within(region).getByLabelText('Reason for change'), 'Correct timezone');
    await user.click(within(region).getByRole('button', { name: 'Review changes' })); await user.click(await within(region).findByRole('button', { name: 'Save person settings' })); await within(region).findByRole('alert');
    await user.click(within(region).getByRole('button', { name: 'Discard local changes' })); const colleague = overview().members.find(member => member.id !== MEMBER); if (!colleague) throw Error('Missing colleague');
    await user.click(within(region).getByRole('combobox', { name: 'Person settings' })); await user.click(screen.getByRole('option', { name: colleague.displayName }));
    expect(within(region).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('refreshes a known-stale profile preview without losing edits and sends the new source hash',async()=>{
    const {failure}=await import('../../test/fakeApi');let previewVersion='a'.repeat(64);let saved=profile();let attempts=0;
    const {calls}=installFakeApi(routes({[`GET ${prefix}/overview`]:()=>ok({...overview(),profiles:[saved]}),[`POST ${prefix}/members/${MEMBER}/profile/preview`]:()=>ok({sourceVersion:previewVersion,balancesBefore:[],balancesAfter:[],deficits:[]}),[`PUT ${prefix}/members/${MEMBER}/profile`]:request=>{attempts++;if(attempts===1){previewVersion='b'.repeat(64);return failure(409,'PREVIEW_STALE','Changed source');}saved={...saved,revision:2,timezone:(request.body as {timezone:string}).timezone};return ok(saved);}}));
    const {user}=renderApp(uiPath);await screen.findByRole('table',{name:'Team calendar'});await user.click(screen.getByRole('button',{name:'People & schedules'}));const region=screen.getByRole('region',{name:'People & schedules'});const zone=within(region).getByLabelText('Timezone');await user.clear(zone);await user.type(zone,'UTC');await user.type(within(region).getByLabelText('Reason for change'),'Correct timezone');await user.click(within(region).getByRole('button',{name:'Review changes'}));await user.click(await within(region).findByRole('button',{name:'Save person settings'}));await user.click(await screen.findByRole('button',{name:'Try again'}));await waitFor(()=>expect(within(region).getByRole('button',{name:'Save person settings'})).toBeEnabled());expect(zone).toHaveValue('UTC');await user.click(within(region).getByRole('button',{name:'Save person settings'}));await waitFor(()=>expect(attempts).toBe(2));expect(writes(calls).map(call=>(call.body as {expectedSourceVersion:string}).expectedSourceVersion)).toEqual(['a'.repeat(64),'b'.repeat(64)]);
  });

  it('discards an unsent profile draft, unlocks switching people and sends no write',async()=>{
    const {calls}=installFakeApi(routes());const{user,queryClient}=renderApp(uiPath);await screen.findByRole('table',{name:'Team calendar'});await user.click(screen.getByRole('button',{name:'People & schedules'}));const region=screen.getByRole('region',{name:'People & schedules'});const zone=within(region).getByLabelText('Timezone');await user.clear(zone);await user.type(zone,'UTC');expect(within(region).getByRole('combobox',{name:'Person settings'})).toBeDisabled();expect(protectedDraftsFor(queryClient).protecting).toBe(true);await user.click(within(region).getByRole('button',{name:'Discard local changes'}));expect(zone).toHaveValue('Europe/Moscow');await waitFor(()=>expect(protectedDraftsFor(queryClient).protecting).toBe(false));expect(within(region).getByRole('combobox',{name:'Person settings'})).toBeEnabled();expect(writes(calls)).toHaveLength(0);
  });

  it('keeps an unsent draft through a background503 and recovery but hides it after a current403',async()=>{
    const {deferred,failure}=await import('../../test/fakeApi');let mode:'ok'|'held'|'forbidden'='ok';const gate=deferred<Response>();installFakeApi(routes({[`GET ${prefix}/overview`]:()=>mode==='held'?gate.promise:mode==='forbidden'?failure(403,'FORBIDDEN','Private detail'):ok(overview())}));
    const{user,queryClient}=renderApp(uiPath);await screen.findByRole('table',{name:'Team calendar'});await user.click(screen.getByRole('button',{name:'People & schedules'}));const region=screen.getByRole('region',{name:'People & schedules'});const zone=within(region).getByLabelText('Timezone');await user.clear(zone);await user.type(zone,'UTC');mode='held';act(()=>{void queryClient.invalidateQueries({queryKey:timeOffKeys.overview(anna.id,alpha.id)});});expect(zone).toBeEnabled();expect(zone).toHaveValue('UTC');await act(async()=>{gate.resolve(failure(503,'UNAVAILABLE','Offline'));});await screen.findByRole('alert');expect(zone).toBeVisible();expect(zone).toHaveValue('UTC');mode='ok';await user.click(screen.getByRole('button',{name:'Try again'}));await waitFor(()=>expect(screen.queryByRole('alert')).not.toBeInTheDocument());expect(zone).toHaveValue('UTC');mode='forbidden';await act(async()=>{await queryClient.invalidateQueries({queryKey:timeOffKeys.overview(anna.id,alpha.id)});});await screen.findByRole('alert');expect(screen.queryByRole('region',{name:'People & schedules'})).not.toBeInTheDocument();expect(screen.queryByRole('table',{name:'Team calendar'})).not.toBeInTheDocument();
  });

});

it('opens working schedules from an owner report link without writing a profile', async()=>{
 const {calls}=installFakeApi(routes()); renderApp(`${uiPath}?tab=people#working-hours`);
 const region=await screen.findByRole('region',{name:'People & schedules'});
 expect(within(region).getByText('Working hours by effective date')).toBeVisible(); expect(region.querySelector('#working-hours')).not.toBeNull(); expect(writes(calls)).toHaveLength(0);
});
it('ignores a privileged schedule deep link when current capabilities are member-only', async()=>{
 const data=overview();data.capabilities={canManage:false,canApprove:false,canRequest:true};
 const {calls}=installFakeApi(routes({[`GET ${prefix}/overview`]:()=>ok(data)}));renderApp(`${uiPath}?tab=people#working-hours`);
 await screen.findByRole('table',{name:'Team calendar'});expect(screen.queryByRole('region',{name:'People & schedules'})).not.toBeInTheDocument();expect(writes(calls)).toHaveLength(0);
});

it('selects only an already-authorized person from a schedule deep link and never writes',async()=>{
 const data=overview(),other=data.members.find(member=>member.id!==MEMBER);if(!other)throw Error('fixture');data.profiles.push(profile(other.id));
 const {calls}=installFakeApi(routes({[`GET ${prefix}/overview`]:()=>ok(data)}));renderApp(`${uiPath}?tab=people&person=${other.id}#working-hours`);
 const region=await screen.findByRole('region',{name:'People & schedules'});expect(within(region).getByRole('combobox',{name:'Person settings'})).toHaveTextContent(other.displayName);expect(writes(calls)).toHaveLength(0);
});
it('falls back to own profile for a foreign person query',async()=>{
 const data=overview(),own=data.members.find(member=>member.id===MEMBER);if(!own)throw Error('fixture');const {calls}=installFakeApi(routes());renderApp(`${uiPath}?tab=people&person=99999999-9999-4999-8999-999999999999#working-hours`);
 const region=await screen.findByRole('region',{name:'People & schedules'});expect(within(region).getByRole('combobox',{name:'Person settings'})).toHaveTextContent(own.displayName);expect(writes(calls)).toHaveLength(0);
});
