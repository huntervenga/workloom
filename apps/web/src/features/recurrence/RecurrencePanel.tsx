import {
  RECURRENCE_LIMITS,
  type MembershipDto,
  type PlanningPeriodDto,
  type ProjectDto,
  type RecurrenceSeriesDto,
  type SectionDto,
  type TaskStatusDto,
  type WorkspaceDto,
} from '@workloom/contracts';
import { Badge, Button, inputClassName } from '@workloom/ui';
import { useId, type ReactNode } from 'react';
import { ApiError, isAccessDenied } from '../../lib/api';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { SaveFeedback, UncertainCommandNotice } from '../../shared/SaveFeedback';
import { RecurrenceCreateDialog } from './RecurrenceCreateDialog';
import { RecurrenceManagementDialog } from './RecurrenceManagementDialog';
import { recurrenceEditSessionDirty, recurrencePeriodSessionDirty, recurrenceExceptionSessionDirty } from './useRecurrenceManagement';
import { RecurrenceInstancesTable } from './RecurrenceInstancesTable';
import { RecurrenceReadinessCard } from './RecurrenceReadinessCard';
import {
  useRecurrenceInstancesQuery,
  useRecurrenceReadinessQuery,
  useRecurrenceSeriesDetailQuery,
  useRecurrenceSeriesQuery,
} from './queries';
import type { RecurrenceWorkspace } from './useRecurrenceWorkspace';

export interface RecurrencePanelProps {
  controller: RecurrenceWorkspace;
  actorId: string;
  workspace: WorkspaceDto;
  project: ProjectDto;
  /** The week chosen on the page; the panel never picks one itself. */
  period: PlanningPeriodDto | null;
  periods: readonly PlanningPeriodDto[];
  members: readonly MembershipDto[];
  statuses: readonly TaskStatusDto[];
  sections: readonly SectionDto[];
  writable: boolean;
  accessDenied: boolean;
  onSelectPeriod: (id: string) => void;
  /** Page-owned selection (e.g. kept in the URL); defaults to the controller's own selection. */
  onSelectSeries?: ((seriesId: string | null) => void) | undefined;
  /** Opens the prepared meeting in the period its occurrence was originally assigned to. */
  onOpenMeeting: (taskId: string, periodId: string) => void;
}

/** One bounded chunk per explicit click; continuing is another explicit click. */
const CHUNK_LIMIT = RECURRENCE_LIMITS.maxRealCreatesPerChunk;

const seriesStateLabels: Record<RecurrenceSeriesDto['state'], string> = {
  active: 'Активна',
  paused: 'Фоновая подготовка приостановлена',
};

/** Fixed labels for commands whose management UI is not part of this pass. */
const otherCommandLabels = {
  edit: 'Изменение серии',
  state: 'Изменение состояния серии',
  addPeriods: 'Добавление периодов серии',
  authorize: 'Разрешение подготовки встреч',
  exception: 'Изменение одной встречи серии',
} as const;
type OtherCommandKind = keyof typeof otherCommandLabels;
const otherCommandKinds = Object.keys(otherCommandLabels) as OtherCommandKind[];

const hintClass = 'text-xs leading-relaxed text-muted';

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function seriesOptionLabel(series: RecurrenceSeriesDto): string {
  return `${series.currentVersion.template.title} — ${seriesStateLabels[series.state]} · периодов в серии: ${series.boundPeriodCount}`;
}

/** First "to do" status by board position; empty when the project has none, so the form asks. */
function defaultStatusId(statuses: readonly TaskStatusDto[]): string {
  return [...statuses].filter((status) => status.group === 'todo').sort((a, b) => a.position - b.position)[0]?.id ?? '';
}

/**
 * Always-mounted recurrence section of the weekly page. All drafts, held commands and chunk results
 * live in the page controller; this panel only reads, renders and dispatches explicit user actions.
 */
export function RecurrencePanel({
  controller: c,
  actorId,
  workspace,
  project,
  period,
  periods,
  members,
  statuses,
  sections,
  writable,
  accessDenied,
  onSelectPeriod,
  onSelectSeries,
  onOpenMeeting,
}: RecurrencePanelProps) {
  const headingId = useId();
  const selectId = useId();
  // Every user selection goes through one path, so a page-held URL never goes stale.
  const selectSeries = (seriesId: string | null) => (onSelectSeries ?? c.setSelectedSeriesId)(seriesId);

  // A denied parent stops every read here; cached recurrence data is never shown under a denial.
  const live = !accessDenied;
  const seriesList = useRecurrenceSeriesQuery(actorId, workspace.id, live ? project.id : '');
  const denied = accessDenied || isAccessDenied(seriesList.error);

  const selectedId = c.selectedSeriesId;
  const detail = useRecurrenceSeriesDetailQuery(actorId, workspace.id, !denied && selectedId !== null ? selectedId : '');
  const detailDenied = isAccessDenied(detail.error);
  const listed = selectedId !== null ? seriesList.data?.find((item) => sameId(item.id, selectedId)) : undefined;
  const shownSeries = detailDenied ? undefined : (detail.data ?? listed);
  const bound = shownSeries !== undefined && period !== null && shownSeries.boundPeriodIds.some((id) => sameId(id, period.id));

  const readiness = useRecurrenceReadinessQuery(actorId, workspace.id, !denied && period !== null ? period.id : '');
  const instances = useRecurrenceInstancesQuery(
    actorId,
    workspace.id,
    !denied && bound && selectedId !== null ? selectedId : '',
    bound && period !== null ? period.id : '',
  );

  const selectedDenied = detailDenied || isAccessDenied(instances.error) || otherCommandKinds.some(kind => {
    const command = c.commands[kind];
    return selectedId !== null && command.variables?.seriesId !== undefined && sameId(command.variables.seriesId, selectedId) && isAccessDenied(command.error);
  });
  const visibleSeries = selectedDenied ? undefined : shownSeries;
  const management = c.management;
  const heldMutation = (kind: OtherCommandKind) => c.commands[kind].pendingCommand !== null || c.commands[kind].uncertain !== null;
  const reopenCommand = (kind: OtherCommandKind, draftId: string | undefined, seriesId: string) => {
    if (kind === 'edit') { const draft = Object.values(management.edits).find(item => item.id === draftId); if (draft) { management.openEdit(draft.base); return; } }
    if (kind === 'addPeriods') { const draft = Object.values(management.periodSessions).find(item => item.id === draftId); if (draft) { management.openPeriods(draft.base); return; } }
    if (kind === 'exception') { const draft = Object.values(management.exceptions).find(item => item.id === draftId); if (draft) { management.openException(draft.baseSeries, draft.baseInstance, draft.kind); return; } }
    selectSeries(seriesId);
  };
  const retained = [
    ...Object.values(management.edits).filter(recurrenceEditSessionDirty).map(draft => ({ id: draft.id, seriesId: draft.base.id, label: 'Продолжить черновик изменения серии', open: () => management.openEdit(draft.base) })),
    ...Object.values(management.periodSessions).filter(recurrencePeriodSessionDirty).map(draft => ({ id: draft.id, seriesId: draft.base.id, label: 'Продолжить выбор периодов серии', open: () => management.openPeriods(draft.base) })),
    ...Object.values(management.exceptions).filter(recurrenceExceptionSessionDirty).map(draft => ({ id: draft.id, seriesId: draft.baseSeries.id, label: `Продолжить изменение встречи ${draft.baseInstance.occurrenceKey}`, open: () => management.openException(draft.baseSeries, draft.baseInstance, draft.kind) })),
  ];

  const create = c.commands.create;
  const createHeld = create.pendingCommand !== null || create.uncertain !== null;
  const materialize = c.commands.materialize;
  const heldMaterialize = materialize.pendingCommand?.variables ?? materialize.uncertain?.variables ?? null;
  const heldHere = heldMaterialize !== null && period !== null && sameId(heldMaterialize.periodId, period.id);

  // Only the original-variables callback in the controller stores chunk results.
  const lastResult = period !== null ? c.materializationByPeriod[period.id.toLowerCase()] : undefined;
  const lastVariables = materialize.variables;
  const ownError =
    heldMaterialize === null && period !== null && lastVariables !== undefined && sameId(lastVariables.periodId, period.id)
      ? materialize.error
      : null;
  // A confirmed rejection of the stored continuation; restarting without a cursor is safe and explicit.
  const cursorRejected =
    ownError instanceof ApiError &&
    (ownError.kind === 'conflict' || ownError.status === 400) &&
    lastVariables?.input.cursor !== undefined &&
    lastVariables.input.cursor === lastResult?.nextCursor;
  const continueCursor =
    !cursorRejected && lastResult?.status === 'pending' && lastResult.nextCursor !== null ? lastResult.nextCursor : undefined;

  /** Sends one fresh chunk for the shown period. A held command is only ever resent, never replaced. */
  const prepare = () => {
    if (period === null || !writable || denied || heldMaterialize !== null) return;
    materialize.mutate({
      periodId: period.id,
      input: continueCursor === undefined ? { limit: CHUNK_LIMIT } : { limit: CHUNK_LIMIT, cursor: continueCursor },
    });
  };

  const ownMembershipId = members.find((member) => member.userId === actorId)?.id ?? '';
  const openCreate = () =>
    c.openCreate({ timezone: workspace.timezone, statusId: defaultStatusId(statuses), organizerMembershipId: ownMembershipId });
  const selectCreated = (seriesId: string) => {
    selectSeries(seriesId);
    c.clearLastCreatedSeries();
  };

  const created = c.lastCreatedSeries;
  const createdUnseen = created !== null && !(selectedId !== null && sameId(selectedId, created.id));

  const otherHeld = otherCommandKinds.flatMap((kind) => {
    const mutation = c.commands[kind];
    const variables = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables;
    if (!variables) return [];
    const occurrenceKey = 'occurrenceKey' in variables ? variables.occurrenceKey : null;
    return [
      {
        key: `${kind}:${variables.seriesId.toLowerCase()}${occurrenceKey === null ? '' : `:${occurrenceKey}`}`,
        kind,
        draftId: variables.draftId,
        seriesId: variables.seriesId,
        pending: mutation.pendingCommand !== null,
        error: mutation.uncertain?.error ?? null,
        retry: () => mutation.retryUncertain(),
      },
    ];
  });

  const heldPeriodName =
    heldMaterialize !== null && !denied ? periods.find((item) => sameId(item.id, heldMaterialize.periodId))?.name : undefined;
  const heldMaterializeLabel = heldPeriodName ? `Подготовка встреч периода «${heldPeriodName}»` : 'Подготовка встреч исходного периода';

  const series = (seriesList.data ?? []).filter(item => !selectedDenied || selectedId === null || !sameId(item.id, selectedId));
  const options = visibleSeries !== undefined && listed === undefined ? [visibleSeries, ...series] : series;

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={headingId} className="text-lg font-semibold">
            Повторяющиеся встречи
          </h2>
          <p className={`mt-1 ${hintClass}`}>
            Серия резервирует даты встреч только в явно выбранных периодах. Сами встречи появляются после подготовки периода; личные
            планы и присутствие подтверждаются отдельно.
          </p>
        </div>
        {writable && !denied ? (
          <Button disabled={createHeld || statuses.length === 0 || members.length === 0} onClick={openCreate}>
            Новая серия встреч
          </Button>
        ) : null}
      </div>

      {create.pendingCommand ? (
        <HeldBox
          text="Создание серии встреч: ждём ответа сервера. Отправленные данные закреплены."
          actions={<Button size="sm" onClick={() => c.setCreateOpen(true)}>Открыть отправку</Button>}
        />
      ) : create.uncertain ? (
        <UncertainHeld
          label="Создание серии встреч"
          error={create.uncertain.error}
          subject="taskSave"
          actions={
            <>
              <Button size="sm" variant="primary" onClick={() => create.retryUncertain()}>
                Повторить создание серии
              </Button>
              <Button size="sm" onClick={() => c.setCreateOpen(true)}>
                Открыть отправку
              </Button>
            </>
          }
        />
      ) : null}

      {heldMaterialize !== null ? (
        materialize.pendingCommand ? (
          <HeldBox
            text={`${heldMaterializeLabel}: ждём ответа сервера. Запрос относится к исходному периоду.`}
            actions={
              heldHere ? null : (
                <Button size="sm" onClick={() => onSelectPeriod(heldMaterialize.periodId)}>
                  Открыть исходный период
                </Button>
              )
            }
          />
        ) : materialize.uncertain ? (
          <UncertainHeld
            label={heldMaterializeLabel}
            error={materialize.uncertain.error}
            subject="planSave"
            actions={
              <>
                <Button size="sm" variant="primary" onClick={() => materialize.retryUncertain()}>
                  Повторить подготовку без изменений
                </Button>
                {heldHere ? null : (
                  <Button size="sm" onClick={() => onSelectPeriod(heldMaterialize.periodId)}>
                    Открыть исходный период
                  </Button>
                )}
              </>
            }
          />
        ) : null
      ) : null}

      {otherHeld.map((command) =>
        command.pending ? (
          <HeldBox key={command.key} text={`${otherCommandLabels[command.kind]}: ждём ответа сервера.`} actions={!denied && !selectedDenied ? <Button size="sm" onClick={() => reopenCommand(command.kind, command.draftId, command.seriesId)}>Открыть исходную отправку</Button> : undefined} />
        ) : command.error ? (
          <UncertainHeld
            key={command.key}
            label={otherCommandLabels[command.kind]}
            error={command.error}
            subject="taskSave"
            actions={
              <>
                <Button size="sm" variant="primary" onClick={command.retry}>
                  Повторить отправку без изменений
                </Button>
                {denied || selectedDenied ? null : (
                  <Button size="sm" onClick={() => reopenCommand(command.kind, command.draftId, command.seriesId)}>
                    Открыть исходную отправку
                  </Button>
                )}
              </>
            }
          />
        ) : null,
      )}

      {created !== null && createdUnseen ? (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-canvas px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {denied || selectedDenied ? 'Серия встреч создана.' : `Серия «${created.currentVersion.template.title}» создана.`}
          </span>
          {denied ? null : (
            <Button size="sm" onClick={() => selectCreated(created.id)}>
              Открыть серию
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={c.clearLastCreatedSeries}>
            Скрыть
          </Button>
        </div>
      ) : null}

      {denied ? (
        <p role="status" className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">
          Повторяющиеся встречи сейчас недоступны текущему пользователю.
        </p>
      ) : (
        <>
          {seriesList.isError ? (
            <QueryErrorState
              error={seriesList.error}
              subject="planning"
              headingLevel={3}
              retrying={seriesList.isFetching}
              onRetry={() => void seriesList.refetch()}
            />
          ) : seriesList.isPending ? (
            <p role="status" className="text-sm text-muted">
              Загрузка серий встреч…
            </p>
          ) : options.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">В проекте пока нет серий встреч.</p>
          ) : (
            <div className="space-y-2">
              <label htmlFor={selectId} className="text-sm font-medium">
                Серия встреч
              </label>
              <select
                id={selectId}
                className={inputClassName()}
                value={visibleSeries?.id ?? ''}
                onChange={(event) => selectSeries(event.target.value || null)}
              >
                <option value="">Не выбрана</option>
                {options.map((item) => (
                  <option key={item.id} value={item.id}>
                    {seriesOptionLabel(item)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {selectedId !== null && selectedDenied ? (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-line p-4 text-sm text-muted">
              <span className="min-w-0 flex-1">Выбранная серия недоступна текущему пользователю.</span>
              <Button size="sm" onClick={() => selectSeries(null)}>
                Снять выбор
              </Button>
            </div>
          ) : selectedId !== null && shownSeries === undefined && detail.isError ? (
            <QueryErrorState
              error={detail.error}
              subject="planning"
              headingLevel={3}
              retrying={detail.isFetching}
              onRetry={() => void detail.refetch()}
            />
          ) : visibleSeries !== undefined ? (
            <div className="space-y-3">
              <SeriesSummary series={visibleSeries} />
              {writable ? <div className="flex flex-wrap gap-2">
                <Button disabled={heldMutation('edit')} onClick={() => management.openEdit(visibleSeries)}>Изменить серию с даты</Button>
                <Button disabled={heldMutation('addPeriods')} onClick={() => management.openPeriods(visibleSeries)}>Добавить периоды серии</Button>
                <Button disabled={heldMutation('state')} onClick={() => c.commands.state.mutate({ seriesId: visibleSeries.id, input: { expectedRevision: visibleSeries.revision, state: visibleSeries.state === 'active' ? 'paused' : 'active' } })}>{visibleSeries.state === 'active' ? 'Приостановить фоновую подготовку' : 'Возобновить фоновую подготовку'}</Button>
                {visibleSeries.generation.state === 'blocked' ? <div className="space-y-2 rounded-lg border border-line p-3 text-sm"><p>Разрешите подготовку встреч от своего имени. При каждом запуске будут проверяться ваши текущие права.</p><Button disabled={heldMutation('authorize')} onClick={() => c.commands.authorize.mutate({ seriesId: visibleSeries.id, input: { expectedRevision: visibleSeries.revision, expectedAuthorizationRevision: visibleSeries.generation.authorizationRevision } })}>Разрешить подготовку от моего имени</Button></div> : null}
              </div> : null}
              {(['state', 'authorize'] as const).map(kind => c.commands[kind].variables?.seriesId === visibleSeries.id && !heldMutation(kind) ? <SaveFeedback key={kind} error={c.commands[kind].error} uncertainError={null} subject="taskSave" /> : null)}
            </div>
          ) : null}

          {retained.filter(draft => !selectedDenied || selectedId === null || !sameId(draft.seriesId, selectedId)).map(draft => <div key={draft.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-canvas p-3 text-sm"><span className="min-w-0 flex-1">Несохранённый черновик серии остаётся на этой странице.</span><Button size="sm" onClick={draft.open}>{draft.label}</Button></div>)}

          {period === null ? (
            <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">
              {periods.length === 0
                ? 'Серии встреч привязываются к существующим периодам. Сначала создайте недельный период.'
                : 'Выберите неделю в списке «Период», чтобы увидеть подготовку встреч серий и встречи выбранной серии.'}
            </p>
          ) : (
            <>
              <RecurrenceReadinessCard
                period={period}
                data={readiness.data}
                error={readiness.error}
                loading={readiness.isPending && readiness.isFetching}
                fetching={readiness.isFetching}
                lastResult={cursorRejected ? undefined : lastResult}
                materializing={heldHere && materialize.pendingCommand !== null}
                blocked={heldMaterialize !== null}
                writable={writable}
                onPrepare={prepare}
                onRefresh={() => void readiness.refetch()}
                onOpenSeries={(seriesId) => selectSeries(seriesId)}
              />
              {ownError ? (
                <div className="space-y-2">
                  <SaveFeedback error={ownError} uncertainError={null} subject="planSave" />
                  {cursorRejected ? (
                    <p className={hintClass}>
                      Продолжение прошлой подготовки устарело. Следующий запуск начнёт подготовку периода с начала; уже подготовленные
                      встречи повторно не создаются.
                    </p>
                  ) : null}
                </div>
              ) : null}

              {visibleSeries === undefined ? null : !bound ? (
                <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">
                  Выбранная неделя не входит в периоды этой серии.
                </p>
              ) : instances.isError ? (
                <QueryErrorState
                  error={instances.error}
                  subject="planning"
                  headingLevel={3}
                  retrying={instances.isFetching}
                  onRetry={() => void instances.refetch()}
                />
              ) : instances.isPending ? (
                <p role="status" className="text-sm text-muted">
                  Загрузка встреч серии…
                </p>
              ) : (
                <RecurrenceInstancesTable instances={instances.data} onOpenMeeting={onOpenMeeting} writable={writable} onSelectException={instance => management.openException(visibleSeries, instance, instance.calendarState === 'cancelled' ? 'restore' : 'skip')} />
              )}
            </>
          )}
        </>
      )}

      <RecurrenceManagementDialog controller={c} workspaceId={workspace.id} periods={periods} members={members} statuses={statuses} sections={sections} writable={writable} accessDenied={denied || selectedDenied} />
      <RecurrenceCreateDialog
        controller={c}
        workspaceId={workspace.id}
        projectId={project.id}
        periods={periods}
        members={members}
        statuses={statuses}
        sections={sections}
        writable={writable}
        accessDenied={denied}
        onCreated={selectCreated}
      />
    </section>
  );
}

function SeriesSummary({ series }: { series: RecurrenceSeriesDto }) {
  const paused = series.state === 'paused';
  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 font-medium [overflow-wrap:anywhere]">{series.currentVersion.template.title}</p>
        <Badge tone={paused ? 'warning' : 'muted'}>{seriesStateLabels[series.state]}</Badge>
      </div>
      <p className={hintClass}>Периодов в серии: {series.boundPeriodCount}.</p>
      {paused ? (
        <p className={hintClass}>
          Серия не отменена: остановлена только фоновая подготовка. Встречи выбранных периодов остаются в их календаре, и период
          можно подготовить вручную.
        </p>
      ) : null}
    </div>
  );
}

function HeldBox({ text, actions }: { text: string; actions?: ReactNode }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <span className="min-w-0 flex-1">{text}</span>
      {actions}
    </div>
  );
}

function UncertainHeld({
  label,
  error,
  subject,
  actions,
}: {
  label: string;
  error: Error;
  subject: 'taskSave' | 'planSave';
  actions: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{label}</p>
      <UncertainCommandNotice error={error} subject={subject} action={<div className="flex flex-wrap gap-2">{actions}</div>} />
    </div>
  );
}
