import { message, type TranslationMessage } from '../../i18n';
import { t, useTranslation } from '../../i18n';
import {
  createTaskFieldInputSchema,
  createTaskFieldOptionInputSchema,
  taskFieldTypeSchema,
  type TaskFieldType,
} from '@workloom/contracts';
import { Button, TextInput, inputClassName } from '@workloom/ui';
import { Plus, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { ErrorSubject } from '../../lib/errors';

/** Same limits as the field and option names in @workloom/contracts, which remain the authority. */
export const FIELD_NAME_MAX = 160;
export const OPTION_NAME_MAX = 100;
const INITIAL_OPTIONS_MAX = 100;

export const FIELDS_LOAD_SUBJECT: ErrorSubject = 'fields';
export const FIELDS_SAVE_SUBJECT: ErrorSubject = 'fieldSave';

export const fieldTypeLabels: Record<TaskFieldType, string> = {
  get text() { return t('fields.fieldDefinitionForm.text'); },
  get number() { return t('fields.fieldDefinitionForm.number'); },
  get duration() { return t('fields.fieldDefinitionForm.duration'); },
  get date() { return t('fields.fieldDefinitionForm.date'); },
  get single_select() { return t('fields.fieldDefinitionForm.singleSelect'); },
  get multi_select() { return t('fields.fieldDefinitionForm.multiSelect'); },
  get person() { return t('fields.fieldDefinitionForm.people'); },
  get boolean() { return t('fields.fieldDefinitionForm.boolean'); },
  get url() { return t('fields.fieldDefinitionForm.link'); },
};

export function isSelectType(type: TaskFieldType): boolean {
  return type === 'single_select' || type === 'multi_select';
}

export function fieldNameProblem(name: string): TranslationMessage | null {
  if (createTaskFieldInputSchema.shape.name.safeParse(name).success) return null;
  if (name.trim() === '') return message('fields.fieldDefinitionForm.enterAColumnName');
  return message('fields.fieldDefinitionForm.nameMustBeValueCharactersOrFewer', { p0: FIELD_NAME_MAX });
}

export function optionNameProblem(name: string): TranslationMessage | null {
  if (createTaskFieldOptionInputSchema.shape.name.safeParse(name).success) return null;
  if (name.trim() === '') return message('fields.fieldDefinitionForm.enterAnOptionName');
  return message('fields.fieldDefinitionForm.optionNameMustBeValueCharactersOrFewer', { p0: OPTION_NAME_MAX });
}

interface TrackedCommand<TVariables> {
  pendingCommand: { variables: TVariables } | null;
  uncertain: { variables: TVariables } | null;
}

/**
 * The command a shared mutation hook carries: the one in flight first, then an unconfirmed one.
 * Taken from the hook, not from `variables`, which `reset()` clears.
 */
export function sentCommand<TVariables>(mutation: TrackedCommand<TVariables>): { variables: TVariables; pending: boolean } | null {
  if (mutation.pendingCommand) return { variables: mutation.pendingCommand.variables, pending: true };
  if (mutation.uncertain) return { variables: mutation.uncertain.variables, pending: false };
  return null;
}

export interface FieldFormValue {
  name: string;
  type: TaskFieldType;
  historyEnabled: boolean;
  locked: boolean;
  /** Initial option names of a new select field; the server assigns their IDs. */
  options: string[];
}

export interface FieldDefinitionFormProps {
  /** An existing field shows its type read-only: the type never changes after creation. */
  mode: 'create' | 'edit';
  initial: FieldFormValue;
  submitLabel: string;
  pending: boolean;
  /** The sent command's outcome is unknown: fields are locked and submitting resends it. */
  uncertain: boolean;
  /**
   * The full visible value of this form's command while it is pending or uncertain, as sent.
   * It is shown read-only instead of the draft, also after the form is remounted.
   */
  sent?: FieldFormValue | null | undefined;
  /** Another command must finish first: fields are read-only and nothing is sent. */
  blocked?: boolean | undefined;
  /** False while another write keeps this form on screen until it is answered. */
  cancelable?: boolean | undefined;
  onRetry: () => void;
  feedback: ReactNode;
  notice?: string | null | undefined;
  onSubmit: (value: FieldFormValue) => void;
  onCancel: () => void;
}

const labelClassName = 'text-sm font-medium text-ink';
const hintClassName = 'mt-1.5 text-xs leading-relaxed text-subtle';
const errorClassName = 'mt-1.5 text-sm text-red-700';

/** Name, type, history and lock of a custom column; a confirmed error keeps the values in the fields. */
export function FieldDefinitionForm({
  mode,
  initial,
  submitLabel,
  pending,
  uncertain,
  sent = null,
  blocked = false,
  cancelable = true,
  onRetry,
  feedback,
  notice,
  onSubmit,
  onCancel,
}: FieldDefinitionFormProps) {
  const { t } = useTranslation();
  const start = sent ?? initial;
  const [name, setName] = useState(start.name);
  const [type, setType] = useState<TaskFieldType>(start.type);
  const [historyEnabled, setHistoryEnabled] = useState(start.historyEnabled);
  const [locked, setLocked] = useState(start.locked);
  const [options, setOptions] = useState<string[]>(start.options);
  const [newOption, setNewOption] = useState('');
  const [nameError, setNameError] = useState<TranslationMessage | null>(null);
  const [optionError, setOptionError] = useState<TranslationMessage | null>(null);
  const frozen = pending || uncertain || blocked || sent !== null;
  const shown: FieldFormValue = sent ?? { name, type, historyEnabled, locked, options };
  const nameRef = useRef<HTMLInputElement>(null);
  const optionRef = useRef<HTMLInputElement>(null);
  const ids = {
    name: useId(),
    nameHint: useId(),
    nameError: useId(),
    type: useId(),
    typeHint: useId(),
    history: useId(),
    historyHint: useId(),
    lock: useId(),
    lockHint: useId(),
    option: useId(),
    optionHint: useId(),
    optionError: useId(),
  };
  const showOptions = mode === 'create' && isSelectType(shown.type);

  // A notice replaces the control that was used (e.g. the reload button), so focus moves to the name.
  useEffect(() => {
    if (notice) nameRef.current?.focus();
  }, [notice]);

  const addOption = () => {
    if (frozen) return;
    const trimmed = newOption.trim();
    const problem =
      optionNameProblem(trimmed) ??
      (options.length >= INITIAL_OPTIONS_MAX ? message('fields.fieldDefinitionForm.useUpToValueOptions', { p0: INITIAL_OPTIONS_MAX }) : null);
    setOptionError(problem);
    if (problem) {
      optionRef.current?.focus();
      return;
    }
    setOptions([...options, trimmed]);
    setNewOption('');
    optionRef.current?.focus();
  };

  const onOptionKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    // Enter adds the option instead of submitting the whole column.
    event.preventDefault();
    addOption();
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Rendered in a portal: keep the submit from reaching an enclosing form.
    event.stopPropagation();
    if (pending || blocked) return;
    if (uncertain) {
      onRetry();
      return;
    }
    const value: FieldFormValue = {
      name: name.trim(),
      type,
      historyEnabled,
      locked,
      options: mode === 'create' && isSelectType(type) ? options : [],
    };
    const problem = fieldNameProblem(value.name);
    setNameError(problem);
    if (problem) {
      nameRef.current?.focus();
      return;
    }
    if (showOptions && newOption.trim() !== '') {
      setOptionError(message('fields.fieldDefinitionForm.useAddOptionToKeepThisOptionOr'));
      optionRef.current?.focus();
      return;
    }
    // The draft becomes what is sent, so a confirmed error leaves the sent values in the fields.
    setName(value.name);
    onSubmit(value);
  };

  return (
    <form noValidate onSubmit={submit} className="space-y-4">
      <div>
        <label htmlFor={ids.name} className={labelClassName}>
          {t('fields.fieldDefinitionForm.columnName')}</label>
        <TextInput
          ref={nameRef}
          id={ids.name}
          className="mt-1.5"
          value={shown.name}
          maxLength={FIELD_NAME_MAX}
          readOnly={frozen}
          autoComplete="off"
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? `${ids.nameError} ${ids.nameHint}` : ids.nameHint}
          onChange={(event) => {
            setName(event.target.value);
            if (nameError) setNameError(null);
          }}
        />
        {nameError ? (
          <p id={ids.nameError} className={errorClassName}>
            {t(nameError.key, nameError.params)}
          </p>
        ) : null}
        <p id={ids.nameHint} className={hintClassName}>
          {t('fields.fieldDefinitionForm.characterLimit', { count: FIELD_NAME_MAX })}</p>
      </div>

      <div>
        <label htmlFor={ids.type} className={labelClassName}>
          {t('fields.fieldDefinitionForm.fieldType')}</label>
        {mode === 'create' ? (
          <select
            id={ids.type}
            className={inputClassName('mt-1.5 pr-8')}
            value={shown.type}
            disabled={frozen}
            aria-describedby={ids.typeHint}
            onChange={(event) => setType(taskFieldTypeSchema.parse(event.target.value))}
          >
            {taskFieldTypeSchema.options.map((option) => (
              <option key={option} value={option}>
                {fieldTypeLabels[option]}
              </option>
            ))}
          </select>
        ) : (
          <TextInput
            id={ids.type}
            className="mt-1.5"
            value={fieldTypeLabels[shown.type]}
            readOnly
            aria-describedby={ids.typeHint}
          />
        )}
        <p id={ids.typeHint} className={hintClassName}>
          {mode === 'create'
            ? t('fields.fieldDefinitionForm.typeCannotChangeAfterCreation')
            : t('fields.fieldDefinitionForm.typeIsFixedBecauseValuesAndHistoryUse')}
        </p>
      </div>

      {showOptions ? (
        <fieldset className="space-y-2">
          <legend className={labelClassName}>{t('fields.fieldDefinitionForm.options')}</legend>
          {shown.options.length > 0 ? (
            <ul aria-label={t('fields.fieldDefinitionForm.newColumnOptions')} className="divide-y divide-line rounded-lg border border-line">
              {shown.options.map((option, index) => (
                <li key={`${index}:${option}`} className="flex min-w-0 items-center gap-2 px-3 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-sm text-ink" title={option}>
                    {option}
                  </span>
                  {frozen ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="px-2"
                      aria-label={t('fields.fieldDefinitionForm.removeOptionValue', { p0: option })}
                      onClick={() => setOptions(options.filter((_, at) => at !== index))}
                    >
                      <X size={14} aria-hidden="true" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {frozen ? null : (
            <>
              <label htmlFor={ids.option} className="sr-only">
                {t('fields.fieldDefinitionForm.newOption')}</label>
              <div className="flex gap-2">
                <TextInput
                  ref={optionRef}
                  id={ids.option}
                  value={newOption}
                  maxLength={OPTION_NAME_MAX}
                  placeholder={t('fields.fieldDefinitionForm.newOption')}
                  autoComplete="off"
                  aria-invalid={optionError ? true : undefined}
                  aria-describedby={optionError ? `${ids.optionError} ${ids.optionHint}` : ids.optionHint}
                  onKeyDown={onOptionKeyDown}
                  onChange={(event) => {
                    setNewOption(event.target.value);
                    if (optionError) setOptionError(null);
                  }}
                />
                <Button onClick={addOption}>
                  <Plus size={16} aria-hidden="true" />
                  {t('fields.fieldDefinitionForm.addOption')}</Button>
              </div>
            </>
          )}
          {optionError ? (
            <p id={ids.optionError} className={errorClassName}>
              {t(optionError.key, optionError.params)}
            </p>
          ) : null}
          <p id={ids.optionHint} className={hintClassName}>
            {t('fields.fieldDefinitionForm.youCanAddOptionsLaterRenamingAnOption')}</p>
        </fieldset>
      ) : null}

      <div>
        <label className="inline-flex items-center gap-2 text-sm font-medium text-ink">
          <input
            id={ids.history}
            type="checkbox"
            className="size-4 accent-accent"
            checked={shown.historyEnabled}
            disabled={frozen}
            aria-describedby={ids.historyHint}
            onChange={(event) => setHistoryEnabled(event.target.checked)}
          />
          {t('fields.fieldDefinitionForm.recordHistory')}</label>
        <p id={ids.historyHint} className={hintClassName}>
          {t('fields.fieldDefinitionForm.recordsFutureChangesWhileEnabledDisablingPreservesExisting')}</p>
      </div>

      <div>
        <label className="inline-flex items-center gap-2 text-sm font-medium text-ink">
          <input
            id={ids.lock}
            type="checkbox"
            className="size-4 accent-accent"
            checked={shown.locked}
            disabled={frozen}
            aria-describedby={ids.lockHint}
            onChange={(event) => setLocked(event.target.checked)}
          />
          {t('fields.fieldDefinitionForm.lockValues')}</label>
        <p id={ids.lockHint} className={hintClassName}>
          {t('fields.fieldDefinitionForm.preventsChangesToThisColumnSValuesIn')}</p>
      </div>

      {feedback}
      {notice ? (
        <p role="status" className="rounded-lg bg-canvas px-3 py-2.5 text-sm leading-relaxed text-ink-soft">
          {notice}
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {/* A pending or unconfirmed command stays on screen until it is answered or resent. */}
        {pending || uncertain || !cancelable ? null : <Button onClick={onCancel}>{t('fields.fieldDefinitionForm.cancel')}</Button>}
        <Button type="submit" variant="primary" aria-disabled={pending || blocked || undefined}>
          {pending ? t('fields.fieldDefinitionForm.saving') : uncertain ? t('fields.fieldDefinitionForm.retrySubmission') : submitLabel}
        </Button>
      </div>
    </form>
  );
}
