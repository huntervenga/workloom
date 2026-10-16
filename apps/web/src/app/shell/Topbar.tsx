import { t, useTranslation } from '../../i18n';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { Badge, Button } from '@workloom/ui';
import { FlaskConical, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useMatch } from 'react-router';
import { LanguageSelector } from './LanguageSelector';
import { isActorKey, queryKeys } from '../../lib/queryKeys';

export interface TopbarProps {
  actorId: string;
  workspaceId: string | null;
  workspaceName: string | null;
  menu: ReactNode;
}

export function Topbar({ actorId, workspaceId, workspaceName, menu }: TopbarProps) {
  useTranslation();
  const queryClient = useQueryClient();
  const onOverview = useMatch('/w/:workspaceId') !== null;
  const onMyTasks = useMatch('/w/:workspaceId/my-tasks') !== null;
  const onMembers = useMatch('/w/:workspaceId/members') !== null;
  const onProjects = useMatch('/w/:workspaceId/projects') !== null;
  const onProject = useMatch('/w/:workspaceId/projects/:projectId') !== null;
  const section = onMyTasks ? t('myTasks.title') : onMembers ? t('routes.members') : onProjects || onProject ? t('routes.projects') : onOverview ? t('shell.overview') : null;
  // Inside a project the section is a way back, not the current page.
  const sectionHref = onProject && workspaceId ? `/w/${workspaceId}/projects` : null;
  const fetching =
    useIsFetching({ predicate: (query) => query.queryKey[0] === 'me' || isActorKey(query.queryKey, actorId) }) > 0;

  const refresh = () => {
    if (fetching) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces(actorId) });
    if (workspaceId) void queryClient.invalidateQueries({ queryKey: queryKeys.workspace(actorId, workspaceId) });
  };

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-canvas/90 px-4 backdrop-blur-sm sm:gap-3 sm:px-6 lg:px-10">
      {menu}
      <nav aria-label={t('shell.breadcrumbs')} className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1.5 text-sm">
          <li className={section ? 'min-w-0 truncate text-muted' : 'min-w-0 truncate font-medium text-ink'}>
            {workspaceName ?? t('common.brand')}
          </li>
          {section ? (
            <>
              <li aria-hidden="true" className="text-line-strong">
                /
              </li>
              {sectionHref ? (
                <li className="shrink-0">
                  <Link to={sectionHref} className="rounded-md font-medium text-ink-soft hover:text-ink">
                    {section}
                  </Link>
                </li>
              ) : (
                <li aria-current="page" className="shrink-0 font-medium text-ink">
                  {section}
                </li>
              )}
            </>
          ) : null}
        </ol>
      </nav>
      <LanguageSelector />
      <Badge tone="warning" title={t('shell.localModeTitle')}>
        <FlaskConical size={14} aria-hidden="true" />
        <span className="sm:hidden">{t('shell.testShort')}</span>
        <span className="hidden sm:inline">{t('shell.localDemo')}</span>
      </Badge>
      <Button size="sm" onClick={refresh} aria-disabled={fetching || undefined}>
        <RefreshCw size={16} aria-hidden="true" className={fetching ? 'motion-safe:animate-spin' : undefined} />
        <span className="sr-only sm:not-sr-only">{t('shell.refresh')}</span>
      </Button>
    </header>
  );
}
