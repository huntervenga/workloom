import { createTagInputSchema, type TagDto, type UpdateTagInput } from '@workloom/contracts';
import { Badge, Button, Skeleton, TextInput, cn } from '@workloom/ui';
import { Pencil, Plus, RefreshCw, Tags } from 'lucide-react';
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../../lib/api';
import { DialogShell } from '../../shared/DialogShell';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { SaveFeedback } from '../../shared/SaveFeedback';
import {
  useCreateTagMutation,
  useReloadTags,
  useTagsQuery,
  useUpdateTagMutation,
  type UpdateTagVariables,
} from './queries';

/** Same limit as the tag name in @workloom/contracts, which remains the authority. */
const TAG_NAME_MAX = 80;
const DEFAULT_TAG_COLOR = '#64748b';

export interface TagFormValue {
  name: string;
  color: string | null;
}

function tagProblem(value: TagFormValue): string | null {
  if (createTagInputSchema.safeParse(value).success) return null;
  if (value.name.trim() === '') return 'Введите название тега.';
  if (value.name.trim().length > TAG_NAME_MAX) return `Название должно быть не длиннее ${TAG_NAME_MAX} символов.`;
  return 'Цвет должен быть в формате #rrggbb.';
}

export function TagSwatch({ color, className }: { color: string | null; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-2.5 shrink-0 rounded-full', color === null && 'bg-subtle', className)}
      style={color === null ? undefined : { backgroundColor: color }}
    />
  );
}

interface TagFormProps {
  initial: TagFormValue;
  submitLabel: string;
  pending: boolean;
  /** The sent command's outcome is unknown: fields are locked and submitting resends it. */
  locked: boolean;
  /**
   * The full visible value of this form's command while it is pending or uncertain, as submitted.
   * It is shown read-only instead of the draft, also after the form is remounted.
   */
  sent?: TagFormValue | null | undefined;
  /** The shared command is busy with another tag: fields are read-only and nothing is sent. */
  blocked?: boolean | undefined;
  onRetry: () => void;
  feedback: ReactNode;
  notice?: string | null | undefined;
  onSubmit: (value: TagFormValue) => void;
  onCancel: () => void;
}

function TagForm({
  initial,
  submitLabel,
  pending,
  locked,
  sent = null,
  blocked = false,
  onRetry,
  feedback,
  notice,
  onSubmit,
  onCancel,
}: TagFormProps) {
  const [name, setName] = useState(sent ? sent.name : initial.name);
  const [color, setColor] = useState<string | null>(sent ? sent.color : initial.color);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const frozen = pending || locked || blocked || sent !== null;
  const shown = sent ?? { name, color };
  const nameRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const errorId = useId();
  const colorId = useId();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Rendered in a portal: keep the submit from reaching an enclosing task form.
    event.stopPropagation();
    if (pending || blocked) return;
    if (locked) {
      onRetry();
      return;
    }
    const value = { name: name.trim(), color };
    const problem = tagProblem(value);
    setFieldError(problem);
    if (problem) {
      nameRef.current?.focus();
      return;
    }
    // The draft becomes what is sent, so a confirmed error leaves the sent values in the fields.
    setName(value.name);
    onSubmit(value);
  };

  return (
    <form noValidate onSubmit={submit} className="space-y-3">
      <div>
        <label htmlFor={nameId} className="text-sm font-medium text-ink">
          Название тега
        </label>
        <TextInput
          ref={nameRef}
          id={nameId}
          className="mt-1.5"
          value={shown.name}
          maxLength={TAG_NAME_MAX}
          readOnly={frozen}
          autoComplete="off"
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? errorId : undefined}
          onChange={(event) => {
            setName(event.target.value);
            if (fieldError) setFieldError(null);
          }}
        />
        {fieldError ? (
          <p id={errorId} className="mt-1.5 text-sm text-red-700">
            {fieldError}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            className="size-4 accent-accent"
            checked={shown.color !== null}
            disabled={frozen}
            onChange={(event) => setColor(event.target.checked ? (initial.color ?? DEFAULT_TAG_COLOR) : null)}
          />
          Цвет
        </label>
        {shown.color !== null ? (
          <>
            <label htmlFor={colorId} className="sr-only">
              Цвет тега
            </label>
            <input
              id={colorId}
              type="color"
              value={shown.color}
              disabled={frozen}
              onChange={(event) => setColor(event.target.value.toLowerCase())}
              className="h-8 w-12 cursor-pointer rounded-md border border-line bg-surface"
            />
          </>
        ) : (
          <span className="text-xs text-subtle">Без цвета</span>
        )}
      </div>

      {feedback}
      {notice ? (
        <p role="status" className="rounded-lg bg-canvas px-3 py-2.5 text-sm leading-relaxed text-ink-soft">
          {notice}
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button onClick={onCancel}>{locked ? 'Скрыть' : 'Отмена'}</Button>
        <Button type="submit" variant="primary" aria-disabled={pending || blocked || undefined}>
          {pending ? 'Сохраняем…' : locked ? 'Повторить отправку' : submitLabel}
        </Button>
      </div>
    </form>
  );
}

type CreateTagMutation = ReturnType<typeof useCreateTagMutation>;

/** A create sends the full value, so the pending or uncertain command is the snapshot. */
function sentCreateValue(mutation: CreateTagMutation): TagFormValue | null {
  const sent = mutation.isPending ? mutation.variables : mutation.uncertain?.variables;
  return sent ? { name: sent.input.name, color: sent.input.color ?? null } : null;
}

/** An update sends only changed fields; the form values it was submitted with are kept beside it. */
interface SentTagEdit {
  variables: UpdateTagVariables;
  value: TagFormValue;
}

function sameTagCommand(a: UpdateTagVariables, b: UpdateTagVariables): boolean {
  return (
    a.tagId === b.tagId &&
    a.input.expectedRevision === b.input.expectedRevision &&
    a.input.name === b.input.name &&
    a.input.color === b.input.color
  );
}

export interface CreateTagDialogProps {
  /** Owned by a component that outlives the dialog, so an uncertain create is not forgotten. */
  mutation: CreateTagMutation;
  onCreated: (tag: TagDto) => void;
}

/** «Новый тег» from inside the task form; the task draft and focus stay where they were. */
export function CreateTagDialog({ mutation, onCreated }: CreateTagDialogProps) {
  const [open, setOpen] = useState(false);
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next && !mutation.isPending) mutation.reset();
  };
  const onSuccess = (tag: TagDto) => {
    changeOpen(false);
    onCreated(tag);
  };
  const { uncertain } = mutation;

  return (
    <DialogShell
      title="Новый тег"
      description="Тег появится во всём пространстве. Задачи хранят ссылку на тег, поэтому переименование его не теряет."
      trigger={
        <Button size="sm" variant="ghost">
          <Plus size={14} aria-hidden="true" />
          Новый тег
        </Button>
      }
      open={open}
      onOpenChange={changeOpen}
    >
      <div className="mt-5">
        <TagForm
          initial={{ name: '', color: null }}
          submitLabel="Создать тег"
          pending={mutation.isPending}
          locked={uncertain !== null}
          sent={sentCreateValue(mutation)}
          onRetry={() => mutation.retryUncertain({ onSuccess })}
          feedback={<SaveFeedback error={mutation.error} uncertainError={uncertain?.error ?? null} subject="tagSave" />}
          onSubmit={(value) => mutation.mutate({ input: value }, { onSuccess })}
          onCancel={() => changeOpen(false)}
        />
      </div>
    </DialogShell>
  );
}

export interface TagManagerDialogProps {
  actorId: string;
  workspaceId: string;
  canEdit: boolean;
}

function orderTags(tags: readonly TagDto[]): TagDto[] {
  return [...tags].sort(
    (a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null) || a.name.localeCompare(b.name, 'ru'),
  );
}

/** Workspace tags: create and rename, by ID and revision. Archiving is not offered here. */
export function TagManagerDialog({ actorId, workspaceId, canEdit }: TagManagerDialogProps) {
  const [open, setOpen] = useState(false);
  const tags = useTagsQuery(actorId, workspaceId);
  const create = useCreateTagMutation(actorId, workspaceId);
  const update = useUpdateTagMutation(actorId, workspaceId);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Outlives the edit form, so reopening it while the command is unresolved shows what was submitted.
  const [sentEdit, setSentEdit] = useState<SentTagEdit | null>(null);
  const [announcement, setAnnouncement] = useState('');

  // An uncertain command keeps its form open until it is resent and confirmed.
  const showCreate = canEdit && (creating || create.uncertain !== null);
  const activeEditId = canEdit ? (update.uncertain?.variables.tagId ?? editingId) : null;

  const closeCreate = () => {
    setCreating(false);
    if (!create.isPending) create.reset();
  };
  const closeEdit = () => {
    setEditingId(null);
    if (!update.isPending) update.reset();
  };
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      closeCreate();
      closeEdit();
    }
  };
  const onCreated = (tag: TagDto) => {
    setCreating(false);
    setAnnouncement(`Тег «${tag.name}» создан.`);
  };

  return (
    <DialogShell
      title="Теги пространства"
      description="Теги общие для всех проектов пространства. Задачи ссылаются на тег, поэтому после переименования он остаётся на задачах."
      trigger={
        <Button>
          <Tags size={16} aria-hidden="true" />
          Теги
        </Button>
      }
      open={open}
      onOpenChange={changeOpen}
    >
      <div className="mt-5 space-y-4">
        <p role="status" className="sr-only">
          {announcement}
        </p>
        {showCreate ? (
          <section aria-label="Новый тег" className="rounded-xl border border-line p-3">
            <TagForm
              initial={{ name: '', color: null }}
              submitLabel="Создать тег"
              pending={create.isPending}
              locked={create.uncertain !== null}
              sent={sentCreateValue(create)}
              onRetry={() => create.retryUncertain({ onSuccess: onCreated })}
              feedback={
                <SaveFeedback error={create.error} uncertainError={create.uncertain?.error ?? null} subject="tagSave" />
              }
              onSubmit={(value) => create.mutate({ input: value }, { onSuccess: onCreated })}
              onCancel={closeCreate}
            />
          </section>
        ) : canEdit ? (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={16} aria-hidden="true" />
            Новый тег
          </Button>
        ) : (
          <p className="text-sm text-muted">Роль «Наблюдатель» позволяет только просматривать теги.</p>
        )}

        {tags.isPending ? (
          <div role="status" className="space-y-2">
            <span className="sr-only">Загрузка тегов</span>
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        ) : tags.isError ? (
          <QueryErrorState
            error={tags.error}
            subject="tags"
            headingLevel={3}
            retrying={tags.isFetching}
            onRetry={() => void tags.refetch()}
          />
        ) : tags.data.length === 0 ? (
          <p className="text-sm text-muted">Тегов пока нет.</p>
        ) : (
          <ul aria-label="Теги" className="divide-y divide-line rounded-xl border border-line">
            {orderTags(tags.data).map((tag) =>
              activeEditId === tag.id ? (
                <li key={tag.id} className="p-3">
                  <EditTagForm
                    actorId={actorId}
                    workspaceId={workspaceId}
                    tag={tag}
                    mutation={update}
                    sentEdit={sentEdit}
                    onSend={setSentEdit}
                    onDone={(renamed) => {
                      closeEdit();
                      if (renamed) setAnnouncement(`Тег «${renamed.name}» сохранён.`);
                    }}
                  />
                </li>
              ) : (
                <li key={tag.id} className="flex min-w-0 items-center gap-2 px-3 py-2">
                  <TagSwatch color={tag.color} />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink" title={tag.name}>
                    {tag.name}
                  </span>
                  {tag.archivedAt !== null ? <Badge tone="muted">В архиве</Badge> : null}
                  {canEdit ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="px-2"
                      aria-label={`Изменить тег «${tag.name}»`}
                      onClick={() => {
                        if (update.uncertain === null) setEditingId(tag.id);
                      }}
                    >
                      <Pencil size={14} aria-hidden="true" />
                    </Button>
                  ) : null}
                </li>
              ),
            )}
          </ul>
        )}
      </div>
    </DialogShell>
  );
}

interface EditTagFormProps {
  actorId: string;
  workspaceId: string;
  tag: TagDto;
  mutation: ReturnType<typeof useUpdateTagMutation>;
  sentEdit: SentTagEdit | null;
  onSend: (sent: SentTagEdit) => void;
  onDone: (saved: TagDto | null) => void;
}

/**
 * Sends only changed fields against the revision captured when editing started. The mutation is
 * shared by all tags, so while it carries another tag's command this form is blocked.
 */
function EditTagForm({ actorId, workspaceId, tag, mutation, sentEdit, onSend, onDone }: EditTagFormProps) {
  const reloadTags = useReloadTags(actorId, workspaceId);
  const [base, setBase] = useState({ revision: tag.revision, name: tag.name, color: tag.color });
  const [reload, setReload] = useState<'idle' | 'loading' | 'done' | 'failed' | 'missing'>('idle');
  const command = mutation.isPending ? mutation.variables : mutation.uncertain?.variables;
  const own = command?.tagId === tag.id;
  const otherTarget = command !== undefined && !own;
  const uncertain = own ? mutation.uncertain : null;
  const error = mutation.variables?.tagId === tag.id ? mutation.error : null;
  const conflict = error instanceof ApiError && error.kind === 'conflict';
  // Omitted fields come from the submitted form, never from a later refresh of the tag.
  const sent =
    command === undefined || !own
      ? null
      : sentEdit !== null && sameTagCommand(sentEdit.variables, command)
        ? sentEdit.value
        : {
            name: command.input.name ?? base.name,
            color: command.input.color === undefined ? base.color : command.input.color,
          };
  const otherNotice = !otherTarget
    ? null
    : mutation.isPending
      ? 'Сохраняется изменение другого тега. Этот тег можно будет изменить после ответа сервера.'
      : 'Изменение другого тега не подтверждено. Сначала повторите его отправку.';

  const loadLatest = async () => {
    if (reload === 'loading') return;
    setReload('loading');
    try {
      const fresh = (await reloadTags()).find((item) => item.id === tag.id);
      if (!fresh) {
        setReload('missing');
        return;
      }
      setBase({ revision: fresh.revision, name: fresh.name, color: fresh.color });
      mutation.reset();
      setReload('done');
    } catch {
      setReload('failed');
    }
  };

  return (
    <TagForm
      initial={{ name: tag.name, color: tag.color }}
      submitLabel="Сохранить"
      pending={mutation.isPending && own}
      locked={uncertain !== null}
      sent={sent}
      blocked={otherTarget}
      onRetry={() => mutation.retryUncertain({ onSuccess: (saved) => onDone(saved) })}
      feedback={
        <SaveFeedback
          error={error}
          uncertainError={uncertain?.error ?? null}
          subject="tagSave"
          action={
            conflict ? (
              <Button size="sm" aria-disabled={reload === 'loading' || undefined} onClick={() => void loadLatest()}>
                <RefreshCw size={16} aria-hidden="true" className={reload === 'loading' ? 'motion-safe:animate-spin' : undefined} />
                Загрузить актуальную версию
              </Button>
            ) : null
          }
        />
      }
      notice={
        otherNotice ??
        (reload === 'done'
          ? `Загружена актуальная версия: «${base.name}». Ваши значения остались в полях — сохраните их, если они всё ещё нужны.`
          : reload === 'failed'
            ? 'Не удалось загрузить актуальную версию тега. Повторите попытку.'
            : reload === 'missing'
              ? 'Тег больше недоступен.'
              : null)
      }
      onSubmit={(value) => {
        const input: UpdateTagInput = { expectedRevision: base.revision };
        if (value.name !== base.name) input.name = value.name;
        if (value.color !== base.color) input.color = value.color;
        if (input.name === undefined && input.color === undefined) {
          onDone(null);
          return;
        }
        const variables: UpdateTagVariables = { tagId: tag.id, input };
        onSend({ variables, value });
        mutation.mutate(variables, { onSuccess: (saved) => onDone(saved) });
      }}
      onCancel={() => onDone(null)}
    />
  );
}
