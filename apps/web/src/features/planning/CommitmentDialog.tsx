import { useTranslation , type TranslationKey } from '../../i18n';
import type { MembershipDto, PeriodCommitmentDto, PlanningPackageDto, PlanningPeriodDto, TaskDto } from '@workloom/contracts';
import { Badge, Button, TextInput, inputClassName } from '@workloom/ui';
import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { formatEstimate, formatEstimateInput, parseEstimateInput } from '../task-table';
import { PlanningEntryContext } from './PlanningEntryContext';
import type { PlanningCommands } from './queries';

export interface CommitmentSession {
  key: string;
  period: PlanningPeriodDto;
  base: PeriodCommitmentDto | null;
  packageId: string;
  membershipId: string;
  hours: string;
  allocations: Record<string, string>;
  state: 'active' | 'removed';
  stale: boolean;
}

export function commitmentSession(period: PlanningPeriodDto, commitment: PeriodCommitmentDto | null, membershipId: string): CommitmentSession {
  return {
    key: commitment?.id ?? `new:${period.id}:${membershipId}`,
    period, base: commitment, packageId: commitment?.workPackageId ?? '',
    membershipId: commitment?.membershipId ?? membershipId,
    hours: formatEstimateInput(commitment?.plannedMinutes ?? null),
    allocations: Object.fromEntries((commitment?.allocations ?? []).map((item) => [item.taskId, formatEstimateInput(item.minutes)])),
    state: commitment?.state ?? 'active', stale: false,
  };
}

interface Props {
  session: CommitmentSession | null;
  open: boolean;
  packages: readonly PlanningPackageDto[];
  tasks: readonly TaskDto[];
  members: readonly MembershipDto[];
  ownMembershipId: string | null;
  canWriteOthers: boolean;
  writable: boolean;
  fixedContext?: boolean;
  fixedMember?: boolean;
  commands: PlanningCommands;
  loadingMoreTasks: boolean;
  hasMoreTasks: boolean;
  onLoadTasks: () => void;
  onChange: (session: CommitmentSession) => void;
  onClose: () => void;
  onSaved: (key: string) => void;
  onReload: (session: CommitmentSession) => Promise<PeriodCommitmentDto | null>;
}

export function CommitmentDialog(props: Props) {
  const { t } = useTranslation();
  const id = useId();
  const [validation, setValidation] = useState<TranslationKey | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadFailed, setReloadFailed] = useState(false);
  const { session, commands } = props;
  const mutation = session?.base ? commands.updateCommitment : commands.createCommitment;
  const held = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables ?? null;
  const heldHere = session && held?.periodId === session.period.id && ('commitmentId' in held ? held.commitmentId === session.base?.id : session.base === null && held.input.workPackageId === session.packageId && held.input.membershipId === session.membershipId) ? held : null;
  const blocked = held !== null && heldHere === null;
  const locked = heldHere !== null || blocked || (session?.base !== null && session?.base !== undefined && session.base.baselineIds.length > 0);
  if (!session) return null;

  const shownHours = heldHere ? formatEstimateInput(heldHere.input.plannedMinutes) : session.hours;
  const shownAllocations = heldHere ? Object.fromEntries(heldHere.input.allocations.map((allocation) => [allocation.taskId, formatEstimateInput(allocation.minutes)])) : session.allocations;
  const selectedPackage = props.packages.find((item) => item.id === session.packageId);
  const packageTasks = props.tasks.filter((task) => task.workPackageId === session.packageId);
  const taskChoices = new Map(packageTasks.map((task) => [task.id, { id: task.id, title: task.title }]));
  for (const taskId of Object.keys(shownAllocations)) {
    if (!taskChoices.has(taskId)) taskChoices.set(taskId, { id: taskId, title: t('planning.savedAllocationTaskNotLoaded') });
  }
  const editableMember = props.writable && (props.canWriteOthers || session.membershipId === props.ownMembershipId);
  const knownMember = props.members.some((member) => member.id === session.membershipId);
  const ownVariables = mutation.variables;
  const confirmedError = ownVariables?.periodId === session.period.id && ('commitmentId' in ownVariables ? ownVariables.commitmentId === session.base?.id : session.base === null && ownVariables.input.workPackageId === session.packageId && ownVariables.input.membershipId === session.membershipId) ? mutation.error : null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (heldHere) {
      if (!mutation.pendingCommand && mutation.uncertain) mutation.retryUncertain({ onSuccess: () => props.onSaved(session.key) });
      return;
    }
    if (locked || session.stale || !editableMember) return;
    if (!session.packageId || !session.membershipId) { setValidation('planning.chooseATaskAndAPerson'); return; }
    const planned = parseEstimateInput(session.hours);
    if (!planned.valid) { setValidation('planning.invalidPlannedHours'); return; }
    const allocations: { taskId: string; minutes: number }[] = [];
    for (const [taskId, raw] of Object.entries(session.allocations)) {
      if (!raw.trim()) continue;
      const value = parseEstimateInput(raw);
      if (!value.valid || value.minutes === null) { setValidation('planning.checkAllocatedHoursForExample15Or1'); return; }
      allocations.push({ taskId, minutes: value.minutes });
    }
    if (allocations.reduce((sum, item) => sum + item.minutes, 0) > (planned.minutes ?? 0)) { setValidation('planning.allocatedHoursCannotExceedThePersonalPlanAnUnknown'); return; }
    setValidation(null);
    const callbacks = {
      onSuccess: () => props.onSaved(session.key),
      onError: (error: Error) => {
        if (error instanceof ApiError && error.kind === 'conflict') props.onChange({ ...session, stale: true });
      },
    };
    if (session.base) {
      commands.updateCommitment.mutate({ periodId: session.period.id, commitmentId: session.base.id, input: { expectedRevision: session.base.revision, plannedMinutes: planned.minutes, allocations, state: session.state } }, callbacks);
    } else {
      commands.createCommitment.mutate({ periodId: session.period.id, input: { workPackageId: session.packageId, membershipId: session.membershipId, expectedAbsent: true, plannedMinutes: planned.minutes, allocations } }, callbacks);
    }
  };
  const reload = async () => {
    setReloading(true); setReloadFailed(false);
    try {
      const fresh = await props.onReload(session);
      if (fresh) props.onChange({ ...session, base: fresh, stale: false });
      else props.onChange({ ...session, stale: false });
      mutation.reset();
    } catch { setReloadFailed(true); }
    finally { setReloading(false); }
  };

  return (
    <DialogShell title={session.base ? t('planning.personalWeeklyPlan') : t('planning.addToWeeklyPlan')} description={t('planning.endExcluded', { periodName: session.period.name, startDate: session.period.localStart, endDate: session.period.localEndExclusive })} open={props.open} onOpenChange={(next) => { if (!next) props.onClose(); }}>
      <form className="mt-5 space-y-4" onSubmit={submit} noValidate>
        {props.fixedContext || props.fixedMember ? <PlanningEntryContext period={session.period.name} person={props.members.find(member => member.id === session.membershipId)?.displayName ?? t('planning.savedPersonMissingFromCurrentList')} {...(props.fixedContext ? { task: selectedPackage?.title ?? t('planning.savedWorkUnavailableForSelection') } : {})} /> : null}
        {session.base?.baselineIds.length ? <p className="rounded-lg bg-canvas p-3 text-sm">{t('planning.theBaselineIsSavedNewWorkIsAddedSeparately')}</p> : null}
        {blocked ? <p role="status" className="text-sm text-amber-800">{t('planning.anotherPlanIsStillSavingOrItsResultIs')}</p> : null}
        {session.base?.classification === 'added' ? <Badge tone="muted">{t('planning.addedAfterBaseline')}</Badge> : null}
        <fieldset disabled={locked || !editableMember} className="min-w-0 space-y-4">
          {!props.fixedContext ? <div className="space-y-1.5"><label htmlFor={`${id}-package`} className="text-sm font-medium">{t('planning.wholeTask')}</label><select id={`${id}-package`} className={inputClassName()} value={session.packageId} disabled={session.base !== null || props.fixedContext} onChange={(event) => { props.onChange({ ...session, packageId: event.target.value, allocations: {} }); setValidation(null); }}><option value="">{t('planning.chooseWork')}</option>{props.packages.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}{session.packageId && !selectedPackage ? <option value={session.packageId}>{t('planning.savedWorkUnavailableForSelection')}</option> : null}</select>{selectedPackage ? <p className="text-xs text-muted">{t('planning.totalWorkThisIsASharedWorkBudgetSeparate', { hours: selectedPackage.estimateMinutes === null ? t('planning.estimateNotSet') : formatEstimate(selectedPackage.estimateMinutes) })}</p> : null}</div> : null}
          {!props.fixedContext && !props.fixedMember ? <div className="space-y-1.5"><label htmlFor={`${id}-member`} className="text-sm font-medium">{t('planning.whosePlan')}</label><select id={`${id}-member`} className={inputClassName()} value={session.membershipId} disabled={session.base !== null || !props.canWriteOthers || props.fixedContext} onChange={(event) => props.onChange({ ...session, membershipId: event.target.value })}><option value="">{t('planning.chooseAPerson')}</option>{props.members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}{!knownMember && session.membershipId ? <option value={session.membershipId}>{t('planning.savedPersonMissingFromCurrentList')}</option> : null}</select></div> : null}
          <div className="space-y-1.5"><label htmlFor={`${id}-hours`} className="text-sm font-medium">{t('planning.plannedHours')}</label><TextInput id={`${id}-hours`} autoFocus={props.fixedContext} value={shownHours} onChange={(event) => props.onChange({ ...session, hours: event.target.value })} inputMode="decimal" placeholder={t('planning.forExample6Or130')} /><p className="text-xs text-muted">{t('planning.leaveBlankForAnUnknownPlanEnter0To')}</p></div>
          <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">{t('planning.allocateHoursToTasks')}</legend><p className="text-xs text-muted">{t('planning.optionalRemainingHoursStayUnallocatedAParentAndIts')}</p>{[...taskChoices.values()].map((task) => <div key={task.id} className="grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-3"><label htmlFor={`${id}-${task.id}`} className="text-sm [overflow-wrap:anywhere]">{task.title}</label><TextInput id={`${id}-${task.id}`} aria-label={t('planning.allocation', { taskTitle: task.title })} inputMode="decimal" value={shownAllocations[task.id] ?? ''} onChange={(event) => props.onChange({ ...session, allocations: { ...session.allocations, [task.id]: event.target.value } })} /></div>)}{props.hasMoreTasks ? <Button size="sm" disabled={props.loadingMoreTasks} onClick={props.onLoadTasks}>{t('planning.loadMoreTasksToAllocate')}</Button> : null}</fieldset>
          {session.base ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={heldHere && 'state' in heldHere.input ? heldHere.input.state === 'removed' : session.state === 'removed'} onChange={(event) => props.onChange({ ...session, state: event.target.checked ? 'removed' : 'active' })} />{t('planning.removeFromCurrentPlan')}</label> : null}
        </fieldset>
        {validation ? <p role="alert" className="text-sm text-red-700">{t(validation)}</p> : null}
        <SaveFeedback subject="planSave" error={confirmedError} uncertainError={heldHere ? mutation.uncertain?.error ?? null : null} action={session.stale ? <Button size="sm" disabled={reloading} onClick={() => void reload()}>{t('planning.reloadCurrentPlan')}</Button> : null} />
        {reloadFailed ? <p role="alert" className="text-sm text-red-700">{t('planning.couldNotRefreshThePlanYourDraftIsSaved')}</p> : null}
        <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4"><Button onClick={props.onClose}>{t('planning.close')}</Button>{editableMember ? <Button type="submit" variant="primary" disabled={mutation.pendingCommand !== null || blocked || session.stale || (locked && heldHere === null)}>{heldHere ? mutation.pendingCommand ? t('planning.saving') : t('planning.retryOriginalSave') : t('planning.savePersonalPlan')}</Button> : null}</div>
      </form>
    </DialogShell>
  );
}
