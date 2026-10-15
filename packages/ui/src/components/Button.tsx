import type { ComponentPropsWithRef } from 'react';
import { cn } from '../cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md';

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white shadow-xs hover:bg-accent-strong',
  secondary: 'border border-line bg-surface text-ink shadow-xs hover:border-line-strong hover:bg-canvas',
  ghost: 'text-ink-soft hover:bg-slate-100 hover:text-ink',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 px-2.5 text-[13px]',
  md: 'h-9 gap-2 px-3.5 text-sm',
};

export interface ButtonStyleOptions {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  className?: string | undefined;
}

/** Shared button look, also usable on router links. */
export function buttonClassName({ variant = 'secondary', size = 'md', className }: ButtonStyleOptions = {}): string {
  return cn(
    'inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors',
    'disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-progress aria-disabled:opacity-70',
    variantClasses[variant],
    sizeClasses[size],
    className,
  );
}

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
}

export function Button({ variant, size, className, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={buttonClassName({ variant, size, className })} {...props} />;
}
