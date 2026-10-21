import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys';
import { t, useTranslation } from '../i18n';
import type { WorkspaceDto } from '@workloom/contracts';
import { Button, StateCard, buttonClassName } from '@workloom/ui';
import { ArrowLeft, Lock } from 'lucide-react';
import { useEffect } from 'react';
import { Link, Outlet, useOutletContext, useLocation, useNavigate } from 'react-router';
import { useWorkspaceRoute } from '../features/workspace/WorkspaceNavigation';
import { canonicalWorkspacePath } from '../features/workspace/workspaceRouting';
import { useMe } from '../features/identity/identity';
import { useWorkspaceQuery } from '../features/workspace/queries';
import { describeError } from '../lib/errors';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { PageSkeleton } from '../shared/PageSkeleton';
import { QueryErrorState } from '../shared/QueryErrorState';

export interface WorkspaceOutletContext {
  actorId: string;
  workspace: WorkspaceDto;
}

export function useWorkspaceContext(): WorkspaceOutletContext {
  return useOutletContext<WorkspaceOutletContext>();
}

export function WorkspaceLayout() {
  useTranslation();
  const actorId = useMe().actor.id;
  const client = useQueryClient();
  const route = useWorkspaceRoute(actorId);
  const workspace = useWorkspaceQuery(actorId, route.workspaceId);
  const location = useLocation();
  const navigate = useNavigate();
  const current = workspace.isSuccess && !workspace.headDenial ? workspace.data : null;
  useEffect(() => {
    if (!current) return;
    client.setQueryData<WorkspaceDto[]>(queryKeys.workspaces(actorId), list => list?.map(item => item.id === current.id && (item.slugRevision ?? 0) < (current.slugRevision ?? 0) ? current : item));
    const path = location.pathname + location.search + location.hash;
    const canonical = canonicalWorkspacePath(path, [current]);
    if (canonical !== path) void navigate(canonical, { replace: true });
  }, [actorId, client, current, location.pathname, location.search, location.hash, navigate]);

  if (route.pending) return <PageSkeleton label={t('routes.loadingWorkspace')} />;
  if (route.error) return <QueryErrorState error={route.error} subject="workspaces" headingLevel={1} retrying={route.isFetching} onRetry={() => void route.refetch()} />;
  if (!route.workspaceId) return <WorkspaceUnavailable />;
  if (workspace.headDenial) return <WorkspaceUnavailable retrying={workspace.isFetching || workspace.recoveringHeadAccess} onRetry={() => void workspace.refetch()} />;
  if (workspace.isPending) return <PageSkeleton label={t('routes.loadingWorkspace')} />;

  // Errors win over any previously loaded data, so a denied refetch hides the workspace.
  if (workspace.isError) {
    if (describeError(workspace.error, 'workspace').unavailable) return <WorkspaceUnavailable />;
    return (
      <QueryErrorState
        error={workspace.error}
        subject="workspace"
        headingLevel={1}
        retrying={workspace.isFetching}
        onRetry={() => void workspace.refetch()}
      />
    );
  }

  return <Outlet context={{ actorId, workspace: workspace.data } satisfies WorkspaceOutletContext} />;
}

function WorkspaceUnavailable({ onRetry, retrying = false }: { onRetry?: (() => void) | undefined; retrying?: boolean }) {
  useTranslation();
  useDocumentTitle(t('routes.workspaceUnavailable'));
  return (
    <StateCard
      headingLevel={1}
      icon={<Lock size={18} aria-hidden="true" />}
      title={t('routes.workspaceUnavailable')}
      description={t('routes.workspaceUnavailableDescription')}
      actions={
        <div className="flex flex-wrap gap-2">
        {onRetry ? <Button disabled={retrying} onClick={onRetry}>{retrying ? t('common.retrying') : t('common.retry')}</Button> : null}
        <Link to="/" className={buttonClassName({ variant: 'primary' })}>
          <ArrowLeft size={16} aria-hidden="true" />

          {t('routes.backWorkspaces')}
        </Link>
        </div>
      }
    />
  );
}
