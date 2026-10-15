import type { MembershipDto, TaskFieldData, TaskFieldDefinitionDto } from '@workloom/contracts';
import { Button, TextInput, cn, inputClassName } from '@workloom/ui';
import { useId, type ReactNode } from 'react';
import {
  NOT_SET,
  clearedFieldDraft,
  isClearedDraft,
  optionsByPosition,
  referenceLabels,
  referencedIds,
  sameId,
  uniqueIds,
  type FieldDraft,
  type ReferenceLabel,
} from './valueDraft';

export interface FieldInputProps {
  field: TaskFieldDefinitionDto;
  draft: FieldDraft;
  onChange: (draft: FieldDraft) => void;
  members: readonly MembershipDto[];
  disabled?: boolean | undefined;
  error?: string | null | undefined;
  /**
   * The saved value. Archived options and unavailable members it references may stay and, once
   * removed, be put back; they are never offered as a new choice.
   */
  originalValue?: TaskFieldData | null | undefined;
}

interface Choice extends ReferenceLabel {
  assignable: boolean;
}

const labelClassName = 'text-sm font-medium text-ink';
const hintClassName = 'mt-1 text-xs text-muted';
const errorClassName = 'mt-1.5 text-sm text-red-700';

/** Active choices first, then retained archived or unavailable references in draft or saved value. */
function referenceChoices(
  field: TaskFieldDefinitionDto,
  members: readonly MembershipDto[],
  selected: readonly string[],
  original: readonly string[],
): Choice[] {
  const base =
    field.type === 'person'
      ? members.map((member) => member.id)
      : optionsByPosition(field.options)
          .filter((option) => option.archivedAt === null)
          .map((option) => option.id);
  const retained = uniqueIds([...selected, ...original]).filter((id) => !base.some((baseId) => sameId(baseId, id)));
  return referenceLabels(field, [...base, ...retained], members).map((label) => ({
    ...label,
    assignable: label.state === 'active' || original.some((id) => sameId(id, label.id)),
  }));
}

function toggleId(list: readonly string[], id: string, on: boolean): string[] {
  const rest = list.filter((item) => !sameId(item, id));
  return on ? [...rest, id] : rest;
}

/**
 * Editor for one custom field value. Controlled: the parent keeps the draft, validates it with
 * `parseFieldDraft` and saves. Clearing sets an explicit «не задано».
 */
export function FieldInput({
  field,
  draft: givenDraft,
  onChange,
  members,
  disabled = false,
  error = null,
  originalValue = null,
}: FieldInputProps) {
  const id = useId();
  const inputId = `${id}-input`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const draft = givenDraft.type === field.type ? givenDraft : clearedFieldDraft(field);
  const original = referencedIds(field, originalValue);

  let hint: string | null = null;
  let control: ReactNode = null;
  let grouped = false;
  // Read after each case has set its hint.
  const describedBy = () => [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;
  const linkage = () => ({ 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy() });

  switch (draft.type) {
    case 'text':
      control = (
        <textarea
          id={inputId}
          className={inputClassName('h-auto min-h-10 py-2 leading-relaxed')}
          rows={2}
          value={draft.value ?? ''}
          placeholder={NOT_SET}
          disabled={disabled}
          {...linkage()}
          onChange={(event) => onChange({ type: 'text', value: event.target.value })}
        />
      );
      break;
    case 'number':
    case 'duration':
    case 'date':
    case 'url': {
      const kind = draft.type;
      if (kind === 'duration') hint = 'Например: 1,5 или 1:30. Пустое поле — не задано, 0 — ноль.';
      control = (
        <TextInput
          id={inputId}
          type={kind === 'date' ? 'date' : kind === 'url' ? 'url' : 'text'}
          inputMode={kind === 'number' || kind === 'duration' ? 'decimal' : kind === 'url' ? 'url' : undefined}
          autoComplete="off"
          placeholder={kind === 'url' ? 'https://…' : NOT_SET}
          value={draft.text}
          disabled={disabled}
          {...linkage()}
          onChange={(event) => onChange({ type: kind, text: event.target.value })}
        />
      );
      break;
    }
    case 'boolean':
      control = (
        <select
          id={inputId}
          className={inputClassName('pr-8')}
          value={draft.value === null ? '' : String(draft.value)}
          disabled={disabled}
          {...linkage()}
          onChange={(event) =>
            onChange({ type: 'boolean', value: event.target.value === '' ? null : event.target.value === 'true' })
          }
        >
          <option value="">{NOT_SET}</option>
          <option value="true">Да</option>
          <option value="false">Нет</option>
        </select>
      );
      break;
    case 'single_select': {
      const current = draft.value;
      const choices = referenceChoices(field, members, current === null ? [] : [current], original);
      if (choices.some((choice) => choice.state !== 'active')) {
        hint = 'Вариант из архива или недоступный остаётся, пока вы его не смените; выбрать его заново для другой задачи нельзя.';
      }
      control = (
        <select
          id={inputId}
          className={inputClassName('pr-8')}
          value={current ?? ''}
          disabled={disabled}
          {...linkage()}
          onChange={(event) => onChange({ type: 'single_select', value: event.target.value === '' ? null : event.target.value })}
        >
          <option value="">{NOT_SET}</option>
          {choices.map((choice) => (
            <option
              key={choice.id}
              value={choice.id}
              disabled={!choice.assignable && !(current !== null && sameId(current, choice.id))}
            >
              {choice.label}
            </option>
          ))}
        </select>
      );
      break;
    }
    case 'multi_select':
    case 'person': {
      grouped = true;
      const kind = draft.type;
      const selected = draft.value ?? [];
      const choices = referenceChoices(field, members, selected, original);
      if (choices.some((choice) => choice.state !== 'active')) {
        hint =
          kind === 'person'
            ? 'Недоступный участник остаётся в значении, пока вы не снимете отметку; заново его выбрать нельзя.'
            : 'Варианты из архива и недоступные остаются, пока вы не снимете отметку; заново их выбрать нельзя.';
      }
      control =
        choices.length === 0 ? (
          <p className="text-sm text-muted">{kind === 'person' ? 'В пространстве нет участников.' : 'Вариантов пока нет.'}</p>
        ) : (
          <ul className="grid gap-1 sm:grid-cols-2">
            {choices.map((choice) => {
              const checked = selected.some((item) => sameId(item, choice.id));
              return (
                <li key={choice.id}>
                  <label
                    className={cn(
                      'flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-sm',
                      choice.state === 'active' ? 'text-ink-soft' : 'text-muted',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="size-4 shrink-0 accent-accent"
                      checked={checked}
                      // Retained references may only be removed or put back, never newly added.
                      disabled={disabled || (!checked && !choice.assignable)}
                      onChange={(event) => onChange({ type: kind, value: toggleId(selected, choice.id, event.target.checked) })}
                    />
                    <span className="truncate">{choice.label}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        );
      break;
    }
  }

  const label = draft.type === 'duration' ? `${field.name}, часы` : field.name;
  const clearable = draft.type !== 'boolean' && draft.type !== 'single_select';
  const clearButton = clearable ? (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`Очистить: ${label}`}
      disabled={disabled || isClearedDraft(draft)}
      onClick={() => onChange(clearedFieldDraft(field))}
    >
      Очистить
    </Button>
  ) : null;
  const footer = (
    <>
      {hint ? (
        <p id={hintId} className={hintClassName}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className={errorClassName}>
          {error}
        </p>
      ) : null}
    </>
  );

  if (grouped) {
    return (
      <fieldset className="min-w-0" aria-describedby={describedBy()}>
        <legend className={cn(labelClassName, 'max-w-full truncate')}>{label}</legend>
        <div className="mt-1">{control}</div>
        {clearButton ? <div className="mt-1">{clearButton}</div> : null}
        {footer}
      </fieldset>
    );
  }

  return (
    <div className="min-w-0">
      <label htmlFor={inputId} className={cn(labelClassName, 'block truncate')}>
        {label}
      </label>
      <div className="mt-1.5 flex min-w-0 items-start gap-1.5">
        <div className="min-w-0 flex-1">{control}</div>
        {clearButton ? <div className="shrink-0 pt-1">{clearButton}</div> : null}
      </div>
      {footer}
    </div>
  );
}
