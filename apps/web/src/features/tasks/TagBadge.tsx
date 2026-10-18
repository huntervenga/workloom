import type { TagDto } from '@workloom/contracts';
import { cn } from '@workloom/ui';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import { tagColor } from './tagColors';

export interface TagBadgeProps {
  tag: Pick<TagDto, 'id' | 'name' | 'color' | 'archivedAt'>;
  className?: string | undefined;
  children?: ReactNode | undefined;
}
/** Color is an accent, never the text's only contrast or the tag's only identity. */
export function TagBadge({ tag, className, children }: TagBadgeProps) {
  const { t } = useTranslation();
  const color = tagColor(tag);
  const style = { '--tag-color': color } as CSSProperties;
  return <span data-tag-badge={tag.id} data-tag-color={color} className={cn('inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border [border-color:color-mix(in_srgb,var(--tag-color)_65%,var(--color-line))] [background-color:color-mix(in_srgb,var(--tag-color)_12%,var(--color-surface))] px-2 py-0.5 text-xs text-ink', className)} style={style}>
    <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
    <span className="min-w-0 truncate">{tag.name}</span>
    {tag.archivedAt !== null ? <span className="shrink-0 text-muted">{t('tagColors.archived')}</span> : null}
    {children}
  </span>;
}
