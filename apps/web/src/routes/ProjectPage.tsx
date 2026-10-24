import { WorkspaceLink as Link, useWorkspaceNavigate as useNavigate } from '../features/workspace/WorkspaceNavigation';
import { useSharedActivityWorkspace } from '../features/shared-activities/queries';
import { CreateSharedActivityDialog } from '../features/shared-activities/CreateSharedActivityDialog';
import { useDuplication } from '../features/duplication/useDuplication';
import { useProjectPlanningChecks } from '../features/planning-checks/useProjectPlanningChecks';
import { ProjectDateRange } from '../features/projects/ProjectDateRange';
import { useColumnAggregates } from '../features/generic-reports/ColumnAggregates';
import { LinkedProjectTasks } from '../features/project-placements/LinkedProjectTasks';
import { PlacementCommandFeedback } from '../features/project-placements/PlacementCommandFeedback';
import { usePlacementCommands } from '../features/project-placements/queries';
import { BulkCustomFieldCell } from '../features/task-table/BulkCustomFieldCell';
import { usePointerRowDragProtection } from '../features/task-table/usePointerRowDrag';
import { BulkTaskToolbar } from '../features/task-table/BulkTaskToolbar';
import { useBulkInlineEdit } from '../features/task-table/useBulkInlineEdit';
import { captureDraftPlacement, type DraftPlacementSnapshot } from '../features/task-table/draftPlacement';
import { ChoicePicker } from '../shared/ChoicePicker';
import { DialogReturnFocus } from '../shared/DialogShell';
import { useDesktopTaskPane } from '../shared/TaskPanelFrame';
import { compareTaskRows, orderBoardTaskHeads, type TaskSortMode } from '../features/task-table/taskOrdering';
import { buildTableGroups, assigneeGroupKey, type TaskGroupingMode } from '../features/task-table/taskGrouping';
import { TaskCompletionAction } from '../features/tasks/TaskCompletionAction';
import { TaskCompletionFeedback, TaskFeedbackLayer } from '../features/tasks/TaskCompletionFeedback';
import { useTaskCompletion } from '../features/tasks/useTaskCompletion';
import { useCurrentSearchParams } from '../lib/useCurrentSearchParams';
import { TaskBoard, type BoardMoveCard } from '../features/task-board';
import { PersonalColumnsDialog } from '../features/task-table/PersonalColumnsDialog';
import { reconcilePersonalColumns, tableColumnId } from '../features/task-table/personalColumns';
import { usePersonalTablePreference } from '../features/task-table/usePersonalTablePreference';
import { useTableExpansionState } from '../features/task-table/useTableExpansionState';
import { CommentCommandRecovery, useTaskCommentsWorkspace } from '../features/task-comments';
import { ProjectActions } from '../features/projects/ProjectActions';
import { QuickTaskAdd, QuickTaskDraftPreview, type QuickAddCloseReason } from '../features/tasks/QuickTaskAdd';
import { InlineTaskEdit, type InlineCloseReason, type InlineSaveIntent } from '../features/tasks/InlineTaskEdit';
import { TaskCommandRecovery } from '../features/tasks/TaskCommandRecovery';
import { SaveFeedback } from '../shared/SaveFeedback';
import { canEditTaskInline, canMoveTaskSection, isCurrentEstimateProjection, matchesInlineTaskReceipt, taskInlineColumn, type TaskInlineField } from '../features/tasks/tableEditing';
import { message, type TranslationMessage } from '../i18n';
import { useTranslation } from '../i18n';
import { ImportView, ImportNotices } from '../features/imports/ImportView';
import { useImportWorkspace } from '../features/imports/useImportWorkspace';
import { GanttView } from '../features/schedule/GanttView';
import { ScheduleDialog, ScheduleNotices } from '../features/schedule/ScheduleDialog';
import { useScheduleWorkspace } from '../features/schedule/useScheduleWorkspace';
import { GraphView } from '../features/dependencies/GraphView';
import { EdgeDialog } from '../features/dependencies/EdgeDialog';
import { DependencyNotices } from '../features/dependencies/DependencyNotices';
import { useDependencyWorkspace } from '../features/dependencies/useDependencyWorkspace';
import { CreateMeetingDialog } from '../features/meetings/CreateMeetingDialog';
import { MeetingCommandNotices } from '../features/meetings/MeetingDrawer';
import { useMeetingWorkspace } from '../features/meetings/useMeetingWorkspace';
import { usePlanningPeriodsQuery } from '../features/planning/queries';
import type {
  MembershipDto,
  ProjectDto,
  SectionDto,
  TaskDto,
  TaskFieldData,
  TaskFieldDefinitionDto,
  TaskFieldValueDto,
  TaskStatusDto,
  TaskWorkScope,
  WorkspaceDto,
} from '@workloom/contracts';
import { explicitTimeContext, type InitialTimeContext } from '../features/tasks/InitialTaskCells';
import { Badge, Button, Skeleton, StateCard, buttonClassName } from '@workloom/ui';
import { ArrowLeft, Lock, Pencil, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { useLocation, useParams } from 'react-router';
import { InlineFieldValueCell } from '../features/fields/InlineFieldValueCell';
import { fieldRollups } from '../features/fields/rollup';
import { BulkContinueDialog } from '../features/task-continuation/BulkContinueDialog';
import { ContinueInProjectDialog } from '../features/task-continuation/ContinueInProjectDialog';
import { DuplicateProjectDialog } from '../features/project-copy/DuplicateProjectDialog';
import { ProjectRulesDialog } from '../features/project-rules/ProjectRulesDialog';
import { TaskDefaultsDialog } from '../features/task-defaults/TaskDefaultsDialog';
import { useProjectViewMemory } from '../features/projects/projectViewMemory';
import { useAutoLoadTasks } from '../features/tasks/autoLoad';
import { CompletedDateBanner } from '../features/projects/CompletedDateBanner';
import { completedDateIssues } from '../features/projects/dateConsistency';
import { startValuesFromDefaults } from '../features/task-defaults/startValues';
import { useTaskDefaults } from '../features/task-defaults/queries';
import {
  FieldManagerDialog,
  useProjectColumnsQuery,
  useProjectFieldValuesQuery,
  useSetTaskFieldValueMutation,
  useTaskFieldsQuery,
  useFieldValueDrafts,
} from '../features/fields';
import { RenameProjectDialog } from '../features/projects/ProjectDialogs';
import { useProjectQuery, useSectionsQuery, useStatusesQuery, useUpdateSectionMutation } from '../features/projects/queries';
import { RenameSectionDialog } from '../features/projects/SectionDialogs';
import { ProjectCreateMenu } from '../features/projects/ProjectCreateMenu';
import { SectionCreateForm, useSectionCreate } from '../features/projects/SectionCreateForm';
import { TaskTable, buildTaskGroups, visibleTaskRows, dedupeTasks, summarizeWorkPackages, type TaskDropPlacement, type TaskTableCustomColumn, type TaskTableDraftRow, type TaskTableQuickAdd } from '../features/task-table';
import { TagManagerDialog } from '../features/tasks/TagDialogs';
import { TableColumnMenu } from '../features/task-table/TableColumnMenu';
import { ProjectUndoSurface } from '../features/undo/ProjectUndoSurface';
import { TaskDrawer, type LoadedSubtasks } from '../features/tasks/TaskDrawer';
import {
  TaskFilters,
  emptyTaskFilters,
  hasActiveTaskFilters,
  patchTaskFilterParams,
  readTaskFilterParams,
  useDebouncedValue,
  type TaskFilterValue,
} from '../features/tasks/TaskFilters';
import { loadedTaskScope, useReloadTask, useTagsQuery, useTaskListQuery } from '../features/tasks/queries';
import { useTaskCommands, unresolvedTaskCommand, type CreateRequest, type EditSession } from '../features/tasks/useTaskCommands';
import { WorkCategorySettings, useTaskTimeTable } from '../features/work-categories';
import { useMembershipsQuery } from '../features/workspace/queries';
import { isAccessDenied } from '../lib/api';
import { describeError } from '../lib/errors';
import { isUuid } from '../lib/format';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { QueryErrorState } from '../shared/QueryErrorState';
import { useWorkspaceContext } from './WorkspaceLayout';

const SEARCH_DEBOUNCE_MS = 250;

/** Today's calendar date in the workspace time zone, or undefined if the zone is unknown here. */
function todayIn(timeZone: string): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(
      new Date(),
    );
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
    const [year, month, day] = [part('year'), part('month'), part('day')];
    return year && month && day ? `${year}-${month}-${day}` : undefined;
  } catch {
    return undefined;
  }
}

interface FieldColumn {
  field: TaskFieldDefinitionDto;
  width: number;
}

interface QueuedInline {
  taskId: string;
  field: TaskInlineField;
  focus: Element | null;
  /** The list heads loaded when the cell was clicked, before the held answer. */
  listUpdatedAt: number;
  /** Each task command's last result when the cell was clicked. */
  receipts: readonly (TaskDto | undefined)[];
}


/**
 * Enter-continued creation right after a task in manual order. New rows stay at this anchor
 * instead of closing the section; each queued create is placed after its predecessor.
 */
interface QuickInsertion {
  placement?: DraftPlacementSnapshot | null;
  anchorTaskId: string;
  request: CreateRequest;
  /** The unsent input row is shown; submitted rows stay visible after it closes until they resolve. */
  open: boolean;
  /** Confirmed creates of this chain, kept in place until a list loaded after them arrives. */
  confirmed: readonly { task: TaskDto; at: number }[];
}

/** A queued create started from this insertion chain (same section and parent, anchored). */
function belongsToInsertion(request: CreateRequest, insertion: QuickInsertion): boolean {
  return request.sectionId === insertion.request.sectionId && (request.parent?.id ?? null) === (insertion.request.parent?.id ?? null)
    && (request.insertion !== undefined || request.insertionAnchor !== undefined || continuesInPlace(request));
}

/**
 * A first subtask under a parent with no loaded child: drawn right below the parent but sent
 * without an insertion anchor (the parent is not a sibling), so the first body is the legacy
 * parent create and each next row follows the previous confirmed one. Read by the create queue.
 */
type FirstChildRequest = CreateRequest & { continueInPlace?: true };
function continuesInPlace(request: CreateRequest): boolean {
  return (request as FirstChildRequest).continueInPlace === true;
}

function fieldValueKey(taskId: string, fieldId: string): string {
  return `${taskId.toLowerCase()}:${fieldId.toLowerCase()}`;
}

function ValueLoadingCell() {
  const { t } = useTranslation();
  return (
    <>
      <span aria-hidden="true" className="px-1.5 text-subtle">
        …
      </span>
      <span className="sr-only">{t('projects.projectPage.loadingValue')}</span>
    </>
  );
}

function ValueUnavailableCell() {
  const { t } = useTranslation();
  return <span className="truncate px-1.5 text-xs text-amber-800">{t('projects.projectPage.notLoaded')}</span>;
}

/** Fetches the project with the route guard; the loaded content owns every other query. */
export function ProjectPage() {
  const { t } = useTranslation();
  const { actorId, workspace } = useWorkspaceContext();
  const { projectId = '' } = useParams();
  const project = useProjectQuery(actorId, workspace.id, projectId);
  const projectsHref = `/w/${workspace.id}/projects`;
  useDocumentTitle(project.isSuccess ? `${project.data.name} · ${workspace.name}` : t('projects.projectPage.projectValue', { p0: workspace.name }));

  if (!isUuid(projectId)) return <ProjectUnavailable projectsHref={projectsHref} />;

  if (project.isPending) {
    return (
      <div role="status" className="space-y-4">
        <span className="sr-only">{t('projects.projectPage.loadingProject')}</span>
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-8 w-72 max-w-full" />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    );
  }

  // Errors win over loaded data, so a denied refetch hides the project.
  if (project.isError) {
    if (describeError(project.error, 'project').unavailable) return <ProjectUnavailable projectsHref={projectsHref} />;
    return (
      <QueryErrorState
        error={project.error}
        subject="project"
        headingLevel={1}
        retrying={project.isFetching}
        onRetry={() => void project.refetch()}
      />
    );
  }

  return (
    <ProjectContent
      key={`${actorId}:${workspace.id}:${project.data.id}`}
      actorId={actorId}
      workspace={workspace}
      project={project.data}
      projectsHref={projectsHref}
    />
  );
}

interface ProjectContentProps {
  actorId: string;
  workspace: WorkspaceDto;
  project: ProjectDto;
  projectsHref: string;
}

function ProjectContent({ actorId, workspace, project, projectsHref }: ProjectContentProps) {
  const acquireDragProtection = usePointerRowDragProtection();
  const { t, locale } = useTranslation();
  const sections = useSectionsQuery(actorId, workspace.id, project.id);
  const statuses = useStatusesQuery(actorId, workspace.id, project.id);
  const members = useMembershipsQuery(actorId, workspace.id);
  const tags = useTagsQuery(actorId, workspace.id);
  const personalColumns = usePersonalTablePreference(actorId, workspace.id, project.id, members.data?.find(member => member.userId === actorId)?.id ?? '');
  // Owned here so that closing the drawer keeps uncertain commands and drafts.
  const commands = useTaskCommands(actorId, workspace.id, workspace.role === 'owner' || workspace.role === 'admin');
  const commentsController = useTaskCommentsWorkspace(actorId, workspace.id);
  const placementCommands = usePlacementCommands(actorId, workspace.id);
  const dependencies = useDependencyWorkspace(actorId, workspace.id, project.id);
  const schedule = useScheduleWorkspace(actorId, workspace.id, project.id, workspace.timezone);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const selectionLedger = useRef(new Map<string, TaskDto>());
  const reloadSelectedTask = useReloadTask(actorId, workspace.id);
  const selectionScope = `${actorId}:${workspace.id}:${project.id}`;
  const selectionScopeHead = useRef(selectionScope);
  useLayoutEffect(() => { selectionScopeHead.current = selectionScope; }, [selectionScope]);
  useEffect(() => { selectionLedger.current.clear(); setSelectedTaskIds([]); }, [actorId, workspace.id, project.id]);
  const activeViewControl = useRef<HTMLButtonElement | null>(null);
  const defaultColumnReturn = useRef<HTMLElement | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const meetingController=useMeetingWorkspace(actorId,workspace.id,project.id);
  const sharedActivityController=useSharedActivityWorkspace(actorId,workspace.id,project.id);
  const meetingPeriods=usePlanningPeriodsQuery(actorId,workspace.id,project.id);
  // Same for custom field values: a hidden drawer keeps a value write that is pending or unconfirmed.
  const fieldValueMutation = useSetTaskFieldValueMutation(actorId, workspace.id);
  const fieldValueDrafts = useFieldValueDrafts(actorId, workspace.id, project.id, fieldValueMutation);
  const fieldDefinitions = useTaskFieldsQuery(actorId, workspace.id, project.id);
  const projectColumns = useProjectColumnsQuery(actorId, workspace.id, project.id);
  const renameSectionMutation = useUpdateSectionMutation(actorId, workspace.id);
  const [fieldManagerInitialId, setFieldManagerInitialId] = useState<string | null>(null);
  const [fieldManagerOpen, setFieldManagerOpen] = useState(false);
  const [continueTask, setContinueTask] = useState<TaskDto | null>(null);
  const [bulkContinueTasks, setBulkContinueTasks] = useState<readonly TaskDto[] | null>(null);
  const [renamingSection, setRenamingSection] = useState<SectionDto | null>(null);
  const [creating, setCreating] = useState<CreateRequest | null>(null);
  const [quickAddSection, setQuickAddSection] = useState<string | null | undefined>(undefined);
  const [insertion, setInsertion] = useState<QuickInsertion | null>(null);
  const queuedRowKeys = useRef({ next: 0, keys: new WeakMap<object, string>() });
  const queuedRowKey = (session: object) => {
    const known = queuedRowKeys.current.keys.get(session);
    if (known) return known;
    const key = `queued-${++queuedRowKeys.current.next}`;
    queuedRowKeys.current.keys.set(session, key);
    return key;
  };
  const inlineGeneration = useRef(0);
  const inlineReceipt = useRef<{ task: TaskDto; field: TaskInlineField; generation: number; presentationKey: string } | null>(null);
  const inlineFocusReturn = useRef<{ task: TaskDto; field: TaskInlineField; generation: number; presentationKey: string; ownsFocus: () => boolean; dispose: () => void } | null>(null);
  const inlineLeases = useRef(new Set<() => void>());
  const [savedAssignment, setSavedAssignment] = useState<{ taskId: string; membershipId: string | null; revision: number; generation: number } | null>(null);
  // A cell clicked while another task save is still being sent opens once that answer arrives
  // and, after a confirmed write, once the list has refetched heads at least that new.
  const [queuedInline, setQueuedInline] = useState<QueuedInline | null>(null);
  const commandReceipts = () => [commands.update.data, commands.archive.data, commands.restore.data, commands.create.data];
  // A title save whose editor already continued into the next new task. Its exact retained
  // session ties page-level progress, outcome feedback and recovery to that one command.
  const [continuation, setContinuation] = useState<{ taskId: string; session: EditSession } | null>(null);
  const invalidateInlineSave = useCallback(() => {
    inlineGeneration.current += 1;
    inlineReceipt.current = null;
    setQueuedInline(null);
    for (const dispose of inlineLeases.current) dispose();
    inlineFocusReturn.current?.dispose();
    inlineFocusReturn.current = null;
    setSavedAssignment(null);
  }, []);
  useEffect(() => () => {
    inlineGeneration.current += 1;
    for (const dispose of inlineLeases.current) dispose();
  }, []);
  const [grouping, setGrouping] = useState<TaskGroupingMode>('section');
  const [activeInline, setActiveInline] = useState<{ taskId: string; field: TaskInlineField; focusClaim: { current: boolean }; titleCaret?: number | undefined } | null>(null);
  const [announcement, setAnnouncement] = useState<TranslationMessage | null>(null);
  // Completion, status, participant, tag and archived are validated URL state; search text stays in memory.
  const [searchText, setSearchText] = useState(emptyTaskFilters.search);
  const search = useDebouncedValue(searchText.trim(), SEARCH_DEBOUNCE_MS);
  const [searchParams, setSearchParams] = useCurrentSearchParams();
  const urlFilters = readTaskFilterParams(searchParams);
  const filters: TaskFilterValue = { ...urlFilters, search: searchText };
  const changeFilters = (next: TaskFilterValue) => {
    invalidateInlineSave();
    setSearchText(next.search);
    // Only changed filters are patched onto the current URL head; a search edit never navigates.
    setSearchParams(before => patchTaskFilterParams(before, urlFilters, next));
  };
  useProjectViewMemory({
    actorId, workspaceId: workspace.id, projectId: project.id, searchParams, grouping,
    restore: (params, group) => { setSearchParams(() => new URLSearchParams(params), { replace: true }); setGrouping(group === 'assignee' ? 'assignee' : 'section'); },
  });
  const sortMode: TaskSortMode = searchParams.getAll('sort').length === 1 && searchParams.get('sort') === 'due_asc' ? 'due_asc' : 'manual';
  const taskId = searchParams.get('task');
  const desktopTaskPane = useDesktopTaskPane(taskId !== null);
  const boardMode = searchParams.get('view') === 'board';
  const graphMode = searchParams.get('view') === 'graph';
  const ganttMode = searchParams.get('view') === 'gantt';
  const importMode = searchParams.get('view') === 'import';
  const tableMode = !boardMode && !graphMode && !ganttMode && !importMode;
  const showTaskFilters = tableMode || boardMode || ganttMode;
  const importId = searchParams.get('import') ?? '';
  const selectImport = useCallback((id: string) => setSearchParams(before => { const next = new URLSearchParams(before); next.set('view', 'import'); if (id) next.set('import', id); else next.delete('import'); return next; }), [setSearchParams]);
  const imports = useImportWorkspace(actorId, workspace.id, project.id, isUuid(importId) ? importId : '', selectImport);

  const tasks = useTaskListQuery(actorId, workspace.id, {
    projectId: project.id,
    sort: sortMode === 'due_asc' ? 'due_asc' : undefined,
    search,
    completion: filters.completion === 'open' ? 'open' : undefined,
    statusId: filters.statusId || undefined,
    tagId: filters.tagId || undefined,
    participantMembershipId: filters.participantMembershipId || undefined,
    includeArchived: filters.includeArchived,
  });

  const canEdit = workspace.role !== 'viewer';
  const writable = canEdit && project.archivedAt === null;
  // The server enforces the role; this only hides controls that would be refused.
  const canManageFields = (workspace.role === 'owner' || workspace.role === 'admin') && project.archivedAt === null;
  const canManageImports = workspace.role === 'owner' || workspace.role === 'admin';

  // Values are requested, in batches, only for the tasks the table shows and only while a custom column is visible.
  // A deleted task stays out of the table until a finished refetch no longer lists it, so a stale
  // response cannot flash it back. A rejected delete releases it.
  const [deletedTaskIds, setDeletedTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const shownTasks = useMemo(() => {
    if (tasks.data === undefined || (tasks.isError && !tasks.isFetchNextPageError)) return [];
    return withoutDeletedTasks(loadedTaskScope(tasks.data).tasks, deletedTaskIds);
  }, [tasks.data, tasks.isError, tasks.isFetchNextPageError, deletedTaskIds]);
  useEffect(() => {
    if (deletedTaskIds.size === 0 || tasks.isFetching || tasks.data === undefined) return;
    const listed = new Set(loadedTaskScope(tasks.data).tasks.map(task => task.id));
    const remaining = [...deletedTaskIds].filter(id => listed.has(id));
    if (remaining.length !== deletedTaskIds.size) setDeletedTaskIds(new Set(remaining));
  }, [deletedTaskIds, tasks.data, tasks.isFetching]);
  const loadedTaskIds = useMemo(() => shownTasks.map(task => task.id), [shownTasks]);
  useAutoLoadTasks(tasks, shownTasks.length);
  const { collapsedTaskIds, expandedTaskIds, collapsedGroupKeys, setTaskCollapsed, setGroupCollapsed } = useTableExpansionState(
    { actorId, workspaceId: workspace.id, projectId: project.id }, loadedTaskIds,
  );
  const changeTaskCollapsed = useCallback((taskId: string, collapsed: boolean) => {
    invalidateInlineSave();
    setTaskCollapsed(taskId, collapsed);
  }, [invalidateInlineSave, setTaskCollapsed]);
  const changeGroupCollapsed = useCallback((key: string, collapsed: boolean) => {
    invalidateInlineSave();
    setGroupCollapsed(key, collapsed);
  }, [invalidateInlineSave, setGroupCollapsed]);
  const loadedPackages = useMemo(() => summarizeWorkPackages(shownTasks), [shownTasks]);
  // Use the same root hierarchy as the table: a child can belong to another section's group.
  const sectionGroups = useMemo(() => buildTaskGroups(shownTasks, sections.data ?? [], locale), [shownTasks, sections.data, locale]);
  const taskGroups = useMemo(() => buildTableGroups(shownTasks, sections.data ?? [], members.data ?? [], grouping, locale, sortMode), [shownTasks, sections.data, members.data, grouping, locale, sortMode]);
  const sectionHiddenTaskIds = useMemo(() => new Set(taskGroups.flatMap(group => {
    const visible = new Set(collapsedGroupKeys.has(group.key) ? [] : visibleTaskRows(group.roots, collapsedTaskIds).map(node => node.task.id));
    return visibleTaskRows(group.roots, new Set()).filter(node => !visible.has(node.task.id)).map(node => node.task.id);
  })), [taskGroups, collapsedGroupKeys, collapsedTaskIds]);
  const { roots: graphRoots, setRoots: setGraphRoots, setRootOrigin: setGraphRootOrigin } = dependencies;
  useEffect(() => {
    if (!graphMode || graphRoots !== null || !tasks.isSuccess) return;
    const initialRoots = selectedTaskIds.length ? selectedTaskIds : dedupeTasks(shownTasks).map(task => task.id);
    if (initialRoots.length > 100) return;
    setGraphRoots(initialRoots);
    setGraphRootOrigin(selectedTaskIds.length ? 'selected' : 'loaded');
  }, [graphMode, graphRoots, setGraphRoots, setGraphRootOrigin, tasks.isSuccess, selectedTaskIds, shownTasks]);
  const taskTime = useTaskTimeTable({
    actorId, workspace, project, members: members.isSuccess ? members.data : [], tasks: dedupeTasks(shownTasks),
    hasMoreTasks: tasks.hasNextPage, loadingMoreTasks: tasks.isFetchingNextPage,
    onOpenMeeting:(id,tab,selection)=>{setSearchParams(before=>{const next=new URLSearchParams(before);next.set('task',id);next.set('meetingTab',tab);if(selection?.requestedPeriodId)next.set('meetingPeriod',selection.requestedPeriodId);else next.delete('meetingPeriod');if(selection?.membershipId)next.set('meetingMember',selection.membershipId);else next.delete('meetingMember');if(selection?.attendanceId)next.set('meetingAttendance',selection.attendanceId);else next.delete('meetingAttendance');return next;});},
    onLoadTasks: () => void tasks.fetchNextPage(), accessDenied: isAccessDenied(members.error) || isAccessDenied(tasks.error),
  });
  const timeAvailable = searchParams.get('legacyTime') === '1';
  const reconciledColumns = useMemo(() => reconcilePersonalColumns(personalColumns.query.data?.columns ?? null,
    fieldDefinitions.isSuccess ? fieldDefinitions.data : [], projectColumns.isSuccess ? projectColumns.data : { workspaceId: workspace.id, projectId: project.id, revision: 1, columns: [] }, timeAvailable),
    [personalColumns.query.data?.columns, fieldDefinitions.data, fieldDefinitions.isSuccess, projectColumns.data, projectColumns.isSuccess, workspace.id, project.id, timeAvailable]);
  const ordinaryAggregates = useColumnAggregates({ actorId, workspaceId: workspace.id, projectId: project.id, projectDateRange: project.dateRange ?? null, projectRevision: project.revision, fields: fieldDefinitions.data ?? [], members: members.data ?? [], sections: sections.data ?? [], grouping, filters: { ...filters, search }, writable, enabled: tableMode && !timeAvailable && fieldDefinitions.isSuccess && projectColumns.isSuccess && members.isSuccess && !personalColumns.denied });
  const planningChecks = useProjectPlanningChecks({ templateController: ordinaryAggregates.templateController, actorId, workspaceId: workspace.id, projectId: project.id, projectRevision: project.revision, fields: fieldDefinitions.data ?? [], members: members.data ?? [], sections: sections.data ?? [], tags: tags.data ?? [], enabled: tableMode && !timeAvailable && fieldDefinitions.isSuccess && members.isSuccess && !personalColumns.denied, writable: canManageFields, requestedOpen: searchParams.get('checks') === '1', requestedFieldId: searchParams.get('checkField') ?? undefined, onOpenTask: id => openTask(id) });
  const duplication = useDuplication({ actorId, workspaceId: workspace.id, projectId: project.id, fields: fieldDefinitions.data ?? [], members: members.data ?? [], writable, onDuplicated: result => { setAnnouncement(message(result.kind === 'task' ? 'duplication.createdTask' : 'duplication.createdSection')); if (result.rootTaskId !== null) openTask(result.rootTaskId); } });
  const visibleColumnIds = useMemo(() => reconciledColumns.effectiveVisibleRefs.map(tableColumnId), [reconciledColumns]);
  const fieldColumns: FieldColumn[] = reconciledColumns.effectiveVisibleRefs.flatMap(ref => {
    if (ref.kind !== 'field' || !fieldDefinitions.isSuccess || !projectColumns.isSuccess) return [];
    const field = fieldDefinitions.data.find(item => item.id === ref.fieldId && item.projectId === project.id && item.workspaceId === workspace.id && item.archivedAt === null);
    return field ? [{ field, width: projectColumns.data.columns.find(column => column.fieldId === field.id)?.width ?? 160 }] : [];
  });
  useEffect(() => {
    if (!activeInline) return;
    const column = taskInlineColumn(activeInline.field);
    if (graphMode || ganttMode || importMode || (boardMode ? activeInline.field !== 'statusId' : !visibleColumnIds.includes(column))) setActiveInline(null);
  }, [activeInline, visibleColumnIds, boardMode, graphMode, ganttMode, importMode]);
  const fieldValues = useProjectFieldValuesQuery(
    actorId,
    workspace.id,
    project.id,
    !personalColumns.denied && fieldColumns.length > 0 ? shownTasks.map((task) => task.id) : [],
  );
  const taskDefaults = useTaskDefaults(actorId, workspace.id, project.id);
  const valueByKey = new Map<string, TaskFieldValueDto>(
    fieldValues.data.map((value) => [fieldValueKey(value.taskId, value.fieldId), value]),
  );
  // A selected row of a multi-selection never writes a team column alone; one already held keeps its recovery.
  const customBlockedByBulk = (task: TaskDto, fieldId: string) => {
    const session = fieldValueDrafts.current.getTask(task.id)[fieldId.toLowerCase()];
    // An already-open one-task editor stays one-task too, when the selection changes around it.
    const capturedBulk = session ? bulkInline.port(session.identity) !== undefined : bulkInline.selectsMany(task.id);
    return capturedBulk && heldFieldTaskId?.toLowerCase() !== task.id.toLowerCase();
  };
  const filtered = hasActiveTaskFilters({ ...filters, includeArchived: false });
  // Offered after "Create next copy": top-level open tasks, only when the whole project is on screen (no filter, every page loaded).
  const unfinishedTasks = useMemo(() => {
    if (filtered || tasks.hasNextPage || !tasks.isSuccess) return [];
    const groups = new Map((statuses.data ?? []).map(status => [status.id, status.group]));
    return dedupeTasks(shownTasks).filter(task => task.parentTaskId === null && task.archivedAt === null && task.meetingId === null && (groups.get(task.statusId) === 'todo' || groups.get(task.statusId) === 'in_progress'));
  }, [filtered, tasks.hasNextPage, tasks.isSuccess, statuses.data, shownTasks]);
  // Subtask totals are only offered once every task of the project is loaded and no filter hides some of them; a partial tree would give a wrong sum.
  const rollupsByField = new Map(fieldColumns.map(({ field }) => [field.id, tasks.hasNextPage || filtered ? new Map<string, TaskFieldData>() : fieldRollups(field, shownTasks, taskId => valueByKey.get(fieldValueKey(taskId, field.id)))]));
  const customColumns: TaskTableCustomColumn[] = fieldColumns.map(({ field, width }) => ({
    id: field.id,
    label: field.name,
    onEdit: canManageFields ? () => { setFieldManagerInitialId(field.id); setFieldManagerOpen(true); } : undefined,
    onConfigureCheck: planningChecks.configureField ? () => planningChecks.configureField?.(field.id) : undefined,
    width,
    // An unloaded value is not an unset one: `null` is shown, and offered for a choice, only after a known read.
    renderCell: (task) => {
      if (fieldValues.isError) return <ValueUnavailableCell />;
      if (fieldValues.isPending) return <ValueLoadingCell />;
      const blocked = customBlockedByBulk(task, field.id);
      if (blocked) return <BulkCustomFieldCell advisory={planningChecks.fieldAdvisory(task, field)} task={task} field={field} value={valueByKey.get(fieldValueKey(task.id, field.id)) ?? null} members={members.data ?? []}
        writable={writable && canEditTaskInline(task)} busy={bulkInline.busy} drafts={fieldValueDrafts.current} onMoreDetails={() => openTask(task.id)}
        capture={(claim, baseField, baseValue) => bulkInline.captureCustom(task, baseField, baseValue, claim)} port={claim => bulkInline.port(claim)} />;
      const cell = (
        <InlineFieldValueCell
          advisory={planningChecks.fieldAdvisory(task, field)}
          inherited={rollupsByField.get(field.id)?.get(task.id) ?? null}
          actorId={actorId}
          workspaceId={workspace.id}
          task={task}
          field={field}
          value={valueByKey.get(fieldValueKey(task.id, field.id)) ?? null}
          members={members.data ?? []}
          writable={writable && canEditTaskInline(task) && !blocked}
          mutation={fieldValueMutation}
          drafts={fieldValueDrafts.current}
          onMoreDetails={() => openTask(task.id)}
        />
      );
      return blocked ? <span title={t('bulkInline.customUnsupported')} className="flex h-10 min-w-0 flex-1 items-center">{cell}<span className="sr-only">{t('bulkInline.customUnsupported')}</span></span> : cell;
    },
  }));
  const fieldsError = fieldDefinitions.isError
    ? { query: fieldDefinitions, subject: 'fields' as const }
    : projectColumns.isError
      ? { query: projectColumns, subject: 'columns' as const }
      : fieldColumns.length > 0 && fieldValues.isError
        ? { query: fieldValues, subject: 'fieldValues' as const }
        : null;

  // A value write still being sent or unconfirmed stays reachable while its task is not open.
  const heldFieldValue = fieldValueMutation.uncertain ?? fieldValueMutation.pendingCommand;
  const heldFieldTaskId = heldFieldValue?.variables.taskId ?? null;
  // A value still being sent from a visible table cell shows its spinner there; a page notice would shift the grid.
  const heldFieldVisibleInCell = fieldValueMutation.uncertain === null && heldFieldValue !== null && tableMode && !personalColumns.denied
    && fieldColumns.some(column => column.field.id.toLowerCase() === heldFieldValue.variables.fieldId.toLowerCase())
    && shownTasks.some(task => task.id.toLowerCase() === heldFieldValue.variables.taskId.toLowerCase() && !sectionHiddenTaskIds.has(task.id));
  const showHeldFieldValue = heldFieldTaskId !== null && taskId?.toLowerCase() !== heldFieldTaskId.toLowerCase() && !heldFieldVisibleInCell;
  const metadata = [
    { query: sections, subject: 'sections' },
    { query: statuses, subject: 'statuses' },
    { query: members, subject: 'members' },
    { query: tags, subject: 'tags' },
  ] as const;
  const metadataError = metadata.find((item) => item.query.isError);
  const importCatalogDenied = [members.error, sections.error, statuses.error, tags.error, fieldDefinitions.error].some(isAccessDenied);
  const noteImportDenied = imports.noteDenied;
  useLayoutEffect(() => { if (importCatalogDenied) noteImportDenied(); }, [importCatalogDenied, noteImportDenied]);
  const refreshImportCatalog = async () => (await Promise.all([members.refetch(), sections.refetch(), statuses.refetch(), tags.refetch(), fieldDefinitions.refetch()])).every(result => result.isSuccess);
  // The editor waits for real sections, statuses, members and tags.
  const metadataReady = metadataError === undefined && metadata.every((item) => item.query.isSuccess);
  const completionWritable = writable && metadataReady && !personalColumns.denied && !isAccessDenied(tasks.error);
  useEffect(() => { commands.autosave.setWritable(completionWritable); }, [commands.autosave, completionWritable]);
  const taskPresentationKey = JSON.stringify([actorId, workspace.id, project.id, location.key, grouping, filters.search, filters.completion, filters.statusId, filters.participantMembershipId, filters.tagId, filters.includeArchived, sortMode]);
  const sectionCreate = useSectionCreate(actorId, workspace.id, project.id, completionWritable, taskPresentationKey, section => setAnnouncement(message('projects.projectPage.sectionValueCreated', { p0: section.name })));
  const showSections = () => {
    invalidateInlineSave(); setGrouping('section');
    if (!tableMode) setSearchParams(before => { const next = new URLSearchParams(before); next.delete('view'); return next; });
  };
  const startSection = () => { showSections(); sectionCreate.start(); };
  const sectionComposerVisible = tableMode && grouping === 'section' && !personalColumns.denied && !tasks.isPending && (!tasks.isError || tasks.isFetchNextPageError);
  useLayoutEffect(() => {
    const id = sectionCreate.revealSectionId;
    if (!id || !completionWritable || !sectionComposerVisible || !sections.isSuccess || sections.isFetching) return;
    const header = document.querySelector<HTMLButtonElement>(`button[data-task-group="section:${id}"]`);
    if (!header || !sectionCreate.claimSectionReveal()) return;
    // Claim only after the fresh authorized section has rendered; keep the person's horizontal context.
    const scroller = header.closest<HTMLElement>('[data-task-table-scroll]'), left = scroller?.scrollLeft;
    header.focus({ preventScroll: true }); header.scrollIntoView({ block: 'center', inline: 'nearest' });
    if (scroller && left !== undefined) scroller.scrollLeft = left;
  }, [sectionCreate, completionWritable, sectionComposerVisible, sections.isSuccess, sections.isFetching]);
  const previousPresentation = useRef(taskPresentationKey);
  useLayoutEffect(() => {
    if (previousPresentation.current !== taskPresentationKey) invalidateInlineSave();
    previousPresentation.current = taskPresentationKey;
  }, [taskPresentationKey, invalidateInlineSave]);
  const completion = useTaskCompletion(commands, { tasks: dedupeTasks(shownTasks), statuses: statuses.data ?? [], writable: completionWritable, editingTaskId: activeInline?.taskId ?? null, focusScope: taskPresentationKey }, () => setAnnouncement(message('tasks.completion.saved')));
  // A selected row's cell or circle in a multi-selection: one atomic batch to the selection frozen when it opened.
  const bulkInline = useBulkInlineEdit(commands, {
    projectId: project.id, selectedTaskIds, shownTasks, ledger: selectionLedger.current, writable: completionWritable,
    fieldValues: fieldValues.data, fields: fieldDefinitions.data, knownFieldTaskIds: !fieldValues.isPending && !fieldValues.isError ? shownTasks.map(task => task.id) : [],
    busy: commands.quick.queue.length > 0 || commands.quick.sending || tasks.isFetching,
    onConfirmed: rows => { for (const row of rows) if (row.projectId === project.id) selectionLedger.current.set(row.id, row); },
    onAnnounce: setAnnouncement,
  });

  const inlineHead = useRef({ activeInline, loadedPackages, grouping, sortMode, shownTasks, presentationKey: taskPresentationKey, completionWritable });
  useLayoutEffect(() => { inlineHead.current = { activeInline, loadedPackages, grouping, sortMode, shownTasks, presentationKey: taskPresentationKey, completionWritable }; });
  // Plain Enter on a saved or unchanged root-task title continues with a new task in its section.
  const nextTaskSection = (task: TaskDto): string | null | undefined => {
    const head = inlineHead.current;
    if (head.grouping !== 'section' || !head.completionWritable || task.parentTaskId !== null || !canEditTaskInline(task)) return undefined;
    if (task.sectionId === null) return null;
    const section = sections.data?.find(item => item.id === task.sectionId);
    return section && section.archivedAt === null ? section.id : undefined;
  };
  // In manual order the new task goes right after the task (root or subtask), as its sibling.
  // Other orders keep the section-end row; the person's sort and filters are never reset.
  const insertionTarget = (task: TaskDto): { sectionId: string | null; parent: TaskDto | null } | undefined => {
    const head = inlineHead.current;
    if (head.sortMode !== 'manual' || !head.completionWritable || !canEditTaskInline(task)) return undefined;
    if (task.sectionId !== null && sections.data?.find(item => item.id === task.sectionId)?.archivedAt !== null) return undefined;
    if (task.parentTaskId === null) return { sectionId: task.sectionId, parent: null };
    // The child request carries the full loaded parent, so detail estimates inherit as in the drawer.
    const parent = dedupeTasks(head.shownTasks).find(item => item.id === task.parentTaskId);
    return parent && parent.archivedAt === null && parent.meetingId === null ? { sectionId: task.sectionId, parent } : undefined;
  };
  const insertionAfter = (anchor: TaskDto, target: { sectionId: string | null; parent: TaskDto | null }): QuickInsertion => {
    const group = taskGroups.find(item => visibleTaskRows(item.roots, new Set()).some(node => node.task.id === anchor.id));
    const placement = group ? captureDraftPlacement(group, anchor.id) : null;
    return {
      anchorTaskId: anchor.id, placement,
      request: { sectionId: target.sectionId, parent: target.parent, insertion: { anchorTaskId: anchor.id, placement: 'after' },
        ...(placement?.defaultResponsibleMembershipId !== undefined ? { defaultResponsibleMembershipId: placement.defaultResponsibleMembershipId } : {}) },
      open: true, confirmed: [],
    };
  };
  const continuable = (task: TaskDto) => insertionTarget(task) !== undefined || nextTaskSection(task) !== undefined;
  const continueAfter = (task: TaskDto) => {
    const target = insertionTarget(task);
    if (target) { startInsertion(task, target); return; }
    const next = nextTaskSection(task);
    if (next !== undefined) startQuickAdd(next);
  };
  const beginInlineSave = (form: HTMLFormElement, intent: InlineSaveIntent) => {
    inlineFocusReturn.current?.dispose();
    inlineFocusReturn.current = null;
    inlineReceipt.current = null;
    const generation = ++inlineGeneration.current;
    setSavedAssignment(null);
    const origin = inlineHead.current;
    let ownsFocus = form.contains(document.activeElement);
    let waitingForHead = false;
    const pointer = (event: PointerEvent) => { if (event.target instanceof Node && !form.contains(event.target)) ownsFocus = false; };
    const focus = (event: FocusEvent) => { if (event.target instanceof Node && event.target !== document.body && !form.contains(event.target)) ownsFocus = false; };
    const blur = () => { ownsFocus = false; };
    window.addEventListener('blur', blur);
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('focusin', focus, true);
    const dispose = () => {
      window.removeEventListener('blur', blur);
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('focusin', focus, true);
      inlineLeases.current.delete(dispose);
    };
    inlineLeases.current.add(dispose);
    const sourceTask = origin.activeInline?.field === 'title' && intent.continueWithNext
      ? dedupeTasks(shownTasks).find(task => task.id === origin.activeInline?.taskId) : undefined;
    const immediateInsertion = sourceTask ? insertionTarget(sourceTask) : undefined;
    const immediateNext = immediateInsertion !== undefined ? immediateInsertion.sectionId : sourceTask ? nextTaskSection(sourceTask) : undefined;
    const continuedSession = sourceTask ? commands.editSessions.current.get(sourceTask.id) : undefined;
    const continued = immediateNext !== undefined && ownsFocus && sourceTask !== undefined && continuedSession !== undefined;
    if (continued) {
      // The update keeps its original retained session, while the next row accepts unsent
      // titles immediately. Its create queue waits for this update's confirmed result.
      // As in startQuickAdd, a retained quick draft keeps its own section and place.
      const kept = commands.createSession.current;
      const resumes = kept !== null && kept.origin === 'quick';
      const target = resumes ? kept.request.sectionId : immediateNext;
      setContinuation({ taskId: sourceTask.id, session: continuedSession });
      if (!resumes && immediateInsertion !== undefined && commands.quick.queue.length === 0) setInsertion(insertionAfter(sourceTask, immediateInsertion));
      else setInsertion(before => before && { ...before, open: kept !== null && kept.origin === 'quick' && belongsToInsertion(kept.request, before) });
      expandQuickSection(target);
      setActiveInline(null);
      setQuickAddSection(target);
    }
    const isCurrent = () => {
      const head = inlineHead.current;
      return inlineGeneration.current === generation && head.completionWritable &&
        head.activeInline?.focusClaim === origin.activeInline?.focusClaim &&
        head.presentationKey === origin.presentationKey;
    };
    return {
      onSettled: () => { if (!waitingForHead) dispose(); },
      onSuccess: (confirmed: TaskDto) => {
        if (continued) {
          // The editor already continued: announce the one confirmation without moving focus.
          setContinuation(before => before?.session === continuedSession ? null : before);
          setAnnouncement(message('tasks.taskDrawer.taskSaved'));
          return;
        }
        if (!origin.activeInline || !isCurrent()) return;
        const field = origin.activeInline.field;
        // The command/session ledger already confirmed this precise submitted draft.
        setActiveInline(null);
        setAnnouncement(message('tasks.taskDrawer.taskSaved'));
        if (field === 'sectionId') {
          // The row leaves its group: say where it went and keep that group open to show it.
          const target = confirmed.sectionId === null ? null : sections.data?.find(section => section.id === confirmed.sectionId);
          setAnnouncement(message('taskTable.sectionMove.moved', { title: confirmed.title, section: confirmed.sectionId === null ? t('tasks.taskFields.noSection') : target?.name ?? t('tasks.taskFields.sectionUnavailable') }));
          if (origin.grouping === 'section') expandQuickSection(confirmed.sectionId);
        }
        if (field === 'responsibleMembershipId' && origin.grouping === 'assignee') {
          inlineReceipt.current = { task: confirmed, field, generation, presentationKey: origin.presentationKey };
        }
        if (!ownsFocus) return;
        if (intent.continueWithNext && field === 'title' && continuable(confirmed)) { dispose(); continueAfter(confirmed); return; }
        waitingForHead = true;
        inlineFocusReturn.current = { task: confirmed, field, generation, presentationKey: origin.presentationKey, ownsFocus: () => ownsFocus, dispose };
      },
    };
  };

  // A task write refetches list heads asynchronously. Wait for that head and the new
  // row/card to commit, rather than focusing a source button that is about to unmount.
  useLayoutEffect(() => {
    if (activeInline !== null || tasks.isFetching) return;
    const receipt = inlineReceipt.current;
    if (receipt) {
      const current = dedupeTasks(shownTasks).find(task => task.id === receipt.task.id);
      if (receipt.generation === inlineGeneration.current && receipt.presentationKey === taskPresentationKey && completionWritable && current && canEditTaskInline(current) && matchesInlineTaskReceipt(current, receipt.task, receipt.field)) {
        setSavedAssignment({ taskId: current.id, membershipId: current.responsibleMembershipId, revision: current.revision, generation: receipt.generation });
      }
      inlineReceipt.current = null;
    }
    const intent = inlineFocusReturn.current;
    if (!intent) return;
    if (intent.generation !== inlineGeneration.current || intent.presentationKey !== taskPresentationKey || !completionWritable || !intent.ownsFocus()) {
      intent.dispose();
      inlineFocusReturn.current = null;
      return;
    }
    const current = dedupeTasks(shownTasks).find(task => task.id === intent.task.id);
    if (!current || !canEditTaskInline(current) || !matchesInlineTaskReceipt(current, intent.task, intent.field) || (intent.field === 'estimate' && !isCurrentEstimateProjection(current, loadedPackages.packages))) {
      intent.dispose();
      inlineFocusReturn.current = null;
      return;
    }
    const cell = document.querySelector<HTMLButtonElement>(`button[data-task-cell="${intent.task.id}:${intent.field}"]`);
    const group = grouping === 'assignee' ? document.querySelector<HTMLButtonElement>(`button[data-task-group="${assigneeGroupKey(current.responsibleMembershipId)}"]`) : null;
    const target = cell ?? group;
    // Remove the lease before our deliberate focus transfer.
    intent.dispose();
    if (target) target.focus();
    inlineFocusReturn.current = null;
  }, [activeInline, tasks.isFetching, shownTasks, taskPresentationKey, completionWritable, grouping, loadedPackages]);

  const setTaskParam = (next: string | null) =>
    setSearchParams((previous) => {
      const params = new URLSearchParams(previous);
      if (next === null) params.delete('task');
      else params.set('task', next);
      return params;
    });

  const openTask = (id: string) => {
    if (taskId !== null) commands.autosave.flush(taskId);
    invalidateInlineSave();
    // Its own editor now shows the continued save's state and feedback.
    setContinuation(before => before?.taskId === id ? null : before);
    setQuickAddSection(undefined);
    setActiveInline(null);
    setCreating(null);
    setSearchParams(before=>{const next=new URLSearchParams(before);next.set('task',id);for(const key of ['meetingTab','meetingMember','meetingAttendance','meetingPeriod'])next.delete(key);return next;});
  };
  const completionAction = (task: TaskDto) => <TaskCompletionAction task={task} statuses={statuses.data ?? []} writable={completionWritable} blocked={unresolvedTaskCommand(commands) !== null} pending={(completion.pending && completion.attempt?.session.base.id === task.id) || bulkInline.completionPending(task.id)} hasDraft={commands.editSessions.current.has(task.id)} editing={activeInline?.taskId === task.id}
    // The circle's own choice for its row goes to the whole selection it belongs to.
    onChoose={(chosen, statusId, source) => { if (!bulkInline.complete(chosen, statusId)) completion.choose(chosen, statusId, source); }} onTargetReady={completion.targetReady} onReview={openTask} />;
  // "Delete" moves a task out of every list and report; the Undo notice brings it straight back.
  const deleteTask = (task: TaskDto) => {
    if (unresolvedTaskCommand(commands) !== null) return;
    setDeletedTaskIds(before => new Set(before).add(task.id));
    const release = () => setDeletedTaskIds(before => { const next = new Set(before); next.delete(task.id); return next; });
    commands.archive.mutate({ taskId: task.id, input: { expectedRevision: task.revision } }, { onError: release });
  };
  const openGraphTask = useCallback((task: TaskDto) => {
    if (task.projectId !== project.id) { navigate(`/w/${workspace.id}/projects/${task.projectId}?task=${task.id}`); return; }
    setCreating(null);
    setSearchParams(before => { const next = new URLSearchParams(before); next.set('task', task.id); return next; });
  }, [project.id, workspace.id, navigate, setSearchParams]);
  const showGraph = () => {
    if (selectedTaskIds.length || dependencies.roots === null && tasks.isSuccess) {
      const initialRoots = selectedTaskIds.length ? selectedTaskIds : dedupeTasks(shownTasks).map(task => task.id);
      if (initialRoots.length <= 100) dependencies.setRoots(initialRoots);
      dependencies.setRootOrigin(selectedTaskIds.length ? 'selected' : 'loaded');
    }
    setSearchParams(before => { const next = new URLSearchParams(before); next.set('view', 'graph'); return next; });
  };
  const expandQuickSection = (sectionId: string | null) => {
    for (const group of sectionGroups) if (group.sectionId === sectionId) setGroupCollapsed(group.key, false);
    // A filtered empty No section group may reappear only after creation.
    if (sectionId === null) setGroupCollapsed('no-section', false);
  };
  const startCreate = (request: CreateRequest) => {
    invalidateInlineSave();
    if (!writable || request.parent?.archivedAt) return;
    const kept = commands.createSession.current;
    setActiveInline(null);
    setTaskParam(null);
    if (kept?.origin === 'quick' && (commands.quick.queue.length > 0 || commands.create.pendingCommand || commands.create.uncertain)) {
      setGrouping('section');
      setCreating(null);
      expandQuickSection(kept.request.sectionId);
      setInsertion(before => before && { ...before, open: belongsToInsertion(kept.request, before) });
      setQuickAddSection(kept.request.sectionId);
      setSearchParams(before => { const next = new URLSearchParams(before); next.delete('view'); next.delete('task'); return next; });
      return;
    }
    setQuickAddSection(undefined);
    if (kept?.origin === 'quick') {
      const { origin: _origin, ...drawerSession } = kept;
      commands.createSession.current = drawerSession;
    }
    setCreating(kept?.request ?? request);
  };
  const startQuickAdd = (sectionId: string | null) => {
    invalidateInlineSave();
    if (!writable || !metadataReady) return;
    setTaskParam(null);
    setCreating(null);
    setActiveInline(null);
    const kept = commands.createSession.current;
    const targetSection = kept?.origin === 'quick' ? kept.request.sectionId : sectionId;
    // A retained draft of an insertion chain reopens at its own place; otherwise at the section end.
    setInsertion(before => before && { ...before, open: kept !== null && kept.origin === 'quick' && belongsToInsertion(kept.request, before) });
    expandQuickSection(targetSection);
    setQuickAddSection(targetSection);
  };
  const startInsertion = (anchor: TaskDto, target: { sectionId: string | null; parent: TaskDto | null }) => {
    // A retained quick draft, or titles still being sent, keep their own place.
    if (commands.createSession.current?.origin === 'quick' || commands.quick.queue.length > 0) { startQuickAdd(target.sectionId); return; }
    invalidateInlineSave();
    if (!writable || !metadataReady) return;
    setTaskParam(null);
    setCreating(null);
    setActiveInline(null);
    setInsertion(insertionAfter(anchor, target));
    setQuickAddSection(target.sectionId);
  };
  // Add subtask: an inline row under the expanded parent, after its last loaded subtask. With none
  // loaded the row is drawn right below the parent but sent without an anchor, since the parent is
  // not a sibling. The full form stays the row's More details.
  const startChildInline = (parent: TaskDto) => {
    if (parent.archivedAt !== null || parent.meetingId !== null) return;
    if (grouping !== 'section' || !tableMode) { startCreate({ sectionId: parent.sectionId, parent }); return; }
    // A retained quick draft, or titles still being sent, keep their own place, context and draft.
    if (commands.createSession.current?.origin === 'quick' || commands.quick.queue.length > 0) { startQuickAdd(commands.createSession.current?.request.sectionId ?? parent.sectionId); return; }
    // A kept full-form draft or an unresolved create is resumed where it was, never replaced.
    if (commands.createSession.current !== null || commands.create.pendingCommand !== null || commands.create.uncertain !== null) { startCreate({ sectionId: parent.sectionId, parent }); return; }
    invalidateInlineSave();
    if (!writable || !metadataReady) return;
    const last = sortMode === 'manual'
      ? dedupeTasks(shownTasks).filter(task => task.parentTaskId === parent.id && task.archivedAt === null).sort((left, right) => compareTaskRows(left, right, 'manual')).at(-1)
      : undefined;
    const sectionId = last?.sectionId ?? parent.sectionId;
    if (sectionId !== null && sections.data?.find(item => item.id === sectionId)?.archivedAt !== null) { startCreate({ sectionId: parent.sectionId, parent }); return; }
    const first: FirstChildRequest = { sectionId, parent, continueInPlace: true };
    const request: CreateRequest = last ? { sectionId, parent, insertion: { anchorTaskId: last.id, placement: 'after' } } : first;
    setTaskParam(null);
    setCreating(null);
    setActiveInline(null);
    if (collapsedTaskIds.has(parent.id)) changeTaskCollapsed(parent.id, false);
    expandQuickSection(sectionId);
    setInsertion({ anchorTaskId: (last ?? parent).id, request, open: true, confirmed: [] });
    setQuickAddSection(sectionId);
  };
  const startInline = (task: TaskDto, field: TaskInlineField, titleCaret?: number) => {
    // Only an ordinary root task moves between sections.
    if (field === 'sectionId' && !canMoveTaskSection(task)) return;
    const held = unresolvedTaskCommand(commands);
    const kept = commands.editSessions.current.get(task.id);
    // Only the held cell itself may reopen for recovery; another task's or field's command must resolve first.
    const reopensHeld = held !== null && held.taskId === task.id && (commands.update.pendingCommand !== null || commands.update.uncertain !== null) && (kept?.inlineField === undefined || kept.inlineField === field);
    // A held batch reopens only in the selected cell that sent it, to show and retry exactly that batch.
    const reopensBulk = held?.kind === 'bulk' && bulkInline.holds(task.id, field);
    // A list refetch, e.g. after a just-confirmed save, may still carry this row's older head.
    if (writable && canEditTaskInline(task) && ((held && !held.uncertain && !reopensHeld && !reopensBulk) || (!held && tasks.isRefetching))) {
      // The in-flight save keeps its editor, focus lease and confirmation; this cell opens after its
      // answer and the current list refetch, then from the row as reloaded.
      setQueuedInline({ taskId: task.id, field, focus: document.activeElement, listUpdatedAt: tasks.dataUpdatedAt, receipts: commandReceipts() });
      return;
    }
    invalidateInlineSave();
    if (!writable || !canEditTaskInline(task) || (held && !reopensHeld && !reopensBulk)) return;
    const original = kept?.base ?? task;
    if (field === 'estimate' && !commands.update.pendingCommand && !commands.update.uncertain && !isCurrentEstimateProjection(original, inlineHead.current.loadedPackages.packages)) {
      setAnnouncement(message('tasks.inlineEstimate.refreshRequired'));
      return;
    }
    // The desktop saved-task pane leaves neighboring cells interactive. Keep that exact pane
    // while its neighbor edits; modal drawers retain the previous close-before-edit behavior.
    if (!desktopTaskPane || document.querySelector('[data-task-panel][data-state="open"]') === null) setTaskParam(null);
    setCreating(null);
    setQuickAddSection(undefined);
    setContinuation(before => before?.taskId === task.id ? null : before);
    const focusClaim = { current: false };
    // The selection is frozen for this explicit open; changing it later never retargets the cell.
    bulkInline.capture(task, field, focusClaim);
    setActiveInline({ taskId: task.id, field, focusClaim, titleCaret });
  };
  const closeInline = (task: TaskDto, field: TaskInlineField, reason: InlineCloseReason = 'cancel') => {
    invalidateInlineSave();
    setActiveInline(null);
    if (reason === 'blur') return;
    if (reason === 'next' && continuable(task)) { continueAfter(task); return; }
    requestAnimationFrame(() => {
      if (document.activeElement === null || document.activeElement === document.body) document.querySelector<HTMLButtonElement>(`button[data-task-cell="${task.id}:${field}"]`)?.focus();
    });
  };
  const closeQuickAdd = (sectionId: string | null, reason: QuickAddCloseReason = 'cancel', returnTaskId: string | null = null) => {
    setQuickAddSection(undefined);
    // Submitted rows of the chain stay visible until they resolve; only the unsent input closes.
    setInsertion(before => before && { ...before, open: false });
    if (reason === 'cancel') requestAnimationFrame(() => {
      if (document.activeElement !== null && document.activeElement !== document.body) return;
      const target = returnTaskId === null ? null : document.querySelector<HTMLButtonElement>(`button[data-task-cell="${returnTaskId}:title"]`);
      (target ?? document.querySelector<HTMLButtonElement>(`button[data-add-task-row="${sectionId ?? ''}"]`))?.focus();
    });
  };
  const heldCommand = unresolvedTaskCommand(commands);
  const heldKey = heldCommand ? `${heldCommand.taskId ?? 'create'}:${heldCommand.uncertain}` : '';
  // A confirmed write refetches list heads asynchronously. Until its own row is loaded at every
  // confirmed revision (or, when it left the list, a later list is loaded), rows are stale.
  const listHeadCurrent = (confirmed: TaskDto, listUpdatedAt: number) => {
    const loaded = dedupeTasks(shownTasks).find(task => task.id.toLowerCase() === confirmed.id.toLowerCase());
    if (!loaded) return tasks.dataUpdatedAt > listUpdatedAt;
    return loaded.revision >= confirmed.revision && loaded.participantsRevision >= confirmed.participantsRevision
      && (loaded.workPackageId !== confirmed.workPackageId || loaded.workPackageRevision >= confirmed.workPackageRevision);
  };
  // Read at answer time: the current command receipts, loaded rows and open rules.
  const settleQueued = useRef<(queued: QueuedInline) => void>(() => undefined);
  settleQueued.current = queued => {
    if (heldKey.endsWith(':false')) return;
    // An unknown outcome keeps every other cell closed.
    if (heldKey !== '') { setQueuedInline(null); return; }
    // Explicit quick creates are sent one after another; the next one may already be sending
    // in this commit. The cell waits for the whole queue, including a paused rejected front.
    if (commands.quick.queue.length > 0 || commands.quick.sending) return;
    // Every result newer than the click is a confirmed write; the list must include them all.
    const receipts = commandReceipts();
    const confirmed = receipts.filter((receipt, i): receipt is TaskDto => receipt !== undefined && receipt !== queued.receipts[i]);
    // A failed list refetch replaces the stale rows with its error, and the person reopens the
    // cell after an explicit retry rather than editing an old head.
    if (tasks.isError && !tasks.isFetchNextPageError) { setQueuedInline(null); return; }
    // Any list refetch, with or without a new receipt, may still change this row's head.
    if (tasks.isRefetching) return;
    if (confirmed.length > 0 && (tasks.isFetching || !confirmed.every(receipt => listHeadCurrent(receipt, queued.listUpdatedAt)))) return;
    setQueuedInline(null);
    // A moved focus means the person went elsewhere.
    if (document.activeElement !== queued.focus && document.activeElement !== document.body) return;
    const task = dedupeTasks(shownTasks).find(item => item.id === queued.taskId);
    if (task) startInline(task, queued.field);
  };
  useEffect(() => {
    if (queuedInline) settleQueued.current(queuedInline);
  }, [queuedInline, heldKey, commands.quickVersion, tasks.isFetching, tasks.isRefetching, tasks.isError, shownTasks]);
  // The open task's direct children among the loaded rows only. Without a current list nothing is
  // claimed; a filter, search or unloaded page labels the list as a subset.
  // Including archived tasks only widens the list; every other filter narrows it.
  // A new object for every filter, search, view or history change, so Back to an equal key
  // never revives an older confirmation.
  const quickCreateScope = useMemo(() => ({ key: taskPresentationKey, filtered }), [taskPresentationKey, filtered]);
  const quickCreateHead = useRef(quickCreateScope);
  useLayoutEffect(() => { quickCreateHead.current = quickCreateScope; }, [quickCreateScope]);
  // Only the latest confirmed quick create a filter may hide; shown only in its own scope.
  const [quickCreated, setQuickCreated] = useState<{ scope: typeof quickCreateScope; taskId: string; title: string } | null>(null);
  useEffect(() => { setQuickCreated(before => before === null || before.scope === quickCreateScope ? before : null); }, [quickCreateScope]);
  // Captured with the queued title and called only after its confirmed answer. An answer for a
  // scope that has since changed confirms nothing; the authoritative list shows the row.
  const quickTaskCreated = (task: TaskDto) => {
    if (quickCreateHead.current !== quickCreateScope) return;
    if (quickCreateScope.filtered) {
      // The visible feedback is the one announcement, never repeated by an earlier generic one.
      setAnnouncement(null);
      setQuickCreated({ scope: quickCreateScope, taskId: task.id, title: task.title });
    } else setAnnouncement(message('projects.projectPage.taskValueCreated', { p0: task.title }));
  };
  const loadedSubtasks = useMemo((): LoadedSubtasks | undefined => {
    if (taskId === null || !isUuid(taskId) || tasks.data === undefined || (tasks.isError && !tasks.isFetchNextPageError)) return undefined;
    const parentId = taskId.toLowerCase();
    const children = dedupeTasks(shownTasks).filter(task => task.parentTaskId?.toLowerCase() === parentId).sort((left, right) => compareTaskRows(left, right, 'manual'));
    const partial = filtered || !loadedTaskScope(tasks.data).complete || tasks.isFetchNextPageError;
    return { parentId, tasks: children, partial, includesArchived: urlFilters.includeArchived, loadedAt: tasks.dataUpdatedAt, fetching: tasks.isFetching };
  }, [taskId, tasks.data, tasks.isError, tasks.isFetchNextPageError, tasks.dataUpdatedAt, tasks.isFetching, shownTasks, filtered, urlFilters.includeArchived]);
  const closeDrawer = () => {
    setCreating(null);
    if (taskId !== null) setTaskParam(null);
  };
  const quickEditorHidden = (grouping !== 'section' && insertion?.placement?.group.kind !== 'assignee') || quickAddSection === undefined || boardMode || graphMode || ganttMode || importMode
    || (insertion?.placement ? collapsedGroupKeys.has(insertion.placement.groupKey) : taskGroups.some(group => group.sectionId === quickAddSection && collapsedGroupKeys.has(group.key)));
  const inlineEditorHidden = activeInline === null || personalColumns.denied || graphMode || ganttMode || importMode
    || !shownTasks.some(task => task.id === activeInline.taskId)
    || (boardMode ? activeInline.field !== 'statusId' : !visibleColumnIds.includes(taskInlineColumn(activeInline.field)) || sectionHiddenTaskIds.has(activeInline.taskId));
  // The continued title save, only while its exact submitted session is still retained.
  const continued = continuation !== null && commands.editSessions.current.get(continuation.taskId) === continuation.session ? continuation : null;
  const continuedPending = continued !== null && commands.update.pendingCommand?.variables.taskId === continued.taskId;
  const continuedUncertain = continued !== null && commands.update.uncertain?.variables.taskId === continued.taskId ? commands.update.uncertain.error : null;
  const continuedError = continued !== null && !continuedPending && commands.update.variables?.taskId === continued.taskId
    && commands.update.variables.input.expectedRevision === continued.session.base.revision ? commands.update.error : null;
  const continuedFeedback = continued !== null && (continuedUncertain !== null || continuedError !== null) && taskId === null && creating === null
    && (inlineEditorHidden || activeInline?.taskId !== continued.taskId);
  // Nothing else needs page-level recovery: no other edit draft and no other held command.
  const continuedOnly = continued !== null && commands.editSessions.current.size === 1
    && [commands.create, commands.archive, commands.restore].every(command => !command.pendingCommand && !command.uncertain);
  const showTaskRecovery = taskId === null && creating === null && (quickEditorHidden || commands.editSessions.current.size > 0) && inlineEditorHidden
    // An ordinary pending continuation needs no page notice that shifts the table; its definite
    // or unknown outcome has its own alert with the same recovery.
    && !(continuedOnly && ((continuedPending && !quickEditorHidden) || (continuedFeedback && (!quickEditorHidden || commands.createSession.current === null))));
  const draftTaskIds = new Set([...commands.editSessions.current.keys()].filter(id => !(continuedPending && id === continued?.taskId)));

  // The insertion chain: queued titles, then confirmed rows the list has not loaded yet, sit right
  // after the last of its tasks the list shows, so the next input never jumps to the section end.
  const listedTaskIds = new Set(shownTasks.map(task => task.id));
  const chainQueue = insertion ? commands.quick.queue.filter(entry => belongsToInsertion(entry.session.request, insertion)) : [];
  const chainRetained = insertion ? insertion.confirmed.filter(entry => !listedTaskIds.has(entry.task.id) && (tasks.isFetching || tasks.dataUpdatedAt < entry.at)) : [];
  const chainAnchorId = insertion ? [insertion.anchorTaskId, ...insertion.confirmed.map(entry => entry.task.id)].filter(id => listedTaskIds.has(id)).at(-1) ?? insertion.anchorTaskId : null;
  const insertionOpen = insertion !== null && insertion.open && quickAddSection !== undefined;
  const recordInsertion = (task: TaskDto) => setInsertion(before => before && task.parentTaskId === (before.request.parent?.id ?? null)
    ? { ...before, confirmed: [...before.confirmed, { task, at: Date.now() }] } : before);

  // Hours of a new row: only the explicitly selected week and the person the table shows. A hours
  // edit there is the consent; nothing falls back to a current week or person.
  const rowContext = taskTime.initialRowContext;
  const rowContextKey = `${rowContext.periodId ?? ''}:${rowContext.membershipId ?? ''}`;
  const currentRowContext = useRef<string | null>(null);
  if (rowContext.current) currentRowContext.current = rowContextKey;
  // A confirmed write refetches the projection; an input already shown for the same week and
  // person stays usable meanwhile, while a changed selection waits for its own current read.
  const initialTimeCurrent = rowContext.current || (currentRowContext.current === rowContextKey && rowContext.period !== null);
  const initialTimeContextFor = (parent: TaskDto | null, workScope: TaskWorkScope): InitialTimeContext | null => {
    const { periodId, membershipId, period } = rowContext;
    if (!timeAvailable || periodId === null || membershipId === null || period === null || period.id.toLowerCase() !== periodId.toLowerCase()) return null;
    const member = members.data?.find(item => item.id === membershipId);
    if (member === undefined) return null;
    // A detail subtask plans its parent's whole package: only a current projection row of exactly
    // that package tells its commitment revision, or that none exists. A removed one is never «absent».
    const packages = rowContext.packages;
    const row = parent !== null && workScope === 'detail' && rowContext.current && 'get' in packages
      ? packages.get(parent.workPackageId) ?? packages.get(parent.workPackageId.toLowerCase()) : undefined;
    const plan = parent === null || row === undefined || row.commitment?.state === 'removed'
      ? null : { workPackageId: parent.workPackageId, expectedRevision: row.commitment?.revision ?? null };
    return explicitTimeContext({ periodId: period.id, membershipId: member.id, periodName: period.name, memberName: member.displayName, plan });
  };
  const initialFields = fieldDefinitions.isSuccess ? fieldDefinitions.data : undefined;
  // The page table's visible custom and weekly columns, in its order; drawer subtask rows show them too.
  // Personal period entries retain their own person/week context; selection never mass-assigns hours.
  const timeColumns = (timeAvailable ? taskTime.columns : []).map(column => ({ ...column, renderCell: (task: TaskDto) => <div className="relative flex min-w-0 flex-1 items-center gap-1">
    <div className="min-w-0 flex-1">{column.renderCell(task)}</div>
    {bulkInline.selectsMany(task.id) ? <span className="max-w-20 truncate text-[10px] text-muted" title={t('bulkInline.singleOnly')}>{t('bulkInline.singleOnly')}</span> : null}
  </div> }));
  const visibleExtraColumns = [...timeColumns, ...customColumns].filter(column => visibleColumnIds.includes(column.id));
  // More details keeps the row's place: its whole request, not only its section and parent.

  // The row starts with what the project's defaults will give the task, so it is visible before saving. "The task above"
  // is the anchor the row follows, or the last loaded task of its section and list; unknown means the server decides.
  const withStartValues = (request: CreateRequest): CreateRequest => {
    const config = taskDefaults.data?.config;
    if (!config || taskDefaults.data?.revision === 0 || request.startValues !== undefined) return request;
    const parentId = request.parent?.id ?? null;
    const loaded = dedupeTasks(shownTasks).filter(task => task.archivedAt === null);
    const anchorId = request.insertionAnchor?.taskId ?? request.insertion?.anchorTaskId ?? null;
    const siblings = loaded.filter(task => (task.sectionId ?? null) === (request.parent?.sectionId ?? request.sectionId ?? null) && task.parentTaskId === parentId).sort((left, right) => left.position - right.position);
    const above = anchorId !== null ? (request.insertionAnchor?.placement ?? request.insertion?.placement) === 'before' ? null : loaded.find(task => task.id === anchorId) ?? null : siblings[siblings.length - 1] ?? null;
    const startValues = startValuesFromDefaults(config, above, { today: todayIn(workspace.timezone), subtask: request.parent !== null });
    return Object.keys(startValues).length === 0 ? request : { ...request, startValues };
  };
  const quickTaskAdd = (request: CreateRequest, key: string, renderRow: TaskTableDraftRow, anchored: boolean) => <QuickTaskAdd key={key} newTaskStatusId={taskDefaults.data?.config.statusId ?? null} projectId={project.id} sectionId={request.sectionId}
    sectionName={sections.data?.find(section => section.id === request.sectionId)?.name ?? t('tasks.taskFields.noSection')} statuses={statuses.data ?? []} members={members.data ?? []} tags={tags.data ?? []} sections={sections.data ?? []}
    commands={commands} writable={writable} request={withStartValues(request)} renderRow={renderRow} detailsKeepInitialCells
    initialFields={initialFields} initialTimeContext={initialTimeContextFor(request.parent, 'detail')} initialTimeWritable={rowContext.writable} initialTimeCurrent={initialTimeCurrent}
    onClose={reason => closeQuickAdd(request.sectionId, reason, anchored ? chainAnchorId : null)}
    onMoreDetails={() => startCreate(request)}
    onCreated={task => { if (anchored) recordInsertion(task); quickTaskCreated(task); }} />;
  const quickAdd: TaskTableQuickAdd | undefined = insertion !== null && (insertionOpen || (quickAddSection === undefined && (chainQueue.length > 0 || chainRetained.length > 0))) ? {
    sectionId: insertion.request.sectionId,
    afterTaskId: chainAnchorId,
    placement: insertion.placement ? { ...insertion.placement, anchorTaskId: chainAnchorId ?? insertion.anchorTaskId } : undefined,
    parentTaskId: insertion.request.parent?.id ?? null,
    confirmedTasks: chainRetained.map(entry => entry.task),
    render: draftRow => <>
      {chainQueue.map((entry, index) => {
        const uncertain = index === 0 && commands.create.uncertain !== null;
        return <QuickTaskDraftPreview key={queuedRowKey(entry.session)} session={entry.session} renderRow={draftRow(uncertain ? 'uncertain' : 'pending')} pending={!uncertain} uncertain={uncertain} />;
      })}
      {insertionOpen ? quickTaskAdd(insertion.request, `insert:${insertion.anchorTaskId}`, draftRow('draft'), true) : null}
    </>,
  } : quickAddSection !== undefined ? {
    sectionId: quickAddSection,
    render: draftRow => quickTaskAdd({ sectionId: quickAddSection, parent: null }, quickAddSection ?? 'none', draftRow('draft'), false),
  } : undefined;

  // Manual reorder: one guarded move at a time, after every other task command has resolved.
  const moveBlocked = !completionWritable || unresolvedTaskCommand(commands) !== null || commands.move.pendingCommand !== null || commands.move.uncertain !== null
    || commands.quick.queue.length > 0 || commands.quick.sending || tasks.isFetching;
  // Board drag is one explicit status intent, using the same page-owned serialized field writer.
  const moveBoardCard: BoardMoveCard = (seen, statusId, anchor, placement) => {
    if (moveBlocked || activeInline !== null || !completionWritable || sortMode !== 'manual' || commands.editSessions.current.has(seen.id)) return;
    const heads = dedupeTasks(shownTasks);
    const current = heads.find(task => task.id === seen.id);
    const target = statuses.data?.find(status => status.id === statusId && status.projectId === project.id && status.workspaceId === workspace.id);
    const currentAnchor = anchor ? heads.find(task => task.id === anchor.id) : null;
    if (!current || !target || !canEditTaskInline(current) || current.revision !== seen.revision || current.statusId !== seen.statusId || current.position !== seen.position
      || current.workPackageRevision !== seen.workPackageRevision || current.participantsRevision !== seen.participantsRevision) return;
    if (anchor && (!currentAnchor || currentAnchor.id === current.id || currentAnchor.statusId !== statusId || currentAnchor.archivedAt !== null
      || currentAnchor.revision !== anchor.revision || currentAnchor.position !== anchor.position)) return;
    invalidateInlineSave(); setActiveInline(null);
    setAnnouncement(message('taskTable.move.moving', { title: current.title }));
    commands.move.mutate({ taskId: current.id, input: { expectedRevision: current.revision, statusId, anchorTaskId: currentAnchor?.id ?? null, placement } }, {
      onSuccess: moved => setAnnouncement(message('taskTable.move.moved', { title: moved.title })),
    });
  };
  const moveTask = (task: TaskDto, anchor: TaskDto | null, placement: TaskDropPlacement, target?: { responsibleMembershipId: string | null }) => {
    if (!completionWritable || sortMode !== 'manual' || (!anchor && target === undefined)) return;
    if (commands.editSessions.current.has(task.id)) { setAnnouncement(message('taskTable.move.draft', { title: task.title })); return; }
    if (moveBlocked) { setAnnouncement(message('taskTable.move.wait')); return; }
    invalidateInlineSave();
    setActiveInline(null);
    setAnnouncement(message('taskTable.move.moving', { title: task.title }));
    commands.move.mutate({ taskId: task.id, input: { expectedRevision: task.revision, anchorTaskId: anchor?.id ?? null, placement, ...(target ? { responsibleMembershipId: target.responsibleMembershipId } : {}) } }, {
      onSuccess: moved => setAnnouncement(message('taskTable.move.moved', { title: moved.title })),
    });
  };

  // The open drawer's subtask rows show and retry their own reorder; the page shows every other one.
  const heldMoveTaskId = commands.move.uncertain?.variables.taskId ?? commands.move.variables?.taskId ?? null;
  const drawerShowsMove = taskId !== null && heldMoveTaskId !== null && (loadedSubtasks?.tasks.some(task => task.id === heldMoveTaskId) ?? false);

  // A rename still being sent or unconfirmed keeps its section: reopening shows that one.
  const heldSectionId =
    renameSectionMutation.pendingCommand?.variables.sectionId ?? renameSectionMutation.uncertain?.variables.sectionId ?? null;
  const renameSection = (section: SectionDto) =>
    setRenamingSection(sections.data?.find((item) => item.id === heldSectionId) ?? section);

  // One guarded selection port for the table and Timeline: a pending or unknown bulk write keeps its selection.
  const bulkHeld = commands.bulk.pendingCommand !== null || commands.bulk.uncertain !== null;
  const changeSelection = (ids: string[]) => {
    if (commands.bulk.pendingCommand || commands.bulk.uncertain || ids.length > 100) return;
    const latest = new Map(shownTasks.map(task => [task.id, task]));
    for (const id of ids) { const task = latest.get(id); if (task) selectionLedger.current.set(id, task); }
    for (const id of selectionLedger.current.keys()) if (!ids.includes(id)) selectionLedger.current.delete(id);
    setSelectedTaskIds(ids);
  };
  // A neutral Escape the table left unhandled; an open editor, quick row, drawer or held batch keeps the selection.
  const clearSelectionByEscape = () => {
    if (selectedTaskIds.length === 0 || bulkHeld || activeInline !== null || quickAddSection !== undefined || creating !== null) return false;
    // A desktop pane leaves the table interactive; a modal drawer still owns Escape.
    if (taskId !== null) {
      const pane = document.querySelector<HTMLElement>('[data-task-panel][data-state="open"]');
      if (!pane || pane.contains(document.activeElement)) return false;
    }
    selectionLedger.current.clear(); setSelectedTaskIds([]);
    return true;
  };
  // Recovery describes the actual immutable command, even if a different view attempts to change the selection.
  const heldBulkInput = commands.bulk.pendingCommand?.variables.input ?? commands.bulk.uncertain?.variables.input;
  const toolbarIds = heldBulkInput?.tasks.map(row => row.taskId) ?? selectedTaskIds;
  const toolbarSelection = { ids: toolbarIds, tasks: toolbarIds.flatMap(id => {
    const task = shownTasks.find(row => row.id === id) ?? selectionLedger.current.get(id);
    return task?.projectId === project.id ? [task] : [];
  }) };

  return (
    <div className="min-w-0 space-y-3 pb-36">
      <header className="flex min-w-0 items-center gap-3">
        <div className="min-w-0 flex-1">
          <BackToProjects href={projectsHref} />
          <div className="flex min-w-0 items-center gap-2">
            <h1 title={project.name} className="min-w-0 truncate text-xl font-semibold tracking-tight text-ink">{project.name}</h1>
            <ProjectDateRange actorId={actorId} workspaceId={workspace.id} project={project} writable={canEdit && project.archivedAt === null}/>
            {project.archivedAt ? <Badge tone="muted">{t('projects.projectPage.archived')}</Badge> : null}
          </div>
        </div>
        {writable && metadataReady ? <ProjectCreateMenu onAddSharedActivity={()=>sharedActivityController.setCreateOpen(true)} returnFocus={sectionCreate.returnFocus} onAddTask={() => { if (grouping === 'section' && tableMode) startQuickAdd(null); else startCreate({ sectionId: null, parent: null }); }} onAddSection={startSection} /> : null}
        <ProjectActions>
            {writable && metadataReady ? <Button size="sm" variant="ghost" onClick={() => meetingController.setCreateOpen(true)}>{t('projects.projectPage.newMeeting')}</Button> : null}
            {canEdit ? <RenameProjectDialog actorId={actorId} workspaceId={workspace.id} project={project} trigger={<Button size="sm" variant="ghost"><Pencil size={16} aria-hidden="true" />{t('projects.projectPage.rename')}</Button>} /> : null}
            <WorkCategorySettings actorId={actorId} workspaceId={workspace.id} projectId={project.id} canManage={canManageFields} />
            <DuplicateProjectDialog actorId={actorId} workspaceId={workspace.id} project={project} canManage={canManageFields} unfinished={unfinishedTasks} />
            <TaskDefaultsDialog actorId={actorId} workspaceId={workspace.id} projectId={project.id} canManage={canManageFields} />
            <ProjectRulesDialog actorId={actorId} workspaceId={workspace.id} projectId={project.id} canManage={canManageFields} />
            <TagManagerDialog actorId={actorId} workspaceId={workspace.id} canEdit={canEdit} />
            <FieldManagerDialog onConfigurePlanningCheck={planningChecks.configureField} initialFieldId={fieldManagerInitialId ?? undefined} open={fieldManagerOpen} onOpenChange={open => { setFieldManagerOpen(open); if (!open) setFieldManagerInitialId(null); }} triggerLabel={t('projects.projectPage.teamColumns')} actorId={actorId} workspaceId={workspace.id} projectId={project.id} canManage={canManageFields} />
        </ProjectActions>
      </header>
      {planningChecks.dialogs}
      {bulkContinueTasks ? <BulkContinueDialog actorId={actorId} workspaceId={workspace.id} tasks={bulkContinueTasks} currentProjectId={project.id} onClose={() => setBulkContinueTasks(null)} onFinished={() => { selectionLedger.current.clear(); setSelectedTaskIds([]); }} /> : null}
      {continueTask ? <ContinueInProjectDialog actorId={actorId} workspaceId={workspace.id} task={continueTask} currentProjectId={project.id} onClose={() => setContinueTask(null)} /> : null}
      <PlacementCommandFeedback commands={placementCommands} actorId={actorId} workspaceId={workspace.id} />

      {savedAssignment && savedAssignment.generation === inlineGeneration.current && shownTasks.some(task => task.id === savedAssignment.taskId && task.revision === savedAssignment.revision && task.responsibleMembershipId === savedAssignment.membershipId && canEditTaskInline(task)) && completionWritable && grouping === 'assignee' && !boardMode && !graphMode && !ganttMode && !importMode && taskId === null && creating === null ? <TaskFeedbackLayer><div role="status" className="fixed right-3 top-20 z-[60] max-w-[calc(100vw-1.5rem)] flex flex-wrap items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2 text-sm shadow-lg">
        <span>{t('taskTable.grouping.moved', { name: savedAssignment.membershipId === null ? t('taskTable.taskTable.unassigned') : members.data?.find(member => member.id === savedAssignment.membershipId)?.displayName ?? t('taskTable.taskTable.memberUnavailable') })}</span>
        <Button size="sm" variant="ghost" onClick={() => openTask(savedAssignment.taskId)}>{t('taskTable.grouping.open')}</Button>
      </div></TaskFeedbackLayer> : null}
      {/* A circle's batch that was refused or not fully confirmed; the Toolbar keeps any held recovery. */}
      {bulkInline.completionNotice ? <TaskFeedbackLayer><div role="alert" className="fixed right-3 top-20 z-[60] max-w-[calc(100vw-1.5rem)] flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 shadow-lg">
        <span className="min-w-0 flex-1">{t(bulkInline.completionNotice.key, bulkInline.completionNotice.params)}</span>
        <Button size="sm" variant="ghost" onClick={bulkInline.dismissNotice}>{t('bulkInline.dismiss')}</Button>
      </div></TaskFeedbackLayer> : null}
      {(toolbarSelection.ids.length > 0 || bulkHeld) && writable ? <BulkTaskToolbar key={`${actorId}:${workspace.id}:${project.id}`} projectId={project.id}
        count={toolbarSelection.ids.length} hiddenCount={toolbarSelection.ids.filter(id => !shownTasks.some(task => task.id === id)).length}
        onClearHidden={() => setSelectedTaskIds(before => before.filter(id => { const visible = shownTasks.some(task => task.id === id); if (!visible) selectionLedger.current.delete(id); return visible; }))} onReload={async () => {
          const scope = selectionScope;
          const fresh = await Promise.all(selectedTaskIds.map(id => reloadSelectedTask(id)));
          if (selectionScopeHead.current !== scope) return;
          for (const row of fresh) if (row.projectId === project.id) selectionLedger.current.set(row.id, row);
          setSelectedTaskIds(before => [...before]);
          await tasks.refetch();
        }} tasks={toolbarSelection.tasks}
        members={members.data ?? []} commands={commands} writable={completionWritable}
        blocked={unresolvedTaskCommand(commands) !== null || commands.quick.queue.length > 0 || commands.quick.sending || tasks.isFetching}
        onClear={() => { selectionLedger.current.clear(); setSelectedTaskIds([]); }}
        onContinue={() => setBulkContinueTasks(toolbarSelection.tasks)}
        onConfirmed={rows => { for (const row of rows) selectionLedger.current.set(row.id, row); }} /> : null}
      <TaskCompletionFeedback controller={completion} onReview={openTask} />
      <CommentCommandRecovery controller={commentsController} visibleTaskId={taskId} onOpen={openTask} />
      {continuedFeedback ? <SaveFeedback subject="taskSave" error={continuedError} uncertainError={continuedUncertain}
        action={<Button size="sm" onClick={() => openTask(continued.taskId)}>{t('tasks.recovery.resume')}</Button>} /> : null}
      {/* A refused or unknown reorder: the list keeps the server's order; an unknown one resends exactly. */}
      {!drawerShowsMove && (commands.move.uncertain !== null || (commands.move.error !== null && commands.move.pendingCommand === null)) ? <>
        <SaveFeedback subject="taskSave" error={commands.move.uncertain === null ? commands.move.error : null} uncertainError={commands.move.uncertain?.error ?? null}
          action={<Button size="sm" variant="ghost" onClick={() => commands.move.reset()}>{t('taskTable.move.dismiss')}</Button>} />
        {commands.move.uncertain !== null ? <Button size="sm" aria-disabled={commands.move.pendingCommand !== null || undefined} onClick={() => { if (commands.move.pendingCommand === null) commands.move.retryUncertain(); }}>{t('tasks.quickAdd.retry')}</Button> : null}
      </> : null}
      <TaskCommandRecovery showTaskRecovery={showTaskRecovery} commands={commands} onResumeCreate={() => startCreate({ sectionId: null, parent: null })} onOpenTask={openTask} />
      <ImportNotices controller={imports} onSelect={selectImport} selectedId={importId} canManage={canManageImports} />
      <ScheduleNotices controller={schedule} />
      <ScheduleDialog controller={schedule} workspaceId={workspace.id} projectId={project.id} periods={meetingPeriods.data ?? []} writable={writable && !bulkHeld} />
      <DependencyNotices controller={dependencies} />
      <EdgeDialog controller={dependencies} actorId={actorId} workspaceId={workspace.id} project={project} writable={writable} />
      <MeetingCommandNotices controller={meetingController} onOpen={(id,tab,selection)=>setSearchParams(before=>{const next=new URLSearchParams(before);next.set('task',id);next.set('meetingTab',tab);if(selection?.requestedPeriodId)next.set('meetingPeriod',selection.requestedPeriodId);else next.delete('meetingPeriod');if(selection?.membershipId)next.set('meetingMember',selection.membershipId);else next.delete('meetingMember');if(selection?.attendanceId)next.set('meetingAttendance',selection.attendanceId);else next.delete('meetingAttendance');return next;})}/>
      {meetingController.commands.create.pendingCommand||meetingController.commands.create.uncertain?<div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">{t('projects.projectPage.meetingCreationIsUnconfirmed')}<Button size="sm" onClick={()=>meetingController.setCreateOpen(true)}>{t('projects.projectPage.openMeetingCreation')}</Button></div>:null}
      {[sharedActivityController.configure,sharedActivityController.attendance].map((command,index)=>command.uncertain||command.pendingCommand?<div key={`shared-${index}`} role="status" className="flex flex-wrap gap-2 rounded border border-line p-2 text-xs text-muted"><span>{t('sharedActivities.reopenTask')}</span><Button size="sm" variant="ghost" onClick={()=>openTask((command.uncertain?.variables??command.pendingCommand?.variables)?.taskId??'')}>{t('sharedActivities.reopenTask')}</Button></div>:null)}
      {sharedActivityController.create.uncertain||sharedActivityController.create.pendingCommand?<Button size="sm" variant="ghost" onClick={()=>sharedActivityController.setCreateOpen(true)}>{t('sharedActivities.reopenCreate')}</Button>:null}
      <CreateSharedActivityDialog controller={sharedActivityController} members={members.data??[]} fields={fieldDefinitions.data??[]} statuses={statuses.data??[]} sections={sections.data??[]} ownMembershipId={members.data?.find(member=>member.userId===actorId)?.id??''} writable={writable&&metadataReady&&!fieldDefinitions.isFetching&&!fieldDefinitions.isError} onCreated={id=>openTask(id)}/>
      <CreateMeetingDialog accessDenied={[members.error,sections.error,statuses.error,meetingPeriods.error].some(isAccessDenied)} controller={meetingController} members={members.data??[]} periods={meetingPeriods.data??[]} statuses={statuses.data??[]} sections={sections.data??[]} ownMembershipId={members.data?.find(m=>m.userId===actorId)?.id??''} timezone={workspace.timezone} onCreated={id=>setSearchParams(before=>{const next=new URLSearchParams(before);next.set('task',id);next.set('meetingTab','plan');return next;})}/>
      <nav aria-label={t('projects.projectPage.projectViews')} className="flex min-w-0 flex-nowrap gap-1 overflow-x-auto border-b border-line pb-2">
        <Button ref={tableMode || (importMode && !canManageImports) ? activeViewControl : undefined} size="sm" variant={boardMode || graphMode || ganttMode || importMode ? 'ghost' : 'primary'} aria-current={!boardMode && !graphMode && !ganttMode && !importMode ? 'page' : undefined} onClick={() => setSearchParams(before => { const next = new URLSearchParams(before); next.delete('view'); return next; })}>{t('projects.projectPage.tasks')}</Button>
        <Button ref={boardMode ? activeViewControl : undefined} size="sm" variant={boardMode ? 'primary' : 'ghost'} aria-current={boardMode ? 'page' : undefined} onClick={() => setSearchParams(before => { const next = new URLSearchParams(before); next.set('view', 'board'); return next; })}>{t('projects.projectPage.board')}</Button>
        <Button ref={graphMode ? activeViewControl : undefined} size="sm" variant={graphMode ? 'primary' : 'ghost'} aria-current={graphMode ? 'page' : undefined} onClick={showGraph}>{selectedTaskIds.length ? t('projects.projectPage.selectedGraphValue', { p0: selectedTaskIds.length }) : t('projects.projectPage.graph')}</Button>
        <Button ref={ganttMode ? activeViewControl : undefined} size="sm" variant={ganttMode ? 'primary' : 'ghost'} aria-current={ganttMode ? 'page' : undefined} onClick={() => setSearchParams(before => { const next = new URLSearchParams(before); next.set('view', 'gantt'); return next; })}>{t('projects.projectPage.timeline')}</Button>
        <Link to={`/w/${workspace.id}/projects/${project.id}/reports`} className={buttonClassName({ variant: 'ghost', size: 'sm' })}>{t('genericReports.reports')}</Link>
        {canManageImports ? <Button ref={importMode ? activeViewControl : undefined} size="sm" variant={importMode ? 'primary' : 'ghost'} aria-current={importMode ? 'page' : undefined} onClick={() => selectImport(importId)}>{t('projects.projectPage.cSVImport')}</Button> : null}
      </nav>

      <div role="status" aria-live="polite" className="sr-only">
        {announcement ? t(announcement.key, announcement.params) : null}
      </div>
      {/* Fixed outside the layout flow, so the header, table and next input never shift. */}
      <div role="status" aria-live="polite" className="fixed inset-x-4 bottom-4 z-30 empty:hidden sm:left-auto sm:w-96">
        {/* The message keeps its own full-width row; the actions wrap compactly below it. */}
        {quickCreated?.scope === quickCreateScope ? <div className="rounded-lg border border-line bg-surface px-3 py-2 text-sm shadow-lg">
          <p className="line-clamp-3 break-words">{t('tasks.quickAdd.createdFiltered', { title: quickCreated.title })}</p>
          <div className="mt-1 flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => openTask(quickCreated.taskId)}>{t('tasks.quickAdd.openDetails')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setQuickCreated(null)}>{t('tasks.quickAdd.dismissCreated')}</Button>
          </div>
        </div> : null}
      </div>

      {metadataError ? (
        <QueryErrorState
          error={metadataError.query.error}
          subject={metadataError.subject}
          headingLevel={2}
          retrying={metadataError.query.isFetching}
          onRetry={() => void metadataError.query.refetch()}
        />
      ) : sections.isSuccess && statuses.isSuccess && members.isSuccess && tags.isSuccess ? (
        <>
          {showHeldFieldValue ? (
            <div
              role="status"
              className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2 text-sm text-amber-900"
            >
              <span className="min-w-0 flex-1">
                {fieldValueMutation.pendingCommand
                  ? t('projects.projectPage.aTaskFieldValueIsBeingSubmitted')
                  : t('projects.projectPage.aTaskFieldValueIsUnconfirmedOtherField')}
              </span>
              <Button
                size="sm"
                onClick={() => {
                  if (heldFieldTaskId !== null) openTask(heldFieldTaskId);
                }}
              >
                {t('projects.projectPage.openSubmission')}</Button>
            </div>
          ) : null}
          {!timeAvailable && tableMode ? ordinaryAggregates.panel : null}
          {timeAvailable ? <><p className="text-xs text-muted">{t('genericReports.legacyColumns')} <Button size="sm" variant="ghost" onClick={() => setSearchParams(before => { const next = new URLSearchParams(before); next.delete('legacyTime'); next.delete('week'); next.delete('worker'); return next; })}>{t('genericReports.ordinaryMode')}</Button></p>{tableMode ? taskTime.controls : taskTime.notices}</> : null}
          <div className="flex min-w-0 flex-wrap items-center gap-2 empty:hidden">
            {showTaskFilters ? <div className="min-w-0 max-w-full shrink grow basis-full"><TaskFilters value={filters} onChange={changeFilters} statuses={statuses.data} members={members.data} tags={tags.data ?? []} /></div> : null}
            {!boardMode && !graphMode && !ganttMode && !importMode ? <label className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-muted">
              {t('taskTable.grouping.label')}
              <ChoicePicker compact label={t('taskTable.grouping.label')} value={grouping}
                options={[{ value: 'section', label: t('taskTable.grouping.section') }, { value: 'assignee', label: t('taskTable.grouping.assignee') }]}
                onValueChange={value => { invalidateInlineSave(); setGrouping(value === 'assignee' ? 'assignee' : 'section'); }} />
            </label> : null}
            {!graphMode && !ganttMode && !importMode ? <label className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-muted">
              {t('taskTable.sort.label')}
              <ChoicePicker compact label={t('taskTable.sort.label')} value={sortMode}
                options={[{ value: 'manual', label: t('taskTable.sort.manual') }, { value: 'due_asc', label: t('taskTable.sort.dueDate') }]}
                onValueChange={value => {
                  const nextSort = value === 'due_asc' ? 'due_asc' : 'manual';
                  invalidateInlineSave();
                  setSearchParams(before => { const next = new URLSearchParams(before); if (nextSort === 'due_asc') next.set('sort', nextSort); else next.delete('sort'); return next; });
                }} />
            </label> : null}
            {!timeAvailable && tableMode ? planningChecks.control : null}
            <DialogReturnFocus targetRef={tableMode ? defaultColumnReturn : activeViewControl}>
              <PersonalColumnsDialog showTrigger={tableMode} controller={personalColumns} fields={fieldDefinitions.isSuccess ? fieldDefinitions.data : []} projectColumns={projectColumns.isSuccess ? projectColumns.data : undefined} timeAvailable={timeAvailable} catalogError={fieldDefinitions.error ?? projectColumns.error} onReloadCatalog={async () => { await Promise.all([fieldDefinitions.refetch(), projectColumns.refetch()]); }} />
            </DialogReturnFocus>
          </div>
          {tableMode && grouping === 'assignee' ? <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <span>{t('taskTable.grouping.sectionsAvailable')}</span><Button size="sm" variant="ghost" onClick={showSections}>{t('taskTable.grouping.showSections')}</Button>
          </div> : null}
          {sectionCreate.open && !sectionComposerVisible || !sectionCreate.open && sectionCreate.held ? <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-muted"><span>{t('projects.sectionCreate.retained')}</span><Button size="sm" variant="ghost" onClick={startSection}>{t('projects.sectionCreate.resume')}</Button></div> : null}
          {tableMode && (grouping === 'assignee' || sortMode === 'due_asc') ? (
            <details className="text-xs text-muted">
              <summary className="w-fit cursor-pointer rounded py-1">{t('taskTable.guidance.aboutTable')}</summary>
              <div className="space-y-1 pb-1 pt-1">
                {grouping === 'assignee' ? <p>{t('taskTable.grouping.help')}</p> : null}
                {sortMode === 'due_asc' ? <><p>{t('taskTable.sort.tableHelp')}</p><p>{t('taskTable.sort.manualDragHint')}</p></> : null}
              </div>
            </details>
          ) : null}
          {boardMode && sortMode === 'due_asc' ? <div className="flex items-center gap-2 text-xs text-muted"><p>{t('taskTable.sort.boardHelp')}</p><Button size="sm" variant="ghost" onClick={() => { invalidateInlineSave(); setSearchParams(before => { const next = new URLSearchParams(before); next.delete('sort'); return next; }); }}>{t('taskTable.sort.manual')}</Button></div> : null}
          {personalColumns.query.isError && !personalColumns.denied ? <p role="status" className="text-xs text-amber-800">{t('taskTable.personalColumns.loadFailed')}</p> : null}
          {/* A custom field failure never hides the built-in table. */}
          {fieldsError ? (
            <QueryErrorState
              error={fieldsError.query.error}
              subject={fieldsError.subject}
              headingLevel={2}
              retrying={fieldsError.query.isFetching}
              onRetry={() => void fieldsError.query.refetch()}
            />
          ) : null}
          {importMode ? <ImportView actorId={actorId} workspaceId={workspace.id} project={project} selectedId={importId} canManage={canManageImports} writable={writable && canManageImports} catalog={{ members: members.data, statuses: statuses.data, sections: sections.data, tags: tags.data, fields: fieldDefinitions.data ?? [] }} catalogDenied={importCatalogDenied} onRefreshCatalog={refreshImportCatalog} controller={imports} onSelect={selectImport} onOpenTask={openTask} /> : graphMode ? <>{dependencies.roots === null && shownTasks.length > 100 && selectedTaskIds.length === 0 ? <p role="alert" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{t('projects.projectPage.moreThan100TasksAreLoadedSelectUp')}</p> : null}<GraphView actorId={actorId} workspace={workspace} project={project} controller={dependencies} loadedTasks={dedupeTasks(shownTasks)} sections={sections.data ?? []} onOpen={openGraphTask} /></> : ganttMode ? <GanttView actorId={actorId} workspace={workspace} project={project} tasks={dedupeTasks(shownTasks)} tasksSettled={tasks.isSuccess} selectedIds={selectedTaskIds} selectionDisabled={bulkHeld} onSelect={(id, selected) => changeSelection(selected ? selectedTaskIds.includes(id) || selectedTaskIds.length >= 100 ? selectedTaskIds : [...selectedTaskIds, id] : selectedTaskIds.filter(item => item !== id))} periods={meetingPeriods.data ?? []} members={members.data} controller={schedule} writable={writable && !bulkHeld} hasMore={tasks.hasNextPage} loadingMore={tasks.isFetchingNextPage} onLoadMore={() => void tasks.fetchNextPage()} onOpen={openTask} /> : personalColumns.denied ? <QueryErrorState error={personalColumns.query.error ?? personalColumns.command.error} subject="tablePreference" headingLevel={2} onRetry={() => void personalColumns.reload()} /> : <TaskList
            renderCompletionAction={completionAction}
            boardMode={boardMode}
            sortMode={sortMode}
            grouping={grouping}
            collapsedTaskIds={collapsedTaskIds}
            onTaskCollapsedChange={changeTaskCollapsed}
            collapsedGroupKeys={collapsedGroupKeys}
            onGroupCollapsedChange={changeGroupCollapsed}
            onEditTaskField={startInline}
            isTaskFieldEditBusy={(task, field) => field !== 'title' && bulkInline.selectsMany(task.id) && bulkInline.busy}
            draftTaskIds={draftTaskIds}
            activeFieldEditor={activeInline ? { taskId: activeInline.taskId, field: activeInline.field } : undefined}
            renderTaskFieldEditor={(task, field) => activeInline?.taskId === task.id && activeInline.field === field ? <InlineTaskEdit key={`${task.id}:${field}`} focusClaim={activeInline.focusClaim} titleCaret={activeInline.titleCaret} task={task} field={field} estimatePackages={loadedPackages.packages} statuses={statuses.data} members={members.data} tags={tags.data} sections={sections.data} commands={commands} writable={writable} onClose={reason => closeInline(task, field, reason)} onDeleteTask={field === 'title' && task.archivedAt === null && task.meetingId === null ? () => deleteTask(task) : undefined} onMoreDetails={() => openTask(task.id)} onSaveStarted={beginInlineSave} onSaved={() => setAnnouncement(message('tasks.taskDrawer.taskSaved'))} bulkEdit={bulkInline.port(activeInline.focusClaim)} singleOnly={activeInline.field === 'title' && bulkInline.selectsMany(task.id)} /> : null}
            columnMenu={<TableColumnMenu actorId={actorId} workspaceId={workspace.id} projectId={project.id} canManage={canManageFields} controller={personalColumns} fields={fieldDefinitions.data ?? []} projectColumns={projectColumns.data} timeAvailable={timeAvailable} catalogError={fieldDefinitions.error ?? projectColumns.error} />}
            onCreateSection={startSection}
            quickAdd={quickAdd}
            sectionComposer={sectionCreate.open && grouping === 'section' ? <SectionCreateForm controller={sectionCreate} writable={completionWritable} /> : undefined}
            onMoveTask={moveTask}
            onMoveBoardCard={moveBoardCard}
            moveBlocked={moveBlocked}
            acquireDragProtection={acquireDragProtection}
            selectedTaskIds={selectedTaskIds}
            onSelectionChange={changeSelection}
            onClearSelection={clearSelectionByEscape}
            selectionDisabled={bulkHeld}
            dragScope={taskPresentationKey}
            query={tasks}
            deletedTaskIds={deletedTaskIds}
            filtered={hasActiveTaskFilters(filters)}
            project={project}
            workspace={workspace}
            sections={sections.data}
            statuses={statuses.data}
            members={members.data}
            columnIds={visibleColumnIds}
            customColumns={[...timeColumns, ...customColumns]}
            showLegacySummary={timeAvailable}
            renderColumnAggregate={ordinaryAggregates.renderColumn} showGroupAggregates={ordinaryAggregates.hasMeasures} showProjectAggregates={ordinaryAggregates.hasMeasures || ordinaryAggregates.canConfigure}
            renderGroupMetadata={group => <>{planningChecks.renderGroup(group)}{ordinaryAggregates.renderGroupMetadata(group)}</>}
            renderTaskIndicator={planningChecks.renderTaskIndicator}
            writable={writable}
            onOpenTask={openTask}
            onCreateTask={(sectionId) => startQuickAdd(sectionId ?? null)}
            onCreateChild={startChildInline}
            onRenameSection={writable ? renameSection : undefined}
            onDeleteTask={writable ? deleteTask : undefined}
            onDuplicateTask={writable ? duplication.openTask : undefined}
            onDuplicateSection={writable ? duplication.openSection : undefined}
          />}
          {!importMode && !graphMode ? <LinkedProjectTasks customFields={fieldColumns} expansion={{ expandedTaskIds, collapsedGroupKeys, setTaskCollapsed: changeTaskCollapsed, setGroupCollapsed: changeGroupCollapsed }} actorId={actorId} project={project} sections={sections.data} members={members.data} filters={{ ...filters, search }} writable={writable && !bulkHeld} commands={commands} placementCommands={placementCommands} view={boardMode ? 'board' : ganttMode ? 'timeline' : 'table'} onOpenTask={openTask} windowStart={schedule.windowStart} windowSize={schedule.windowSize} sortByDue={sortMode === 'due_asc'} acquireDragProtection={acquireDragProtection} /> : null}
          <ProjectUndoSurface actorId={actorId} workspaceId={workspace.id} projectId={project.id} writable={writable} />
          <TaskDrawer
            onCompleteTask={(chosen, statusId, source) => { if (!bulkInline.complete(chosen, statusId)) completion.choose(chosen, statusId, source); }}
            onContinueTask={task => setContinueTask(task)}
            newTaskStatusId={taskDefaults.data?.config.statusId ?? null}
            sharedActivityController={sharedActivityController}
            legacyTime={timeAvailable}
            placementCommands={placementCommands}
            commentsController={commentsController}
            dependencyController={dependencies}
            meetingRequestedPeriodId={searchParams.get('meetingPeriod')??undefined}
            onAcceptMeetingPeriod={id=>setSearchParams(before=>{const next=new URLSearchParams(before);next.set('week',id);next.set('meetingPeriod',id);return next;})}
            meetingMembershipId={searchParams.get('meetingMember')??undefined}
            meetingAttendanceId={searchParams.get('meetingAttendance')??undefined}
            meetingController={meetingController}
            meetingOpenIntent={location.key}
            meetingTab={searchParams.get('meetingTab')==='attendance'?'attendance':searchParams.get('meetingTab')==='plan'?'plan':searchParams.get('meetingTab')==='meeting'?'meeting':undefined}
            actorId={actorId}
            workspace={workspace}
            project={project}
            sections={sections.data}
            statuses={statuses.data}
            members={members.data}
            tags={tags.data}
            writable={writable}
            commands={commands}
            fieldValueMutation={fieldValueMutation}
            fieldValueDrafts={fieldValueDrafts.current}
            taskId={taskId}
            creating={creating}
            onClose={closeDrawer}
            onOpenTask={openTask}
            onDuplicateTask={writable ? duplication.openTask : undefined}
            onCreateChild={parent => startCreate({ sectionId: parent.sectionId, parent })}
            onResumeCreate={() => startCreate({ sectionId: null, parent: null })}
            loadedSubtasks={loadedSubtasks}
            subtaskColumns={visibleExtraColumns.filter(column => !['weekly-plan', 'weekly-fact'].includes(column.id) || rowContext.periodId !== null)}
            initialFields={initialFields}
            initialTimeContextFor={initialTimeContextFor}
            initialTimeWritable={rowContext.writable}
            initialTimeCurrent={initialTimeCurrent}
            onCreated={(task) => {
              closeDrawer();
              setAnnouncement(message('projects.projectPage.taskValueCreated', { p0: task.title }));
            }}
            onAnnounce={setAnnouncement}
          />
          {taskTime.dialogs}
          {duplication.dialog}
          <RenameSectionDialog
            actorId={actorId}
            workspaceId={workspace.id}
            section={renamingSection}
            mutation={renameSectionMutation}
            onClose={() => setRenamingSection(null)}
            onRenamed={(section) => setAnnouncement(message('projects.projectPage.sectionRenamedToValue', { p0: section.name }))}
          />
        </>
      ) : (
        <div role="status" className="space-y-3">
          <span className="sr-only">{t('projects.projectPage.loadingProjectTasks')}</span>
          <Skeleton className="h-10 rounded-xl" />
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      )}
    </div>
  );
}

interface TaskListProps {
  renderCompletionAction: NonNullable<ComponentProps<typeof TaskTable>['renderCompletionAction']>;
  boardMode: boolean;
  sortMode: TaskSortMode;
  grouping: TaskGroupingMode;
  collapsedTaskIds: ReadonlySet<string>;
  onTaskCollapsedChange: NonNullable<ComponentProps<typeof TaskTable>['onTaskCollapsedChange']>;
  collapsedGroupKeys: ReadonlySet<string>;
  onGroupCollapsedChange: NonNullable<ComponentProps<typeof TaskTable>['onGroupCollapsedChange']>;
  selectedTaskIds: readonly string[];
  onSelectTask?: ((id: string, selected: boolean) => void) | undefined;
  onSelectionChange?: ((ids: string[]) => void) | undefined;
  onClearSelection?: (() => boolean) | undefined;
  selectionDisabled?: boolean | undefined;
  dragScope?: string | undefined;
  query: ReturnType<typeof useTaskListQuery>;
  deletedTaskIds: ReadonlySet<string>;
  filtered: boolean;
  project: ProjectDto;
  workspace: WorkspaceDto;
  sections: readonly SectionDto[];
  statuses: readonly TaskStatusDto[];
  members: readonly MembershipDto[];
  customColumns: readonly TaskTableCustomColumn[];
  columnIds: readonly string[];
  onEditTaskField: NonNullable<ComponentProps<typeof TaskTable>['onEditTaskField']>;
  isTaskFieldEditBusy?: ComponentProps<typeof TaskTable>['isTaskFieldEditBusy'];
  renderTaskFieldEditor: NonNullable<ComponentProps<typeof TaskTable>['renderTaskFieldEditor']>;
  activeFieldEditor: ComponentProps<typeof TaskTable>['activeFieldEditor'];
  draftTaskIds: ReadonlySet<string>;
  quickAdd: ComponentProps<typeof TaskTable>['quickAdd'];
  sectionComposer?: ComponentProps<typeof TaskTable>['sectionComposer'];
  columnMenu?: ComponentProps<typeof TaskTable>['columnMenu'];
  onCreateSection?: ComponentProps<typeof TaskTable>['onCreateSection'];
  showLegacySummary?: boolean;
  aggregateFooter?: ComponentProps<typeof TaskTable>['aggregateFooter'];
  renderColumnAggregate?: ComponentProps<typeof TaskTable>['renderColumnAggregate'];
  showGroupAggregates?: boolean;
  showProjectAggregates?: boolean;
  renderGroupMetadata?: ComponentProps<typeof TaskTable>['renderGroupMetadata'];
  renderTaskIndicator?: ComponentProps<typeof TaskTable>['renderTaskIndicator'];
  onMoveTask: NonNullable<ComponentProps<typeof TaskTable>['onMoveTask']>;
  onMoveBoardCard: BoardMoveCard;
  moveBlocked: boolean;
  acquireDragProtection: () => () => void;
  writable: boolean;
  onOpenTask: (taskId: string) => void;
  onCreateTask: (sectionId?: string | null) => void;
  onCreateChild: (parent: TaskDto) => void;
  onRenameSection: ((section: SectionDto) => void) | undefined;
  onDuplicateTask?: ComponentProps<typeof TaskTable>['onDuplicateTask'];
  onDeleteTask?: ComponentProps<typeof TaskTable>['onDeleteTask'];
  onDuplicateSection?: ComponentProps<typeof TaskTable>['onDuplicateSection'];
}

function TaskList({ query, deletedTaskIds, filtered, project, workspace, boardMode, ...table }: TaskListProps) {
  const { t } = useTranslation();
  if (query.isPending) {
    return (
      <div role="status" className="space-y-3">
        <span className="sr-only">{t('projects.projectPage.loadingTasks')}</span>
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  // A failed first page hides the list; a failed next page keeps the loaded part.
  if (query.isError && !query.isFetchNextPageError) {
    return (
      <QueryErrorState
        error={query.error}
        subject="tasks"
        headingLevel={2}
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const loadedScope = loadedTaskScope(query.data);
  const scope = deletedTaskIds.size === 0 ? loadedScope : { ...loadedScope, tasks: withoutDeletedTasks(loadedScope.tasks, deletedTaskIds) };
  const dateIssues = completedDateIssues(project, scope.tasks, table.statuses);
  const dateIssueKinds = new Map(dateIssues.map(issue => [issue.taskId, { kind: issue.kind, finished: issue.finished }] as const));
  return (
    <div className="space-y-3">
      {!boardMode ? <CompletedDateBanner project={project} issues={dateIssues} tasks={scope.tasks} partial={filtered || !scope.complete} onOpenTask={table.onOpenTask} /> : null}
      {boardMode ? <TaskBoard onMoveCard={table.sortMode === 'manual' ? table.onMoveBoardCard : undefined} dragBlocked={table.moveBlocked || table.activeFieldEditor !== undefined} dragContextKey={table.dragScope} acquireDragProtection={table.acquireDragProtection} renderCompletionAction={table.renderCompletionAction} tasks={table.sortMode === 'manual' ? orderBoardTaskHeads(scope.tasks, 'manual').sort((left, right) => compareTaskRows(left, right, 'manual')) : orderBoardTaskHeads(scope.tasks, table.sortMode)} statuses={table.statuses} members={table.members} partial={filtered || !scope.complete} writable={table.writable} today={todayIn(workspace.timezone)} draftTaskIds={table.draftTaskIds} caption={t('projects.projectPage.tasksInValue', { p0: project.name })} onOpenTask={table.onOpenTask} onEditStatus={task => table.onEditTaskField(task, 'statusId')} isStatusEditBusy={task => table.isTaskFieldEditBusy?.(task, 'statusId') === true} renderStatusEditor={task => table.renderTaskFieldEditor(task, 'statusId') ?? null} /> : <TaskTable
        {...table}
        tasks={scope.tasks}
        partial={filtered || !scope.complete}
        today={todayIn(workspace.timezone)}
        dateIssues={dateIssueKinds}
        caption={t('projects.projectPage.tasksInValue', { p0: project.name })}
      />}
      {query.isFetchNextPageError ? (
        <QueryErrorState
          error={query.error}
          subject="tasks"
          headingLevel={3}
          retrying={query.isFetchingNextPage}
          onRetry={() => void query.fetchNextPage()}
        />
      ) : null}
      {query.hasNextPage && !query.isFetchNextPageError ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            aria-disabled={query.isFetchingNextPage || undefined}
            onClick={() => {
              if (!query.isFetchingNextPage) void query.fetchNextPage();
            }}
          >
            <RefreshCw
              size={16}
              aria-hidden="true"
              className={query.isFetchingNextPage ? 'motion-safe:animate-spin' : undefined}
            />
            {query.isFetchingNextPage ? t('projects.projectPage.loading') : t('projects.projectPage.loadMoreTasks')}
          </Button>
          <span className="text-sm text-muted">{t('projects.projectPage.moreProjectTasksAreAvailable')}</span>
        </div>
      ) : null}
    </div>
  );
}

function BackToProjects({ href }: { href: string }) {
  const { t } = useTranslation();
  return (
    <Link
      to={href}
      className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-muted hover:text-accent-strong"
    >
      <ArrowLeft size={16} aria-hidden="true" />
      {t('projects.projectPage.allProjects')}</Link>
  );
}

function ProjectUnavailable({ projectsHref }: { projectsHref: string }) {
  const { t } = useTranslation();
  return (
    <StateCard
      headingLevel={1}
      icon={<Lock size={18} aria-hidden="true" />}
      title={t('projects.projectPage.projectUnavailable')}
      description={t('projects.projectPage.thisProjectDoesNotExistOrYouDo')}
      actions={
        <Link to={projectsHref} className={buttonClassName({ variant: 'primary' })}>
          <ArrowLeft size={16} aria-hidden="true" />
          {t('projects.projectPage.backToProjects')}</Link>
      }
    />
  );
}

/** The deleted tasks and their subtasks. */
function withoutDeletedTasks(list: readonly TaskDto[], deleted: ReadonlySet<string>): TaskDto[] {
  return deleted.size === 0 ? [...list] : list.filter(task => !deleted.has(task.id) && (task.parentTaskId === null || !deleted.has(task.parentTaskId)));
}
