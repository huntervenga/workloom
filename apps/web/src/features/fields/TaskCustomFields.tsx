import type { MembershipDto, TaskDto, TaskFieldDefinitionDto, TaskFieldValueDto } from '@workloom/contracts';
import { Badge, Button, Skeleton } from '@workloom/ui';
import { Lock, Pencil } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
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
  type FieldEditSession,
  type FreshFieldData,
  type SetFieldValueMutation,
} from './FieldValueForm';
import { useTaskFieldValuesQuery, useTaskFieldsQuery, type SetTaskFieldValueVariables } from './queries';
import { draftFromFieldValue, sameId } from './valueDraft';

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

type Sessions = Partial<Record<string, FieldEditSession>>;
export type FieldValueDraftStore = Map<string, Sessions>;

function withoutKey(sessions: Sessions, key: string): Sessions {
  return Object.fromEntries(Object.entries(sessions).filter(([candidate]) => candidate !== key));
}

/**
 * The task's custom field values, each with its own editor and history. Mounted for an existing
 * task only; a failure here never hides the built-in task form around it.
 */
export function TaskCustomFields({
  actorId, workspaceId, task, members, writable, mutation, onOpenTask, draftStore,
}: TaskCustomFieldsProps) {
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
  const [sessions, setSessions] = useState<Sessions>(() => draftStore?.get(taskKey) ?? {});
  useEffect(() => {
    draftStore?.set(taskKey, sessions);
  }, [draftStore, taskKey, sessions]);
  const [confirmedFieldId, setConfirmedFieldId] = useState<string | null>(null);

  // A confirmed write, possibly sent before this component remounted, closes its editor.
  const [seenData, setSeenData] = useState(mutation.data);
  if (mutation.data !== seenData) {
    setSeenData(mutation.data);
    const confirmed = mutation.data;
    if (confirmed !== undefined && sameId(confirmed.taskId, task.id)) {
      const key = confirmed.fieldId.toLowerCase();
      setSessions((current) => withoutKey(current, key));
      if (openFieldId === key) setOpenFieldId(null);
      setConfirmedFieldId(key);
    }
  }

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
    if (!isUuid(valuesTaskId)) throw new Error('Field values are not requested.');
    const [freshFields, freshValues] = await Promise.all([fieldsQuery.refetch(), valuesQuery.refetch()]);
    if (freshFields.isError || freshValues.isError || !freshFields.data || !freshValues.data) {
      throw new Error('Field data could not be reloaded.');
    }
    const field = freshFields.data.find((candidate) => sameId(candidate.id, fieldId));
    if (!field) throw new Error('The field is no longer listed.');
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
        Дополнительные поля
      </h3>
      <div role="status">
        {confirmedFieldId !== null ? (
          <p className="rounded-lg bg-canvas px-3 py-2 text-sm text-ink-soft">
            {confirmedField ? `Значение поля «${confirmedField.name}» сохранено.` : 'Значение поля сохранено.'}
          </p>
        ) : null}
      </div>
      {heldNotice}

      {fieldsQuery.isPending ? (
        <div role="status" className="space-y-2">
          <span className="sr-only">Загрузка дополнительных полей</span>
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
            <StaleNotice text="Не удалось обновить поля. Показана последняя загруженная версия." onRetry={() => void fieldsQuery.refetch()} />
          ) : null}
          {activeFields.length === 0 ? (
            <p className="text-sm text-muted">В проекте нет дополнительных полей.</p>
          ) : valuesQuery.isPending ? (
            <div role="status" className="space-y-2">
              <span className="sr-only">Загрузка значений полей</span>
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
                  text="Не удалось обновить значения полей. Показаны последние загруженные."
                  onRetry={() => void valuesQuery.refetch()}
                />
              ) : null}
              <ul className="divide-y divide-line rounded-lg border border-line">{activeFields.map(rowFor)}</ul>
            </>
          )}
          {archivedFields.length > 0 ? (
            <details className="rounded-lg border border-line px-3 py-2 text-sm">
              <summary className="cursor-pointer text-ink-soft">Поля в архиве ({archivedFields.length})</summary>
              <p className="mt-2 text-xs text-muted">Новые значения не принимаются; сохранённые значения и история остаются.</p>
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
          blockedNotice={heldNotice}
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
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2.5">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium [overflow-wrap:anywhere] text-ink-soft">
          {field.name}
          {field.locked ? <Lock size={14} aria-hidden="true" className="shrink-0 text-muted" /> : null}
          {field.archivedAt !== null ? <Badge tone="muted">В архиве</Badge> : null}
        </p>
        {value !== undefined ? (
          <div className="text-sm [overflow-wrap:anywhere] text-ink">
            <StoredValue field={field} value={value} members={members} />
          </div>
        ) : null}
        {field.locked ? <p className="text-xs text-muted">Поле заблокировано: его значения сейчас нельзя изменить.</p> : null}
        {heldState ? (
          <p className="text-xs font-medium text-amber-800">
            {heldState === 'pending' ? 'Новое значение отправляется…' : 'Отправка нового значения не подтверждена.'}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap gap-1">
        {onEdit ? (
          <Button size="sm" aria-label={`Изменить «${field.name}»`} onClick={onEdit}>
            <Pencil size={14} aria-hidden="true" />
            Изменить
          </Button>
        ) : null}
        {history}
      </div>
    </li>
  );
}

function StaleNotice({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2 text-sm text-amber-900">
      <span className="min-w-0 flex-1">{text}</span>
      <Button size="sm" onClick={onRetry}>
        Повторить
      </Button>
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
  const state = pending ? 'ещё отправляется' : 'ещё не подтверждено';
  const subject = !onTask
    ? 'Значение поля в другой задаче'
    : field
      ? `Значение поля «${field.name}»`
      : 'Значение поля этой задачи';
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2 text-sm text-amber-900">
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {subject} {state}. Пока его результат неизвестен, другие значения полей не отправляются.
      </span>
      {!onTask ? (
        <Button size="sm" onClick={() => onOpenTask(held.taskId)}>
          Открыть ту задачу
        </Button>
      ) : field ? (
        <Button size="sm" onClick={() => onOpenField(field)}>
          {`Открыть «${field.name}»`}
        </Button>
      ) : !pending ? (
        // The field is no longer listed, so the frozen value cannot be shown; the resend is unchanged.
        <Button size="sm" onClick={onRetry}>
          Повторить отправку
        </Button>
      ) : null}
    </div>
  );
}
