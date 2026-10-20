import type * as C from '@workloom/contracts';
import type { CommandContext } from '../access/context.js';
import type { Capability } from '../access/capabilities.js';
import type { PlanningApplicationWriteScope } from '../planning/ports.js';
import type { GenericReportRepository } from '../generic-reports/ports.js';
import type { PlanningCheckRepository } from '../planning-checks/ports.js';
import type { TaskProjectPlacementRepository } from '../tasks/project-placement-ports.js';
export interface DuplicationScope extends PlanningApplicationWriteScope {
  readonly reports: GenericReportRepository;
  readonly checks: PlanningCheckRepository;
  readonly placements: TaskProjectPlacementRepository;
}
export interface DuplicationDependencies {
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
