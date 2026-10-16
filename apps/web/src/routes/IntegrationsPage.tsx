import { Link } from 'react-router';
import { buttonClassName } from '@workloom/ui';
import { CredentialPanel } from '../features/mcp/CredentialPanel';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useWorkspaceContext } from './WorkspaceLayout';
export function IntegrationsPage() {
  const { actorId, workspace } = useWorkspaceContext();
  useDocumentTitle(`Интеграции · ${workspace.name}`);
  return <div className="space-y-6"><header className="space-y-2"><Link className={buttonClassName({ variant: 'ghost', size: 'sm' })} to={`/w/${workspace.id}`}>К обзору пространства</Link><h1 className="text-2xl font-semibold">Интеграции</h1><p className="text-sm text-muted">Локальный доступ для ваших инструментов к текущему пространству.</p></header><CredentialPanel key={`${actorId}:${workspace.id}`} actorId={actorId} workspaceId={workspace.id} /></div>;
}
