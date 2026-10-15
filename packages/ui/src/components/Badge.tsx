import type { ComponentPropsWithRef } from 'react';
import { cn } from '../cn';

export type BadgeTone = 'neutral' | 'muted' | 'accent' | 'warning';

const toneClasses: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-ink-soft ring-slate-200',
  muted: 'bg-canvas text-muted ring-line',
  accent: 'bg-accent-soft text-accent-ink ring-accent-line',
  warning: 'bg-amber-50 text-amber-800 ring-amber-200',
};

export interface BadgeProps extends ComponentPropsWithRef<'span'> {
  tone?: BadgeTone | undefined;
}

export function Badge({ tone = 'neutral', className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset',
        toneClasses[tone],
        className,
      )}
      {...props}
    />
  );
}
