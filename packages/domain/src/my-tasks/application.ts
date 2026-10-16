import type { MyTaskDto, MyTasksQueryInput } from '@workloom/contracts';
import type { CommandContext } from '../access/context.js';
export interface MyTasksPage { readonly items: MyTaskDto[]; readonly nextCursor: string | null }
export interface MyTasksApplication {
  list(context: CommandContext, input: MyTasksQueryInput): Promise<MyTasksPage>;
}
