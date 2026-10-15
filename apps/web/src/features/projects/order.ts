import type { ProjectDto } from '@workloom/contracts';

/** Active projects first; the server order is kept within each group. */
export function orderProjects(projects: readonly ProjectDto[]): ProjectDto[] {
  return [...projects.filter((project) => !project.archivedAt), ...projects.filter((project) => project.archivedAt)];
}
