import { QuickCreateDialog } from './QuickCreateDialog';
import { useShortcutItems } from '../work-shortcuts/WorkShortcuts';
import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, TextInput } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { DialogShell } from '../../shared/DialogShell';
import { useTaskSearch } from '../tasks/useTaskSearch';
import { useProjectsQuery } from '../projects/queries';
import { useWorkspaceNavigate } from '../workspace/WorkspaceNavigation';
import { filterJumpItems, type JumpItem } from './quickJumpItems';

/** Ctrl/Cmd+K: jump to a page, a project, or a workspace task by typing part of its name. */
export function QuickJump({ actorId, workspaceId, canCreate = false }: { actorId: string; workspaceId: string; canCreate?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (creating || event.isComposing || event.defaultPrevented) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') { event.preventDefault(); setOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [creating]);
  return <>
    <Button size="sm" variant="ghost" aria-label={t('quickJump.open')} title={t('quickJump.openHint')} onClick={() => setOpen(true)}><Search size={16} aria-hidden="true" /></Button>
    {/* Nothing is read until the palette is opened. */}
    {open ? <QuickJumpDialog actorId={actorId} workspaceId={workspaceId} onClose={() => setOpen(false)} onCreate={canCreate ? () => { setOpen(false); setCreating(true); } : undefined} /> : null}
    {creating ? <QuickCreateDialog actorId={actorId} workspaceId={workspaceId} onClose={() => setCreating(false)} /> : null}
  </>;
}

function QuickJumpDialog({ actorId, workspaceId, onClose, onCreate }: { actorId: string; workspaceId: string; onClose: () => void; onCreate: (() => void) | undefined }) {
  const { t } = useTranslation();
  const navigate = useWorkspaceNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const projects = useProjectsQuery(actorId, workspaceId);
  const recent = useShortcutItems(actorId, workspaceId, 'recent', query.trim() === '');
  const search = useTaskSearch(actorId, workspaceId, query);
  const items = useMemo(() => {
    const base = `/w/${workspaceId}`;
    const pages: JumpItem[] = [
      ...(onCreate ? [{ key: 'command:create', label: t('quickJump.createTask'), hint: t('quickJump.command'), to: '' }] : []),
      { key: 'page:overview', label: t('quickJump.overview'), hint: t('quickJump.page'), to: base },
      { key: 'page:inbox', label: t('quickJump.inbox'), hint: t('quickJump.page'), to: `${base}/inbox` },
      { key: 'page:my-tasks', label: t('quickJump.myTasks'), hint: t('quickJump.page'), to: `${base}/my-tasks` },
      { key: 'page:projects', label: t('quickJump.projects'), hint: t('quickJump.page'), to: `${base}/projects` },
      { key: 'page:reports', label: t('quickJump.reports'), hint: t('quickJump.page'), to: `${base}/reports` },
      { key: 'page:time-off', label: t('quickJump.timeOff'), hint: t('quickJump.page'), to: `${base}/time-off` },
      { key: 'page:members', label: t('quickJump.members'), hint: t('quickJump.page'), to: `${base}/members` },
    ];
    const projectItems: JumpItem[] = (projects.data?.projects ?? []).filter(project => project.archivedAt === null)
      .map(project => ({ key: `project:${project.id}`, label: project.name, hint: t('quickJump.project'), to: `${base}/projects/${project.id}` }));
    const taskItems: JumpItem[] = (search.results ?? []).map(task => ({
      key: `task:${task.id}`, label: task.title, hint: `${task.projectName} · ${task.statusName}`,
      to: `${base}/projects/${task.projectId}?task=${task.id}`,
    }));
    const recentKeys = new Set(recent.map(item => item.key));
    const recentItems = recent.map(item => ({ ...item, hint: t('quickJump.recent') }));
    return [...recentItems, ...filterJumpItems([...projectItems, ...pages], query).filter(item => !recentKeys.has(item.key)), ...taskItems];
  }, [workspaceId, projects.data, search.results, recent, query, t, onCreate]);

  const go = (item: JumpItem | undefined) => { if (!item) return; if (item.key === 'command:create') { onCreate?.(); return; } onClose(); void navigate(item.to); };
  const current = Math.min(active, Math.max(items.length - 1, 0));
  useEffect(() => { listRef.current?.children[current]?.scrollIntoView?.({ block: 'nearest' }); }, [current]);

  return <DialogShell open onOpenChange={next => { if (!next) onClose(); }} title={t('quickJump.title')} description={t('quickJump.description')}>
      <div className="space-y-3">
        <TextInput autoFocus role="combobox" aria-expanded="true" aria-controls="quick-jump-list" aria-activedescendant={items[current] ? `quick-jump-${items[current].key}` : undefined} aria-label={t('quickJump.input')}
          placeholder={t('quickJump.placeholder')} value={query} maxLength={200}
          onChange={event => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setActive(Math.min(current + 1, items.length - 1)); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(Math.max(current - 1, 0)); }
            else if (event.key === 'Enter') { event.preventDefault(); go(items[current]); }
          }} />
        {items.length === 0 ? <p role="status" className="text-sm text-muted">{t(search.pending ? 'quickJump.searching' : search.failed ? 'quickJump.searchFailed' : 'quickJump.none')}</p>
          : <ul id="quick-jump-list" role="listbox" ref={listRef} aria-label={t('quickJump.results')} className="max-h-72 overflow-y-auto rounded-lg border border-line">
            {items.map((item, index) => <li key={item.key} id={`quick-jump-${item.key}`} role="option" aria-selected={index === current}
              className={`flex cursor-pointer items-baseline justify-between gap-3 px-3 py-2 text-sm ${index === current ? 'bg-accent-soft text-ink' : 'text-ink-soft'}`}
              onMouseEnter={() => setActive(index)} onClick={() => go(item)}>
              <span className="min-w-0 truncate">{item.label}</span><span className="shrink-0 text-xs text-muted">{item.hint}</span>
            </li>)}
          </ul>}
      </div>
  </DialogShell>;
}
