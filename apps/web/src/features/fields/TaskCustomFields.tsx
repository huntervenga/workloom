import { useTranslation } from '../../i18n';
import type { MembershipDto, TaskDto, TaskFieldDefinitionDto, TaskFieldValueDto } from '@workloom/contracts';
import { Badge, Button, Skeleton } from '@workloom/ui';
import { Lock, Pencil } from 'lucide-react';
import { useEffect, useId, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { isAccessDenied } from '../../lib/api';
import { isUuid } from '../../lib/format';
import { useUnsavedChangesWarning } from '../../lib/useUnsavedChangesWarning';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { FieldHistoryDialog } from './FieldHistoryDialog';
import {
  FieldValueForm,
  StoredValue,
  heldFieldCommand,
  isSessionDirty,
  newFieldSession,
  type FreshFieldData,
  type SetFieldValueMutation,
} from './FieldValueForm';
import { useTaskFieldValuesQuery, useTaskFieldsQuery, type SetTaskFieldValueVariables } from './queries';
import { draftFromFieldValue, sameId } from './valueDraft';
import { observableFieldDrafts, type FieldValueDraftStore, type FieldValueSessions } from './fieldValueDraftStore';
export type { FieldValueDraftStore } from './fieldValueDraftStore';

export interface TaskCustomFieldsProps {
  actorId: string;
  workspaceId: string;
  task: TaskDto;
  members: readonly MembershipDto[];
  /** The actor may change values in this project (not a viewer, project not archived). */
  writable: boolean;
  /** Owned by the page, so closing the drawer keeps a pending or unconfirmed value write. */
  mutation: SetFieldValueMutation;
  onOpenTask: (taskId: string) => void;
  /** Page-owned drafts survive switching tasks and closing the whole drawer. */
  draftStore?: FieldValueDraftStore | undefined;
}

/**
 * The task's custom field values, each with its own editor and history. Mounted for an existing
 * task only; a failure here never hides the built-in task form around it.
 */
export function TaskCustomFields({
  actorId, workspaceId, task, members, writable, mutation, onOpenTask, draftStore,
}: TaskCustomFieldsProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const fieldsQuery = useTaskFieldsQuery(actorId, workspaceId, task.projectId);
  const fields = useMemo(() => fieldsQuery.data ?? [], [fieldsQuery.data]);
  const activeFields = fields.filter((field) => field.archivedAt === null);
  const archivedFields = fields.filter((field) => field.archivedAt !== null);
  const valuesTaskId = fields.length > 0 ? task.id : '';
  const valuesQuery = useTaskFieldValuesQuery(actorId, workspaceId, valuesTaskId);
  const valuesByField = useMemo(
    () => new Map((valuesQuery.data ?? []).map((value) => [value.fieldId.toLowerCase(), value])),
    [valuesQuery.data],
  );

  const [openFieldId, setOpenFieldId] = useState<string | null>(null);
  const taskKey = task.id.toLowerCase();
  const store = useMemo(() => observableFieldDrafts(draftStore ?? new Map()), [draftStore]);
  const sessions = useSyncExternalStore(store.subscribe, () => store.getTask(taskKey));
  const setSessions = (update: (current: FieldValueSessions) => FieldValueSessions) => store.set(taskKey, update(store.getTask(taskKey)));
  const [confirmedFieldId, setConfirmedFieldId] = useState<string | null>(null);

  useEffect(() => {
    const confirmed = mutation.data;
    if (!confirmed || !sameId(confirmed.taskId, task.id) || !store.confirm(confirmed)) return;
    const key = confirmed.fieldId.toLowerCase();
    setOpenFieldId(current => current === key ? null : current);
    setConfirmedFieldId(key);
  }, [mutation.data, store, task.id]);

  useUnsavedChangesWarning(Object.values(sessions).some((session) => session !== undefined && isSessionDirty(session)));

  const held = heldFieldCommand(mutation);
  const heldOnTask = held !== null && sameId(held.taskId, task.id) ? held : null;
  const findField = (fieldId: string) => fields.find((field) => sameId(field.id, fieldId)) ?? null;
  /** `undefined` while the values are not loaded; `null` when the task has no row. */
  const currentValueOf = (fieldId: string): TaskFieldValueDto | null | undefined =>
    valuesQuery.data === undefined ? undefined : (valuesByField.get(fieldId.toLowerCase()) ?? null);
  const isHeldHere = (fieldId: string) => heldOnTask !== null && sameId(heldOnTask.fieldId, fieldId);

  const openEditor = (field: TaskFieldDefinitionDto) => {
    const key = field.id.toLowerCase();
    const heldHere = heldOnTask !== null && sameId(heldOnTask.fieldId, field.id) ? heldOnTask : null;
    const value = currentValueOf(field.id) ?? null;
    setSessions((current) => {
      const kept = current[key];
      if (heldHere) {
        if (kept) return current;
        // Rebuilt from the held command, not the cache: after a remount only the hook knows what was sent.
        const rebuilt = newFieldSession(field, value, draftFromFieldValue(field, heldHere.input.value));
        return { ...current, [key]: { ...rebuilt, submitted: true } };
      }
      if (kept && (isSessionDirty(kept) || kept.stale || kept.serverLocked)) return current;
      return { ...current, [key]: newFieldSession(field, value) };
    });
    setOpenFieldId(key);
    setConfirmedFieldId(null);
  };

  const reloadField = async (fieldId: string): Promise<FreshFieldData> => {
    if (!isUuid(valuesTaskId)) throw new Error(t('fields.taskCustomFields.fieldValuesNotRequested'));
    const [freshFields, freshValues] = await Promise.all([fieldsQuery.refetch(), valuesQuery.refetch()]);
    if (freshFields.isError || freshValues.isError || !freshFields.data || !freshValues.data) {
      throw new Error(t('fields.taskCustomFields.fieldDataReloadFailed'));
    }
    const field = freshFields.data.find((candidate) => sameId(candidate.id, fieldId));
    if (!field) throw new Error(t('fields.taskCustomFields.fieldNoLongerListed'));
    return { field, value: freshValues.data.find((candidate) => sameId(candidate.fieldId, fieldId)) ?? null };
  };

  const heldNotice = held ? (
    <HeldCommandNotice
      held={held}
      onTask={heldOnTask !== null}
      pending={mutation.pendingCommand !== null}
      field={findField(held.fieldId)}
      onOpenField={openEditor}
      onOpenTask={onOpenTask}
      onRetry={() => mutation.retryUncertain()}
    />
  ) : null;

  const editorSession = openFieldId !== null ? sessions[openFieldId] : undefined;
  const confirmedField = confirmedFieldId !== null ? findField(confirmedFieldId) : null;

  const rowFor = (field: TaskFieldDefinitionDto) => {
    const heldHere = isHeldHere(field.id);
    const canEdit =
      heldHere || (writable && !field.locked && field.archivedAt === null && valuesQuery.data !== undefined);
    return (
      <FieldRow
        key={field.id}
        field={field}
        value={currentValueOf(field.id)}
        members={members}
        heldState={heldHere ? (mutation.pendingCommand !== null ? 'pending' : 'uncertain') : null}
        onEdit={canEdit ? () => openEditor(field) : null}
        history={<FieldHistoryDialog actorId={actorId} workspaceId={workspaceId} taskId={task.id} field={field} members={members} />}
      />
    );
  };

  const denied = isAccessDenied(fieldsQuery.error)
    ? { error: fieldsQuery.error, subject: 'fields' as const }
    : isAccessDenied(valuesQuery.error)
      ? { error: valuesQuery.error, subject: 'fieldValues' as const }
      : null;
  if (denied) {
    return <QueryErrorState error={denied.error} subject={denied.subject} headingLevel={3} />;
  }

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h3 id={headingId} className="text-sm font-semibold text-ink">
        {t('fields.taskCustomFields.customFields')}</h3>
      <div role="status">
        {confirmedFieldId !== null ? (
          <p className="rounded-lg bg-canvas px-3 py-2 text-sm text-ink-soft">
            {confirmedField ? t('fields.taskCustomFields.valueOfValueSaved', { p0: confirmedField.name }) : t('fields.taskCustomFields.fieldValueSaved')}
          </p>
        ) : null}
      </div>
      {heldNotice}

      {fieldsQuery.isPending ? (
        <div role="status" className="space-y-2">
          <span className="sr-only">{t('fields.taskCustomFields.loadingCustomFields')}</span>
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : fieldsQuery.data === undefined ? (
        <QueryErrorState
          error={fieldsQuery.error}
          subject="fields"
          headingLevel={3}
          retrying={fieldsQuery.isFetching}
          onRetry={() => void fieldsQuery.refetch()}
        />
      ) : (
        <>
          {fieldsQuery.isRefetchError ? (
            <StaleNotice text={t('fields.taskCustomFields.couldNotRefreshFieldsShowingTheLastLoaded')} onRetry={() => void fieldsQuery.refetch()} />
          ) : null}
          {activeFields.length === 0 ? (
            <p className="text-sm text-muted">{t('fields.taskCustomFields.noCustomFieldsInThisProject')}</p>
          ) : valuesQuery.isPending ? (
            <div role="status" className="space-y-2">
              <span className="sr-only">{t('fields.taskCustomFields.loadingFieldValues')}</span>
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : valuesQuery.data === undefined ? (
            <QueryErrorState
              error={valuesQuery.error}
              subject="fieldValues"
              headingLevel={3}
              retrying={valuesQuery.isFetching}
              onRetry={() => void valuesQuery.refetch()}
            />
          ) : (
            <>
              {valuesQuery.isRefetchError ? (
                <StaleNotice
                  text={t('fields.taskCustomFields.couldNotRefreshFieldValuesShowingTheLast')}
                  onRetry={() => void valuesQuery.refetch()}
                />
              ) : null}
              <ul className="divide-y divide-line rounded-lg border border-line">{activeFields.map(rowFor)}</ul>
            </>
          )}
          {archivedFields.length > 0 ? (
            <details className="rounded-lg border border-line px-3 py-2 text-sm">
              <summary className="cursor-pointer text-ink-soft">{t('fields.taskCustomFields.archivedFields')}{archivedFields.length})</summary>
              <p className="mt-2 text-xs text-muted">{t('fields.taskCustomFields.newValuesAreNotAcceptedSavedValuesAnd')}</p>
              <ul className="mt-1 divide-y divide-line">{archivedFields.map(rowFor)}</ul>
            </details>
          ) : null}
        </>
      )}

      {openFieldId !== null && editorSession ? (
        <FieldValueForm
          actorId={actorId}
          workspaceId={workspaceId}
          taskId={task.id}
          taskTitle={task.title}
          session={editorSession}
          currentField={findField(openFieldId)}
          currentValue={currentValueOf(openFieldId)}
          members={members}
          writable={writable}
          mutation={mutation}
          autosave
          blockedNotice={heldNotice}
          onSubmitSession={session => store.capture(taskKey, session)}
          onSessionChange={(update) => {
            const key = openFieldId;
            setSessions((current) => {
              const session = current[key];
              return session ? { ...current, [key]: update(session) } : current;
            });
          }}
          onDiscard={() => {
            const key = openFieldId;
            const field = findField(key) ?? editorSession.field;
            const value = currentValueOf(key);
            setSessions((current) => ({ ...current, [key]: newFieldSession(field, value === undefined ? editorSession.value : value) }));
          }}
          onReload={() => reloadField(openFieldId)}
          onFieldLocked={() => void fieldsQuery.refetch()}
          onClose={() => setOpenFieldId(null)}
        />
      ) : null}
    </section>
  );
}

interface FieldRowProps {
  field: TaskFieldDefinitionDto;
  value: TaskFieldValueDto | null | undefined;
  members: readonly MembershipDto[];
  heldState: 'pending' | 'uncertain' | null;
  onEdit: (() => void) | null;
  history: ReactNode;
}

function FieldRow({ field, value, members, heldState, onEdit, history }: FieldRowProps) {
  const { t } = useTranslation();
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2.5">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium [overflow-wrap:anywhere] text-ink-soft">
          {field.name}
          {field.locked ? <Lock size={14} aria-hidden="true" className="shrink-0 text-muted" /> : null}
          {field.archivedAt !== null ? <Badge tone="muted">{t('fields.taskCustomFields.archived')}</Badge> : null}
        </p>
        {value !== undefined ? (
          <div className="text-sm [overflow-wrap:anywhere] text-ink">
            <StoredValue field={field} value={value} members={members} />
          </div>
        ) : null}
        {field.locked ? <p className="text-xs text-muted">{t('fields.taskCustomFields.thisFieldIsLockedItsValuesCannotBe')}</p> : null}
        {heldState ? (
          <p className="text-xs font-medium text-amber-800">
            {heldState === 'pending' ? t('fields.taskCustomFields.submittingANewValue') : t('fields.taskCustomFields.theNewValueSubmissionIsUnconfirmed')}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap gap-1">
        {onEdit ? (
          <Button size="sm" aria-label={t('fields.taskCustomFields.editValue', { p0: field.name })} onClick={onEdit}>
            <Pencil size={14} aria-hidden="true" />
            {t('fields.taskCustomFields.edit')}</Button>
        ) : null}
        {history}
      </div>
    </li>
  );
}

function StaleNotice({ text, onRetry }: { text: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2 text-sm text-amber-900">
      <span className="min-w-0 flex-1">{text}</span>
      <Button size="sm" onClick={onRetry}>
        {t('fields.taskCustomFields.retry')}</Button>
    </div>
  );
}

interface HeldCommandNoticeProps {
  held: SetTaskFieldValueVariables;
  /** The held command belongs to the task shown. */
  onTask: boolean;
  pending: boolean;
  /** The held command's current definition, if still listed. */
  field: TaskFieldDefinitionDto | null;
  onOpenField: (field: TaskFieldDefinitionDto) => void;
  onOpenTask: (taskId: string) => void;
  onRetry: () => void;
}

/** The one unresolved value write; until it is resolved no other value is sent. */
function HeldCommandNotice({ held, onTask, pending, field, onOpenField, onOpenTask, onRetry }: HeldCommandNoticeProps) {
  const { t } = useTranslation();
  const message = !onTask
    ? pending ? 'fields.taskCustomFields.otherTaskPending' : 'fields.taskCustomFields.otherTaskUnconfirmed'
    : field ? pending ? 'fields.taskCustomFields.namedFieldPending' : 'fields.taskCustomFields.namedFieldUnconfirmed'
    : pending ? 'fields.taskCustomFields.taskFieldPending' : 'fields.taskCustomFields.taskFieldUnconfirmed';
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2 text-sm text-amber-900">
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {t(message, { fieldName: field?.name ?? '' })}</span>
      {!onTask ? (
        <Button size="sm" onClick={() => onOpenTask(held.taskId)}>
          {t('fields.taskCustomFields.openThatTask')}</Button>
      ) : field ? (
        <Button size="sm" onClick={() => onOpenField(field)}>
          {t('fields.taskCustomFields.openValue', { p0: field.name })}
        </Button>
      ) : !pending ? (
        // The field is no longer listed, so the frozen value cannot be shown; the resend is unchanged.
        <Button size="sm" onClick={onRetry}>
          {t('fields.taskCustomFields.retrySubmission')}</Button>
      ) : null}
    </div>
  );
}
