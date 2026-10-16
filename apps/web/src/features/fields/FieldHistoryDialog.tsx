import { t, useTranslation, formatDate } from '../../i18n';
import type { MembershipDto, TaskFieldDefinitionDto, TaskFieldValueHistoryDto } from '@workloom/contracts';
import { Button, Skeleton } from '@workloom/ui';
import { History, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { isAccessDenied } from '../../lib/api';
import { DialogShell } from '../../shared/DialogShell';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { FieldValueDisplay } from './FieldValueDisplay';
import { useTaskFieldHistoryQuery } from './queries';

export interface FieldHistoryDialogProps {
  actorId: string;
  workspaceId: string;
  taskId: string;
  field: TaskFieldDefinitionDto;
  members: readonly MembershipDto[];
}

const sourceLabels: Record<TaskFieldValueHistoryDto['source'], string> = {
  get web() { return t('fields.fieldHistoryDialog.webApp'); },
  get api() { return t('fields.fieldHistoryDialog.api'); },
  get mcp() { return t('fields.fieldHistoryDialog.mcp'); },
  get job() { return t('fields.fieldHistoryDialog.backgroundJob'); },
  get import() { return t('fields.fieldHistoryDialog.import'); },
};

/** The viewer's local time with the offset spelled out, so the moment is unambiguous. */
const recordedAtFormat = { format: (date: Date) => formatDate(date, {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
}) };

function formatRecordedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : recordedAtFormat.format(date);
}

const historyPolicyCopy = () =>
  t('fields.fieldHistoryDialog.changesAreRecordedWhileHistoryIsEnabledEnabling');

/**
 * One field's recorded value changes on a task, newest first. Each entry is shown with the
 * definition snapshot it was written with, so later renames do not relabel the past.
 */
export function FieldHistoryDialog({ actorId, workspaceId, taskId, field, members }: FieldHistoryDialogProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <DialogShell
      title={t('fields.fieldHistoryDialog.historyOfValue', { p0: field.name })}
      description={historyPolicyCopy()}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm" variant="ghost" aria-label={t('fields.fieldHistoryDialog.valueHistory', { p0: field.name })}>
          <History size={16} aria-hidden="true" />
          {t('fields.fieldHistoryDialog.history')}</Button>
      }
    >
      {/* Mounted only while open, so the history is requested only then. */}
      {open ? (
        <HistoryEntries actorId={actorId} workspaceId={workspaceId} taskId={taskId} field={field} members={members} />
      ) : null}
    </DialogShell>
  );
}

function HistoryEntries({ actorId, workspaceId, taskId, field, members }: FieldHistoryDialogProps) {
  const { t } = useTranslation();
  const history = useTaskFieldHistoryQuery(actorId, workspaceId, taskId, field.id);

  if (history.isPending) {
    return (
      <div role="status" className="mt-5 space-y-3">
        <span className="sr-only">{t('fields.fieldHistoryDialog.loadingValueHistory')}</span>
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  }
  if (history.data === undefined || isAccessDenied(history.error)) {
    return (
      <QueryErrorState
        className="mt-5"
        error={history.error}
        subject="fieldHistory"
        headingLevel={3}
        retrying={history.isFetching}
        onRetry={() => void history.refetch()}
      />
    );
  }

  // Pages may overlap if entries were recorded between requests.
  const seen = new Set<string>();
  const entries: TaskFieldValueHistoryDto[] = [];
  for (const entry of history.data.pages.flatMap((page) => page.entries)) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }

  return (
    <div className="mt-5 space-y-3">
      {!field.historyEnabled ? (
        <p className="rounded-lg bg-canvas px-3 py-2 text-sm text-ink-soft">
          {t('fields.fieldHistoryDialog.historyIsDisabledNewChangesAreNotRecorded')}</p>
      ) : null}
      {history.isRefetchError ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2 text-sm text-amber-900">
          <span className="min-w-0 flex-1">{t('fields.fieldHistoryDialog.couldNotRefreshHistoryShowingPreviouslyLoadedRecords')}</span>
          <Button size="sm" onClick={() => void history.refetch()}>
            {t('fields.fieldHistoryDialog.retry')}</Button>
        </div>
      ) : null}

      {entries.length === 0 ? (
        <p className="text-sm text-muted">{t('fields.fieldHistoryDialog.noRecordedChanges')}</p>
      ) : (
        <ol className="space-y-2" aria-label={t('fields.fieldHistoryDialog.changesToValue', { p0: field.name })}>
          {entries.map((entry) => (
            <HistoryEntry key={entry.id} entry={entry} currentName={field.name} members={members} />
          ))}
        </ol>
      )}

      {history.isFetchNextPageError ? (
        <p role="alert" className="text-sm text-red-700">
          {t('fields.fieldHistoryDialog.couldNotLoadMoreRecordsTryAgain')}</p>
      ) : null}
      {history.hasNextPage ? (
        <Button
          size="sm"
          aria-disabled={history.isFetchingNextPage || undefined}
          onClick={() => {
            if (!history.isFetchingNextPage) void history.fetchNextPage();
          }}
        >
          <RefreshCw size={16} aria-hidden="true" className={history.isFetchingNextPage ? 'motion-safe:animate-spin' : undefined} />
          {history.isFetchingNextPage ? t('fields.fieldHistoryDialog.loading') : t('fields.fieldHistoryDialog.showMore')}
        </Button>
      ) : null}
    </div>
  );
}

interface HistoryEntryProps {
  entry: TaskFieldValueHistoryDto;
  currentName: string;
  members: readonly MembershipDto[];
}

function HistoryEntry({ entry, currentName, members }: HistoryEntryProps) {
  const { t } = useTranslation();
  const snapshot = entry.definition;
  return (
    <li className="rounded-lg border border-line px-3 py-2.5">
      <p className="flex flex-wrap gap-x-1.5 text-xs text-muted">
        <span className="font-medium [overflow-wrap:anywhere] text-ink-soft">{entry.actor.displayName}</span>
        <span aria-hidden="true">·</span>
        <span>{sourceLabels[entry.source]}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={entry.recordedAt}>{formatRecordedAt(entry.recordedAt)}</time>
      </p>
      {snapshot.name !== currentName ? (
        <p className="mt-1 text-xs [overflow-wrap:anywhere] text-muted">{t('fields.fieldHistoryDialog.previouslyNamed')}{snapshot.name}».</p>
      ) : null}
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted">{t('fields.fieldHistoryDialog.before')}</dt>
        <dd className="[overflow-wrap:anywhere] text-ink">
          {entry.before === null ? (
            <span className="text-muted">{t('fields.fieldHistoryDialog.noPreviousValue')}</span>
          ) : (
            <FieldValueDisplay field={snapshot} value={entry.before} members={members} />
          )}
        </dd>
        <dt className="text-muted">{t('fields.fieldHistoryDialog.after')}</dt>
        <dd className="[overflow-wrap:anywhere] text-ink">
          <FieldValueDisplay field={snapshot} value={entry.after} members={members} />
        </dd>
      </dl>
    </li>
  );
}
