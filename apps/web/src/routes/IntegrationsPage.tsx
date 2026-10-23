import { WorkspaceLink as Link } from '../features/workspace/WorkspaceNavigation';
import { useTranslation } from '../i18n';

import { buttonClassName } from '@workloom/ui';
import { ApiTokensPanel } from '../features/api-tokens/ApiTokensPanel';
import { CredentialPanel } from '../features/mcp/CredentialPanel';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useWorkspaceContext } from './WorkspaceLayout';
export function IntegrationsPage() {
  const { t } = useTranslation();
  const { actorId, workspace } = useWorkspaceContext();
  useDocumentTitle(t('mcp.integrations', { name: workspace.name }));
  return <div className="space-y-6"><header className="space-y-2"><Link className={buttonClassName({ variant: 'ghost', size: 'sm' })} to={`/w/${workspace.id}`}>{t('mcp.backToWorkspaceOverview')}</Link><h1 className="text-2xl font-semibold">{t('mcp.integrations2')}</h1><p className="text-sm text-muted">{t('mcp.localAccessForYourToolsInThisWorkspace')}</p></header><ApiTokensPanel key={`tokens:${actorId}:${workspace.id}`} actorId={actorId} workspaceId={workspace.id} workspaceName={workspace.name} /><details className="rounded-xl border border-line px-4 py-3"><summary className="cursor-pointer text-sm font-semibold">{t('mcp.localMcpAdvanced')}</summary><div className="mt-4"><CredentialPanel key={`${actorId}:${workspace.id}`} actorId={actorId} workspaceId={workspace.id} /></div></details></div>;
}
