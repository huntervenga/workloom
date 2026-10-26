import type { TagDto } from '@workloom/contracts';
import { TagBadge } from './TagBadge';
import { cn } from '@workloom/ui';
import { Check, Plus } from 'lucide-react';
import { useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import { SaveFeedback } from '../../shared/SaveFeedback';
import type { InlineTagCreateBinding, InlineTagStartResult } from './inlineTagCreate';

export interface TaskTagPickerProps {
  tags: readonly TagDto[];
  values: readonly string[];
  onChange: (values: string[]) => void;
  disabled?: boolean | undefined;
  autoFocus?: boolean | undefined;
  /** Inline creation of a workspace tag; a confirmed tag is only selected in this draft. */
  creation?: InlineTagCreateBinding | undefined;
  /** Escape in the search closes this picker only, before an enclosing row or editor sees it. */
  onRequestClose?: (() => void) | undefined;
  /** The existing way to manage tags in details, offered by the caller. */
  manageAction?: ReactNode | undefined;
}

const problemKeys = {
  tooLong: 'tasks.tags.createTooLong',
  exists: 'tasks.tags.createExists',
  archived: 'tasks.tags.createArchived',
  denied: 'tasks.tags.createDenied',
  readonly: 'tasks.tags.createReadOnly',
  busy: 'tasks.tags.createBusy',
} as const satisfies Partial<Record<InlineTagStartResult, string>>;
type TagCreateProblem = keyof typeof problemKeys;
const isProblem = (result: InlineTagStartResult): result is TagCreateProblem => Object.hasOwn(problemKeys, result);

const actionClassName = 'rounded px-1 py-1 text-xs font-medium text-accent-ink hover:bg-canvas aria-disabled:text-muted';

/** Existing workspace tags, including retained unavailable values; edits remain local until Save. */
export function TaskTagPicker({ tags, values, onChange, disabled = false, autoFocus = false, creation, onRequestClose, manageAction }: TaskTagPickerProps) {
  const { t, locale } = useTranslation();
  const [localSearch, setLocalSearch] = useState('');
  const [problem, setProblem] = useState<TagCreateProblem | null>(null);
  const search = creation ? creation.search : localSearch;
  const setSearch = creation ? creation.setSearch : setLocalSearch;
  const id = useId();
  const selected = new Set(values.map(value => value.toLowerCase()));
  const byId = new Map(tags.map(tag => [tag.id.toLowerCase(), tag]));
  const options = [...tags.filter(tag => tag.archivedAt === null || selected.has(tag.id.toLowerCase()))]
    .sort((a, b) => Number(selected.has(b.id.toLowerCase())) - Number(selected.has(a.id.toLowerCase()))
      || a.name.localeCompare(b.name, locale));
  const missing = values.filter(value => !byId.has(value.toLowerCase()));
  const needle = search.trim().toLocaleLowerCase(locale);
  const visible = options.filter(tag => tag.name.toLocaleLowerCase(locale).includes(needle));
  const toggle = (value: string, checked: boolean) => onChange(checked
    ? [...values.filter(kept => kept.toLowerCase() !== value.toLowerCase()), value]
    : values.filter(kept => kept.toLowerCase() !== value.toLowerCase()));
  // Same comparison as the server's unique name: trimmed, lower-cased, archived tags included.
  const typed = search.trim();
  const namesake = typed === '' ? undefined : tags.find(tag => tag.name.trim().toLowerCase() === typed.toLowerCase());
  const offerCreate = creation !== undefined && creation.canCreate && typed !== '' && namesake === undefined;
  const createHint = creation !== undefined && !creation.canCreate && typed !== '' && namesake === undefined;
  const createBlocked = disabled || creation === undefined || !creation.canAttach || creation.busy || creation.held;
  const searchRef = useRef<HTMLInputElement>(null);
  // The pressed button disappears once the tag is confirmed; focus waits in the search instead of
  // falling to the page, where leaving the enclosing editor would save it.
  const keepFocus = () => { searchRef.current?.focus({ preventScroll: true }); };
  const startCreate = () => {
    if (!creation || !offerCreate) return;
    keepFocus();
    if (createBlocked) { setProblem(creation.held ? null : !creation.canAttach ? 'readonly' : 'busy'); return; }
    const result = creation.create(search, tags);
    setProblem(isProblem(result) ? result : null);
  };
  const own = creation?.own ?? null;
  const shownProblem = problem ?? (creation?.canCreate && namesake ? (namesake.archivedAt === null ? 'exists' : 'archived') : null);
  const problemKey = shownProblem ? problemKeys[shownProblem] : undefined;
  return <div className="min-w-0 space-y-2">
    <label htmlFor={`${id}-search`} className="sr-only">{t('tasks.tags.search')}</label>
    <input ref={searchRef} id={`${id}-search`} type="search" value={search} disabled={disabled} autoFocus={autoFocus} autoComplete="off"
      aria-describedby={creation?.canCreate || createHint ? `${id}-help` : undefined}
      onKeyDown={event => {
        if (event.key === 'Escape' && onRequestClose) { event.preventDefault(); event.stopPropagation(); onRequestClose(); return; }
        if (event.key !== 'Enter') return;
        // Enter never reaches an enclosing form: it neither submits nor saves the task.
        event.preventDefault(); event.stopPropagation();
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (offerCreate) startCreate();
        else if (creation?.canCreate && namesake) setProblem(namesake.archivedAt === null ? 'exists' : 'archived');
      }}
      onChange={event => { setSearch(event.target.value); setProblem(null); }}
      className="h-8 w-full min-w-0 rounded border border-line bg-surface px-2 text-sm text-ink outline-none focus:ring-2 focus:ring-accent-soft" />
    <fieldset className="max-h-56 min-w-48 space-y-1 overflow-y-auto" disabled={disabled}>
      <legend className="sr-only">{t('tasks.taskFields.tags')}</legend>
      {missing.map(value => <label key={value} className="flex min-h-8 items-center gap-2 text-sm text-muted">
        <input type="checkbox" checked onChange={() => toggle(value, false)} /><span>{t('tasks.taskFields.tagUnavailable')}</span>
      </label>)}
      {visible.map(tag => <label key={tag.id} className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-canvas">
        <input type="checkbox" className="peer sr-only" checked={selected.has(tag.id.toLowerCase())} onChange={event => toggle(tag.id, event.target.checked)} />
        <span aria-hidden="true" className={cn('inline-flex size-4 shrink-0 items-center justify-center rounded border border-line-strong peer-focus-visible:ring-2 peer-focus-visible:ring-accent', selected.has(tag.id.toLowerCase()) && 'border-accent bg-accent text-white')}>
          {selected.has(tag.id.toLowerCase()) ? <Check size={12} /> : null}
        </span>
        <TagBadge tag={tag} />
      </label>)}
      {visible.length === 0 && missing.length === 0 ? <p className="text-xs text-muted">{options.length === 0 ? t('tasks.taskFields.noTagsYet') : t('tasks.tags.noMatches')}</p> : null}
    </fieldset>
    {offerCreate ? <button type="button" aria-disabled={createBlocked || undefined} aria-describedby={`${id}-help`} onClick={startCreate}
      className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded px-1 py-1 text-left text-sm text-accent-ink hover:bg-canvas aria-disabled:text-muted">
      <Plus size={14} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 break-words">{t('tasks.tags.create', { name: typed })}</span>
    </button> : null}
    {creation?.canCreate ? <p id={`${id}-help`} className="text-xs text-muted">{t('tasks.tags.createHelp')}</p> : null}
    {createHint ? <p id={`${id}-help`} className="text-xs text-muted">{t('tasks.tags.createDenied')}</p> : null}
    {problemKey ? <p role="alert" className="text-xs text-ink">{t(problemKey)}</p> : null}
    {creation ? <div aria-live="polite" className="space-y-1 text-xs text-ink">
      {own?.status === 'pending' ? <p>{t('tasks.tags.creating', { name: own.name })}</p> : null}
      {own?.status === 'unknown' ? <>
        <SaveFeedback subject="tagSave" error={null} uncertainError={own.error} />
        <button type="button" className={actionClassName} aria-disabled={!creation.canRetry || undefined} onClick={() => { keepFocus(); creation.retry(); }}>{t('tasks.tags.retry')}</button>
        {/* Focus moves to the search before the button disappears, never to the page or the task. */}
        {!own.catalogOnly && creation.canContinue
          ? <button type="button" className={actionClassName} onClick={() => {
            // Release only once the search holds focus; a disabled search cannot take it.
            const searchInput = searchRef.current;
            if (!searchInput || searchInput.disabled) return;
            keepFocus();
            if (document.activeElement === searchInput) creation.continueWithoutTag();
          }}>{t('tasks.tags.continueWithoutTag')}</button>
          : null}
      </> : null}
      {own?.status === 'unknown' ? <p>{t('tasks.tags.createUnknown', { name: own.name })}</p> : null}
      {(own?.status === 'unknown' || own?.status === 'pending') && own.catalogOnly ? <p>{t('tasks.tags.continuedWithoutTag', { name: own.name })}</p> : null}
      {own?.status === 'rejected' ? <SaveFeedback subject="tagSave" error={own.error} uncertainError={null}
        action={<button type="button" className={actionClassName} onClick={() => { creation.dismiss(); }}>{t('tasks.tags.dismiss')}</button>} /> : null}
      {own?.status === 'created' && own.added === true ? <p>{t('tasks.tags.createdAdded', { name: own.name })}</p> : null}
      {own?.status === 'created' && own.added === false ? <p>{t('tasks.tags.createdNotAdded', { name: own.name })}{' '}
        <button type="button" className={actionClassName} onClick={() => { creation.dismiss(); }}>{t('tasks.tags.dismiss')}</button></p> : null}
      {creation.foreign ? <p className="text-muted">{t('tasks.tags.otherCreatePending', { name: creation.foreign.name, label: creation.foreign.origin.label })}</p> : null}
    </div> : null}
    {manageAction}
  </div>;
}
