import { inboxResponseSchema, type InboxItemDto } from '@workloom/contracts';
import { apiGet } from '../../lib/api';
import { workspacePath } from '../workspace/queries';

export async function fetchInbox(workspaceId: string, signal?: AbortSignal): Promise<InboxItemDto[]> {
  return (await apiGet(`${workspacePath(workspaceId)}/inbox?limit=50`, inboxResponseSchema, signal)).data;
}
