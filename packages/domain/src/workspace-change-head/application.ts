import type { WorkspaceChangeHeadDto } from '@workloom/contracts';
import type { CommandContext } from '../access/context.js';

export interface WorkspaceChangeHeadApplication {
  getHead(context: CommandContext): Promise<WorkspaceChangeHeadDto>;
}
