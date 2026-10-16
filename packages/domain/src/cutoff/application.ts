import type { ConfigureCutoffInput, CutoffCommandResultDto, CutoffJob, CutoffReadinessDto, CutoffWorkerOutcome, RetryCutoffInput } from '@workloom/contracts';
import type { CommandContext } from '../access/context.js';
export interface CutoffApplication {
  getReadiness(context: CommandContext, periodId: string): Promise<CutoffReadinessDto>;
  configure(context: CommandContext, periodId: string, input: ConfigureCutoffInput): Promise<CutoffCommandResultDto>;
  retry(context: CommandContext, periodId: string, input: RetryCutoffInput): Promise<CutoffCommandResultDto>;
}
export interface CutoffWorkerFacade { freezeDuePeriod(job: CutoffJob): Promise<CutoffWorkerOutcome> }
