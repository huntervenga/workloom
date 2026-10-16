import { t, useTranslation } from '../i18n';
import type { WorkspaceDto } from '@workloom/contracts';
import { StateCard, buttonClassName } from '@workloom/ui';
import { ArrowLeft, Lock } from 'lucide-react';
import { Link, Outlet, useOutletContext, useParams } from 'react-router';
import { useMe } from '../features/identity/identity';
import { useWorkspaceQuery } from '../features/workspace/queries';
import { describeError } from '../lib/errors';
import { isUuid } from '../lib/format';
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
  const { workspaceId = '' } = useParams();
  const actorId = useMe().actor.id;
  const workspace = useWorkspaceQuery(actorId, workspaceId);

  if (!isUuid(workspaceId)) return <WorkspaceUnavailable />;
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

function WorkspaceUnavailable() {
  useTranslation();
  useDocumentTitle(t('routes.workspaceUnavailable'));
  return (
    <StateCard
      headingLevel={1}
      icon={<Lock size={18} aria-hidden="true" />}
      title={t('routes.workspaceUnavailable')}
      description={t('routes.workspaceUnavailableDescription')}
      actions={
        <Link to="/" className={buttonClassName({ variant: 'primary' })}>
          <ArrowLeft size={16} aria-hidden="true" />

          {t('routes.backWorkspaces')}
        </Link>
      }
    />
  );
}
