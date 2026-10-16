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
  ProjectColumnsDto,
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
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
import { useTaskCommands, type CreateRequest } from '../features/tasks/useTaskCommands';
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

/** Visible columns of active fields in the shared settings' order; settings without a known field are skipped. */
function visibleFieldColumns(definitions: readonly TaskFieldDefinitionDto[], settings: ProjectColumnsDto): FieldColumn[] {
  const activeById = new Map(
    definitions.filter((field) => field.archivedAt === null).map((field) => [field.id.toLowerCase(), field]),
  );
  return settings.columns
    .filter((column) => column.visible)
    .sort((a, b) => a.position - b.position)
    .flatMap((column) => {
      const field = activeById.get(column.fieldId.toLowerCase());
      return field === undefined ? [] : [{ field, width: column.width }];
    });
}

function fieldValueKey(taskId: string, fieldId: string): string {
  return `${taskId.toLowerCase()}:${fieldId.toLowerCase()}`;
}

function ValueLoadingCell() {
  return (
    <>
      <span aria-hidden="true" className="text-subtle">
        …
      </span>
      <span className="sr-only">Значение загружается</span>
    </>
  );
}

function ValueUnavailableCell() {
  return <span className="text-xs text-amber-800">Не загружено</span>;
}

/** Fetches the project with the route guard; the loaded content owns every other query. */
export function ProjectPage() {
  const { actorId, workspace } = useWorkspaceContext();
  const { projectId = '' } = useParams();
  const project = useProjectQuery(actorId, workspace.id, projectId);
  const projectsHref = `/w/${workspace.id}/projects`;
  useDocumentTitle(project.isSuccess ? `${project.data.name} · ${workspace.name}` : `Проект · ${workspace.name}`);

  if (!isUuid(projectId)) return <ProjectUnavailable projectsHref={projectsHref} />;

  if (project.isPending) {
    return (
      <div role="status" className="space-y-4">
        <span className="sr-only">Загрузка проекта</span>
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
  const sections = useSectionsQuery(actorId, workspace.id, project.id);
  const statuses = useStatusesQuery(actorId, workspace.id, project.id);
  const members = useMembershipsQuery(actorId, workspace.id);
  const tags = useTagsQuery(actorId, workspace.id);
  // Owned here so that closing the drawer keeps uncertain commands and drafts.
  const commands = useTaskCommands(actorId, workspace.id);
  const dependencies = useDependencyWorkspace(actorId, workspace.id, project.id);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const navigate = useNavigate();
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
  const [announcement, setAnnouncement] = useState('');
  const [filters, setFilters] = useState<TaskFilterValue>(emptyTaskFilters);
  const search = useDebouncedValue(filters.search.trim(), SEARCH_DEBOUNCE_MS);
  const [searchParams, setSearchParams] = useSearchParams();
  const taskId = searchParams.get('task');
  const graphMode = searchParams.get('view') === 'graph';

  const tasks = useTaskListQuery(actorId, workspace.id, {
    projectId: project.id,
    search,
    statusId: filters.statusId || undefined,
    participantMembershipId: filters.participantMembershipId || undefined,
    includeArchived: filters.includeArchived,
  });

  const canEdit = workspace.role !== 'viewer';
  const writable = canEdit && project.archivedAt === null;
  // The server enforces the role; this only hides controls that would be refused.
  const canManageFields = (workspace.role === 'owner' || workspace.role === 'admin') && project.archivedAt === null;

  // Errors win over loaded data, so a denied refetch hides the custom columns.
  const fieldColumns =
    fieldDefinitions.isSuccess && projectColumns.isSuccess
      ? visibleFieldColumns(fieldDefinitions.data, projectColumns.data)
      : [];
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
  const fieldValues = useProjectFieldValuesQuery(
    actorId,
    workspace.id,
    project.id,
    fieldColumns.length > 0 ? shownTasks.map((task) => task.id) : [],
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
  // The editor waits for real sections, statuses, members and tags.
  const metadataReady = metadataError === undefined && metadata.every((item) => item.query.isSuccess);

  const setTaskParam = (next: string | null) =>
    setSearchParams((previous) => {
      const params = new URLSearchParams(previous);
      if (next === null) params.delete('task');
      else params.set('task', next);
      return params;
    });

  const openTask = (id: string) => {
    setCreating(null);
    setSearchParams(before=>{const next=new URLSearchParams(before);next.set('task',id);for(const key of ['meetingTab','meetingMember','meetingAttendance','meetingPeriod'])next.delete(key);return next;});
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
  const startCreate = (request: CreateRequest) => {
    if (!writable || request.parent?.archivedAt) return;
    setTaskParam(null);
    setCreating(commands.createSession.current?.request ?? request);
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
    <div className="space-y-6">
      <BackToProjects href={projectsHref} />
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere] text-ink sm:text-[1.75rem]">
              {project.name}
            </h1>
            {project.archivedAt ? <Badge tone="muted">В архиве</Badge> : null}
          </div>
          <p className="text-[15px] text-muted">Проект пространства «{workspace.name}».</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {writable&&metadataReady?<Button onClick={()=>meetingController.setCreateOpen(true)}>Новая встреча</Button>:null}
          {canEdit ? (
            <RenameProjectDialog
              actorId={actorId}
              workspaceId={workspace.id}
              project={project}
              trigger={
                <Button>
                  <Pencil size={16} aria-hidden="true" />
                  Переименовать
                </Button>
              }
            />
          ) : null}
          <WorkCategorySettings actorId={actorId} workspaceId={workspace.id} projectId={project.id} canManage={canManageFields} />
          <TagManagerDialog actorId={actorId} workspaceId={workspace.id} canEdit={canEdit} />
          <FieldManagerDialog actorId={actorId} workspaceId={workspace.id} projectId={project.id} canManage={canManageFields} />
          {writable ? (
            <CreateSectionDialog
              actorId={actorId}
              workspaceId={workspace.id}
              projectId={project.id}
              trigger={
                <Button>
                  <FolderPlus size={16} aria-hidden="true" />
                  Новый раздел
                </Button>
              }
              onCreated={(section) => setAnnouncement(`Раздел «${section.name}» создан.`)}
            />
          ) : null}
          {writable && metadataReady ? (
            <Button variant="primary" onClick={() => startCreate({ sectionId: null, parent: null })}>
              <Plus size={16} aria-hidden="true" />
              Новая задача
            </Button>
          ) : null}
        </div>
      </header>

      <DependencyNotices controller={dependencies} />
      <EdgeDialog controller={dependencies} actorId={actorId} workspaceId={workspace.id} project={project} writable={writable} />
      <MeetingCommandNotices controller={meetingController} onOpen={(id,tab,selection)=>setSearchParams(before=>{const next=new URLSearchParams(before);next.set('task',id);next.set('meetingTab',tab);if(selection?.requestedPeriodId)next.set('meetingPeriod',selection.requestedPeriodId);else next.delete('meetingPeriod');if(selection?.membershipId)next.set('meetingMember',selection.membershipId);else next.delete('meetingMember');if(selection?.attendanceId)next.set('meetingAttendance',selection.attendanceId);else next.delete('meetingAttendance');return next;})}/>
      {meetingController.commands.create.pendingCommand||meetingController.commands.create.uncertain?<div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">Создание встречи ещё не подтверждено. <Button size="sm" onClick={()=>meetingController.setCreateOpen(true)}>Открыть создание встречи</Button></div>:null}
      <CreateMeetingDialog accessDenied={[members.error,sections.error,statuses.error,meetingPeriods.error].some(isAccessDenied)} controller={meetingController} members={members.data??[]} periods={meetingPeriods.data??[]} statuses={statuses.data??[]} sections={sections.data??[]} ownMembershipId={members.data?.find(m=>m.userId===actorId)?.id??''} timezone={workspace.timezone} onCreated={id=>setSearchParams(before=>{const next=new URLSearchParams(before);next.set('task',id);next.set('meetingTab','plan');return next;})}/>
      <nav aria-label="Представления проекта" className="flex flex-wrap gap-2">
        <Button variant={graphMode ? 'ghost' : 'primary'} aria-current={!graphMode ? 'page' : undefined} onClick={() => setSearchParams(before => { const next = new URLSearchParams(before); next.delete('view'); return next; })}>Задачи</Button>
        <Button variant={graphMode ? 'primary' : 'ghost'} aria-current={graphMode ? 'page' : undefined} onClick={showGraph}>{selectedTaskIds.length ? `Граф выбранных (${selectedTaskIds.length})` : 'Граф'}</Button>
        <Link to={`/w/${workspace.id}/projects/${project.id}/week`} className={buttonClassName({ variant: 'ghost' })}>
          <CalendarDays size={16} aria-hidden="true" />Неделя
        </Link>
      </nav>

      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
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
                  ? 'Значение поля задачи ещё отправляется.'
                  : 'Значение поля задачи не подтверждено. Пока его результат неизвестен, другие значения полей не отправляются.'}
              </span>
              <Button
                size="sm"
                onClick={() => {
                  if (heldFieldTaskId !== null) openTask(heldFieldTaskId);
                }}
              >
                Открыть отправку
              </Button>
            </div>
          ) : null}
          {taskTime.controls}
          <TaskFilters value={filters} onChange={setFilters} statuses={statuses.data} members={members.data} />
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
          {graphMode ? <>{dependencies.roots === null && shownTasks.length > 100 && selectedTaskIds.length === 0 ? <p role="alert" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Загружено больше 100 задач. Выберите до 100 исходных задач в списке ниже; граф не сокращает набор автоматически.</p> : null}<GraphView actorId={actorId} workspace={workspace} project={project} controller={dependencies} loadedTasks={dedupeTasks(shownTasks)} onOpen={openGraphTask} /></> : <TaskList
            selectedTaskIds={selectedTaskIds}
            onSelectTask={(id, selected) => setSelectedTaskIds(before => selected ? before.includes(id) || before.length >= 100 ? before : [...before, id] : before.filter(item => item !== id))}
            query={tasks}
            filtered={hasActiveTaskFilters(filters)}
            project={project}
            workspace={workspace}
            sections={sections.data}
            statuses={statuses.data}
            members={members.data}
            customColumns={[...taskTime.columns, ...customColumns]}
            writable={writable}
            onOpenTask={openTask}
            onCreateTask={(sectionId) => startCreate({ sectionId: sectionId ?? null, parent: null })}
            onCreateChild={(parent) => startCreate({ sectionId: parent.sectionId, parent })}
            onRenameSection={writable ? renameSection : undefined}
          />}
          <TaskDrawer
            dependencyController={dependencies}
            meetingRequestedPeriodId={searchParams.get('meetingPeriod')??undefined}
            onAcceptMeetingPeriod={id=>setSearchParams(before=>{const next=new URLSearchParams(before);next.set('week',id);next.set('meetingPeriod',id);return next;})}
            meetingMembershipId={searchParams.get('meetingMember')??undefined}
            meetingAttendanceId={searchParams.get('meetingAttendance')??undefined}
            meetingController={meetingController}
            meetingTab={searchParams.get('meetingTab')==='attendance'?'attendance':searchParams.get('meetingTab')==='plan'?'plan':'meeting'}
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
            onResumeCreate={() => startCreate({ sectionId: null, parent: null })}
            onCreated={(task) => {
              closeDrawer();
              setAnnouncement(`Задача «${task.title}» создана.`);
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
            onRenamed={(section) => setAnnouncement(`Раздел переименован в «${section.name}».`)}
          />
        </>
      ) : (
        <div role="status" className="space-y-3">
          <span className="sr-only">Загрузка задач проекта</span>
          <Skeleton className="h-10 rounded-xl" />
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      )}
    </div>
  );
}

interface TaskListProps {
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
  writable: boolean;
  onOpenTask: (taskId: string) => void;
  onCreateTask: (sectionId?: string | null) => void;
  onCreateChild: (parent: TaskDto) => void;
  onRenameSection: ((section: SectionDto) => void) | undefined;
}

function TaskList({ query, filtered, project, workspace, ...table }: TaskListProps) {
  if (query.isPending) {
    return (
      <div role="status" className="space-y-3">
        <span className="sr-only">Загрузка задач</span>
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
      <TaskTable
        {...table}
        tasks={dedupeTasks(scope.tasks)}
        partial={filtered || !scope.complete}
        today={todayIn(workspace.timezone)}
        caption={`Задачи проекта «${project.name}»`}
      />
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
            {query.isFetchingNextPage ? 'Загружаем…' : 'Загрузить ещё задачи'}
          </Button>
          <span className="text-sm text-muted">Загружена часть задач проекта.</span>
        </div>
      ) : null}
    </div>
  );
}

function BackToProjects({ href }: { href: string }) {
  return (
    <Link
      to={href}
      className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-accent-ink hover:text-accent-strong"
    >
      <ArrowLeft size={16} aria-hidden="true" />
      Все проекты
    </Link>
  );
}

function ProjectUnavailable({ projectsHref }: { projectsHref: string }) {
  return (
    <StateCard
      headingLevel={1}
      icon={<Lock size={18} aria-hidden="true" />}
      title="Проект недоступен"
      description="Такого проекта нет или у текущего пользователя нет к нему доступа."
      actions={
        <Link to={projectsHref} className={buttonClassName({ variant: 'primary' })}>
          <ArrowLeft size={16} aria-hidden="true" />
          К списку проектов
        </Link>
      }
    />
  );
}
