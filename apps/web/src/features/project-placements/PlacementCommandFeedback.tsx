import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../../lib/queryKeys';
import { Button } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { ApiError } from '../../lib/api';
import type { PlacementCommands } from './queries';

/** Page owned: the exact uncertain command survives closing the pane or changing tasks. */
export function PlacementCommandFeedback({ commands, actorId, workspaceId }: { commands: PlacementCommands; actorId?: string; workspaceId?: string }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  if (commands.pendingCommand) return <p role="status" className="text-xs text-muted">{t('placements.saving')}</p>;
  if (commands.uncertain) return <div role="alert" className="flex flex-wrap items-center gap-2 text-sm"><span>{t('placements.unknown')}</span><Button size="sm" onClick={() => commands.retryUncertain()}>{t('placements.retry')}</Button></div>;
  if (commands.isError) return <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-red-700"><p>{commands.error instanceof ApiError && commands.error.status === 422 ? t('placements.failedRule') : t('placements.failed')}</p><Button size="sm" onClick={() => { if (actorId && workspaceId) void client.invalidateQueries({ queryKey: queryKeys.tasks(actorId, workspaceId) }); commands.reset(); }}>{t('placements.reload')}</Button></div>;
  return null;
}
