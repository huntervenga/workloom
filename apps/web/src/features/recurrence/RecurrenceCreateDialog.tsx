import { t, useTranslation } from '../../i18n';
import type {
  CreateRecurrenceSeriesInput,
  MembershipDto,
  PlanningPeriodDto,
  RecurrenceSeriesDto,
  SectionDto,
  TaskStatusDto,
} from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { CircleHelp, TriangleAlert } from 'lucide-react';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, isAccessDenied } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { canonicalJson } from '../../lib/idempotency';
import { DialogShell } from '../../shared/DialogShell';
import { RecurrenceCreatePreview } from './RecurrencePreview';
import { RecurrenceRuleFields, type RecurrenceRuleDraft } from './RecurrenceRuleFields';
import { RecurrenceTemplateFields, type RecurrenceTemplateDraft } from './RecurrenceTemplateFields';
import { buildRecurrenceCreatePreviewInput, type RecurrenceWorkspace } from './useRecurrenceWorkspace';

export interface RecurrenceCreateDialogProps {
  controller: RecurrenceWorkspace;
  workspaceId: string;
  projectId: string;
  periods: readonly PlanningPeriodDto[];
  members: readonly MembershipDto[];
  statuses: readonly TaskStatusDto[];
  sections: readonly SectionDto[];
  writable: boolean;
  accessDenied?: boolean | undefined;
  onCreated?: ((seriesId: string) => void) | undefined;
}

const title = () => t('recurrence.newMeetingSeries');
const description = () =>
  t('recurrence.aSeriesReservesDatesInSelectedPeriodsMeetingsAre');
const body = '-mx-1 min-h-0 flex-1 scroll-py-4 space-y-6 overflow-y-auto px-1 pt-4 pb-6';
const footer = 'flex shrink-0 flex-wrap justify-end gap-2 border-t border-line bg-surface pt-4';

/** The exact submitted schedule, shown instead of the draft while the command is held. */
function ruleFromInput(input: CreateRecurrenceSeriesInput): RecurrenceRuleDraft {
  const { schedule } = input;
  return {
    frequency: schedule.frequency,
    weekdays: schedule.weekdays ? [...schedule.weekdays] : [],
    startDate: schedule.startDate,
    localTime: schedule.localTime,
    timezone: schedule.timezone,
    durationMinutes: String(schedule.plannedDurationMinutes),
    endKind: schedule.end.kind,
    endDate: schedule.end.kind === 'on_date' ? schedule.end.endDate : '',
    count: schedule.end.kind === 'after_count' ? String(schedule.end.count) : '',
    targetPeriodIds: [...input.targetPeriodIds],
  };
}

function templateFromInput(input: CreateRecurrenceSeriesInput): RecurrenceTemplateDraft {
  const { template } = input;
  return {
    title: template.title,
    statusId: template.statusId,
    sectionId: template.sectionId ?? '',
    organizerMembershipId: template.organizerMembershipId,
    attendeeMembershipIds: [...template.attendeeMembershipIds],
    joinUrl: template.joinUrl ?? '',
  };
}

function Alert({ tone, heading, children }: { tone: 'error' | 'uncertain'; heading: string; children: ReactNode }) {
  const error = tone === 'error';
  const Icon = error ? TriangleAlert : CircleHelp;
  return (
    <div
      role="alert"
      className={`flex gap-2.5 rounded-lg border px-3 py-2.5 text-sm ${error ? 'border-red-200 bg-red-50/70 text-red-800/90' : 'border-amber-200 bg-amber-50/80 text-amber-900'}`}
    >
      <Icon size={16} aria-hidden="true" className={`mt-0.5 shrink-0 ${error ? 'text-red-600' : 'text-amber-700'}`} />
      <div className="min-w-0 space-y-1">
        <p className={`font-medium ${error ? 'text-red-900' : 'text-amber-950'}`}>{heading}</p>
        {children}
      </div>
    </div>
  );
}

function RequestCode({ error }: { error: Error }) {
  const { t } = useTranslation();
  const requestId = error instanceof ApiError ? error.requestId : null;
  return requestId ? (
    <p className="text-xs opacity-70">
      {t('recurrence.requestCode')}<code className="font-mono">{requestId}</code>
    </p>
  ) : null;
}

/**
 * Two-part create flow: validate and preview the draft, then create exactly the previewed input.
 * All draft state lives in the page controller; this dialog only renders and dispatches.
 */
export function RecurrenceCreateDialog(props: RecurrenceCreateDialogProps) {
  const { t } = useTranslation();
  const { controller: c } = props;
  const mutation = c.commands.create;
  const session = c.createSession;
  const held = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables ?? null;
  const ruleHeadingId = useId();
  const templateHeadingId = useId();
  const [problems, setProblems] = useState<{ sessionId: string; messages: string[] } | null>(null);

  // A preview read counts only for the input the draft builds now; after an edit it can be rechecked at once.
  const built = session ? buildRecurrenceCreatePreviewInput(session.rule, session.template) : null;
  const fingerprint = built?.ok ? canonicalJson(built.input) : null;
  const request =
    session && c.createPreviewRequest?.sessionId === session.id && c.createPreviewRequest.fingerprint === fingerprint
      ? c.createPreviewRequest
      : null;
  const previewPending = request?.pending === true;
  const previewError = request && !request.pending ? request.error : null;
  const shownProblems = session && problems?.sessionId === session.id && built && !built.ok ? built.problems : [];

  // A confirmed failure of this draft's command; an uncertain one is shown separately.
  const createError =
    held === null && session !== null && mutation.error && mutation.variables?.draftId === session.id ? mutation.error : null;
  // A confirmed conflict makes this preview unusable; a fresh check keeps the typed draft.
  const previewRejected =
    createError instanceof ApiError &&
    createError.kind === 'conflict' &&
    !!session?.preview &&
    mutation.variables?.input.previewHash === session.preview.previewHash;

  const locked = held !== null || !props.writable;
  const shownRule = held ? ruleFromInput(held.input) : session?.rule;
  const shownTemplate = held ? templateFromInput(held.input) : session?.template;
  // A held command shows only the preview of its own draft and exact hash.
  const heldPreview =
    held !== null &&
    session !== null &&
    held.draftId !== undefined &&
    session.id === held.draftId &&
    session.preview?.previewHash === held.input.previewHash
      ? session.preview
      : null;
  const shownPreview = held ? heldPreview : (session?.preview ?? null);
  const canCreate =
    !locked && session !== null && session.preview !== null && session.previewInput !== null && !previewPending && !previewRejected;

  const close = () => c.setCreateOpen(false);
  const created = (series: RecurrenceSeriesDto) => props.onCreated?.(series.id);
  const retry = () => mutation.retryUncertain({ onSuccess: created });

  const changeRule = (rule: RecurrenceRuleDraft) => {
    if (!session || locked) return;
    setProblems(null);
    c.changeCreateDraft(session.id, { rule });
  };
  const changeTemplate = (template: RecurrenceTemplateDraft) => {
    if (!session || locked) return;
    setProblems(null);
    c.changeCreateDraft(session.id, { template });
  };

  const check = (event?: FormEvent) => {
    event?.preventDefault();
    if (!session || !built || locked || previewPending) return;
    if (!built.ok) {
      setProblems({ sessionId: session.id, messages: built.problems });
      return;
    }
    setProblems(null);
    // Nothing is held here, so this only clears the last confirmed failure.
    mutation.reset();
    c.checkCreateSchedule(session.id, built.input);
  };

  // Sends the frozen previewed input with its hash; never re-derived from the form.
  const create = () => {
    if (!canCreate || !session?.preview || !session.previewInput) return;
    mutation.mutate(
      { draftId: session.id, input: { ...session.previewInput, previewHash: session.preview.previewHash } },
      { onSuccess: created },
    );
  };

  // A confirmed 403/404 from this draft's preview or create hides cached fields before parent queries refetch.
  if (props.accessDenied || isAccessDenied(previewError) || isAccessDenied(createError)) {
    return (
      <DialogShell variant="drawer" title={title()} description={t('recurrence.projectDataIsUnavailableToTheCurrentUser')} open={c.createOpen} onOpenChange={c.setCreateOpen}>
        <div className={body}>
          <p role="status" className="text-sm text-muted">{t('recurrence.seriesFieldsAndScheduleStayHiddenUntilAccessIs2', { saveState: mutation.pendingCommand
              ? t('recurrence.theSubmittedSeriesIsWaitingForAServerResponse')
              : mutation.uncertain
                ? t('recurrence.theSeriesCreationResultIsUnknownRetryTheUnchanged')
                : t('recurrence.yourDraftIsPreservedOnThisPage') })}</p>
        </div>
        <div className={footer}>
          {held === null && session ? <Button onClick={c.discardCreate}>{t('recurrence.discardSeriesDraft')}</Button> : null}
          <Button onClick={close}>{t('recurrence.close')}</Button>
          {mutation.uncertain ? (
            <Button variant="primary" disabled={mutation.pendingCommand !== null} onClick={retry}>
              {t('recurrence.retryOriginalSeriesCreation')}</Button>
          ) : null}
        </div>
      </DialogShell>
    );
  }

  return (
    <DialogShell variant="drawer" title={title()} description={description()} open={c.createOpen} onOpenChange={c.setCreateOpen}>
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={check}>
        <div className={body}>
          {!shownRule || !shownTemplate ? (
            <p role="status" className="text-sm text-muted">{t('recurrence.noSeriesDraftIsReadyCloseThisDialogAnd')}</p>
          ) : (
            <>
              {!props.writable ? (
                <p className="text-sm text-muted">{t('recurrence.viewOnlyYouDoNotHavePermissionToCreate')}</p>
              ) : null}
              <section aria-labelledby={ruleHeadingId} className="min-w-0 space-y-3">
                <h3 id={ruleHeadingId} className="text-sm font-semibold">{t('recurrence.schedule')}</h3>
                <RecurrenceRuleFields value={shownRule} onChange={changeRule} periods={props.periods} disabled={locked} />
              </section>
              <section aria-labelledby={templateHeadingId} className="min-w-0 space-y-3 border-t border-line pt-5">
                <h3 id={templateHeadingId} className="text-sm font-semibold">{t('recurrence.meeting')}</h3>
                <RecurrenceTemplateFields
                  value={shownTemplate}
                  onChange={changeTemplate}
                  members={props.members}
                  statuses={props.statuses}
                  sections={props.sections}
                  disabled={locked}
                />
              </section>

              <div className="min-w-0 space-y-4 border-t border-line pt-5">
                {shownProblems.length > 0 ? (
                  <Alert tone="error" heading={t('recurrence.checkSeriesFields')}>
                    <ul className="list-disc space-y-0.5 pl-4">
                      {shownProblems.map((message) => (
                        <li key={message}>{message}</li>
                      ))}
                    </ul>
                  </Alert>
                ) : null}

                {previewError ? (
                  <Alert tone="error" heading={t('recurrence.couldNotPreviewSchedule')}>
                    <p>{t('recurrence.yourDraftIsPreserved3', { description: describeError(previewError, 'planning').description })}</p>
                    <RequestCode error={previewError} />
                  </Alert>
                ) : null}

                {mutation.uncertain ? (
                  <Alert tone="uncertain" heading={t('recurrence.seriesCreationResultUnknown')}>
                    <p>{describeError(mutation.uncertain.error, 'taskSave').description}</p>
                    <p>
                      {t('recurrence.theServerMayHaveCreatedTheSeriesSubmittedData')}</p>
                    <RequestCode error={mutation.uncertain.error} />
                  </Alert>
                ) : null}

                {createError ? (
                  <Alert tone="error" heading={t('recurrence.couldNotCreateMeetingSeries')}>
                    <p>
                      {previewRejected
                        ? t('recurrence.dataChangedAfterTheSchedulePreviewYourDraftIs')
                        : t('recurrence.yourDraftIsPreserved2', { description: describeError(createError, 'taskSave').description })}
                    </p>
                    <RequestCode error={createError} />
                  </Alert>
                ) : null}

                {mutation.pendingCommand ? (
                  <p role="status" className="text-sm text-muted">{t('recurrence.creatingSeriesSubmittedDataIsLockedUntilTheServer')}</p>
                ) : previewPending ? (
                  <p role="status" className="text-sm text-muted">{t('recurrence.checkingSchedule')}</p>
                ) : null}

                {shownPreview ? (
                  <RecurrenceCreatePreview preview={shownPreview} periods={props.periods} />
                ) : held === null && !previewPending ? (
                  <p className="text-sm text-muted">
                    {t('recurrence.previewBeforeCreatingAllSeriesDatesPeriodsAndDaylight')}</p>
                ) : null}
              </div>
            </>
          )}
        </div>

        <div className={footer}>
          <Button variant="ghost" disabled={held !== null || !session} onClick={c.discardCreate}>
            {t('recurrence.discardSeriesDraft')}</Button>
          <Button onClick={close}>{t('recurrence.close')}</Button>
          {held === null ? (
            <Button type="submit" disabled={locked || !session || previewPending}>
              {t('recurrence.previewSchedule')}</Button>
          ) : null}
          {mutation.uncertain ? (
            <Button variant="primary" disabled={mutation.pendingCommand !== null} onClick={retry}>
              {t('recurrence.retryOriginalSeriesCreation')}</Button>
          ) : (
            <Button variant="primary" disabled={!canCreate} aria-busy={mutation.pendingCommand !== null || undefined} onClick={create}>
              {t('recurrence.createSeries')}</Button>
          )}
        </div>
      </form>
    </DialogShell>
  );
}
