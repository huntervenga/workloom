import { useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, useSyncExternalStore, type ComponentProps } from 'react';
import type { MembershipDto } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { queryKeys } from '../../lib/queryKeys';
import { insertMention, mentionQueryAt, suggestMembers, type Mentionable } from './mentions';

type NativeProps = Omit<ComponentProps<'textarea'>, 'onChange' | 'value' | 'role'>;

/** A comment box that offers the workspace's members after "@". Members come from the cache the app already filled; nothing is fetched here. */
export function MentionTextarea({ actorId, workspaceId, value, onValueChange, ...rest }: NativeProps & { actorId: string; workspaceId: string; value: string; onValueChange: (value: string) => void }) {
  const { t } = useTranslation();
  const listId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const client = useQueryClient();
  // Observe the existing cache without replacing the real membership query's fetcher or options.
  const members = useSyncExternalStore(
    listener => client.getQueryCache().subscribe(listener),
    () => client.getQueryData<MembershipDto[]>(queryKeys.memberships(actorId, workspaceId)),
    () => undefined,
  );
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState(0);
  const typing = mentionQueryAt(value, caret);
  const suggestions = typing ? suggestMembers(members ?? [], typing.query) : [];
  const choose = (member: Mentionable) => {
    if (!typing) return;
    const next = insertMention(value, typing.start, caret, member.displayName);
    onValueChange(next.body);
    setCaret(next.caret);
    requestAnimationFrame(() => { field.current?.focus(); field.current?.setSelectionRange(next.caret, next.caret); });
  };
  return <>
    <textarea {...rest} ref={field} value={value} role="combobox" aria-expanded={suggestions.length > 0} aria-controls={listId} aria-autocomplete="list"
      onChange={event => { onValueChange(event.target.value); setCaret(event.target.selectionStart); setPicked(0); }}
      onSelect={event => setCaret(event.currentTarget.selectionStart)}
      onKeyDown={event => {
        if (suggestions.length === 0) return;
        if (event.key === 'ArrowDown') { event.preventDefault(); setPicked((picked + 1) % suggestions.length); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setPicked((picked + suggestions.length - 1) % suggestions.length); }
        else if ((event.key === 'Enter' || event.key === 'Tab') && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) { event.preventDefault(); const member = suggestions[picked]; if (member) choose(member); }
        else if (event.key === 'Escape') { event.stopPropagation(); setCaret(0); }
      }} />
    {suggestions.length > 0 ? <ul id={listId} role="listbox" aria-label={t('comments.mentionList')} className="max-h-40 overflow-y-auto rounded-lg border border-line bg-surface text-sm shadow-sm">
      {suggestions.map((member, index) => <li key={member.id} role="option" aria-selected={index === picked} className={`cursor-pointer px-3 py-1.5 ${index === picked ? 'bg-accent-soft text-ink' : 'text-ink-soft'}`} onMouseDown={event => { event.preventDefault(); choose(member); }}>{member.displayName}</li>)}
    </ul> : null}
  </>;
}
