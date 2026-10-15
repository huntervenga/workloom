import type { ReactNode } from 'react';
import { cn } from '../cn';

export type StateTone = 'neutral' | 'error';

const iconToneClasses: Record<StateTone, string> = {
  neutral: 'bg-slate-100 text-muted ring-line',
  error: 'bg-red-50 text-red-600 ring-red-100',
};

export interface StateCardProps {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  footnote?: ReactNode;
  tone?: StateTone | undefined;
  headingLevel?: 1 | 2 | 3 | undefined;
  role?: 'alert' | 'status' | undefined;
  className?: string | undefined;
}

/** Empty, error and unavailable states with an optional recovery action. */
export function StateCard({
  title,
  description,
  icon,
  actions,
  footnote,
  tone = 'neutral',
  headingLevel = 2,
  role,
  className,
}: StateCardProps) {
  const Heading = headingLevel === 1 ? 'h1' : headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div
      role={role}
      className={cn(
        'flex flex-col items-center rounded-2xl border border-line bg-surface px-6 py-10 text-center',
        className,
      )}
    >
      {icon ? (
        <span className={cn('mb-4 inline-flex size-10 items-center justify-center rounded-full ring-1', iconToneClasses[tone])}>
          {icon}
        </span>
      ) : null}
      <Heading className="text-base font-semibold text-balance text-ink">{title}</Heading>
      {description ? <div className="mt-1.5 max-w-md text-sm leading-relaxed text-pretty text-muted">{description}</div> : null}
      {actions ? <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{actions}</div> : null}
      {footnote ? <div className="mt-4 text-xs text-subtle">{footnote}</div> : null}
    </div>
  );
}
