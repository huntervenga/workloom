import { message, type TranslationMessage } from '../../i18n';
import { useTranslation } from '../../i18n';
import type { TaskFieldDefinitionDto, TaskFieldOptionDto } from '@workloom/contracts';
import { Badge, Button, TextInput, cn } from '@workloom/ui';
import { Archive, ArchiveRestore, Pencil, Plus } from 'lucide-react';
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../../lib/api';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { TagColorPalette } from '../tasks/TagColorPalette';
import { FIELDS_SAVE_SUBJECT, OPTION_NAME_MAX, optionNameProblem, sentCommand } from './FieldDefinitionForm';
import type { useCreateTaskFieldOptionMutation, useUpdateTaskFieldOptionMutation } from './queries';

type CreateOptionMutation = ReturnType<typeof useCreateTaskFieldOptionMutation>;
type UpdateOptionMutation = ReturnType<typeof useUpdateTaskFieldOptionMutation>;

function orderOptions(options: readonly TaskFieldOptionDto[]): TaskFieldOptionDto[] {
  return [...options].sort(
    (a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null) || a.position - b.position,
  );
}

function OptionSwatch({ color }: { color: string | null }) {
  useTranslation();
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-2.5 shrink-0 rounded-full', color === null && 'bg-subtle')}
      style={color === null ? undefined : { backgroundColor: color }}
    />
  );
}

export interface FieldOptionsEditorProps {
  /** The field as last loaded or saved here; its `revision` guards every option write. */
  field: TaskFieldDefinitionDto;
  /** Both owned by a component that outlives the dialog, so an unconfirmed write is not forgotten. */
  createMutation: CreateOptionMutation;
  updateMutation: UpdateOptionMutation;
  /** A definition write to this field is pending or unconfirmed; option writes wait for it. */
  definitionBusy: boolean;
  /** Shown with a conflict or rejected write: reloads the field without touching the drafts. */
  reloadAction: ReactNode;
  onSaved: (field: TaskFieldDefinitionDto) => void;
}

/**
 * Options of a select field: add, rename, archive and restore. IDs stay stable, so tasks and
 * history keep referring to the same option; nothing is deleted. One option write at a time,
 * each against the field revision the user is looking at.
 */
export function FieldOptionsEditor({
  field,
  createMutation,
  updateMutation,
  definitionBusy,
  reloadAction,
  onSaved,
}: FieldOptionsEditorProps) {
  const { t } = useTranslation();
  const createCommand = sentCommand(createMutation);
  const updateCommand = sentCommand(updateMutation);
  const ownCreate = createCommand !== null && createCommand.variables.fieldId === field.id ? createCommand : null;
  const ownUpdate = updateCommand !== null && updateCommand.variables.fieldId === field.id ? updateCommand : null;
  const createElsewhere = createCommand !== null && ownCreate === null;
  const updateElsewhere = updateCommand !== null && ownUpdate === null;
  // Every write moves the field revision, so writes to this field never overlap.
  const busy = definitionBusy || ownCreate !== null || ownUpdate !== null;
  const createError = createMutation.variables?.fieldId === field.id ? createMutation.error : null;
  const updateError = updateMutation.variables?.fieldId === field.id ? updateMutation.error : null;
  const error = createError ?? updateError;
  const correctable = error instanceof ApiError && (error.kind === 'conflict' || error.kind === 'validation');

  const [newName, setNewName] = useState(() => (createError ? (createMutation.variables?.input.name ?? '') : ''));
  const [renaming, setRenaming] = useState<{ optionId: string; name: string } | null>(() => {
    const failed = updateError ? updateMutation.variables : undefined;
    const failedName = failed?.input.name;
    return failed && failedName !== undefined ? { optionId: failed.optionId, name: failedName } : null;
  });
  const [addError, setAddError] = useState<TranslationMessage | null>(null);
  const [renameError, setRenameError] = useState<TranslationMessage | null>(null);
  const [announcement, setAnnouncement] = useState<TranslationMessage | null>(null);
  const [colorOptionId, setColorOptionId] = useState<string | null>(null);
  const addRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const ids = { add: useId(), addError: useId(), rename: useId(), renameError: useId(), hint: useId() };

  // The visible state of an own update comes from what was sent: a rename shows its name, an archive its row.
  const sentName = ownUpdate?.variables.input.name;
  const sentRename =
    ownUpdate && sentName !== undefined ? { optionId: ownUpdate.variables.optionId, name: sentName } : null;
  const activeRename = sentRename ?? renaming;
  const sentArchive = ownUpdate && ownUpdate.variables.input.archived !== undefined ? ownUpdate : null;
  const sentColor = ownUpdate && ownUpdate.variables.input.color !== undefined ? ownUpdate : null;
  const uncertainError =
    ownCreate && !ownCreate.pending
      ? (createMutation.uncertain?.error ?? null)
      : ownUpdate && !ownUpdate.pending
        ? (updateMutation.uncertain?.error ?? null)
        : null;

  const elsewhere = createElsewhere ? createCommand : updateElsewhere ? updateCommand : null;
  const notice = elsewhere
    ? elsewhere.pending
      ? t('fields.fieldOptionsEditor.anOptionInAnotherColumnIsBeingSaved')
      : t('fields.fieldOptionsEditor.anOptionChangeInAnotherColumnIsUnconfirmed')
    : definitionBusy
      ? t('fields.fieldOptionsEditor.editOptionsAfterTheColumnChangeIsConfirmed')
      : null;

  const saved = (message: TranslationMessage) => (result: TaskFieldDefinitionDto) => {
    onSaved(result);
    setAnnouncement(message);
  };

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (createMutation.pendingCommand !== null || createElsewhere) return;
    if (ownCreate) {
      createMutation.retryUncertain({
        onSuccess: (result) => {
          setNewName('');
          saved(message('fields.fieldOptionsEditor.optionAdded'))(result);
        },
      });
      return;
    }
    if (busy) return;
    const name = newName.trim();
    const problem = optionNameProblem(name);
    setAddError(problem);
    if (problem) {
      addRef.current?.focus();
      return;
    }
    setNewName(name);
    createMutation.mutate(
      { fieldId: field.id, input: { expectedRevision: field.revision, name, color: null } },
      {
        onSuccess: (result) => {
          setNewName('');
          saved(message('fields.fieldOptionsEditor.optionValueAdded', { p0: name }))(result);
        },
      },
    );
  };

  const rename = (event: FormEvent<HTMLFormElement>, option: TaskFieldOptionDto) => {
    event.preventDefault();
    event.stopPropagation();
    if (updateMutation.pendingCommand !== null || updateElsewhere) return;
    if (ownUpdate) {
      updateMutation.retryUncertain({
        onSuccess: (result) => {
          setRenaming(null);
          saved(message('fields.fieldOptionsEditor.optionSaved'))(result);
        },
      });
      return;
    }
    if (busy || !renaming) return;
    const name = renaming.name.trim();
    const problem = optionNameProblem(name);
    setRenameError(problem);
    if (problem) {
      renameRef.current?.focus();
      return;
    }
    if (name === option.name) {
      setRenaming(null);
      return;
    }
    setRenaming({ optionId: option.id, name });
    updateMutation.mutate(
      { fieldId: field.id, optionId: option.id, input: { expectedRevision: field.revision, name } },
      {
        onSuccess: (result) => {
          setRenaming(null);
          saved(message('fields.fieldOptionsEditor.optionValueSaved', { p0: name }))(result);
        },
      },
    );
  };

  const setArchived = (option: TaskFieldOptionDto, archived: boolean) => {
    if (busy || updateElsewhere) return;
    setRenaming(null);
    updateMutation.mutate(
      { fieldId: field.id, optionId: option.id, input: { expectedRevision: field.revision, archived } },
      { onSuccess: saved(archived ? message('fields.fieldOptionsEditor.optionValueArchived', { p0: option.name }) : message('fields.fieldOptionsEditor.optionValueRestored', { p0: option.name })) },
    );
  };

  const setColor = (option: TaskFieldOptionDto, color: string | null) => {
    if (busy || updateElsewhere || color === option.color) return;
    setColorOptionId(option.id);
    updateMutation.mutate(
      { fieldId: field.id, optionId: option.id, input: { expectedRevision: field.revision, color } },
      { onSuccess: saved(message('fields.fieldOptionsEditor.optionColorSaved', { p0: option.name })) },
    );
  };

  const options = orderOptions(field.options);
  const addFrozen = busy || createElsewhere;
  const shownNewName = ownCreate ? ownCreate.variables.input.name : newName;

  return (
    <section aria-label={t('fields.fieldOptionsEditor.options')} className="space-y-3">
      <h3 className="text-sm font-medium text-ink">{t('fields.fieldOptionsEditor.options')}</h3>
      <p role="status" className="sr-only">
        {announcement ? t(announcement.key, announcement.params) : null}
      </p>
      <p id={ids.hint} className="text-xs leading-relaxed text-subtle">
        {t('fields.fieldOptionsEditor.archivedOptionsCannotBeSelectedForNewValues')}</p>

      {options.length === 0 ? (
        <p className="text-sm text-muted">{t('fields.fieldOptionsEditor.noOptionsYet')}</p>
      ) : (
        <ul aria-label={t('fields.fieldOptionsEditor.columnOptions')} className="divide-y divide-line rounded-xl border border-line">
          {options.map((option) => {
            const archived = option.archivedAt !== null;
            const editing = activeRename?.optionId === option.id;
            const own = sentRename?.optionId === option.id;
            const archiving = sentArchive?.variables.optionId === option.id ? sentArchive : null;
            const coloring = sentColor?.variables.optionId === option.id ? sentColor : null;
            const changing = archiving ?? coloring;
            const shownColor = coloring ? coloring.variables.input.color ?? null : option.color;
            if (editing && activeRename) {
              return (
                <li key={option.id} className="px-3 py-2">
                  <form noValidate onSubmit={(event) => rename(event, option)} className="space-y-2">
                    <label htmlFor={ids.rename} className="sr-only">
                      {t('fields.fieldOptionsEditor.optionName')}</label>
                    <TextInput
                      ref={renameRef}
                      id={ids.rename}
                      value={activeRename.name}
                      maxLength={OPTION_NAME_MAX}
                      readOnly={own || busy || updateElsewhere}
                      autoComplete="off"
                      aria-invalid={renameError ? true : undefined}
                      aria-describedby={renameError ? ids.renameError : undefined}
                      onChange={(event) => {
                        setRenaming({ optionId: option.id, name: event.target.value });
                        if (renameError) setRenameError(null);
                      }}
                    />
                    {renameError ? (
                      <p id={ids.renameError} className="text-sm text-red-700">
                        {t(renameError.key, renameError.params)}
                      </p>
                    ) : null}
                    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                      {own ? null : (
                        <Button size="sm" onClick={() => setRenaming(null)}>
                          {t('fields.fieldOptionsEditor.cancel')}</Button>
                      )}
                      <Button
                        size="sm"
                        type="submit"
                        variant="primary"
                        aria-disabled={(own && ownUpdate?.pending) || (!own && busy) || updateElsewhere || undefined}
                      >
                        {own && ownUpdate?.pending ? t('fields.fieldOptionsEditor.saving') : own ? t('fields.fieldOptionsEditor.retrySubmission') : t('fields.fieldOptionsEditor.saveOption')}
                      </Button>
                    </div>
                  </form>
                </li>
              );
            }
            return (
              <li key={option.id} className="flex min-w-0 flex-wrap items-center gap-1.5 px-3 py-1.5">
                <OptionSwatch color={shownColor} />
                <span
                  className={cn('min-w-0 flex-1 truncate text-sm', archived ? 'text-muted' : 'text-ink')}
                  title={option.name}
                >
                  {option.name}
                </span>
                {archived ? <Badge tone="muted">{t('fields.fieldOptionsEditor.archived')}</Badge> : null}
                {changing?.pending ? (
                  <Badge tone="warning">{t('fields.fieldOptionsEditor.saving')}</Badge>
                ) : changing ? (
                  <Button
                    size="sm"
                    onClick={() => updateMutation.retryUncertain({ onSuccess: saved(message('fields.fieldOptionsEditor.optionSaved')) })}
                  >
                    {t('fields.fieldOptionsEditor.retrySubmission')}</Button>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="px-2"
                      aria-label={t('fields.fieldOptionsEditor.renameOptionValue', { p0: option.name })}
                      disabled={busy || updateElsewhere}
                      onClick={() => {
                        setRenameError(null);
                        setRenaming({ optionId: option.id, name: option.name });
                      }}
                    >
                      <Pencil size={14} aria-hidden="true" />
                    </Button>
                    <Button size="sm" variant="ghost" className="px-2" aria-label={t('fields.fieldOptionsEditor.changeColor', { p0: option.name })}
                      aria-expanded={colorOptionId === option.id} disabled={busy || updateElsewhere}
                      onClick={() => setColorOptionId(current => current === option.id ? null : option.id)}>
                      {t('fields.fieldOptionsEditor.color')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="px-2"
                      aria-label={archived ? t('fields.fieldOptionsEditor.restoreOptionValue', { p0: option.name }) : t('fields.fieldOptionsEditor.archiveOptionValue', { p0: option.name })}
                      aria-describedby={ids.hint}
                      disabled={busy || updateElsewhere}
                      onClick={() => setArchived(option, !archived)}
                    >
                      {archived ? (
                        <ArchiveRestore size={14} aria-hidden="true" />
                      ) : (
                        <Archive size={14} aria-hidden="true" />
                      )}
                    </Button>
                  </>
                )}
                {colorOptionId === option.id || coloring ? <div className="basis-full space-y-2 rounded-lg border border-line bg-canvas p-3">
                  <TagColorPalette value={shownColor} disabled={busy || updateElsewhere} onChange={color => setColor(option, color)}/>
                  <Button size="sm" variant="ghost" disabled={busy || updateElsewhere || shownColor === null} onClick={() => setColor(option, null)}>{t('fields.fieldOptionsEditor.noColor')}</Button>
                </div> : null}
              </li>
            );
          })}
        </ul>
      )}

      <form noValidate onSubmit={add} className="space-y-2">
        <label htmlFor={ids.add} className="text-sm text-ink-soft">
          {t('fields.fieldOptionsEditor.newOption')}</label>
        <div className="flex gap-2">
          <TextInput
            ref={addRef}
            id={ids.add}
            value={shownNewName}
            maxLength={OPTION_NAME_MAX}
            readOnly={addFrozen}
            autoComplete="off"
            aria-invalid={addError ? true : undefined}
            aria-describedby={addError ? ids.addError : undefined}
            onChange={(event) => {
              setNewName(event.target.value);
              if (addError) setAddError(null);
            }}
          />
          <Button
            type="submit"
            aria-disabled={(ownCreate?.pending ?? false) || (!ownCreate && busy) || createElsewhere || undefined}
          >
            {ownCreate?.pending ? (
              t('fields.fieldOptionsEditor.saving')
            ) : ownCreate ? (
              t('fields.fieldOptionsEditor.retrySubmission')
            ) : (
              <>
                <Plus size={16} aria-hidden="true" />
                {t('fields.fieldOptionsEditor.addOption')}</>
            )}
          </Button>
        </div>
        {addError ? (
          <p id={ids.addError} className="text-sm text-red-700">
            {t(addError.key, addError.params)}
          </p>
        ) : null}
      </form>

      <SaveFeedback
        error={error}
        uncertainError={uncertainError}
        subject={FIELDS_SAVE_SUBJECT}
        action={correctable ? reloadAction : null}
      />
      {notice ? (
        <p role="status" className="rounded-lg bg-canvas px-3 py-2.5 text-sm leading-relaxed text-ink-soft">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
