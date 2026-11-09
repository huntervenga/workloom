import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useId, useRef, useState, useSyncExternalStore, type ComponentProps } from 'react';
import type { MembershipDto } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { queryKeys } from '../../lib/queryKeys';
import type { ProjectList } from '../projects/api';
import { taskLink } from '../tasks/CopyTaskLink';
import { LinkedDescription } from '../tasks/LinkedDescription';
import { useTaskSearch } from '../tasks/useTaskSearch';
import { insertMention, mentionQueryAt, suggestMembers } from './mentions';

type NativeProps = Omit<ComponentProps<'textarea'>, 'onChange' | 'value' | 'role'>;
type Suggestion = { key: string; label: string; insert: string; hint?: string };

export function MentionTextarea({ actorId, workspaceId, value, onValueChange, mentionPeople = true, ref, onKeyDown, onFocus, onBlur, ...rest }:
  NativeProps & { actorId: string; workspaceId: string; value: string; onValueChange: (value: string) => void; mentionPeople?: boolean }) {
  const { t } = useTranslation();
  const listId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const attach = useCallback((node: HTMLTextAreaElement | null) => {
    field.current = node;
    if (typeof ref === 'function') return ref(node);
    if (ref) ref.current = node;
  }, [ref]);
  const client = useQueryClient();
  // Observe existing catalog entries without replacing their authorized fetchers.
  const members = useSyncExternalStore(
    listener => client.getQueryCache().subscribe(listener),
    () => client.getQueryState(queryKeys.memberships(actorId, workspaceId))?.status === 'success'
      ? client.getQueryData<MembershipDto[]>(queryKeys.memberships(actorId, workspaceId)) : undefined,
    () => undefined,
  );
  const projects = useSyncExternalStore(
    listener => client.getQueryCache().subscribe(listener),
    () => client.getQueryState(queryKeys.projectList(actorId, workspaceId))?.status === 'success'
      ? client.getQueryData<ProjectList>(queryKeys.projectList(actorId, workspaceId))?.projects : undefined,
    () => undefined,
  );
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const typing = focused && !dismissed && !rest.disabled && !rest.readOnly ? mentionQueryAt(value, caret) : null;
  const term = typing?.query.trim() ?? '';
  const tasks = useTaskSearch(actorId, workspaceId, term);
  const suggestions: Suggestion[] = [];
  if (typing) {
    if (mentionPeople) suggestions.push(...suggestMembers(members ?? [], term, 4)
      .map(person => ({ key: `person:${person.id}`, label: person.displayName, insert: `@${person.displayName.trim()}` })));
    if (term) suggestions.push(...(projects ?? [])
      .filter(project => project.archivedAt === null && project.name.toLowerCase().includes(term.toLowerCase())).slice(0, 3)
      .map(project => ({ key: `project:${project.id}`, label: project.name, hint: t('quickJump.project'),
        insert: `${window.location.origin}/app/w/${workspaceId}/projects/${project.id}` })));
    suggestions.push(...(tasks.results ?? []).slice(0, 5).map(task => ({
      key: `task:${task.id}`, label: task.title, hint: task.projectName,
      insert: taskLink(window.location.origin, workspaceId, task.projectId, task.id),
    })));
  }
  const current = Math.min(picked, Math.max(suggestions.length - 1, 0));
  const choose = (item: Suggestion) => {
    if (!typing) return;
    const next = insertMention(value, typing.start, caret, item.insert.startsWith('@') ? item.insert.slice(1) : item.insert, item.insert.startsWith('@'));
    if (rest.maxLength !== undefined && next.body.length > rest.maxLength) return;
    onValueChange(next.body);
    setCaret(next.caret);
    setDismissed(true);
    requestAnimationFrame(() => { field.current?.focus(); field.current?.setSelectionRange(next.caret, next.caret); });
  };
  return <>
    <textarea {...rest} ref={attach} value={value} role={mentionPeople || typing ? 'combobox' : undefined}
      aria-expanded={mentionPeople || typing ? suggestions.length > 0 : undefined} aria-controls={suggestions.length ? listId : undefined}
      aria-activedescendant={suggestions.length ? `${listId}-${current}` : undefined} aria-autocomplete={mentionPeople || typing ? 'list' : undefined}
      onFocus={event => { setFocused(true); onFocus?.(event); }}
      onBlur={event => { setFocused(false); onBlur?.(event); }}
      onChange={event => { onValueChange(event.target.value); setCaret(event.target.selectionStart); setPicked(0); setDismissed(false); }}
      onSelect={event => setCaret(event.currentTarget.selectionStart)}
      onKeyDown={event => {
        if (suggestions.length > 0 && !event.nativeEvent.isComposing && !event.metaKey && !event.ctrlKey) {
          if (event.key === 'ArrowDown') { event.preventDefault(); setPicked((current + 1) % suggestions.length); return; }
          if (event.key === 'ArrowUp') { event.preventDefault(); setPicked((current + suggestions.length - 1) % suggestions.length); return; }
          if (event.key === 'Enter' || event.key === 'Tab' && !event.shiftKey) {
            const item = suggestions[current];
            if (item) { event.preventDefault(); choose(item); return; }
          }
          if (event.key === 'Escape') { event.stopPropagation(); setDismissed(true); return; }
        }
        onKeyDown?.(event);
      }} />
    {suggestions.length > 0 ? <ul id={listId} role="listbox" aria-label={t('comments.mentionList')} className="max-h-40 overflow-y-auto rounded-lg border border-line bg-surface text-sm shadow-sm">
      {suggestions.map((item, index) => <li key={item.key} id={`${listId}-${index}`} role="option" aria-selected={index === current}
        className={index === current ? 'cursor-pointer px-3 py-1.5 bg-accent-soft text-ink' : 'cursor-pointer px-3 py-1.5 text-ink-soft'}
        onMouseDown={event => { event.preventDefault(); choose(item); }}>
        {item.label}{item.hint ? <span className="ml-2 text-xs text-muted">{item.hint}</span> : null}
      </li>)}
    </ul> : null}
    <LinkedDescription text={value} preview />
  </>;
}
