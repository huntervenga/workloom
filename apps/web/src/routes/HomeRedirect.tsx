import { t, useTranslation } from '../i18n';
import { StateCard } from '@workloom/ui';
import { Inbox } from 'lucide-react';
import { Navigate } from 'react-router';
import { useMe } from '../features/identity/identity';
import { useWorkspacesQuery } from '../features/workspace/queries';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { PageSkeleton } from '../shared/PageSkeleton';
import { QueryErrorState } from '../shared/QueryErrorState';

/** Opens the first workspace the server lists for the current actor. */
export function HomeRedirect() {
  useTranslation();
  const me = useMe();
  const workspaces = useWorkspacesQuery(me.actor.id);
  useDocumentTitle(null);

  if (workspaces.isPending) return <PageSkeleton label={t('workspace.loading')} />;

  if (workspaces.isError) {
    return (
      <QueryErrorState
        error={workspaces.error}
        subject="workspaces"
        headingLevel={1}
        retrying={workspaces.isFetching}
        onRetry={() => void workspaces.refetch()}
      />
    );
  }

  const first = workspaces.data.at(0);
  if (!first) {
    return (
      <StateCard
        headingLevel={1}
        icon={<Inbox size={18} aria-hidden="true" />}
        title={t('workspace.noneAvailable')}
        description={t('routes.notInWorkspace', { name: me.actor.displayName })}
      />
    );
  }

  return <Navigate to={`/w/${first.id}`} replace />;
}
