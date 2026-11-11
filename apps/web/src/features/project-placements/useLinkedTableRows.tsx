import type { MembershipDto, ProjectDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import { FieldValueDisplay } from '../fields/FieldValueDisplay';
import { useProjectFieldValuesQuery } from '../fields/queries';
import type { TaskTableLinkedRow } from '../task-table';
import type { TaskFilterValue } from '../tasks/TaskFilters';
import { loadedProjectRows, useProjectRowsQuery } from './queries';
import { linkedRows } from './rowModel';

interface LinkedTableRowsOptions {
  actorId: string; project: ProjectDto; filters: TaskFilterValue; members: readonly MembershipDto[];
  /** This project's visible custom field columns; a linked task shows its values in them read-only. */
  fields: readonly { field: TaskFieldDefinitionDto }[];
  /** Off outside the table view: rows are then neither built nor their values read. */
  enabled: boolean;
}

/**
 * Linked tasks for the project's own table, where they sit in their section among its tasks.
 * The rows read the same cache as the separate linked list, which keeps loading, errors and paging.
 */
export function useLinkedTableRows({ actorId, project, filters, members, fields, enabled }: LinkedTableRowsOptions) {
  const { t } = useTranslation();
  const query = useProjectRowsQuery(actorId, project.workspaceId, project.id, filters.includeArchived);
  // The filter object is rebuilt on every page render; its values are the inputs.
  const { search, completion, statusId, participantMembershipId, tagId, includeArchived } = filters;
  const data = query.data;
  const rows = useMemo<TaskTableLinkedRow[]>(() => !enabled ? [] : linkedRows(loadedProjectRows(data), project.id, { search, completion, statusId, participantMembershipId, tagId, includeArchived }).map(row => ({
    id: row.placement.id, revision: row.placement.revision, task: row.canonicalTask, sectionId: row.placement.sectionId, position: row.placement.position,
    status: { name: row.canonicalStatus.name, group: row.canonicalStatus.group },
    homeProject: { id: row.homeProject.id, name: row.homeProject.name },
  })), [enabled, data, project.id, search, completion, statusId, participantMembershipId, tagId, includeArchived]);
  const values = useProjectFieldValuesQuery(actorId, project.workspaceId, project.id, enabled && fields.length ? rows.map(row => row.task.id) : []);
  const valueByKey = useMemo(() => new Map(values.data.map(value => [`${value.taskId}:${value.fieldId}`, value])), [values.data]);
  const renderCell = (row: TaskTableLinkedRow, columnId: string): ReactNode => {
    const column = fields.find(item => item.field.id === columnId);
    if (!column) return null;
    if (values.isError) return <span className="px-1.5 text-xs text-muted">{t('projects.projectPage.notLoaded')}</span>;
    if (values.isPending) return <span className="px-1.5 text-muted" aria-label={t('projects.projectPage.loadingValue')}>…</span>;
    return <span className="flex h-8 min-w-0 items-center px-1.5"><FieldValueDisplay field={column.field} value={valueByKey.get(`${row.task.id}:${column.field.id}`)?.value ?? null} members={members} compact /></span>;
  };
  return { rows, renderCell };
}
