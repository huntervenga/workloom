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
  web: 'веб-интерфейс',
  api: 'API',
  mcp: 'MCP',
  job: 'фоновая задача',
  import: 'импорт',
};

/** The viewer's local time with the offset spelled out, so the moment is unambiguous. */
const recordedAtFormat = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});

function formatRecordedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : recordedAtFormat.format(date);
}

const historyPolicyCopy =
  'Записи появляются, только пока для поля включена история: включение не восстанавливает прошлые изменения, выключение не удаляет уже записанные.';

/**
 * One field's recorded value changes on a task, newest first. Each entry is shown with the
 * definition snapshot it was written with, so later renames do not relabel the past.
 */
export function FieldHistoryDialog({ actorId, workspaceId, taskId, field, members }: FieldHistoryDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <DialogShell
      title={`История поля «${field.name}»`}
      description={historyPolicyCopy}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm" variant="ghost" aria-label={`История «${field.name}»`}>
          <History size={16} aria-hidden="true" />
          История
        </Button>
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
  const history = useTaskFieldHistoryQuery(actorId, workspaceId, taskId, field.id);

  if (history.isPending) {
    return (
      <div role="status" className="mt-5 space-y-3">
        <span className="sr-only">Загрузка истории значения</span>
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
          История поля сейчас выключена: новые изменения не записываются.
        </p>
      ) : null}
      {history.isRefetchError ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2 text-sm text-amber-900">
          <span className="min-w-0 flex-1">Не удалось обновить историю. Показаны ранее загруженные записи.</span>
          <Button size="sm" onClick={() => void history.refetch()}>
            Повторить
          </Button>
        </div>
      ) : null}

      {entries.length === 0 ? (
        <p className="text-sm text-muted">Записанных изменений нет.</p>
      ) : (
        <ol className="space-y-2" aria-label={`Изменения поля «${field.name}»`}>
          {entries.map((entry) => (
            <HistoryEntry key={entry.id} entry={entry} currentName={field.name} members={members} />
          ))}
        </ol>
      )}

      {history.isFetchNextPageError ? (
        <p role="alert" className="text-sm text-red-700">
          Не удалось загрузить следующие записи. Повторите попытку.
        </p>
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
          {history.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
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
        <p className="mt-1 text-xs [overflow-wrap:anywhere] text-muted">Поле тогда называлось «{snapshot.name}».</p>
      ) : null}
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted">Было</dt>
        <dd className="[overflow-wrap:anywhere] text-ink">
          {entry.before === null ? (
            <span className="text-muted">значения не было</span>
          ) : (
            <FieldValueDisplay field={snapshot} value={entry.before} members={members} />
          )}
        </dd>
        <dt className="text-muted">Стало</dt>
        <dd className="[overflow-wrap:anywhere] text-ink">
          <FieldValueDisplay field={snapshot} value={entry.after} members={members} />
        </dd>
      </dl>
    </li>
  );
}
