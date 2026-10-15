import type { MembershipDto, SectionDto, TagDto, TaskPriority, TaskStatusDto } from '@workloom/contracts';
import { TextInput, cn, inputClassName } from '@workloom/ui';
import { UserRound } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { formatEstimate, parseEstimateInput } from '../task-table';
import { TagSwatch } from './TagDialogs';
import { TASK_DESCRIPTION_MAX, TASK_TITLE_MAX, type TaskDraft, type TaskDraftErrors, type TaskDraftKey } from './taskDraft';

export const priorityLabels: Record<TaskPriority, string> = {
  none: 'Без приоритета',
  low: 'Низкий',
  medium: 'Средний',
  high: 'Высокий',
  urgent: 'Срочный',
};

const priorities: TaskPriority[] = ['none', 'low', 'medium', 'high', 'urgent'];

export const fieldLabels: Record<TaskDraftKey, string> = {
  title: 'Название',
  description: 'Описание',
  statusId: 'Статус',
  sectionId: 'Раздел',
  responsibleMembershipId: 'Ответственный',
  participantMembershipIds: 'Участники',
  dueDate: 'Срок',
  priority: 'Приоритет',
  tagIds: 'Теги',
  estimate: 'Оценка задачи',
};

export const UNAVAILABLE_MEMBER = 'Участник недоступен';

/** Lookups for showing IDs by name; unknown IDs get neutral copy, never invented names. */
export interface TaskLookups {
  statuses: readonly TaskStatusDto[];
  sections: readonly SectionDto[];
  members: readonly MembershipDto[];
  tags: ReadonlyMap<string, TagDto>;
}

export function formatDraftValue(key: TaskDraftKey, draft: TaskDraft, lookups: TaskLookups): string {
  const memberName = (id: string) => lookups.members.find((member) => member.id === id)?.displayName ?? UNAVAILABLE_MEMBER;
  switch (key) {
    case 'title':
      return draft.title.trim();
    case 'description':
      return draft.description === '' ? 'Без описания' : draft.description.length > 160 ? `${draft.description.slice(0, 160)}…` : draft.description;
    case 'statusId':
      return lookups.statuses.find((status) => status.id === draft.statusId)?.name ?? 'Статус недоступен';
    case 'sectionId':
      return draft.sectionId === null
        ? 'Без раздела'
        : (lookups.sections.find((section) => section.id === draft.sectionId)?.name ?? 'Раздел недоступен');
    case 'responsibleMembershipId':
      return draft.responsibleMembershipId === null ? 'Не назначен' : memberName(draft.responsibleMembershipId);
    case 'participantMembershipIds':
      return draft.participantMembershipIds.length === 0 ? 'Нет участников' : draft.participantMembershipIds.map(memberName).join(', ');
    case 'dueDate':
      return draft.dueDate === '' ? 'Без срока' : draft.dueDate;
    case 'priority':
      return priorityLabels[draft.priority];
    case 'tagIds':
      return draft.tagIds.length === 0
        ? 'Без тегов'
        : draft.tagIds.map((id) => lookups.tags.get(id)?.name ?? 'Тег недоступен').join(', ');
    case 'estimate': {
      const parsed = parseEstimateInput(draft.estimate);
      if (!parsed.valid) return draft.estimate;
      return parsed.minutes === null ? 'Не оценено' : formatEstimate(parsed.minutes);
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
}

const selectClassName = inputClassName('mt-1.5 pr-8');
const labelClassName = 'text-sm font-medium text-ink';
const errorClassName = 'mt-1.5 text-sm text-red-700';

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  return message ? (
    <p id={id} className={errorClassName}>
      {message}
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
}: TaskFieldsProps) {
  const id = useId();
  const ids = {
    title: `${id}-title`,
    titleError: `${id}-title-error`,
    description: `${id}-description`,
    descriptionError: `${id}-description-error`,
    status: `${id}-status`,
    section: `${id}-section`,
    responsible: `${id}-responsible`,
    due: `${id}-due`,
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

  // Retained references to memberships outside the workspace: shown without names, removable.
  const memberIds = new Set(members.map((member) => member.id));
  const savedRetained = new Set(unavailableParticipantIds);
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
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const missingTagIds = draft.tagIds.filter((tagId) => !tags.has(tagId));

  const toggle = (list: readonly string[], value: string, on: boolean) =>
    on ? [...list.filter((item) => item !== value), value] : list.filter((item) => item !== value);

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor={ids.title} className={labelClassName}>
          Название
        </label>
        <TextInput
          id={ids.title}
          className="mt-1.5"
          value={draft.title}
          maxLength={TASK_TITLE_MAX}
          autoComplete="off"
          autoFocus={autoFocusTitle}
          aria-invalid={errors.title ? true : undefined}
          aria-describedby={errors.title ? ids.titleError : undefined}
          onChange={(event) => onChange({ title: event.target.value })}
        />
        <FieldError id={ids.titleError} message={errors.title} />
      </div>

      <div>
        <label htmlFor={ids.description} className={labelClassName}>
          Описание
        </label>
        <textarea
          id={ids.description}
          className={inputClassName('mt-1.5 h-auto min-h-24 py-2 leading-relaxed')}
          rows={4}
          value={draft.description}
          maxLength={TASK_DESCRIPTION_MAX}
          aria-invalid={errors.description ? true : undefined}
          aria-describedby={errors.description ? ids.descriptionError : undefined}
          onChange={(event) => onChange({ description: event.target.value })}
        />
        <FieldError id={ids.descriptionError} message={errors.description} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={ids.status} className={labelClassName}>
            Статус
          </label>
          <select
            id={ids.status}
            className={selectClassName}
            value={draft.statusId}
            onChange={(event) => onChange({ statusId: event.target.value })}
          >
            {statusKnown ? null : <option value={draft.statusId}>Статус недоступен</option>}
            {orderedStatuses.map((status) => (
              <option key={status.id} value={status.id}>
                {status.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor={ids.section} className={labelClassName}>
            Раздел
          </label>
          <select
            id={ids.section}
            className={selectClassName}
            value={draft.sectionId ?? ''}
            onChange={(event) => onChange({ sectionId: event.target.value === '' ? null : event.target.value })}
          >
            <option value="">Без раздела</option>
            {sectionKnown ? null : <option value={draft.sectionId ?? ''}>Раздел недоступен</option>}
            {sectionOptions.map((section) => (
              <option key={section.id} value={section.id}>
                {section.archivedAt === null ? section.name : `${section.name} (в архиве)`}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor={ids.responsible} className={labelClassName}>
            Ответственный
          </label>
          <select
            id={ids.responsible}
            className={selectClassName}
            value={draft.responsibleMembershipId ?? ''}
            onChange={(event) =>
              onChange({ responsibleMembershipId: event.target.value === '' ? null : event.target.value })
            }
          >
            <option value="">Не назначен</option>
            {responsibleKnown ? null : <option value={draft.responsibleMembershipId ?? ''}>{UNAVAILABLE_MEMBER}</option>}
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.displayName}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor={ids.priority} className={labelClassName}>
            Приоритет
          </label>
          <select
            id={ids.priority}
            className={selectClassName}
            value={draft.priority}
            onChange={(event) => {
              const next = priorities.find((priority) => priority === event.target.value);
              if (next) onChange({ priority: next });
            }}
          >
            {priorities.map((priority) => (
              <option key={priority} value={priority}>
                {priorityLabels[priority]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor={ids.due} className={labelClassName}>
            Срок
          </label>
          <TextInput
            id={ids.due}
            type="date"
            className="mt-1.5"
            value={draft.dueDate}
            aria-invalid={errors.dueDate ? true : undefined}
            aria-describedby={errors.dueDate ? ids.dueError : undefined}
            onChange={(event) => onChange({ dueDate: event.target.value })}
          />
          <FieldError id={ids.dueError} message={errors.dueDate} />
        </div>

        <div>
          <label htmlFor={ids.estimate} className={labelClassName}>
            Оценка задачи, часы
          </label>
          <TextInput
            id={ids.estimate}
            className="mt-1.5"
            inputMode="decimal"
            autoComplete="off"
            placeholder="Не оценено"
            value={estimateMode.kind === 'inherited' ? estimateMode.text : draft.estimate}
            readOnly={estimateMode.kind === 'inherited'}
            aria-invalid={errors.estimate ? true : undefined}
            aria-describedby={errors.estimate ? `${ids.estimateError} ${ids.estimateHint}` : ids.estimateHint}
            onChange={(event) => {
              if (estimateMode.kind !== 'inherited') onChange({ estimate: event.target.value });
            }}
          />
          <FieldError id={ids.estimateError} message={errors.estimate} />
        </div>
      </div>

      <p id={ids.estimateHint} className="rounded-lg bg-canvas px-3 py-2 text-xs leading-relaxed text-muted">
        {estimateMode.kind === 'inherited'
          ? `Подзадача-детализация входит в оценку задачи «${estimateMode.parentTitle}»: оценка общая и отдельно не задаётся. Для новой работы выберите «Дополнительный объём».`
          : estimateMode.kind === 'shared'
            ? 'Оценка задачи — общий бюджет команды на эту работу, не личная оценка и не базовый план. Подзадачи-детализация показывают ту же оценку, поэтому изменение затронет и их. Участники её не делят и не умножают.'
            : 'Оценка задачи — общий бюджет команды на эту работу, не личная оценка и не базовый план. Например: 1,5 или 1:30. Пустое поле — «не оценено», 0 — оценено в ноль.'}
      </p>

      <fieldset>
        <legend className={labelClassName}>Участники</legend>
        {members.length === 0 && retainedParticipantIds.length === 0 ? (
          <p className="mt-1.5 text-sm text-muted">В пространстве нет участников.</p>
        ) : (
          <ul className="mt-1.5 grid gap-1 sm:grid-cols-2">
            {members.map((member) => (
              <li key={member.id}>
                <label className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-sm text-ink-soft">
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-accent"
                    checked={draft.participantMembershipIds.includes(member.id)}
                    onChange={(event) =>
                      onChange({
                        participantMembershipIds: toggle(draft.participantMembershipIds, member.id, event.target.checked),
                      })
                    }
                  />
                  <span className="truncate">{member.displayName}</span>
                </label>
              </li>
            ))}
            {retainedParticipantIds.map((membershipId, index) => {
              const checked = draft.participantMembershipIds.includes(membershipId);
              return (
                <li key={membershipId}>
                  <label className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-sm text-muted">
                    <input
                      type="checkbox"
                      className="size-4 shrink-0 accent-accent"
                      checked={checked}
                      // Only removal, or putting back a saved reference; never a new assignment.
                      disabled={!checked && !savedRetained.has(membershipId)}
                      onChange={(event) =>
                        onChange({
                          participantMembershipIds: toggle(draft.participantMembershipIds, membershipId, event.target.checked),
                        })
                      }
                    />
                    <UserRound size={14} aria-hidden="true" className="shrink-0" />
                    <span className="truncate">
                      {retainedParticipantIds.length > 1 ? `${UNAVAILABLE_MEMBER} ${index + 1}` : UNAVAILABLE_MEMBER}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {retainedParticipantIds.length > 0 ? (
          <p className="mt-1 text-xs text-muted">
            Недоступный участник больше не состоит в пространстве, но остаётся в задаче. Снимите отметку, чтобы убрать его
            из участников.
          </p>
        ) : null}
      </fieldset>

      <fieldset>
        <legend className={labelClassName}>Теги</legend>
        {tagAction ? <div className="mt-1">{tagAction}</div> : null}
        {tagOptions.length === 0 && missingTagIds.length === 0 ? (
          <p className="mt-1.5 text-sm text-muted">Тегов пока нет.</p>
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
                      disabled={!assignable}
                      onChange={(event) => onChange({ tagIds: toggle(draft.tagIds, tag.id, event.target.checked) })}
                    />
                    <TagSwatch color={tag.color} className={archived ? 'opacity-50' : undefined} />
                    <span className="truncate">{archived ? `${tag.name} (в архиве)` : tag.name}</span>
                  </label>
                </li>
              );
            })}
            {missingTagIds.map((tagId) => (
              <li key={tagId} className="inline-flex items-center rounded-full border border-line px-2.5 py-1 text-xs text-muted">
                Тег недоступен
              </li>
            ))}
          </ul>
        )}
      </fieldset>
    </div>
  );
}
