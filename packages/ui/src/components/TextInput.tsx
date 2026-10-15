import type { ComponentPropsWithRef } from 'react';
import { cn } from '../cn';

/** Shared text field look; invalid state follows `aria-invalid`. */
export function inputClassName(className?: string): string {
  return cn(
    'block h-10 w-full min-w-0 rounded-lg border border-line bg-surface px-3 text-sm text-ink shadow-xs outline-none transition-colors',
    'placeholder:text-subtle hover:border-line-strong focus:border-accent-line focus:ring-4 focus:ring-accent-soft',
    'aria-[invalid=true]:border-red-300 aria-[invalid=true]:focus:ring-red-100',
    className,
  );
}

export type TextInputProps = ComponentPropsWithRef<'input'>;

export function TextInput({ className, type = 'text', ...props }: TextInputProps) {
  return <input type={type} className={inputClassName(className)} {...props} />;
}
