import type {
 AddRecurrencePeriodsInput,AuthorizeRecurrenceGenerationInput,CreateRecurrenceSeriesInput,EditRecurrenceSeriesInput,MaterializePeriodInput,
 RecurrenceCreatePreviewDto,RecurrenceCreatePreviewInput,RecurrenceEditPreviewDto,RecurrenceEditPreviewInput,RecurrenceExceptionPreviewDto,
 RecurrenceExceptionPreviewInput,RecurrenceInstanceDto,RecurrenceInstanceListQuery,RecurrenceMaterializationResultDto,RecurrencePeriodPreviewDto,
 RecurrencePeriodPreviewInput,RecurrencePeriodsResultDto,RecurrenceReadinessDto,RecurrenceSeriesDto,RecurrenceSeriesListQuery,
 SetRecurrenceExceptionInput,SetRecurrenceSeriesStateInput,
} from '@workloom/contracts';
import type {CommandContext} from '../access/context.js';
import type {PlanningPage} from '../planning/application.js';

/** P3b public port, exactly fifteen methods (docs/16-p3b-contract.md §5). Trusted ctx first.
 * Mutations are keyed and run the mandatory planning guard with an exhaustive recurrence intent.
 * Previews are keyless repeatable reads: they never materialize, reserve headers or invent entity IDs.
 * materializePeriod is the typed prerequisite-recovery command; authorizeGeneration is the narrow
 * metadata recovery exempt from a prerequisite that needs the revoked old grant.
 */
export interface RecurrenceApplication {
 listSeries(ctx:CommandContext,projectId:string,query:RecurrenceSeriesListQuery):Promise<PlanningPage<RecurrenceSeriesDto>>;
 previewCreate(ctx:CommandContext,projectId:string,input:RecurrenceCreatePreviewInput):Promise<RecurrenceCreatePreviewDto>;
 createSeries(ctx:CommandContext,projectId:string,input:CreateRecurrenceSeriesInput):Promise<RecurrenceSeriesDto>;
 getSeries(ctx:CommandContext,seriesId:string):Promise<RecurrenceSeriesDto>;
 previewEdit(ctx:CommandContext,seriesId:string,input:RecurrenceEditPreviewInput):Promise<RecurrenceEditPreviewDto>;
 editSeries(ctx:CommandContext,seriesId:string,input:EditRecurrenceSeriesInput):Promise<RecurrenceSeriesDto>;
 setState(ctx:CommandContext,seriesId:string,input:SetRecurrenceSeriesStateInput):Promise<RecurrenceSeriesDto>;
 previewPeriods(ctx:CommandContext,seriesId:string,input:RecurrencePeriodPreviewInput):Promise<RecurrencePeriodPreviewDto>;
 addPeriods(ctx:CommandContext,seriesId:string,input:AddRecurrencePeriodsInput):Promise<RecurrencePeriodsResultDto>;
 authorizeGeneration(ctx:CommandContext,seriesId:string,input:AuthorizeRecurrenceGenerationInput):Promise<RecurrenceSeriesDto>;
 listInstances(ctx:CommandContext,seriesId:string,query:RecurrenceInstanceListQuery):Promise<PlanningPage<RecurrenceInstanceDto>>;
 previewException(ctx:CommandContext,seriesId:string,occurrenceKey:string,input:RecurrenceExceptionPreviewInput):Promise<RecurrenceExceptionPreviewDto>;
 setException(ctx:CommandContext,seriesId:string,occurrenceKey:string,input:SetRecurrenceExceptionInput):Promise<RecurrenceInstanceDto>;
 materializePeriod(ctx:CommandContext,periodId:string,input:MaterializePeriodInput):Promise<RecurrenceMaterializationResultDto>;
 getReadiness(ctx:CommandContext,periodId:string):Promise<RecurrenceReadinessDto>;
}
