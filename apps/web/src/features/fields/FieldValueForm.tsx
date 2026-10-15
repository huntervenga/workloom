import type { MembershipDto, TaskFieldData, TaskFieldDefinitionDto, TaskFieldValueDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { Archive, Lock, RefreshCw } from 'lucide-react';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../../lib/api';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { FieldHistoryDialog } from './FieldHistoryDialog';
import { FieldInput } from './FieldInput';
import { FieldValueDisplay } from './FieldValueDisplay';
import type { SetTaskFieldValueVariables, useSetTaskFieldValueMutation } from './queries';
import { draftFromFieldValue, parseFieldDraft, sameId, type FieldDraft } from './valueDraft';

export type SetFieldValueMutation = ReturnType<typeof useSetTaskFieldValueMutation>;

/** The value write the page's hook is sending or holds unconfirmed; one at a time. */
export function heldFieldCommand(mutation: SetFieldValueMutation): SetTaskFieldValueVariables | null {
  return mutation.pendingCommand?.variables ?? mutation.uncertain?.variables ?? null;
}

function isCommandFor(variables: SetTaskFieldValueVariables | null | undefined, taskId: string, fieldId: string): boolean {
  return variables !== null && variables !== undefined && sameId(variables.taskId, taskId) && sameId(variables.fieldId, fieldId);
}

/** Edit state of one field's value, kept while the editor is closed and reopened. */
export interface FieldEditSession {
  /** Definition the draft is edited against; its revision is sent as `expectedDefinitionRevision`. */
  field: TaskFieldDefinitionDto;
  /** Value row the draft is based on; null when the task has none (`expectedRevision: 0`). */
  value: TaskFieldValueDto | null;
  draft: FieldDraft;
  /** This session sent a command, so the hook's latest confirmed error is its own. */
  submitted: boolean;
  /** A confirmed conflict: nothing is sent until fresh data is loaded explicitly. */
  stale: boolean;
  /** The server refused the write because the field is locked. */
  serverLocked: boolean;
  /** The base before the last explicit reload, shown next to the fresh data. */
  previous: { field: TaskFieldDefinitionDto; value: TaskFieldValueDto | null } | null;
}

export function newFieldSession(
  field: TaskFieldDefinitionDto,
  value: TaskFieldValueDto | null,
  draft: FieldDraft = draftFromFieldValue(field, value?.value ?? null),
): FieldEditSession {
  return { field, value, draft, submitted: false, stale: false, serverLocked: false, previous: null };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function isSessionDirty(session: FieldEditSession): boolean {
  return !sameJson(session.draft, draftFromFieldValue(session.field, session.value?.value ?? null));
}

export interface StoredValueProps {
  field: TaskFieldDefinitionDto;
  /** null: the task has no value row, which differs from a row holding a typed `null`. */
  value: TaskFieldValueDto | null;
  members: readonly MembershipDto[];
}

export function StoredValue({ field, value, members }: StoredValueProps) {
  if (value === null) return <span className="text-muted">Значение не задавалось</span>;
  return <FieldValueDisplay field={field} value={value.value} members={members} />;
}

export interface FreshFieldData {
  field: TaskFieldDefinitionDto;
  value: TaskFieldValueDto | null;
}

export interface FieldValueFormProps {
  actorId: string;
  workspaceId: string;
  taskId: string;
  taskTitle: string;
  /** Kept edit state. While this field's command is held, the sent value is shown instead. */
  session: FieldEditSession;
  /** Latest loaded definition and value row (`undefined` when values are not loaded). */
  currentField: TaskFieldDefinitionDto | null;
  currentValue: TaskFieldValueDto | null | undefined;
  members: readonly MembershipDto[];
  writable: boolean;
  /** Owned by the page, so closing or remounting the editor keeps the held command. */
  mutation: SetFieldValueMutation;
  /** Shown when another value command is unresolved; this form sends nothing meanwhile. */
  blockedNotice: ReactNode;
  onSessionChange: (update: (session: FieldEditSession) => FieldEditSession) => void;
  /** Drops the draft and starts over from the loaded data. */
  onDiscard: () => void;
  /** Refetches the definition and the task's values; rejects when either fails. */
  onReload: () => Promise<FreshFieldData>;
  onFieldLocked: () => void;
  onClose: () => void;
}

/** One field's value editor in a centered dialog over the task drawer. */
export function FieldValueForm(props: FieldValueFormProps) {
  const { actorId, workspaceId, taskId, taskTitle, session, currentField, currentValue, members, writable, mutation } = props;
  const { blockedNotice, onSessionChange, onDiscard, onReload, onFieldLocked, onClose } = props;
  const field = session.field;
  const latestField = currentField ?? field;

  const [parseError, setParseError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloading, setReloading] = useState<'idle' | 'loading' | 'failed'>('idle');

  const held = heldFieldCommand(mutation);
  const heldHere = isCommandFor(held, taskId, field.id) ? held : null;
  const blocked = held !== null && heldHere === null;
  const pending = heldHere !== null && mutation.pendingCommand !== null;
  const uncertainHere = isCommandFor(mutation.uncertain?.variables, taskId, field.id) ? mutation.uncertain : null;

  const locked = latestField.locked || session.serverLocked;
  const archived = latestField.archivedAt !== null;
  const editable = writable && !locked && !archived;
  const canSend = editable && !session.stale && held === null;
  const dirty = heldHere === null && isSessionDirty(session);

  // A held command shows exactly what was sent, never the kept draft or the cache.
  const shownDraft = heldHere ? draftFromFieldValue(field, heldHere.input.value) : session.draft;
  const originalValue: TaskFieldData | null = heldHere ? heldHere.input.value : (session.value?.value ?? null);

  const ownError =
    heldHere === null && session.submitted && isCommandFor(mutation.variables, taskId, field.id) ? mutation.error : null;
  const changedSinceOpen =
    heldHere === null &&
    !session.stale &&
    session.previous === null &&
    ((currentField !== null && currentField.revision !== field.revision) ||
      (currentValue !== undefined && (currentValue?.revision ?? 0) !== (session.value?.revision ?? 0)));

  const handleError = (error: Error) => {
    if (!(error instanceof ApiError) || error.kind !== 'conflict') return;
    if (error.code === 'FIELD_LOCKED') {
      onSessionChange((current) => ({ ...current, serverLocked: true }));
      onFieldLocked();
    } else {
      onSessionChange((current) => ({ ...current, stale: true }));
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The dialog is portaled, but React still bubbles the submit to the task form around it.
    event.stopPropagation();
    if (heldHere) {
      if (!pending && uncertainHere) mutation.retryUncertain({ onError: handleError });
      return;
    }
    if (!canSend) return;
    const parsed = parseFieldDraft(field, session.draft);
    if (!parsed.ok) {
      setParseError(parsed.message);
      return;
    }
    setParseError(null);
    const original = session.value?.value ?? null;
    if (original === null ? parsed.value.value === null : sameJson(original, parsed.value)) {
      setNotice(original === null ? 'Поле и так не заполнено — сохранять нечего.' : 'Значение не изменилось — сохранять нечего.');
      return;
    }
    setNotice(null);
    onSessionChange((current) => ({ ...current, submitted: true, previous: null }));
    mutation.mutate(
      {
        taskId,
        fieldId: field.id,
        input: {
          expectedRevision: session.value?.revision ?? 0,
          expectedDefinitionRevision: field.revision,
          value: parsed.value,
        },
      },
      { onError: handleError },
    );
  };

  const reload = async () => {
    if (reloading === 'loading') return;
    setReloading('loading');
    try {
      const fresh = await onReload();
      // The draft stays as typed; only the base it is sent against moves to the fresh data.
      onSessionChange((current) => ({
        ...current,
        field: fresh.field,
        value: fresh.value,
        submitted: false,
        stale: false,
        serverLocked: false,
        previous: { field: current.field, value: current.value },
      }));
      setNotice(null);
      setReloading('idle');
    } catch {
      setReloading('failed');
    }
  };

  const reloadButton = (
    <Button size="sm" aria-disabled={reloading === 'loading' || undefined} onClick={() => void reload()}>
      <RefreshCw size={16} aria-hidden="true" className={reloading === 'loading' ? 'motion-safe:animate-spin' : undefined} />
      Загрузить актуальные данные
    </Button>
  );

  return (
    <DialogShell
      title={`Значение поля «${field.name}»`}
      description={`Задача «${taskTitle}».`}
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <form noValidate onSubmit={submit} className="mt-5 space-y-4">
        {blocked ? blockedNotice : null}

        {latestField.locked && !session.serverLocked ? (
          <p className="flex gap-2 rounded-lg bg-canvas px-3 py-2 text-sm text-ink-soft">
            <Lock size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span>
              Поле заблокировано: его значения сейчас нельзя изменить.
              {heldHere ? ' Неподтверждённую отправку можно повторить, но сервер может её отклонить.' : null}
            </span>
          </p>
        ) : null}
        {archived ? (
          <p className="flex gap-2 rounded-lg bg-canvas px-3 py-2 text-sm text-ink-soft">
            <Archive size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span>Поле в архиве: новые значения не принимаются.</span>
          </p>
        ) : null}
        {!writable && heldHere === null ? (
          <p className="rounded-lg bg-canvas px-3 py-2 text-sm text-ink-soft">Значение доступно только для просмотра.</p>
        ) : null}

        {changedSinceOpen ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink-soft">
            <span className="min-w-0 flex-1">Поле или его значение изменились после того, как вы открыли форму.</span>
            {reloadButton}
          </div>
        ) : null}

        {session.previous && heldHere === null ? (
          <FreshDataPanel
            session={session}
            previous={session.previous}
            members={members}
            onTakeServer={() => {
              onSessionChange((current) => ({
                ...current,
                draft: draftFromFieldValue(current.field, current.value?.value ?? null),
                previous: null,
              }));
              setParseError(null);
              setNotice('Форма показывает значение с сервера.');
            }}
            onDismiss={() => onSessionChange((current) => ({ ...current, previous: null }))}
          />
        ) : null}

        <fieldset disabled={heldHere !== null || blocked || !editable} className="min-w-0">
          <legend className="sr-only">{field.name}</legend>
          <FieldInput
            field={field}
            draft={shownDraft}
            onChange={(draft) => {
              onSessionChange((current) => ({ ...current, draft }));
              setParseError(null);
              setNotice(null);
            }}
            members={members}
            disabled={heldHere !== null || blocked || !editable}
            error={parseError}
            originalValue={originalValue}
          />
        </fieldset>
        {heldHere ? (
          <p className="text-xs text-muted">Показано отправленное значение — оно закреплено до ответа сервера.</p>
        ) : null}

        <SaveFeedback
          error={ownError}
          uncertainError={uncertainHere?.error ?? null}
          subject="fieldValueSave"
          action={session.stale ? reloadButton : null}
        />
        {reloading === 'failed' ? (
          <p role="alert" className="text-sm text-red-700">
            Не удалось загрузить актуальные данные поля. Повторите попытку.
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="rounded-lg bg-canvas px-3 py-2.5 text-sm leading-relaxed text-ink-soft">
            {notice}
          </p>
        ) : null}

        <div role="group" aria-label="Действия со значением" className="space-y-3 border-t border-line pt-4">
          <div className="flex flex-wrap items-center gap-2">
            {heldHere ? (
              <Button type="submit" variant="primary" aria-disabled={pending || undefined}>
                {pending ? 'Отправляем…' : 'Повторить отправку'}
              </Button>
            ) : editable ? (
              <Button type="submit" variant="primary" aria-disabled={!canSend || undefined}>
                Сохранить значение
              </Button>
            ) : null}
            {dirty ? (
              <Button
                variant="ghost"
                onClick={() => {
                  onDiscard();
                  setParseError(null);
                  setNotice(null);
                }}
              >
                Сбросить черновик
              </Button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <FieldHistoryDialog actorId={actorId} workspaceId={workspaceId} taskId={taskId} field={latestField} members={members} />
            <Button variant="ghost" onClick={onClose}>
              Закрыть
            </Button>
          </div>
        </div>
      </form>
    </DialogShell>
  );
}

interface FreshDataPanelProps {
  session: FieldEditSession;
  previous: NonNullable<FieldEditSession['previous']>;
  members: readonly MembershipDto[];
  onTakeServer: () => void;
  onDismiss: () => void;
}

/** Fresh server data after an explicit reload, next to the base the draft was started from. */
function FreshDataPanel({ session, previous, members, onTakeServer, onDismiss }: FreshDataPanelProps) {
  const headingId = useId();
  const { field, value } = session;
  const previousRevision = previous.value?.revision ?? 0;
  const currentRevision = value?.revision ?? 0;
  const changes = [
    previous.field.name === field.name ? null : `Поле переименовано: «${previous.field.name}» → «${field.name}».`,
    previous.field.revision === field.revision ? null : `Версия настроек поля: ${previous.field.revision} → ${field.revision}.`,
    previousRevision === currentRevision ? null : `Версия значения: ${previousRevision} → ${currentRevision}.`,
  ].filter((line) => line !== null);

  return (
    <section aria-labelledby={headingId} className="space-y-2 rounded-xl border border-line-strong bg-canvas p-3 text-sm">
      <h3 id={headingId} className="font-semibold text-ink">
        Актуальные данные загружены
      </h3>
      {changes.length > 0 ? (
        <ul className="space-y-0.5 text-xs [overflow-wrap:anywhere] text-muted">
          {changes.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">Версии поля и значения не изменились.</p>
      )}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-muted">Было</dt>
        <dd className="[overflow-wrap:anywhere] text-ink">
          <StoredValue field={previous.field} value={previous.value} members={members} />
        </dd>
        <dt className="text-muted">Сейчас</dt>
        <dd className="[overflow-wrap:anywhere] text-ink">
          <StoredValue field={field} value={value} members={members} />
        </dd>
      </dl>
      <p className="text-ink-soft">Ваш черновик остался в форме. Проверьте его и сохраните снова.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onTakeServer}>
          Взять значение с сервера
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Скрыть
        </Button>
      </div>
    </section>
  );
}
