import type { TaskDependencyCountsDto } from '@workloom/contracts';
import { Hand, Hourglass } from 'lucide-react';
import { useTranslation } from '../../i18n';

/**
 * List badges for a task's unfinished dependency links: an hourglass while it waits on unfinished tasks, a raised
 * hand while unfinished tasks wait on it. Either opens the task, whose pane lists the links themselves.
 */
export function DependencyBadges({ title, counts, onOpen }: { title: string; counts: TaskDependencyCountsDto | undefined; onOpen: () => void }) {
  const { t } = useTranslation();
  if (!counts || (counts.waitingOn === 0 && counts.blocking === 0)) return null;
  return <>
    {counts.waitingOn > 0 ? <button type="button" data-dependency-badge="waiting" onClick={onOpen}
      title={t('dependencies.badges.waitingOn', { count: counts.waitingOn })}
      aria-label={t('dependencies.badges.waitingOnTask', { title, count: counts.waitingOn })}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded text-amber-600 hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ink dark-theme:text-amber-400">
      <Hourglass size={13} aria-hidden="true" />
    </button> : null}
    {counts.blocking > 0 ? <button type="button" data-dependency-badge="blocking" onClick={onOpen}
      title={t('dependencies.badges.blocking', { count: counts.blocking })}
      aria-label={t('dependencies.badges.blockingTask', { title, count: counts.blocking })}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ink">
      <Hand size={13} aria-hidden="true" />
    </button> : null}
  </>;
}
