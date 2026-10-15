import * as Dialog from '@radix-ui/react-dialog';
import { Button, TextInput } from '@workloom/ui';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';

export interface NameFormProps {
  label: string;
  initialName: string;
  maxLength: number;
  /** Field problem in user copy, or null when the shared schema accepts the name. */
  validate: (name: string) => string | null;
  submitLabel: string;
  pending: boolean;
  /**
   * A sent command has an unknown outcome: the field is read-only and submitting resends it
   * unchanged through `onRetry`.
   */
  locked?: boolean | undefined;
  /**
   * The name of this form's command while it is pending or uncertain, exactly as sent. It is shown
   * read-only instead of the draft, also after the form is remounted.
   */
  sentName?: string | null | undefined;
  /** The shared command is busy with another target: the field is read-only and nothing is sent. */
  blocked?: boolean | undefined;
  onRetry?: (() => void) | undefined;
  /** Save errors, see `SaveFeedback`. */
  feedback?: ReactNode;
  notice?: string | null | undefined;
  onSubmit: (name: string) => void;
}

/** The typed name survives every server error; only a confirmed save closes the dialog. */
export function NameForm({
  label,
  initialName,
  maxLength,
  validate,
  submitLabel,
  pending,
  locked = false,
  sentName = null,
  blocked = false,
  onRetry,
  feedback,
  notice,
  onSubmit,
}: NameFormProps) {
  const [name, setName] = useState(sentName ?? initialName);
  const frozen = pending || locked || blocked || sentName !== null;
  const [fieldError, setFieldError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();

  // A notice replaces the control that was used (e.g. the reload button), so focus moves to the field.
  useEffect(() => {
    if (notice) inputRef.current?.focus();
  }, [notice]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || blocked) return;
    if (locked) {
      onRetry?.();
      return;
    }
    const problem = validate(name);
    setFieldError(problem);
    if (problem) {
      inputRef.current?.focus();
      return;
    }
    // The draft becomes what is sent, so a confirmed error leaves the sent name in the field.
    const trimmed = name.trim();
    setName(trimmed);
    onSubmit(trimmed);
  };

  return (
    <form noValidate onSubmit={submit} className="mt-5 space-y-4">
      <div>
        <label htmlFor={inputId} className="text-sm font-medium text-ink">
          {label}
        </label>
        <TextInput
          ref={inputRef}
          id={inputId}
          className="mt-1.5"
          value={sentName ?? name}
          maxLength={maxLength}
          readOnly={frozen}
          autoComplete="off"
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? `${errorId} ${hintId}` : hintId}
          onChange={(event) => {
            setName(event.target.value);
            if (fieldError) setFieldError(null);
          }}
        />
        {fieldError ? (
          <p id={errorId} className="mt-1.5 text-sm text-red-700">
            {fieldError}
          </p>
        ) : null}
        <p id={hintId} className="mt-1.5 text-xs text-subtle">
          До {maxLength} символов.
        </p>
      </div>

      {feedback}
      {notice ? (
        <p role="status" className="rounded-lg bg-canvas px-3 py-2.5 text-sm leading-relaxed text-ink-soft">
          {notice}
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
        <Dialog.Close asChild>
          <Button>{locked ? 'Скрыть' : 'Отмена'}</Button>
        </Dialog.Close>
        <Button type="submit" variant="primary" aria-disabled={pending || blocked || undefined}>
          {pending ? 'Сохраняем…' : locked ? 'Повторить отправку' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
