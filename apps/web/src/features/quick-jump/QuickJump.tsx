import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, TextInput } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { DialogShell } from '../../shared/DialogShell';
import { useMyTasksQuery } from '../my-tasks/queries';
import { useProjectsQuery } from '../projects/queries';
import { useWorkspaceNavigate } from '../workspace/WorkspaceNavigation';
import { filterJumpItems, type JumpItem } from './quickJumpItems';

/** Ctrl/Cmd+K: jump to a page, a project, or one of your own tasks by typing part of its name. */
export function QuickJump({ actorId, workspaceId }: { actorId: string; workspaceId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') { event.preventDefault(); setOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return <>
    <Button size="sm" variant="ghost" aria-label={t('quickJump.open')} title={t('quickJump.openHint')} onClick={() => setOpen(true)}><Search size={16} aria-hidden="true" /></Button>
    {/* Nothing is read until the palette is opened. */}
    {open ? <QuickJumpDialog actorId={actorId} workspaceId={workspaceId} onClose={() => setOpen(false)} /> : null}
  </>;
}

function QuickJumpDialog({ actorId, workspaceId, onClose }: { actorId: string; workspaceId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useWorkspaceNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const projects = useProjectsQuery(actorId, workspaceId);
  const term = query.trim();
  // Own tasks are asked for from the server, only once something meaningful is typed.
  const mine = useMyTasksQuery(actorId, workspaceId, { relation: 'all', completion: 'open', includeArchived: false, search: term }, { enabled: term.length >= 2 });
  const items = useMemo(() => {
    const base = `/w/${workspaceId}`;
    const pages: JumpItem[] = [
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
    const taskRows = term.length >= 2 ? (mine.data?.pages.flatMap(page => page.items) ?? []).slice(0, 8) : [];
    const taskItems: JumpItem[] = taskRows.map(row => ({ key: `task:${row.task.id}`, label: row.task.title, hint: row.project.name, to: `${base}/projects/${row.task.projectId}?task=${row.task.id}` }));
    return [...filterJumpItems([...projectItems, ...pages], query), ...taskItems];
  }, [workspaceId, projects.data, mine.data, term, query, t]);

  const go = (item: JumpItem | undefined) => { if (!item) return; onClose(); void navigate(item.to); };
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
        {items.length === 0 ? <p role="status" className="text-sm text-muted">{t('quickJump.none')}</p>
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
