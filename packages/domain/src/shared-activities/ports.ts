import type { ConfigureSharedActivityInput, ConfirmSharedActivityAttendanceInput, CreateSharedActivityInput, CreateSharedActivityResultDto, SharedActivityContributionDto, SharedActivityDto, SharedActivityHistoryDto, SharedActivityRecordDto } from '@workloom/contracts';
import type { Capability } from '../access/capabilities.js';
import type { CommandContext } from '../access/context.js';
import type { TaskFieldWriteScope } from '../fields/ports.js';
import type { TaskWriteScope } from '../tasks/ports.js';
export interface SharedActivityRepository {
  findByTask(taskId: string): Promise<SharedActivityDto | null>;
  listForTasks(taskIds: readonly string[]): Promise<SharedActivityDto[]>;
  contributions(activityId: string): Promise<SharedActivityContributionDto[]>;
  saveActivity(activity: SharedActivityDto): Promise<void>;
  saveContribution(contribution: SharedActivityContributionDto): Promise<void>;
  insertActivityVersion(activity: SharedActivityDto, actorUserId: string, changeSeq: string): Promise<void>;
  insertContributionVersion(version: SharedActivityHistoryDto): Promise<void>;
  history(activityId: string, contributionId: string): Promise<SharedActivityHistoryDto[]>;
}
export interface SharedActivityScope extends TaskFieldWriteScope {
  readonly activities: SharedActivityRepository;
  readonly taskScope: TaskWriteScope;
}
export interface SharedActivityDependencies {
  read<T>(context: CommandContext, capability: Capability, work: (scope: SharedActivityScope) => Promise<T>): Promise<T>;
  write<T>(context: CommandContext, capability: Capability, work: (scope: SharedActivityScope) => Promise<T>): Promise<T>;
  newId(): string; digest(value: string): string;
}
export interface SharedActivityApplication {
  get(context: CommandContext, taskId: string): Promise<SharedActivityRecordDto>;
  configure(context: CommandContext, taskId: string, input: ConfigureSharedActivityInput): Promise<SharedActivityRecordDto>;
  create(context: CommandContext, projectId: string, input: CreateSharedActivityInput): Promise<CreateSharedActivityResultDto>;
  confirm(context: CommandContext, taskId: string, input: ConfirmSharedActivityAttendanceInput): Promise<SharedActivityRecordDto>;
  history(context: CommandContext, taskId: string, contributionId: string): Promise<SharedActivityHistoryDto[]>;
}
