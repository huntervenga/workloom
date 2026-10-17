import type { TagDto } from '@workloom/contracts';
import { cn } from '@workloom/ui';
import { Check } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from '../../i18n';

export interface TaskTagPickerProps {
  tags: readonly TagDto[];
  values: readonly string[];
  onChange: (values: string[]) => void;
  disabled?: boolean | undefined;
  autoFocus?: boolean | undefined;
}

/** Existing workspace tags, including retained unavailable values; edits remain local until Save. */
export function TaskTagPicker({ tags, values, onChange, disabled = false, autoFocus = false }: TaskTagPickerProps) {
  const { t, locale } = useTranslation();
  const [search, setSearch] = useState('');
  const id = useId();
  const selected = new Set(values.map(value => value.toLowerCase()));
  const byId = new Map(tags.map(tag => [tag.id.toLowerCase(), tag]));
  const options = [...tags.filter(tag => tag.archivedAt === null || selected.has(tag.id.toLowerCase()))]
    .sort((a, b) => a.name.localeCompare(b.name, locale));
  const missing = values.filter(value => !byId.has(value.toLowerCase()));
  const needle = search.trim().toLocaleLowerCase(locale);
  const visible = options.filter(tag => tag.name.toLocaleLowerCase(locale).includes(needle));
  const toggle = (value: string, checked: boolean) => onChange(checked
    ? [...values.filter(kept => kept.toLowerCase() !== value.toLowerCase()), value]
    : values.filter(kept => kept.toLowerCase() !== value.toLowerCase()));
  return <div className="min-w-0 space-y-2">
    <label htmlFor={`${id}-search`} className="sr-only">{t('tasks.tags.search')}</label>
    <input id={`${id}-search`} type="search" value={search} disabled={disabled} autoFocus={autoFocus}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); } }}
      onChange={event => setSearch(event.target.value)} className="h-8 w-full min-w-0 rounded border border-line px-2 text-sm outline-none focus:ring-2 focus:ring-accent-soft" />
    <fieldset className="max-h-56 min-w-48 space-y-1 overflow-y-auto" disabled={disabled}>
      <legend className="sr-only">{t('tasks.taskFields.tags')}</legend>
      {visible.map(tag => <label key={tag.id} className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-canvas">
        <input type="checkbox" className="peer sr-only" checked={selected.has(tag.id.toLowerCase())} onChange={event => toggle(tag.id, event.target.checked)} />
        <span aria-hidden="true" className={cn('inline-flex size-4 shrink-0 items-center justify-center rounded border border-line-strong peer-focus-visible:ring-2 peer-focus-visible:ring-accent', selected.has(tag.id.toLowerCase()) && 'border-accent bg-accent text-white')}>
          {selected.has(tag.id.toLowerCase()) ? <Check size={12} /> : null}
        </span>
        <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-line bg-canvas px-2 py-0.5 text-xs">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-subtle" style={tag.color ? { backgroundColor: tag.color } : undefined} />
          <span className="min-w-0 break-words">{tag.archivedAt === null ? tag.name : t('tasks.taskFields.valueArchived', { p0: tag.name })}</span>
        </span>
      </label>)}
      {missing.map(value => <label key={value} className="flex min-h-8 items-center gap-2 text-sm text-muted">
        <input type="checkbox" checked onChange={() => toggle(value, false)} /><span>{t('tasks.taskFields.tagUnavailable')}</span>
      </label>)}
      {visible.length === 0 && missing.length === 0 ? <p className="text-xs text-muted">{options.length === 0 ? t('tasks.taskFields.noTagsYet') : t('tasks.tags.noMatches')}</p> : null}
    </fieldset>
  </div>;
}
