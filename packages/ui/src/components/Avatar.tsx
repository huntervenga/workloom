import { cn } from '../cn';

const tones = [
  'bg-indigo-100 text-indigo-700',
  'bg-sky-100 text-sky-700',
  'bg-emerald-100 text-emerald-700',
  'bg-amber-100 text-amber-800',
  'bg-rose-100 text-rose-700',
  'bg-violet-100 text-violet-700',
  'bg-teal-100 text-teal-700',
] as const;

const sizeClasses = {
  sm: 'size-6 text-[10px]',
  md: 'size-8 text-xs',
  lg: 'size-10 text-sm',
} as const;

export function getInitials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const first = Array.from(words.at(0) ?? '').at(0) ?? '';
  const last = words.length > 1 ? (Array.from(words.at(-1) ?? '').at(0) ?? '') : '';
  const initials = `${first}${last}`.toLocaleUpperCase('ru-RU');
  return initials === '' ? '?' : initials;
}

/** Stable palette slot for a seed such as an entity ID. */
export function avatarToneIndex(seed: string): number {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  }
  return hash % tones.length;
}

export interface AvatarProps {
  name: string;
  seed?: string | undefined;
  size?: keyof typeof sizeClasses | undefined;
  shape?: 'circle' | 'square' | undefined;
  className?: string | undefined;
}

/** Decorative initials; always render the name as text next to it. */
export function Avatar({ name, seed, size = 'md', shape = 'circle', className }: AvatarProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-semibold select-none',
        shape === 'circle' ? 'rounded-full' : 'rounded-lg',
        sizeClasses[size],
        tones[avatarToneIndex(seed ?? name)],
        className,
      )}
    >
      {getInitials(name)}
    </span>
  );
}
