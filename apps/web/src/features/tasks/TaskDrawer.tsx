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
  TaskStatusDto,
  TaskWorkScope,
  WorkspaceDto,
} from '@workloom/contracts';
import { Badge, Button, Skeleton, StateCard } from '@workloom/ui';
import { Archive, ArchiveRestore, Lock, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { isUuid } from '../../lib/format';
import { useUnsavedChangesWarning } from '../../lib/useUnsavedChangesWarning';
import { DialogShell } from '../../shared/DialogShell';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { TaskCustomFields, type FieldValueDraftStore, type useSetTaskFieldValueMutation } from '../fields';
import { formatEstimateInput } from '../task-table';
import { taskWouldRegress, useReloadTask, useTaskQuery } from './queries';
import { CreateTagDialog } from './TagDialogs';
import { TaskFields, fieldLabels, formatDraftValue, type EstimateMode, type TaskLookups } from './TaskFields';
import {
  activeParticipantIds,
  buildCreateInput,
  buildUpdateInput,
  changedKeys,
  draftFromTask,
  emptyDraft,
  inheritsEstimate,
  rebaseDraft,
  taskDraftKeys,
  type TaskDraft,
  type TaskDraftErrors,
} from './taskDraft';
import {
  unresolvedTaskCommand,
  type CreateRequest,
  type CreateSession,
  type EditSession,
  type TaskCommands,
  type UnresolvedTaskCommand,
} from './useTaskCommands';

export interface TaskDrawerProps {
  dependencyController?: DependencyWorkspace;
  meetingController?: MeetingWorkspace;
  meetingTab?: MeetingTab;
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
  /** Reopens the kept new-task form, e.g. to resolve its unconfirmed create. */
  onResumeCreate: () => void;
  onCreated: (task: TaskDto) => void;
  onAnnounce: (message: string) => void;
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

function defaultStatusId(statuses: readonly TaskStatusDto[]): string | null {
  const ordered = [...statuses].sort((a, b) => a.position - b.position);
  return (ordered.find((status) => status.group === 'todo') ?? ordered[0])?.id ?? null;
}

/**
 * Task detail and creation in a right-hand drawer (full width on small screens). Details are
 * fetched by ID and shown only when the task belongs to this project.
 */
export function TaskDrawer(props: TaskDrawerProps) {
  const { actorId, workspace, project, taskId, creating, onClose } = props;
  const detail = useTaskQuery(actorId, workspace.id, taskId ?? '');
  const shown =
    taskId !== null && detail.data !== undefined && !detail.isError && detail.data.projectId === project.id
      ? detail.data
      : null;
  const open = taskId !== null || creating !== null;

  const title =
    taskId !== null ? (shown?.title ?? 'Задача') : creating?.parent ? 'Новая подзадача' : 'Новая задача';
  const description =
    taskId !== null
      ? `Проект «${project.name}». Задачу видят все участники пространства.`
      : `Проект «${project.name}». Новую задачу увидят все участники пространства.`;

  if(shown?.meetingId && props.meetingController) return <MeetingDrawer dependencyController={props.dependencyController} controller={props.meetingController} actorId={actorId} workspace={workspace} project={project} members={props.members} taskId={shown.id} task={shown} fieldValueMutation={props.fieldValueMutation} fieldValueDrafts={props.fieldValueDrafts} onOpenTask={props.onOpenTask} requestedPeriodId={props.meetingRequestedPeriodId} onAcceptOriginalPeriod={props.onAcceptMeetingPeriod} initialMembershipId={props.meetingMembershipId} initialAttendanceId={props.meetingAttendanceId} initialTab={props.meetingTab??'meeting'} open={open} onClose={onClose} onPrepare={()=>{props.onClose();props.onResumeCreate();}}/>;
  if(shown && shown.meetingId===undefined) return <DialogShell variant="drawer" title="Тип задачи уточняется" description="Для безопасного редактирования нужна актуальная информация сервера." open={open} onOpenChange={next=>{if(!next)onClose();}}><div className="mt-4 space-y-3"><p className="text-sm text-muted">Сохранённый ответ не содержит тип задачи. Обновите её перед изменением.</p><Button onClick={()=>void detail.refetch()}>Обновить тип задачи</Button></div></DialogShell>;
  return (
    <DialogShell
      variant="drawer"
      title={title}
      description={description}
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {taskId !== null ? (
        <TaskDetail {...props} taskId={taskId} detail={detail} />
      ) : creating ? (
        <CreateTaskForm {...props} request={creating} />
      ) : null}
    </DialogShell>
  );
}

interface OtherTaskCommandNoticeProps {
  command: UnresolvedTaskCommand;
  onOpenTask: (taskId: string) => void;
  onResumeCreate: () => void;
}

/** Another task command of this page is unresolved, so this form sends nothing until it is. */
function OtherTaskCommandNotice({ command, onOpenTask, onResumeCreate }: OtherTaskCommandNoticeProps) {
  const { taskId } = command;
  const subject = taskId === null ? 'Создание новой задачи' : 'Изменение другой задачи';
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2 text-sm text-amber-900">
      <span className="min-w-0 flex-1">
        {subject} {command.uncertain ? 'ещё не подтверждено' : 'ещё отправляется'}. Пока его результат неизвестен, новые
        изменения задач не отправляются.
      </span>
      <Button size="sm" onClick={() => (taskId === null ? onResumeCreate() : onOpenTask(taskId))}>
        {taskId === null ? 'Открыть новую задачу' : 'Открыть ту задачу'}
      </Button>
    </div>
  );
}

function TaskUnavailable() {
  return (
    <StateCard
      className="mt-6"
      headingLevel={3}
      icon={<Lock size={18} aria-hidden="true" />}
      title="Задача недоступна"
      description="Такой задачи нет или у текущего пользователя нет к ней доступа."
    />
  );
}

function TaskDetail(props: TaskDrawerProps & { taskId: string; detail: ReturnType<typeof useTaskQuery> }) {
  const { taskId, detail, project, workspace } = props;
  if (!isUuid(taskId)) return <TaskUnavailable />;

  if (detail.isPending) {
    return (
      <div role="status" className="mt-6 space-y-3">
        <span className="sr-only">Загрузка задачи</span>
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
      {detail.isError ? (
        <div role="alert" className="mt-4 flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2 text-sm text-amber-900">
          <TriangleAlert size={16} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 flex-1">Не удалось обновить задачу. Показана последняя загруженная версия.</span>
          <Button size="sm" onClick={() => void detail.refetch()}>
            Повторить
          </Button>
        </div>
      ) : null}
      {/* Keyed by ID only: a refetch never remounts the inputs. */}
      <TaskEditForm key={taskId} {...props} latest={task} />
    </>
  );
}

function useLookups(props: TaskDrawerProps, extra: readonly TagDto[]) {
  const { statuses, sections, members, tags, commands } = props;
  const tagsById = useMemo(() => mergeTags(tags, commands.createdTags, extra), [tags, commands.createdTags, extra]);
  const memberIds = useMemo(() => new Set(members.map((member) => member.id)), [members]);
  const lookups: TaskLookups = { statuses, sections, members, tags: tagsById };
  return { tagsById, memberIds, lookups };
}

type TaskCommandName = 'update' | 'archive' | 'restore';

function TaskEditForm(props: TaskDrawerProps & { latest: TaskDto }) {
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
  const { update, archive, restore, editSessions } = commands;
  const taskId = latest.id;
  const reloadTask = useReloadTask(actorId, workspace.id);

  const [session, setSession] = useState<EditSession>(
    () => editSessions.current.get(taskId) ?? { base: latest, draft: draftFromTask(latest, new Set(members.map((m) => m.id))) },
  );
  const [restored, setRestored] = useState(() => editSessions.current.has(taskId));
  const [errors, setErrors] = useState<TaskDraftErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [lastCommand, setLastCommand] = useState<TaskCommandName | null>(null);
  const [review, setReview] = useState<TaskDto | null>(null);
  const [reloading, setReloading] = useState<'idle' | 'loading' | 'failed'>('idle');

  const { base, draft } = session;
  const { tagsById, memberIds, lookups } = useLookups(props, base.tags);
  const baseDraft = useMemo(() => draftFromTask(base, memberIds), [base, memberIds]);
  const dirty = changedKeys(baseDraft, draft).length > 0;

  const lockedCommand: TaskCommandName | null =
    update.uncertain?.variables.taskId === taskId
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
  const pending = [update, archive, restore].some((mutation) => mutation.pendingCommand?.variables.taskId === taskId);
  const unresolved = unresolvedTaskCommand(commands);
  const blockedByOther = unresolved !== null && unresolved.taskId !== taskId ? unresolved : null;
  const busy = pending || blockedByOther !== null;

  const archived = base.archivedAt !== null;
  const canEdit = writable && !archived;
  const locked = lockedCommand !== null;
  const shownError = shownMutation?.error ?? null;
  const conflict = shownError instanceof ApiError && shownError.kind === 'conflict';
  const newerOnServer = taskWouldRegress(latest, base) && review === null;

  // Keep the draft in memory while it is unsaved or unconfirmed, so closing the drawer loses nothing.
  useEffect(() => {
    if (dirty || locked) editSessions.current.set(taskId, session);
    else editSessions.current.delete(taskId);
  }, [dirty, locked, session, taskId, editSessions]);
  useUnsavedChangesWarning(dirty || locked);

  const adopt = (task: TaskDto, message: string) => {
    // Runs even if the drawer closed meanwhile: the confirmed task replaces the kept draft.
    editSessions.current.delete(task.id);
    setSession({ base: task, draft: draftFromTask(task, memberIds) });
    setRestored(false);
    setReview(null);
    setErrors({});
    setNotice(null);
    onAnnounce(message);
  };
  const saved = (task: TaskDto) => adopt(task, 'Задача сохранена.');
  const archivedDone = (task: TaskDto) => adopt(task, 'Задача перенесена в архив.');
  const restoredDone = (task: TaskDto) => adopt(task, 'Задача восстановлена из архива.');

  const setDraft = (patch: Partial<TaskDraft>) => {
    setSession((current) => ({ ...current, draft: { ...current.draft, ...patch } }));
    setNotice(null);
  };

  const retryLocked = () => {
    if (lockedCommand === 'update') update.retryUncertain({ onSuccess: saved });
    else if (lockedCommand === 'archive') archive.retryUncertain({ onSuccess: archivedDone });
    else if (lockedCommand === 'restore') restore.retryUncertain({ onSuccess: restoredDone });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (event.target !== event.currentTarget || busy) return;
    if (locked) {
      retryLocked();
      return;
    }
    if (!canEdit) return;
    const result = buildUpdateInput(base, baseDraft, draft);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    if (result.input === null) {
      setNotice('Изменений нет — сохранять нечего.');
      return;
    }
    setNotice(null);
    setLastCommand('update');
    update.mutate({ taskId, input: result.input }, { onSuccess: saved });
  };

  const runArchive = () => {
    if (busy || locked) return;
    setLastCommand('archive');
    archive.mutate({ taskId, input: { expectedRevision: base.revision } }, { onSuccess: archivedDone });
  };
  const runRestore = () => {
    if (busy || locked) return;
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

  const discardRestored = () => {
    setSession({ base: latest, draft: draftFromTask(latest, memberIds) });
    setRestored(false);
    setErrors({});
  };

  const unavailableParticipantIds = activeParticipantIds(base).filter((id) => !memberIds.has(id));

  return (
    <form noValidate onSubmit={submit} className="mt-5 flex min-h-0 flex-1 flex-col">
      <div className={formBodyClassName}>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {archived ? <Badge tone="muted">В архиве</Badge> : null}
          {base.parentTaskId !== null ? <Badge tone="muted">Подзадача</Badge> : null}
          <span>Видна всем участникам пространства.</span>
          {dirty && !locked ? <span className="font-medium text-ink-soft">Есть несохранённые изменения.</span> : null}
        </div>

        {archived ? (
          <p className="rounded-lg bg-canvas px-3 py-2 text-sm text-ink-soft">
            Задача в архиве: её можно просмотреть{writable ? ' или восстановить' : ''}, но не изменить.
          </p>
        ) : !writable ? (
          <p className="rounded-lg bg-canvas px-3 py-2 text-sm text-ink-soft">Задача доступна только для просмотра.</p>
        ) : null}

        {restored && !locked ? (
          <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg bg-canvas px-3 py-2 text-sm text-ink-soft">
            <span className="min-w-0 flex-1">Восстановлен несохранённый черновик этой задачи.</span>
            <Button size="sm" variant="ghost" onClick={discardRestored}>
              Сбросить черновик
            </Button>
          </div>
        ) : null}

        {blockedByOther ? (
          <OtherTaskCommandNotice command={blockedByOther} onOpenTask={onOpenTask} onResumeCreate={onResumeCreate} />
        ) : null}

        {newerOnServer && !locked ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink-soft">
            <span className="min-w-0 flex-1">Задача изменилась после того, как вы открыли форму.</span>
            <Button size="sm" onClick={() => setReview(latest)}>
              Посмотреть изменения
            </Button>
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
              setSession({ base: review, draft: draftFromTask(review, memberIds) });
              setReview(null);
              setLastCommand(null);
              setRestored(false);
              setNotice('Форма показывает актуальную версию задачи.');
            }}
            onKeepMine={() => {
              setSession({ base: review, draft: rebaseDraft(baseDraft, draft, draftFromTask(review, memberIds)) });
              setReview(null);
              setLastCommand(null);
              setNotice('Ваши изменения перенесены на актуальную версию. Проверьте поля и сохраните.');
            }}
            onDismiss={() => setReview(null)}
          />
        ) : null}

        <fieldset disabled={!canEdit || locked || busy} className="min-w-0">
          <legend className="sr-only">Поля задачи</legend>
          <TaskFields
            draft={draft}
            onChange={setDraft}
            errors={errors}
            statuses={statuses}
            sections={sections}
            members={members}
            tags={tagsById}
            savedTagIds={base.tags.map((tag) => tag.id)}
            unavailableParticipantIds={unavailableParticipantIds}
            estimateMode={{ kind: 'shared' }}
            tagAction={
              canEdit && !locked ? (
                <CreateTagDialog
                  mutation={commands.createTag}
                  onCreated={(tag) => {
                    commands.addCreatedTag(tag);
                    setDraft({ tagIds: [...draft.tagIds, tag.id] });
                  }}
                />
              ) : null
            }
          />
        </fieldset>

        {props.dependencyController ? <DependencyPanel actorId={actorId} workspaceId={workspace.id} project={props.project} task={latest} controller={props.dependencyController} writable={canEdit} onOpenTask={onOpenTask} /> : null}

        {/* Values have their own revisions and commands, independent of the task form above. */}
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

        {errors.form ? <p className="text-sm text-red-700">{errors.form}</p> : null}
        <SaveFeedback
          error={shownError}
          uncertainError={lockedCommand ? (mutations[lockedCommand].uncertain?.error ?? null) : null}
          subject="taskSave"
          action={
            conflict && review === null ? (
              <Button size="sm" aria-disabled={reloading === 'loading' || undefined} onClick={() => void loadLatest()}>
                <RefreshCw size={16} aria-hidden="true" className={reloading === 'loading' ? 'motion-safe:animate-spin' : undefined} />
                Загрузить актуальную версию
              </Button>
            ) : null
          }
        />
        {reloading === 'failed' ? (
          <p className="text-sm text-red-700">Не удалось загрузить актуальную версию задачи. Повторите попытку.</p>
        ) : null}
        {notice ? (
          <p role="status" className="rounded-lg bg-canvas px-3 py-2.5 text-sm leading-relaxed text-ink-soft">
            {notice}
          </p>
        ) : null}
      </div>

      <div className={formFooterClassName}>
        {locked ? (
          <Button type="submit" variant="primary" aria-disabled={busy || undefined}>
            {pending ? 'Отправляем…' : 'Повторить отправку'}
          </Button>
        ) : canEdit ? (
          <Button type="submit" variant="primary" aria-disabled={busy || undefined}>
            {update.pendingCommand?.variables.taskId === taskId ? 'Сохраняем…' : 'Сохранить'}
          </Button>
        ) : null}
        {writable && !archived && !locked ? (
          dirty ? (
            <span className="text-xs text-muted">Чтобы отправить задачу в архив, сначала сохраните или сбросьте изменения.</span>
          ) : (
            <Button aria-disabled={busy || undefined} onClick={runArchive}>
              <Archive size={16} aria-hidden="true" />
              В архив
            </Button>
          )
        ) : null}
        {writable && archived && !locked ? (
          <Button aria-disabled={busy || undefined} onClick={runRestore}>
            <ArchiveRestore size={16} aria-hidden="true" />
            Восстановить
          </Button>
        ) : null}
      </div>
    </form>
  );
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
  const headingId = useId();
  const theirs = new Set(changedKeys(baseDraft, latestDraft));
  const mine = new Set(changedKeys(baseDraft, draft));
  const keys = taskDraftKeys.filter((key) => theirs.has(key) || mine.has(key));
  const revisions = [
    base.revision === latest.revision ? null : `задача: ${base.revision} → ${latest.revision}`,
    base.workPackageRevision === latest.workPackageRevision
      ? null
      : `оценка: ${base.workPackageRevision} → ${latest.workPackageRevision}`,
    base.participantsRevision === latest.participantsRevision
      ? null
      : `участники: ${base.participantsRevision} → ${latest.participantsRevision}`,
  ].filter((line) => line !== null);

  return (
    <section aria-labelledby={headingId} className="space-y-3 rounded-xl border border-line-strong bg-canvas p-3">
      <h3 id={headingId} className="text-sm font-semibold text-ink">
        Актуальная версия задачи
      </h3>
      <p className="text-xs text-muted">
        {revisions.length > 0 ? `Версии изменились — ${revisions.join('; ')}.` : 'Версии не изменились.'}
        {latest.archivedAt !== null && base.archivedAt === null ? ' Задача перенесена в архив.' : null}
        {latest.archivedAt === null && base.archivedAt !== null ? ' Задача восстановлена из архива.' : null}
      </p>
      {keys.length === 0 ? (
        <p className="text-sm text-ink-soft">Поля задачи совпадают с вашим черновиком.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-left text-sm">
            <caption className="sr-only">Различия актуальной версии и черновика</caption>
            <thead className="text-xs text-muted">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Поле
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Сейчас на сервере
                </th>
                <th scope="col" className="py-1 font-medium">
                  Ваш черновик
                </th>
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
                    {mine.has(key) ? <span className="text-xs text-muted"> (изменено вами)</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onTakeLatest}>
          Взять актуальную версию
        </Button>
        {mine.size > 0 ? (
          <Button size="sm" variant="primary" onClick={onKeepMine}>
            Оставить мои изменения
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Скрыть
        </Button>
      </div>
    </section>
  );
}

function freshCreateSession(request: CreateRequest, statusId: string): CreateSession {
  const sectionId = request.parent ? request.parent.sectionId : request.sectionId;
  return { request, draft: emptyDraft(statusId, sectionId), workScope: 'detail' };
}

function CreateTaskForm(props: TaskDrawerProps & { request: CreateRequest }) {
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
  const [errors, setErrors] = useState<TaskDraftErrors>({});
  const { tagsById } = useLookups(props, []);

  const locked = create.uncertain !== null;
  const pristine = session && statusId !== null ? freshCreateSession(session.request, statusId) : null;
  const dirty =
    session !== null &&
    pristine !== null &&
    (changedKeys(pristine.draft, session.draft).length > 0 || session.workScope !== pristine.workScope);

  useEffect(() => {
    createSession.current = session !== null && (dirty || locked) ? session : null;
  }, [createSession, dirty, locked, session]);
  useUnsavedChangesWarning(dirty || locked);

  if (!writable) {
    return <p className="mt-6 text-sm text-muted">Создавать задачи в этом проекте нельзя.</p>;
  }
  if (session === null || statusId === null) {
    return <p className="mt-6 text-sm text-muted">В проекте нет статусов задач, поэтому создать задачу нельзя.</p>;
  }

  const { draft, workScope } = session;
  const parent = session.request.parent;
  const options = { parentTaskId: parent?.id ?? null, workScope };
  const estimateMode: EstimateMode =
    parent && inheritsEstimate(options)
      ? { kind: 'inherited', text: formatEstimateInput(parent.estimateMinutes), parentTitle: parent.title }
      : { kind: 'own' };

  const done = (task: TaskDto) => {
    createSession.current = null;
    onCreated(task);
  };
  const setDraft = (patch: Partial<TaskDraft>) =>
    setSession((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current));
  const setScope = (next: TaskWorkScope) => setSession((current) => (current ? { ...current, workScope: next } : current));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (event.target !== event.currentTarget || busy) return;
    if (locked) {
      create.retryUncertain({ onSuccess: done });
      return;
    }
    const result = buildCreateInput(project.id, draft, options);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    create.mutate({ input: result.input }, { onSuccess: done });
  };

  return (
    <form noValidate onSubmit={submit} className="mt-5 flex min-h-0 flex-1 flex-col">
      <div className={formBodyClassName}>
        {parent ? (
          <p className="text-sm text-ink-soft">
            Подзадача к «<span className="[overflow-wrap:anywhere]">{parent.title}</span>».
          </p>
        ) : null}
        {blockedByOther ? (
          <OtherTaskCommandNotice command={blockedByOther} onOpenTask={onOpenTask} onResumeCreate={onResumeCreate} />
        ) : null}
        {restored && !locked ? (
          <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg bg-canvas px-3 py-2 text-sm text-ink-soft">
            <span className="min-w-0 flex-1">Восстановлен несохранённый черновик новой задачи.</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSession(freshCreateSession(session.request, statusId));
                setRestored(false);
                setErrors({});
              }}
            >
              Начать заново
            </Button>
          </div>
        ) : null}

        <fieldset disabled={locked || busy} className="min-w-0 space-y-4">
          <legend className="sr-only">Поля новой задачи</legend>
          {parent ? (
            <fieldset>
              <legend className="text-sm font-medium text-ink">Объём подзадачи</legend>
              <div className="mt-1.5 space-y-1.5">
                <label className="flex items-start gap-2 text-sm text-ink-soft">
                  <input
                    type="radio"
                    name={scopeName}
                    className="mt-0.5 size-4 accent-accent"
                    checked={workScope === 'detail'}
                    onChange={() => setScope('detail')}
                  />
                  <span>Детализация — входит в оценку родительской задачи</span>
                </label>
                <label className="flex items-start gap-2 text-sm text-ink-soft">
                  <input
                    type="radio"
                    name={scopeName}
                    className="mt-0.5 size-4 accent-accent"
                    checked={workScope === 'added_scope'}
                    onChange={() => setScope('added_scope')}
                  />
                  <span>Дополнительный объём — своя оценка</span>
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

        {errors.form ? <p className="text-sm text-red-700">{errors.form}</p> : null}
        <SaveFeedback error={create.error} uncertainError={create.uncertain?.error ?? null} subject="taskSave" />
      </div>

      <div className={formFooterClassName}>
        <Button type="submit" variant="primary" aria-disabled={busy || undefined}>
          {pending ? 'Создаём…' : locked ? 'Повторить отправку' : 'Создать задачу'}
        </Button>
      </div>
    </form>
  );
}
