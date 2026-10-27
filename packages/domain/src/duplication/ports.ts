import type { AttachmentRecord } from '../attachments/ports.js';
import type {SummaryTemplateRepository} from '../summary-templates/ports.js';
import type * as C from '@workloom/contracts';
import type { CommandContext } from '../access/context.js';
import type { Capability } from '../access/capabilities.js';
import type { PlanningApplicationWriteScope } from '../planning/ports.js';
import type { GenericReportRepository } from '../generic-reports/ports.js';
import type { PlanningCheckRepository } from '../planning-checks/ports.js';
import type { TaskProjectPlacementRepository } from '../tasks/project-placement-ports.js';
export interface PreparedAttachmentCopy {
  readonly sourceId: string;
  readonly row: AttachmentRecord;
}
export interface DuplicationAttachments {
  listReady(workspaceId: string, taskIds: readonly string[]): Promise<AttachmentRecord[]>;
  adopt(row: AttachmentRecord): Promise<void>;
}
export interface DuplicationScope extends PlanningApplicationWriteScope {
  readonly attachments: DuplicationAttachments;
  readonly templates?:SummaryTemplateRepository;
  sharedActivityTaskIds?(taskIds:readonly string[]):Promise<string[]>;
  readonly reports: GenericReportRepository;
  readonly checks: PlanningCheckRepository;
  readonly placements: TaskProjectPlacementRepository;
}
export interface DuplicationDependencies {
  readonly attachmentCopies?: {
    readonly storageId: string;
    prepare(context: CommandContext, sources: readonly AttachmentRecord[]): Promise<PreparedAttachmentCopy[]>;
  };
  read<T>(ctx: CommandContext, capability: Capability, work: (scope: DuplicationScope) => Promise<T>): Promise<T>;
  write<T>(ctx: CommandContext, capability: Capability, work: (scope: DuplicationScope) => Promise<T>): Promise<T>;
  newId(): string;
  digest(value: string): string;
}
export interface DuplicationApplication {
  previewTask(ctx: CommandContext, taskId: string, input: C.DuplicateTaskPreviewInput): Promise<C.DuplicationPreviewDto>;
  duplicateTask(ctx: CommandContext, taskId: string, input: C.DuplicateTaskInput): Promise<C.DuplicationResultDto>;
  previewSection(ctx: CommandContext, sectionId: string, input: C.DuplicateSectionPreviewInput): Promise<C.DuplicationPreviewDto>;
  duplicateSection(ctx: CommandContext, sectionId: string, input: C.DuplicateSectionInput): Promise<C.DuplicationResultDto>;
}
