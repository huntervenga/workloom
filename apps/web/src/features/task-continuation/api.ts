import { continueTaskInputSchema, continueTaskResponseSchema, type ContinueTaskInput } from '@workloom/contracts';
import { prepareMutation } from '../../lib/api';
import { workspacePath } from '../workspace/queries';

export function continueTaskRequest(workspaceId: string, taskId: string, input: ContinueTaskInput) {
  return prepareMutation({ method: 'POST', path: `${workspacePath(workspaceId)}/tasks/${encodeURIComponent(taskId)}/continue`, input, inputSchema: continueTaskInputSchema, responseSchema: continueTaskResponseSchema });
}
