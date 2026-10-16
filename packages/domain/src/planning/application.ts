import type {
  CreatePlanningPeriodInput, CreatePeriodCommitmentInput, CreateWeeklyPlanFactReportInput,
  FreezePlanInput, FreezePreviewDto, FreezePreviewInput, ManualPeriodWorkLogDto, PackageBaselineDto,
  PeriodCommitmentDto, PeriodCommitmentListQuery, PlanBaselineDto, PlanningPackageDto,
  PlanningPackageListQuery, PlanningPageQuery, PlanningPeriodDto, PlanningPeriodListQuery,
  ReportRunListQuery, SetManualPeriodWorkInput, UpdatePeriodCommitmentInput, UpdatePlanningPeriodInput,
  WeeklyPlanFactReportRunDto, WeeklyPlanFactRowDto, WorkLogListQuery,
} from '@workloom/contracts';
import type { CommandContext } from '../access/context.js';

/** HTTP maps items to data, nextCursor to meta.nextCursor. All lists are paged. */
export interface PlanningPage<T> { readonly items: T[]; readonly nextCursor: string | null }

/** Trusted ctx first. Every mutation needs an Idempotency-Key. See docs/13-p2a-contract.md.
 * Reads authorize current access; immutable snapshots never grant historical access.
 * POST freeze-preview is a consistent read, needs no key and never runs auto-freeze.
 */
export interface PlanningApplication {
  listPeriods(ctx: CommandContext, query: PlanningPeriodListQuery): Promise<PlanningPage<PlanningPeriodDto>>;
  getPeriod(ctx: CommandContext, periodId: string): Promise<PlanningPeriodDto>;
  createPeriod(ctx: CommandContext, input: CreatePlanningPeriodInput): Promise<PlanningPeriodDto>;
  updatePeriod(ctx: CommandContext, periodId: string, input: UpdatePlanningPeriodInput): Promise<PlanningPeriodDto>;
  listPackages(ctx: CommandContext, query: PlanningPackageListQuery): Promise<PlanningPage<PlanningPackageDto>>;
  listCommitments(ctx: CommandContext, periodId: string, query: PeriodCommitmentListQuery): Promise<PlanningPage<PeriodCommitmentDto>>;
  createCommitment(ctx: CommandContext, periodId: string, input: CreatePeriodCommitmentInput): Promise<PeriodCommitmentDto>;
  updateCommitment(ctx: CommandContext, periodId: string, commitmentId: string, input: UpdatePeriodCommitmentInput): Promise<PeriodCommitmentDto>;
  previewFreeze(ctx: CommandContext, periodId: string, input: FreezePreviewInput): Promise<FreezePreviewDto>;
  freezePlan(ctx: CommandContext, periodId: string, input: FreezePlanInput): Promise<PlanBaselineDto>;
  listBaselines(ctx: CommandContext, periodId: string, query: PlanningPageQuery): Promise<PlanningPage<PlanBaselineDto>>;
  getBaseline(ctx: CommandContext, baselineId: string): Promise<PlanBaselineDto>;
  getPackageBaseline(ctx: CommandContext, baselineId: string): Promise<PackageBaselineDto>;
  listWorkLogs(ctx: CommandContext, query: WorkLogListQuery): Promise<PlanningPage<ManualPeriodWorkLogDto>>;
  setManualPeriodWork(ctx: CommandContext, taskId: string, periodId: string, membershipId: string, input: SetManualPeriodWorkInput): Promise<ManualPeriodWorkLogDto>;
  listReportRuns(ctx: CommandContext, query: ReportRunListQuery): Promise<PlanningPage<WeeklyPlanFactReportRunDto>>;
  createReportRun(ctx: CommandContext, input: CreateWeeklyPlanFactReportInput): Promise<WeeklyPlanFactReportRunDto>;
  getReportRun(ctx: CommandContext, runId: string): Promise<WeeklyPlanFactReportRunDto>;
  listReportRows(ctx: CommandContext, runId: string, query: PlanningPageQuery): Promise<PlanningPage<WeeklyPlanFactRowDto>>;
}
