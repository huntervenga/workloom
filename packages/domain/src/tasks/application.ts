import type {
  ArchiveTaskInput,
  CreateProjectInput,
  CreateSectionInput,
  CreateTagInput,
  CreateTaskInput,
  MoveTaskInput,
  ProjectDto,
  RestoreTaskInput,
  SectionDto,
  TagDto,
  TaskDto,
  TaskListQuery,
  TaskStatusDto,
  UpdateProjectInput,
  UpdateSectionInput,
  UpdateTagInput,
  UpdateTaskInput,
} from '@workloom/contracts';

import type { CommandContext } from '../access/context.js';

/**
 * One page of tasks. The HTTP adapter maps `items` to `data` and `nextCursor` to
 * `meta.nextCursor`; `null` means the last page.
 */
export interface TaskPage {
  readonly items: TaskDto[];
  readonly nextCursor: string | null;
}

/**
 * P1a project, section, status, tag and task use cases, shared by HTTP, MCP, imports and jobs.
 *
 * - `context` is trusted and built by a server adapter; the workspace comes from it, never
 *   from an input. Every mutation requires `context.idempotencyKey`.
 * - Inputs are expected to be parsed with the matching `@workloom/contracts` schema. The
 *   application still re-checks capabilities and all cross-entity rules on every call, so
 *   adapters stay thin and must not duplicate business rules.
 * - Task `revision`, `workPackageRevision` and `participantsRevision` are independent
 *   optimistic-concurrency guards; see `updateTaskInputSchema`.
 */
export interface TaskApplication {
  listProjects(context: CommandContext): Promise<ProjectDto[]>;
  getProject(context: CommandContext, projectId: string): Promise<ProjectDto>;
  createProject(context: CommandContext, input: CreateProjectInput): Promise<ProjectDto>;
  updateProject(context: CommandContext, projectId: string, input: UpdateProjectInput): Promise<ProjectDto>;

  listSections(context: CommandContext, projectId: string): Promise<SectionDto[]>;
  createSection(context: CommandContext, projectId: string, input: CreateSectionInput): Promise<SectionDto>;
  updateSection(context: CommandContext, sectionId: string, input: UpdateSectionInput): Promise<SectionDto>;

  listStatuses(context: CommandContext, projectId: string): Promise<TaskStatusDto[]>;

  listTags(context: CommandContext): Promise<TagDto[]>;
  createTag(context: CommandContext, input: CreateTagInput): Promise<TagDto>;
  updateTag(context: CommandContext, tagId: string, input: UpdateTagInput): Promise<TagDto>;

  listTasks(context: CommandContext, input: TaskListQuery): Promise<TaskPage>;
  getTask(context: CommandContext, taskId: string): Promise<TaskDto>;
  createTask(context: CommandContext, input: CreateTaskInput): Promise<TaskDto>;
  updateTask(context: CommandContext, taskId: string, input: UpdateTaskInput): Promise<TaskDto>;
  archiveTask(context: CommandContext, taskId: string, input: ArchiveTaskInput): Promise<TaskDto>;
  restoreTask(context: CommandContext, taskId: string, input: RestoreTaskInput): Promise<TaskDto>;
  /** Manual reorder next to an active sibling; see `moveTaskInputSchema`. */
  moveTask(context: CommandContext, taskId: string, input: MoveTaskInput): Promise<TaskDto>;
}
