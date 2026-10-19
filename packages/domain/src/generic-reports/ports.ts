import type { LeaveAvailabilityDto, GenericAggregateSettingsDto, GenericInitialSnapshotDto, GenericReportConfig, GenericReportDefinitionDto, GenericReportRowDto, TaskFieldDefinitionDto, TaskFieldValueDto, TaskStatusDto } from '@workloom/contracts';
import type { CommandContext } from '../access/context.js';
import type { Capability } from '../access/capabilities.js';
import type { TaskFieldWriteScope } from '../fields/ports.js';
export interface GenericSourceTask {
  id: string; projectId: string; title: string; revision: number; parentTaskId: string | null;
  sectionId: string | null; responsibleMembershipId: string | null; dueDate: string | null;
  statusGroup: TaskStatusDto['group']; tagIds: string[];
}
export interface GenericReportSource {
  /** Workspace change sequence + permission epoch under the same shared/exclusive barrier. */
  capacity?: LeaveAvailabilityDto;
  head: string; fields: TaskFieldDefinitionDto[]; tasks: GenericSourceTask[]; values: TaskFieldValueDto[];
  memberLabels: Record<string, string>; sectionLabels: Record<string, string>;
}
export interface StoredGenericInitial { header: GenericInitialSnapshotDto; rows: GenericReportRowDto[]; values: TaskFieldValueDto[] }
export interface GenericReportRepository {
  workspaceCatalog?(): Promise<import('@workloom/contracts').WorkspaceReportSourceDto[]>;
  workspaceMembers?(): Promise<import('@workloom/contracts').WorkspaceReportSourcesDto['members']>;
  workspaceCapacity?(input: import('@workloom/contracts').LeaveAvailabilityInput, manager: boolean): Promise<LeaveAvailabilityDto>;
  list(projectId: string): Promise<GenericReportDefinitionDto[]>;
  find(reportId: string): Promise<GenericReportDefinitionDto | null>;
  save(report: GenericReportDefinitionDto): Promise<void>;
  validateCapacity?(config:GenericReportConfig,allowFormer?:boolean):Promise<void>;
  source(config: GenericReportConfig): Promise<GenericReportSource>;
  listSnapshots(reportId: string): Promise<GenericInitialSnapshotDto[]>;
  findSnapshot(reportId: string, snapshotId: string): Promise<StoredGenericInitial | null>;
  insertSnapshot(snapshot: StoredGenericInitial): Promise<void>;
  settings(projectId: string): Promise<GenericAggregateSettingsDto>;
  saveSettings(settings: GenericAggregateSettingsDto): Promise<void>;
}
export interface GenericReportScope extends TaskFieldWriteScope { readonly reports: GenericReportRepository }
export interface GenericReportDependencies {
  read<T>(context: CommandContext, capability: Capability, work: (scope: GenericReportScope) => Promise<T>): Promise<T>;
  write<T>(context: CommandContext, capability: Capability, work: (scope: GenericReportScope) => Promise<T>): Promise<T>;
  newId(): string; digest(value: string): string;
}
