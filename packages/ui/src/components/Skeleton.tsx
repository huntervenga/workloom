import { cn } from '../cn';

export function Skeleton({ className }: { className?: string | undefined }) {
  return <div aria-hidden="true" className={cn('rounded-md bg-slate-200/70 motion-safe:animate-pulse', className)} />;
}
