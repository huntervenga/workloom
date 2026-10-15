import type { ProjectColumnsDto } from '@workloom/contracts';
import { Badge, Button } from '@workloom/ui';
import { ChevronDown, ChevronUp, Pencil, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../lib/api';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { FIELDS_SAVE_SUBJECT, sentCommand } from './FieldDefinitionForm';
import type { useUpdateProjectColumnsMutation } from './queries';

type ProjectColumn = ProjectColumnsDto['columns'][number];
type UpdateColumnsMutation = ReturnType<typeof useUpdateProjectColumnsMutation>;

/** A local layout edited against the settings revision it was based on. */
interface ColumnsDraft {
  revision: number;
  columns: ProjectColumn[];
}

function byPosition(columns: readonly ProjectColumn[]): ProjectColumn[] {
  return [...columns].sort((a, b) => a.position - b.position);
}

function sameLayout(a: readonly ProjectColumn[], b: readonly ProjectColumn[]): boolean {
  return a.length === b.length && a.every((column, index) => column.fieldId === b[index]?.fieldId && column.visible === b[index]?.visible);
}

/**
 * Keeps the user's order and visibility for columns that are still active, appends columns that
 * appeared meanwhile in their saved order and drops the ones that are gone.
 */
function mergeLayout(mine: readonly ProjectColumn[], fresh: readonly ProjectColumn[]) {
  const freshIds = new Set(fresh.map((column) => column.fieldId));
  const mineIds = new Set(mine.map((column) => column.fieldId));
  const kept = mine.filter((column) => freshIds.has(column.fieldId));
  const added = byPosition(fresh).filter((column) => !mineIds.has(column.fieldId));
  return { columns: [...kept, ...added], added: added.length, removed: mine.length - kept.length };
}

type ReloadState =
  | { state: 'idle' | 'loading' | 'failed' | 'missing' }
  | { state: 'done'; added: number; removed: number };

function reloadNotice(reload: ReloadState): string | null {
  if (reload.state === 'failed') return 'Не удалось загрузить актуальное расположение. Повторите попытку.';
  if (reload.state === 'missing') return 'Настройки колонок проекта больше недоступны.';
  if (reload.state !== 'done') return null;
  const parts = ['Загружена актуальная версия расположения. Ваш порядок и видимость сохранены для оставшихся колонок'];
  if (reload.added > 0) parts.push(`новые колонки (${reload.added}) добавлены в конец`);
  if (reload.removed > 0) parts.push(`колонки, которых больше нет в проекте (${reload.removed}), убраны`);
  return `${parts.join('; ')}. Проверьте расположение и сохраните его снова.`;
}

export interface ProjectColumnsEditorProps {
  projectId: string;
  columns: ProjectColumnsDto;
  /** Names of the project's fields by ID. */
  fieldNames: ReadonlyMap<string, string>;
  canManage: boolean;
  /** Owned by a component that outlives the dialog, so a pending or unconfirmed save is kept. */
  mutation: UpdateColumnsMutation;
  /** Refetches the settings and field names; resolves to the fresh settings, or null when they are gone. */
  reload: () => Promise<ProjectColumnsDto | null>;
  onEditField?: ((fieldId: string) => void) | undefined;
}

/**
 * Shared project column order and visibility. The whole layout is saved explicitly with the
 * settings revision; widths are kept as they are. A sent layout stays on screen, read-only, until
 * it is confirmed, also after the dialog is closed and reopened.
 */
export function ProjectColumnsEditor({
  projectId,
  columns,
  fieldNames,
  canManage,
  mutation,
  reload,
  onEditField,
}: ProjectColumnsEditorProps) {
  const command = sentCommand(mutation);
  const own = command !== null && command.variables.projectId === projectId;
  const otherTarget = command !== null && !own;
  const uncertain = own ? mutation.uncertain : null;
  const error = mutation.variables?.projectId === projectId ? mutation.error : null;
  const correctable = error instanceof ApiError && (error.kind === 'conflict' || error.kind === 'validation');

  // A confirmed error after the dialog was closed reopens with what was sent, still against its revision.
  const [draft, setDraft] = useState<ColumnsDraft | null>(() => {
    const failed = mutation.variables;
    return error && failed?.projectId === projectId
      ? { revision: failed.input.expectedRevision, columns: byPosition(failed.input.columns) }
      : null;
  });
  // The confirmed answer is shown until the refetch catches up, so the old order does not flash back.
  const [saved, setSaved] = useState<ProjectColumnsDto | null>(null);
  const [reloadState, setReloadState] = useState<ReloadState>({ state: 'idle' });
  const [announcement, setAnnouncement] = useState('');
  const listRef = useRef<HTMLUListElement>(null);
  const focusAfterMove = useRef<{ fieldId: string; direction: 'up' | 'down' } | null>(null);

  const server = saved !== null && saved.revision >= columns.revision ? saved : columns;
  const serverColumns = byPosition(server.columns);
  const base: ColumnsDraft = draft ?? { revision: server.revision, columns: serverColumns };
  const shown = own ? byPosition(command.variables.input.columns) : base.columns;
  const frozen = !canManage || own || otherTarget;
  const changed = draft !== null && (draft.revision !== server.revision || !sameLayout(draft.columns, serverColumns));
  const nameOf = (fieldId: string) => fieldNames.get(fieldId) ?? 'Колонка недоступна';

  // Moving a row re-renders the list; focus follows the moved column's button.
  useEffect(() => {
    const target = focusAfterMove.current;
    if (!target) return;
    focusAfterMove.current = null;
    const find = (direction: 'up' | 'down') =>
      listRef.current?.querySelector<HTMLButtonElement>(`button[data-field="${target.fieldId}"][data-move="${direction}"]`);
    const button = find(target.direction);
    (button && !button.disabled ? button : find(target.direction === 'up' ? 'down' : 'up'))?.focus();
  });

  const edit = (next: ProjectColumn[]) => {
    setDraft({ revision: base.revision, columns: next });
    if (reloadState.state !== 'idle') setReloadState({ state: 'idle' });
  };

  const move = (index: number, direction: 'up' | 'down') => {
    const target = direction === 'up' ? index - 1 : index + 1;
    const moving = base.columns[index];
    const other = base.columns[target];
    if (frozen || !moving || !other) return;
    const next = [...base.columns];
    next[index] = other;
    next[target] = moving;
    focusAfterMove.current = { fieldId: moving.fieldId, direction };
    setAnnouncement(`Колонка «${nameOf(moving.fieldId)}» перемещена на позицию ${target + 1} из ${next.length}.`);
    edit(next);
  };

  const onSuccess = (result: ProjectColumnsDto) => {
    setSaved(result);
    setDraft(null);
    setReloadState({ state: 'idle' });
    setAnnouncement('Расположение колонок сохранено.');
  };

  const save = () => {
    if (!canManage || mutation.pendingCommand !== null || otherTarget) return;
    if (uncertain) {
      mutation.retryUncertain({ onSuccess });
      return;
    }
    if (!changed) return;
    mutation.mutate(
      {
        projectId,
        input: {
          expectedRevision: base.revision,
          columns: base.columns.map((column, position) => ({ ...column, position })),
        },
      },
      { onSuccess },
    );
  };

  const loadLatest = async () => {
    if (reloadState.state === 'loading') return;
    setReloadState({ state: 'loading' });
    try {
      const fresh = await reload();
      if (!fresh) {
        setReloadState({ state: 'missing' });
        return;
      }
      const merged = mergeLayout(base.columns, fresh.columns);
      setSaved(null);
      setDraft({ revision: fresh.revision, columns: merged.columns });
      mutation.reset();
      setReloadState({ state: 'done', added: merged.added, removed: merged.removed });
    } catch {
      setReloadState({ state: 'failed' });
    }
  };

  const otherNotice = !otherTarget
    ? null
    : command.pending
      ? 'Сохраняется расположение колонок другого проекта. Здесь его можно будет изменить после ответа сервера.'
      : 'Расположение колонок другого проекта не подтверждено. Сначала откройте тот проект и повторите отправку.';
  const notice = otherNotice ?? reloadNotice(reloadState);

  return (
    <section aria-label="Расположение колонок" className="space-y-3">
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {shown.length === 0 ? (
        <p className="text-sm text-muted">Колонок пока нет.</p>
      ) : (
        <>
          {canManage ? (
            <p className="text-xs leading-relaxed text-subtle">Отмеченные колонки видны в таблице задач проекта.</p>
          ) : null}
          <ul ref={listRef} aria-label="Колонки" className="divide-y divide-line rounded-xl border border-line">
            {shown.map((column, index) => {
              const name = nameOf(column.fieldId);
              return (
                <li key={column.fieldId} className="flex min-w-0 items-center gap-1.5 px-3 py-1.5">
                  {canManage ? (
                    <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-ink">
                      <input
                        type="checkbox"
                        className="size-4 shrink-0 accent-accent"
                        checked={column.visible}
                        disabled={frozen}
                        onChange={(event) =>
                          edit(
                            base.columns.map((item) =>
                              item.fieldId === column.fieldId ? { ...item, visible: event.target.checked } : item,
                            ),
                          )
                        }
                      />
                      <span className="min-w-0 truncate" title={name}>
                        {name}
                      </span>
                    </label>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-sm text-ink" title={name}>
                      {name}
                    </span>
                  )}
                  {column.visible ? null : <Badge tone="muted">Скрыта</Badge>}
                  {canManage ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="px-2"
                        data-field={column.fieldId}
                        data-move="up"
                        aria-label={`Поднять колонку «${name}»`}
                        disabled={frozen || index === 0}
                        onClick={() => move(index, 'up')}
                      >
                        <ChevronUp size={14} aria-hidden="true" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="px-2"
                        data-field={column.fieldId}
                        data-move="down"
                        aria-label={`Опустить колонку «${name}»`}
                        disabled={frozen || index === shown.length - 1}
                        onClick={() => move(index, 'down')}
                      >
                        <ChevronDown size={14} aria-hidden="true" />
                      </Button>
                      {onEditField && fieldNames.has(column.fieldId) ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="px-2"
                          aria-label={`Изменить колонку «${name}»`}
                          onClick={() => onEditField(column.fieldId)}
                        >
                          <Pencil size={14} aria-hidden="true" />
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {canManage ? (
        <>
          <SaveFeedback
            error={error}
            uncertainError={uncertain?.error ?? null}
            subject={FIELDS_SAVE_SUBJECT}
            action={
              correctable ? (
                <Button
                  size="sm"
                  aria-disabled={reloadState.state === 'loading' || undefined}
                  onClick={() => void loadLatest()}
                >
                  <RefreshCw
                    size={16}
                    aria-hidden="true"
                    className={reloadState.state === 'loading' ? 'motion-safe:animate-spin' : undefined}
                  />
                  Загрузить актуальную версию
                </Button>
              ) : null
            }
          />
          {notice ? (
            <p role="status" className="rounded-lg bg-canvas px-3 py-2.5 text-sm leading-relaxed text-ink-soft">
              {notice}
            </p>
          ) : null}
          {shown.length > 0 || changed || own ? (
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              {changed && !own ? (
                <Button
                  onClick={() => {
                    setDraft(null);
                    setReloadState({ state: 'idle' });
                    if (mutation.pendingCommand === null) mutation.reset();
                  }}
                >
                  Отменить изменения
                </Button>
              ) : null}
              <Button
                variant="primary"
                disabled={!own && !changed}
                aria-disabled={(own && command.pending) || otherTarget || undefined}
                onClick={save}
              >
                {own && command.pending ? 'Сохраняем…' : uncertain ? 'Повторить отправку' : 'Сохранить расположение'}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
