import { t } from '../../i18n';
import {
  recurrenceEditPreviewInputSchema,
  recurrenceExceptionPreviewInputSchema,
  recurrencePeriodPreviewInputSchema,
  type RecurrenceEditPreviewDto,
  type RecurrenceEditPreviewInput,
  type RecurrenceExceptionKind,
  type RecurrenceExceptionPreviewDto,
  type RecurrenceExceptionPreviewInput,
  type RecurrenceInstanceDto,
  type RecurrencePeriodPreviewDto,
  type RecurrencePeriodPreviewInput,
  type RecurrenceSeriesDto,
} from '@workloom/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type ApiErrorKind } from '../../lib/api';
import { canonicalJson } from '../../lib/idempotency';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { useUnsavedChangesWarning } from '../../lib/useUnsavedChangesWarning';
import { isMaterializationRequired, previewRecurrenceEdit, previewRecurrenceException, previewRecurrencePeriods } from './api';
import type { AddPeriodsVariables, EditSeriesVariables, RecurrenceSuccessCallbacks, SetExceptionVariables } from './queries';
import type { RecurrenceRuleDraft } from './RecurrenceRuleFields';
import type { RecurrenceTemplateDraft } from './RecurrenceTemplateFields';

/*
 * Page-owned management drafts for existing series: edit, add periods and per-instance exceptions.
 * Sessions are keyed by the target identity and outlive their dialogs, the selected series and the
 * selected period. Previews are keyless reads; only the command hooks' own onSuccess retires a draft.
 */

export type RecurrenceManagementKind = 'edit' | 'periods' | 'exception';

/** Map key of a session: lowercase series ID (edit, periods) or instance ID (exception). */
export const recurrenceManagementKey = (id: string) => id.toLowerCase();

/** The latest keyless check of one session. */
export interface RecurrencePreviewCheck {
  /** Canonical input that was sent; null when the draft did not build and nothing was sent. */
  fingerprint: string | null;
  pending: boolean;
  /** Failure of exactly this check; show it with `recurrencePreviewErrorCopy`. */
  error: Error | null;
  /** Fixed copy for a draft that does not build. */
  problems: readonly string[];
}

/** Common shape of a management draft. `id` is a UI draft ID: it becomes `draftId` and never reaches a request body. */
export interface RecurrenceManagedSession<TInput, TPreview> {
  id: string;
  /** Server preview of exactly `previewInput`; any change clears both. */
  preview: TPreview | null;
  previewInput: TInput | null;
  check: RecurrencePreviewCheck | null;
  /** Canonical form of the opened values: an untouched session is not an unsent draft. */
  pristine: string;
}

export interface RecurrenceEditSession extends RecurrenceManagedSession<RecurrenceEditPreviewInput, RecurrenceEditPreviewDto> {
  /** The series as opened; its revision is `expectedRevision`. Replaced only by an explicit rebase, never automatically. */
  base: RecurrenceSeriesDto;
  /** Raw YYYY-MM-DD; empty until chosen, never taken from the browser clock. */
  effectiveFromNominalDate: string;
  /** `rule.targetPeriodIds` shows the bound periods only; an edit never sends periods. */
  rule: RecurrenceRuleDraft;
  template: RecurrenceTemplateDraft;
}

export interface RecurrencePeriodSession extends RecurrenceManagedSession<RecurrencePeriodPreviewInput, RecurrencePeriodPreviewDto> {
  base: RecurrenceSeriesDto;
  /** Only explicitly checked new periods; nothing is preselected. */
  periodIds: string[];
}

export interface RecurrenceExceptionSession
  extends RecurrenceManagedSession<RecurrenceExceptionPreviewInput, RecurrenceExceptionPreviewDto> {
  baseSeries: RecurrenceSeriesDto;
  baseInstance: RecurrenceInstanceDto;
  kind: RecurrenceExceptionKind;
  /** Raw move target; starts at the instance's intended wall date/time and is sent only for `move`. */
  localDate: string;
  localTime: string;
  reason: string;
}

export interface RecurrenceEditChange {
  effectiveFromNominalDate?: string | undefined;
  rule?: RecurrenceRuleDraft | undefined;
  template?: RecurrenceTemplateDraft | undefined;
}

export interface RecurrenceExceptionChange {
  kind?: RecurrenceExceptionKind | undefined;
  localDate?: string | undefined;
  localTime?: string | undefined;
  reason?: string | undefined;
}

export type RecurrenceManagementTarget = { kind: RecurrenceManagementKind; key: string };

export type RecurrenceManagementActive =
  | { kind: 'edit'; session: RecurrenceEditSession }
  | { kind: 'periods'; session: RecurrencePeriodSession }
  | { kind: 'exception'; session: RecurrenceExceptionSession }
  | null;

export type RecurrenceBuild<TInput> = { ok: true; input: TInput } | { ok: false; problems: string[] };

/** Pass these into `useRecurrenceCommands`; dialogs never call them. */
export interface RecurrenceManagementCallbacks {
  onEdit: NonNullable<RecurrenceSuccessCallbacks['onEdit']>;
  onAddPeriods: NonNullable<RecurrenceSuccessCallbacks['onAddPeriods']>;
  onException: NonNullable<RecurrenceSuccessCallbacks['onException']>;
}

/** Fixed copy per schema path; the most specific prefix comes first. Schema messages are never shown. */
const problemCopy: readonly (readonly [string, `recurrence.${string}`])[] = [
  ['expectedRevision', 'recurrence.seriesDataIsOutdatedReopenTheForm'],
  ['expectedSeriesRevision', 'recurrence.seriesDataIsOutdatedReopenTheForm'],
  ['expectedInstanceRevision', 'recurrence.meetingDataIsOutdatedReopenTheForm'],
  ['effectiveFromNominalDate', 'recurrence.enterTheDateWhenSeriesChangesStart'],
  ['schedule.startDate', 'recurrence.enterTheSeriesStartDate'],
  ['schedule.localTime', 'recurrence.enterTheSeriesTimeAsHhMm'],
  ['schedule.timezone', 'recurrence.enterAnIanaTimeZoneSuchAsAsiaNicosia'],
  ['schedule.weekdays', 'recurrence.chooseAtLeastOneWeekday'],
  ['schedule.plannedDurationMinutes', 'recurrence.durationMustBeAWholeNumberOfMinutesFrom'],
  ['schedule.end.endDate', 'recurrence.theLastDateMustBeOnOrAfterThe'],
  ['schedule.end.count', 'recurrence.meetingCountMustBeAWholeNumberFrom1'],
  ['schedule.end', 'recurrence.checkTheSeriesEnd'],
  ['schedule', 'recurrence.checkTheSeriesSchedule'],
  ['template.title', 'recurrence.enterAMeetingTitle'],
  ['template.statusId', 'recurrence.chooseAMeetingStatus'],
  ['template.sectionId', 'recurrence.chooseASectionFromTheListOrNoSection'],
  ['template.organizerMembershipId', 'recurrence.chooseAnOrganizer2'],
  ['template.attendeeMembershipIds', 'recurrence.select1100SeriesParticipants'],
  ['template.joinUrl', 'recurrence.meetingLinkMustBeginWithHttpOrHttps'],
  ['template', 'recurrence.checkTheMeetingFields'],
  ['periodIds', 'recurrence.select152PeriodsToAdd'],
  ['kind', 'recurrence.chooseAMeetingAction'],
  ['localDate', 'recurrence.enterANewMeetingDate'],
  ['localTime', 'recurrence.enterTheNewMeetingTimeAsHhMm'],
  ['reason', 'recurrence.enterAReasonOfUpTo1000Characters'],
];

function problemsOf(issues: readonly { path: readonly PropertyKey[] }[]): string[] {
  const describe = (path: string) =>
    t(problemCopy.find(([prefix]) => path === prefix || path.startsWith(`${prefix}.`))?.[1] ?? 'recurrence.checkTheChangeFields');
  return [...new Set(issues.map((issue) => describe(issue.path.map(String).join('.'))))];
}

const errorCopy: Record<ApiErrorKind, string> = {
  get network() { return t('recurrence.couldNotCompleteTheCheckTryAgain'); },
  get server() { return t('recurrence.couldNotCompleteTheCheckTryAgain'); },
  get unavailable() { return t('recurrence.theServiceIsTemporarilyUnavailableTryThePreviewLater'); },
  get invalid_response() { return t('recurrence.couldNotCompleteTheCheckTryAgain'); },
  get rate_limited() { return t('recurrence.tooManyRequestsTryThePreviewLater'); },
  get unauthenticated() { return t('recurrence.accessUnavailableRefreshThePage'); },
  get forbidden() { return t('recurrence.seriesOrMeetingUnavailable'); },
  get not_found() { return t('recurrence.seriesOrMeetingUnavailable'); },
  get conflict() { return t('recurrence.theSeriesOrMeetingChangedAfterYouOpenedThis'); },
  get validation() { return t('recurrence.theServerRejectedThisChangeCheckTheFields'); },
  get invalid_input() { return t('recurrence.checkTheChangeFields'); },
};

/** Fixed, safe copy for a failed preview; server messages and details are never shown. */
export function recurrencePreviewErrorCopy(error: Error): string {
  if (isMaterializationRequired(error)) return t('recurrence.prepareMeetingsInTheAffectedPeriodThenPreviewAgain');
  return error instanceof ApiError ? errorCopy[error.kind] : errorCopy.network;
}

/** Whole numbers only: "1.5", "1e2" or a blank stay invalid instead of being rounded. */
function wholeNumber(raw: string): number {
  const text = raw.trim();
  return /^[0-9]{1,6}$/.test(text) ? Number(text) : Number.NaN;
}

/** Daily series omit weekdays; only the chosen end variant is sent. */
function scheduleCandidate(rule: RecurrenceRuleDraft) {
  return {
    startDate: rule.startDate,
    localTime: rule.localTime,
    timezone: rule.timezone.trim(),
    frequency: rule.frequency,
    ...(rule.frequency === 'weekly' ? { weekdays: [...rule.weekdays].sort((a, b) => a - b) } : {}),
    plannedDurationMinutes: wholeNumber(rule.durationMinutes),
    end:
      rule.endKind === 'on_date'
        ? { kind: 'on_date' as const, endDate: rule.endDate }
        : { kind: 'after_count' as const, count: wholeNumber(rule.count) },
  };
}

function templateCandidate(template: RecurrenceTemplateDraft) {
  const joinUrl = template.joinUrl.trim();
  return {
    title: template.title,
    statusId: template.statusId,
    sectionId: template.sectionId || null,
    organizerMembershipId: template.organizerMembershipId,
    attendeeMembershipIds: [...template.attendeeMembershipIds],
    joinUrl: joinUrl || null,
  };
}

export function buildRecurrenceEditPreviewInput(session: RecurrenceEditSession): RecurrenceBuild<RecurrenceEditPreviewInput> {
  const parsed = recurrenceEditPreviewInputSchema.safeParse({
    expectedRevision: session.base.revision,
    effectiveFromNominalDate: session.effectiveFromNominalDate,
    schedule: scheduleCandidate(session.rule),
    template: templateCandidate(session.template),
  });
  return parsed.success ? { ok: true, input: parsed.data } : { ok: false, problems: problemsOf(parsed.error.issues) };
}

export function buildRecurrencePeriodPreviewInput(session: RecurrencePeriodSession): RecurrenceBuild<RecurrencePeriodPreviewInput> {
  const parsed = recurrencePeriodPreviewInputSchema.safeParse({ expectedRevision: session.base.revision, periodIds: [...session.periodIds] });
  return parsed.success ? { ok: true, input: parsed.data } : { ok: false, problems: problemsOf(parsed.error.issues) };
}

/** Both revisions guard the exception; the move date/time is sent only for `move`. */
export function buildRecurrenceExceptionPreviewInput(session: RecurrenceExceptionSession): RecurrenceBuild<RecurrenceExceptionPreviewInput> {
  const guarded = {
    expectedSeriesRevision: session.baseSeries.revision,
    expectedInstanceRevision: session.baseInstance.revision,
    reason: session.reason,
    kind: session.kind,
  };
  const parsed = recurrenceExceptionPreviewInputSchema.safeParse(
    session.kind === 'move' ? { ...guarded, localDate: session.localDate, localTime: session.localTime } : guarded,
  );
  return parsed.success ? { ok: true, input: parsed.data } : { ok: false, problems: problemsOf(parsed.error.issues) };
}

const editFingerprint = (s: Pick<RecurrenceEditSession, 'effectiveFromNominalDate' | 'rule' | 'template'>) =>
  canonicalJson({ effectiveFromNominalDate: s.effectiveFromNominalDate, rule: { ...s.rule, targetPeriodIds: undefined }, template: s.template });
const periodFingerprint = (s: Pick<RecurrencePeriodSession, 'periodIds'>) => canonicalJson(s.periodIds);
const exceptionFingerprint = (s: Pick<RecurrenceExceptionSession, 'kind' | 'localDate' | 'localTime' | 'reason'>) =>
  canonicalJson({ kind: s.kind, localDate: s.localDate, localTime: s.localTime, reason: s.reason });

export const recurrenceEditSessionDirty = (s: RecurrenceEditSession) => editFingerprint(s) !== s.pristine;
export const recurrencePeriodSessionDirty = (s: RecurrencePeriodSession) => periodFingerprint(s) !== s.pristine;
export const recurrenceExceptionSessionDirty = (s: RecurrenceExceptionSession) => exceptionFingerprint(s) !== s.pristine;

/** Seeds raw controls from the current version; the effective date stays empty. */
export function newRecurrenceEditSession(series: RecurrenceSeriesDto): RecurrenceEditSession {
  const { schedule, template } = series.currentVersion;
  const rule: RecurrenceRuleDraft = {
    frequency: schedule.frequency,
    weekdays: [...(schedule.weekdays ?? [])],
    startDate: schedule.startDate,
    localTime: schedule.localTime,
    timezone: schedule.timezone,
    durationMinutes: String(schedule.plannedDurationMinutes),
    endKind: schedule.end.kind,
    endDate: schedule.end.kind === 'on_date' ? schedule.end.endDate : '',
    count: schedule.end.kind === 'after_count' ? String(schedule.end.count) : '',
    targetPeriodIds: [...series.boundPeriodIds],
  };
  const templateDraft: RecurrenceTemplateDraft = {
    title: template.title,
    statusId: template.statusId,
    sectionId: template.sectionId ?? '',
    organizerMembershipId: template.organizerMembershipId,
    attendeeMembershipIds: [...template.attendeeMembershipIds],
    joinUrl: template.joinUrl ?? '',
  };
  const values = { effectiveFromNominalDate: '', rule, template: templateDraft };
  return { id: crypto.randomUUID(), base: series, ...values, preview: null, previewInput: null, check: null, pristine: editFingerprint(values) };
}

export function newRecurrencePeriodSession(series: RecurrenceSeriesDto): RecurrencePeriodSession {
  const periodIds: string[] = [];
  return { id: crypto.randomUUID(), base: series, periodIds, preview: null, previewInput: null, check: null, pristine: periodFingerprint({ periodIds }) };
}

export function newRecurrenceExceptionSession(
  series: RecurrenceSeriesDto,
  instance: RecurrenceInstanceDto,
  kind: RecurrenceExceptionKind,
): RecurrenceExceptionSession {
  const values = { kind, localDate: instance.resolution.intendedLocalDate, localTime: instance.resolution.intendedLocalTime, reason: '' };
  return {
    id: crypto.randomUUID(),
    baseSeries: series,
    baseInstance: instance,
    ...values,
    preview: null,
    previewInput: null,
    check: null,
    pristine: exceptionFingerprint(values),
  };
}

/** A fresh preview of exactly what the session builds now, or null. */
function freshPreview<TInput, TPreview>(session: RecurrenceManagedSession<TInput, TPreview>, now: RecurrenceBuild<TInput>) {
  if (session.preview === null || session.previewInput === null || !now.ok) return null;
  return canonicalJson(now.input) === canonicalJson(session.previewInput) ? { input: session.previewInput, preview: session.preview } : null;
}

/** Submittable variables, or null without a fresh preview or when the preview lists protected targets (apply would reject). */
export function recurrenceEditVariables(session: RecurrenceEditSession): EditSeriesVariables | null {
  const fresh = freshPreview(session, buildRecurrenceEditPreviewInput(session));
  if (fresh === null || fresh.preview.protectedTargets.length > 0) return null;
  return { draftId: session.id, seriesId: session.base.id, input: { ...fresh.input, previewHash: fresh.preview.previewHash } };
}

export function recurrencePeriodVariables(session: RecurrencePeriodSession): AddPeriodsVariables | null {
  const fresh = freshPreview(session, buildRecurrencePeriodPreviewInput(session));
  if (fresh === null) return null;
  return { draftId: session.id, seriesId: session.base.id, input: { ...fresh.input, previewHash: fresh.preview.previewHash } };
}

/**
 * Addressed by the instance's stable series and original nominal key. Null without a fresh preview or
 * when the preview lists protected reasons (apply would reject).
 */
export function recurrenceExceptionVariables(session: RecurrenceExceptionSession): SetExceptionVariables | null {
  const fresh = freshPreview(session, buildRecurrenceExceptionPreviewInput(session));
  if (fresh === null || fresh.preview.protectedReasons.length > 0) return null;
  return {
    draftId: session.id,
    seriesId: session.baseInstance.seriesId,
    occurrenceKey: session.baseInstance.occurrenceKey,
    input: { ...fresh.input, previewHash: fresh.preview.previewHash },
  };
}

/** Whether this draft's command is pending or uncertain; pass the result to `discard`. */
export function recurrenceDraftHeld(
  command: {
    pendingCommand: { variables: { draftId?: string | undefined } } | null;
    uncertain: { variables: { draftId?: string | undefined } } | null;
  },
  draftId: string,
): boolean {
  return command.pendingCommand?.variables.draftId === draftId || command.uncertain?.variables.draftId === draftId;
}

type Sessions<S> = Readonly<Record<string, S>>;
type AnySession = RecurrenceManagedSession<unknown, unknown>;

interface SessionStore<S> {
  readonly ref: { readonly current: Sessions<S> };
  readonly update: (change: (current: Sessions<S>) => Sessions<S>) => void;
}

/** State plus a synchronously updated mirror, so a check sent right after a change reads that change. */
function useSessionStore<S extends AnySession>(): readonly [Sessions<S>, SessionStore<S>] {
  const ref = useRef<Sessions<S>>({});
  const [sessions, setSessions] = useState<Sessions<S>>({});
  const update = useCallback((change: (current: Sessions<S>) => Sessions<S>) => {
    const next = change(ref.current);
    if (next === ref.current) return;
    ref.current = next;
    setSessions(next);
  }, []);
  const store = useMemo(() => ({ ref, update }), [update]);
  return [sessions, store];
}

function keyOf<S extends AnySession>(sessions: Sessions<S>, sessionId: string): string | undefined {
  return Object.keys(sessions).find((key) => sessions[key]?.id === sessionId);
}

/** Patches only the session with this draft ID; a retired or replaced session is never recreated. */
function patchSession<S extends AnySession>(sessions: Sessions<S>, sessionId: string, patch: (session: S) => S): Sessions<S> {
  const key = keyOf(sessions, sessionId);
  const before = key === undefined ? undefined : sessions[key];
  if (key === undefined || before === undefined) return sessions;
  const after = patch(before);
  return after === before ? sessions : { ...sessions, [key]: after };
}

const cleared = { preview: null, previewInput: null, check: null } as const;

function findSession<S extends AnySession>(sessions: Sessions<S>, sessionId: string): S | undefined {
  const key = keyOf(sessions, sessionId);
  return key === undefined ? undefined : sessions[key];
}

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The same stable series in the same workspace and project, at the base revision or later. */
function seriesRebaseable(base: RecurrenceSeriesDto, fresh: RecurrenceSeriesDto): boolean {
  return (
    sameId(base.id, fresh.id) &&
    sameId(base.workspaceId, fresh.workspaceId) &&
    sameId(base.projectId, fresh.projectId) &&
    fresh.revision >= base.revision
  );
}

/** The same reserved header: series, binding, originally assigned period and nominal key unchanged, revision not older. */
function instanceRebaseable(base: RecurrenceInstanceDto, fresh: RecurrenceInstanceDto): boolean {
  return (
    sameId(base.id, fresh.id) &&
    sameId(base.workspaceId, fresh.workspaceId) &&
    sameId(base.projectId, fresh.projectId) &&
    sameId(base.seriesId, fresh.seriesId) &&
    sameId(base.bindingId, fresh.bindingId) &&
    sameId(base.plannedPeriodId, fresh.plannedPeriodId) &&
    base.occurrenceKey === fresh.occurrenceKey &&
    fresh.revision >= base.revision
  );
}

/**
 * Keyless preview of what the session builds now. The answer is kept only while the same session
 * still builds exactly the sent input, so a response for a changed or retired draft is dropped.
 */
function startCheck<TInput, TPreview, S extends RecurrenceManagedSession<TInput, TPreview>>(
  store: SessionStore<S>,
  aborts: Map<string, AbortController>,
  sessionId: string,
  build: (session: S) => RecurrenceBuild<TInput>,
  send: (session: S, input: TInput, signal: AbortSignal) => Promise<TPreview>,
): void {
  const key = keyOf(store.ref.current, sessionId);
  const session = key === undefined ? undefined : store.ref.current[key];
  if (session === undefined) return;
  aborts.get(sessionId)?.abort();
  aborts.delete(sessionId);
  const built = build(session);
  if (!built.ok) {
    const check: RecurrencePreviewCheck = { fingerprint: null, pending: false, error: null, problems: built.problems };
    store.update((current) => patchSession(current, sessionId, (s) => ({ ...s, preview: null, previewInput: null, check })));
    return;
  }
  const input = built.input;
  const fingerprint = canonicalJson(input);
  const abort = new AbortController();
  aborts.set(sessionId, abort);
  const check: RecurrencePreviewCheck = { fingerprint, pending: true, error: null, problems: [] };
  store.update((current) => patchSession(current, sessionId, (s) => ({ ...s, preview: null, previewInput: null, check })));
  send(session, input, abort.signal)
    .then(
      (preview) => {
        if (abort.signal.aborted) return;
        store.update((current) =>
          patchSession(current, sessionId, (s) => {
            if (s.check?.fingerprint !== fingerprint) return s;
            const now = build(s);
            return now.ok && canonicalJson(now.input) === fingerprint ? { ...s, preview, previewInput: input, check: null } : { ...s, check: null };
          }),
        );
      },
      (error: unknown) => {
        if (abort.signal.aborted) return;
        const failure = error instanceof Error ? error : new Error('Recurrence preview failed.');
        store.update((current) =>
          patchSession(current, sessionId, (s) =>
            s.check !== null && s.check.fingerprint === fingerprint ? { ...s, check: { ...s.check, pending: false, error: failure } } : s,
          ),
        );
      },
    )
    .finally(() => {
      if (aborts.get(sessionId) === abort) aborts.delete(sessionId);
    });
}

function activeSession(
  target: RecurrenceManagementTarget | null,
  edits: Sessions<RecurrenceEditSession>,
  periods: Sessions<RecurrencePeriodSession>,
  exceptions: Sessions<RecurrenceExceptionSession>,
): RecurrenceManagementActive {
  if (target === null) return null;
  switch (target.kind) {
    case 'edit': {
      const session = edits[target.key];
      return session ? { kind: 'edit', session } : null;
    }
    case 'periods': {
      const session = periods[target.key];
      return session ? { kind: 'periods', session } : null;
    }
    case 'exception': {
      const session = exceptions[target.key];
      return session ? { kind: 'exception', session } : null;
    }
  }
}

/**
 * Always-mounted management state of one workspace page. Mount it under the page's
 * actor/workspace/project key: sessions and previews belong to the scope they were made in.
 */
export function useRecurrenceManagement(workspaceId: string) {
  const [edits, editStore] = useSessionStore<RecurrenceEditSession>();
  const [periodSessions, periodStore] = useSessionStore<RecurrencePeriodSession>();
  const [exceptions, exceptionStore] = useSessionStore<RecurrenceExceptionSession>();
  const [activeTarget, setActiveTarget] = useState<RecurrenceManagementTarget | null>(null);
  /** In-flight preview per draft ID. */
  const [aborts] = useState(() => new Map<string, AbortController>());
  useEffect(
    () => () => {
      for (const abort of aborts.values()) abort.abort();
      aborts.clear();
    },
    [aborts],
  );

  const stopCheck = useCallback(
    (sessionId: string) => {
      aborts.get(sessionId)?.abort();
      aborts.delete(sessionId);
    },
    [aborts],
  );

  const withStore = useCallback(
    <R>(kind: RecurrenceManagementKind, run: <S extends AnySession>(store: SessionStore<S>) => R): R =>
      kind === 'edit' ? run(editStore) : kind === 'periods' ? run(periodStore) : run(exceptionStore),
    [editStore, periodStore, exceptionStore],
  );

  /** Removes exactly the session with this draft ID and closes its dialog only if it is the active one. */
  const remove = useCallback(
    (kind: RecurrenceManagementKind, draftId: string | undefined): boolean => {
      if (draftId === undefined) return false;
      return withStore(kind, (store) => {
        const key = keyOf(store.ref.current, draftId);
        if (key === undefined) return false;
        stopCheck(draftId);
        store.update((current) =>
          current[key]?.id === draftId ? Object.fromEntries(Object.entries(current).filter(([other]) => other !== key)) : current,
        );
        setActiveTarget((current) => (current?.kind === kind && current.key === key ? null : current));
        return true;
      });
    },
    [withStore, stopCheck],
  );

  /** Each opener reopens the retained draft for its target, or starts one from the given server data. */
  const openEdit = useCallback(
    (series: RecurrenceSeriesDto) => {
      const key = recurrenceManagementKey(series.id);
      editStore.update((current) => (current[key] ? current : { ...current, [key]: newRecurrenceEditSession(series) }));
      setActiveTarget({ kind: 'edit', key });
    },
    [editStore],
  );

  const openPeriods = useCallback(
    (series: RecurrenceSeriesDto) => {
      const key = recurrenceManagementKey(series.id);
      periodStore.update((current) => (current[key] ? current : { ...current, [key]: newRecurrencePeriodSession(series) }));
      setActiveTarget({ kind: 'periods', key });
    },
    [periodStore],
  );

  /** `kind` applies only to a new draft; a retained draft keeps its own. */
  const openException = useCallback(
    (series: RecurrenceSeriesDto, instance: RecurrenceInstanceDto, kind: RecurrenceExceptionKind) => {
      if (recurrenceManagementKey(instance.seriesId) !== recurrenceManagementKey(series.id)) return;
      const key = recurrenceManagementKey(instance.id);
      exceptionStore.update((current) =>
        current[key] ? current : { ...current, [key]: newRecurrenceExceptionSession(series, instance, kind) },
      );
      setActiveTarget({ kind: 'exception', key });
    },
    [exceptionStore],
  );

  /** Hides the dialog; the draft and any held command stay. */
  const close = useCallback(() => setActiveTarget(null), []);

  // Every change invalidates the session's preview: only a fresh check makes it submittable.
  const changeEdit = useCallback(
    (sessionId: string, next: RecurrenceEditChange) => {
      stopCheck(sessionId);
      editStore.update((current) =>
        patchSession(current, sessionId, (s) => ({
          ...s,
          effectiveFromNominalDate: next.effectiveFromNominalDate ?? s.effectiveFromNominalDate,
          rule: next.rule ?? s.rule,
          template: next.template ?? s.template,
          ...cleared,
        })),
      );
    },
    [editStore, stopCheck],
  );

  const changePeriods = useCallback(
    (sessionId: string, periodIds: readonly string[]) => {
      stopCheck(sessionId);
      periodStore.update((current) => patchSession(current, sessionId, (s) => ({ ...s, periodIds: [...periodIds], ...cleared })));
    },
    [periodStore, stopCheck],
  );

  const changeException = useCallback(
    (sessionId: string, next: RecurrenceExceptionChange) => {
      stopCheck(sessionId);
      exceptionStore.update((current) =>
        patchSession(current, sessionId, (s) => ({
          ...s,
          kind: next.kind ?? s.kind,
          localDate: next.localDate ?? s.localDate,
          localTime: next.localTime ?? s.localTime,
          reason: next.reason ?? s.reason,
          ...cleared,
        })),
      );
    },
    [exceptionStore, stopCheck],
  );

  const checkEdit = useCallback(
    (sessionId: string) =>
      startCheck(editStore, aborts, sessionId, buildRecurrenceEditPreviewInput, (s, input, signal) =>
        previewRecurrenceEdit(workspaceId, s.base.id, input, signal),
      ),
    [editStore, aborts, workspaceId],
  );

  const checkPeriods = useCallback(
    (sessionId: string) =>
      startCheck(periodStore, aborts, sessionId, buildRecurrencePeriodPreviewInput, (s, input, signal) =>
        previewRecurrencePeriods(workspaceId, s.base.id, input, signal),
      ),
    [periodStore, aborts, workspaceId],
  );

  const checkException = useCallback(
    (sessionId: string) =>
      startCheck(exceptionStore, aborts, sessionId, buildRecurrenceExceptionPreviewInput, (s, input, signal) =>
        previewRecurrenceException(workspaceId, s.baseInstance.seriesId, s.baseInstance.occurrenceKey, input, signal),
      ),
    [exceptionStore, aborts, workspaceId],
  );

  /** After a confirmed rejection (e.g. a conflict): drops the preview, keeps every raw value. Held commands are untouched. */
  const clearPreview = useCallback(
    (kind: RecurrenceManagementKind, sessionId: string) => {
      stopCheck(sessionId);
      withStore(kind, (store) => store.update((current) => patchSession(current, sessionId, (s) => ({ ...s, ...cleared }))));
    },
    [withStore, stopCheck],
  );

  // Explicit rebase after a confirmed revision conflict, never automatic. Refused while `held`, for another
  // target or scope, or for an older revision. Only the base changes: draft ID, raw values and `pristine`
  // stay, so `dirty` still reflects typed input; the preview and any pending check are dropped.
  const rebaseEdit = useCallback(
    (sessionId: string, freshSeries: RecurrenceSeriesDto, held: boolean): boolean => {
      if (held) return false;
      const session = findSession(editStore.ref.current, sessionId);
      if (session === undefined || !seriesRebaseable(session.base, freshSeries)) return false;
      stopCheck(sessionId);
      editStore.update((current) => patchSession(current, sessionId, (s) => ({ ...s, base: freshSeries, ...cleared })));
      return true;
    },
    [editStore, stopCheck],
  );

  const rebasePeriods = useCallback(
    (sessionId: string, freshSeries: RecurrenceSeriesDto, held: boolean): boolean => {
      if (held) return false;
      const session = findSession(periodStore.ref.current, sessionId);
      if (session === undefined || !seriesRebaseable(session.base, freshSeries)) return false;
      stopCheck(sessionId);
      periodStore.update((current) => patchSession(current, sessionId, (s) => ({ ...s, base: freshSeries, ...cleared })));
      return true;
    },
    [periodStore, stopCheck],
  );

  const rebaseException = useCallback(
    (sessionId: string, freshSeries: RecurrenceSeriesDto, freshInstance: RecurrenceInstanceDto, held: boolean): boolean => {
      if (held) return false;
      const session = findSession(exceptionStore.ref.current, sessionId);
      if (
        session === undefined ||
        !seriesRebaseable(session.baseSeries, freshSeries) ||
        !instanceRebaseable(session.baseInstance, freshInstance)
      ) {
        return false;
      }
      stopCheck(sessionId);
      exceptionStore.update((current) =>
        patchSession(current, sessionId, (s) => ({ ...s, baseSeries: freshSeries, baseInstance: freshInstance, ...cleared })),
      );
      return true;
    },
    [exceptionStore, stopCheck],
  );

  /** Explicit discard of one draft; refused while `held` (see `recurrenceDraftHeld`). Returns whether it was removed. */
  const discard = useCallback(
    (kind: RecurrenceManagementKind, sessionId: string, held: boolean): boolean => (held ? false : remove(kind, sessionId)),
    [remove],
  );

  // Run from the command hooks' own onSuccess with the ORIGINAL variables, so a retry sent from a
  // closed dialog retires exactly the submitted draft. Response IDs never decide ownership.
  const callbacks = useMemo<RecurrenceManagementCallbacks>(
    () => ({
      onEdit: (_data, variables) => {
        remove('edit', variables.draftId);
      },
      onAddPeriods: (_data, variables) => {
        remove('periods', variables.draftId);
      },
      onException: (_data, variables) => {
        remove('exception', variables.draftId);
      },
    }),
    [remove],
  );

  // Pending/uncertain commands protect themselves; this covers only changed, unsent input.
  const dirty =
    Object.values(edits).some(recurrenceEditSessionDirty) ||
    Object.values(periodSessions).some(recurrencePeriodSessionDirty) ||
    Object.values(exceptions).some(recurrenceExceptionSessionDirty);
  useUnsavedChangesWarning(dirty);
  useProtectedDraft(dirty);

  return {
    edits,
    periodSessions,
    exceptions,
    activeTarget,
    active: activeSession(activeTarget, edits, periodSessions, exceptions),
    openEdit,
    openPeriods,
    openException,
    close,
    changeEdit,
    changePeriods,
    changeException,
    checkEdit,
    checkPeriods,
    checkException,
    clearPreview,
    rebaseEdit,
    rebasePeriods,
    rebaseException,
    discard,
    dirty,
    callbacks,
  };
}
export type RecurrenceManagement = ReturnType<typeof useRecurrenceManagement>;
