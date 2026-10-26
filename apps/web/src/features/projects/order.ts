import type { ProjectDto } from '@workloom/contracts';

/** Active projects first; the server order is kept within each group. */
export function orderProjects(projects: readonly ProjectDto[]): ProjectDto[] {
  return [...projects.filter((project) => !project.archivedAt), ...projects.filter((project) => project.archivedAt)];
}

const PROJECT_SORT_FIELDS = ['name', 'createdAt', 'updatedAt', 'startDate', 'endDate', 'status'] as const;
export type ProjectSortField = typeof PROJECT_SORT_FIELDS[number];
export interface ProjectSort {
  field: ProjectSortField;
  direction: 'asc' | 'desc';
}

/** The URL owns the view; old links and unsupported values fall back without rewriting history. */
export function readProjectSort(params: URLSearchParams): ProjectSort {
  const requested = params.get('sort') ?? 'name';
  const field = PROJECT_SORT_FIELDS.find(candidate => candidate === requested);
  if (field === undefined) return { field: 'name', direction: 'asc' };
  const direction = params.get('direction');
  return {
    field,
    direction: direction === 'asc' || direction === 'desc' ? direction
      : field === 'createdAt' || field === 'updatedAt' ? 'desc' : 'asc',
  };
}

function sortValue(project: ProjectDto, field: ProjectSortField): string | number | null {
  switch (field) {
    case 'name': return project.name;
    case 'createdAt': return Date.parse(project.createdAt);
    case 'updatedAt': return Date.parse(project.updatedAt);
    case 'startDate': return project.dateRange?.from ?? null;
    case 'endDate': return project.dateRange?.to ?? null;
    case 'status': return Number(project.archivedAt !== null);
  }
}

/** Sort a copy of the full project list; missing planned dates stay last in either direction. */
export function sortProjects(projects: readonly ProjectDto[], sort: ProjectSort, locale: string): ProjectDto[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const direction = sort.direction === 'asc' ? 1 : -1;
  return [...projects].sort((a, b) => {
    const left = sortValue(a, sort.field);
    const right = sortValue(b, sort.field);
    if (left === null && right !== null) return 1;
    if (right === null && left !== null) return -1;
    const compared = sort.field === 'name' ? collator.compare(a.name, b.name)
      : left === null || right === null ? 0 : left < right ? -1 : left > right ? 1 : 0;
    return direction * compared || collator.compare(a.name, b.name) || a.id.localeCompare(b.id);
  });
}
