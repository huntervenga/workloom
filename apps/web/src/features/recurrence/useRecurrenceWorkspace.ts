import {
  recurrenceCreatePreviewInputSchema,
  type RecurrenceCreatePreviewDto,
  type RecurrenceCreatePreviewInput,
  type RecurrenceMaterializationResultDto,
  type RecurrenceSeriesDto,
} from '@workloom/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { canonicalJson } from '../../lib/idempotency';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { useUnsavedChangesWarning } from '../../lib/useUnsavedChangesWarning';
import { previewRecurrenceCreate } from './api';
import { useRecurrenceCommands } from './queries';
import type { RecurrenceRuleDraft } from './RecurrenceRuleFields';
import type { RecurrenceTemplateDraft } from './RecurrenceTemplateFields';
import { useRecurrenceManagement } from './useRecurrenceManagement';

/** Page-known defaults for a new series; nothing is taken from the browser or the selected period. */
export interface RecurrenceCreateDefaults {
  timezone: string;
  statusId: string;
  organizerMembershipId: string;
}

/** One page-owned create draft. `id` is a UI draft ID only and never reaches a request body. */
export interface RecurrenceCreateSession {
  id: string;
  rule: RecurrenceRuleDraft;
  template: RecurrenceTemplateDraft;
  /** Server preview of exactly `previewInput`; any edit clears both. */
  preview: RecurrenceCreatePreviewDto | null;
  previewInput: RecurrenceCreatePreviewInput | null;
  /** Canonical form of the untouched defaults: an opened, unchanged form is not an unsent draft. */
  pristine: string;
}

/** The latest keyless preview read, identified by its session and the exact canonical input. */
export interface RecurrenceCreatePreviewRequest {
  sessionId: string;
  fingerprint: string;
  pending: boolean;
  error: Error | null;
}

export type RecurrenceCreateBuild =
  | { ok: true; input: RecurrenceCreatePreviewInput }
  | { ok: false; problems: string[] };

/** Fixed copy per schema path; the most specific prefix comes first. Schema messages are never shown. */
const problemCopy: readonly (readonly [string, string])[] = [
  ['schedule.startDate', 'Укажите дату начала серии.'],
  ['schedule.localTime', 'Укажите время серии в формате ЧЧ:ММ.'],
  ['schedule.timezone', 'Укажите часовой пояс IANA, например Asia/Nicosia.'],
  ['schedule.weekdays', 'Выберите хотя бы один день недели.'],
  ['schedule.plannedDurationMinutes', 'Длительность — целое число минут от 1 до 1440.'],
  ['schedule.end.endDate', 'Последняя дата серии должна быть не раньше даты начала и не дальше 366 дней от неё.'],
  ['schedule.end.count', 'Число встреч — целое число от 1 до 366.'],
  ['schedule.end', 'Проверьте окончание серии.'],
  ['schedule', 'Проверьте расписание серии.'],
  ['template.title', 'Введите название встречи.'],
  ['template.statusId', 'Выберите статус встречи.'],
  ['template.sectionId', 'Выберите раздел из списка или «Без раздела».'],
  ['template.organizerMembershipId', 'Выберите организатора.'],
  ['template.attendeeMembershipIds', 'Отметьте от 1 до 100 участников встреч серии.'],
  ['template.joinUrl', 'Ссылка на встречу должна начинаться с http:// или https://.'],
  ['template', 'Проверьте поля встречи.'],
  ['targetPeriodIds', 'Отметьте от 1 до 52 периодов серии.'],
];

function describeProblem(path: string): string {
  return problemCopy.find(([prefix]) => path === prefix || path.startsWith(`${prefix}.`))?.[1] ?? 'Проверьте поля серии.';
}

/** Whole numbers only: "1.5", "1e2" or a blank stay invalid instead of being rounded. */
function wholeNumber(raw: string): number {
  const text = raw.trim();
  return /^[0-9]{1,6}$/.test(text) ? Number(text) : Number.NaN;
}

/**
 * Builds the exact preview input from raw draft strings and validates it with the shared schema.
 * Daily series omit weekdays; only the chosen end variant is sent.
 */
export function buildRecurrenceCreatePreviewInput(rule: RecurrenceRuleDraft, template: RecurrenceTemplateDraft): RecurrenceCreateBuild {
  const joinUrl = template.joinUrl.trim();
  const candidate = {
    schedule: {
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
    },
    template: {
      title: template.title,
      statusId: template.statusId,
      sectionId: template.sectionId || null,
      organizerMembershipId: template.organizerMembershipId,
      attendeeMembershipIds: [...template.attendeeMembershipIds],
      joinUrl: joinUrl || null,
    },
    targetPeriodIds: [...rule.targetPeriodIds],
  };
  const parsed = recurrenceCreatePreviewInputSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, input: parsed.data };
  return { ok: false, problems: [...new Set(parsed.error.issues.map((issue) => describeProblem(issue.path.map(String).join('.'))))] };
}

const draftFingerprint = (rule: RecurrenceRuleDraft, template: RecurrenceTemplateDraft) => canonicalJson({ rule, template });

/** Start date stays empty and no period, attendee or organizer-as-attendee is preselected. */
export function newRecurrenceCreateSession(defaults: RecurrenceCreateDefaults): RecurrenceCreateSession {
  const rule: RecurrenceRuleDraft = {
    frequency: 'weekly',
    weekdays: [1, 2, 3, 4, 5],
    startDate: '',
    localTime: '10:00',
    timezone: defaults.timezone,
    durationMinutes: '60',
    endKind: 'after_count',
    endDate: '',
    count: '5',
    targetPeriodIds: [],
  };
  const template: RecurrenceTemplateDraft = {
    title: '',
    statusId: defaults.statusId,
    sectionId: '',
    organizerMembershipId: defaults.organizerMembershipId,
    attendeeMembershipIds: [],
    joinUrl: '',
  };
  return { id: crypto.randomUUID(), rule, template, preview: null, previewInput: null, pristine: draftFingerprint(rule, template) };
}

export function recurrenceCreateSessionDirty(session: RecurrenceCreateSession): boolean {
  return draftFingerprint(session.rule, session.template) !== session.pristine;
}

/**
 * Always-mounted recurrence page state, above the period selector and every dialog. Key it by
 * actor, workspace and project: sessions and results belong to the scope they were made in.
 */
export function useRecurrenceWorkspace(actorId: string, workspaceId: string, projectId: string) {
  const [createSession, setCreateSession] = useState<RecurrenceCreateSession | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createPreviewRequest, setCreatePreviewRequest] = useState<RecurrenceCreatePreviewRequest | null>(null);
  const [selectedSeriesId, setSelectedSeriesId] = useState<string | null>(null);
  /** Last chunk result per original submitted period (lowercase ID), independent of the selected period. */
  const [materializationByPeriod, setMaterializationByPeriod] = useState<Readonly<Record<string, RecurrenceMaterializationResultDto>>>({});
  /** Confirmed creation, also when it was retried from a closed dialog. */
  const [lastCreatedSeries, setLastCreatedSeries] = useState<RecurrenceSeriesDto | null>(null);

  const sessionRef = useRef<RecurrenceCreateSession | null>(null);
  const defaultsRef = useRef<RecurrenceCreateDefaults | null>(null);
  const previewAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    sessionRef.current = createSession;
  }, [createSession]);
  useEffect(() => () => previewAbort.current?.abort(), []);

  // Edit, add-period and exception drafts; pause/resume and authorization need none.
  const management = useRecurrenceManagement(workspaceId);

  // Page-owned: these run from the hooks' own onSuccess, so a retry sent while the dialog is hidden
  // still retires exactly the submitted draft, and a result lands on its original period.
  const commands = useRecurrenceCommands(actorId, workspaceId, projectId, {
    ...management.callbacks,
    onCreate: (series, variables) => {
      setLastCreatedSeries(series);
      const draftId = variables.draftId;
      if (draftId === undefined) return;
      if (sessionRef.current?.id === draftId) setCreateOpen(false);
      setCreateSession((current) => (current?.id === draftId ? null : current));
      setCreatePreviewRequest((current) => (current?.sessionId === draftId ? null : current));
    },
    onMaterialize: (result, variables) => {
      setMaterializationByPeriod((before) => ({ ...before, [variables.periodId.toLowerCase()]: result }));
    },
  });
  const createHeld = commands.create.pendingCommand !== null || commands.create.uncertain !== null;

  /** Reopens the retained draft, or starts one from the given defaults. */
  const openCreate = useCallback((defaults: RecurrenceCreateDefaults) => {
    defaultsRef.current = defaults;
    setCreateSession((current) => current ?? newRecurrenceCreateSession(defaults));
    setCreateOpen(true);
  }, []);

  /** Every edit invalidates the preview: only a fresh check makes the changed draft submittable. */
  const changeCreateDraft = useCallback(
    (sessionId: string, next: { rule?: RecurrenceRuleDraft | undefined; template?: RecurrenceTemplateDraft | undefined }) => {
      setCreateSession((current) =>
        current?.id === sessionId
          ? { ...current, rule: next.rule ?? current.rule, template: next.template ?? current.template, preview: null, previewInput: null }
          : current,
      );
    },
    [],
  );

  /**
   * Keyless preview of a validated input. The answer is kept only while the same session still builds
   * exactly this input, so a response for an edited draft can never become submittable.
   */
  const checkCreateSchedule = useCallback(
    (sessionId: string, input: RecurrenceCreatePreviewInput) => {
      const fingerprint = canonicalJson(input);
      previewAbort.current?.abort();
      const abort = new AbortController();
      previewAbort.current = abort;
      const isThisRequest = (current: RecurrenceCreatePreviewRequest | null) =>
        current?.sessionId === sessionId && current.fingerprint === fingerprint;
      setCreatePreviewRequest({ sessionId, fingerprint, pending: true, error: null });
      previewRecurrenceCreate(workspaceId, projectId, input, abort.signal)
        .then(
          (preview) => {
            if (abort.signal.aborted) return;
            setCreateSession((current) => {
              if (current?.id !== sessionId) return current;
              const now = buildRecurrenceCreatePreviewInput(current.rule, current.template);
              return now.ok && canonicalJson(now.input) === fingerprint ? { ...current, preview, previewInput: input } : current;
            });
            setCreatePreviewRequest((current) => (isThisRequest(current) ? null : current));
          },
          (error: unknown) => {
            if (abort.signal.aborted) return;
            const failure = error instanceof Error ? error : new Error('Recurrence preview failed.');
            setCreatePreviewRequest((current) =>
              current !== null && isThisRequest(current) ? { ...current, pending: false, error: failure } : current,
            );
          },
        )
        .finally(() => {
          if (previewAbort.current === abort) previewAbort.current = null;
        });
    },
    [workspaceId, projectId],
  );

  /** Explicit discard; refused while the create command is pending or uncertain. */
  const discardCreate = useCallback(() => {
    if (createHeld) return;
    previewAbort.current?.abort();
    previewAbort.current = null;
    setCreatePreviewRequest(null);
    setCreateSession(defaultsRef.current ? newRecurrenceCreateSession(defaultsRef.current) : null);
  }, [createHeld]);

  const clearLastCreatedSeries = useCallback(() => setLastCreatedSeries(null), []);

  // Pending/uncertain commands protect themselves; this covers only typed, unsent input.
  const createDirty = createSession !== null && recurrenceCreateSessionDirty(createSession);
  useUnsavedChangesWarning(createDirty);
  useProtectedDraft(createDirty);

  return {
    commands,
    createSession,
    setCreateSession,
    createOpen,
    setCreateOpen,
    openCreate,
    changeCreateDraft,
    checkCreateSchedule,
    createPreviewRequest,
    discardCreate,
    createDirty,
    selectedSeriesId,
    setSelectedSeriesId,
    materializationByPeriod,
    lastCreatedSeries,
    clearLastCreatedSeries,
    management,
  };
}
export type RecurrenceWorkspace = ReturnType<typeof useRecurrenceWorkspace>;
