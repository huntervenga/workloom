import { WorkspaceLink as Link } from '../workspace/WorkspaceNavigation';

import type { MembershipDto, ProjectDto, ProjectRowDto, SectionDto, TaskFieldDefinitionDto, TaskFieldValueDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { buildTaskGroups, visibleTaskRows, type TaskTreeNode } from '../task-table/taskTree';
import { useTableExpansionState, type TableExpansionControls } from '../task-table/useTableExpansionState';
import { useProjectFieldValuesQuery, type ProjectFieldValues } from '../fields/queries';
import { FieldValueDisplay } from '../fields/FieldValueDisplay';
import { useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { useTranslation } from '../../i18n';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import { ChoicePicker } from '../../shared/ChoicePicker';
import { useStatusesQuery } from '../projects/queries';
import { TaskBoard } from '../task-board/TaskBoard';
import { ScheduleBar } from '../schedule/GanttView';
import { calendarWindow } from '../schedule/dates';
import { priorityLabels } from '../tasks/TaskFields';
import type { TaskFilterValue } from '../tasks/TaskFilters';
import { autosaveRetains } from '../tasks/taskAutosave';
import { unresolvedTaskCommand, type TaskCommands } from '../tasks/useTaskCommands';
import { byHomeProject, canonicalStatusTarget, linkedRows } from './rowModel';
import { loadedProjectRows, type PlacementCommands, useProjectRowsQuery } from './queries';

interface LinkedProjectTasksProps {
  actorId: string; project: ProjectDto; sections: readonly SectionDto[]; members: readonly MembershipDto[];
  filters: TaskFilterValue; writable: boolean; commands: TaskCommands; placementCommands: PlacementCommands;
  view: 'table' | 'board' | 'timeline'; onOpenTask: (id: string) => void;
  expansion?: TableExpansionControls;
  customFields?: readonly { field: TaskFieldDefinitionDto; width: number }[];
  windowStart: string; windowSize: number; sortByDue: boolean; acquireDragProtection?: (() => () => void) | undefined;
}
/** The legacy home-task table and these canonical linked rows own distinct command identities. */
export function LinkedProjectTasks(props: LinkedProjectTasksProps) {
  const { t } = useTranslation();
  const query = useProjectRowsQuery(props.actorId, props.project.workspaceId, props.project.id, props.filters.includeArchived);
  const rows = linkedRows(loadedProjectRows(query.data), props.project.id, props.filters).sort((a, b) => props.sortByDue
    ? (a.canonicalTask.dueDate ?? '9999-12-31').localeCompare(b.canonicalTask.dueDate ?? '9999-12-31') || a.placement.position - b.placement.position
    : a.placement.position - b.placement.position || a.placement.id.localeCompare(b.placement.id));
  const ownExpansion = useTableExpansionState(
    { actorId: props.actorId, workspaceId: props.project.workspaceId, projectId: props.project.id }, rows.map(row => row.canonicalTask.id),
  );
  const expansion = props.expansion ?? ownExpansion;
  const collapsedTaskIds = new Set(rows.filter(row => !expansion.expandedTaskIds.has(row.canonicalTask.id)).map(row => row.canonicalTask.id));
  const groups = buildTaskGroups(rows.map(row => ({ ...row.canonicalTask, sectionId: row.placement.sectionId, position: row.placement.position })), props.sections,
    undefined, props.sortByDue ? 'due_asc' : 'manual').filter(group => group.roots.length > 0);
  const rowById = new Map(rows.map(row => [row.canonicalTask.id, row]));
  const fields = props.customFields ?? [];
  const fieldValues = useProjectFieldValuesQuery(props.actorId, props.project.workspaceId, props.project.id,
    fields.length && props.view !== 'board' ? rows.map(row => row.canonicalTask.id) : []);
  const valueByKey = new Map(fieldValues.data.map(value => [`${value.taskId}:${value.fieldId}`, value]));
  if (query.isPending) return <p role="status" className="text-xs text-muted">{t('placements.loadingRows')}</p>;
  if (query.isError && !query.isFetchNextPageError) return <div role="status" className="space-y-2 text-sm"><p>{t('placements.rowsFailed')}</p><Button size="sm" onClick={() => void query.refetch()}>{t('placements.reload')}</Button></div>;
  if (!rows.length && !query.hasNextPage) return null;
  const current = query.isSuccess && !query.isFetching && !query.isError;
  return <section className="mt-4 min-w-0 space-y-3 border-t border-line pt-3" aria-label={t('placements.linkedTasks')}>
    <div><h2 className="text-sm font-medium">{t('placements.linkedTasks')}</h2><p className="text-xs text-muted">{t('placements.accountingHint')}</p></div>
    {props.view === 'board' ? byHomeProject(rows).map(group => { const first = group[0]; return first ? <LinkedHomeBoard key={first.homeProject.id} {...props} rows={group} current={current} partial={query.hasNextPage} /> : null; }) : <div className="min-w-0 max-w-full overflow-x-auto rounded-lg border border-line"><table className="w-full min-w-[85rem] table-fixed text-left text-sm"><colgroup><col className="w-80" /><col className="w-32" /><col className="w-40" /><col className="w-32" /><col className="w-32" />{fields.map(({ field, width }) => <col key={field.id} style={{ width }} />)}<col className="w-52" /><col className="w-72" /></colgroup><thead className="bg-canvas text-xs text-muted"><tr>
      {[t('tasks.taskFields.taskName'), t('tasks.taskFields.status'), t('tasks.taskFields.assignee'), t('tasks.taskFields.dueDate'), t('tasks.taskFields.priority')].map(label => <th key={label} className="whitespace-nowrap px-3 py-2 font-medium">{label}</th>)}
      {fields.map(({ field }) => <th key={field.id} className="whitespace-nowrap px-3 py-2 font-medium">{field.name}</th>)}
      {[t('placements.home'), t('placements.placement')].map(label => <th key={label} className="whitespace-nowrap px-3 py-2 font-medium">{label}</th>)}
    </tr></thead>{groups.map(group => {
      const collapsed = expansion.collapsedGroupKeys.has(group.key);
      const sectionName = group.section?.name ?? t('tasks.taskFields.noSection');
      return <tbody key={group.key}>
        <tr className="border-t border-line bg-canvas"><th scope="rowgroup" colSpan={7 + fields.length} className="px-3 py-1.5">
          <button type="button" aria-expanded={!collapsed} aria-label={t(collapsed ? 'taskTable.sections.expand' : 'taskTable.sections.collapse', { section: sectionName })}
            onClick={() => expansion.setGroupCollapsed(group.key, !collapsed)} className="flex min-h-8 items-center gap-1 text-left text-xs font-semibold">
            {collapsed ? <ChevronRight size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}{sectionName}
          </button>
        </th></tr>
        {!collapsed ? visibleTaskRows(group.roots, collapsedTaskIds).map(node => {
          const row = rowById.get(node.task.id);
          return row ? <LinkedTableRow key={row.placement.id} {...props} row={row} fieldValues={fieldValues} valueByKey={valueByKey} node={node} expanded={expansion.expandedTaskIds.has(row.canonicalTask.id)}
            onToggle={() => expansion.setTaskCollapsed(row.canonicalTask.id, expansion.expandedTaskIds.has(row.canonicalTask.id))} current={current} /> : null;
        }) : null}
      </tbody>;
    })}</table></div>}
    {fieldValues.isError && fields.length ? <div role="status" className="flex items-center gap-2 text-xs text-muted"><span>{t('projects.projectPage.notLoaded')}</span><Button size="sm" onClick={() => void fieldValues.refetch()}>{t('placements.reload')}</Button></div> : null}
    {query.hasNextPage ? <Button size="sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{t('placements.loadMore')}</Button> : null}
    {query.isFetchNextPageError ? <p role="alert" className="text-xs text-muted">{t('placements.rowsFailed')}</p> : null}
  </section>;
}
function LinkedTableRow(props: LinkedProjectTasksProps & { row: ProjectRowDto; current: boolean; node: TaskTreeNode; fieldValues: ProjectFieldValues; valueByKey: ReadonlyMap<string, TaskFieldValueDto>; expanded: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const { row, onOpenTask, members } = props;
  const task = row.canonicalTask;
  const person = members.find(member => member.id === task.responsibleMembershipId)?.displayName ?? t(task.responsibleMembershipId === null ? 'tasks.taskFields.unassigned' : 'tasks.taskFields.memberUnavailable');
  const window = props.view === 'timeline' ? calendarWindow(props.windowStart, props.windowSize) : null;
  return <tr data-placement-id={row.placement.id} className="border-t border-line align-middle">
    <td className="px-3 py-2"><div className="flex min-w-0 items-center gap-1" style={{ paddingLeft: Math.min(props.node.depth, 2) * 20 }}>
      {props.node.children.length ? <button type="button" aria-expanded={props.expanded}
        aria-label={t('taskTable.taskTable.valueSubtasksOfValue', { p0: t(props.expanded ? 'taskTable.taskTable.collapse' : 'taskTable.taskTable.expand'), p1: task.title })}
        onClick={props.onToggle} className="flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-canvas">
        {props.expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
      </button> : <span className="size-6 shrink-0" aria-hidden="true" />}
      <button type="button" aria-label={task.title} title={task.title} className="block w-full truncate text-left hover:text-accent-ink" onClick={() => onOpenTask(task.id)}>{task.title}</button></div>
      {window ? <div className="mt-2 min-w-64"><ScheduleBar start={task.startDate ?? null} due={task.dueDate} window={window} title={task.title} onFocus={() => onOpenTask(task.id)} onActivate={() => onOpenTask(task.id)} /></div> : null}
      {task.parentTaskId !== null ? <p className="text-xs text-muted">{t('placements.homeHierarchy')}</p> : null}
    </td><td className="truncate whitespace-nowrap px-3 py-2" title={row.canonicalStatus.name}>{row.canonicalStatus.name}</td><td className="truncate whitespace-nowrap px-3 py-2" title={person}>{person}</td><td className="whitespace-nowrap px-3 py-2">{task.dueDate ?? '—'}</td><td className="truncate whitespace-nowrap px-3 py-2">{priorityLabels[task.priority]}</td>
    {props.customFields?.map(({ field }) => <td key={field.id} className="truncate px-3 py-2">
      {props.fieldValues.isError ? <span className="text-xs text-muted">{t('projects.projectPage.notLoaded')}</span>
        : props.fieldValues.isPending ? <span className="text-muted" aria-label={t('projects.projectPage.loadingValue')}>…</span>
        : <FieldValueDisplay field={field} value={props.valueByKey.get(`${task.id}:${field.id}`)?.value ?? null} members={members} compact />}
    </td>)}
    <td className="px-3 py-2"><Link className="block truncate text-xs underline" title={row.homeProject.name} to={`/w/${task.workspaceId}/projects/${task.projectId}?task=${task.id}`}>{row.homeProject.name}</Link></td>
    <td className="px-3 py-1"><PlacementRowControls key={`${row.placement.id}:${row.placement.revision}`} row={row} projectName={props.project.name} sections={props.sections} commands={props.placementCommands} writable={props.writable && props.current && task.archivedAt === null && row.homeProject.archivedAt === null} /></td>
  </tr>;
}
function PlacementRowControls({ row, projectName, sections, commands, writable }: { row: ProjectRowDto; projectName: string; sections: readonly SectionDto[]; commands: PlacementCommands; writable: boolean }) {
  const { t } = useTranslation();
  const registry = protectedCommandsFor(useQueryClient());
  useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  const blocked = !writable || commands.isError || commands.pendingCommand !== null || commands.uncertain !== null || commands.hasOtherProtectedCommands();
  const archived = row.placement.archivedAt !== null;
  const update = (patch: { sectionId: string | null }) => {
    if (!blocked && !archived) commands.mutate({ command: { kind: 'update', placementId: row.placement.id, input: { expectedRevision: row.placement.revision, ...patch } } });
  };
  return <div className="flex min-w-0 items-center gap-2">
    <div className="min-w-0 flex-1"><ChoicePicker compact label={t('placements.section')} value={row.placement.sectionId ?? ''} disabled={blocked || archived} options={[{ value: '', label: t('tasks.taskFields.noSection') }, ...sections.filter(section => section.archivedAt === null).map(section => ({ value: section.id, label: section.name }))]} onValueChange={sectionId => update({ sectionId: sectionId || null })} /></div>
      <Button size="sm" variant="ghost" className="shrink-0" disabled={blocked} aria-label={t(archived ? 'placements.restoreTo' : 'placements.removeFrom', { p0: projectName })} onClick={() => commands.mutate({ command: { kind: archived ? 'restore' : 'detach', placementId: row.placement.id, input: { expectedRevision: row.placement.revision } } })}>{t(archived ? 'placements.restore' : 'placements.remove')}</Button>
  </div>;
}
function LinkedHomeBoard(props: LinkedProjectTasksProps & { rows: readonly ProjectRowDto[]; current: boolean; partial: boolean }) {
  const { t } = useTranslation();
  const home = props.rows[0]?.homeProject;
  const statuses = useStatusesQuery(props.actorId, props.project.workspaceId, home?.id ?? '');
  const registry = protectedCommandsFor(useQueryClient());
  const held = useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  const paused = useSyncExternalStore(props.commands.autosave.subscribe, props.commands.autosave.getPaused);
  const writable = props.writable && props.current && home?.archivedAt === null && statuses.isSuccess && !statuses.isFetching;
  const blocked = !writable || held || paused !== null || unresolvedTaskCommand(props.commands) !== null;
  if (!home || !statuses.isSuccess) return <p role="status" className="text-xs text-muted">{t('placements.homeUnavailable')}</p>;
  return <div className="space-y-2"><h3 className="text-xs font-medium text-muted">{home.name} · {t('placements.sharedStatus')}</h3><TaskBoard tasks={props.rows.filter(row => row.placement.archivedAt === null).map(row => row.canonicalTask)} statuses={statuses.data} members={props.members} partial={props.partial} writable={writable} dragBlocked={blocked} acquireDragProtection={props.acquireDragProtection} dragContextKey={`${props.project.id}:${home.id}`} onOpenTask={props.onOpenTask} onEditStatus={task => props.onOpenTask(task.id)} renderStatusEditor={() => null} onMoveStatus={(seen, statusId) => {
    const row = props.rows.find(item => item.canonicalTask.id === seen.id);
    if (blocked || !row || !canonicalStatusTarget(row, statuses.data, statusId) || seen.statusId === statusId || seen.archivedAt !== null || row.canonicalTask.revision !== seen.revision || row.canonicalTask.statusId !== seen.statusId || row.canonicalTask.workPackageRevision !== seen.workPackageRevision || row.canonicalTask.participantsRevision !== seen.participantsRevision || props.commands.editSessions.current.has(seen.id) || autosaveRetains(props.commands.autosave.get(seen.id))) return;
    props.commands.autosave.authorize(row.canonicalTask.id, true);
    props.commands.autosave.choose(row.canonicalTask, { statusId });
  }} /></div>;
}
