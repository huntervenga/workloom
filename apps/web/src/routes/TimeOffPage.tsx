import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Temporal } from 'temporal-polyfill';
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Settings2, Users } from 'lucide-react';
import { Button, Skeleton, TextInput } from '@workloom/ui';
import type { LeaveAvailabilityInput, LeaveOverviewDto, LeaveProfileDto, LeaveRequestDto, LeaveSettingsDto } from '@workloom/contracts';
import { useTranslation } from '../i18n';
import { isUuid } from '../lib/format';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { ApiError, isAccessDenied } from '../lib/api';
import { describeError } from '../lib/errors';
import { ChoicePicker } from '../shared/ChoicePicker';
import { QueryErrorState } from '../shared/QueryErrorState';
import { useWorkspaceContext } from './WorkspaceLayout';
import { timeOffKeys, useAvailability, useTimeOffCommands, useTimeOffOverview } from '../features/time-off/queries';
import { daysText, monthRange, policyForYear } from '../features/time-off/presentation';
import { approvedCalendarAllocations, TimeOffCalendar } from '../features/time-off/TimeOffCalendar';
import { LeaveRequestForm } from '../features/time-off/LeaveRequestForm';
import { LeaveRequestList } from '../features/time-off/LeaveRequestList';
import { LeaveSettingsEditor } from '../features/time-off/LeaveSettingsEditor';
import { LeaveProfileEditor } from '../features/time-off/LeaveProfileEditor';

export function TimeOffPage() {
  const { t } = useTranslation();
  const { actorId, workspace } = useWorkspaceContext();
  const [search] = useSearchParams();
  useDocumentTitle(t('timeOff.pageTitle', { workspace: workspace.name }));
  return <TimeOffWorkspace key={`${actorId}:${workspace.id}`} actorId={actorId} workspaceId={workspace.id} initialPeople={(workspace.role === 'owner' || workspace.role === 'admin') && search.get('tab') === 'people'} initialPerson={isUuid(search.get('person') ?? '') ? (search.get('person') ?? '').toLowerCase() : ''}/>;
}
function TimeOffWorkspace({ actorId, workspaceId, initialPeople, initialPerson }: { actorId: string; workspaceId: string; initialPeople: boolean; initialPerson: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const overview = useTimeOffOverview(actorId, workspaceId);
  // Hook owners outlive open forms and keep uncertain commands available for exact retry.
  const commands = useTimeOffCommands(actorId, workspaceId, {
    onCreated: () => { setRequestOpen(false); setRequestGeneration(value => value + 1); },
    onSettings: saved => { setSettingsAck(saved); setSettingsGeneration(value => value + 1); },
    onProfile: saved => { setProfileAcks(values => ({ ...values, [saved.membershipId]: saved })); setProfileGenerations(values => ({ ...values, [saved.membershipId]: (values[saved.membershipId] ?? 0) + 1 })); setProfileDirty(false); },
    onRequest: saved => setRequestAcks(values => ({ ...values, [saved.id]: saved })),
  });
  const [entry] = useState({ people: initialPeople, person: initialPerson });
  const [tab, setTab] = useState<'calendar' | 'settings' | 'people'>(entry.people ? 'people' : 'calendar');
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestGeneration, setRequestGeneration] = useState(0);
  const [includeHolidays, setIncludeHolidays] = useState(true);
  const [templateYear, setTemplateYear] = useState<string>('');
  const [month, setMonth] = useState('');
  const [selectedMember, setSelectedMember] = useState('');
  const [settingsAck, setSettingsAck] = useState<LeaveSettingsDto | null>(null);
  const [profileAcks, setProfileAcks] = useState<Record<string, LeaveProfileDto>>({});
  const [settingsGeneration, setSettingsGeneration] = useState(0);
  const [profileGenerations, setProfileGenerations] = useState<Record<string, number>>({});
  const [profileDirty, setProfileDirty] = useState(false);
  const [requestAcks, setRequestAcks] = useState<Record<string, LeaveRequestDto>>({});
  const data = overview.data ?? null;
  const accessFailed = isAccessDenied(overview.error) || overview.error instanceof ApiError && overview.error.kind === 'unauthenticated';
  const currentMonth = month || data?.today.slice(0, 7) || '';
  const range = currentMonth ? monthRange(`${currentMonth}-01`) : null;
  const availabilityInput: LeaveAvailabilityInput | null = data?.settings && range ? { ...range, people: { kind: 'all_active' } } : null;
  const availability = useAvailability(actorId, workspaceId, availabilityInput);
  const allCommands = Object.values(commands);
  const protectedWrite = allCommands.some(command => command.pendingCommand !== null || command.uncertain !== null);
  const busy = protectedWrite;
  const current = selectedMember || (entry.people && data?.capabilities.canManage && data.members.some(member => member.id === entry.person) ? entry.person : data?.ownMembershipId) || '';
  const scheduleLinkScrolled = useRef(false);
  useEffect(() => {
    if (scheduleLinkScrolled.current || !entry.people || tab !== 'people' || !data?.settings || !data.capabilities.canManage || window.location.hash !== '#working-hours') return;
    const target = document.getElementById('working-hours');
    if (target) { target.scrollIntoView?.({ block: 'start' }); scheduleLinkScrolled.current = true; }
  }, [entry.people, tab, data?.settings, data?.capabilities.canManage]);
  if (overview.isPending) return <div role="status" className="space-y-4"><span className="sr-only">{t('timeOff.loading')}</span><Skeleton className="h-8 w-44"/><Skeleton className="h-32 w-full"/><Skeleton className="h-80 w-full"/></div>;
  if (accessFailed || !data) return <QueryErrorState error={overview.error} subject="workspace" headingLevel={1} retrying={overview.isFetching} onRetry={() => void overview.refetch()}/>;
  const canManage = data.capabilities.canManage;
  const visibleTab = canManage ? tab : 'calendar';
  const readProfile = data.profiles.find(profile => profile.membershipId === current);
  const profileAck = profileAcks[current];
  const selectedProfile = profileAck && profileAck.revision > (readProfile?.revision ?? 0) ? profileAck : readProfile;
  const currentSettings = settingsAck && settingsAck.revision > (data.settings?.revision ?? 0) ? settingsAck : data.settings;
  const selectedToday = data.members.find(member => member.id === current)?.today ?? data.today;
  return <div className="min-w-0 space-y-5">
    {overview.isError ? <QueryErrorState error={overview.error} subject="workspace" retrying={overview.isFetching} onRetry={() => void overview.refetch()}/> : null}
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold tracking-tight">{t('timeOff.title')}</h1><p className="mt-1 text-sm text-muted">{t('timeOff.subtitle')}</p></div>{data.settings && data.capabilities.canRequest ? <Button variant="primary" disabled={busy} onClick={() => { setTab('calendar'); setRequestOpen(true); }}><Plus size={16} aria-hidden="true"/>{t('timeOff.requestTimeOff')}</Button> : null}</header>
    {allCommands.map((command, index) => command.error ? <div key={index} role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-danger/25 bg-surface p-3 text-sm"><p className="text-danger">{command.uncertain ? t('timeOff.uncertain') : describeError(command.error, 'timeOffSave').description}</p>{command.uncertain ? <Button size="sm" disabled={command.pendingCommand !== null} onClick={() => command.retryUncertain()}>{t('timeOff.retryExact')}</Button> : <Button size="sm" variant="ghost" onClick={() => { command.reset(); void queryClient.invalidateQueries({ queryKey: timeOffKeys.root(actorId, workspaceId) }); }}>{t('common.retry')}</Button>}</div> : null)}
    {!data.settings ? <section className="mx-auto max-w-2xl space-y-4 rounded-2xl border border-line bg-surface p-6"><CalendarDays className="text-accent" size={28} aria-hidden="true"/><h2 className="text-lg font-semibold">{t('timeOff.setupTitle')}</h2><p className="text-sm text-muted">{t(canManage ? 'timeOff.setupHint' : 'timeOff.setupWaiting')}</p>{canManage ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); commands.template.mutate({ input: { expectedRevision: 0, effectiveYear: Number(templateYear || data.today.slice(0, 4)), includeCompanyHolidays: includeHolidays } }); }}><fieldset disabled={busy} className="space-y-3"><label className="grid max-w-40 gap-1 text-xs text-muted">{t('timeOff.policyYear')}<TextInput type="number" min={1900} max={2200} required value={templateYear || data.today.slice(0, 4)} onChange={event => setTemplateYear(event.target.value)}/></label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeHolidays} onChange={event => setIncludeHolidays(event.target.checked)}/>{t('timeOff.includeDefaultHolidays')}</label><Button type="submit" variant="primary">{t('timeOff.applyTemplate')}</Button></fieldset></form> : null}</section> : <>
      <nav aria-label={t('timeOff.views')} className="flex flex-wrap gap-1 border-b border-line pb-2">{([{ key: 'calendar', icon: CalendarDays, label: t('timeOff.calendar') }, ...(canManage ? [{ key: 'settings', icon: Settings2, label: t('timeOff.policies') }, { key: 'people', icon: Users, label: t('timeOff.people') }] as const : [])] as const).map(item => <Button key={item.key} variant={visibleTab === item.key ? 'secondary' : 'ghost'} size="sm" aria-current={visibleTab === item.key ? 'page' : undefined} onClick={() => setTab(item.key)}><item.icon size={15} aria-hidden="true"/>{item.label}</Button>)}</nav>
      <div hidden={visibleTab !== 'calendar'} className="space-y-5">
        <BalanceCards overview={data} membershipId={data.ownMembershipId}/>
        {requestOpen ? <section aria-label={t('timeOff.requestTimeOff')} className="rounded-xl border border-line bg-surface p-4"><h2 className="mb-3 font-semibold">{t('timeOff.requestTimeOff')}</h2><LeaveRequestForm onCancel={() => { if (!protectedWrite) { setRequestOpen(false); setRequestGeneration(value => value + 1); } }} actorId={actorId} key={requestGeneration} overview={data} disabled={busy} onCreate={input => commands.create.mutate({ input })} onBulk={input => commands.bulk.mutate({ input })}/></section> : null}
        <section className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{t('timeOff.teamCalendar')}</h2><div className="flex items-center gap-1"><Button size="sm" aria-label={t('timeOff.previousMonth')} onClick={() => setMonth(Temporal.PlainYearMonth.from(currentMonth).subtract({ months: 1 }).toString())}><ChevronLeft size={16}/></Button><TextInput aria-label={t('timeOff.month')} type="month" className="w-40" value={currentMonth} onChange={event => { if (/^\d{4}-\d{2}$/.test(event.target.value)) setMonth(event.target.value); }}/><Button size="sm" aria-label={t('timeOff.nextMonth')} onClick={() => setMonth(Temporal.PlainYearMonth.from(currentMonth).add({ months: 1 }).toString())}><ChevronRight size={16}/></Button></div></div>
          {availability.isPending ? <p role="status" className="text-sm text-muted">{t('timeOff.loadingAvailability')}</p> : availability.isError ? <QueryErrorState error={availability.error} subject="members" onRetry={() => void availability.refetch()}/> : availability.data ? <TimeOffCalendar availability={availability.data} members={data.members} allocations={approvedCalendarAllocations(data.requests)}/> : null}
          <p className="text-xs text-muted">{t('timeOff.calendarLegend')}</p>
        </section>
        <LeaveRequestList acknowledgedRequests={requestAcks} actorId={actorId} overview={data} disabled={busy} onUpdate={(requestId, input) => commands.update.mutateAsync({ requestId, input })} onDecision={(requestId, input) => commands.decision.mutateAsync({ requestId, input })}/>
      </div>
      {canManage ? <><section aria-label={t('timeOff.policies')} hidden={visibleTab !== 'settings'} className="max-w-4xl space-y-4"><h2 className="text-lg font-semibold">{t('timeOff.policies')}</h2><LeaveSettingsEditor actorId={actorId} key={settingsGeneration} settings={currentSettings ?? data.settings} disabled={busy} onSave={input => commands.settings.mutate({ input })}/></section><section aria-label={t('timeOff.people')} hidden={visibleTab !== 'people'} className="max-w-4xl space-y-4"><h2 className="text-lg font-semibold">{t('timeOff.people')}</h2><ChoicePicker label={t('timeOff.profilePerson')} value={current} searchable options={data.members.map(member => ({ value: member.id, label: member.displayName, avatarName: member.displayName, avatarUrl: member.avatarUrl }))} disabled={profileDirty || busy} onValueChange={setSelectedMember}/>{profileDirty ? <p className="text-xs text-muted">{t('timeOff.saveBeforePersonSwitch')}</p> : null}<BalanceCards overview={data} membershipId={current}/><LeaveProfileEditor actorId={actorId} membershipId={current} key={`${current}:${profileGenerations[current] ?? 0}`} onDirtyChange={setProfileDirty} saveError={commands.profile.variables?.membershipId === current && commands.profile.uncertain === null ? commands.profile.error : null} profile={selectedProfile} settings={data.settings} today={selectedToday} disabled={busy} onSave={input => commands.profile.mutate({ membershipId: current, input })}/></section></> : null}
    </>}
  </div>;
}
function BalanceCards({ overview, membershipId }: { overview: LeaveOverviewDto; membershipId: string }) {
  const { t, locale } = useTranslation();
  const today = overview.members.find(member => member.id === membershipId)?.today ?? overview.today;
  const types = overview.settings ? policyForYear(overview.settings, Number(today.slice(0, 4)))?.types ?? [] : [];
  const balances = overview.balances.filter(balance => balance.membershipId === membershipId);
  const profile = overview.profiles.find(profile => profile.membershipId === membershipId);
  if (!profile) return <p role="status" className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">{t('timeOff.profileRequired')}</p>;
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{balances.map(balance => <section key={balance.typeId} className="rounded-xl border border-line bg-surface p-4"><h2 className="text-sm font-medium text-muted">{types.find(type => type.id === balance.typeId)?.name ?? t('timeOff.leaveType')}</h2><p className="mt-2 text-2xl font-semibold tabular-nums">{t('timeOff.dayCount', { days: daysText(balance.availableMicrodays, locale) })}</p><p className="mb-3 text-xs text-muted">{t('timeOff.availableToday', { date: balance.asOf })}</p><dl className="grid grid-cols-2 gap-2 text-xs">{([{ key: 'earnedMicrodays', label: t('timeOff.earned') }, { key: 'takenMicrodays', label: t('timeOff.taken') }, { key: 'reservedFutureMicrodays', label: t('timeOff.reserved') }, { key: 'projectedAvailableMicrodays', label: t('timeOff.afterReservations') }] as const).map(item => <div key={item.key}><dt className="text-muted">{item.label}</dt><dd className="mt-0.5 font-medium tabular-nums">{daysText(balance[item.key], locale)}{item.key === 'projectedAvailableMicrodays' ? <span className="block text-[10px] font-normal text-muted">{t('timeOff.projectedThrough', { date: balance.projectedThroughDate })}</span> : null}</dd></div>)}</dl></section>)}{balances.length === 0 ? <p className="text-sm text-muted">{t('timeOff.noBalances')}</p> : null}<p className="text-xs text-muted sm:col-span-2 xl:col-span-3">{t('timeOff.balanceHint')}</p></div>;
}
