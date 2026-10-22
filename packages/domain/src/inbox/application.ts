import type { InboxItemDto, InboxQueryInput } from '@workloom/contracts';
import type { CommandContext } from '../access/context.js';

export interface InboxApplication {
  list(context: CommandContext, input: InboxQueryInput): Promise<InboxItemDto[]>;
}
