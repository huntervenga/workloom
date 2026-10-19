import type { SectionDto } from '@workloom/contracts';
import { t } from '../../i18n';
import { GraphLayoutBoundsError, type GraphNodeSize } from './GraphNodeContent';
import type { Point } from './useDependencyWorkspace';

export interface SectionLayoutTask { id: string; projectId: string; projectName: string; sectionId: string | null; position: number }
export interface GraphSectionColumn { id: string; title: string; x: number; y: number; width: number; count: number }
export interface SectionGraphLayout { positions: Record<string, Point>; columns: GraphSectionColumn[] }
const GAP = 96, ROW_GAP = 36, HEADER_HEIGHT = 96, MARGIN = 24, LIMIT = 100000;

/** A view of real section membership. Never changes tasks, dates, edges or saved positions. */
export function arrangeGraphBySections(tasks: readonly SectionLayoutTask[], projectId: string, sections: readonly SectionDto[], sizes: Readonly<Record<string, GraphNodeSize>>): SectionGraphLayout {
  const known = new Map(sections.filter(section => section.projectId === projectId).map(section => [section.id, section]));
  const groups = new Map<string, { title: string; order: number; kind: number; tasks: SectionLayoutTask[] }>();
  for (const task of tasks) {
    const section = task.projectId === projectId && task.sectionId ? known.get(task.sectionId) : undefined;
    const key = task.projectId !== projectId ? `project:${task.projectId}` : section ? `section:${section.id}` : task.sectionId ? `unavailable:${task.sectionId}` : 'unsectioned';
    let group = groups.get(key);
    if (!group) {
      group = { title: task.projectId !== projectId ? t('dependencies.sectionLayout.otherProject', { name: task.projectName }) : section ? section.name : task.sectionId ? t('dependencies.sectionLayout.unavailableSection') : t('dependencies.sectionLayout.unsectioned'), order: section && Number.isFinite(section.position) ? section.position : 0, kind: task.projectId !== projectId ? 3 : section ? 0 : task.sectionId ? 2 : 1, tasks: [] };
      groups.set(key, group);
    }
    group.tasks.push(task);
  }
  const columns: GraphSectionColumn[] = [], positions: Record<string, Point> = {};
  let x = MARGIN, maxBottom = MARGIN;
  for (const [id, group] of [...groups].sort(([a, left], [b, right]) => left.kind - right.kind || left.order - right.order || a.localeCompare(b))) {
    const sorted = [...group.tasks].sort((a, b) => (Number.isFinite(a.position) ? a.position : 0) - (Number.isFinite(b.position) ? b.position : 0) || a.id.localeCompare(b.id));
    let width = 240;
    for (const task of sorted) {
      const size = sizes[task.id];
      if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) throw new Error(t('dependencies.layout.couldNotMeasureNodes'));
      width = Math.max(width, size.width);
    }
    columns.push({ id, title: group.title, x, y: MARGIN, width, count: sorted.length });
    let y = MARGIN + HEADER_HEIGHT;
    for (const task of sorted) {
      positions[task.id] = { x, y };
      y += (sizes[task.id]?.height ?? 0) + ROW_GAP;
    }
    maxBottom = Math.max(maxBottom, y - ROW_GAP);
    x += width + GAP;
  }
  const right = columns.length ? x - GAP : MARGIN;
  if (![right, maxBottom].every(Number.isFinite) || right - MARGIN > LIMIT * 2 || maxBottom - MARGIN > LIMIT * 2) throw new GraphLayoutBoundsError(t('dependencies.layout.measuredLayoutTooLarge'));
  const dx = right > LIMIT ? -(MARGIN + right) / 2 : 0, dy = maxBottom > LIMIT ? -(MARGIN + maxBottom) / 2 : 0;
  return { positions: Object.fromEntries(Object.entries(positions).map(([id, point]) => [id, { x: point.x + dx, y: point.y + dy }])), columns: columns.map(column => ({ ...column, x: column.x + dx, y: column.y + dy })) };
}
