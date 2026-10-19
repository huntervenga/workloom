import {FieldPolicyPanel} from './FieldPolicyPanel';
import {useSetFieldPolicyMutation} from './policy-queries';
import { message, type TranslationMessage } from '../../i18n';
import { useTranslation } from '../../i18n';
import type { ProjectColumnsDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { Button, Skeleton } from '@workloom/ui';
import { Columns3, Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { ApiError, isAccessDenied } from '../../lib/api';
import { DialogShell } from '../../shared/DialogShell';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { SaveFeedback } from '../../shared/SaveFeedback';
import {
  FIELDS_LOAD_SUBJECT,
  FIELDS_SAVE_SUBJECT,
  FieldDefinitionForm,
  isSelectType,
  sentCommand,
  type FieldFormValue,
} from './FieldDefinitionForm';
import { FieldOptionsEditor } from './FieldOptionsEditor';
import { ProjectColumnsEditor } from './ProjectColumnsEditor';
import {
  useCreateTaskFieldMutation,
  useCreateTaskFieldOptionMutation,
  useProjectColumnsQuery,
  useTaskFieldsQuery,
  useUpdateProjectColumnsMutation,
  useUpdateTaskFieldMutation,
  useUpdateTaskFieldOptionMutation,
  type CreateTaskFieldVariables,
  type UpdateTaskFieldVariables,
} from './queries';

const EMPTY_FIELD: FieldFormValue = { name: '', type: 'text', historyEnabled: true, locked: false, options: [] };

function createValue({ input }: CreateTaskFieldVariables): FieldFormValue {
  return {
    name: input.name,
    type: input.type,
    historyEnabled: input.historyEnabled,
    locked: input.locked,
    options: input.options.map((option) => option.name),
  };
}

/** A definition update always sends the full name and flags, so the command is the visible snapshot. */
function updateValue({ input }: UpdateTaskFieldVariables, base: TaskFieldDefinitionDto): FieldFormValue {
  return {
    name: input.name ?? base.name,
    type: base.type,
    historyEnabled: input.historyEnabled ?? base.historyEnabled,
    locked: input.locked ?? base.locked,
    options: [],
  };
}

export interface FieldManagerDialogProps {
  triggerLabel?: string;
  /** Controlled opening lets a table header menu reuse the same durable manager. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
  actorId: string;
  workspaceId: string;
  projectId: string;
  canManage: boolean;
}

/**
 * Custom columns of a project: shared order and visibility, new columns, and name, history, lock
 * and options of existing ones. Every write hook lives here, outside the dialog content, so closing
 * the dialog keeps a pending or unconfirmed write, its frozen form and the navigation guard.
 */
export function FieldManagerDialog({ actorId, workspaceId, projectId, canManage, triggerLabel, open: controlledOpen, onOpenChange, showTrigger = true }: FieldManagerDialogProps) {
  const { t } = useTranslation();
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  const fields = useTaskFieldsQuery(actorId, workspaceId, projectId);
  const columns = useProjectColumnsQuery(actorId, workspaceId, projectId);
  const policyMutation=useSetFieldPolicyMutation(actorId,workspaceId);
  const createField = useCreateTaskFieldMutation(actorId, workspaceId);
  const updateField = useUpdateTaskFieldMutation(actorId, workspaceId);
  const createOption = useCreateTaskFieldOptionMutation(actorId, workspaceId);
  const updateOption = useUpdateTaskFieldOptionMutation(actorId, workspaceId);
  const updateColumns = useUpdateProjectColumnsMutation(actorId, workspaceId);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<TranslationMessage | null>(null);

  const projectFields = fields.data ?? [];
  const activeFields = projectFields.filter((field) => field.archivedAt === null);
  const isActiveField = (fieldId: string) => activeFields.some((field) => field.id === fieldId);

  const create = sentCommand(createField);
  const ownCreate = create !== null && create.variables.input.projectId === projectId ? create : null;
  const createElsewhere = create !== null && ownCreate === null;
  const createError = createField.variables?.input.projectId === projectId ? createField.error : null;
  // A sent create stays on screen until it is answered or resent.
  const showCreate = canManage && (creating || ownCreate !== null);

  // A sent write to one of this project's fields keeps that field open, as with the create form.
  const forcedId =
    [sentCommand(updateField), sentCommand(createOption), sentCommand(updateOption), sentCommand(policyMutation)]
      .map((command) => command?.variables.fieldId)
      .find((fieldId) => fieldId !== undefined && isActiveField(fieldId)) ?? null;
  const activeEditId = canManage ? (forcedId ?? editingId) : null;
  const editedField = activeFields.find((field) => field.id === activeEditId) ?? null;

  const closeCreate = () => {
    setCreating(false);
    if (createField.pendingCommand === null) createField.reset();
  };
  const closeEdit = () => {
    setEditingId(null);
    if (updateField.pendingCommand === null) updateField.reset();
    if (createOption.pendingCommand === null) createOption.reset();
    if (updateOption.pendingCommand === null) updateOption.reset();
  };
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (next) return;
    closeCreate();
    closeEdit();
    if (updateColumns.pendingCommand === null) updateColumns.reset();
  };

  const onCreated = (field: TaskFieldDefinitionDto) => {
    setCreating(false);
    setAnnouncement(message('fields.fieldManagerDialog.columnValueAdded', { p0: field.name }));
  };
  // A confirmed rejection that arrives after closing reopens with the sent values to correct.
  const createCallbacks = { onSuccess: onCreated, onError: () => setCreating(true) };

  const reloadColumns = async (): Promise<ProjectColumnsDto | null> => {
    const [freshColumns] = await Promise.all([columns.refetch(), fields.refetch()]);
    if (freshColumns.isError) {
      if (isAccessDenied(freshColumns.error)) return null;
      throw freshColumns.error;
    }
    return freshColumns.data ?? null;
  };
  const reloadFields = async (): Promise<TaskFieldDefinitionDto[]> => {
    const fresh = await fields.refetch();
    if (fresh.isError) throw fresh.error;
    return fresh.data ?? [];
  };

  const fieldNames = new Map(projectFields.map((field) => [field.id, field.name]));
  // A failed background refetch keeps the loaded data and the drafts on screen.
  const loadError =
    (isAccessDenied(fields.error) ? fields.error : null) ??
    (isAccessDenied(columns.error) ? columns.error : null) ??
    (fields.data ? null : fields.error) ??
    (columns.data ? null : columns.error);
  const retainedChanges = [
    { key: 'policy', command: sentCommand(policyMutation), retry: () => policyMutation.retryUncertain() },
    { key: 'definition', command: sentCommand(updateField), retry: () => updateField.retryUncertain() },
    { key: 'option-create', command: sentCommand(createOption), retry: () => createOption.retryUncertain() },
    { key: 'option-update', command: sentCommand(updateOption), retry: () => updateOption.retryUncertain() },
  ].flatMap((change) =>
    change.command !== null && !isActiveField(change.command.variables.fieldId)
      ? [{ ...change, command: change.command }]
      : [],
  );

  return (
    <DialogShell
      title={t('fields.fieldManagerDialog.projectColumns')}
      description={t('fields.fieldManagerDialog.customColumnsForThisProjectSTaskTable')}
      trigger={showTrigger ?
        <Button>
          <Columns3 size={16} aria-hidden="true" />
          {triggerLabel ?? t('fields.fieldManagerDialog.columns')}</Button> : undefined
      }
      open={open}
      onOpenChange={changeOpen}
    >
      <div className="mt-5 space-y-4">
        <p role="status" className="sr-only">
          {announcement ? t(announcement.key, announcement.params) : null}
        </p>
        <p className="rounded-lg bg-canvas px-3 py-2.5 text-sm leading-relaxed text-ink-soft">
          {t('fields.fieldManagerDialog.columnOrderAndVisibilityAreSharedWithThe')}</p>
        {canManage ? null : (
          <p className="text-sm text-muted">
            {t('fields.fieldManagerDialog.workspaceOwnersAndAdminsCanManageColumnsYou')}</p>
        )}

        {loadError ? (
          <QueryErrorState
            error={loadError}
            subject={FIELDS_LOAD_SUBJECT}
            headingLevel={3}
            retrying={fields.isFetching || columns.isFetching}
            onRetry={() => {
              void fields.refetch();
              void columns.refetch();
            }}
          />
        ) : !fields.data || !columns.data ? (
          <div role="status" className="space-y-2">
            <span className="sr-only">{t('fields.fieldManagerDialog.loadingColumns')}</span>
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        ) : (
          <>
            {retainedChanges.map((change) => (
              <section key={change.key} aria-label={t('fields.fieldManagerDialog.unconfirmedColumnChange')} className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2.5 text-sm text-amber-950">
                <p>{t('fields.fieldManagerDialog.thisColumnIsNoLongerActiveTheSubmitted')}</p>
                {change.command.pending ? (
                  <p role="status">{t('fields.fieldManagerDialog.waitingForTheServer')}</p>
                ) : (
                  <Button size="sm" onClick={change.retry}>{t('fields.fieldManagerDialog.retryColumnChange')}</Button>
                )}
              </section>
            ))}
            <ProjectColumnsEditor
              projectId={projectId}
              columns={columns.data}
              fieldNames={fieldNames}
              canManage={canManage}
              mutation={updateColumns}
              reload={reloadColumns}
              onEditField={(fieldId) => {
                if (forcedId === null) setEditingId(fieldId);
              }}
            />

            {projectFields.some(field => field.archivedAt !== null) ? (
              <details className="rounded-lg border border-line px-3 py-2 text-sm">
                <summary className="cursor-pointer text-muted">{t('taskTable.columnMenu.archived')}</summary>
                <ul className="mt-2 space-y-1">
                  {projectFields.filter(field => field.archivedAt !== null).map(field => (
                    <li key={field.id} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">{field.name}</span>
                      {canManage ? <Button size="sm" variant="ghost" disabled={sentCommand(updateField) !== null} onClick={() => updateField.mutate({ fieldId: field.id, input: { expectedRevision: field.revision, archived: false } })}>{t('taskTable.columnMenu.restore')}</Button> : null}
                    </li>
                  ))}
                </ul>
                <SaveFeedback subject={FIELDS_SAVE_SUBJECT} error={updateField.variables && projectFields.some(field => field.id === updateField.variables?.fieldId && field.archivedAt !== null) ? updateField.error : null} uncertainError={null} />
                {updateField.error ? <Button size="sm" variant="ghost" onClick={() => {
                  void reloadFields().then(() => { if (!sentCommand(updateField)) updateField.reset(); }).catch(() => undefined);
                }}>{t('fields.fieldManagerDialog.loadLatestVersion')}</Button> : null}
              </details>
            ) : null}
            {editedField ? (
              <section aria-label={t('fields.fieldManagerDialog.columnValue', { p0: editedField.name })} className="rounded-xl border border-line p-3">
                <EditFieldPanel
                  key={editedField.id}
                  field={editedField}
                  updateField={updateField}
                  createOption={createOption}
                  updateOption={updateOption}
                  reloadFields={reloadFields}
                  onRejected={() => setEditingId(editedField.id)}
                  onDone={(saved) => {
                    closeEdit();
                    if (saved) setAnnouncement(message('fields.fieldManagerDialog.columnValueSaved', { p0: saved.name }));
                  }}
                />
                <FieldPolicyPanel actorId={actorId} workspaceId={workspaceId} field={editedField} mutation={policyMutation}/>
              </section>
            ) : null}

            {showCreate ? (
              <section aria-label={t('fields.fieldManagerDialog.newColumn')} className="rounded-xl border border-line p-3">
                <FieldDefinitionForm
                  mode="create"
                  initial={createError && createField.variables ? createValue(createField.variables) : EMPTY_FIELD}
                  submitLabel={t('fields.fieldManagerDialog.addColumn')}
                  pending={ownCreate?.pending ?? false}
                  uncertain={ownCreate !== null && !ownCreate.pending}
                  sent={ownCreate ? createValue(ownCreate.variables) : null}
                  onRetry={() => createField.retryUncertain(createCallbacks)}
                  feedback={
                    <SaveFeedback
                      error={createError}
                      uncertainError={ownCreate && !ownCreate.pending ? (createField.uncertain?.error ?? null) : null}
                      subject={FIELDS_SAVE_SUBJECT}
                    />
                  }
                  onSubmit={(value) =>
                    createField.mutate(
                      {
                        input: {
                          projectId,
                          name: value.name,
                          type: value.type,
                          historyEnabled: value.historyEnabled,
                          locked: value.locked,
                          options: value.options.map((name) => ({ name, color: null })),
                        },
                      },
                      createCallbacks,
                    )
                  }
                  onCancel={closeCreate}
                />
              </section>
            ) : canManage ? (
              <div className="space-y-2">
                <Button
                  variant="primary"
                  aria-disabled={createElsewhere || undefined}
                  onClick={() => {
                    if (!createElsewhere) setCreating(true);
                  }}
                >
                  <Plus size={16} aria-hidden="true" />
                  {t('fields.fieldManagerDialog.addColumn')}</Button>
                {createElsewhere ? (
                  <p role="status" className="text-sm text-muted">
                    {create.pending
                      ? t('fields.fieldManagerDialog.aColumnIsBeingCreatedInAnotherProject')
                      : t('fields.fieldManagerDialog.aNewColumnInAnotherProjectIsUnconfirmed')}
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </DialogShell>
  );
}

interface EditFieldPanelProps {
  field: TaskFieldDefinitionDto;
  updateField: ReturnType<typeof useUpdateTaskFieldMutation>;
  createOption: ReturnType<typeof useCreateTaskFieldOptionMutation>;
  updateOption: ReturnType<typeof useUpdateTaskFieldOptionMutation>;
  reloadFields: () => Promise<TaskFieldDefinitionDto[]>;
  /** A confirmed rejection that arrives after closing reopens this field with the sent values. */
  onRejected: () => void;
  onDone: (saved: TaskFieldDefinitionDto | null) => void;
}

/**
 * Edits one field against the revision captured when it was opened, or the one returned by this
 * panel's own option writes. A conflict needs an explicit reload, which keeps every draft.
 */
function EditFieldPanel({
  field,
  updateField,
  createOption,
  updateOption,
  reloadFields,
  onRejected,
  onDone,
}: EditFieldPanelProps) {
  const { t } = useTranslation();
  const [base, setBase] = useState(field);
  const [reload, setReload] = useState<'idle' | 'loading' | 'done' | 'failed' | 'missing'>('idle');

  const command = sentCommand(updateField);
  const own = command !== null && command.variables.fieldId === field.id ? command : null;
  const otherTarget = command !== null && own === null;
  const optionBusy = [sentCommand(createOption), sentCommand(updateOption)].some(
    (option) => option?.variables.fieldId === field.id,
  );
  const failed = updateField.variables?.fieldId === field.id ? updateField.variables : undefined;
  const error = failed ? updateField.error : null;
  const correctable = error instanceof ApiError && (error.kind === 'conflict' || error.kind === 'validation');

  const loadLatest = async () => {
    if (reload === 'loading') return;
    setReload('loading');
    try {
      const fresh = (await reloadFields()).find((item) => item.id === field.id && item.archivedAt === null);
      if (!fresh) {
        setReload('missing');
        return;
      }
      setBase(fresh);
      if (updateField.pendingCommand === null) updateField.reset();
      if (createOption.pendingCommand === null) createOption.reset();
      if (updateOption.pendingCommand === null) updateOption.reset();
      setReload('done');
    } catch {
      setReload('failed');
    }
  };

  const reloadAction = (
    <Button size="sm" aria-disabled={reload === 'loading' || undefined} onClick={() => void loadLatest()}>
      <RefreshCw size={16} aria-hidden="true" className={reload === 'loading' ? 'motion-safe:animate-spin' : undefined} />
      {t('fields.fieldManagerDialog.loadLatestVersion')}</Button>
  );

  const notice = otherTarget
    ? command.pending
      ? t('fields.fieldManagerDialog.anotherColumnIsBeingChangedWaitForThe')
      : t('fields.fieldManagerDialog.anotherColumnChangeIsUnconfirmedOpenThatColumn')
    : optionBusy
      ? t('fields.fieldManagerDialog.saveTheNameAndSettingsAfterTheOption')
      : reload === 'done'
        ? t('fields.fieldManagerDialog.latestVersionOfValueLoadedYourValuesRemain', { p0: base.name })
        : reload === 'failed'
          ? t('fields.fieldManagerDialog.couldNotLoadTheLatestColumnTryAgain')
          : reload === 'missing'
            ? t('fields.fieldManagerDialog.thisColumnIsNoLongerAvailable')
            : null;

  const callbacks = { onSuccess: (saved: TaskFieldDefinitionDto) => onDone(saved), onError: onRejected };

  return (
    <div className="space-y-5">
      <FieldDefinitionForm
        mode="edit"
        initial={
          failed && error
            ? updateValue(failed, base)
            : { name: base.name, type: base.type, historyEnabled: base.historyEnabled, locked: base.locked, options: [] }
        }
        submitLabel={t('fields.fieldManagerDialog.save')}
        pending={own?.pending ?? false}
        uncertain={own !== null && !own.pending}
        sent={own ? updateValue(own.variables, base) : null}
        blocked={otherTarget || optionBusy}
        cancelable={!optionBusy}
        onRetry={() => updateField.retryUncertain(callbacks)}
        feedback={
          <SaveFeedback
            error={error}
            uncertainError={own && !own.pending ? (updateField.uncertain?.error ?? null) : null}
            subject={FIELDS_SAVE_SUBJECT}
            action={correctable ? reloadAction : null}
          />
        }
        notice={notice}
        onSubmit={(value) => {
          if (value.name === base.name && value.historyEnabled === base.historyEnabled && value.locked === base.locked) {
            onDone(null);
            return;
          }
          updateField.mutate(
            {
              fieldId: field.id,
              input: {
                expectedRevision: base.revision,
                name: value.name,
                historyEnabled: value.historyEnabled,
                locked: value.locked,
              },
            },
            callbacks,
          );
        }}
        onCancel={() => onDone(null)}
      />
      <div className="border-t border-line pt-3">
        <Button size="sm" variant="ghost" disabled={own !== null || otherTarget || optionBusy || correctable} onClick={() => updateField.mutate({ fieldId: field.id, input: { expectedRevision: base.revision, archived: true } }, callbacks)}>{t('taskTable.columnMenu.archive')}</Button>
        <p className="mt-1 text-xs text-muted">{t('taskTable.columnMenu.archiveHint')}</p>
      </div>
      {isSelectType(base.type) ? (
        <FieldOptionsEditor
          field={base}
          createMutation={createOption}
          updateMutation={updateOption}
          definitionBusy={own !== null}
          reloadAction={reloadAction}
          onSaved={(saved) => {
            setBase(saved);
            if (reload !== 'idle') setReload('idle');
          }}
        />
      ) : null}
    </div>
  );
}
