import { t, useTranslation } from '../i18n';
import { Button, StateCard } from '@workloom/ui';
import { Inbox, Plus } from 'lucide-react';
import { Navigate } from 'react-router';
import { useMe } from '../features/identity/identity';
import { useWorkspacesQuery } from '../features/workspace/queries';
import { homeTarget, useWorkspaceCreation } from '../features/workspace/WorkspaceCreation';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { PageSkeleton } from '../shared/PageSkeleton';
import { QueryErrorState } from '../shared/QueryErrorState';

/** Opens the first workspace the server lists for the current actor. */
export function HomeRedirect() {
  useTranslation();
  const me = useMe();
  const workspaces = useWorkspacesQuery(me.actor.id);
  const creation = useWorkspaceCreation();
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
        actions={
          // Nothing is created by itself: only this explicit action opens the dialog.
          creation.canCreate ? (
            <Button variant="primary" onClick={(event) => creation.show(event.currentTarget)}>
              <Plus size={16} aria-hidden="true" />
              {t('workspace.create.open')}
            </Button>
          ) : undefined
        }
      />
    );
  }

  // A workspace just created from this page keeps the create's own projects target, also while
  // another owner's guard holds that navigation.
  return <Navigate to={homeTarget(first.id, creation)} replace />;
}
