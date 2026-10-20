import { Check, Minus, X } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { cn } from '@workloom/ui';
import { useTranslation } from '../../i18n';

export interface BooleanFieldControlProps {
  value: boolean | null;
  label: string;
  fieldName: string;
  disabled?: boolean | undefined;
  id?: string | undefined;
  describedBy?: string | undefined;
  invalid?: boolean | undefined;
  onBegin?: (() => void) | undefined;
  onCancel?: (() => void) | undefined;
  onChange: (value: boolean | null) => void;
}

/** A real checkbox: mixed means not set; unchecked is an explicit false. Clear never means false. */
export function BooleanFieldControl({ value, label, fieldName, disabled = false, id, describedBy, invalid, onBegin, onCancel, onChange }: BooleanFieldControlProps) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { if (input.current) input.current.indeterminate = value === null; });
  const status = value === null ? t('fields.booleanControl.notSet') : value ? t('fields.booleanControl.checked') : t('fields.booleanControl.unchecked');
  return <span className="flex h-8 w-full min-w-0 flex-1 items-center gap-1.5 px-1.5" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) onCancel?.(); }}>
    <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
      <input ref={input} id={id} type="checkbox" data-project-undo="true" checked={value === true}
        aria-label={label} aria-describedby={describedBy} aria-invalid={invalid || undefined} title={status} disabled={disabled}
        className={cn('size-4 cursor-pointer appearance-none rounded border outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-60', value === true ? 'border-accent bg-accent' : value === null ? 'border-dashed border-muted bg-transparent' : 'border-muted bg-surface')}
        onFocus={onBegin} onChange={event => { if (!disabled) onChange(event.currentTarget.checked); }} onKeyDown={event => {
          if (event.key === 'Escape') onCancel?.();
          // Space retains native checkbox behavior; Enter must not submit an enclosing task form.
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); }
        }}/>
      {value === true ? <Check size={12} aria-hidden="true" className="pointer-events-none absolute text-white"/> : value === null ? <Minus size={10} aria-hidden="true" className="pointer-events-none absolute text-muted"/> : null}
    </span>
    {value === null ? <span className="truncate text-xs text-muted">{status}</span> : null}
    <button type="button" disabled={disabled || value === null} aria-label={t('fields.fieldInput.clearValue', { p0: fieldName })}
      title={t('fields.booleanControl.clearHint')} className="ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded text-muted outline-none hover:bg-canvas hover:text-ink focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-30"
      onMouseDown={event => { if (event.button === 0) event.preventDefault(); }} onClick={() => { if (!disabled && value !== null) onChange(null); }}><X size={12} aria-hidden="true"/></button>
  </span>;
}
