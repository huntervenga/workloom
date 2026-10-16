import { TaskCompletionAction } from '../features/tasks/TaskCompletionAction';
import { TaskCompletionFeedback } from '../features/tasks/TaskCompletionFeedback';
import { useTaskCompletion } from '../features/tasks/useTaskCompletion';
import { useCurrentSearchParams } from '../lib/useCurrentSearchParams';
import { TaskBoard } from '../features/task-board';
import { PersonalColumnsDialog } from '../features/task-table/PersonalColumnsDialog';
import { reconcilePersonalColumns, tableColumnId } from '../features/task-table/personalColumns';
import { usePersonalTablePreference } from '../features/task-table/usePersonalTablePreference';
import { CommentCommandRecovery, useTaskCommentsWorkspace } from '../features/task-comments';
import { ProjectActions } from '../features/projects/ProjectActions';
import { weeklyPlanningHref } from '../features/planning/navigation';
import { QuickTaskAdd } from '../features/tasks/QuickTaskAdd';
import { InlineTaskEdit } from '../features/tasks/InlineTaskEdit';
import { TaskCommandRecovery } from '../features/tasks/TaskCommandRecovery';
import { canEditTaskInline, taskInlineColumn, type TaskInlineField } from '../features/tasks/tableEditing';
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
  TaskFieldDefinitionDto,
  TaskFieldValueDto,
  TaskStatusDto,
  WorkspaceDto,
} from '@workloom/contracts';
import { Badge, Button, Skeleton, StateCard, buttonClassName } from '@workloom/ui';
import { ArrowLeft, CalendarDays, FolderPlus, Lock, Pencil, Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import {
  FieldManagerDialog,
  FieldValueDisplay,
  useProjectColumnsQuery,
  useProjectFieldValuesQuery,
  useSetTaskFieldValueMutation,
  useTaskFieldsQuery,
  type FieldValueDraftStore,
} from '../features/fields';
import { RenameProjectDialog } from '../features/projects/ProjectDialogs';
import { useProjectQuery, useSectionsQuery, useStatusesQuery, useUpdateSectionMutation } from '../features/projects/queries';
import { CreateSectionDialog, RenameSectionDialog } from '../features/projects/SectionDialogs';
import { TaskTable, dedupeTasks, type TaskTableCustomColumn } from '../features/task-table';
import { TagManagerDialog } from '../features/tasks/TagDialogs';
import { TaskDrawer } from '../features/tasks/TaskDrawer';
import {
  TaskFilters,
  emptyTaskFilters,
  hasActiveTaskFilters,
  useDebouncedValue,
  type TaskFilterValue,
} from '../features/tasks/TaskFilters';
import { loadedTaskScope, useTagsQuery, useTaskListQuery } from '../features/tasks/queries';
import { useTaskCommands, unresolvedTaskCommand, type CreateRequest } from '../features/tasks/useTaskCommands';
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


function fieldValueKey(taskId: string, fieldId: string): string {
  return `${taskId.toLowerCase()}:${fieldId.toLowerCase()}`;
}

function ValueLoadingCell() {
  const { t } = useTranslation();
  return (
    <>
      <span aria-hidden="true" className="text-subtle">
        …
      </span>
      <span className="sr-only">{t('projects.projectPage.loadingValue')}</span>
    </>
  );
}

function ValueUnavailableCell() {
  const { t } = useTranslation();
  return <span className="text-xs text-amber-800">{t('projects.projectPage.notLoaded')}</span>;
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
  const { t } = useTranslation();
  const sections = useSectionsQuery(actorId, workspace.id, project.id);
  const statuses = useStatusesQuery(actorId, workspace.id, project.id);
  const members = useMembershipsQuery(actorId, workspace.id);
  const tags = useTagsQuery(actorId, workspace.id);
  const personalColumns = usePersonalTablePreference(actorId, workspace.id, project.id, members.data?.find(member => member.userId === actorId)?.id ?? '');
  // Owned here so that closing the drawer keeps uncertain commands and drafts.
  const commands = useTaskCommands(actorId, workspace.id);
  const commentsController = useTaskCommentsWorkspace(actorId, workspace.id);
  const dependencies = useDependencyWorkspace(actorId, workspace.id, project.id);
  const schedule = useScheduleWorkspace(actorId, workspace.id, project.id, workspace.timezone);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const navigate = useNavigate();
  const location = useLocation();
  const meetingController=useMeetingWorkspace(actorId,workspace.id,project.id);
  const meetingPeriods=usePlanningPeriodsQuery(actorId,workspace.id,project.id);
  // Same for custom field values: a hidden drawer keeps a value write that is pending or unconfirmed.
  const fieldValueMutation = useSetTaskFieldValueMutation(actorId, workspace.id);
  const fieldValueDrafts = useRef<FieldValueDraftStore>(new Map());
  // The write may finish while its drawer is closed. Retire only that confirmed draft;
  // later unsent changes are kept until the next command actually receives an answer.
  useEffect(() => {
    const confirmed = fieldValueMutation.data;
    if (!confirmed) return;
    const key = confirmed.taskId.toLowerCase();
    const drafts = fieldValueDrafts.current.get(key);
    if (drafts) {
      fieldValueDrafts.current.set(
        key,
        Object.fromEntries(Object.entries(drafts).filter(([id]) => id !== confirmed.fieldId.toLowerCase())),
      );
    }
  }, [fieldValueMutation.data]);
  const fieldDefinitions = useTaskFieldsQuery(actorId, workspace.id, project.id);
  const projectColumns = useProjectColumnsQuery(actorId, workspace.id, project.id);
  const renameSectionMutation = useUpdateSectionMutation(actorId, workspace.id);
  const [renamingSection, setRenamingSection] = useState<SectionDto | null>(null);
  const [creating, setCreating] = useState<CreateRequest | null>(null);
  const [quickAddSection, setQuickAddSection] = useState<string | null | undefined>(undefined);
  const [activeInline, setActiveInline] = useState<{ taskId: string; field: TaskInlineField; focusClaim: { current: boolean } } | null>(null);
  const [announcement, setAnnouncement] = useState<TranslationMessage | null>(null);
  const [filters, setFilters] = useState<TaskFilterValue>(emptyTaskFilters);
  const search = useDebouncedValue(filters.search.trim(), SEARCH_DEBOUNCE_MS);
  const [searchParams, setSearchParams] = useCurrentSearchParams();
  const taskId = searchParams.get('task');
  const boardMode = searchParams.get('view') === 'board';
  const graphMode = searchParams.get('view') === 'graph';
  const ganttMode = searchParams.get('view') === 'gantt';
  const importMode = searchParams.get('view') === 'import';
  const importId = searchParams.get('import') ?? '';
  const selectImport = useCallback((id: string) => setSearchParams(before => { const next = new URLSearchParams(before); next.set('view', 'import'); if (id) next.set('import', id); else next.delete('import'); return next; }), [setSearchParams]);
  const imports = useImportWorkspace(actorId, workspace.id, project.id, isUuid(importId) ? importId : '', selectImport);

  const tasks = useTaskListQuery(actorId, workspace.id, {
    projectId: project.id,
    search,
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
  const shownTasks = useMemo(() =>
    tasks.data !== undefined && (!tasks.isError || tasks.isFetchNextPageError) ? loadedTaskScope(tasks.data).tasks : [],
    [tasks.data, tasks.isError, tasks.isFetchNextPageError]);
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
  const timeAvailable = Boolean(taskTime.context.periodId && members.data?.some(member => member.id === taskTime.context.workerId) && meetingPeriods.data?.some(period => period.id === taskTime.context.periodId));
  const reconciledColumns = useMemo(() => reconcilePersonalColumns(personalColumns.query.data?.columns ?? null,
    fieldDefinitions.isSuccess ? fieldDefinitions.data : [], projectColumns.isSuccess ? projectColumns.data : { workspaceId: workspace.id, projectId: project.id, revision: 1, columns: [] }, timeAvailable),
    [personalColumns.query.data?.columns, fieldDefinitions.data, fieldDefinitions.isSuccess, projectColumns.data, projectColumns.isSuccess, workspace.id, project.id, timeAvailable]);
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
  const valueByKey = new Map<string, TaskFieldValueDto>(
    fieldValues.data.map((value) => [fieldValueKey(value.taskId, value.fieldId), value]),
  );
  const customColumns: TaskTableCustomColumn[] = fieldColumns.map(({ field, width }) => ({
    id: field.id,
    label: field.name,
    width,
    // An unloaded value is not an unset one: `null` is shown only after a known read.
    renderCell: (task) =>
      fieldValues.isError ? (
        <ValueUnavailableCell />
      ) : fieldValues.isPending ? (
        <ValueLoadingCell />
      ) : (
        <FieldValueDisplay
          field={field}
          value={valueByKey.get(fieldValueKey(task.id, field.id))?.value ?? null}
          members={members.data ?? []}
          compact
        />
      ),
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
  const showHeldFieldValue = heldFieldTaskId !== null && taskId?.toLowerCase() !== heldFieldTaskId.toLowerCase();
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
  const completion = useTaskCompletion(commands, { tasks: dedupeTasks(shownTasks), statuses: statuses.data ?? [], writable: completionWritable, editingTaskId: activeInline?.taskId ?? null }, () => setAnnouncement(message('tasks.completion.saved')));

  const setTaskParam = (next: string | null) =>
    setSearchParams((previous) => {
      const params = new URLSearchParams(previous);
      if (next === null) params.delete('task');
      else params.set('task', next);
      return params;
    });

  const openTask = (id: string) => {
    setQuickAddSection(undefined);
    setActiveInline(null);
    setCreating(null);
    setSearchParams(before=>{const next=new URLSearchParams(before);next.set('task',id);for(const key of ['meetingTab','meetingMember','meetingAttendance','meetingPeriod'])next.delete(key);return next;});
  };
  const completionAction = (task: TaskDto) => <TaskCompletionAction task={task} statuses={statuses.data ?? []} writable={completionWritable} blocked={unresolvedTaskCommand(commands) !== null} pending={completion.pending && completion.attempt?.session.base.id === task.id} hasDraft={commands.editSessions.current.has(task.id)} editing={activeInline?.taskId === task.id} onChoose={completion.choose} onReview={openTask} />;
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
  const startCreate = (request: CreateRequest) => {
    if (!writable || request.parent?.archivedAt) return;
    const kept = commands.createSession.current;
    setActiveInline(null);
    setTaskParam(null);
    if (kept?.origin === 'quick' && (commands.create.pendingCommand || commands.create.uncertain)) {
      setCreating(null);
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
    if (!writable || !metadataReady) return;
    setTaskParam(null);
    setCreating(null);
    setActiveInline(null);
    const kept = commands.createSession.current;
    setQuickAddSection(kept?.origin === 'quick' ? kept.request.sectionId : sectionId);
  };
  const startInline = (task: TaskDto, field: TaskInlineField) => {
    if (!writable || !canEditTaskInline(task)) return;
    const held = unresolvedTaskCommand(commands);
    if (held && (held.taskId !== task.id || !commands.update.pendingCommand && !commands.update.uncertain)) return;
    setTaskParam(null);
    setCreating(null);
    setQuickAddSection(undefined);
    setActiveInline({ taskId: task.id, field, focusClaim: { current: false } });
  };
  const closeInline = (taskId: string, field: TaskInlineField) => {
    setActiveInline(null);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`button[data-task-cell="${taskId}:${field}"]`)?.focus());
  };
  const closeDrawer = () => {
    setCreating(null);
    if (taskId !== null) setTaskParam(null);
  };
  // A rename still being sent or unconfirmed keeps its section: reopening shows that one.
  const heldSectionId =
    renameSectionMutation.pendingCommand?.variables.sectionId ?? renameSectionMutation.uncertain?.variables.sectionId ?? null;
  const renameSection = (section: SectionDto) =>
    setRenamingSection(sections.data?.find((item) => item.id === heldSectionId) ?? section);

  return (
    <div className="min-w-0 space-y-3">
      <header className="flex min-w-0 items-center gap-3">
        <div className="min-w-0 flex-1">
          <BackToProjects href={projectsHref} />
          <div className="flex min-w-0 items-center gap-2">
            <h1 title={project.name} className="min-w-0 truncate text-xl font-semibold tracking-tight text-ink">{project.name}</h1>
            {project.archivedAt ? <Badge tone="muted">{t('projects.projectPage.archived')}</Badge> : null}
          </div>
        </div>
        {writable && metadataReady ? <Button size="sm" variant="primary" onClick={() => startCreate({ sectionId: null, parent: null })}><Plus size={16} aria-hidden="true" />{t('projects.projectPage.newTask')}</Button> : null}
        <ProjectActions>
            {writable && metadataReady ? <Button size="sm" variant="ghost" onClick={() => meetingController.setCreateOpen(true)}>{t('projects.projectPage.newMeeting')}</Button> : null}
            {canEdit ? <RenameProjectDialog actorId={actorId} workspaceId={workspace.id} project={project} trigger={<Button size="sm" variant="ghost"><Pencil size={16} aria-hidden="true" />{t('projects.projectPage.rename')}</Button>} /> : null}
            <WorkCategorySettings actorId={actorId} workspaceId={workspace.id} projectId={project.id} canManage={canManageFields} />
            <TagManagerDialog actorId={actorId} workspaceId={workspace.id} canEdit={canEdit} />
            <FieldManagerDialog triggerLabel={t('projects.projectPage.teamColumns')} actorId={actorId} workspaceId={workspace.id} projectId={project.id} canManage={canManageFields} />
            {writable ? <CreateSectionDialog actorId={actorId} workspaceId={workspace.id} projectId={project.id} trigger={<Button size="sm" variant="ghost"><FolderPlus size={16} aria-hidden="true" />{t('projects.projectPage.newSection')}</Button>} onCreated={section => setAnnouncement(message('projects.projectPage.sectionValueCreated', { p0: section.name }))} /> : null}
        </ProjectActions>
      </header>

      <TaskCompletionFeedback controller={completion} onReview={openTask} />
      <CommentCommandRecovery controller={commentsController} visibleTaskId={taskId} onOpen={openTask} />
      {taskId === null && creating === null && (quickAddSection === undefined || boardMode || graphMode || ganttMode || importMode) && (!activeInline || personalColumns.denied || graphMode || ganttMode || importMode || !shownTasks.some(task => task.id === activeInline.taskId) || (boardMode ? activeInline.field !== 'statusId' : !visibleColumnIds.includes(taskInlineColumn(activeInline.field)))) ? <TaskCommandRecovery commands={commands} onResumeCreate={() => startCreate({ sectionId: null, parent: null })} onOpenTask={openTask} /> : null}
      <ImportNotices controller={imports} onSelect={selectImport} selectedId={importId} canManage={canManageImports} />
      <ScheduleNotices controller={schedule} />
      <ScheduleDialog controller={schedule} workspaceId={workspace.id} projectId={project.id} periods={meetingPeriods.data ?? []} writable={writable} />
      <DependencyNotices controller={dependencies} />
      <EdgeDialog controller={dependencies} actorId={actorId} workspaceId={workspace.id} project={project} writable={writable} />
      <MeetingCommandNotices controller={meetingController} onOpen={(id,tab,selection)=>setSearchParams(before=>{const next=new URLSearchParams(before);next.set('task',id);next.set('meetingTab',tab);if(selection?.requestedPeriodId)next.set('meetingPeriod',selection.requestedPeriodId);else next.delete('meetingPeriod');if(selection?.membershipId)next.set('meetingMember',selection.membershipId);else next.delete('meetingMember');if(selection?.attendanceId)next.set('meetingAttendance',selection.attendanceId);else next.delete('meetingAttendance');return next;})}/>
      {meetingController.commands.create.pendingCommand||meetingController.commands.create.uncertain?<div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">{t('projects.projectPage.meetingCreationIsUnconfirmed')}<Button size="sm" onClick={()=>meetingController.setCreateOpen(true)}>{t('projects.projectPage.openMeetingCreation')}</Button></div>:null}
      <CreateMeetingDialog accessDenied={[members.error,sections.error,statuses.error,meetingPeriods.error].some(isAccessDenied)} controller={meetingController} members={members.data??[]} periods={meetingPeriods.data??[]} statuses={statuses.data??[]} sections={sections.data??[]} ownMembershipId={members.data?.find(m=>m.userId===actorId)?.id??''} timezone={workspace.timezone} onCreated={id=>setSearchParams(before=>{const next=new URLSearchParams(before);next.set('task',id);next.set('meetingTab','plan');return next;})}/>
      <nav aria-label={t('projects.projectPage.projectViews')} className="flex min-w-0 flex-nowrap gap-1 overflow-x-auto border-b border-line pb-2">
        <Button size="sm" variant={boardMode || graphMode || ganttMode || importMode ? 'ghost' : 'primary'} aria-current={!boardMode && !graphMode && !ganttMode && !importMode ? 'page' : undefined} onClick={() => setSearchParams(before => { const next = new URLSearchParams(before); next.delete('view'); return next; })}>{t('projects.projectPage.tasks')}</Button>
        <Button size="sm" variant={boardMode ? 'primary' : 'ghost'} aria-current={boardMode ? 'page' : undefined} onClick={() => setSearchParams(before => { const next = new URLSearchParams(before); next.set('view', 'board'); return next; })}>{t('projects.projectPage.board')}</Button>
        <Button size="sm" variant={graphMode ? 'primary' : 'ghost'} aria-current={graphMode ? 'page' : undefined} onClick={showGraph}>{selectedTaskIds.length ? t('projects.projectPage.selectedGraphValue', { p0: selectedTaskIds.length }) : t('projects.projectPage.graph')}</Button>
        <Button size="sm" variant={ganttMode ? 'primary' : 'ghost'} aria-current={ganttMode ? 'page' : undefined} onClick={() => setSearchParams(before => { const next = new URLSearchParams(before); next.set('view', 'gantt'); return next; })}>{t('projects.projectPage.timeline')}</Button>
        {canManageImports ? <Button size="sm" variant={importMode ? 'primary' : 'ghost'} aria-current={importMode ? 'page' : undefined} onClick={() => selectImport(importId)}>{t('projects.projectPage.cSVImport')}</Button> : null}
        <Link to={weeklyPlanningHref(workspace.id, project.id, { periodId: taskTime.context.periodId, workerId: taskTime.context.workerId, explicitEmptyPeriod: true })} className={buttonClassName({ variant: 'ghost', size: 'sm' })}>
          <CalendarDays size={16} aria-hidden="true" />{t('projects.projectPage.week')}</Link>
      </nav>

      <div role="status" aria-live="polite" className="sr-only">
        {announcement ? t(announcement.key, announcement.params) : null}
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
          {taskTime.controls}
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1"><TaskFilters value={filters} onChange={setFilters} statuses={statuses.data} members={members.data} tags={tags.data ?? []} /></div>
            <PersonalColumnsDialog showTrigger={!boardMode} controller={personalColumns} fields={fieldDefinitions.isSuccess ? fieldDefinitions.data : []} projectColumns={projectColumns.isSuccess ? projectColumns.data : undefined} timeAvailable={timeAvailable} catalogError={fieldDefinitions.error ?? projectColumns.error} onReloadCatalog={async () => { await Promise.all([fieldDefinitions.refetch(), projectColumns.refetch()]); }} />
          </div>
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
          {importMode ? <ImportView actorId={actorId} workspaceId={workspace.id} project={project} selectedId={importId} canManage={canManageImports} writable={writable && canManageImports} catalog={{ members: members.data, statuses: statuses.data, sections: sections.data, tags: tags.data, fields: fieldDefinitions.data ?? [] }} catalogDenied={importCatalogDenied} onRefreshCatalog={refreshImportCatalog} controller={imports} onSelect={selectImport} onOpenTask={openTask} /> : graphMode ? <>{dependencies.roots === null && shownTasks.length > 100 && selectedTaskIds.length === 0 ? <p role="alert" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{t('projects.projectPage.moreThan100TasksAreLoadedSelectUp')}</p> : null}<GraphView actorId={actorId} workspace={workspace} project={project} controller={dependencies} loadedTasks={dedupeTasks(shownTasks)} onOpen={openGraphTask} /></> : ganttMode ? <GanttView actorId={actorId} workspace={workspace} project={project} tasks={dedupeTasks(shownTasks)} selectedIds={selectedTaskIds} onSelect={(id, selected) => setSelectedTaskIds(before => selected ? before.includes(id) || before.length >= 100 ? before : [...before, id] : before.filter(item => item !== id))} periods={meetingPeriods.data ?? []} members={members.data} controller={schedule} writable={writable} hasMore={tasks.hasNextPage} loadingMore={tasks.isFetchingNextPage} onLoadMore={() => void tasks.fetchNextPage()} onOpen={openTask} /> : personalColumns.denied ? <QueryErrorState error={personalColumns.query.error ?? personalColumns.command.error} subject="tablePreference" headingLevel={2} onRetry={() => void personalColumns.reload()} /> : <TaskList
            renderCompletionAction={completionAction}
            boardMode={boardMode}
            onEditTaskField={startInline}
            draftTaskIds={new Set(commands.editSessions.current.keys())}
            renderTaskFieldEditor={(task, field) => activeInline?.taskId === task.id && activeInline.field === field ? <InlineTaskEdit key={`${task.id}:${field}`} focusClaim={activeInline.focusClaim} task={task} field={field} statuses={statuses.data} members={members.data} commands={commands} writable={writable} onClose={() => closeInline(task.id, field)} onMoreDetails={() => openTask(task.id)} onSaved={() => setAnnouncement(message('tasks.taskDrawer.taskSaved'))} /> : null}
            quickAdd={quickAddSection !== undefined ? { sectionId: quickAddSection, content: <QuickTaskAdd key={quickAddSection ?? 'none'} projectId={project.id} sectionId={quickAddSection} sectionName={sections.data.find(section => section.id === quickAddSection)?.name ?? t('tasks.taskFields.noSection')} statuses={statuses.data} members={members.data} commands={commands} writable={writable} onClose={() => setQuickAddSection(undefined)} onMoreDetails={() => startCreate({ sectionId: quickAddSection, parent: null })} onCreated={task => setAnnouncement(message('projects.projectPage.taskValueCreated', { p0: task.title }))} /> } : undefined}
            selectedTaskIds={selectedTaskIds}
            onSelectTask={(id, selected) => setSelectedTaskIds(before => selected ? before.includes(id) || before.length >= 100 ? before : [...before, id] : before.filter(item => item !== id))}
            query={tasks}
            filtered={hasActiveTaskFilters(filters)}
            project={project}
            workspace={workspace}
            sections={sections.data}
            statuses={statuses.data}
            members={members.data}
            columnIds={visibleColumnIds}
            customColumns={[...taskTime.columns, ...customColumns]}
            writable={writable}
            onOpenTask={openTask}
            onCreateTask={(sectionId) => startQuickAdd(sectionId ?? null)}
            onCreateChild={(parent) => startCreate({ sectionId: parent.sectionId, parent })}
            onRenameSection={writable ? renameSection : undefined}
          />}
          <TaskDrawer
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
            onCreateChild={parent => startCreate({ sectionId: parent.sectionId, parent })}
            onResumeCreate={() => startCreate({ sectionId: null, parent: null })}
            onCreated={(task) => {
              closeDrawer();
              setAnnouncement(message('projects.projectPage.taskValueCreated', { p0: task.title }));
            }}
            onAnnounce={setAnnouncement}
          />
          {taskTime.dialogs}
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
  selectedTaskIds: readonly string[];
  onSelectTask: (id: string, selected: boolean) => void;
  query: ReturnType<typeof useTaskListQuery>;
  filtered: boolean;
  project: ProjectDto;
  workspace: WorkspaceDto;
  sections: readonly SectionDto[];
  statuses: readonly TaskStatusDto[];
  members: readonly MembershipDto[];
  customColumns: readonly TaskTableCustomColumn[];
  columnIds: readonly string[];
  onEditTaskField: NonNullable<ComponentProps<typeof TaskTable>['onEditTaskField']>;
  renderTaskFieldEditor: NonNullable<ComponentProps<typeof TaskTable>['renderTaskFieldEditor']>;
  draftTaskIds: ReadonlySet<string>;
  quickAdd: ComponentProps<typeof TaskTable>['quickAdd'];
  writable: boolean;
  onOpenTask: (taskId: string) => void;
  onCreateTask: (sectionId?: string | null) => void;
  onCreateChild: (parent: TaskDto) => void;
  onRenameSection: ((section: SectionDto) => void) | undefined;
}

function TaskList({ query, filtered, project, workspace, boardMode, ...table }: TaskListProps) {
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

  const scope = loadedTaskScope(query.data);
  return (
    <div className="space-y-3">
      {boardMode ? <TaskBoard renderCompletionAction={table.renderCompletionAction} tasks={dedupeTasks(scope.tasks)} statuses={table.statuses} members={table.members} partial={!scope.complete} writable={table.writable} today={todayIn(workspace.timezone)} draftTaskIds={table.draftTaskIds} caption={t('projects.projectPage.tasksInValue', { p0: project.name })} onOpenTask={table.onOpenTask} onEditStatus={task => table.onEditTaskField(task, 'statusId')} renderStatusEditor={task => table.renderTaskFieldEditor(task, 'statusId') ?? null} /> : <TaskTable
        {...table}
        tasks={dedupeTasks(scope.tasks)}
        partial={filtered || !scope.complete}
        today={todayIn(workspace.timezone)}
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
