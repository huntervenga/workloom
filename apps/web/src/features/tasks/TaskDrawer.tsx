import { Link } from 'react-router';
import { PlacementCommandFeedback } from '../project-placements/PlacementCommandFeedback';
import { useProjectQuery, useSectionsQuery, useStatusesQuery } from '../projects/queries';
import { TaskProjectsField } from '../project-placements/TaskProjectsField';
import { usePlacementCommands, type PlacementCommands } from '../project-placements/queries';
import { TaskActivityStream, type TaskCommentsWorkspace } from '../task-comments';
import { message, type TranslationMessage } from '../../i18n';
import { useTranslation } from '../../i18n';
import { DependencyPanel } from '../dependencies/DependencyPanel';
import type { DependencyWorkspace } from '../dependencies/useDependencyWorkspace';
import { MeetingDrawer } from '../meetings/MeetingDrawer';
import type { MeetingTab, MeetingWorkspace } from '../meetings/useMeetingWorkspace';
import type {
  MembershipDto,
  ProjectDto,
  SectionDto,
  TagDto,
  TaskDto,
  TaskFieldDefinitionDto,
  TaskStatusDto,
  TaskWorkScope,
  WorkspaceDto,
} from '@workloom/contracts';
import { Badge, Button, Skeleton, StateCard } from '@workloom/ui';
import { Archive, ArchiveRestore, Lock, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ApiError } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { isUuid } from '../../lib/format';
import { useUnsavedChangesWarning } from '../../lib/useUnsavedChangesWarning';
import { DialogShell } from '../../shared/DialogShell';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { TaskCustomFields, type FieldValueDraftStore, type useSetTaskFieldValueMutation } from '../fields';
import { formatEstimate, formatEstimateInput, type TaskTableCustomColumn } from '../task-table';
import { OriginalEstimate } from '../planning/OriginalEstimate';
import { taskWouldRegress, useReloadTask, useTaskQuery } from './queries';
import { CreateTagDialog } from './TagDialogs';
import { DrawerSubtasks } from './DrawerSubtasks';
import {
  emptyInitialTaskCellsDraft,
  hasInitialTaskCells,
  InitialCustomFieldCell,
  InitialTaskTimeCell,
  sameTimeContext,
  type InitialTaskCellsDraft,
  type InitialTaskCellsIssue,
  type InitialTimeContext,
} from './InitialTaskCells';
import { buildInitialTaskPayload, snapshotInitialTaskPayload } from './initialTaskPayload';
import { TaskFields, fieldLabels, formatDraftValue, type EstimateMode, type TaskLookups } from './TaskFields';
import {
  activeParticipantIds,
  buildCreateInput,
  changedKeys,
  draftFromTask,
  emptyDraft,
  inheritsEstimate,
  taskDraftKeys,
  type TaskDraft,
  type TaskDraftErrors,
  type TaskDraftKey,
} from './taskDraft';
import { autosaveRetains, type AutosavePhase } from './taskAutosave';
import {
  resolveQuickCreateInput,
  unresolvedTaskCommand,
  type CreateRequest,
  type CreateSession,
  type TaskCommands,
  type UnresolvedTaskCommand,
} from './useTaskCommands';

export interface TaskDrawerProps {
  /** Explicit legacy planning routes only; ordinary time values are custom fields. */
  legacyTime?: boolean;
  placementCommands?: PlacementCommands | undefined;
  /** The page context remains visible while editing a linked canonical task. */
  viewedProjectName?: string | undefined;
  commentsController?: TaskCommentsWorkspace;
  dependencyController?: DependencyWorkspace;
  meetingController?: MeetingWorkspace;
  meetingTab?: MeetingTab | undefined;
  meetingOpenIntent?: string | undefined;
  meetingRequestedPeriodId?:string|undefined;
  onAcceptMeetingPeriod?:((id:string)=>void)|undefined;
  meetingMembershipId?: string|undefined;
  meetingAttendanceId?: string|undefined;
  actorId: string;
  workspace: WorkspaceDto;
  project: ProjectDto;
  sections: readonly SectionDto[];
  statuses: readonly TaskStatusDto[];
  members: readonly MembershipDto[];
  tags: readonly TagDto[];
  /** The actor may change tasks in this project (not a viewer, project not archived). */
  writable: boolean;
  /** Owned by the page, so closing the drawer keeps uncertain commands and drafts. */
  commands: TaskCommands;
  /**
   * Custom field value writes, owned by the page for the same reason as `commands`. Without it
   * the saved-task form shows no custom fields.
   */
  fieldValueMutation?: ReturnType<typeof useSetTaskFieldValueMutation> | undefined;
  fieldValueDrafts?: FieldValueDraftStore | undefined;
  /** The `task` URL parameter as given; it is validated here. */
  taskId: string | null;
  creating: CreateRequest | null;
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
  /** Reuses the page-owned child composer; existing create sessions keep their original parent. */
  onCreateChild?: ((parent: TaskDto) => void) | undefined;
  /** Reopens the kept new-task form, e.g. to resolve its unconfirmed create. */
  onResumeCreate: () => void;
  /** Direct children of the open task among the page's loaded tasks; absent without a current list. */
  loadedSubtasks?: LoadedSubtasks | undefined;
  onCreated: (task: TaskDto) => void;
  onAnnounce: (message: TranslationMessage) => void;
  /**
   * Current field definitions of the project. Values staged on a new row are kept and checked
   * against them; without it the staged snapshots are still sent only after their own validation.
   */
  initialFields?: readonly TaskFieldDefinitionDto[] | undefined;
  /**
   * The explicitly selected week and person for hours of a new row under `parent` (null for a
   * root) with `workScope`, or `null`. Never a fallback; a shared parent plan carries its loaded
   * commitment revision only for a detail child.
   */
  initialTimeContextFor?: ((parent: TaskDto | null, workScope: TaskWorkScope) => InitialTimeContext | null) | undefined;
  /** The actor may stage plan and actual hours for that context. */
  initialTimeWritable?: boolean | undefined;
  /** The context comes from a current projection; a stale one is never captured. */
  initialTimeCurrent?: boolean | undefined;
  /** Visible custom and weekly columns of the page table, shown by the subtask rows too. */
  subtaskColumns?: readonly TaskTableCustomColumn[] | undefined;
}

/** The context new hours may capture now, or `null` when none may be captured. */
export function capturableTimeContext(
  props: Pick<TaskDrawerProps, 'initialTimeContextFor' | 'initialTimeWritable' | 'initialTimeCurrent'>,
  parent: TaskDto | null,
  workScope: TaskWorkScope,
): InitialTimeContext | null {
  if (props.initialTimeWritable !== true || props.initialTimeCurrent !== true) return null;
  return props.initialTimeContextFor?.(parent, workScope) ?? null;
}

/**
 * The page's loaded direct children of one task. It is a view of loaded rows, never a server
 * count: filters, search, archived exclusion or unloaded pages may hide other children.
 */
export interface LoadedSubtasks {
  parentId: string;
  /** In manual order. */
  tasks: readonly TaskDto[];
  /** Filters, search or unloaded pages may hide other children. */
  partial: boolean;
  /** Archived children are loaded only while the archived filter is on. */
  includesArchived: boolean;
  /** When the list behind `tasks` was loaded, and whether a newer one is being fetched. */
  loadedAt?: number | undefined;
  fetching?: boolean | undefined;
}

/** Newest copy of every tag by ID, so a renamed tag shows its current name. */
function mergeTags(...lists: (readonly TagDto[])[]): Map<string, TagDto> {
  const byId = new Map<string, TagDto>();
  for (const list of lists) {
    for (const tag of list) {
      const known = byId.get(tag.id);
      if (!known || tag.revision > known.revision) byId.set(tag.id, tag);
    }
  }
  return byId;
}

/**
 * The task forms fill the drawer: fields scroll in the body while the actions stay in an opaque
 * footer below it. The side padding keeps focus rings clear of the scroll container's clipping.
 */
const formBodyClassName = '-mx-1 min-h-0 flex-1 scroll-py-4 space-y-4 overflow-y-auto px-1 pt-1 pb-6';
const formFooterClassName = 'flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-surface pt-4';

/** Submits only this form; portalled/nested editors keep their own keyboard behavior. */
export function submitTaskFormShortcut(event: KeyboardEvent<HTMLFormElement>, enabled: boolean): void {
  if (!enabled || event.defaultPrevented || event.nativeEvent.isComposing || event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
  const target = event.target;
  if (!(target instanceof Element) || target.closest('form') !== event.currentTarget) return;
  event.preventDefault();
  event.currentTarget.requestSubmit();
}


function defaultStatusId(statuses: readonly TaskStatusDto[]): string | null {
  const ordered = [...statuses].sort((a, b) => a.position - b.position);
  return (ordered.find((status) => status.group === 'todo') ?? ordered[0])?.id ?? null;
}

/**
 * Task detail and creation in a right-hand drawer (full width on small screens). Details are
 * fetched by ID. Linked tasks resolve authorized canonical home metadata before editing.
 */
export function TaskDrawer(props: TaskDrawerProps) {
  const { t } = useTranslation();
  const { actorId, workspace, project, taskId, creating } = props;
  const onClose = () => {
    // Explicit close runs before the pane's focus/animation lifecycle can remove its inputs.
    if (taskId !== null && (!foreign || homeReady) && resolvedProps.writable) props.commands.autosave.flush(taskId);
    props.onClose();
  };
  const localPlacementCommands = usePlacementCommands(actorId, workspace.id);
  const detail = useTaskQuery(actorId, workspace.id, taskId ?? '');
  const foreign = detail.data !== undefined && detail.data.workspaceId === workspace.id && detail.data.projectId !== project.id;
  const homeId = foreign && !detail.isError ? detail.data?.projectId ?? '' : '';
  const home = useProjectQuery(actorId, workspace.id, homeId);
  const homeSections = useSectionsQuery(actorId, workspace.id, homeId);
  const homeStatuses = useStatusesQuery(actorId, workspace.id, homeId);
  const homeReady = foreign && !detail.isError && home.isSuccess && homeSections.isSuccess && homeStatuses.isSuccess
    && home.data.id === homeId && home.data.workspaceId === workspace.id
    && homeSections.data.every(section => section.projectId === homeId && section.workspaceId === workspace.id)
    && homeStatuses.data.every(status => status.projectId === homeId && status.workspaceId === workspace.id);
  // Revoke before the departing form's passive cleanup can flush a retained draft.
  useLayoutEffect(() => {
    if (foreign && taskId !== null && (!homeReady || home.data?.archivedAt !== null || workspace.role === 'viewer')) props.commands.autosave.authorize(taskId, false);
  }, [foreign, taskId, homeReady, home.data?.archivedAt, workspace.role, props.commands.autosave]);
  const resolvedProps: TaskDrawerProps = {
    ...props,
    placementCommands: props.placementCommands ?? localPlacementCommands,
    ...(homeReady ? {
      project: home.data, sections: homeSections.data, statuses: homeStatuses.data,
      writable: props.writable && home.data.archivedAt === null && workspace.role !== 'viewer' && !home.isFetching && !homeSections.isFetching && !homeStatuses.isFetching,
      viewedProjectName: project.name,
      // These page-owned projections belong to the viewed project. Never retarget their writers.
      dependencyController: undefined, meetingController: undefined, loadedSubtasks: undefined,
      subtaskColumns: undefined, onCreateChild: undefined, initialFields: undefined,
      initialTimeContextFor: undefined, initialTimeWritable: false, initialTimeCurrent: false,
    } : {}),
  };
  const shown =
    taskId !== null && detail.data !== undefined && !detail.isError && (detail.data.projectId === project.id || homeReady)
      ? detail.data
      : null;
  const open = taskId !== null || creating !== null;

  const title =
    taskId !== null ? (shown?.title ?? t('tasks.taskDrawer.task')) : creating?.parent ? t('tasks.taskDrawer.newSubtask') : t('tasks.taskDrawer.newTask');
  const description =
    taskId !== null
      ? t('tasks.taskDrawer.projectValueVisibleToAllWorkspaceMembers', { p0: project.name })
      : t('tasks.taskDrawer.projectValueTheNewTaskWillBeVisible', { p0: project.name });

  if(shown?.meetingId && !foreign && props.meetingController) return <MeetingDrawer initialIntent={props.meetingOpenIntent} commentsController={props.commentsController} dependencyController={props.dependencyController} controller={props.meetingController} actorId={actorId} workspace={workspace} project={project} members={props.members} taskId={shown.id} task={shown} fieldValueMutation={props.fieldValueMutation} fieldValueDrafts={props.fieldValueDrafts} onOpenTask={props.onOpenTask} requestedPeriodId={props.meetingRequestedPeriodId} onAcceptOriginalPeriod={props.onAcceptMeetingPeriod} initialMembershipId={props.meetingMembershipId} initialAttendanceId={props.meetingAttendanceId} initialTab={props.meetingTab} open={open} onClose={onClose} onPrepare={()=>{props.onClose();props.onResumeCreate();}}/>;
  if(shown && shown.meetingId===undefined) return <DialogShell variant="task-drawer" title={t('tasks.taskDrawer.refreshTaskType')} description={t('tasks.taskDrawer.currentServerInformationIsRequiredToEditSafely')} open={open} onOpenChange={next=>{if(!next)onClose();}}><div className="mt-4 space-y-3"><p className="text-sm text-muted">{t('tasks.taskDrawer.theSavedResponseHasNoTaskTypeRefresh')}</p><Button onClick={()=>void detail.refetch()}>{t('tasks.taskDrawer.refreshTaskType')}</Button></div></DialogShell>;
  return (<>
    {!props.placementCommands ? <PlacementCommandFeedback commands={localPlacementCommands} actorId={actorId} workspaceId={workspace.id} /> : null}
    <DialogShell
      variant="task-drawer"
      title={title}
      description={description}
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {taskId !== null ? (
        foreign && !homeReady ? <div className="mt-4 space-y-2" role="status"><p>{t('placements.loadingHome')}</p>{home.isError || homeSections.isError || homeStatuses.isError ? <><p>{t('placements.homeUnavailable')}</p><Button size="sm" onClick={() => { void home.refetch(); void homeSections.refetch(); void homeStatuses.refetch(); }}>{t('placements.reload')}</Button></> : <Skeleton className="h-24" />}</div> : foreign && (detail.data?.meetingId !== null || detail.data?.visibility !== 'workspace') ? <TaskUnavailable /> : <TaskDetail {...resolvedProps} onClose={onClose} taskId={taskId} detail={detail} />
      ) : creating ? (
        <CreateTaskForm {...props} request={creating} />
      ) : null}
    </DialogShell>
  </>);
}

interface OtherTaskCommandNoticeProps {
  onReviewBulk: () => void;
  command: UnresolvedTaskCommand;
  onOpenTask: (taskId: string) => void;
  onResumeCreate: () => void;
}

/** Another task command of this page is unresolved, so this form sends nothing until it is. */
function OtherTaskCommandNotice({ command, onOpenTask, onResumeCreate, onReviewBulk }: OtherTaskCommandNoticeProps) {
  const { t } = useTranslation();
  const { taskId } = command;
  if (command.kind === 'bulk') return <div role="status" className="space-y-2 rounded-lg border border-line p-3 text-sm"><p>{t(command.uncertain ? 'taskTable.bulk.unconfirmed' : 'taskTable.bulk.saving')}</p><Button size="sm" onClick={onReviewBulk}>{t('taskTable.bulk.review')}</Button></div>;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2 text-sm text-amber-900">
      <span className="min-w-0 flex-1">
        {t(taskId === null ? command.uncertain ? 'tasks.taskDrawer.createUnconfirmed' : 'tasks.taskDrawer.createPending' : command.uncertain ? 'tasks.taskDrawer.otherEditUnconfirmed' : 'tasks.taskDrawer.otherEditPending')}</span>
      <Button size="sm" onClick={() => (taskId === null ? onResumeCreate() : onOpenTask(taskId))}>
        {taskId === null ? t('tasks.taskDrawer.openNewTask') : t('tasks.taskDrawer.openThatTask')}
      </Button>
    </div>
  );
}

function TaskUnavailable() {
  const { t } = useTranslation();
  return (
    <StateCard
      className="mt-6"
      headingLevel={3}
      icon={<Lock size={18} aria-hidden="true" />}
      title={t('tasks.taskDrawer.taskUnavailable')}
      description={t('tasks.taskDrawer.thisTaskDoesNotExistOrYouDo')}
    />
  );
}

function TaskDetail(props: TaskDrawerProps & { taskId: string; detail: ReturnType<typeof useTaskQuery> }) {
  const { t } = useTranslation();
  const { taskId, detail, project, workspace } = props;
  if (!isUuid(taskId)) return <TaskUnavailable />;

  if (detail.isPending) {
    return (
      <div role="status" className="mt-6 space-y-3">
        <span className="sr-only">{t('tasks.taskDrawer.loadingTask')}</span>
        <Skeleton className="h-10" />
        <Skeleton className="h-24" />
        <Skeleton className="h-10" />
      </div>
    );
  }

  // A denial hides everything already loaded about the task.
  if (detail.isError && describeError(detail.error, 'task').unavailable) return <TaskUnavailable />;
  if (detail.data === undefined) {
    return (
      <QueryErrorState
        className="mt-6"
        error={detail.error}
        subject="task"
        headingLevel={3}
        retrying={detail.isFetching}
        onRetry={() => void detail.refetch()}
      />
    );
  }
  const task = detail.data;
  if (task.projectId !== project.id || task.workspaceId !== workspace.id) return <TaskUnavailable />;

  return (
    <>
      {props.viewedProjectName ? <p className="mt-3 rounded-lg bg-canvas px-3 py-2 text-xs text-muted">{t('placements.homeContext', { p0: project.name, p1: props.viewedProjectName })} <Link className="underline" to={`/w/${workspace.id}/projects/${project.id}?task=${task.id}`}>{t('placements.openHome')}</Link></p> : null}
      {detail.isError ? (
        <div role="alert" className="mt-4 flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2 text-sm text-amber-900">
          <TriangleAlert size={16} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 flex-1">{t('tasks.taskDrawer.couldNotRefreshThisTaskShowingTheLast')}</span>
          <Button size="sm" onClick={() => void detail.refetch()}>
            {t('tasks.taskDrawer.retry')}</Button>
        </div>
      ) : null}
      {/* Keyed by ID only: a refetch never remounts the inputs. */}
      <TaskEditForm
        key={taskId}
        {...props}
        hierarchyCurrent={!detail.isFetching&&!detail.isError}
        latest={task}
        activity={props.commentsController && task.meetingId === null ? <TaskActivityStream key={taskId} task={task} controller={props.commentsController} writable={props.writable} canRetry={workspace.role !== 'viewer'} timezone={workspace.timezone} onOpenTask={props.onOpenTask} /> : null}
      />
    </>
  );
}

/** Resolve only the explicit immediate parent, then navigate after current authorization. */
interface ParentTaskActionProps {actorId:string;workspaceId:string;projectId:string;sourceId:string|null;parentId:string;onOpenTask:(id:string)=>void;beforeOpen:()=>void;intent:object;back?:boolean;disabled?:boolean}
function ParentTaskAction(props:ParentTaskActionProps) {
  const context=`${props.actorId}:${props.workspaceId}:${props.projectId}:${props.sourceId??''}:${props.parentId}`;
  // A context change owns fresh request flags; old callbacks keep their unmounted instance.
  return <ParentTaskActionForContext key={context} {...props}/>;
}
function ParentTaskActionForContext({actorId,workspaceId,projectId,sourceId,parentId,onOpenTask,beforeOpen,intent,back=false,disabled=false}:ParentTaskActionProps) {
  const {t}=useTranslation();
  const reload=useReloadTask(actorId,workspaceId);
  const [loading,setLoading]=useState(false);
  const [unavailable,setUnavailable]=useState(false);
  const mounted=useRef(true);
  const inFlight=useRef(false);
  const context=`${actorId}:${workspaceId}:${projectId}:${sourceId??''}:${parentId}`;
  const current=useRef(context);current.current=context;
  const currentIntent=useRef(intent);currentIntent.current=intent;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const invalid=!isUuid(parentId)||parentId===sourceId;
  const open=async()=>{
    if(disabled||invalid||inFlight.current)return;
    const expected=current.current;const expectedIntent=currentIntent.current;inFlight.current=true;setLoading(true);setUnavailable(false);
    try {
      const parent=await reload(parentId);
      if(!mounted.current||current.current!==expected||currentIntent.current!==expectedIntent)return;
      if(parent.id!==parentId.toLowerCase()||parent.workspaceId!==workspaceId||parent.projectId!==projectId){setUnavailable(true);return;}
      beforeOpen();onOpenTask(parent.id);
    } catch {if(mounted.current&&current.current===expected)setUnavailable(true);}
    finally {if(mounted.current&&current.current===expected){inFlight.current=false;setLoading(false);}}
  };
  return <div className="flex min-w-0 flex-wrap items-center gap-2">{invalid?<span role="status">{t('hierarchy.parentUnavailable')}</span>:<Button size="sm" variant="ghost" disabled={disabled||loading} onClick={()=>void open()}>{loading?t('hierarchy.openingParent'):back?t('hierarchy.backToParent'):t('hierarchy.openParent')}</Button>}{unavailable?<span role="status" className="text-xs text-muted">{t('hierarchy.parentUnavailable')}</span>:null}</div>;
}

function useLookups(props: TaskDrawerProps, extra: readonly TagDto[]) {
  useTranslation();
  const { statuses, sections, members, tags, commands } = props;
  const tagsById = useMemo(() => mergeTags(tags, commands.createdTags, extra), [tags, commands.createdTags, extra]);
  const memberIds = useMemo(() => new Set(members.map((member) => member.id)), [members]);
  const lookups: TaskLookups = { statuses, sections, members, tags: tagsById };
  return { tagsById, memberIds, lookups };
}

type TaskCommandName = 'update' | 'archive' | 'restore';

/** `activity` comes last in the same scroller, after the task form and the subtasks. */
function TaskEditForm(props: TaskDrawerProps & { latest: TaskDto; hierarchyCurrent:boolean; activity?: ReactNode }) {
  const { t } = useTranslation();
  const {
    actorId,
    workspace,
    latest,
    statuses,
    sections,
    members,
    writable,
    commands,
    fieldValueMutation,
    fieldValueDrafts,
    onOpenTask,
    onResumeCreate,
    onAnnounce,
  } = props;
  const { update, archive, restore, autosave, adoptAutosaveSession } = commands;
  const taskId = latest.id;
  const reloadTask = useReloadTask(actorId, workspace.id);

  // Saved tasks autosave field by field through the page-owned controller, so closing,
  // switching or remounting the pane keeps typed, queued, sending and unknown saves.
  const entry = useSyncExternalStore(autosave.subscribe, () => autosave.get(taskId), () => autosave.get(taskId));
  const pausedBy = useSyncExternalStore(autosave.subscribe, autosave.getPaused, autosave.getPaused);
  const kept = autosaveRetains(entry) ? entry : undefined;
  const retained = kept !== undefined;
  // Show an existing field/full-form handoff exactly while its original command is held.
  const legacy = !retained ? commands.editSessions.current.get(taskId) : undefined;
  useLayoutEffect(() => { if (legacy) adoptAutosaveSession(legacy); }, [adoptAutosaveSession, legacy]);
  // Back/navigation is a fallback; explicit Close and pane-owned navigation flush before leaving.
  useEffect(() => () => autosave.flush(taskId), [autosave, taskId]);
  const [notice, setNotice] = useState<'tasks.taskDrawer.theFormNowShowsTheLatestTaskVersion' | 'tasks.taskDrawer.yourChangesHaveBeenAppliedToTheLatest' | null>(null);
  const [lastCommand, setLastCommand] = useState<TaskCommandName | null>(null);
  const [review, setReview] = useState<TaskDto | null>(null);
  const [reloading, setReloading] = useState<'idle' | 'loading' | 'failed'>('idle');

  // A clean entry stands in only while the cached task has not caught up with its answer.
  const base = kept ? kept.base : legacy?.base ?? (entry && taskWouldRegress(entry.base, latest) ? entry.base : latest);
  const { tagsById, memberIds, lookups } = useLookups(props, base.tags);
  const baseDraft = useMemo(() => draftFromTask(base, memberIds), [base, memberIds]);
  const draft = kept ? kept.draft : legacy?.draft ?? baseDraft;
  const errors: TaskDraftErrors = entry?.errors ?? {};
  const phase = entry?.phase ?? 'idle';
  const unsent = changedKeys(baseDraft, draft).length > 0;

  // The autosave's own unknown update is recovered by its Retry; any other held command locks.
  const ownUpdate = (variables: { input: unknown } | undefined) => variables !== undefined && autosave.owns(variables.input);
  const lockedCommand: TaskCommandName | null =
    update.uncertain?.variables.taskId === taskId && !ownUpdate(update.uncertain.variables)
      ? 'update'
      : archive.uncertain?.variables.taskId === taskId
        ? 'archive'
        : restore.uncertain?.variables.taskId === taskId
          ? 'restore'
          : null;
  const mutations = { update, archive, restore };
  const shownCommand = lockedCommand ?? lastCommand;
  const shownMutation = shownCommand ? mutations[shownCommand] : null;
  // From the commands the hooks hold: a refused call never stands in for the one in flight.
  const pending = [archive, restore].some((mutation) => mutation.pendingCommand?.variables.taskId === taskId)
    || (update.pendingCommand?.variables.taskId === taskId && !ownUpdate(update.pendingCommand.variables));
  const unresolved = unresolvedTaskCommand(commands);
  // A field save of another task in flight only delays this queue; it is not shown as a block.
  const ownPendingElsewhere = unresolved !== null && !unresolved.uncertain && ownUpdate(update.pendingCommand?.variables);
  const blockedByOther = unresolved !== null && unresolved.taskId !== taskId && !ownPendingElsewhere ? unresolved : null;
  const busy = pending || blockedByOther !== null;

  const archived = base.archivedAt !== null;
  const canEdit = writable && !archived;
  const locked = lockedCommand !== null;
  const shownError = shownMutation?.error ?? null;
  const conflict = shownError instanceof ApiError && shownError.kind === 'conflict';
  const newerOnServer = kept !== undefined && kept.sending === null && taskWouldRegress(latest, base) && review === null;

  // The current right to change this task gates every queued send, including after Close.
  useEffect(() => {
    autosave.authorize(taskId, canEdit);
  }, [autosave, taskId, canEdit]);
  useUnsavedChangesWarning(retained || locked);

  // Archive and restore are confirmed by the cache refresh of their own mutation.
  const announceDone = (announcement: TranslationMessage) => () => {
    setReview(null);
    setNotice(null);
    onAnnounce(announcement);
  };
  const archivedDone = announceDone(message('tasks.taskDrawer.taskArchived'));
  const restoredDone = announceDone(message('tasks.taskDrawer.taskRestoredFromArchive'));

  // Typing only stages; a field is sent once it is committed.
  const setDraft = (patch: Partial<TaskDraft>) => {
    autosave.stage(base, patch);
    setNotice(null);
  };
  const commitFields = (keys: readonly TaskDraftKey[]) => {
    if (canEdit) autosave.commit(taskId, keys);
  };

  const retryLocked = () => {
    if (lockedCommand === 'update') update.retryUncertain({ onSuccess: task => {
      if (legacy && commands.editSessions.current.get(taskId) === legacy) commands.confirmSession(legacy, task);
    } });
    else if (lockedCommand === 'archive') archive.retryUncertain({ onSuccess: archivedDone });
    else if (lockedCommand === 'restore') restore.retryUncertain({ onSuccess: restoredDone });
  };

  // Ctrl/Cmd+Enter (or a held lock's Retry) commits every changed field; nothing else submits.
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (event.target !== event.currentTarget) return;
    if (locked) {
      if (!busy) retryLocked();
      return;
    }
    if (canEdit) commitFields(changedKeys(baseDraft, draft));
  };

  const runArchive = () => {
    if (busy || locked || retained) return;
    setLastCommand('archive');
    archive.mutate({ taskId, input: { expectedRevision: base.revision } }, { onSuccess: archivedDone });
  };
  const runRestore = () => {
    if (busy || locked || retained) return;
    setLastCommand('restore');
    restore.mutate({ taskId, input: { expectedRevision: base.revision } }, { onSuccess: restoredDone });
  };

  const loadLatest = async () => {
    if (reloading === 'loading') return;
    setReloading('loading');
    try {
      setReview(await reloadTask(taskId));
      setReloading('idle');
    } catch {
      setReloading('failed');
    }
  };

  // The page's autosave controller already retains this task's input across navigation.
  const retainForNavigation=()=>{ if (canEdit) autosave.flush(taskId); };
  const canCreateChild=writable&&workspace.role!=='viewer'&&props.project.archivedAt===null&&latest.archivedAt===null&&latest.meetingId===null&&props.onCreateChild!==undefined;
  const keptCreate=commands.createSession.current!==null||commands.create.pendingCommand!==null||commands.create.uncertain!==null;
  const unavailableParticipantIds = activeParticipantIds(base).filter((id) => !memberIds.has(id));
  const subtasksShown = props.loadedSubtasks !== undefined && props.loadedSubtasks.parentId === taskId;
  // Add subtask opens the inline row below; the full create form stays its More details.
  const [subtaskAddRequest, setSubtaskAddRequest] = useState(0);

  const formId = useId();
  // Inputs stay editable while a field save is pending; only this task's held archive, restore
  // or foreign update freezes them. Sending still waits for every page guard.
  const fieldsDisabled = !canEdit || locked || pending;
  const sharedEstimate: EstimateMode = { kind: 'shared' };

  const subtaskActions = <div className="space-y-1.5 text-xs text-muted">
    {canCreateChild?keptCreate?<Button size="sm" variant="ghost" onClick={()=>{retainForNavigation();onResumeCreate();}}>{t('hierarchy.resumeDraft')}</Button>:<Button size="sm" variant="ghost" disabled={!props.hierarchyCurrent||unresolved!==null} onClick={()=>{if(!props.hierarchyCurrent||unresolvedTaskCommand(commands)!==null)return;if(subtasksShown){setSubtaskAddRequest(count=>count+1);return;}retainForNavigation();props.onCreateChild?.(latest);}}>{t('hierarchy.addSubtask')}</Button>:null}
        {canCreateChild&&!keptCreate&&unresolved!==null?<p className="text-xs text-muted">{t('hierarchy.resolveSave')}</p>:null}
        {canCreateChild&&!keptCreate&&draft.estimate!==baseDraft.estimate?<p className="text-xs text-muted">{t('hierarchy.savedEstimateHint')}</p>:null}
  </div>;

  // Subtask rows carry their own forms, so they follow this form rather than sit inside it.
  const subtasks = props.loadedSubtasks && subtasksShown ? (
      <div className="min-w-0">
        <DrawerSubtasks parent={latest} scope={props.loadedSubtasks} projectId={props.project.id} statuses={statuses} members={props.members} sections={props.sections} tags={props.tags}
          commands={commands} writable={canCreateChild && props.hierarchyCurrent} draftWritable={canCreateChild}
          extraColumns={props.subtaskColumns} initialFields={props.initialFields}
          initialTimeContext={props.initialTimeContextFor?.(latest, 'detail') ?? null} initialTimeWritable={props.initialTimeWritable} initialTimeCurrent={props.initialTimeCurrent}
          addRequest={subtaskAddRequest}
          headerAction={canCreateChild ? subtaskActions : null}
          onOpen={id => { retainForNavigation(); onOpenTask(id); }}
          onMoreDetails={() => { retainForNavigation(); props.onCreateChild?.(latest); }}
          onAnnounce={onAnnounce}
          onCreated={task => onAnnounce(message('projects.projectPage.taskValueCreated', { p0: task.title }))} />
      </div>
    ) : canCreateChild ? <section className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2"><h3 className="text-sm font-medium text-ink">{t('tasks.subtasks.heading')}</h3>{subtaskActions}</div>
    </section> : null;

  return (<>
    {/* One scroller for the whole task: its form, then subtasks and activity with their own forms.
        The actions stay in the footer below and submit the form by ID. */}
    <div className={`mt-1 ${formBodyClassName}`}>
      <form id={formId} noValidate onSubmit={submit} onKeyDown={event => submitTaskFormShortcut(event, canEdit || (locked && !busy))} className="space-y-4">
        {archived || base.parentTaskId !== null ? <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {archived ? <Badge tone="muted">{t('tasks.taskDrawer.archived')}</Badge> : null}
          {base.parentTaskId !== null ? <Badge tone="muted">{t('tasks.taskDrawer.subtask')}</Badge> : null}
        </div> : null}

        {latest.parentTaskId!==null?<div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {latest.parentTaskId!==null?<ParentTaskAction actorId={actorId} workspaceId={workspace.id} projectId={props.project.id} sourceId={taskId} parentId={latest.parentTaskId} beforeOpen={retainForNavigation} intent={autosave.editIntent(taskId)} onOpenTask={onOpenTask} disabled={!props.hierarchyCurrent}/>:null}
        </div>:null}

        {archived ? (
          <p className="rounded-lg bg-canvas px-3 py-2 text-sm text-ink-soft">
            {t(writable ? 'tasks.taskDrawer.archivedCanRestore' : 'tasks.taskDrawer.archivedReadOnly')}
          </p>
        ) : !writable ? (
          <p className="rounded-lg bg-canvas px-3 py-2 text-sm text-ink-soft">{t('tasks.taskDrawer.thisTaskIsReadOnly')}</p>
        ) : null}

        {blockedByOther ? (
          <OtherTaskCommandNotice command={blockedByOther} onOpenTask={onOpenTask} onResumeCreate={onResumeCreate} onReviewBulk={props.onClose} />
        ) : pausedBy !== null && pausedBy !== taskId ? (
          <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2 text-sm text-amber-900">
            <span className="min-w-0 flex-1">{t('autosave.status.pausedByOther')}</span>
            <Button size="sm" onClick={() => onOpenTask(pausedBy)}>{t('autosave.actions.openThatTask')}</Button>
          </div>
        ) : null}

        {newerOnServer && !locked ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink-soft">
            <span className="min-w-0 flex-1">{t('tasks.taskDrawer.thisTaskChangedAfterYouOpenedTheForm')}</span>
            <Button size="sm" onClick={() => setReview(latest)}>
              {t('tasks.taskDrawer.reviewChanges')}</Button>
          </div>
        ) : null}

        {review ? (
          <ReviewPanel
            base={base}
            baseDraft={baseDraft}
            draft={draft}
            latest={review}
            latestDraft={draftFromTask(review, memberIds)}
            lookups={lookups}
            onTakeLatest={() => {
              autosave.resolveReview(taskId, review, false);
              setReview(null);
              setLastCommand(null);
              setNotice('tasks.taskDrawer.theFormNowShowsTheLatestTaskVersion');
            }}
            onKeepMine={() => {
              // Explicit: the user's fields are queued again against the reviewed version.
              autosave.resolveReview(taskId, review, true);
              setReview(null);
              setLastCommand(null);
              setNotice('tasks.taskDrawer.yourChangesHaveBeenAppliedToTheLatest');
            }}
            onDismiss={() => setReview(null)}
          />
        ) : null}

        <div className="min-w-0" aria-label={t('tasks.taskDrawer.taskFields')} role="group">
          <TaskFields
            draft={draft}
            onChange={setDraft}
            onCommit={commitFields}
            errors={errors}
            statuses={statuses}
            sections={sections}
            members={members}
            tags={tagsById}
            savedTagIds={base.tags.map((tag) => tag.id)}
            unavailableParticipantIds={unavailableParticipantIds}
            estimateMode={sharedEstimate}
            part="saved"
            projectName={props.project.name}
            projectsField={props.placementCommands && latest.meetingId === null ? <TaskProjectsField actorId={actorId} task={latest} homeProject={props.project} writable={canEdit} commands={props.placementCommands} /> : undefined}
            disabled={fieldsDisabled}
            showLegacyEstimate={props.legacyTime === true}
            estimateSupplement={props.legacyTime === true && latest.meetingId === null ? <div className="space-y-1.5 text-xs text-muted">
              {draft.estimate !== baseDraft.estimate ? <section aria-label={t('tasks.estimates.current')} className="space-y-0.5">
                <p><span className="font-medium">{t('tasks.estimates.current')}: </span>{latest.estimateMinutes === null ? t('tasks.estimates.notSet') : formatEstimate(latest.estimateMinutes)}</p>
                <p>{t('tasks.estimates.unsavedHint')}</p>
              </section> : null}
              <OriginalEstimate compact actorId={actorId} workspaceId={workspace.id} packageId={latest.workPackageId} />
            </div> : null}
            tagAction={
              canEdit && !locked ? (
                <CreateTagDialog
                  mutation={commands.createTag}
                  onCreated={(tag) => {
                    commands.addCreatedTag(tag);
                    autosave.choose(base, { tagIds: [...draft.tagIds, tag.id] });
                  }}
                />
              ) : null
            }
            dependenciesField={props.dependencyController ? <DependencyPanel compact actorId={actorId} workspaceId={workspace.id} project={props.project} task={latest} controller={props.dependencyController} writable={canEdit} onOpenTask={onOpenTask} /> : null}
            moreFields={<>
              {/* Values have their own revisions and commands, independent of the task fields. */}
              {fieldValueMutation ? (
                <TaskCustomFields
                  actorId={actorId}
                  workspaceId={workspace.id}
                  task={latest}
                  members={members}
                  writable={canEdit && latest.archivedAt === null}
                  mutation={fieldValueMutation}
                  draftStore={fieldValueDrafts}
                  onOpenTask={onOpenTask}
                />
              ) : null}

            </>}
            secondaryActions={writable && !archived && !locked ? (
              retained ? <p className="text-xs text-muted">{t('autosave.archive.waitForSave')}</p> : (
                <Button size="sm" aria-disabled={busy || undefined} onClick={runArchive}><Archive size={16} aria-hidden="true" />{t('tasks.taskDrawer.archive')}</Button>
              )
            ) : null}
          />
        </div>

        {errors.form ? <p className="text-sm text-red-700">{t(errors.form.key, errors.form.params)}</p> : null}
        <SaveFeedback
          error={phase === 'conflict' || phase === 'rejected' ? (entry?.error instanceof Error ? entry.error : null) : null}
          uncertainError={phase === 'unknown' && entry?.error instanceof Error ? entry.error : null}
          subject="taskSave"
          action={
            phase === 'rejected' || phase === 'conflict' ? (
              <span className="flex flex-wrap gap-2">
                {phase !== 'conflict' ? <Button size="sm" variant="primary" aria-disabled={entry?.sending || !canEdit ? true : undefined} onClick={() => { if (canEdit) autosave.retry(taskId); }}>{t('autosave.actions.retry')}</Button> : null}
                {review === null ? (
                  <Button size="sm" aria-disabled={reloading === 'loading' || undefined} onClick={() => void loadLatest()}>
                    <RefreshCw size={16} aria-hidden="true" className={reloading === 'loading' ? 'motion-safe:animate-spin' : undefined} />
                    {t('autosave.actions.review')}</Button>
                ) : null}
              </span>
            ) : null
          }
        />
        {phase === 'unknown' ? <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" aria-disabled={entry?.sending || !canEdit ? true : undefined} onClick={() => { if (canEdit) autosave.retry(taskId); }}>{t('autosave.actions.retry')}</Button>
        </div> : null}
        <SaveFeedback
          error={shownError}
          uncertainError={lockedCommand ? (mutations[lockedCommand].uncertain?.error ?? null) : null}
          subject="taskSave"
          action={
            conflict && review === null ? (
              <Button size="sm" aria-disabled={reloading === 'loading' || undefined} onClick={() => void loadLatest()}>
                <RefreshCw size={16} aria-hidden="true" className={reloading === 'loading' ? 'motion-safe:animate-spin' : undefined} />
                {t('tasks.taskDrawer.loadLatestVersion')}</Button>
            ) : null
          }
        />
        {reloading === 'failed' ? (
          <p className="text-sm text-red-700">{t('tasks.taskDrawer.couldNotLoadTheLatestTaskTryAgain')}</p>
        ) : null}
        {notice ? (
          <p role="status" className="rounded-lg bg-canvas px-3 py-2.5 text-sm leading-relaxed text-ink-soft">
            {t(notice)}
          </p>
        ) : null}
      </form>
      {subtasks}
      {props.activity}
    </div>

      {/* No Save, Draft or Discard for ordinary edits: only the save state, and a Retry for a held lock. */}
      <div className={formFooterClassName}>
        <AutosaveStatus phase={phase} unsent={unsent} committed={(entry?.committed.length ?? 0) > 0} />
        {canEdit && !locked ? <span className="order-last ml-auto text-xs text-muted">{t('autosave.fields.hint')}</span> : null}
        {locked ? (
          <Button type="submit" form={formId} variant="primary" aria-disabled={busy || undefined}>
            {pending ? t('tasks.taskDrawer.submitting') : t('tasks.taskDrawer.retrySubmission')}
          </Button>
        ) : null}
        {writable && archived && !locked ? (
          <Button aria-disabled={busy || undefined} onClick={runRestore}>
            <ArchiveRestore size={16} aria-hidden="true" />
            {t('tasks.taskDrawer.restore')}</Button>
        ) : null}
      </div>
  </>);
}

/**
 * The saved task's autosave state. "Saved" only for a confirmed answer with nothing typed since;
 * failures are explained, with their recovery, by the feedback inside the form.
 */
function AutosaveStatus({ phase, unsent, committed }: { phase: AutosavePhase; unsent: boolean; committed: boolean }) {
  const { t } = useTranslation();
  const text = phase === 'saving' || (committed && phase === 'idle') ? t('autosave.status.saving')
    : phase === 'invalid' ? t('autosave.status.invalid')
      : phase === 'unknown' ? t('autosave.status.unknown')
        : phase === 'conflict' ? t('autosave.status.conflict')
        : phase === 'rejected' ? t('autosave.status.rejected')
        : unsent ? t('autosave.status.unsent')
          : phase === 'saved' ? t('autosave.status.saved')
            : '';
  return <span role="status" aria-live="polite" className="min-w-0 text-xs text-muted">{text}</span>;
}

interface ReviewPanelProps {
  base: TaskDto;
  baseDraft: TaskDraft;
  draft: TaskDraft;
  latest: TaskDto;
  latestDraft: TaskDraft;
  lookups: TaskLookups;
  onTakeLatest: () => void;
  onKeepMine: () => void;
  onDismiss: () => void;
}

/**
 * The server's current task next to the draft. Nothing is saved from here: the user either
 * takes the current version or keeps their changes on top of it and then saves explicitly.
 */
function ReviewPanel({ base, baseDraft, draft, latest, latestDraft, lookups, onTakeLatest, onKeepMine, onDismiss }: ReviewPanelProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const theirs = new Set(changedKeys(baseDraft, latestDraft));
  const mine = new Set(changedKeys(baseDraft, draft));
  const keys = taskDraftKeys.filter((key) => theirs.has(key) || mine.has(key));
  const revisions = [
    base.revision === latest.revision ? null : t('tasks.taskDrawer.taskValueValue', { p0: base.revision, p1: latest.revision }),
    base.workPackageRevision === latest.workPackageRevision
      ? null
      : t('tasks.taskDrawer.estimateValueValue', { p0: base.workPackageRevision, p1: latest.workPackageRevision }),
    base.participantsRevision === latest.participantsRevision
      ? null
      : t('tasks.taskDrawer.participantsValueValue', { p0: base.participantsRevision, p1: latest.participantsRevision }),
  ].filter((line) => line !== null);

  return (
    <section aria-labelledby={headingId} className="space-y-3 rounded-xl border border-line-strong bg-canvas p-3">
      <h3 id={headingId} className="text-sm font-semibold text-ink">
        {t('tasks.taskDrawer.latestTaskVersion')}</h3>
      <p className="text-xs text-muted">
        {revisions.length > 0 ? t('tasks.taskDrawer.versionsChangedValue', { p0: revisions.join('; ') }) : t('tasks.taskDrawer.versionsAreUnchanged')}
        {latest.archivedAt !== null && base.archivedAt === null ? t('tasks.taskDrawer.theTaskWasArchived') : null}
        {latest.archivedAt === null && base.archivedAt !== null ? t('tasks.taskDrawer.theTaskWasRestoredFromArchive') : null}
      </p>
      {keys.length === 0 ? (
        <p className="text-sm text-ink-soft">{t('tasks.taskDrawer.theTaskFieldsMatchYourDraft')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-left text-sm">
            <caption className="sr-only">{t('tasks.taskDrawer.latestVersionAndDraftDifferences')}</caption>
            <thead className="text-xs text-muted">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('tasks.taskDrawer.field')}</th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('tasks.taskDrawer.onTheServer')}</th>
                <th scope="col" className="py-1 font-medium">
                  {t('tasks.taskDrawer.yourDraft')}</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key} className="border-t border-line align-top">
                  <th scope="row" className="py-1.5 pr-3 font-medium text-ink-soft">
                    {fieldLabels[key]}
                  </th>
                  <td className="py-1.5 pr-3 [overflow-wrap:anywhere] text-ink">{formatDraftValue(key, latestDraft, lookups)}</td>
                  <td className="py-1.5 [overflow-wrap:anywhere] text-ink">
                    {formatDraftValue(key, draft, lookups)}
                    {mine.has(key) ? <span className="text-xs text-muted"> {t('tasks.taskDrawer.changedByYou')}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onTakeLatest}>
          {t('tasks.taskDrawer.useLatestVersion')}</Button>
        {mine.size > 0 ? (
          <Button size="sm" variant="primary" onClick={onKeepMine}>
            {t('tasks.taskDrawer.keepMyChanges')}</Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          {t('tasks.taskDrawer.hide')}</Button>
      </div>
    </section>
  );
}

function freshCreateSession(request: CreateRequest, statusId: string): CreateSession {
  const sectionId = request.parent ? request.parent.sectionId : request.sectionId;
  return { request, draft: emptyDraft(statusId, sectionId), workScope: 'detail' };
}

function CreateTaskForm(props: TaskDrawerProps & { request: CreateRequest }) {
  const { t } = useTranslation();
  const { project, statuses, sections, members, writable, commands, request, onCreated, onOpenTask, onResumeCreate } = props;
  const { create, createSession } = commands;
  const pending = create.pendingCommand !== null;
  const unresolved = unresolvedTaskCommand(commands);
  const blockedByOther = unresolved !== null && unresolved.taskId !== null ? unresolved : null;
  const busy = pending || blockedByOther !== null;
  const statusId = defaultStatusId(statuses);
  const scopeName = useId();

  const [session, setSession] = useState<CreateSession | null>(() =>
    createSession.current ?? (statusId === null ? null : freshCreateSession(request, statusId)),
  );
  const [restored, setRestored] = useState(() => createSession.current !== null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const confirmed = session ? commands.confirmedSessions.current.get(session) : undefined;
  useEffect(() => {
    if (!confirmed || !session || !statusId) return;
    setSession(freshCreateSession(session.request, statusId));
    setRestored(false);
    setErrors({});
  }, [confirmed, session, statusId]);
  const [errors, setErrors] = useState<TaskDraftErrors>({});
  const [initialIssues, setInitialIssues] = useState<readonly InitialTaskCellsIssue[]>([]);
  /** The row this create follows has no confirmed task yet, so its place cannot be sent. */
  const [anchorUnresolved, setAnchorUnresolved] = useState(false);
  const { tagsById } = useLookups(props, []);

  const locked = create.uncertain !== null;
  const pristine = session && statusId !== null ? freshCreateSession(session.request, statusId) : null;
  // Values staged in a quick row count even with an empty title, so opening this form never drops them.
  const staged = session?.initialCells !== undefined && hasInitialTaskCells(session.initialCells);
  const dirty =
    session !== null &&
    pristine !== null &&
    (changedKeys(pristine.draft, session.draft).length > 0 || session.workScope !== pristine.workScope || staged);

  useEffect(() => {
    if (!confirmed) createSession.current = session !== null && (dirty || locked) ? session : null;
  }, [confirmed, createSession, dirty, locked, session]);
  useUnsavedChangesWarning(dirty || locked);

  if (!writable) {
    return <p className="mt-6 text-sm text-muted">{t('tasks.taskDrawer.youCannotCreateTasksInThisProject')}</p>;
  }
  if (session === null || statusId === null) {
    return <p className="mt-6 text-sm text-muted">{t('tasks.taskDrawer.addATaskStatusToThisProjectBefore')}</p>;
  }

  const { draft, workScope } = session;
  const parent = session.request.parent;
  const options = { parentTaskId: parent?.id ?? null, workScope };
  const estimateMode: EstimateMode =
    parent && inheritsEstimate(options)
      ? { kind: 'inherited', text: formatEstimateInput(parent.estimateMinutes), parentTitle: parent.title }
      : { kind: 'own' };

  const done = (task: TaskDto) => {
    const ownsVisibleSession = createSession.current === session;
    if (!commands.confirmSession(session, task)) return;
    if (mounted.current && ownsVisibleSession) onCreated(task);
    else props.onAnnounce(message('tasks.taskDrawer.taskSaved'));
  };
  const setDraft = (patch: Partial<TaskDraft>) =>
    setSession((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current));
  const setScope = (next: TaskWorkScope) => setSession((current) => (current ? { ...current, workScope: next } : current));
  const setInitialCells = (initialCells: InitialTaskCellsDraft) => {
    setSession((current) => (current ? { ...current, initialCells } : current));
    setInitialIssues([]);
  };
  const sharesParentPackage = inheritsEstimate(options);
  const timeContext = capturableTimeContext(props, parent, workScope);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (event.target !== event.currentTarget || confirmed || busy) return;
    if (locked) {
      // The held variables are sent again unchanged, never a remap of the current draft.
      create.retryUncertain({ onSuccess: done });
      return;
    }
    // Every built-in and staged value is checked before anything is sent.
    const result = buildCreateInput(project.id, draft, options);
    const extras = buildInitialTaskPayload(result.ok ? result.input : null, session.initialCells, {
      definitions: props.initialFields,
      currentContext: timeContext,
      sharesParentPackage,
      parentWorkPackageId: sharesParentPackage ? parent?.workPackageId : undefined,
    });
    setErrors(result.ok ? {} : result.errors);
    setInitialIssues(extras.ok ? [] : extras.issues);
    if (!result.ok || !extras.ok) return;
    // A quick row keeps its place: right after its row, or after the earlier create it follows.
    const placed = resolveQuickCreateInput({ session, input: result.input });
    setAnchorUnresolved(placed === null);
    if (placed === null) return;
    const initial = snapshotInitialTaskPayload(extras.initial);
    create.mutate({ input: placed, ...(initial ? { initial } : {}) }, { onSuccess: done });
  };

  return (<>
    {/* Staged values carry their own popover editors, so they sit beside the form rather than inside it. */}
    <StagedInitialCells
      cells={session.initialCells}
      fields={props.initialFields}
      members={members}
      context={timeContext}
      sharesParentPackage={sharesParentPackage}
      issues={initialIssues}
      disabled={locked || busy}
      onChange={setInitialCells}
    />
    <form noValidate onSubmit={submit} onKeyDown={event => submitTaskFormShortcut(event, !busy && !locked)} className="mt-3 flex min-h-0 flex-1 flex-col">
      <div className={formBodyClassName}>
        {parent ? (
          <div className="space-y-1 text-sm text-ink-soft">
            <p>{t('tasks.taskDrawer.subtaskOfTask', { title: parent.title })}</p>
            <ParentTaskAction actorId={props.actorId} workspaceId={props.workspace.id} projectId={project.id} sourceId={null} parentId={parent.id} beforeOpen={()=>{if(dirty||locked||pending)createSession.current=session;}} intent={session} onOpenTask={onOpenTask} back/>
          </div>
        ) : null}
        {blockedByOther ? (
          <OtherTaskCommandNotice command={blockedByOther} onOpenTask={onOpenTask} onResumeCreate={onResumeCreate} onReviewBulk={props.onClose} />
        ) : null}
        {restored && !locked ? (
          <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg bg-canvas px-3 py-2 text-sm text-ink-soft">
            <span className="min-w-0 flex-1">{t('tasks.taskDrawer.yourUnsavedNewTaskDraftHasBeenRestored')}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSession(freshCreateSession(session.request, statusId));
                setRestored(false);
                setErrors({});
              }}
            >
              {t('tasks.taskDrawer.startOver')}</Button>
          </div>
        ) : null}

        <fieldset disabled={locked || busy} className="min-w-0 space-y-4">
          <legend className="sr-only">{t('tasks.taskDrawer.newTaskFields')}</legend>
          {parent ? (
            <fieldset>
              <legend className="text-sm font-medium text-ink">{t('tasks.taskDrawer.subtaskScope')}</legend>
              <div className="mt-1.5 space-y-1.5">
                <label className="flex items-start gap-2 text-sm text-ink-soft">
                  <input
                    type="radio"
                    name={scopeName}
                    className="mt-0.5 size-4 accent-accent"
                    checked={workScope === 'detail'}
                    onChange={() => setScope('detail')}
                  />
                  <span>{t('tasks.taskDrawer.detailIncludedInTheParentEstimate')}</span>
                </label>
                <label className="flex items-start gap-2 text-sm text-ink-soft">
                  <input
                    type="radio"
                    name={scopeName}
                    className="mt-0.5 size-4 accent-accent"
                    checked={workScope === 'added_scope'}
                    onChange={() => setScope('added_scope')}
                  />
                  <span>{t('tasks.taskDrawer.additionalWorkSeparateEstimate')}</span>
                </label>
              </div>
            </fieldset>
          ) : null}
          <TaskFields
            draft={draft}
            onChange={setDraft}
            errors={errors}
            statuses={statuses}
            sections={sections}
            members={members}
            tags={tagsById}
            savedTagIds={[]}
            unavailableParticipantIds={[]}
            estimateMode={estimateMode}
            showLegacyEstimate={props.legacyTime === true}
            autoFocusTitle
            tagAction={
              locked ? null : (
                <CreateTagDialog
                  mutation={commands.createTag}
                  onCreated={(tag) => {
                    commands.addCreatedTag(tag);
                    setDraft({ tagIds: [...draft.tagIds, tag.id] });
                  }}
                />
              )
            }
          />
        </fieldset>

        {errors.form ? <p className="text-sm text-red-700">{t(errors.form.key, errors.form.params)}</p> : null}
        {anchorUnresolved && !pending && !locked ? <p role="status" className="text-sm text-amber-900">{t('tasks.taskDrawer.createPending')}</p> : null}
        <SaveFeedback error={create.error} uncertainError={create.uncertain?.error ?? null} subject="taskSave" />
      </div>

      <div className={formFooterClassName}>
        {!locked ? <span className="order-last ml-auto text-xs text-muted">{t('tasks.taskDrawer.keyboardCreate')}</span> : null}
        <Button type="submit" variant="primary" aria-disabled={busy || undefined}>
          {pending ? t('tasks.taskDrawer.creating') : locked ? t('tasks.taskDrawer.retrySubmission') : t('tasks.taskDrawer.createTask')}
        </Button>
      </div>
    </form>
  </>);
}

interface StagedInitialCellsProps {
  cells: InitialTaskCellsDraft | undefined;
  fields: readonly TaskFieldDefinitionDto[] | undefined;
  members: readonly MembershipDto[];
  /** What new hours may capture now; captured hours keep their own context. */
  context: InitialTimeContext | null;
  sharesParentPackage: boolean;
  issues: readonly InitialTaskCellsIssue[];
  disabled: boolean;
  onChange: (cells: InitialTaskCellsDraft) => void;
}

/**
 * Custom values and weekly hours of the new task, staged locally and created with it atomically.
 * Values staged in a quick row are shown here for review and stay editable; nothing is saved
 * before the task is created.
 */
function StagedInitialCells({ cells, fields, members, context, sharesParentPackage, issues, disabled, onChange }: StagedInitialCellsProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const draft = cells ?? emptyInitialTaskCellsDraft();
  const captured = draft.time.context;
  const target = captured ?? context;
  // Staged entries keep their snapshot even after the column changed or left, so they can be reviewed.
  const shown = new Map<string, TaskFieldDefinitionDto>();
  for (const entry of Object.values(draft.fields)) shown.set(entry.field.id, entry.field);
  for (const field of fields ?? []) if (field.archivedAt === null && !shown.has(field.id)) shown.set(field.id, field);
  if (shown.size === 0 && target === null) return null;
  const hours = (kind: 'planned' | 'fact') =>
    target === null
      ? ''
      : t(kind === 'fact' ? 'taskRows.time.factLabel' : sharesParentPackage ? 'taskRows.time.parentPlannedLabel' : 'taskRows.time.plannedLabel', {
          period: target.periodName,
          member: target.memberName,
        });

  return (
    <section aria-labelledby={headingId} className="mt-3 max-h-[35%] min-h-0 shrink-0 space-y-2 overflow-y-auto rounded-lg border border-line px-3 py-2">
      <h3 id={headingId} className="text-xs font-medium text-muted">{t('taskRows.field.staged')}</h3>
      <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-sm">
        {[...shown.values()].map((field) => (
          <div key={field.id} className="contents">
            <dt className="truncate text-ink-soft" title={field.name}>{field.name}</dt>
            <dd className="h-9 min-w-0"><InitialCustomFieldCell field={field} draft={draft} onChange={onChange} members={members} disabled={disabled} /></dd>
          </div>
        ))}
        {target !== null ? (['planned', 'fact'] as const).map((kind) => (
          <div key={kind} className="contents">
            <dt className="truncate text-ink-soft" title={hours(kind)}>{hours(kind)}</dt>
            <dd className="h-9 min-w-0">
              <InitialTaskTimeCell kind={kind} draft={draft} onChange={onChange} context={context} sharesParentPackage={sharesParentPackage} disabled={disabled} />
            </dd>
          </div>
        )) : null}
      </dl>
      {captured !== null && context !== null && !sameTimeContext(captured, context) ? (
        <p role="status" className="text-xs text-muted">{t('taskRows.time.contextChanged', { period: captured.periodName, member: captured.memberName })}</p>
      ) : null}
      {issues.length > 0 ? (
        <ul role="alert" className="space-y-0.5 text-sm text-red-700">
          {issues.map((issue, index) => (
            <li key={index}>
              {issue.kind === 'field' ? `${shown.get(issue.fieldId)?.name ?? ''}: ` : ''}
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
