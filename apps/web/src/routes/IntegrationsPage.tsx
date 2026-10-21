import { WorkspaceLink as Link } from '../features/workspace/WorkspaceNavigation';
import { useTranslation } from '../i18n';

import { buttonClassName } from '@workloom/ui';
import { CredentialPanel } from '../features/mcp/CredentialPanel';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useWorkspaceContext } from './WorkspaceLayout';
export function IntegrationsPage() {
  const { t } = useTranslation();
  const { actorId, workspace } = useWorkspaceContext();
  useDocumentTitle(t('mcp.integrations', { name: workspace.name }));
  return <div className="space-y-6"><header className="space-y-2"><Link className={buttonClassName({ variant: 'ghost', size: 'sm' })} to={`/w/${workspace.id}`}>{t('mcp.backToWorkspaceOverview')}</Link><h1 className="text-2xl font-semibold">{t('mcp.integrations2')}</h1><p className="text-sm text-muted">{t('mcp.localAccessForYourToolsInThisWorkspace')}</p></header><CredentialPanel key={`${actorId}:${workspace.id}`} actorId={actorId} workspaceId={workspace.id} /></div>;
}
