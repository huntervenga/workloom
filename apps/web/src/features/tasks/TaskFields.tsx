import { t, useTranslation } from '../../i18n';
import type { MembershipDto, SectionDto, TagDto, TaskPriority, TaskStatusDto, TaskStatusGroup } from '@workloom/contracts';
import { TextInput, cn, inputClassName } from '@workloom/ui';
import { X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { ChoicePicker, type ChoiceOption } from '../../shared/ChoicePicker';
import { formatEstimate, parseEstimateInput } from '../task-table';
import { TagBadge } from './TagBadge';
import { tagColor } from './tagColors';
import { TaskDateInput } from './TaskDateInput';
import { TaskCompactDateField } from './TaskCompactDateField';
import { TaskParticipantPicker } from './TaskParticipantPicker';
import { TASK_DESCRIPTION_MAX, TASK_TITLE_MAX, type TaskDraft, type TaskDraftErrors, type TaskDraftIssue, type TaskDraftKey } from './taskDraft';

export const priorityLabels: Record<TaskPriority, string> = {
  get none() { return t('tasks.taskFields.noPriority'); },
  get low() { return t('tasks.taskFields.low'); },
  get medium() { return t('tasks.taskFields.medium'); },
  get high() { return t('tasks.taskFields.high'); },
  get urgent() { return t('tasks.taskFields.urgent'); },
};

const priorities: TaskPriority[] = ['none', 'low', 'medium', 'high', 'urgent'];

// Picker dots match the task table: slate/accent/emerald status dots, amber/rose priorities.
const statusColors: Record<TaskStatusGroup, string> = { todo: '#94a3b8', in_progress: '#6366f1', done: '#10b981', cancelled: '#cbd5e1' };
const priorityColors: Record<TaskPriority, string | undefined> = { none: undefined, low: '#94a3b8', medium: '#64748b', high: '#d97706', urgent: '#e11d48' };

export const fieldLabels: Record<TaskDraftKey, string> = {
  get title() { return t('tasks.taskFields.taskName'); },
  get description() { return t('tasks.taskFields.description'); },
  get statusId() { return t('tasks.taskFields.status'); },
  get sectionId() { return t('tasks.taskFields.section'); },
  get responsibleMembershipId() { return t('tasks.taskFields.assignee'); },
  get participantMembershipIds() { return t('tasks.taskFields.participants'); },
  get startDate() { return t('tasks.taskFields.startDate'); },
  get dueDate() { return t('tasks.taskFields.dueDate'); },
  get priority() { return t('tasks.taskFields.priority'); },
  get tagIds() { return t('tasks.taskFields.tags'); },
  get estimate() { return t('tasks.taskFields.teamEstimate'); },
};

export const UNAVAILABLE_MEMBER = () => t('tasks.taskFields.memberUnavailable');

/** Lookups for showing IDs by name; unknown IDs get neutral copy, never invented names. */
export interface TaskLookups {
  statuses: readonly TaskStatusDto[];
  sections: readonly SectionDto[];
  members: readonly MembershipDto[];
  tags: ReadonlyMap<string, TagDto>;
}

export function formatDraftValue(key: TaskDraftKey, draft: TaskDraft, lookups: TaskLookups): string {
  const memberName = (id: string) => lookups.members.find((member) => member.id === id)?.displayName ?? UNAVAILABLE_MEMBER();
  switch (key) {
    case 'title':
      return draft.title.trim();
    case 'description':
      return draft.description === '' ? t('tasks.taskFields.noDescription') : draft.description.length > 160 ? `${draft.description.slice(0, 160)}…` : draft.description;
    case 'statusId':
      return lookups.statuses.find((status) => status.id === draft.statusId)?.name ?? t('tasks.taskFields.statusUnavailable');
    case 'sectionId':
      return draft.sectionId === null
        ? t('tasks.taskFields.noSection')
        : (lookups.sections.find((section) => section.id === draft.sectionId)?.name ?? t('tasks.taskFields.sectionUnavailable'));
    case 'responsibleMembershipId':
      return draft.responsibleMembershipId === null ? t('tasks.taskFields.unassigned') : memberName(draft.responsibleMembershipId);
    case 'participantMembershipIds':
      return draft.participantMembershipIds.length === 0 ? t('tasks.taskFields.noParticipants') : draft.participantMembershipIds.map(memberName).join(', ');
    case 'startDate':
      return draft.startDate || t('tasks.taskFields.noStartDate');
    case 'dueDate':
      return draft.dueDate === '' ? t('tasks.taskFields.noDueDate') : draft.dueDate;
    case 'priority':
      return priorityLabels[draft.priority];
    case 'tagIds':
      return draft.tagIds.length === 0
        ? t('tasks.taskFields.noTags')
        : draft.tagIds.map((id) => lookups.tags.get(id)?.name ?? t('tasks.taskFields.tagUnavailable')).join(', ');
    case 'estimate': {
      const parsed = parseEstimateInput(draft.estimate);
      if (!parsed.valid) return draft.estimate;
      return parsed.minutes === null ? t('tasks.taskFields.notEstimated') : formatEstimate(parsed.minutes);
    }
  }
}

export type EstimateMode =
  /** The task's own package estimate (a root task or new added scope). */
  | { kind: 'own' }
  /** An existing task's package, possibly shared with linked tasks. */
  | { kind: 'shared' }
  /** A new detail subtask: shows the parent's estimate and sends none. */
  | { kind: 'inherited'; text: string; parentTitle: string };

export interface TaskFieldsProps {
  draft: TaskDraft;
  onChange: (patch: Partial<TaskDraft>) => void;
  errors: TaskDraftErrors;
  statuses: readonly TaskStatusDto[];
  sections: readonly SectionDto[];
  members: readonly MembershipDto[];
  /** Every tag that may be shown: workspace tags plus any already on the task. */
  tags: ReadonlyMap<string, TagDto>;
  /** Tags on the saved task; archived ones among them may stay but not be newly assigned. */
  savedTagIds: readonly string[];
  /**
   * Saved active participants whose membership is no longer in the workspace. The task retains
   * them: they stay in the draft and in any replacement set until the user unchecks them, and
   * an unchecked one may be checked again (it restores the saved reference, not a new one).
   */
  unavailableParticipantIds: readonly string[];
  estimateMode: EstimateMode;
  /** Slot for creating a tag without leaving the form. */
  tagAction?: ReactNode;
  autoFocusTitle?: boolean | undefined;
  /**
   * `all` keeps the rest behind More details. The other parts show every field of their group
   * openly, for a form that places them apart: `primary` (name, project, section, status,
   * assignee, dates), `details` (priority, estimate, participants, tags) and `description`.
   */
  part?: 'all' | 'primary' | 'details' | 'description' | 'saved' | undefined;
  /** Shown read only in the `primary` and `saved` parts; a task cannot move to another project. */
  projectName?: string | undefined;
  /** Independently saved project placements of an existing canonical task. */
  projectsField?: ReactNode;
  /** Read-only history beneath the estimate, outside the disabled editable controls. */
  estimateSupplement?: ReactNode;
  disabled?: boolean | undefined;
  /**
   * Saved tasks only: a field's value is final (text blur or Enter, description Ctrl+Enter, any
   * choice). Typing alone only calls `onChange`. Absent, nothing commits and forms behave as before.
   */
  onCommit?: ((keys: readonly TaskDraftKey[]) => void) | undefined;
  /** Saved task custom values, visible beside the built-in properties. */
  moreFields?: ReactNode;
  dependenciesField?: ReactNode;
  /** Only explicit legacy views expose the old package estimate; lineage/drafts stay intact. */
  showLegacyEstimate?: boolean;
  secondaryActions?: ReactNode;
}

const labelClassName = 'text-sm font-medium text-ink';
const errorClassName = 'mt-1.5 text-sm text-red-700';

function FieldError({ id, message }: { id: string; message: TaskDraftIssue | undefined }) {
  const { t } = useTranslation();
  return message ? (
    <p id={id} className={errorClassName}>
      {t(message.key, message.params)}
    </p>
  ) : null;
}

/**
 * The task fields. Wrap them in a `<fieldset disabled>` to make the form read-only or to lock
 * a sent command; values stay visible either way.
 */
export function TaskFields({
  draft,
  onChange,
  errors,
  statuses,
  sections,
  members,
  tags,
  savedTagIds,
  unavailableParticipantIds,
  estimateMode,
  tagAction,
  autoFocusTitle = false,
  part = 'all',
  projectName,
  projectsField,
  estimateSupplement,
  disabled = false,
  onCommit,
  moreFields,
  dependenciesField,
  showLegacyEstimate = false,
  secondaryActions,
}: TaskFieldsProps) {
  const { t, locale } = useTranslation();
  const id = useId();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  // Each explicit validation attempt gets a new error object, so the same error reopens
  // details after the user closes it. Native toggling remains fully under user control.
  useLayoutEffect(() => {
    if (errors.estimate && detailsRef.current) detailsRef.current.open = true;
  }, [errors]);
  const ids = {
    title: `${id}-title`,
    titleError: `${id}-title-error`,
    description: `${id}-description`,
    descriptionError: `${id}-description-error`,
    status: `${id}-status`,
    section: `${id}-section`,
    responsible: `${id}-responsible`,
    due: `${id}-due`,
    start: `${id}-start`,
    startError: `${id}-start-error`,
    dueError: `${id}-due-error`,
    priority: `${id}-priority`,
    estimate: `${id}-estimate`,
    estimateHint: `${id}-estimate-hint`,
    estimateError: `${id}-estimate-error`,
  };

  const orderedStatuses = [...statuses].sort((a, b) => a.position - b.position);
  const statusKnown = statuses.some((status) => status.id === draft.statusId);
  const sectionOptions = [...sections]
    .filter((section) => section.archivedAt === null || section.id === draft.sectionId)
    .sort((a, b) => a.position - b.position);
  const sectionKnown = draft.sectionId === null || sections.some((section) => section.id === draft.sectionId);
  const responsibleKnown =
    draft.responsibleMembershipId === null || members.some((member) => member.id === draft.responsibleMembershipId);

  // A current reference without a known record stays as its own neutral choice, never renamed.
  const statusChoices: ChoiceOption[] = [
    ...(statusKnown ? [] : [{ value: draft.statusId, label: t('tasks.taskFields.statusUnavailable') }]),
    ...orderedStatuses.map((status) => ({ value: status.id, label: status.name, color: statusColors[status.group] })),
  ];
  // '' is the picker value for null: Unassigned and No section are ordinary choices.
  const responsibleChoices: ChoiceOption[] = [
    { value: '', label: t('tasks.taskFields.unassigned') },
    ...(responsibleKnown ? [] : [{ value: draft.responsibleMembershipId ?? '', label: UNAVAILABLE_MEMBER() }]),
    ...members.map((member) => ({ value: member.id, label: member.displayName, avatarName: member.displayName, avatarUrl: member.avatarUrl })),
  ];
  const sectionChoices: ChoiceOption[] = [
    { value: '', label: t('tasks.taskFields.noSection') },
    ...(sectionKnown ? [] : [{ value: draft.sectionId ?? '', label: t('tasks.taskFields.sectionUnavailable') }]),
    ...sectionOptions.map((section) => ({
      value: section.id,
      label: section.archivedAt === null ? section.name : t('tasks.taskFields.valueArchived', { p0: section.name }),
    })),
  ];
  const priorityChoices: ChoiceOption[] = priorities.map((priority) => ({
    value: priority,
    label: priorityLabels[priority],
    color: priorityColors[priority],
  }));

  // Retained references to memberships outside the workspace: shown without names, removable.
  const memberIds = new Set(members.map((member) => member.id));
  const retainedParticipantIds = [
    ...new Set([
      ...unavailableParticipantIds,
      ...draft.participantMembershipIds.filter((membershipId) => !memberIds.has(membershipId)),
    ]),
  ];

  const selectedTags = new Set(draft.tagIds);
  const savedTags = new Set(savedTagIds);
  const tagOptions = [...tags.values()]
    .filter((tag) => tag.archivedAt === null || selectedTags.has(tag.id) || savedTags.has(tag.id))
    .sort((a, b) => a.name.localeCompare(b.name, locale));
  const missingTagIds = draft.tagIds.filter((tagId) => !tags.has(tagId));

  const toggle = (list: readonly string[], value: string, on: boolean) =>
    on ? [...list.filter((item) => item !== value), value] : list.filter((item) => item !== value);
  const saved = part === 'saved';
  const commit = (...keys: TaskDraftKey[]) => onCommit?.(keys);
  /** A choice is final at once; without `onCommit` this is the plain change. */
  const choose = (patch: Partial<TaskDraft>) => {
    onChange(patch);
    commit(...(Object.keys(patch) as TaskDraftKey[]));
  };
  /** Enter ends a single-line text field of a saved task; other forms keep implicit submission. */
  const commitOnEnter = (key: TaskDraftKey) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (!onCommit || event.key !== 'Enter' || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    commit(key);
  };

  const titleField = (
<div>
        <label htmlFor={ids.title} className={part === 'primary' || saved ? 'sr-only' : labelClassName}>
          {t('tasks.taskFields.taskName')}</label>
        <TextInput
          id={ids.title}
          className={part === 'primary' || saved ? 'task-title-input' : 'mt-1.5'}
          value={draft.title}
          maxLength={TASK_TITLE_MAX}
          autoComplete="off"
          autoFocus={autoFocusTitle}
          aria-invalid={errors.title ? true : undefined}
          aria-describedby={errors.title ? ids.titleError : undefined}
          onChange={(event) => onChange({ title: event.target.value })}
          onBlur={() => commit('title')}
          onKeyDown={commitOnEnter('title')}
        />
        <FieldError id={ids.titleError} message={errors.title} />
      </div>
  );
  const statusField = (<div>
          <label htmlFor={ids.status} className={labelClassName}>
            {t('tasks.taskFields.status')}</label>
          <ChoicePicker
            id={ids.status}
            className="mt-1.5"
            label={t('tasks.taskFields.status')}
            value={draft.statusId}
            options={statusChoices}
            onValueChange={(statusId) => choose({ statusId })}
          />
        </div>);
  const assigneeField = (<div>
          <label htmlFor={ids.responsible} className={labelClassName}>
            {t('tasks.taskFields.assignee')}</label>
          <ChoicePicker
            id={ids.responsible}
            className="mt-1.5"
            label={t('tasks.taskFields.assignee')}
            searchable
            value={draft.responsibleMembershipId ?? ''}
            options={responsibleChoices}
            onValueChange={(value) => choose({ responsibleMembershipId: value === '' ? null : value })}
          />
        </div>);
  const datesField = (<div onBlur={(event) => {
            if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) commit('startDate', 'dueDate');
          }}>
          <TaskDateInput startDate={draft.startDate ?? ''} dueDate={draft.dueDate} onChange={onChange} onCommit={onCommit ? patch => commit(...Object.keys(patch) as TaskDraftKey[]) : undefined} calendarPopover
            errors={{ startDate: errors.startDate ? t(errors.startDate.key, errors.startDate.params) : undefined, dueDate: errors.dueDate ? t(errors.dueDate.key, errors.dueDate.params) : undefined }} />
        </div>);
  const descriptionField = (
<div>
        <label htmlFor={ids.description} className={labelClassName}>
          {t('tasks.taskFields.description')}</label>
        <textarea
          id={ids.description}
          className={inputClassName('mt-1.5 h-auto min-h-20 py-2 leading-relaxed')}
          rows={3}
          value={draft.description}
          maxLength={TASK_DESCRIPTION_MAX}
          aria-invalid={errors.description ? true : undefined}
          aria-describedby={errors.description ? ids.descriptionError : undefined}
          onChange={(event) => onChange({ description: event.target.value })}
          onBlur={() => commit('description')}
          onKeyDown={(event) => {
            // Enter stays a newline; Ctrl/Cmd+Enter makes the description final.
            if (!onCommit || event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.nativeEvent.isComposing) return;
            event.preventDefault();
            commit('description');
          }}
        />
        <FieldError id={ids.descriptionError} message={errors.description} />
      </div>
  );
  const sectionField = (<div>
          <label htmlFor={ids.section} className={labelClassName}>
            {t('tasks.taskFields.section')}</label>
          <ChoicePicker
            id={ids.section}
            className="mt-1.5"
            label={t('tasks.taskFields.section')}
            value={draft.sectionId ?? ''}
            options={sectionChoices}
            onValueChange={(value) => choose({ sectionId: value === '' ? null : value })}
          />
        </div>);
  const priorityField = (<div>
          <label htmlFor={ids.priority} className={labelClassName}>
            {t('tasks.taskFields.priority')}</label>
          <ChoicePicker
            id={ids.priority}
            className="mt-1.5"
            label={t('tasks.taskFields.priority')}
            value={draft.priority}
            options={priorityChoices}
            onValueChange={(value) => {
              const next = priorities.find((priority) => priority === value);
              if (next) choose({ priority: next });
            }}
          />
        </div>);
  const estimateField = (<div>
          <label htmlFor={ids.estimate} className={labelClassName}>
            {t('tasks.taskFields.teamEstimateHours')}</label>
          <TextInput
            id={ids.estimate}
            className="mt-1.5"
            inputMode="decimal"
            autoComplete="off"
            placeholder={t('tasks.taskFields.notEstimated')}
            value={estimateMode.kind === 'inherited' ? estimateMode.text : draft.estimate}
            readOnly={estimateMode.kind === 'inherited'}
            aria-invalid={errors.estimate ? true : undefined}
            aria-describedby={errors.estimate ? `${ids.estimateError} ${ids.estimateHint}` : ids.estimateHint}
            onChange={(event) => {
              if (estimateMode.kind !== 'inherited') onChange({ estimate: event.target.value });
            }}
            onBlur={() => { if (estimateMode.kind !== 'inherited') commit('estimate'); }}
            onKeyDown={commitOnEnter('estimate')}
          />
          <FieldError id={ids.estimateError} message={errors.estimate} />
        </div>);
  const estimateHint = (<p id={ids.estimateHint} className="rounded-lg bg-canvas px-3 py-2 text-xs leading-relaxed text-muted">
        {estimateMode.kind === 'inherited'
          ? t('tasks.taskFields.includedInValueThisSubtaskSharesItsParent', { p0: estimateMode.parentTitle })
          : estimateMode.kind === 'shared'
            ? t('tasks.taskFields.sharedBudgetForTheWholeTeamAndLinked')
            : t('tasks.taskFields.sharedBudgetForTheWholeTeamEnter1')}
      </p>);
  const participantsField = (<div className="min-w-0 space-y-1.5">
        <p className={labelClassName}>{t('tasks.taskFields.participants')}</p>
        <TaskParticipantPicker members={members} value={draft.participantMembershipIds} retainedIds={unavailableParticipantIds} disabled={disabled}
          onChange={participantMembershipIds => choose({ participantMembershipIds })} />
        {members.length === 0 && retainedParticipantIds.length === 0 ? <p className="text-xs text-muted">{t('tasks.taskFields.noWorkspaceMembers')}</p> : null}
        {retainedParticipantIds.length > 0 ? <p className="text-xs text-muted">{t('tasks.taskFields.thisMemberHasLeftTheWorkspaceButRemains')}</p> : null}
      </div>);
  const tagsField = (<fieldset>
        <legend className={labelClassName}>{t('tasks.taskFields.tags')}</legend>
        {tagAction ? <div className="mt-1">{tagAction}</div> : null}
        {tagOptions.length === 0 && missingTagIds.length === 0 ? (
          <p className="mt-1.5 text-sm text-muted">{t('tasks.taskFields.noTagsYet')}</p>
        ) : (
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {tagOptions.map((tag) => {
              const archived = tag.archivedAt !== null;
              // Archived tags can stay on the task but cannot be newly assigned.
              const assignable = !archived || savedTags.has(tag.id);
              return (
                <li key={tag.id}>
                  <label
                    className={cn(
                      'inline-flex max-w-full items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs',
                      archived ? 'text-muted' : 'text-ink-soft',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="size-3.5 shrink-0 accent-accent"
                      checked={selectedTags.has(tag.id)}
                      aria-label={archived ? t('tasks.taskFields.valueArchived', { p0: tag.name }) : tag.name}
                      disabled={!assignable}
                      onChange={(event) => choose({ tagIds: toggle(draft.tagIds, tag.id, event.target.checked) })}
                    />
                    <TagBadge tag={tag} />
                  </label>
                </li>
              );
            })}
            {missingTagIds.map((tagId) => (
              <li key={tagId} className="inline-flex items-center rounded-full border border-line px-2.5 py-1 text-xs text-muted">
                {t('tasks.taskFields.tagUnavailable')}</li>
            ))}
          </ul>
        )}
      </fieldset>);

  if (saved) {
    const rowLabel = 'flex min-h-8 items-center py-1 text-sm text-ink-soft';
    const compactPicker = 'border-transparent! bg-transparent! px-1.5 shadow-none! hover:bg-canvas!';
    const addableTags = tagOptions.filter((tag) => !selectedTags.has(tag.id) && (tag.archivedAt === null || savedTags.has(tag.id)));
    return (
      <div className="space-y-3">
        <fieldset disabled={disabled} className="min-w-0 space-y-3">
          <legend className="sr-only">{t('autosave.fields.label')}</legend>
          <div className="flex min-w-0 items-start gap-2">
            <div className="min-w-0 flex-1">{titleField}</div>
            <div className="max-w-[11rem] shrink-0 pt-1">
              <ChoicePicker id={ids.status} compact className={compactPicker} label={t('tasks.taskFields.status')} value={draft.statusId} options={statusChoices} onValueChange={(statusId) => choose({ statusId })} />
            </div>
          </div>
          <dl className="grid grid-cols-[minmax(6rem,8rem)_minmax(0,1fr)] items-start gap-x-3 gap-y-0.5">
            <dt className={rowLabel}><label htmlFor={ids.responsible}>{t('tasks.taskFields.assignee')}</label></dt>
            <dd className="min-w-0">
              <ChoicePicker id={ids.responsible} compact className={compactPicker} label={t('tasks.taskFields.assignee')} searchable value={draft.responsibleMembershipId ?? ''} options={responsibleChoices}
                onValueChange={(value) => choose({ responsibleMembershipId: value === '' ? null : value })} />
            </dd>
            <dt className={rowLabel}>{t('autosave.fields.dates')}</dt>
            <dd className="min-w-0"><TaskCompactDateField startDate={draft.startDate ?? ''} dueDate={draft.dueDate} disabled={disabled}
              errors={{ startDate: errors.startDate ? t(errors.startDate.key, errors.startDate.params) : undefined, dueDate: errors.dueDate ? t(errors.dueDate.key, errors.dueDate.params) : undefined }}
              onDraftChange={onChange} onCommit={dates => choose(dates)} /></dd>
            <dt className={rowLabel}>{t(projectsField ? 'placements.projects' : 'tasks.taskFields.project')}</dt>
            <dd className="flex min-h-8 min-w-0 items-center text-sm [overflow-wrap:anywhere] text-ink-soft">{projectsField ?? projectName}</dd>
            <dt className={rowLabel}><label htmlFor={ids.section}>{t('tasks.taskFields.section')}</label></dt>
            <dd className="min-w-0">
              <ChoicePicker id={ids.section} compact className={compactPicker} label={t('tasks.taskFields.section')} value={draft.sectionId ?? ''} options={sectionChoices}
                onValueChange={(value) => choose({ sectionId: value === '' ? null : value })} />
            </dd>
            {showLegacyEstimate ? <>
              <dt className={rowLabel}><label htmlFor={ids.estimate}>{t('tasks.taskFields.teamEstimateHours')}</label></dt>
              <dd className="min-w-0">
                <TextInput id={ids.estimate} className="h-8" inputMode="decimal" autoComplete="off" placeholder={t('tasks.taskFields.notEstimated')} value={draft.estimate}
                  aria-invalid={errors.estimate ? true : undefined} aria-describedby={errors.estimate ? `${ids.estimateError} ${ids.estimateHint}` : ids.estimateHint}
                  onChange={(event) => onChange({ estimate: event.target.value })} onBlur={() => commit('estimate')} onKeyDown={commitOnEnter('estimate')} />
                <FieldError id={ids.estimateError} message={errors.estimate} />
              </dd>
            </> : null}
            <dt className={rowLabel}><label htmlFor={ids.priority}>{t('tasks.taskFields.priority')}</label></dt>
            <dd className="min-w-0">
              <ChoicePicker id={ids.priority} compact className={compactPicker} label={t('tasks.taskFields.priority')} value={draft.priority} options={priorityChoices}
                onValueChange={(value) => { const next = priorities.find((priority) => priority === value); if (next) choose({ priority: next }); }} />
            </dd>
            <dt className={rowLabel}>{t('tasks.taskFields.tags')}</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-1.5 py-1">
              {draft.tagIds.map((tagId) => {
                const tag = tags.get(tagId);
                const name = tag ? (tag.archivedAt === null ? tag.name : t('tasks.taskFields.valueArchived', { p0: tag.name })) : t('tasks.taskFields.tagUnavailable');
                const remove = <button type="button" aria-label={t('autosave.fields.removeTag', { name })} className="inline-flex size-5 items-center justify-center rounded-full text-muted hover:bg-slate-100 hover:text-ink"
                  onClick={() => choose({ tagIds: draft.tagIds.filter((id) => id !== tagId) })}>
                  <X size={12} aria-hidden="true" />
                </button>;
                return tag ? <TagBadge key={tagId} tag={tag}>{remove}</TagBadge>
                  : <span key={tagId} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line py-0.5 pr-1 pl-2.5 text-xs text-ink-soft"><span className="truncate">{name}</span>{remove}</span>;
              })}
              {addableTags.length > 0 ? (
                <ChoicePicker label={t('autosave.fields.addTag')} value="" compact searchable className={compactPicker}
                  options={[{ value: '', label: t('autosave.fields.addTag') }, ...addableTags.map((tag) => ({ value: tag.id, label: tag.archivedAt === null ? tag.name : t('tasks.taskFields.valueArchived', { p0: tag.name }), color: tagColor(tag) }))]}
                  onValueChange={(value) => { if (value !== '' && !selectedTags.has(value)) choose({ tagIds: [...draft.tagIds, value] }); }} />
              ) : draft.tagIds.length === 0 ? <span className="text-sm text-muted">{t('tasks.taskFields.noTagsYet')}</span> : null}
              {tagAction}
            </dd>
            <dt className={rowLabel}>{t('tasks.taskFields.participants')}</dt>
            <dd className="min-w-0"><TaskParticipantPicker members={members} value={draft.participantMembershipIds} retainedIds={unavailableParticipantIds} disabled={disabled}
              onChange={participantMembershipIds => choose({ participantMembershipIds })} /></dd>
          </dl>
        </fieldset>
        {dependenciesField}
        {moreFields}
        {showLegacyEstimate ? <div className="space-y-1.5">{estimateHint}{estimateSupplement}</div> : null}
        <fieldset disabled={disabled} className="min-w-0">{descriptionField}</fieldset>
        {secondaryActions}
      </div>
    );
  }
  if (part === 'primary') {
    return (
      <div className="space-y-4">
        {titleField}
        <div className="grid gap-3 sm:grid-cols-2">
          <dl>
            <dt className={labelClassName}>{t('tasks.taskFields.project')}</dt>
            <dd className="mt-1.5 flex min-h-9 items-center text-sm [overflow-wrap:anywhere] text-ink-soft">{projectsField ?? projectName}</dd>
          </dl>
          {sectionField}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">{statusField}{assigneeField}{datesField}</div>
      </div>
    );
  }
  if (part === 'details') {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {showLegacyEstimate ? <div className="min-w-0 space-y-2"><fieldset disabled={disabled}>{estimateField}</fieldset>{estimateSupplement}</div> : null}
          <fieldset disabled={disabled}>{priorityField}</fieldset>
        </div>
        {showLegacyEstimate ? estimateHint : null}
        <fieldset disabled={disabled} className="min-w-0 space-y-4">{participantsField}{tagsField}</fieldset>
      </div>
    );
  }
  if (part === 'description') return descriptionField;

  return (
    <div className="space-y-4">
      {titleField}
      <div className="grid gap-3 sm:grid-cols-2">{statusField}{assigneeField}{datesField}</div>
      {descriptionField}
<details ref={detailsRef} className="rounded-lg border border-line p-3">
<summary className="cursor-pointer text-sm font-medium text-ink">{t('tasks.taskFields.moreDetails')}<span className="ml-2 text-xs font-normal text-muted">{t(showLegacyEstimate ? 'tasks.taskFields.moreDetailsHint' : 'tasks.taskFields.moreDetailsOrdinaryHint')}</span></summary>
<div className="mt-4 space-y-4"><div className="grid gap-4 sm:grid-cols-2">{sectionField}{priorityField}{showLegacyEstimate ? estimateField : null}</div>{showLegacyEstimate ? estimateHint : null}{participantsField}{tagsField}</div>
</details>
    </div>
  );
}
